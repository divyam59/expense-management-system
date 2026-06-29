# Expense Management System (EMS) — Level 2 Design Document

> **This is the primary design deliverable.** It is structured to map 1:1 with
> the assignment's required deliverables. Every section ends with a
> **"Prototype scope vs Production approach"** callout that states what is built
> now and **how it would be implemented in a real system**.
>
> **One-line summary:** A multi-tenant SaaS platform where employees submit
> expenses (reimbursement or direct company payment), which flow through
> configurable, policy-driven multi-level approvals, governed by RBAC, with a
> first-class immutable audit trail and an observability dashboard.

---

## Table of Contents
1. Assumptions
2. Functional Requirements
3. Non-Functional Requirements
4. System Architecture
5. Data Model
6. APIs
7. Workflow Engine Approach
8. Role / Permission Model (RBAC)
9. Scalability Strategy
10. Security Considerations
11. Failure Handling
12. Audit Mechanisms
13. Observability
14. Tradeoffs Summary
15. Out-of-Scope & Production Roadmap (consolidated)

---

## 1. Assumptions

- **Multi-tenant SaaS:** one deployment serves many organizations; all data is
  scoped and isolated by `organization_id`.
- A **Manager is a User** with reportees (self-referential `manager_id`), not a
  separate entity.
- Approval rules are **threshold (amount) based**, configured per organization;
  the engine is generic enough to extend to category/type-based rules.
- Two expense flows:
  - **Reimbursement** — employee already spent; claims money back (approve-after-spend).
  - **Direct company payment** — employee requests first; company pays vendor after
    approval (approve-before-spend; amount is an estimate, with a tolerance band).
- Each org has a **base/reporting currency**; expenses may be filed in any currency
  and are converted at submission using a stored FX rate.
- Money movement (actual payout / vendor payment) is **out of scope**; the system
  tracks status up to `APPROVED`/`PAID` and integrates with an external payment
  system in production.

---

## 2. Functional Requirements

### Built (prototype)
| # | Requirement |
|---|-------------|
| F1 | Multi-tenancy (org isolation across all entities) |
| F2 | Auth + RBAC (employee, manager, finance, admin) |
| F3 | Expense CRUD for both types (reimbursement, company-paid) |
| F4 | Expense lifecycle state machine (draft → … → approved/rejected/paid, withdrawn) |
| F5 | Configurable multi-level approval engine (policy-driven) |
| F6 | Approve / reject with mandatory reason |
| F7 | Policy CRUD (amount thresholds → approver levels) |
| F8 | Budget enforcement (daily/monthly limits) |
| F9 | Attachments via S3 pre-signed URLs |
| F10 | Multi-currency (amount, currency, base_amount, fx_rate) |
| F11 | Immutable audit trail + history API |
| F12 | Notifications (persisted in-app) |
| F13 | List/queue views (mine, pending, reportees, all) with pagination |
| F14 | Self-approval prevention |
| F15 | Observability dashboard (charts) |

### Documented but not built (with production approach)
| Requirement | Why deferred | How to build for real |
|---|---|---|
| **OCR bill validation** (blur/amount mismatch) | ML + async infra heavy | Async worker calling AWS Textract / Google Vision / Tesseract; compare extracted total vs claimed; flag mismatch/blur; store confidence; human-in-the-loop review queue. |
| **Approver delegation** (on leave) | Calendar + rule complexity | Per-user "out-of-office" with delegate; at step creation, resolve to delegate; record both principal & delegate in audit. Prototype: manual reassign by admin. |
| **SLA auto-escalation** | Needs durable scheduler | Store `sla_due_at`; production uses a scheduler (Temporal timers / cron + queue) to remind, then escalate to next level or manager after timeout. Prototype: store the field + expose an `overdue` flag. |
| **Direct-payment tolerance re-approval** | Edge branch | Policy field `tolerance_percent`; if actual ≤ approved×(1+tolerance) auto-pass, else open a delta-approval step. Prototype: store field + simple check only. |
| **Resubmit-after-reject / comments thread / draft autosave** | Nice-to-have | Standard CRUD extensions; resubmit clones with a `parent_id` link. |

