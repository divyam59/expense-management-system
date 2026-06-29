# EMS — Level 2.1: NFR Deep Dive

> **Purpose:** `level-2-design.md` summarises NFRs in a single table. This
> document expands them into a real engineering plan, with concrete numbers,
> failure modes, and the **two questions that drive every NFR decision** in a
> multi-tenant SaaS:
>
> 1. **Why do we need a queue?** The set of request *types* is small and known,
>    but the *volume* per type is unbounded and bursty. A synchronous,
>    DB-coupled call chain cannot absorb that. → §3.
> 2. **How do we scale across very different organisations?**
>    Org A = 100 users, Org B = 10,000 users on the same deployment.
>    A single sizing strategy will either over-pay for small tenants or melt
>    under large ones. → §4.
>
> Everything else (security, availability, consistency, perf, observability,
> compliance, DR) is laid out in §5 with **target → mechanism → prototype gap**
> so it's easy to see what's actually built vs. what's the production plan.

---

## Table of Contents
1. Workload Profile & Scaling Assumptions
2. NFR Inventory (one-line summary)
3. Why a Queue: Async Mechanism Deep Dive
4. Multi-Tenant Scaling: The 100-vs-10,000 Problem
5. NFR-by-NFR Deep Dive
   - 5.1 Security
   - 5.2 Auditability
   - 5.3 Scalability (compute, data, hot paths)
   - 5.4 Availability & Failure Handling
   - 5.5 Consistency Model
   - 5.6 Performance (latency / throughput SLOs)
   - 5.7 Idempotency
   - 5.8 Observability
   - 5.9 Compliance, Retention & Data Residency
   - 5.10 Disaster Recovery (RPO / RTO)
6. Capacity Planning — Back-of-Envelope
7. Tradeoffs & Decision Log
8. Prototype Gap Summary (what to demo vs what to document)

---

## 1. Workload Profile & Scaling Assumptions

### 1.1 What the workload actually looks like

EMS is **write-light, read-heavy, with bursty async fan-out**.

| Action | Frequency model | Type |
|---|---|---|
| Create / edit expense | per-user, monthly burst near month-end | Write |
| Approve / reject | per-approver, batched in sittings | Write |
| List "my expenses" / "pending approvals" | many per session | Read (hot) |
| Dashboard / analytics | per page load (admin/finance) | Read (heavy) |
| Notifications, OCR, S3 audit shipping, email/Slack | 1 write → N side-effects | **Async fan-out** |
| Audit log writes | 1 per state change (in-txn) | Write (small, append-only) |

Key property: the **request types are a small finite set** (CRUD + approve/reject
+ submit/withdraw + a few read endpoints). The **volume per type**, however, is
unbounded and seasonal (month-end, quarter-end, travel season).

### 1.2 Working capacity assumptions (for sizing)

These are *assumed* targets; production will be derived from real telemetry.

- **Tenants per deployment:** 10² – 10⁴ orgs.
- **Active users per tenant:** 10 – 10⁴ (two orders of magnitude spread → §4).
- **Expenses per active user per month:** ~10 (long tail to 100).
- **Read:write ratio:** ~10:1 (lists/dashboards dominate).
- **Burstiness:** ~30–40% of monthly writes land in the last 3 working days.
- **p99 API latency target:** 300 ms for synchronous user actions.

---

## 2. NFR Inventory (one-line summary)

| # | NFR | What it means here |
|---|---|---|
| N1 | Security | AuthN, AuthZ, tenant isolation, input safety, secrets, data protection |
| N2 | Auditability | Every state change is immutable, attributable, queryable |
| N3 | Scalability | Grow compute, DB, async work, and per-tenant load independently |
| N4 | Availability | Survive node/zone failures within an SLA |
| N5 | Consistency | Strong for money/approvals; eventual for reads/analytics |
| N6 | Performance | Latency + throughput SLOs per endpoint class |
| N7 | Idempotency | Retries never double-act on state/money |
| N8 | Observability | Business + system signals; can answer "why is it slow / wrong" |
| N9 | Compliance / Retention | Financial records retention, PII handling, residency |
| N10 | Disaster Recovery | RPO / RTO targets, backup strategy, runbook |

---

