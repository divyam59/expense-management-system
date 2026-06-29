# EMS — Level 2.4: DB Scaling Mental Model

> **Why this doc exists.** "We'll have thousands of companies and billions of
> users, reads ≫ writes, each tenant needs only *its own* data — how do we store
> and scale that? One DB hits a vertical ceiling… so a DB per tenant? how do you
> even manage a cluster of thousands of DBs? and how does Redis help per-tenant?"
>
> This is a **mental-model** doc. It doesn't just list techniques — it teaches
> the *order* you reach for them, **the exact wall each one solves, and the new
> wall it creates.** Read it top to bottom once; after that the cheat-sheet in
> §9 is all you'll need.

---

## 0. The one insight that makes this easy

You do **not** have "billions of users." You have:

```
thousands of TENANTS  →  each owns its users + expenses + policies + audit
                         (a self-contained island; nothing joins across islands)
```

In EMS, **every** business row carries `org_id`, and **no OLTP query ever needs
two tenants at once**. That means the data is **embarrassingly partitionable**:
you can cut it into independent pieces along `org_id` and put those pieces on
different machines, and *no feature breaks*.

> 🧠 **Mental model #1:** Scaling a multi-tenant DB is mostly the art of
> **slicing along the tenant boundary** and **routing** each request to the right
> slice. Everything below is a variation on that.

The second thing to internalise: **"scale the database" is not one problem.**
It's four independent resources that run out at different times:

| Resource | "Runs out" when… | Symptom |
|---|---|---|
| **Storage** | total bytes > biggest disk | can't grow the table |
| **Write throughput** | writes/s > one primary's IOPS | write latency climbs |
| **Read throughput** | reads/s > one box's CPU | read latency climbs |
| **Connections** | clients > ~a few hundred | "too many connections", memory blows |
| **Working set** | hot data > RAM | cache-miss storms, disk thrash |

Different techniques fix different columns. Picking the wrong technique = no
help. Keep this table in your head.

---

## 1. The scaling ladder (climb only when you hit a wall)

Don't "design for a billion users" on day one — you'll build a cathedral nobody
needs. Climb **one rung at a time**, each rung triggered by a *specific* wall.

```
 Rung 6  Archive cold data + OLAP for analytics      ── storage + analytics scans
 Rung 5  Partition big tables by time (within a shard) ── one table too big
 Rung 4  SHARD by org_id (the big one)               ── write/storage ceiling
 Rung 3  Split by service / bounded context          ── one schema does too much
 Rung 2  Cache hot reads in Redis                     ── read CPU, repeated reads
 Rung 1  Read replicas                                ── read throughput (reads≫writes)
 Rung 0  One DB, scale it UP (vertical)               ── you're just starting
         ───────────────────────────────────────────
         each rung: solves a wall ▲   creates a new wall ▼
```

> 🧠 **Mental model #2:** There is no "final" architecture — only "the rung that
> matches today's wall." A healthy system is usually sitting on rungs 1–2 with
> the *seams* for 4 already in place (EMS has them: `org_id` everywhere).

Let's walk each rung: what it fixes, and what it then breaks.

### Rung 0 — One DB, vertical scaling ("just buy a bigger box")
- **Fixes:** everything, for a while. Simplest possible thing.
- **Wall it hits:** there's a *biggest instance money can buy*; past that you
  can't scale up. Also: one box = one failure domain, and **writes** all funnel
  through one primary. Cost grows non-linearly at the top end.
- **For EMS:** good to surprisingly far, because writes are light.

### Rung 1 — Read replicas (your reads ≫ writes → this is your first real move)
- **What:** the primary streams its changes to N read-only copies. Send
  list/dashboard/lookup queries to replicas; send writes (approve, submit) to the
  primary.
- **Fixes:** **read throughput** — exactly your situation. Add replicas → add
  read capacity, almost linearly.