---

## 3. Non-Functional Requirements

Primary focus (implemented): **Audit, Security, Scalability (pragmatic), Observability.**

| NFR | Target | Built now | Production approach |
|---|---|---|---|
| **Security** | AuthZ on every route, tenant isolation | JWT, RBAC middleware, org scoping, validation, idempotency, private S3 | Secrets manager, WAF, gateway rate-limiting, field-level encryption, SSO/SAML |
| **Auditability** | Every state change recorded immutably | Append-only `audit_log` + history API + optional S3 shipping | Hash-chain tamper-evidence, WORM storage, SIEM export |
| **Scalability** | Horizontal scale, read-heavy reads fast | Stateless app, Redis cache, pagination, indexes | Read replicas, materialized views, sharding by `org_id`, CQRS, event outbox |
| **Availability** | Survive single-node failure | Single managed Postgres + health checks | Multi-AZ active-passive/active-active, replicas, auto-failover |
| **Consistency** | Money/approvals exact | Strong consistency via DB transactions | Keep writes strongly consistent; reads eventual via replicas/cache |
| **Idempotency** | Safe retries | `Idempotency-Key` on money/state actions | Dedup store with TTL in Redis/DB |
| **Performance** | p99 API < ~300ms | Indexes + cache | Profiling, query tuning, CDN for static, connection pooling |
| **Observability** | Visibility into spend + health | Built-in dashboard + `/metrics` | Prometheus/Grafana, OpenTelemetry tracing, ELK logs |
| **Compliance/Retention** | Keep financial records | S3 shipping for long-term | 7-yr retention policy, GDPR data-subject flows, PII encryption |
| **DR** | Recover from disaster | (documented) | Automated backups, cross-region replication, RPO/RTO targets |

---

## 4. System Architecture

### Prototype (modular monolith)
```
                 ┌─────────────────────────────────────────┐
   Client  ──►   │            EMS Monolith (Node/TS)        │
 (web/curl)      │                                          │
                 │  HTTP layer: auth mw → RBAC mw → routes  │
                 │                                          │
                 │  Modules:                                │
                 │   • auth        • expenses               │
                 │   • workflow    • policy/budget          │
                 │   • audit       • notifications          │
                 │   • analytics                            │
                 │                                          │
                 │  Shared: validation, idempotency, errors │
                 └──────┬───────────────┬───────────┬───────┘
                        │               │           │
                   ┌────▼────┐     ┌────▼────┐  ┌───▼────┐
                   │Postgres │     │ Redis   │  │  S3    │
                   │(SoR)    │     │ (cache) │  │(files +│
                   │         │     │         │  │ audit) │
                   └─────────┘     └─────────┘  └────────┘
```
- **Modular monolith:** one deployable, clear module boundaries so it can be
  split into services later without rewrites.
- **Postgres = system of record** (no in-memory). **Redis = cache only.**
- **S3** for attachments + optional audit log shipping.

### Production (service-oriented, target)
```
Client → CDN → API Gateway (authn, rate-limit)
        │
        ├── Expense Service ─────┐
        ├── Workflow Service ────┤→ Postgres (sharded by org_id) + Read Replicas
        ├── Policy Service ──────┤
        ├── Notification Service │→ Message Queue (Kafka/SQS) via Outbox
        ├── Audit Service ───────┘→ S3 (WORM) + SIEM
        └── Analytics/Read Service → Materialized views / OLAP store
```

**Tradeoff:** Monolith chosen for the prototype because it ships fastest, is
easiest to demo, and keeps transactions simple (single DB). Microservices add
operational overhead (network, distributed transactions, eventual consistency)
unjustified at prototype stage — but the module boundaries make the split cheap
when scale demands it.