## 3. Why a Queue: Async Mechanism Deep Dive

### 3.1 The problem with doing everything synchronously

Every state change today triggers several *side effects*:

```
submit / approve / reject
        │
        ├─ persist expense + approval step + audit  (must be atomic)
        ├─ send notification (in-app, email, Slack)
        ├─ optional OCR scan of attachment
        ├─ ship audit row to S3 (long-term retention)
        ├─ refresh analytics rollups / cache
        └─ webhook to customer ERP (future)
```

If all of these run **inline** with the HTTP request:
- p99 latency = sum of slowest dependency (email/OCR can be seconds).
- Any side-effect failure (Slack 5xx, S3 throttle) fails the whole user action.
- Retries hit *all* steps including the DB write → must be made idempotent
  everywhere, which is expensive.
- A spike (month-end) saturates the API tier because every request is heavy.

### 3.2 Decision: split into **core transaction** + **async side-effects**

```
                    ┌─────────────────────────────────────┐
   HTTP request ──► │   App tier (stateless)              │
                    │   1. begin txn                      │
                    │   2. write expense + step + audit   │
                    │   3. write OutboxEvent (same txn)   │
                    │   4. commit  ← user sees 200 here   │
                    └──────────────┬──────────────────────┘
                                   │
                                   ▼
                         (outbox relay / CDC)
                                   │
                                   ▼
                ┌──────────────── Queue ────────────────┐
                │  Topics: notifications, ocr,          │
                │  audit-shipping, analytics, webhooks  │
                └─────────┬────────┬────────┬───────────┘
                          ▼        ▼        ▼
                       Worker   Worker   Worker
                       (notif)  (OCR)    (audit-S3)
                       └── retry + DLQ ───────┘
```

This is the **transactional outbox pattern**:
- Side-effects are recorded as rows in an `outbox_event` table **inside the
  same DB transaction** as the business write. The user response only depends
  on that local commit.
- A relay (CDC like Debezium, or a polling worker) drains `outbox_event` into
  a real broker (Kafka / SQS / NATS / RabbitMQ — choice in §3.5).
- Independent worker pools consume per topic, with per-topic retry policy and
  a Dead Letter Queue (DLQ) for poison messages.

### 3.3 Why outbox and not "just publish to the queue directly"

Publishing to the queue *and* writing to the DB are two separate systems
without a shared transaction. Three possible orderings, two are wrong:

| Order | Failure case | Result |
|---|---|---|
| Publish → DB write | DB write fails | Event sent for a non-existent change. **Wrong.** |
| DB write → Publish | Publish fails | DB has the change, no event ever sent. **Lost.** |
| DB write **+ outbox row (one txn)** → relay publishes | Relay can retry | Always consistent. ✅ |

The outbox pattern is the only one that gives "at-least-once delivery
guaranteed to match committed state", which is what `audit ≡ reality` (a
stated NFR) demands.

### 3.4 What goes async (and what does not)

| Side-effect | Sync or async? | Why |
|---|---|---|
| Approval step generation on submit | **Sync** (same txn) | The user must see "submitted, routed to X" |
| Audit log row | **Sync** (same txn) | Must never diverge from state |
| Notification (in-app row) | **Sync** (same txn, cheap) | So the recipient's `/notifications` is instant |
| Notification (email / Slack / push) | **Async** | Network-bound, can retry |
| OCR scan of bill | **Async** | Seconds, may fail, doesn't block submit |
| S3 audit shipping | **Async** | Best-effort retention, DB is SoR |
| Analytics rollup refresh | **Async** | Eventual; powers dashboards, not money |
| Webhook to customer ERP | **Async** | External, must retry, must be idempotent |

### 3.5 Broker choice (production)

| Option | Good for | Tradeoff |
|---|---|---|
| **Postgres outbox + worker poll** | Prototype, ≤ ~50 events/s/tenant | No new infra; not great at high fan-out |
| **AWS SQS** (one queue per topic) | Simple managed, per-message retry/DLQ built-in | No ordering across messages, ~250k msg/s/queue |
| **Kafka** | High throughput, replay, ordered per partition, multi-consumer | Operational complexity; needs schemas |
| **NATS JetStream / RabbitMQ** | Lower-ops middle ground | Smaller ecosystem |

