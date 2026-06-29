# EMS — Level 1.5: Scoped Implementation Contract

> **Purpose:** A finite, buildable scope that sits between Level 1 (brain-dump)
> and Level 2 (full design). This is the **build contract** for the working
> prototype.
>
> **Architecture decision:** Modular **monolith** (Node.js + TypeScript +
> PostgreSQL + Redis). Single deployable, internally split into modules
> (`auth`, `expenses`, `workflow`, `policy`, `audit`, `notifications`).
>
> **Persistence decision:** A real **PostgreSQL** database is the system of
> record — **no in-memory store**. State survives restarts; Redis is only a
> cache/accelerator, never the source of truth.
>
> **Audit log shipping:** Audit logs live in Postgres and, **when enabled via a
> feature flag**, are also shipped to **S3** (object storage) for cheap,
> durable, long-term retention.
>
> **NFR focus for this build:** **Audit**, **Scalability (pragmatic)**,
> **Security**. Everything else is documented as *theoretical* (how we would do
> it), not built.

---

## 1. Scope at a glance

| Area | IN SCOPE (build) | THEORETICAL (document only) |
|---|---|---|
| Tenancy | `org_id` scoping on all data | Per-tenant DB / pool isolation |
| Identity | Auth (JWT) + RBAC (4 roles) | SSO/SAML, SCIM provisioning |
| Expenses | CRUD, both types, full lifecycle | OCR bill validation |
| Workflow | Threshold-based multi-level engine | Parallel approvals, delegation engine |
| Policy | CRUD + budget enforcement | Category-tree policies, ML anomaly checks |
| Money | currency + base + static FX | Real payout / payment gateway |
| Audit | Immutable append-only log (Postgres) + history API + **optional S3 log shipping (feature-flagged)** | Tamper-proof hash chain, external SIEM |
| Persistence | **PostgreSQL** as system of record; Redis = cache only | In-memory store (explicitly rejected) |
| Notifications | Persisted in-app + console log | Email/SMS/push providers |
| Files | S3 presigned (MinIO/local fallback) | Virus scan, OCR pipeline |
| SLA | `sla_due_at` stored + flag overdue | Auto-escalation scheduler/cron |
| Observability | Built-in dashboard (basic charts) + `/metrics` | Prometheus/Grafana, tracing, ELK |

---

## 2. Functional Requirements — FINAL build set

> These will be **implemented**. Each has a clear acceptance criterion.

| # | FR | Acceptance criterion |
|---|----|----------------------|
| F1 | **Multi-tenancy** | Every entity carries `org_id`; every query filters by it; no cross-org reads. |
| F2 | **Auth + RBAC** | JWT login; roles `employee / manager / finance / admin`; endpoints enforce permissions. |
| F3 | **Expense CRUD (both types)** | Create/read/update/delete `reimbursement` and `company_paid` requests. |
| F4 | **Lifecycle** | States: `DRAFT → SUBMITTED → IN_REVIEW → APPROVED/REJECTED → (PAID)`; `WITHDRAWN`. |
| F5 | **Multi-level approval engine** | Policy decides chain by amount; steps created; sequential approval. |
| F6 | **Approve / reject** | Approver acts with mandatory reason; advances or terminates chain. |
| F7 | **Policy CRUD** | Admin defines thresholds → required approver levels; budget limits. |
| F8 | **Budget enforcement** | At submit, reject/flag if user daily/monthly budget exceeded. |
| F9 | **Attachments** | Request presigned URL → upload bill → store key in metadata. |
| F10 | **Multi-currency** | Store `amount`, `currency`, `base_amount`, `fx_rate` (static rate table). |
| F11 | **Audit trail + History API** | Every state change logged; `GET /expenses/{id}/history`. |
| F12 | **Notifications** | On submit/approve/reject → persisted notification + console log. |
| F13 | **Views/queues** | `my expenses`, `pending approvals`, `reportees`, `all` (per permission), paginated. |
| F14 | **Self-approval prevention** | A user cannot approve their own request. |
| F15 | **Observability dashboard** | Admin/finance dashboard with basic charts (spend, status mix, pending/SLA, budget, audit volume, app health). |

