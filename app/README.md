# EMS — Expense Management System (Prototype)

A multi-tenant SaaS expense platform with **configurable multi-level approvals**,
**RBAC**, an **immutable audit trail**, and a built-in **observability dashboard**.

Project map: [`../docs/PROJECT-OVERVIEW.md`](../docs/PROJECT-OVERVIEW.md). Full API
reference + UI walkthrough (PDF): [`../docs/technical-documentation.pdf`](../docs/technical-documentation.pdf).
Design-iteration docs are archived under `self-projects/docs/`.
Stack:
**Node.js + TypeScript + Express + PostgreSQL + Redis(optional)**. Modular
monolith. Postgres is the system of record (no in-memory store); Redis is an
optional cache with an in-memory fallback.

### Real vs Mocked (at a glance)

The table below is the honest boundary between what is genuinely implemented and
what is stubbed or documented as the production path.

| Area | Status | Notes |
|---|---|---|
| Postgres (system of record) | ✅ Real | Schema, migrations, transactions, row locks |
| AuthN — access tokens | ✅ Real | Short-lived JWT |
| AuthN — refresh tokens | ✅ Real | Opaque, **hashed at rest, rotated, revocable**, reuse-detection (`/auth/logout`) |
| RBAC | ✅ Real | Role → permission map enforced in middleware |
| Multi-tenancy isolation | ✅ Real (app-layer) | `org_id` from token on every query; RLS is the documented prod hardening (§7) |
| Concurrency (approve/reject) | ✅ Real | `SELECT … FOR UPDATE` serializes transitions (§7) |
| Idempotency | ✅ Real | Keyed dedupe of retried money/state actions |
| Audit trail | ✅ Real | Append-only, written in the same txn as the change |
| Multi-currency | ⚠️ Partial | Conversion + stored `fx_rate` real; **FX rates are static** |
| Bill uploads (image/PDF) | ✅ Real | Multipart upload → bytes persisted via a storage driver; metadata in Postgres; authenticated, tenant-scoped download |
| Object storage backend | ⚙️ Local now / S3 documented | `LocalDiskStorage` is the default driver; `BlobStorage` interface is ready to swap in S3 |
| S3 presign (direct-to-bucket) | ❌ Mocked | `/attachments/presign` returns a fake URL — the documented production alternative to API-proxied uploads |
| Audit S3 shipping | ❌ Mocked | Flag-gated; writes to an in-memory sink |
| Redis cache | ⚙️ Optional | In-memory fallback by default; Redis slot wired |
| SLA escalation | ❌ Not built | `sla_due_at` stored & surfaced; no scheduler |
| OCR / email-SMS-push / sharding / multi-AZ | ❌ Documented only | See §7 + Level 2 doc |

---

## 1. Prerequisites

- Node 18+ (tested on Node 24)
- PostgreSQL running locally (tested on PG 14)
- Redis optional (falls back to in-memory cache automatically)

## 2. Setup & run

```bash
cd app
npm install
cp .env.example .env          # adjust DATABASE_URL if needed
createdb ems                  # if it doesn't exist
npm run setup                 # runs migrations + seeds sample data
npm run dev                   # starts http://localhost:4000
```

Open the UI at **http://localhost:4000/**

## 3. Sample data & logins (password: `password123`)

Org **Acme Corp**:

| Email | Role | Notes |
|---|---|---|
| `riya@acme.test` | employee | has manager Amit; has expenses in several states |
| `arjun@acme.test` | employee | has manager Amit |
| `manager@acme.test` | manager | approves L1 |
| `cfo@acme.test` | finance | approves L2, sees all, dashboards |
| `admin@acme.test` | admin | approves L3, manages users/policies |

A second org **Globex Inc** (`admin@globex.test`) exists to demonstrate
**tenant isolation** — it cannot see Acme's data.

Seeded approval policy (Acme):

| Amount (₹) | Approval chain |
|---|---|
| 0 – 5,000 | manager |
| 5,001 – 50,000 | manager → finance |
| 50,001+ | manager → finance → admin |

---

## 4. How to test

### A) Via the UI (easiest)
0. (Optional) **Onboard a new company:** on the login screen click **"Create an
   organization"** → fill org + admin details → you're logged in as that org's
   admin with a default policy ready. Then use the **Users** tab to add
   managers/employees. (Existing seed orgs already have users.)