**Recommended path:** start on Postgres-outbox + a worker (covers prototype +
small production). Migrate the relay output to **SQS per topic** when fan-out
crosses ~1k events/s aggregate. Move to **Kafka** if/when we need replay,
multi-consumer (analytics + audit + SIEM reading the same stream), or strict
per-key ordering at scale.

### 3.6 Queue NFR contract (per topic)

| Topic | Order | Retries | DLQ after | Max age | Idempotency strategy |
|---|---|---|---|---|---|
| `notifications.email` | best-effort | exponential, 6 | 6 attempts | 24h | dedupe key = `event_id` |
| `notifications.in_app` | sync (no queue) | — | — | — | row PK |
| `ocr.bill` | per-attachment | exponential, 4 | 4 attempts | 12h | `attachment_id` |
| `audit.s3_shipping` | best-effort | exponential, ∞ (slow) | never (alert) | ∞ | content hash |
| `analytics.rollup` | per-org | exponential, 5 | 5 attempts | 6h | `(org_id, window)` |
| `webhooks.outbound` | per-subscription | exponential, 10 | 10 attempts | 7d | `event_id` |

### 3.7 Backpressure & isolation

- **Per-tenant rate limit at the queue producer** (token bucket keyed on
  `org_id`) to prevent a single noisy tenant from starving others — see §4.5.
- **Per-topic consumer concurrency caps** so OCR (CPU-heavy) doesn't starve
  notifications (I/O-heavy).
- **Bulkheads:** separate worker deployments per topic class so a wedged OCR
  pod can't take down the notification path.

### 3.8 Prototype vs production

| | Prototype (built) | Production (designed) |
|---|---|---|
| Inline writes | Same as production | Same |
| Outbox table | ✅ (`outbox_event`) | ✅ |
| Relay | In-process worker, 1s poll | Debezium/CDC OR dedicated relay svc |
| Broker | None (relay writes side-effects directly) | SQS per topic → Kafka later |
| Workers | Same process | Separate deployments per topic |
| DLQ | DB table `outbox_dlq` | Broker-native DLQ + alert |

---

## 4. Multi-Tenant Scaling: The 100-vs-10,000 Problem

### 4.1 Why one strategy doesn't fit all tenants

Cost and load do not scale linearly with user count — they scale with:
- **Active users** (DAU/MAU), not licensed seats.
- **Approvals chain depth** (policy-driven; bigger orgs have deeper chains).
- **Dashboard fan-out** (admins of large orgs hit `/analytics/*` harder).
- **Attachment volume** (S3 bandwidth, OCR queue depth).
- **Concurrent month-end load** (writes spike for everyone in the same week).

Two orgs of size 100 and 10,000:

| Dimension | Org-100 | Org-10,000 |
|---|---|---|
| Expenses / month (~10/user) | ~1,000 | ~100,000 |
| Peak writes/s (40% in last 3 days × 8h) | <1 | ~12 |
| Pending approvals queue size | tens | thousands |
| Dashboard query cost (rows scanned) | KB | MB–GB |
| Cache footprint | trivial | non-trivial |
| Blast radius if migrations break | small | catastrophic |

→ A pooled deployment that's "fine" for 1,000 small orgs may be wrecked by a
single large one. **Noisy-neighbour** is the central risk.

### 4.2 Tenancy isolation models (pick per tier)

| Model | Description | Isolation | Cost | Operational complexity |
|---|---|---|---|---|
| **Pooled (shared everything)** | All tenants in one DB, scoped by `org_id` | Logical only | Lowest | Low |
| **Silo'd schema** | One DB schema per tenant in shared cluster | Logical + per-schema RLS | Low–Med | Med |
| **Silo'd DB** | One database per tenant (shared cluster or not) | Strong | Med–High | Med–High |
| **Dedicated stack** | Per-tenant app + DB + cache | Strongest | Highest | High |

**Strategy: tiered tenancy.**