**Prototype vs Production:** Built = monolith + Postgres + Redis + S3.
Not built = gateway, per-service DBs, message queue, OLAP — documented above.

---

## 5. Data Model

> All tables carry `org_id` (tenant key). Enums used for `role`, `type`, `status`.

### Core entities
| Entity | Key fields |
|---|---|
| **Organization** | `id, name, base_currency, settings_json, created_at` |
| **User** | `id, org_id, name, email(unique per org), password_hash, role, manager_id?, is_active, created_at` |
| **Policy** | `id, org_id, name, rules_json, tolerance_percent?, active, version, created_at` |
| **Budget** | `id, org_id, user_id?, scope[user|org], period[daily|monthly], limit_amount, currency` |
| **ExpenseRequest** | `id, org_id, requester_id, type, category, description, amount, currency, base_amount, fx_rate, status, policy_snapshot_json, current_level, sla_due_at, created_at, updated_at` |
| **ExpenseLineItem** (opt) | `id, org_id, expense_id, description, amount, category` |
| **Attachment** | `id, org_id, expense_id, s3_key, filename, content_type, size, uploaded_by, uploaded_at` |
| **ApprovalStep** | `id, org_id, expense_id, level, required_role, approver_id, status, reason?, acted_at?, sla_due_at?` |
| **AuditLog** | `id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json, reason?, request_id, created_at` (append-only) |
| **Notification** | `id, org_id, user_id, type, payload_json, read, created_at` |
| **IdempotencyKey** | `key, org_id, endpoint, response_hash, created_at` |

### Enums
- `role`: `employee | manager | finance | admin`
- `expense.type`: `reimbursement | company_paid`
- `expense.status`: `draft | submitted | in_review | approved | rejected | paid | withdrawn`
- `approval_step.status`: `pending | approved | rejected | skipped`

### `policy.rules_json` (the workflow brain)
```json
{
  "currency": "INR",
  "rules": [
    { "min": 0,     "max": 5000,  "levels": ["manager"] },
    { "min": 5001,  "max": 50000, "levels": ["manager", "finance"] },
    { "min": 50001, "max": null,  "levels": ["manager", "finance", "admin"] }
  ]
}
```

### Key indexes
- `expense_request (org_id, status)`, `(org_id, requester_id)`, `(org_id, created_at)`
- `approval_step (org_id, approver_id, status)` — drives the pending-approvals queue
- `audit_log (org_id, entity_type, entity_id)`, `(org_id, created_at)`

**Prototype vs Production:** Built = single Postgres schema with the above tables
+ indexes. Not built = sharding/partitioning (by `org_id`), table partitioning of
`audit_log` by month, materialized views for analytics — documented in §9.

---

## 6. APIs

REST, JSON, JWT-authenticated (except login). `org_id` derived from token.
State-changing money actions accept an `Idempotency-Key` header. List endpoints
support `?page=&limit=&sort=&filter=`.

```
# Auth
POST   /auth/login
POST   /auth/refresh

# Expenses
POST   /expenses                      # create draft
GET    /expenses                      # list (mine|reportees|all per role)
GET    /expenses/{id}
PATCH  /expenses/{id}                  # edit (draft/before approval)
DELETE /expenses/{id}                  # delete draft
POST   /expenses/{id}/submit           # build approval chain
POST   /expenses/{id}/approve          # approver action (idempotent)
POST   /expenses/{id}/reject           # approver action + reason
POST   /expenses/{id}/withdraw         # requester cancels
GET    /expenses/{id}/history          # audit trail

# Attachments
POST   /attachments/presign            # presigned PUT url + key

# Approvals
GET    /approvals/pending              # my approval queue

# Policy / Budget / Users (admin)
POST   /policies   GET /policies   PATCH /policies/{id}   DELETE /policies/{id}
POST   /budgets    GET /budgets
POST   /users      GET /users      PATCH /users/{id}

# Notifications
GET    /notifications
POST   /notifications/{id}/read

# Observability / Analytics (admin, finance)
GET    /analytics/summary
GET    /analytics/spend
GET    /analytics/by-status
GET    /analytics/by-category
GET    /analytics/audit-volume
GET    /metrics                        # Prometheus text format
```