### Theoretical FRs (documented, NOT built)
- OCR bill validation (blur/amount mismatch) → AWS Textract / Tesseract, async worker.
- Delegation when approver on leave → simple manual reassign only in build.
- SLA auto-escalation → store `sla_due_at` + expose `overdue` flag; scheduler is theoretical.
- Direct-payment **tolerance** → `tolerance_percent` policy field stored; auto-pass within tolerance; re-approval branch documented only.
- Comments thread, draft autosave, resubmit-after-reject niceties → optional.

---

## 3. NFRs — what we actually implement

### 3.1 AUDIT (focus)
- Dedicated **append-only `audit_log`** table; no updates/deletes.
- Each entry: `id, org_id, actor_id, action, entity_type, entity_id, before(jsonb), after(jsonb), reason, created_at`.
- A DB write trigger or a single service-layer `AuditService.record()` wraps every
  state transition (submit/approve/reject/edit/withdraw/pay).
- Exposed via `GET /expenses/{id}/history` (the UI "History" tab).
- **S3 log shipping (feature-flagged, `AUDIT_S3_SHIPPING_ENABLED`):**
  - Postgres remains the immediate, queryable system of record.
  - When the flag is on, audit entries are also written to S3 (e.g. newline-
    delimited JSON, partitioned by `org_id/date`) for durable long-term retention
    and offloading old data from the hot DB.
  - Implementation: append to a buffered writer / async job that flushes batches
    to S3; failure to ship must **not** block the primary DB write (best-effort,
    retried). Postgres write is the source of truth.
  - When the flag is off, everything still works using Postgres only.
- *Theoretical extension:* hash-chain (`prev_hash`) for tamper-evidence; ship to SIEM.

### 3.2 SECURITY (focus)
- **AuthN:** JWT (short-lived access + refresh); passwords hashed (bcrypt/argon2).
- **AuthZ:** RBAC middleware checks role+permission per route.
- **Tenant isolation:** `org_id` injected from token, enforced in every repository query.
- **Input validation** (zod/DTO) on all endpoints; reject unknown fields.
- **Idempotency:** `Idempotency-Key` header on submit/approve/reject to stop double-action.
- **Files:** private S3 bucket, time-limited presigned URLs only (no public access).
- *Theoretical:* secrets manager, WAF, rate limiting at gateway, field-level encryption.

### 3.3 SCALABILITY (pragmatic focus)
- **Stateless app** (JWT, no server session) → horizontally scalable.
- **Redis cache** for read-heavy views (pending queues, lists) with invalidation on writes.
- **Pagination + indexes** on hot query paths (`org_id`, `status`, `approver_id`, `requester_id`).
- **Idempotent writes** → safe retries.
- *Theoretical:* read replicas + materialized views for reporting; DB sharding by
  `org_id`; CQRS read model; multi-zone active-active; outbox pattern for events.

### 3.4 OBSERVABILITY (focus — built-in dashboard)
A single **Observability & Analytics dashboard** (admin/finance) with basic charts,
powered mostly by Postgres aggregations + lightweight in-app metrics. Two lenses:

**Business / operational charts**
- Expenses by **status** (donut): draft/submitted/in-review/approved/rejected/paid.
- **Spend over time** (line): approved spend per day/week (in org base currency).
- **Spend by category** (bar).
- **Pending approvals** & **SLA-breached** counts (stat cards) — ties to audit/SLA.
- **Avg approval cycle time** (submit → final decision).
- **Budget utilization** (bar/gauge): used vs limit per period.
- **Audit volume** (line): audit events/day — proves the audit trail is alive.

**System / health metrics**
- Request rate, error rate, p95 latency (line) — from a lightweight metrics
  collector; also exposed at `GET /metrics` (Prometheus text format).

Implementation notes:
- Aggregation endpoints (`/analytics/*`) read from Postgres (cached in Redis,
  short TTL) so the dashboard stays cheap and the read-heavy NFR is demonstrated.
- Frontend: one dashboard page using a simple chart lib (Chart.js / Recharts).
- *Theoretical:* full Prometheus + Grafana, OpenTelemetry tracing, ELK log
  aggregation — documented as the production path; the built-in dashboard is the
  prototype slice.