| Tier | Org size | Model | Justification |
|---|---|---|---|
| **Starter** | < 200 active users | Pooled | Cheapest; loss = bounded |
| **Growth** | 200 – 2,000 | Pooled + per-tenant rate limits + cache namespacing | Still cheap; protect from each other |
| **Enterprise** | > 2,000 | Silo'd DB (shared cluster) or dedicated shard | Performance isolation, custom SLA, DR knobs |
| **Regulated / Sovereign** | Special | Dedicated stack, in-region | Compliance / residency |

A single tenant can be **promoted** between tiers as it grows; data move is a
controlled migration (DMS / logical replication), not an emergency.

### 4.3 Sharding strategy (when pooled isn't enough)

- **Shard key: `org_id`.** Every business query already filters by it (see
  level-2 §5 indexes), so range-routing is natural.
- **Strategy:** consistent hashing of `org_id` to N shards, with a **tenant→shard
  routing table** (a "catalog" DB) so individual tenants can be moved between
  shards for rebalancing.
- **Enterprise tenants are pinned to their own shard** (or own DB) so their
  workload does not affect anyone else. This is the answer to
  "Org A has 100, Org B has 10,000" — Org B gets its own shard, Org A shares
  one with hundreds of peers.
- **Cross-shard queries** are avoided at the application layer because nothing
  needs to join across orgs. (Global admin/finance reporting, if required,
  runs against the analytics warehouse, not OLTP.)

### 4.4 Table partitioning (within a shard)

- **`audit_log` partitioned by month** (`created_at`). Old partitions can be
  detached and archived to S3 — keeps the hot index small.
- **`expense_request` partitioned by month** for the same reason at very large
  tenants.
- **`approval_step` not partitioned** (small, hot, indexed on
  `(org_id, approver_id, status)`).

### 4.5 Per-tenant fairness ("noisy neighbour" defence)

Hard guardrails so a single org cannot consume more than its share:

| Resource | Guardrail | Where enforced |
|---|---|---|
| API requests/sec | Per-`org_id` token bucket (e.g. 200 rps starter, 2,000 rps enterprise) | API gateway |
| Concurrent DB connections | Per-tenant pool cap via PgBouncer pool per tenant key | PgBouncer / app pool |
| Queue throughput | Per-`org_id` token bucket at producer; per-topic consumer concurrency | Async layer (§3.7) |
| Cache memory | Per-tenant key namespace; LRU within budget | Redis (logical) |
| Attachment storage | Per-org quota (GB) | S3 + app-level check |
| Dashboard heavy queries | Per-tenant query concurrency limit + 5s statement timeout | DB / app |

### 4.6 Read scaling for large tenants

For a 10,000-user tenant, the read endpoints — pending approvals, "my team",
dashboards — are the failure mode, not writes.

- **Read replicas** per shard. List endpoints route to replica; money/approval
  actions to primary.
- **Materialised views / rollup tables** for analytics (refreshed by the
  `analytics.rollup` worker, §3.6). The `/analytics/*` endpoints read from
  rollups, not from raw `expense_request`.
- **Cache layer with explicit invalidation** on writes (already in scope).
  Cache keys include `org_id` and the *user view* (e.g. `pending:org:42:user:7`).
- For the dashboard, a separate **OLAP store** (ClickHouse / Redshift / Druid)
  fed by CDC is the right tool once a tenant produces > ~1M expenses/year.

### 4.7 Onboarding / churn scaling

- New tenant = a row in the catalog + a schema/DB if silo'd. Bootstrapping
  default policies, roles, budgets is a one-shot script.
- Tenant deletion is **soft + scheduled hard purge** (compliance §5.9).

### 4.8 Prototype vs production

| | Prototype | Production |
|---|---|---|
| Tenancy | Pooled, `org_id` scoping | Tiered (Starter/Growth/Enterprise/Regulated) |
| Sharding | None | Hash on `org_id`, catalog routing, Enterprise pinned |
| Partitioning | None | Audit + expense by month |
| Per-tenant limits | Process-level only | Gateway + PgBouncer + queue + cache |
| Read scaling | Cache + indexes | Replicas + rollups + OLAP for big tenants |

---

## 5. NFR-by-NFR Deep Dive

### 5.1 Security

**Threat model (abridged):** account takeover, IDOR / cross-tenant data leak,
privilege escalation, replay/double-spend, supply-chain, insider exfiltration.