Standard error envelope: `{ "error": { "code", "message", "details" } }`.

**Prototype vs Production:** Built = all above as monolith routes.
Not built = API versioning strategy at gateway, webhooks for external systems,
GraphQL/BFF for rich clients, public partner API with API keys + quotas.

---

## 7. Workflow Engine Approach

**Goal:** approvals must be **configurable per organization**, not hardcoded.

### Design: declarative, policy-driven, snapshotted
1. **Resolve policy** for the org (and optionally category/type).
2. On **submit**, evaluate `rules_json` against the expense's `base_amount` to get
   the ordered list of **required levels** (e.g. `["manager", "finance"]`).
3. **Snapshot** the matched policy into `expense.policy_snapshot_json` so later
   policy edits never change an in-flight request.
4. **Generate `ApprovalStep` rows**, one per level, in order. Resolve the actual
   approver for each level:
   - `manager` → `requester.manager_id`
   - `finance` / `admin` → a user holding that role in the org (configurable
     routing; default: first active user with the role / a designated approver)
5. Set the first step to `pending`, expense → `in_review`, `current_level = 1`.

### State machine
```
draft ──submit──► submitted ──auto──► in_review ──(all steps approved)──► approved ──pay──► paid
  │                                      │
  │                                  (any reject)
  └──delete──► (gone)                     ▼
in_review/submitted ──withdraw──► withdrawn
                                       rejected
```
- **Approve:** mark current step approved → if more steps, advance & notify next
  approver; if last, expense → `approved`.
- **Reject:** mark step rejected → expense → `rejected` (config: terminate-all is
  default; send-back-to-requester is an option).
- **Self-approval prevention:** an approver cannot act on a step where they are
  the requester; resolution skips/blocks such assignment.
- **Edit re-evaluation:** editing amount before final decision re-runs rule
  matching; if the required chain changes, steps are regenerated (old pending
  steps invalidated, audited).
- **SLA:** each step gets `sla_due_at`; overdue surfaced via `overdue` flag (and
  dashboard). Auto-escalation is the production extension.
- **Idempotency:** approve/reject are idempotent via `Idempotency-Key` +
  step-status check (acting on an already-decided step is a no-op).

### Why this approach (tradeoff)
- **Custom lightweight engine** chosen over a full BPMN/workflow engine
  (Camunda, Temporal) for prototype speed and full control over a simple,
  linear-with-levels model.
- **Production approach:** for durable timers, retries, long-running escalations,
  and complex branching (parallel approvals, conditional routing), adopt
  **Temporal** or a BPMN engine. The declarative `rules_json` + `ApprovalStep`
  model maps cleanly onto such an engine later.

**Prototype vs Production:** Built = sequential multi-level engine, policy
snapshot, re-evaluation, self-approval guard, idempotency, SLA field.
Not built = parallel/conditional approvals, delegation engine, durable timer
auto-escalation — documented above.

---

## 8. Role / Permission Model (RBAC)

### Roles → capabilities
| Capability | employee | manager | finance | admin |
|---|:--:|:--:|:--:|:--:|
| Create/edit/withdraw own expense | ✅ | ✅ | ✅ | ✅ |
| View own expenses | ✅ | ✅ | ✅ | ✅ |
| View reportees' expenses | — | ✅ | — | ✅ |
| View all org expenses | — | — | ✅ | ✅ |
| Approve/reject (as assigned step) | — | ✅ | ✅ | ✅ |
| Manage policies/budgets | — | — | ✅ | ✅ |
| Manage users/roles | — | — | — | ✅ |
| View analytics dashboard | — | reportees | ✅ | ✅ |