- **New wall:** **replication lag.** A replica is milliseconds-to-seconds behind.
  "I approved an expense, refreshed, and it still shows pending" = you read a
  stale replica (**read-your-writes** broken).
  - *Fix:* route the **critical/just-wrote** read to the primary (or "sticky to
    primary for N seconds after a write"); let everything else use replicas.
- **Doesn't help:** storage or write throughput — every replica holds the *full*
  copy and every write still hits one primary.

### Rung 2 — Cache hot reads in Redis (because your data is mostly static)
- **What:** put a fast key-value layer in front of the DB for data that's read a
  lot and changes rarely (policies, categories, budgets, role maps).
- **Fixes:** read CPU + latency; absorbs repeated identical reads so the DB only
  serves cache misses.
- **New wall:** **cache invalidation** (the famously hard problem) and **cold
  cache** (after a restart, everything misses at once → "stampede"). Full Redis
  treatment in §6.
- **Doesn't help:** writes or storage.

### Rung 3 — Split by service / bounded context (vertical partitioning)
- **What:** stop putting everything in one schema. Give each bounded context its
  own DB: `auth`, `expenses`, `audit`, `analytics`. (Audit and analytics are the
  loudest, fastest-growing tables — isolating them protects the OLTP path.)
- **Fixes:** one schema/instance no longer carries unrelated load; each piece
  scales on its own; blast radius shrinks.
- **New wall:** **no more cross-table JOINs** between split DBs → you join in the
  app or denormalise, and a write that spans two DBs needs the **outbox pattern**
  (see `level-2.1` §3), not a distributed transaction.
- **Note:** this splits by *kind of data*, not by *tenant*. It buys time but every
  tenant still shares each service DB. The real ceiling-breaker is next.

### Rung 4 — **Shard by `org_id`** (horizontal partitioning — the big one)
This is the answer to "one DB can't hold it all." Covered in depth in §2.

### Rung 5 — Partition a big table by time (within a shard)
- Even inside one shard, `audit_logs` and `expense_requests` grow **forever**.
  A single 2-billion-row table = slow indexes, slow vacuum, scary migrations.
- **What:** range-partition by month on `created_at`. Postgres treats each month
  as a child table; queries touch only relevant months; old months can be
  **detached and archived** cheaply.
- **Fixes:** keeps the *hot* index small even as total rows explode; makes
  deletion/archival a metadata operation (drop a partition) instead of a
  multi-hour `DELETE`.

### Rung 6 — Archive cold data + a separate analytics store
- **Cold tiering:** financial/audit rows must live ~7 years but are rarely read
  after a few months → move old partitions to **S3/Glacier**; keep Postgres hot
  and small.
- **Analytics off OLTP:** dashboards that scan millions of rows do **not** belong
  on the transactional DB. Stream changes (CDC) into an OLAP store
  (ClickHouse/Redshift/BigQuery) and point `/analytics/*` there. OLTP stays fast.

---

## 2. Sharding deep dive (your main question)

"One DB hits a vertical limit. So… a DB per tenant?" Almost — but not *literally*
one DB per tenant. Let's build it up.

### 2.1 The isolation spectrum (4 models, cheapest → strongest)

```
 Cheapest / weakest isolation ───────────────────► Most expensive / strongest
 ┌───────────────────┬────────────────────┬───────────────────┬──────────────────┐
 │ A) Shared DB,     │ B) Shared DB,      │ C) DB per tenant  │ D) Cluster/stack │
 │    shared schema  │    schema/tenant   │                   │    per tenant     │
 │  (org_id column)  │                    │                   │                   │
 ├───────────────────┼────────────────────┼───────────────────┼──────────────────┤
 │ row-level         │ schema-level       │ database-level    │ everything-level  │
 │ 1 DB = ∞ tenants  │ 1 DB = 100s        │ 1 DB = 1 tenant   │ 1 stack = 1 tenant│
 │ cheapest          │ cheap-ish          │ pricey at scale   │ priciest          │
 │ noisy-neighbour   │ some isolation     │ strong isolation  │ total isolation   │
 │ EMS today ✅      │                    │ enterprise tier   │ regulated/sovereign│
 └───────────────────┴────────────────────┴───────────────────┴──────────────────┘
```

**The trap:** thinking you must pick ONE. You don't.

### 2.2 The realization: shard = a *bucket of tenants*, not one tenant

A "shard" is just one DB (or DB cluster) that holds **many** tenants. You group
tenants into shards:

```
                 ┌─────────── routing catalog ───────────┐
   org_id ──────►│  org → shard mapping (a tiny lookup)   │
                 └───┬───────────┬───────────┬────────────┘
                     ▼           ▼           ▼
                 ┌────────┐  ┌────────┐  ┌──────────────────┐
                 │ Shard1 │  │ Shard2 │  │ Shard 3 (whale)  │
                 │ 800    │  │ 800    │  │ 1 huge tenant    │
                 │ small  │  │ small  │  │ all to itself    │
                 │ tenants│  │ tenants│  │                  │
                 └────────┘  └────────┘  └──────────────────┘
```

- **Small tenants** (the thousands) share a shard with hundreds of peers (model A
  inside that shard). Cheap.
- A **whale tenant** (the one with 100M expenses) gets **pinned to its own shard**
  — effectively model C, *only for the tenants that need it.* This is the precise
  answer to "Org A has 100 users, Org B has 10,000": they don't live together.

> 🧠 **Mental model #3:** Sharding = **(a) a shard key** (`org_id`) + **(b) a
> routing catalog** (org → shard) + **(c) a placement policy** (small tenants
> pool, big tenants isolate). That's the entire idea.

### 2.3 How you choose the shard

| Strategy | How org→shard is decided | Pro | Con |
|---|---|---|---|
| **Range** | org_ids A–M → shard1, N–Z → shard2 | simple | hotspots if growth is uneven |
| **Hash** | `hash(org_id) % N` | even spread | **resharding** when N changes is painful |
| **Directory / catalog** | a lookup table says exactly where each org lives | **move any tenant anytime**, pin whales | the catalog is one more thing to run (cache it!) |

**Use the directory/catalog approach.** It costs one tiny extra lookup (cached in
Redis) but buys you the superpower of **moving individual tenants between shards**
— for rebalancing, or to promote a growing tenant to its own shard — without a
global re-hash.

### 2.4 Why `org_id` is the right shard key (and not user_id)
- Every EMS query already filters by `org_id` → routing is free, no query rewrite.
- An expense + its approval steps + its audit rows **all share the same `org_id`**
  → they land on the **same shard** → a state change stays a **single-node
  transaction** (your `FOR UPDATE` + in-txn audit keeps working unchanged).
- Sharding by `user_id` would scatter one tenant's data across shards and turn
  every "my team's expenses" into a cross-shard query. Don't.

> 🧠 **Mental model #4 (the golden rule):** **Co-locate everything that must be
> read/written together in one transaction onto the same shard.** Pick the shard
> key that makes that true. For EMS that's `org_id`.

---

## 3. "How do I manage a cluster of thousands of DBs?"

This is the real operational fear, and it's legitimate. You don't manage them by
hand — you make the *fleet* uniform and automate the five things that change:

| Concern | How it's handled |
|---|---|
| **Where does tenant X live?** | The **routing catalog** (a small, highly-available, heavily-cached directory DB). Every request: `org_id → catalog → connection string`. |
| **Connections** (N shards × M pods = explosion) | **PgBouncer** in front of every shard (transaction pooling). Pods talk to PgBouncer, not Postgres directly. This is what stops "too many connections" from killing you. |
| **Schema migrations across all shards** | A **migration runner** fans the same migration out to every shard, tracked per-shard. Use the **expand/contract** pattern (add nullable column → backfill → switch reads → drop old) so migrations are online and reversible. Never a flag-day `ALTER` on a 2B-row table. |
| **Rebalancing / moving a tenant** | **Logical replication**: stream tenant X's data to the new shard live, then a short cutover flips the catalog entry. No downtime, no global reshard. |
| **Backups / DR / monitoring** | Per-shard, but driven by **one config and dashboards templated per shard** (the fleet is uniform). Each shard: snapshots + PITR; metrics tagged with `shard_id`. |
| **Provisioning a new shard** | Infrastructure-as-code (Terraform) → spin shard → register in catalog → new tenants start landing there. |

> 🧠 **Mental model #5:** You don't operate "thousands of DBs"; you operate **one
> *fleet* of identical shards + one catalog + automation for migrate/rebalance/
> provision.** The count stops mattering once those are templated.

**A note on tenant DB vs shard of tenants:** pure "one DB per tenant" only makes
sense for a small number of **big/regulated** tenants. For thousands of small
ones it's wasteful (each Postgres has fixed overhead: RAM, connections, a
WAL, backups). So: **pool the many, isolate the few.** That's the whole strategy.