1. Login as **Riya (employee)** → create an expense (e.g. ₹3,000) → open it → **Submit**.
2. Login as **Amit (manager)** → **Approvals** tab → **Approve**.
3. Create a ₹20,000 expense as Riya → submit → manager approves → **Neha (finance)** approves → status `approved`.
4. Login as **Neha** → **Dashboard** → see charts populated from real data.
5. Open any expense → see the **approval chain** + **History (audit trail)**.
6. **Attach a bill at creation:** on the create-expense form pick a receipt
   (image or PDF) before clicking **Create draft** — it's uploaded with the
   draft. You can also add/view bills later from an expense's **Bills** tab
   (thumbnail + **View** to preview). (Seed data already attaches a sample bill.)

### B) Via curl
```bash
# Login -> capture token
TOKEN=$(curl -s -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"riya@acme.test","password":"password123"}' | jq -r .accessToken)

# Create a draft
EID=$(curl -s -X POST localhost:4000/expenses -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"reimbursement","category":"travel","amount":3000,"currency":"INR"}' | jq -r .id)

# Submit it (builds the approval chain)
curl -s -X POST localhost:4000/expenses/$EID/submit -H "Authorization: Bearer $TOKEN"

# Approve as manager
MTOKEN=$(curl -s -X POST localhost:4000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"manager@acme.test","password":"password123"}' | jq -r .accessToken)
curl -s -X POST localhost:4000/expenses/$EID/approve -H "Authorization: Bearer $MTOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' -d '{"reason":"ok"}'

# View audit history
curl -s localhost:4000/expenses/$EID/history -H "Authorization: Bearer $TOKEN" | jq
```

### C) Automated test suite (TDD)
```bash
npm test          # run all tests (uses the ems_test database)
npm run test:cov  # run with coverage report
npm run test:watch
```
- **127 tests**, all passing. Measured coverage: **~94% statements, ~96% lines,
  ~94% functions, ~72% branches**. High coverage on the core flows; the
  uncovered branches are mostly defensive guards (null fallbacks, unreachable
  error paths) — branch % is deliberately not chased to 100%.
- Tests run against a real Postgres `ems_test` DB (auto-migrated); cache uses the
  in-memory implementation. The build fails if coverage drops below thresholds
  (statements/functions/lines 90%, branches 70%).
- **Regression policy:** every user-reported bug gets a dedicated test
  (`tests/integration/ui-fixes.test.ts`, `policy-categories.test.ts`, and
  additions to `expenses.test.ts` / `users.test.ts`). **CI**
  (`.github/workflows/ci.yml`) runs the type-check + full suite on every push and
  PR to `main`, so a regression can't merge.

---

## 5. API reference