### Theoretical NFRs (documented only)
- Multi-zone HA, failover, replication topology.
- DR with RPO/RTO targets, backups.
- Full observability stack at scale (Prometheus/Grafana, distributed tracing,
  centralized log aggregation) — prototype ships a built-in dashboard instead.

---

## 4. Scoped Data Model (build target)

> Corrected from Level 1 (Employee+Manager merged into `User`; added
> `ExpenseRequest` + `ApprovalStep`). All tables include `org_id`.

- **Organization** `(id, name, base_currency, created_at)`
- **User** `(id, org_id, name, email, password_hash, role, manager_id?, created_at)`
- **Policy** `(id, org_id, name, rules_json, tolerance_percent?, active, created_at)`
  - `rules_json` example: `[{ "min": 0, "max": 5000, "levels": ["manager"] }, { "min": 5001, "max": null, "levels": ["manager","finance"] }]`
- **Budget** `(id, org_id, user_id?, scope, period, limit_amount, currency)`
- **ExpenseRequest** `(id, org_id, requester_id, type[reimbursement|company_paid], category, description, amount, currency, base_amount, fx_rate, status, policy_snapshot_json, sla_due_at, created_at, updated_at)`
- **Attachment** `(id, org_id, expense_id, s3_key, filename, content_type, uploaded_at)`
- **ApprovalStep** `(id, org_id, expense_id, level, approver_id, status[pending|approved|rejected|skipped], reason?, acted_at?, sla_due_at?)`
- **AuditLog** `(id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json, reason?, created_at)` — append-only
- **Notification** `(id, org_id, user_id, type, payload_json, read, created_at)`

---

## 5. Scoped API surface (REST)

```
# Auth
POST   /auth/login
POST   /auth/refresh

# Expenses
POST   /expenses                      # create (draft)
GET    /expenses                      # list (filters: status,type,mine,reportees,all) + pagination
GET    /expenses/{id}
PATCH  /expenses/{id}                  # edit (draft / before approval)
DELETE /expenses/{id}                  # delete draft
POST   /expenses/{id}/submit           # DRAFT -> SUBMITTED (builds approval chain)
POST   /expenses/{id}/approve          # approver action (Idempotency-Key)
POST   /expenses/{id}/reject           # approver action + reason
POST   /expenses/{id}/withdraw         # requester cancels
GET    /expenses/{id}/history          # audit trail

# Attachments
POST   /attachments/presign            # -> presigned PUT url + key

# Approvals
GET    /approvals/pending              # my approval queue

# Policy / Budget (admin)
POST   /policies   GET /policies   PATCH /policies/{id}   DELETE /policies/{id}
POST   /budgets    GET /budgets

# Users / Roles (admin)
POST   /users      GET /users      PATCH /users/{id}

# Notifications
GET    /notifications                  # my notifications
POST   /notifications/{id}/read

# Observability / Analytics (admin, finance)
GET    /analytics/summary              # stat cards: totals, pending, SLA breaches, budget util
GET    /analytics/spend                # spend over time (group by day/week)
GET    /analytics/by-status            # counts grouped by status
GET    /analytics/by-category          # spend grouped by category
GET    /analytics/audit-volume         # audit events over time
GET    /metrics                        # app health (Prometheus text format)
```

Cross-cutting: JWT auth on all (except login), `org_id` from token, pagination,
validation, `Idempotency-Key` on state-changing money actions.

---

## 6. What a reviewer will see in the demo
1. Login as employee → create a ₹8,000 reimbursement with a bill upload.
2. Policy auto-builds a 2-level chain (manager → finance) because amount > threshold.
3. Login as manager → approve; login as finance → approve → status `APPROVED`.
4. Reject path with reason from another request.
5. Budget block when monthly limit exceeded.
6. History tab shows the full immutable audit trail.
7. Company-paid request demonstrates the approve-before-spend flow.
8. Observability dashboard shows spend trends, status mix, pending/SLA-breached
   approvals, budget utilization, audit volume, and basic app health charts.

This covers: workflow engine, RBAC, multi-tenancy, audit, security, and the two
expense types — the heart of the assignment — while sharding/microservices/
multi-zone/OCR remain as documented design.