| Control | Built (prototype) | Production |
|---|---|---|
| AuthN | JWT (short-lived) + refresh; argon2 password hash | SSO (SAML/OIDC), MFA, device trust |
| AuthZ | RBAC middleware; ownership/hierarchy checks; deny-by-default | ABAC via OPA/Cedar; per-field policies |
| Tenant isolation | `org_id` enforced in every repo query | DB row-level security (RLS) + per-tenant keys |
| Input | zod DTOs, strip unknown fields | Schema registry, fuzzing in CI |
| Idempotency | `Idempotency-Key` header (state actions) | Redis dedup store with TTL |
| Files | Private S3, time-limited presigned URLs only | + AV scan, object-lock, signed downloads |
| Secrets | env config | AWS Secrets Manager + KMS, rotation, no secrets in CI logs |
| Transport | TLS at edge (assumed) | TLS everywhere, mTLS service-to-service |
| Logging | No tokens/PII in logs (redactor) | + DLP scanning of log sinks |
| Audit of sensitive actions | All money/state changes audited | + alert on admin actions, anomaly detection |
| Abuse | — | Gateway rate-limit per IP + per `org_id`, WAF |

**Cross-tenant IDOR test (always-on):** every list/get endpoint has an
integration test that, given a token for Org A, hitting any Org B resource
returns 404, not 403 (avoid existence oracle).

### 5.2 Auditability

Already deep in level-2 §12. The NFR contract:

- **Completeness:** every state-changing API path routes through
  `AuditService.record()`; enforced by a test that diffs the route list
  against audit-emitting routes.
- **Integrity:** append-only; no `UPDATE`/`DELETE` grants on the table in
  production DB role. Production extension: hash chain (`prev_hash`) per
  `(org_id)` for tamper evidence.
- **Latency to durable storage:** in-txn, so 0ms after commit. S3 shipping is
  best-effort; SLO = "shipped within 15 min" measured by lag metric.
- **Queryability:** `/expenses/{id}/history` ≤ 200ms p99; index
  `(org_id, entity_type, entity_id)`.
- **Retention:** see §5.9 (7 years for financial records).

### 5.3 Scalability — three independent axes

Treat scalability as three separate problems with three separate levers:

1. **Compute (app tier)** — stateless, horizontal. Lever: pod count + HPA on
   CPU/RPS. Bottleneck = DB connections (mitigated by PgBouncer).
2. **Data (Postgres)** — vertical first, then read replicas, then shard by
   `org_id` (§4.3). Bottleneck = write IOPS on hot tables.
3. **Async work (queue + workers)** — horizontal, per-topic. Lever: worker
   replicas + per-topic concurrency. Bottleneck = downstream APIs
   (email provider, OCR service) → mitigated by per-tenant rate limits.

What we are **explicitly not** trying to scale: an in-memory store or session
affinity. Both are absent by design.

### 5.4 Availability & Failure Handling

**Target SLOs (production):**
- Core write APIs: 99.9% monthly (≈ 43 min downtime).
- Read APIs: 99.95%.
- Async pipelines: 99.5% (queue + workers; backlog is acceptable, loss is not).

| Failure | Detection | Containment | Recovery |
|---|---|---|---|
| App pod crash | Health probe | LB removes pod | New pod via orchestrator |
| DB primary loss | Replica lag + heartbeat | Block writes | Multi-AZ auto-failover (RPO ≈ 0, RTO < 60s) |
| Redis loss | Connection error | Bypass cache (read from DB) | Restart / fail over; cache rebuilds |
| S3 throttle | 5xx + slow uploads | Retry with backoff | Async pipelines absorb |
| Queue broker loss | Heartbeat | Producers buffer to outbox (DB) | Drain when broker returns |
| Worker stuck on poison msg | Retry count → DLQ | DLQ + alert | Manual replay after fix |
| Region outage | External monitor | Geo-route to standby | Active-passive failover (RPO = replication lag, RTO < 30 min) |

**Principles:**
- DB is the only thing that *must* be up for writes; everything else fails
  open or buffers.
- Async pipelines must **never** lose data; they may be late.
- Circuit breakers around every outbound dependency (email, OCR, payment).

### 5.5 Consistency Model — written down explicitly