All endpoints require `Authorization: Bearer <token>` except `/auth/*`,
`/health`, `/metrics`. Money/state actions accept an optional `Idempotency-Key`.

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/auth/signup` | public | **Tenant onboarding** — creates a new org + first admin (+ default policy/budget), atomically; auto-login |
| POST | `/auth/login` | public | Login, returns access + refresh tokens |
| POST | `/auth/refresh` | public | Rotate a refresh token → new access + refresh (old one revoked) |
| POST | `/auth/logout` | public | Revoke a refresh token |
| GET | `/health` | public | Liveness |
| GET | `/metrics` | public | Prometheus metrics |
| POST | `/expenses` | expense:create | Create draft (**422 if the org has no active policy**) |
| GET | `/expenses?scope=mine\|reportees\|all` | by role | List (paginated, filter by status/type) |
| GET | `/expenses/:id` | owner/mgr/finance | Get one + approval steps |
| PATCH | `/expenses/:id` | requester | Edit (re-evaluates chain if amount crosses threshold) |
| DELETE | `/expenses/:id` | requester | Delete a draft |
| POST | `/expenses/:id/submit` | requester | Submit → builds approval chain (**422 if no eligible approver exists for a level**) |
| POST | `/expenses/:id/approve` | expense:approve | Approve current level |
| POST | `/expenses/:id/reject` | expense:approve | Reject (reason required) |
| POST | `/expenses/:id/withdraw` | requester | Withdraw |
| GET | `/expenses/:id/history` | owner/mgr/finance | Audit trail |
| POST | `/expenses/:id/attachments` | requester | **Upload a bill** (multipart `file`; image or PDF, ≤5MB) while editable |
| GET | `/expenses/:id/attachments` | owner/mgr/finance | List a bill's metadata for an expense |
| GET | `/attachments/:id` | owner/mgr/finance | Download/preview a bill (authenticated, tenant-scoped) |
| GET | `/approvals/pending` | expense:approve | My approval queue |
| POST | `/attachments/presign` | any | Mock S3 presigned URL (documented direct-to-bucket path) |
| GET/POST/PATCH/DELETE | `/policies` | policy:manage (read: analytics:view) | Approval policy CRUD. **Only one policy is active per org** — create/activate auto-deactivates the rest; duplicate names → 409; the active policy can't be deleted (400) |
| GET | `/categories` | any | List the org's active expense categories |
| POST/DELETE | `/categories` | policy:manage | Add / soft-deactivate an expense category (duplicate → 409) |
| GET/POST | `/budgets` | budget:manage (read: analytics:view) | Budgets |
| GET | `/budgets/utilization` | any | Current user's budget utilization |
| GET/POST/PATCH | `/users` | user:manage | User management. `PATCH …{isActive:false}` deactivates a user (can't deactivate yourself or the last active admin); inactive users can't log in or be assigned as approvers |
| GET | `/notifications` / POST `/:id/read` | any | In-app notifications |
| GET | `/analytics/summary\|spend\|by-status\|by-category\|audit-volume` | analytics:view | Dashboard data |

---

## 6. Feature matrix — expected vs current behaviour

| Feature | Expected behaviour | Current | Test(s) |
|---|---|---|---|
| Multi-tenancy | Users only see their org's data | ✅ Works | `expenses.test.ts › isolates data across tenants`, `onboarding.test.ts` |
| Tenant onboarding | New org self-serve signup (org + first admin + defaults) | ✅ | `onboarding.test.ts` |
| Add employees | Admin creates users in their org (UI form + API) | ✅ | `users.test.ts`, `onboarding.test.ts` |
| Auth | Valid creds → token; invalid → 401 | ✅ | `auth.test.ts` |
| RBAC | Permissions enforced per role | ✅ | `permissions.test.ts`, `expenses.test.ts`, `users.test.ts` |
| Expense CRUD | Create/edit/delete draft, both types | ✅ | `expenses.test.ts`, `edge.test.ts` |
| Lifecycle | draft→in_review→approved/rejected/withdrawn | ✅ | `expenses.test.ts` |
| Multi-level approval | Chain built from policy by amount; **stages are sequential** (L2 notified only after L1 approves) | ✅ | `expenses.test.ts` (1/2/3-level) |
| Self-approval block | Cannot approve own expense; approver resolution **routes to another eligible user**, never the requester | ✅ | `expenses.test.ts › prevents self-approval`, `› routes an admin's own expense to another admin` |
| No-approver block | Submit fails (422) if no eligible approver exists for a level | ✅ | `expenses.test.ts`, `policy-categories.test.ts` |
| No-policy block | Creating an expense fails (422) if the org has no active policy | ✅ | `edge.test.ts`, `ui-fixes.test.ts` |
| Wrong-approver block | Only assigned approver can act | ✅ | `expenses.test.ts`, `branches.test.ts` |
| Reject reason required | Reject without reason → 400 | ✅ | `expenses.test.ts` |
| Idempotency | Repeat approve w/ key = no double-apply | ✅ | `expenses.test.ts › idempotent` |
| Budget enforcement | Over daily/monthly limit → 422 | ✅ | `expenses.test.ts`, `edge.test.ts` |
| Chain re-eval on edit | Amount crosses threshold → new chain | ✅ | `expenses.test.ts › re-evaluates` |
| Multi-currency | Convert to base + store fx_rate | ✅ | `currency.test.ts`, `expenses.test.ts` |
| Audit trail | Every change logged immutably, in-txn | ✅ | `misc.test.ts › audit` |
| Audit S3 shipping | Only ships when flag enabled | ✅ | `misc.test.ts › ships audit` |
| Notifications | Generated on workflow events | ✅ | `misc.test.ts › notifications` |
| Bill uploads | Upload image/PDF, list, download; type/size/permission enforced | ✅ | `attachments.test.ts` |
| S3 presign (mock) | Mock presigned URL | ✅ | `misc.test.ts › attachments` |
| Policy CRUD + validation | Bad ranges → 422 | ✅ | `policy.test.ts`, `branches.test.ts` |
| Single active policy | One active policy/org; create/activate deactivates others; dup name → 409; active can't be deleted | ✅ | `policy-categories.test.ts` |
| Expense categories | Admin-managed per-org categories (UI dropdown); dup → 409 | ✅ | `policy-categories.test.ts` |
| User deactivation | Admin deactivates/reactivates users; self & last-admin guarded | ✅ | `users.test.ts` |
| Analytics | Summary + breakdowns + cache | ✅ | `analytics.test.ts`, `branches.test.ts` |
| Metrics | Prometheus `/metrics` | ✅ | `metrics.test.ts`, `auth.test.ts` |

---

## 7. Caveats & known limitations (prototype)

