-- EMS schema. All tenant data carries org_id. Enums modeled as VARCHAR + CHECK
-- for portability. Postgres is the system of record.

CREATE TABLE IF NOT EXISTS organizations (
  id            UUID PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  base_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id),
  name          VARCHAR(200) NOT NULL,
  email         VARCHAR(200) NOT NULL,
  password_hash VARCHAR(200) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('employee','manager','finance','admin')),
  manager_id    UUID REFERENCES users(id),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS policies (
  id                UUID PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organizations(id),
  name              VARCHAR(200) NOT NULL,
  rules_json        JSONB NOT NULL,
  tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-org expense categories (admin-managed). Expenses reference the name.
CREATE TABLE IF NOT EXISTS expense_categories (
  id         UUID PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organizations(id),
  name       VARCHAR(80) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS budgets (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id),
  user_id      UUID REFERENCES users(id),
  scope        VARCHAR(10) NOT NULL CHECK (scope IN ('user','org')),
  period       VARCHAR(10) NOT NULL CHECK (period IN ('daily','monthly')),
  limit_amount NUMERIC(14,2) NOT NULL,
  currency     VARCHAR(3) NOT NULL DEFAULT 'INR'
);

CREATE TABLE IF NOT EXISTS expense_requests (
  id                  UUID PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organizations(id),
  requester_id        UUID NOT NULL REFERENCES users(id),
  type                VARCHAR(20) NOT NULL CHECK (type IN ('reimbursement','company_paid')),
  category            VARCHAR(50) NOT NULL DEFAULT 'general',
  description         TEXT NOT NULL DEFAULT '',
  amount              NUMERIC(14,2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  base_amount         NUMERIC(14,2) NOT NULL,
  fx_rate             NUMERIC(14,6) NOT NULL DEFAULT 1,
  status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','submitted','in_review','approved','rejected','paid','withdrawn')),
  policy_snapshot_json JSONB,
  current_level       INTEGER NOT NULL DEFAULT 0,
  sla_due_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organizations(id),
  expense_id   UUID REFERENCES expense_requests(id),
  s3_key       VARCHAR(500) NOT NULL,
  filename     VARCHAR(300) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size         INTEGER NOT NULL DEFAULT 0,
  uploaded_by  UUID NOT NULL REFERENCES users(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approval_steps (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organizations(id),
  expense_id    UUID NOT NULL REFERENCES expense_requests(id),
  level         INTEGER NOT NULL,
  required_role VARCHAR(20) NOT NULL,
  approver_id   UUID REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','skipped')),
  reason        TEXT,
  acted_at      TIMESTAMPTZ,
  sla_due_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL,
  actor_id    UUID,
  action      VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id   UUID NOT NULL,
  before_json JSONB,
  after_json  JSONB,
  reason      TEXT,
  request_id  VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY,
  org_id       UUID NOT NULL,
  user_id      UUID NOT NULL,
  type         VARCHAR(50) NOT NULL,
  payload_json JSONB NOT NULL,
  read         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           VARCHAR(200) NOT NULL,
  org_id        UUID NOT NULL,
  endpoint      VARCHAR(200) NOT NULL,
  response_json JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key, org_id, endpoint)
);

-- Opaque refresh tokens stored as SHA-256 hashes (never the raw value).
-- Rotation: each /auth/refresh revokes the presented token and issues a new one
-- (replaced_by chains them). Reuse of a revoked token => session theft signal.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id),
  user_id     UUID NOT NULL REFERENCES users(id),
  token_hash  VARCHAR(64) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_org_status ON expense_requests(org_id, status);
CREATE INDEX IF NOT EXISTS idx_expense_org_requester ON expense_requests(org_id, requester_id);
CREATE INDEX IF NOT EXISTS idx_expense_org_created ON expense_requests(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_step_org_approver_status ON approval_steps(org_id, approver_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(org_id, user_id, read);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id, revoked_at);