### Enforcement model
- **Permission = (resource, action)** checked by middleware from the JWT role.
- **Scope checks (ownership/hierarchy)** layered on top: e.g. a manager may
  approve only steps assigned to them and view only reportees' data.
- **Tenant scope:** every query is filtered by `org_id` from the token — the
  outermost guardrail.

**Tradeoff & production approach:** Static role→permission mapping is simple and
enough for the prototype. Real enterprises need **ABAC** (attribute-based:
department-scoped finance, cost-center owners), **custom roles**, and
**fine-grained permission policies** (e.g. OPA/Cedar). The `Role`/`Permission`
tables are structured so this can grow from RBAC → ABAC without a redesign.

---

## 9. Scalability Strategy

| Concern | Prototype | Production |
|---|---|---|
| App scaling | Stateless (JWT) → run N instances | Auto-scaling group behind LB |
| Read-heavy lists/queues | Redis cache + indexes + pagination | Read replicas + materialized views; CQRS read model |
| Hot tables | Single Postgres | **Shard by `org_id`**; partition `audit_log`/`expense` by time |
| Analytics | On-the-fly aggregation (cached) | Pre-aggregated rollup tables / OLAP (ClickHouse/Redshift) |
| Async work (notifications, OCR, S3 shipping) | In-process async / best-effort | **Outbox pattern → Kafka/SQS → workers** |
| Files | Direct-to-S3 via presigned URLs (no app bandwidth) | + CDN for retrieval |
| Multi-region | Single region | Active-passive or active-active, geo-routing |

**Key tradeoff:** strong consistency is preserved for **writes** (money/approvals
via DB transactions); **reads** are allowed to be eventually consistent (cache /
replicas) to scale the read-heavy workload. This split is intentional and stated.

---

## 10. Security Considerations

| Area | Prototype | Production |
|---|---|---|
| AuthN | JWT (short access + refresh), hashed passwords (argon2/bcrypt) | + SSO/SAML/OIDC, MFA |
| AuthZ | RBAC middleware per route + ownership/hierarchy checks | + ABAC / policy engine (OPA/Cedar) |
| Tenant isolation | `org_id` enforced in every repository query | + row-level security in DB, per-tenant keys |
| Input | Schema validation (zod), reject unknown fields | + schema registry, fuzzing |
| Idempotency | `Idempotency-Key` on state/money actions | dedup store with TTL |
| Files | Private bucket, time-limited presigned URLs | + virus scan, signed downloads, object-lock |
| Transport | TLS assumed at edge | TLS everywhere, mTLS between services |
| Secrets | Env config | Secrets manager / KMS, rotation |
| Data protection | — | PII encryption at rest, field-level encryption, tokenization |
| Abuse | — | Gateway rate-limiting, WAF, anomaly detection |

OWASP Top-10 mindset: authz on every endpoint, no IDOR (ownership checks),
parameterized queries (no SQLi), output encoding, audit of sensitive actions.

---

## 11. Failure Handling

| Failure | Prototype behavior | Production approach |
|---|---|---|
| Duplicate/retried request | Idempotency key → no double approve/submit | Same, with distributed dedup store |
| Partial write | DB **transaction** wraps expense+steps+audit (atomic) | Same + saga for cross-service |
| Redis down | Fall back to Postgres (cache optional, not SoR) | Circuit breaker, graceful degradation |
| S3 audit shipping fails | Best-effort + retry; **never blocks** DB write | Outbox + retry queue + DLQ |
| Notification send fails | Persisted in DB; retried; user still sees in-app | Queue + retries + DLQ |
| Approver unavailable | Manual reassign (admin) | Delegation + SLA escalation |
| DB node failure | Managed Postgres restart | Multi-AZ replica + auto-failover |
| Poison message / stuck job | — | DLQ + alerting + manual replay |

**Principles:** make writes **atomic + idempotent**; treat side-effects
(notifications, S3, OCR) as **best-effort, retryable, non-blocking**; the DB is
the single source of truth that everything reconciles to.