---

## 4. Reads: putting it together (your read-heavy reality)

Reads scale on a different ladder than writes. For a read-heavy, mostly-static
workload like EMS, in priority order:

```
1. Index it           → org-scoped composite indexes (already in EMS)
2. Cache it (Redis)    → policies/categories/budgets/role-maps (static, hot)
3. Replica it          → spread list/dashboard reads across read replicas
4. Pre-compute it      → rollup tables / materialised views for analytics
5. Offload it          → OLAP store (ClickHouse/Redshift) for heavy scans
```

The reason this order: each step is cheaper and less invasive than the next.
Most read pain dies at steps 1–2. You only reach 4–5 for the biggest tenants'
dashboards.

---

## 5. Where it breaks, and the fix ("kahaan fasega")

The bottleneck cheat-table. This is the part to re-read when something is on fire.

| Bottleneck (the wall) | Why it happens | The fix |
|---|---|---|
| **Connection exhaustion** | N shards × M app pods each open pools | **PgBouncer** transaction pooling in front of every shard |
| **Hot shard / noisy neighbour** | one tenant outgrows its shard-mates | move/pin that tenant to its own shard via the catalog + logical replication |
| **Replication lag breaks read-your-writes** | replica is behind primary | route just-wrote / critical reads to primary; replicas for the rest |
| **Cross-shard query** (e.g. global admin report) | someone needs all tenants at once | **don't** do it on OLTP — feed an **OLAP/warehouse** via CDC; OLTP stays single-shard |
| **Schema migration on huge/ many tables** | a blocking `ALTER` locks a giant table | **expand/contract** online migrations; per-shard fan-out runner |
| **One table grows forever** (`audit`, `expense`) | unbounded inserts | **time-partition** + detach/archive old partitions to S3 |
| **Distributed transaction** across shards | a write spans two tenants/services | avoid by design (co-locate via `org_id`); for cross-service effects use the **outbox** |
| **Resharding when hash N changes** | hash-based placement | use the **directory/catalog** so you move tenants, not rehash everyone |
| **Cache stampede** | hot key expires, 10k requests miss at once | per-key lock / request-coalescing / staggered TTLs (see §6) |
| **Analytics melts OLTP** | dashboard scans millions of rows on primary | rollups + OLAP off the transactional path |