These are **intentional** scope cuts (see Level 2 doc §15 for the production approach):

1. **Bill storage is local, not S3 (yet).** Uploaded bills are *really* stored —
   bytes go through a `BlobStorage` abstraction whose default `LocalDiskStorage`
   driver writes under `UPLOADS_DIR` (`var/uploads/`), with metadata in Postgres
   and authenticated, tenant-scoped download. Production swaps in an `S3Storage`
   implementing the same interface (the object key format is already S3-shaped).
   The separate `/attachments/presign` endpoint (fake URL) documents the
   alternative *direct-to-bucket* upload path. Audit S3 shipping still writes to
   an in-memory sink.
2. **Redis is optional / mocked in tests.** Default run uses the in-memory cache.
   A `RedisCache` slot exists in `cache.ts` to wire real Redis.
3. **FX rates are static** (`currency.ts`), not from a live provider.
4. **Tenant isolation is enforced at the application layer**, not in the DB.
   Every query is scoped by the `org_id` derived from the token, but a single
   forgotten `WHERE org_id` would leak across tenants. Production hardening is
   **Postgres Row-Level Security** as defense-in-depth (see §8 / technical doc).
5. **Approver resolution is basic**: `manager` = requester's manager (fallback to
   first *other* org manager); `finance`/`admin` = first active user with that
   role **excluding the requester**, so an expense never routes to its own author
   (if no other eligible approver exists, submit is blocked with a 422). No
   routing rules, no delegation, no load-balancing across approvers.
6. **SLA is stored, not enforced.** `sla_due_at` is set and surfaced (dashboard
   "SLA breached"), but there is **no scheduler** to auto-escalate. Production
   would use a durable timer (Temporal/cron + queue).
7. **Tolerance (±%) for company-paid** is stored on the policy but the
   delta-reapproval branch is **not** implemented (documented only).
8. **No OCR** bill validation.
9. **Single Postgres, single node.** No sharding, no read replicas, no multi-AZ
   — all documented as the production path, not built.
10. **Reject terminates the chain** (no send-back-to-requester variant yet).
11. **Notifications are in-app only** (persisted + console log); no email/SMS/push.
12. **No rate limiting / WAF / secrets manager** — env-based config only.
13. **Tests run serially** (`--runInBand`) against a shared test DB and truncate
    between cases; not designed for parallel CI workers without a DB-per-worker.

---

## 8. Security, isolation & concurrency (design decisions)

**Tokens.** Access tokens are short-lived JWTs carrying `{ id, org_id, role,
email }`. Refresh tokens are **opaque random strings, stored only as SHA-256
hashes** (`refresh_tokens` table). `/auth/refresh` performs **single-use
rotation**: the presented token is revoked and a replacement issued. Presenting
an already-revoked token is treated as **reuse/theft** and revokes the user's
whole session family. `/auth/logout` revokes a token. This is the production
pattern, just without a distributed token store. *(Code: `auth/refreshToken.ts`.)*

**Tenant isolation.** `org_id` is taken from the verified token — never from the
client — and applied to every query. This is correct but app-layer only; one
missing predicate is a cross-tenant leak. The defense-in-depth answer is
**Postgres Row-Level Security**: a `tenant_isolation` policy
(`USING (org_id = current_setting('app.org_id')::uuid)`) with the org id set per
transaction (`SET LOCAL app.org_id = …` inside `withTransaction`). It is
documented rather than enabled here because RLS interacts with connection pooling
and the seed/migration paths — but it's the first thing to turn on for real
multi-tenant traffic.

**Concurrency / no double-apply.** Every state transition runs in a transaction
that first does `SELECT … FOR UPDATE` on the expense row (`getByIdForUpdate`).
Two managers approving the same expense at once are **serialized by Postgres**:
the second blocks, then re-reads the committed state and is rejected by the
status/level guards. Idempotency keys are a separate concern — they only dedupe
*identical retries* of one request; the row lock is what handles *distinct
concurrent* requests.

---

## 9. Project structure

```
app/
  src/
    config.ts            env config
    db/                  pool, schema.sql, migrate, seed
    cache/               cache interface + in-memory impl
    storage/             blob storage interface + local-disk impl (S3-ready)
    auth/                jwt, password, middleware
    rbac/                role → permission map
    http/                app factory, errors, asyncHandler, idempotency
    metrics/             in-process metrics + /metrics
    modules/
      users/  orgs/  policy/  categories/  budget/  expenses/  workflow/
      audit/  notifications/  analytics/  attachments/
  public/                static UI (index.html, app.js, styles.css)
  tests/                 unit + integration tests
```