| Operation class | Consistency | Why |
|---|---|---|
| Expense create / approve / reject / withdraw | **Strong** (single-row + multi-row DB txn) | Money correctness, audit ≡ reality |
| Approval step transitions | **Strong** + optimistic locking on `(step_id, version)` | Prevent concurrent approve+reject |
| Budget check at submit | **Strong** read-modify-write in same txn | Avoid double-spend past budget |
| Lists ("my expenses", "pending") | **Read-your-writes** within session; eventually consistent across replicas | Cache + replica acceptable |
| Dashboards / analytics | **Eventual** (rollups refreshed async) | Cost; freshness ≤ 5 min is fine |
| Notifications | **At-least-once delivery** | Outbox guarantees |
| S3 audit shipping | **Eventual** (DB is SoR) | Best-effort retention |

Concurrent approve/reject collision: the second action sees the step is no
longer `pending` → returns the existing decision (idempotent), not an error.

### 5.6 Performance — explicit SLOs

| Endpoint class | p50 | p95 | p99 | Notes |
|---|---|---|---|---|
| Auth (`/auth/*`) | 50ms | 150ms | 300ms | argon2 dominates |
| Write (submit/approve/reject) | 80ms | 200ms | 400ms | DB txn + outbox |
| Read by id | 30ms | 80ms | 150ms | Cache hit path |
| List (paginated) | 60ms | 200ms | 350ms | Index-driven |
| Analytics / dashboard | 200ms | 500ms | 900ms | Reads rollups |
| `/metrics` | <50ms | <100ms | <100ms | In-process |

Error budget: **p99 > target for > 5 min** triggers an SLO-breach alert.

**Test gates (production):** k6/Locust scenarios per endpoint class run in CI
against a staging shape; merge blocked if p99 regresses by > 20%.

### 5.7 Idempotency

| Operation | Key | Window |
|---|---|---|
| `POST /expenses` (create) | `Idempotency-Key` header → 24h | Returns same `expense_id` on replay |
| `submit / approve / reject / withdraw` | `Idempotency-Key` + step-state check | Replaying a decided step is a no-op |
| `POST /attachments/presign` | None (safe to repeat) | — |
| Outbox consumers | Per-event `event_id` deduped at consumer | At-least-once → effective once |

Storage: prototype uses an `idempotency_key` table in Postgres; production
moves to Redis with TTL + spillover to DB.

### 5.8 Observability

Three pillars + the business lens:

| Pillar | Built | Production |
|---|---|---|
| Metrics | `/metrics` (Prometheus text), in-app counters | Prometheus + Grafana, RED + USE dashboards per service |
| Logs | Structured JSON to stdout, correlation `request_id` | Loki/ELK, sampling, PII redaction |
| Traces | — | OpenTelemetry, sampled traces incl. DB + queue spans |
| Business | Built-in dashboard (spend, status mix, SLA breaches, audit volume) | Same, on Grafana, with alerting |

**Golden signals tracked:** request rate, error rate, p95 latency, queue lag,
DLQ depth, replication lag, cache hit ratio.

**SLO alerts** (multi-window burn-rate) rather than threshold alerts.

### 5.9 Compliance, Retention & Data Residency

| Concern | Plan |
|---|---|
| Financial record retention | **7 years** for `expense_request`, `audit_log`, attachments. Hot in Postgres → cold in S3 Glacier after 13 months. |
| PII | Email, name only. Hashed/encrypted at rest in prod; redacted in logs. |
| GDPR-style right-to-erasure | Soft-anonymise user (`User.is_active=false`, PII nulled) but keep audit and expense rows for legal retention. Documented divergence between "delete user" and "delete data". |
| Data residency | Region pinning per tenant via the catalog. EU tenants land on EU shards; US on US. |
| Access control | Admin actions audited; quarterly access review. |
| Backups | Daily encrypted snapshots, monthly cold copies, restore-test quarterly. |
| Vendor / sub-processor list | Maintained for SOC2 / GDPR. |

### 5.10 Disaster Recovery (RPO / RTO)