---

## 6. Redis, tenant/user-wise (your specific Redis question)

"Data is mostly static, reads are many — how do I use Redis per tenant/user?"
This is the *ideal* Redis case. The mechanics:

### 6.1 What to cache (and what not to)
| Cache it (static-ish, hot) | Don't cache (or short TTL) |
|---|---|
| Active **policy** per org | money-critical live state mid-transaction |
| **Categories**, **budgets** per org | anything you must read strongly-consistent in a txn |
| **role / manager map** (user→role, who-approves-whom) | one-off rarely-read rows |
| per-user **pending-approvals count / list** (short TTL) | |

EMS already caches `analytics:summary:<org>` for 15s — same idea, widen it.

### 6.2 Key naming = your tenant/user isolation
Namespace **every** key by tenant (and user where relevant):

```
t:<org_id>:policy:active
t:<org_id>:categories
t:<org_id>:user:<user_id>:pending          (per-user view)
t:<org_id>:policy:v<version>                (versioned — see 6.4)
```

This gives you: clean per-tenant isolation, the ability to **wipe one tenant's
cache** with a prefix delete (`del t:<org>:*`), and per-tenant memory accounting.

### 6.3 The access pattern: cache-aside
```
read:   v = redis.get(key)
        if v: return v                      # hit (the common case)
        v = db.query(...)                   # miss
        redis.set(key, v, ttl)
        return v
write:  db.write(...)                       # source of truth first
        redis.del(key) / bump version       # then invalidate
```
Redis is a **copy**, never the source of truth → a Redis outage = slower, not
wrong (fail-open). EMS's `MemoryCache` already behaves this way; `RedisCache`
slots into the same `getCache()` seam.

### 6.4 Invalidation made easy: **versioned keys**
The hard part of caching is invalidation. The cheap trick: put a **version** in
the key and bump it on write instead of hunting down keys to delete.

