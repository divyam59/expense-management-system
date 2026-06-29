# EMS — Level 2.3: Priority NFR Deep Dive

> **Scope.** `level-2.1-nfr-deep-dive.md` covers *all ten* NFRs broadly (queue,
> multi-tenant scaling, DR, compliance…). This document goes **deeper on the six
> NFRs that matter most for this system** and ties every claim to the **actual
> code in `project-ems/app`**, with an honest *built vs. production-plan* split.
> It adds two implementation chapters the others only touched: **DB planning**
> and **Redis usage**.
>
> Priority order (most-concerning first):
> **Security · Auditability · Consistency · Availability · Latency · Scalability.**
>
> Each section uses the same template:
> **(a) what it means here → (b) what's built (with file refs) → (c) how it
> actually works → (d) gaps & production plan → (e) how it's tested.**

---

## Table of Contents
1. System shape (one screen)
2. Security
3. Auditability
4. Consistency
5. Availability
6. Latency (performance)
7. Scalability
8. DB Planning
9. Redis Usage
10. Built-vs-Production matrix (all six NFRs)

---

## 1. System shape (one screen)

```
            ┌──────────────────────────────────────────────────────┐
 Browser ──►│  Express app (stateless)                             │
  (JWT)     │   authenticate → requirePermission → handler         │
            │      │                                               │
            │      ├── withTransaction(BEGIN…COMMIT)               │
            │      │     ├── SELECT … FOR UPDATE  (row lock)       │
            │      │     ├── business write                        │
            │      │     ├── recordAudit(client)   (same txn)      │
            │      │     └── saveIdempotentResponse(client)        │
            │      │                                               │
            │      ├── getCache() ── MemoryCache (Redis seam)      │
            │      └── metricsMiddleware → /metrics (Prometheus)   │
            └───────────────┬──────────────────────────────────────┘
                            ▼
                 PostgreSQL  (system of record, Pool max=10)
                            │
              best-effort ──┘──► shipAuditToS3()  (flag-gated, mocked)
```

Key invariants the code enforces:
- **Every** tenant row carries `org_id`; **every** query filters on it.
- **Every** state change runs inside one DB transaction with a `FOR UPDATE`
  lock and an in-transaction audit row.
- The app holds **no session state** — access is a short-lived JWT; the only
  server-side auth state is the `refresh_tokens` table.

---

## 2. Security

### (a) What it means here
AuthN (who you are), AuthZ (what you may do), **tenant isolation** (you only
ever see your org), input safety, and credential/secret protection. The headline
threats are **account takeover**, **cross-tenant IDOR**, and **privilege
escalation**.

### (b) What's built
| Control | Where | Notes |
|---|---|---|
| Password hashing | `auth/password.ts` | `bcryptjs`, cost 10 |
| Access token | `auth/jwt.ts` | HS256 JWT, **1h TTL** (`jwtAccessTtl`), carries `{id, org_id, role, email}` |
| Refresh token | `auth/refreshToken.ts` + `refresh_tokens` table | **opaque random 32-byte**, stored only as **SHA-256 hash**, single-use **rotation**, **reuse → revoke all sessions** |
| AuthN middleware | `auth/middleware.ts` | `authenticate()` rejects missing/invalid bearer → 401 |
| AuthZ | `rbac/permissions.ts` + `requirePermission()` | role→permission map, **deny-by-default** |
| Tenant isolation | every `*.repo.ts` | `WHERE org_id=$1` on every read/write |
| Input validation | zod DTOs in routes | unknown fields rejected/stripped |
| Error envelope | `http/errors.ts` + `app.ts` | uniform `{error:{code,message}}`; no stack leakage |

### (c) How it actually works
- **Rotating refresh tokens (the strong part).** `rotateRefreshToken()` looks up
  the presented token *by its hash*. If it's already revoked, that's a **replay /
  theft signal** → it revokes **every** live token for that user and throws.
  Otherwise it revokes the presented token, issues a new one, and chains them via
  `replaced_by`. The user is **re-read from the DB** on every rotation, so a
  deactivated user or a role change takes effect at the next refresh — the JWT
  can't outlive the user's status by more than its 1h TTL.