| Scenario | RPO target | RTO target | Mechanism |
|---|---|---|---|
| Single AZ outage | 0 | < 5 min | Multi-AZ Postgres failover |
| Region outage | < 5 min (replication lag) | < 30 min | Cross-region async replica + DNS failover |
| Accidental data loss (bad migration) | < 24h (last snapshot) | < 4h | Point-in-time recovery (WAL) |
| S3 bucket loss | 0 | < 1h | Versioning + cross-region replication |

**Runbook discipline:** every DR scenario above has a runbook; each is
**rehearsed quarterly** in staging (game day). Untested DR = no DR.

---

## 6. Capacity Planning — Back-of-Envelope

Assume **1,000 tenants** mixed (900 starter, 90 growth, 10 enterprise).

| Quantity | Estimate | Notes |
|---|---|---|
| Total active users | ~250k | Heavy tail in enterprise tenants |
| Expenses/month | ~2.5M | 10/user/month |
| Writes/s steady | ~1 | 2.5M / 30 / 86400 |
| Writes/s month-end peak | ~30–40 | 40% of month into last 3 working days |
| Reads/s peak | ~400 | 10:1 ratio + dashboard fan-out |
| Audit rows/month | ~10M | ~4 transitions/expense |
| Outbox events/month | ~10M | ≈ writes × 4 side-effects average |
| Attachments/month | ~2M | ~80% of expenses have a bill |
| Attachment storage/month | ~600 GB | ~300KB avg |

Sizing implication:
- **App tier:** 4–8 vCPU pods × 6 replicas comfortably handles 400 rps with
  headroom. HPA target 60% CPU.
- **Postgres:** medium instance with replicas; the audit + outbox tables drive
  the IOPS budget — partition by month.
- **Queue:** ~4 events/s steady, ~150/s peak — comfortable for SQS.
- **Workers:** 2 per topic baseline, autoscale on queue depth.

One enterprise tenant alone hitting 100k expenses/month is ~70% of this whole
deployment's write load → **it gets its own shard** (§4.3).

---

## 7. Tradeoffs & Decision Log

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Sync vs async side-effects | Async via outbox | Inline | Latency + isolation; never lose events |
| Broker | Postgres outbox → SQS → Kafka (staged) | Kafka day 1 | Ops cost; defer until justified |
| Tenancy | Tiered (pooled → silo → dedicated) | One-size pooled | Noisy neighbours; enterprise SLAs |
| Sharding key | `org_id` | `user_id` / random | Every query already org-scoped; pinnability |
| Read scaling | Cache + replicas + rollups (+ OLAP for big tenants) | Single DB forever | Dashboards dominate at scale |
| Consistency split | Strong writes / eventual reads | Strong everywhere | Read-heavy load cannot pay strong cost |
| Idempotency | Header + dedup store + state check | Hope of no retries | Networks retry; double-spend is unacceptable |
| Audit storage | In-txn Postgres + async S3 | Async-only | "Audit ≡ reality" NFR |
| Compliance retention | 7y hot+cold tiering | Forever in Postgres | Cost; query patterns favour cold |

---

## 8. Prototype Gap Summary

What is **demonstrated in the prototype** vs **documented for production**:

| Topic | Prototype | Production |
|---|---|---|
| Outbox pattern | ✅ table + in-process relay + 1 worker | Real broker (SQS/Kafka), per-topic workers, DLQ |
| Per-tenant rate limit | Single global limit | Gateway token bucket per `org_id` |
| Sharding | None | Hash on `org_id` + catalog + enterprise pinning |
| Partitioning | None | Monthly partitions on audit + expense |
| Replicas | None | Read replicas + replica routing |
| OLAP | None | ClickHouse/Redshift for big-tenant analytics |
| Multi-AZ HA | Single managed Postgres | Multi-AZ + auto-failover |
| DR | Daily snapshot | Multi-region replica, runbook, game days |
| Compliance retention | Audit in DB + optional S3 ship | 7y hot/cold + Glacier + erasure handler |
| Observability | `/metrics` + built-in dashboard | Prom/Grafana, OTel traces, Loki logs, SLO alerts |

> The prototype is the **happy path with the right seams**: outbox, `org_id`
> everywhere, idempotency keys, audit-in-txn, cache namespacing. None of the
> production extensions require a rewrite — only operational investment.