```
read:   ver = redis.get("t:<org>:policy:ver")        # one tiny read
        return redis.get("t:<org>:policy:v"+ver)
write:  db.update(policy); redis.incr("t:<org>:policy:ver")
        # old vN keys are now unreferenced → expire on their own
```
No scanning, no races — readers instantly see the new version.

### 6.5 Scaling Redis itself (same idea as the DB!)
- Redis also has a memory ceiling → **Redis Cluster** shards keys across nodes by
  hash slot. Because your keys start with `t:<org_id>:`, a tenant's keys can be
  co-located (hash tags `{org_id}`) — the **same shard-by-tenant idea** applies to
  the cache layer.
- **Noisy tenant evicting others:** use `maxmemory-policy allkeys-lru` + per-tenant
  prefixes; for whales, a dedicated Redis (mirror of the DB strategy: pool the
  many, isolate the few).
- **Stampede protection** for hot keys: a short per-key lock so only one request
  rebuilds a missed key while others wait, plus **jittered TTLs** so keys don't
  all expire together.

> 🧠 **Mental model #6:** Redis is a per-tenant, namespaced, fail-open *copy* of
> hot static data. Cache-aside + versioned keys solves 90% of it; cluster it the
> same way you shard the DB (by tenant) for the last 10%.

---

## 7. The EMS growth story (the mental model as a narrative)

Watch the same system climb the ladder. This is how to *feel* when each rung
arrives.

| Stage | Scale | What you run | Triggered by |
|---|---|---|---|
| **Launch** | 10s of tenants | 1 Postgres (rung 0) | — |
| **Traction** | 100s, dashboards heavy | + **read replicas** + **Redis** (rungs 1–2) | read latency climbs |
| **Loud tables** | audit/analytics noisy | split `audit`/`analytics` DBs; time-partition audit (rungs 3, 5) | audit table huge, vacuum slow |
| **A whale appears** | one 10k-user tenant | **shard by `org_id`**, pin the whale to its own shard (rung 4) | one tenant's load hurts neighbours |
| **Many tenants** | 1000s | shard fleet + **routing catalog** + **PgBouncer** + fan-out migrations | one shard can't hold them all |
| **Analytics at scale** | whales' dashboards | **CDC → OLAP** store, cold data → S3 (rung 6) | dashboards scan millions of rows |

Notice: **nothing here is a rewrite.** Because EMS already has `org_id` on every
row, a stateless app, and a cache seam, each rung is an *operational* addition.
That's the payoff of building the seams early.

---

## 8. Two principles to never violate

1. **Co-location golden rule.** Anything read/written in one transaction shares a
   shard key (`org_id`). This keeps transactions single-node and avoids the
   nightmare of distributed transactions. *(EMS: expense + steps + audit all
   carry `org_id`.)*
2. **The cache (and replicas) are copies, never the source of truth.** They may be
   stale or down; the system must stay *correct*, only slower. Fail open.

---

## 9. Cheat-sheet: "if you hit X, reach for Y"

| If you hit… | Reach for… |
|---|---|
| read latency, reads ≫ writes | **read replicas**, then **Redis cache** |
| repeated reads of static data | **Redis cache-aside + versioned keys** |
| "too many connections" | **PgBouncer** (transaction pooling) |
| storage/write ceiling on one box | **shard by `org_id`** |
| one tenant hurting others | **pin that tenant to its own shard** (catalog move) |
| a table that grows forever | **time-partition** + archive old partitions |
| need a report across all tenants | **OLAP store fed by CDC** (never cross-shard OLTP) |
| migrating schema on a huge fleet | **expand/contract online migration** + per-shard runner |
| moving a tenant without downtime | **logical replication + catalog cutover** |
| Redis out of memory | **Redis Cluster** (shard by tenant) + LRU + isolate whales |
| cache stampede on a hot key | **per-key lock / coalescing + jittered TTL** |

---

### Where this fits with the other docs
- `level-2.1` §3–§4 — the async/queue (outbox) and tiered-tenancy/sharding design.
- `level-2.3` §8–§9 — the *current* DB schema/indexes and the Redis seam in code.
- **This doc (2.4)** — the *mental model*: the ladder, the walls, and the fixes,
  so the choices in 2.1/2.3 feel obvious instead of arbitrary.