- **Deny-by-default AuthZ.** `hasPermission()` returns `false` for anything not
  explicitly granted; routes declare the exact permission they need
  (`expense:approve`, `user:manage`, …). Ownership/hierarchy is a second layer:
  `assertCanView()` allows the requester, `read:all` (finance/admin),
  `read:reportees` (a manager's reports), **or an assigned approver**.
- **Cross-tenant isolation returns 404, not 403.** A lookup is always
  `WHERE id=$1 AND org_id=$2`; another tenant's id simply "doesn't exist" — so we
  never leak existence (no IDOR oracle).

### (d) Gaps & production plan
| Gap (today) | Production |
|---|---|
| JWT signed with a single shared `JWT_SECRET` | Asymmetric keys (RS256/EdDSA) + JWKS rotation; or move to opaque sessions in Redis |
| No rate limiting / WAF / `helmet` headers | Gateway token-bucket per IP **and** per `org_id`; helmet/CSP; WAF |
| No MFA / SSO | SAML/OIDC SSO, MFA, device trust |
| Isolation is app-layer only | Postgres **RLS** as defence-in-depth (policy `org_id = current_setting('app.org')`) |
| Secrets in env / `.env` | AWS Secrets Manager + KMS, rotation, no secrets in logs |
| Files served via authenticated app route | Add AV scan + S3 object-lock + signed, time-boxed downloads |

### (e) Tested
- Cross-tenant access → **404** integration tests on get/list/attachment paths.
- Refresh-token **reuse → all sessions revoked** test.
- RBAC: wrong-role → 403; self-approval blocked; only assigned approver may act.

---

## 3. Auditability

### (a) What it means here
Every state change is **immutable, attributable, and queryable**, and the audit
log can **never diverge from reality** ("audit ≡ state").

### (b) What's built
| Piece | Where |
|---|---|
| Append-only table | `audit_logs` (`org_id, actor_id, action, entity_type, entity_id, before_json, after_json, reason, request_id, created_at`) |
| Writer | `audit/audit.service.ts` → `recordAudit(input, client?)` |
| History API | `getHistory()` → `GET /expenses/:id/history` |
| S3 shipping (flag) | `audit/s3shipper.ts`, gated by `AUDIT_S3_SHIPPING_ENABLED` |
| Indexes | `idx_audit_entity (org_id, entity_type, entity_id)`, `idx_audit_created (org_id, created_at)` |

### (c) How it actually works
- **Atomicity is the whole point.** `recordAudit()` accepts the **transaction
  client**, so the audit row is `INSERT`ed in the *same* `BEGIN…COMMIT` as the
  business change (see `expense.service.ts`). If the state change rolls back, so
  does its audit row — they can't drift.
- **Attributable & diffable.** Each row stores `actor_id`, a `before_json` /
  `after_json` snapshot, an optional `reason` (e.g. rejection reason), and the
  `request_id` for log correlation.
- **S3 shipping is best-effort and non-blocking.** `recordAudit` calls
  `void shipAuditToS3(...)` — fire-and-forget. In the prototype this writes to an
  in-memory NDJSON sink partitioned `bucket/org_id/date.ndjson`; it can throw and
  the primary write is unaffected. Postgres is the **system of record**; S3 is
  long-term retention.

### (d) Gaps & production plan
| Gap | Production |
|---|---|
| Append-only by convention, not enforced | Revoke `UPDATE`/`DELETE` on `audit_logs` for the app DB role; add a **hash chain** (`prev_hash` per org) for tamper-evidence |
| S3 sink is in-memory mock | Async **batched** S3 writer with retries + DLQ; "shipped within 15 min" SLO measured by a lag metric |
| Unbounded growth | **Monthly partitioning** on `created_at`; detach + archive cold partitions to Glacier (7-yr financial retention) |
| Completeness by review | CI test that diffs the route list vs. audit-emitting routes |

### (e) Tested
- After approve/reject/withdraw, `GET …/history` shows the expected ordered
  trail with actor + reason.
- With the flag on, the S3 sink receives a partitioned entry.

---

## 4. Consistency

### (a) What it means here
**Strong** consistency for anything touching money/approvals; concurrent actions
on the same expense must never double-apply (e.g. approve **and** reject racing).

### (b) What's built
| Mechanism | Where |
|---|---|
| Transactions | `db/pool.ts` → `withTransaction()` (`BEGIN`/`COMMIT`/`ROLLBACK`) |
| Row locking | `expense.repo.ts` → `getByIdForUpdate()` = `SELECT … FOR UPDATE` |
| Idempotency store | `idempotency_keys` table + `http/idempotency.ts` |
| State guards | status + `current_level` checks in `expense.service.ts` |

### (c) How it actually works
- **Pessimistic lock serializes transitions.** Every state change
  (submit/edit/approve/reject/withdraw) opens a txn and re-reads the expense with
  `SELECT … FOR UPDATE`. Two concurrent approvals on the same expense: the first
  holds the row lock; the second **blocks**, then reads the *post-commit* state
  and is rejected by the status/level guard (it's no longer `in_review` at that
  level). This — not the idempotency key — is what prevents double-apply.
- **Idempotency keys dedupe identical retries.** `approve`/`reject` look up
  `getIdempotentResponse(client, key, org, endpoint)` at the top of the txn; on a
  hit they **return the stored response** instead of re-acting. The key is
  `PRIMARY KEY (key, org_id, endpoint)`, written with `ON CONFLICT DO NOTHING`.
  So a network retry of the *same* call is a no-op; a genuinely new action takes
  the lock path above.
- **Budget check is read-modify-write in the same txn**, so spend can't slip past
  the limit under concurrency.
- **Reads are allowed to be looser.** Lists/dashboards are read-your-writes
  within a request and otherwise eventually consistent (cache TTL, §6/§9).

### (d) Gaps & production plan
| Gap | Production |
|---|---|
| `FOR UPDATE` serializes per-row (fine now) | Keep; for cross-row invariants add explicit advisory locks or `SERIALIZABLE` txns on the few hot paths |
| Idempotency in Postgres | Move to **Redis with TTL** (24h) + DB spillover (§9) |
| Idempotency covers approve/reject | Extend the same wrapper to create/submit/withdraw for full retry-safety |
| Single-DB strong consistency | On sharding, keep each expense + its steps + audit **co-located on one shard** (key = `org_id`) so the txn stays single-node |

### (e) Tested
- Concurrent approve/reject on one expense → exactly one decision wins; the loser
  sees the already-decided state (no 500, no double-apply).
- Replaying an approve with the same `Idempotency-Key` returns the first result.

---

## 5. Availability

### (a) What it means here
Survive the loss of non-DB dependencies without taking user actions down; keep
the app horizontally replaceable.

### (b) What's built
- **Stateless app.** Auth is a JWT; there is **no in-process session** and no
  sticky affinity → any pod can serve any request, so crash/replace is trivial.
- **Cache fails open.** `getCache()` returns a `MemoryCache` that is always
  available; if a value is missing the code reads Postgres. A cache outage
  degrades latency, not correctness.
- **Audit shipping fails open.** `shipAuditToS3` is fire-and-forget and swallows
  errors — an S3 problem never blocks a write.
- **Health probe.** `GET /health` → `{status:'ok'}` for load-balancer checks.
- **Connection pool.** `pg.Pool({ max: 10 })` bounds DB connections per pod.

### (c) How it actually works
The dependency hierarchy is explicit: **Postgres is the only hard dependency for
writes**; cache, S3, and (future) queue all **fail open or buffer**. That's a
deliberate design choice that makes most outages a latency event, not an outage.

### (d) Gaps & production plan
| Gap | Production target |
|---|---|
| Single Postgres instance | Multi-AZ with auto-failover (**RPO≈0, RTO<60s**); read replicas |
| One process holds everything | Separate API pods (HPA) + worker pods; PgBouncer in front of PG |
| No circuit breakers | Breakers around every outbound dep (email/OCR/S3) |
| No region redundancy | Cross-region async replica + DNS failover (**RTO<30 min**) |
| SLOs informal | Core-write 99.9%, read 99.95%, async 99.5%; multi-window burn-rate alerts |

### (e) Tested
- App boots and serves with cache in memory and S3 shipping disabled (the
  default test config) — proving non-DB deps are non-blocking.

---

## 6. Latency (performance)

### (a) What it means here
Synchronous user actions feel instant; we can **measure** p50/p95/p99 and catch
regressions. Working target: **p99 ≤ 300 ms** for sync actions.

### (b) What's built
| Piece | Where |
|---|---|
| Latency instrumentation | `metrics/metrics.ts` (`metricsMiddleware`) |
| Exposition | `GET /metrics` → Prometheus text (`ems_request_latency_ms{quantile=…}`, `ems_requests_total`, `ems_errors_total`) |
| Hot-path indexes | `schema.sql` (see §8) |
| Read cache | `analytics.service.ts` via `getCache()`, 15s TTL |

### (c) How it actually works
- `metricsMiddleware` times every request on `res.finish`, keeps a **rolling
  window of the last 1000 latencies**, and computes p50/p95/p99 on scrape. Error
  rate = 5xx / total. This is enough to *observe* the latency SLO locally.
- The **expensive read** (analytics `summary`) is cached per `org_id` for 15s, so
  repeated dashboard loads don't re-run five aggregate queries each time.
- Hot list/queue endpoints are **index-driven** (org-scoped composite indexes),
  not full scans.

### (d) Gaps & production plan
| Gap | Production |
|---|---|
| In-process metrics (per-pod, rolling 1000) | Scrape into Prometheus/Grafana; histogram buckets, RED dashboards |
| Only `summary` is cached | Cache `pending`, `by-status`, etc. in Redis; per-`org_id`+view keys |
| No load-test gate | k6/Locust per endpoint class in CI; block merge on >20% p99 regression |
| Analytics on raw tables | Rollup/materialised views + OLAP store for very large tenants |

### (e) Tested
- `/metrics` returns valid Prometheus output with the latency quantile lines.

### Latency budget (target SLOs)
| Endpoint class | p50 | p95 | p99 |
|---|---|---|---|
| Auth (`/auth/*`) | 50 | 150 | 300 (bcrypt dominates) |
| Write (submit/approve/reject) | 80 | 200 | 400 |
| Read by id | 30 | 80 | 150 |
| List (paginated) | 60 | 200 | 350 |
| Analytics (cached) | <20 (hit) / 200 (miss) | 500 | 900 |

---

## 7. Scalability

### (a) What it means here
Grow compute, data, and per-tenant load **independently**, and keep one large
tenant from hurting small ones (the "100 vs 10,000 users" problem — full
treatment in `level-2.1` §4).

### (b) What's built (the seams that make scaling cheap later)
- **Stateless app** → horizontal scale is just "more pods" (no session store to
  share).
- **`org_id` on every table + composite indexes** → the natural **shard key** is
  already present; nothing joins across orgs.
- **Bounded pool** (`max: 10`/pod) → predictable DB connection math.
- **Cache abstraction** (`Cache` interface) → swap `MemoryCache`→`RedisCache`
  with no call-site changes.
- **Idempotency + outbox-ready writes** → async fan-out can be added without
  reworking the transaction.

### (c) How it actually works
Because every query is already `org_id`-scoped and the app is stateless, the
three scaling axes are decoupled:
1. **Compute** — add API pods behind the LB (HPA on CPU/RPS).
2. **Data** — vertical → read replicas → **hash-shard on `org_id`**, with
   enterprise tenants **pinned to their own shard**.
3. **Async work** — move side-effects to a queue/worker tier (outbox pattern).

### (d) Gaps & production plan
| Gap | Production |
|---|---|
| One pooled DB | Tiered tenancy (pooled→silo→dedicated); shard by `org_id` + routing catalog |
| No partitioning | Monthly partitions on `audit_logs` (and `expense_requests` for huge tenants) |
| Process-level limits only | Per-`org_id` rate limits at gateway + PgBouncer pool caps (noisy-neighbour defence) |
| No replicas | Route list/dashboard reads to replicas; writes to primary |

> Cross-reference: the queue/outbox + multi-tenant sharding design lives in
> `level-2.1` §3–§4; this section only states what the **current code** already
> makes possible.

---

## 8. DB Planning

PostgreSQL is the **system of record**. Schema in `db/schema.sql`; migrations are
idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`) run by `db/migrate.ts`.

### 8.1 Tables (and why)
| Table | Purpose | Notable columns / constraints |
|---|---|---|
| `organizations` | tenant root | `base_currency` |
| `users` | members | `role CHECK(...)`, `manager_id` self-FK, **`UNIQUE(org_id,email)`**, `is_active` |
| `policies` | approval rules | `rules_json JSONB`, `tolerance_percent`, `active`, `version` |
| `expense_categories` | per-org categories | **`UNIQUE(org_id,name)`** |
| `budgets` | spend limits | `scope ∈ {user, org}`, `period ∈ {daily, monthly}` (CHECK) |
| `expense_requests` | the core entity | money as `NUMERIC(14,2)`, `base_amount`/`fx_rate`, `status CHECK(7 states)`, `policy_snapshot_json`, `current_level`, `sla_due_at` |
| `attachments` | bills | `s3_key`, `content_type`, `size`, `uploaded_by` |
| `approval_steps` | per-level steps | `level`, `required_role`, `approver_id`, `status CHECK(...)`, `sla_due_at` |
| `audit_logs` | immutable trail | `before_json`/`after_json`, `request_id` |
| `notifications` | in-app inbox | `payload_json`, `read` |
| `idempotency_keys` | retry-safety | **PK `(key, org_id, endpoint)`**, `response_json` |
| `refresh_tokens` | sessions | `token_hash` (SHA-256), `expires_at`, `revoked_at`, `replaced_by` |

### 8.2 Key & type decisions
- **UUID primary keys** everywhere — shard/merge-friendly, no cross-tenant id
  guessing, no hot sequence.
- **Money is `NUMERIC(14,2)`** (never float); FX kept as `base_amount` +
  `fx_rate(14,6)` so the converted value is frozen at submit time.
- **Enums as `VARCHAR + CHECK`** — portable and migration-light vs PG enums.
- **`JSONB`** for policy rules, policy snapshot, and notification payloads —
  flexible shape without schema churn; the **snapshot** means later policy edits
  don't rewrite history.
- **Composite uniqueness is org-scoped** (`(org_id,email)`, `(org_id,name)`) so
  two tenants can reuse the same email/category name.

### 8.3 Indexes (all org-leading → isolation + selectivity)
```
idx_expense_org_status        (org_id, status)              -- "my org's in_review"
idx_expense_org_requester     (org_id, requester_id)        -- "my expenses"
idx_expense_org_created       (org_id, created_at)          -- listings / spend-over-time
idx_step_org_approver_status  (org_id, approver_id, status) -- "my approval queue" (hot)
idx_audit_entity              (org_id, entity_type, entity_id) -- history lookups
idx_audit_created             (org_id, created_at)          -- audit volume
idx_notif_user               (org_id, user_id, read)        -- unread badge
idx_refresh_token_hash UNIQUE (token_hash)                  -- O(1) refresh lookup
idx_refresh_user              (user_id, revoked_at)         -- revoke-all-sessions
```

### 8.4 Transactions, locking & pooling
- **`withTransaction()`** wraps each state change; audit + business write commit
  together.
- **`SELECT … FOR UPDATE`** (`getByIdForUpdate`) is the concurrency primitive
  (§4).
- **`pg.Pool({ max: 10 })`** per process; parameterised queries everywhere (no
  string interpolation → no SQL injection).

### 8.5 Production DB roadmap
| Area | Plan |
|---|---|
| Connections | **PgBouncer** (transaction pooling) in front; per-tenant pool caps |
| Read scale | Read replicas; route list/analytics reads there |
| Growth | **Monthly partitioning** of `audit_logs` (+ `expense_requests` at scale); archive cold partitions to S3/Glacier |
| Isolation | **RLS** policies on `org_id` as a second wall behind app scoping |
| Sharding | Hash on `org_id` + routing catalog; enterprise tenants pinned |
| Integrity | Revoke `UPDATE/DELETE` on `audit_logs`; consider hash-chaining |
| HA/DR | Multi-AZ failover, PITR via WAL, cross-region replica (see §5) |

---

## 9. Redis Usage

### 9.1 Current state (honest)
Redis is **designed-in but not yet wired**. There is a `Cache` interface
(`cache/cache.ts`) with `get/set/del/flush`; the live implementation is
**`MemoryCache`** (per-process, TTL-based). `getCache()` is the single seam where
a `RedisCache` implementing the same interface drops in when
`config.useRedis` is true (set by `REDIS_URL`). `config.cacheTtlSeconds`
defaults to **15s**.

**What uses the cache today:** `analytics.summary(orgId)` only — key
`analytics:summary:<org_id>`, TTL 15s. Other reads hit Postgres directly.

> ⚠️ **Known limitation:** the analytics cache is **TTL-only** — it is *not*
> explicitly invalidated when an expense changes. Staleness is therefore bounded
> to ≤15s, which is acceptable for a dashboard but is called out so it isn't
> mistaken for write-through.

### 9.2 Why the interface is shaped this way
- `del(pattern)` supports **prefix invalidation** (`analytics:summary:42*`), so a
  write path can later evict exactly one tenant's view.
- Keys are **namespaced by `org_id`**, which both isolates tenants and makes
  per-tenant memory budgeting/eviction possible.
- Keeping the call sites behind `getCache()` means **zero code change** to adopt
  Redis — only `getCache()` wiring.

### 9.3 What Redis will hold in production
| Use | Key shape | TTL / policy | Why Redis |
|---|---|---|---|
| **Shared read cache** | `analytics:summary:<org>`, `pending:<org>:<user>`, `expense:<org>:<id>` | 15–60s, LRU | One cache shared across all pods (MemoryCache is per-pod) |
| **Cache invalidation** | pub/sub channel per `org` | — | Write paths publish → pods evict on change (write-through, not just TTL) |
| **Idempotency store** | `idem:<org>:<endpoint>:<key>` | 24h | Faster than a DB round-trip; auto-expiry; spillover to `idempotency_keys` for durability |
| **Per-tenant rate limits** | `rl:<org>` / `rl:<ip>` token bucket | sliding window | Noisy-neighbour defence at the edge (§7) |
| **Distributed lock (optional)** | `lock:expense:<id>` | short TTL | Only if a hot path ever needs cross-row coordination beyond `FOR UPDATE` |
| **Hot counters** | `notif:unread:<org>:<user>` | event-driven | Avoid a COUNT(*) on every poll |

### 9.4 Operational notes
- **Fail-open is mandatory:** a Redis outage must fall back to Postgres
  (correctness) and only cost latency — exactly how `MemoryCache` behaves today.
- **Eviction:** `maxmemory-policy allkeys-lru`, per-tenant key prefixes so one
  tenant can't evict everyone.
- **HA:** Redis Sentinel or managed (ElastiCache) with multi-AZ; cache is
  rebuildable, so RPO is not a concern.

---

## 10. Built-vs-Production matrix (the six NFRs)

| NFR | Built in the prototype | Production extension |
|---|---|---|
| **Security** | bcrypt; 1h JWT; **rotating, reuse-detecting, DB-backed refresh tokens**; deny-by-default RBAC; org-scoped queries (404 on cross-tenant); zod input; uniform errors | RS256/JWKS or Redis sessions; MFA/SSO; gateway rate-limit + WAF + helmet; Postgres RLS; Secrets Manager/KMS; AV scan on files |
| **Auditability** | append-only `audit_logs` written **in the same txn**; before/after + actor + reason + request_id; history API; flag-gated (mock) S3 ship | enforce append-only (grants) + hash chain; real batched S3 writer w/ retries+DLQ; monthly partitions; route-coverage CI test |
| **Consistency** | `withTransaction` + `SELECT … FOR UPDATE` serialization; idempotency table for approve/reject; in-txn budget check | Redis idempotency (TTL) + spillover; extend keys to all writes; co-locate expense+steps+audit per shard |
| **Availability** | stateless app; cache & audit-ship **fail open**; `/health`; bounded pool | multi-AZ PG + replicas; PgBouncer; circuit breakers; cross-region DR; formal SLOs |
| **Latency** | per-request p50/p95/p99 + Prometheus `/metrics`; org-scoped indexes; 15s analytics cache | Prom/Grafana histograms; Redis cache for all hot reads; k6 CI gate; rollups/OLAP |
| **Scalability** | stateless + `org_id` everywhere + composite indexes + cache/idempotency seams | tiered tenancy + hash sharding on `org_id` + partitioning + per-tenant limits + replicas + queue/outbox |

> **Design stance:** the prototype is the **happy path with the right seams**.
> Every production item above is an *operational* addition — none requires
> rewriting the core transaction, the `org_id` scoping, the audit-in-txn rule, or
> the cache interface.