---

## 12. Audit Mechanisms

- **Append-only `audit_log`** (no UPDATE/DELETE). Every state transition routes
  through a single `AuditService.record(actor, action, entity, before, after,
  reason, request_id)`.
- Captures **who, what, when, before→after, why (reason), correlation id**.
- Written **inside the same DB transaction** as the change → audit can never
  diverge from reality (satisfies the "consistent audits" NFR).
- Exposed to users via `GET /expenses/{id}/history` (UI "History" tab).
- **S3 log shipping (feature-flagged):** async, batched, best-effort export of
  audit entries to S3 (NDJSON, partitioned `org_id/date`) for durable, cheap,
  long-term retention and hot-DB offload. Postgres remains source of truth.
- **Production extensions:** hash-chain (`prev_hash`) for tamper-evidence,
  WORM/object-lock storage, SIEM streaming, 7-year retention, periodic integrity
  verification jobs.

---

## 13. Observability

- **Built-in dashboard** (admin/finance) with basic charts:
  - Business: spend over time, status mix, spend by category, pending &
    SLA-breached approvals, avg approval cycle time, budget utilization, audit
    volume.
  - Health: request rate, error rate, p95 latency; `GET /metrics` (Prometheus
    text format).
- Analytics endpoints read from Postgres aggregations, cached in Redis (short
  TTL) — also demonstrates the read-heavy/caching strategy.
- **Production:** Prometheus + Grafana dashboards, OpenTelemetry distributed
  tracing, centralized structured logging (ELK/Loki), alerting (PagerDuty).

---

## 14. Tradeoffs Summary

| Decision | Chosen | Rejected alternative | Why |
|---|---|---|---|
| Architecture | Modular monolith | Microservices | Faster to ship/demo, simple transactions; boundaries keep split cheap later |
| Workflow | Custom declarative engine | Temporal/Camunda | Control + speed for a linear-levels model; documented upgrade path |
| Consistency | Strong writes / eventual reads | Strong everywhere | Scales read-heavy load without risking money correctness |
| AuthZ | RBAC (+ownership) | ABAC/policy engine | Enough for prototype; schema allows growth |
| Store | Postgres SoR + Redis cache | In-memory / Redis SoR | Durability + correctness; cache is disposable |
| Audit | In-txn append-only + async S3 | Async-only logging | Guarantees audit ≡ reality; S3 adds retention without blocking |
| Side-effects | Best-effort, retryable | Synchronous inline | Resilience; failures don't block core flow |

---

## 15. Out-of-Scope & Production Roadmap (consolidated)

Everything intentionally **not built**, with the real-system approach:

1. **OCR bill validation** → async Textract/Vision worker + review queue.
2. **Delegation engine** → out-of-office + delegate resolution at step creation.
3. **SLA auto-escalation** → durable scheduler (Temporal timers) → remind/escalate.
4. **Tolerance re-approval branch** → delta-approval step beyond policy tolerance.
5. **Microservices split** → gateway + per-service DBs + queue (outbox).
6. **DB sharding/partitioning** → shard by `org_id`, time-partition audit/expense.
7. **Read replicas + materialized views / OLAP** → reporting at scale.
8. **Multi-AZ/region HA + DR** → replicas, auto-failover, backups, RPO/RTO.
9. **Real payment/payout integration** → external payment provider + reconciliation.
10. **Advanced security** → SSO/MFA, secrets manager, WAF, ABAC/OPA, PII encryption.
11. **Full observability stack** → Prometheus/Grafana, tracing, log aggregation.
12. **Tamper-evident audit** → hash-chain + WORM + SIEM + integrity jobs.

> The prototype proves the **core** (multi-tenant expenses, configurable
> multi-level approvals, RBAC, audit, observability). This roadmap shows the
> path from prototype to an enterprise-grade, globally scalable platform.
