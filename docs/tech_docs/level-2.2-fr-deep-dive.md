# EMS — Level 2.2: FR Deep Dive

> **Purpose:** `level-2-design.md` lists functional requirements in summary
> tables. This document expands each FR into a real product+engineering spec:
> **what it does, how it's built in the prototype, the edge cases, and the
> production design** for the parts we deferred. It is the FR counterpart to
> [`level-2.1-nfr-deep-dive.md`](./level-2.1-nfr-deep-dive.md).
>
> Two product questions drive most FR decisions:
>
> 1. **How configurable must approvals be?** The chain must adapt per
>    organisation (amount, category, type) **without code changes**. This is the
>    single most important FR and shapes the data model. → §3.
> 2. **How do the two money flows differ?** *Reimbursement* (approve-after-spend)
>    vs *direct company payment* (approve-before-spend, estimate + tolerance).
>    Same workflow, different money-movement tail. → §4.
>
> Everything else is laid out in §5 (built FRs) and §6 (not-built FRs) with
> **behaviour → prototype → production** so it's clear what's demoable vs designed.

---

## Table of Contents
1. Product Scope & Actors
2. FR Inventory (built vs not-built)
3. The Workflow Engine FR (the core)
4. The Two Money Flows (reimbursement vs company-paid)
5. Built FRs — Deep Dive
6. Not-Built FRs — Production Design
7. Edge Cases Catalogue
8. Tradeoffs & Decision Log
9. Prototype Gap Summary

---

## 1. Product Scope & Actors

| Actor | Goal | Key capabilities |
|---|---|---|
| **Employee** | Get money back / get company to pay | Create, edit, submit, withdraw, track own expenses |
| **Manager** | Control team spend | Approve/reject reportees' expenses (level 1), view reportees |
| **Finance** | Control org spend & policy | Approve (higher levels), manage policies/budgets, see all, dashboards |
| **Admin** | Run the tenant | Manage users/roles, policies, final-level approvals, onboard org |
| **Auditor** (role-extensible) | Oversight | Read-only + history (modelled via permissions; not a separate seeded role) |

**Two expense flows**: reimbursement and direct company
payment. Both share the approval workflow; they differ only in *when money moves*
and whether the amount is actual or estimated (§4).

---

## 2. FR Inventory (built vs not-built)

### Built (demonstrated in the prototype)
| # | FR | Where |
|---|---|---|
| F1 | Multi-tenancy (org isolation everywhere) | every repo query scoped by `org_id` |
| F2 | Auth (JWT) + RBAC (4 roles) | `auth/`, `rbac/permissions.ts` |
| F3 | Expense CRUD — both types | `modules/expenses` |
| F4 | Lifecycle state machine | `expense.service`, `workflow.engine` |
| F5 | **Configurable multi-level approval engine** | `workflow.engine.ts`, `policies` |
| F6 | Approve / reject with mandatory reason | `workflow.engine.ts` |
| F7 | Policy CRUD (thresholds → approver chain) | `modules/policy` |
| F8 | Budget enforcement (daily/monthly) | `modules/budget` |
| F9 | Attachments via S3 presigned URL (mock) | `modules/attachments` |
| F10 | Multi-currency (amount/base/fx) | `expenses/currency.ts` |
| F11 | Immutable audit trail + history API | `modules/audit` |
| F12 | Notifications (in-app, persisted) | `modules/notifications` |
| F13 | Views/queues (mine, reportees, all, pending) | `expense.service`, `approval.repo` |
| F14 | Self-approval prevention | `workflow.engine.approve()` |
| F15 | Observability dashboard | `modules/analytics` + UI |
| F16 | Tenant onboarding (self-serve signup) | `modules/orgs` |
| F17 | User management (add employees/roles) | `modules/users` + UI |
| F18 | Chain re-evaluation on edit | `expense.service.editExpense()` |
| F19 | Idempotent approve/reject | `http/idempotency.ts` |
| F20 | Withdraw / cancel | `expense.service.withdrawExpense()` |

### Not built (documented; production design in §6)
| # | FR | Reason deferred |
|---|---|---|
| G1 | OCR bill validation (blur / amount mismatch) | ML + async infra |
| G2 | Approver delegation (out-of-office) | calendar + routing complexity |
| G3 | SLA auto-escalation (timers) | needs durable scheduler |
| G4 | Direct-payment tolerance re-approval | edge branch |
| G5 | Comments / notes thread | nice-to-have |
| G6 | Resubmit-after-reject (clone with lineage) | nice-to-have |
| G7 | Draft autosave | UX polish |
| G8 | Real payout / payment-gateway + reconciliation | external integration |
| G9 | Expense line items (multi-item reports) | model extension |
| G10 | Receipt-required policy + category-based rules | policy extension |
| G11 | Live FX rates | provider integration |
| G12 | Bulk approval & advanced search/filter | scale UX |
| G13 | Reject "send-back-to-requester" variant | workflow option |
| G14 | Email / Slack / push delivery | provider integration |
| G15 | Recurring expenses / per-diem | product extension |

---

## 3. The Workflow Engine FR (the core)

This is the most important FR — workflow design / the workflow engine approach.
The design principle: **declarative, policy-driven, snapshotted.**

### 3.1 How it works (prototype)
```
submit
  → load active Policy for org
  → resolveLevels(rules, base_amount)   // pure function, unit-tested
  → snapshot policy onto the expense    // policy edits don't affect in-flight
  → create one ApprovalStep per level, resolve approver per role
  → expense.status = in_review, current_level = 1, notify level-1 approver
approve(level N)
  → guard: caller is the assigned approver AND not the requester
  → mark step approved; if last level → approved; else advance + notify next
reject
  → reason mandatory; mark step rejected; expense → rejected; notify requester
```

`rules_json` is the brain — amount range → ordered approver roles:
```json
{ "rules": [
  { "min": 0, "max": 5000, "levels": ["manager"] },
  { "min": 5001, "max": 50000, "levels": ["manager","finance"] },
  { "min": 50001, "max": null, "levels": ["manager","finance","admin"] } ] }
```

### 3.2 Why declarative, not hardcoded `if amount > X`
- Each org configures its own chain via Policy CRUD — **no deploy** to change rules.
- The chain is **data** (`ApprovalStep` rows), so it's queryable, auditable, and
  resumable after a crash.
- `resolveLevels` is a pure function → trivially unit-tested at all boundaries.

### 3.3 Production hardening (designed)
| Capability | Prototype | Production |
|---|---|---|
| Rule matching | amount range | + category, type, department, vendor, cost-center predicates |
| Approver routing | requester's manager; first user with role | routing tables, round-robin, load-by-queue-depth, group approvals |
| Parallel approvals | sequential only | "any 2 of N", parallel branches, quorum |
| Conditional branches | none | rule DSL or BPMN (e.g. Temporal/Camunda) |
| Durability of long waits | step row + SLA field | durable workflow engine with timers |
| Re-evaluation | on edit (amount) | + on policy version pin, on org-structure change |

> Upgrade path: the `rules_json` + `ApprovalStep` model maps cleanly onto a
> durable workflow engine (Temporal) when parallelism/conditionals/timers are
> needed — without changing the API surface.

---

## 4. The Two Money Flows

| Aspect | Reimbursement | Direct company payment |
|---|---|---|
| When money leaves | Employee already paid | Company pays vendor *after* approval |
| Amount at submit | **Actual** (from bill) | **Estimate** |
| Approval timing | approve-after-spend | approve-before-spend (pre-approval) |
| Tail step | reimburse employee (payout) | pay vendor + reconcile actual vs estimate |
| Built now | ✅ full chain to `approved` | ✅ full chain to `approved` |
| Not built | payout execution (G8) | tolerance re-approval (G4) + payout (G8) |

### 4.1 Tolerance (G4) — designed, not fully built
Policy carries `tolerance_percent`. Production behaviour for company-paid:
```
on reconcile(actual):
  if actual <= approved_amount * (1 + tolerance/100):  auto-pass (audit the delta)
  else: open a delta-approval ApprovalStep (only the overage is re-approved)
```
Prototype stores `tolerance_percent` on the policy and documents this branch;
the reconcile/delta step is not wired (no payout stage exists yet).

---

## 5. Built FRs — Deep Dive

For each: **behaviour · prototype mechanism · production hardening.**

### F1 Multi-tenancy
- **Behaviour:** every row belongs to an org; nobody reads across orgs.
- **Prototype:** `org_id` from JWT, enforced in every repository query; verified
  by a cross-tenant IDOR test (Org B → Org A resource = 404).
- **Production:** DB row-level security as defence-in-depth; per-tenant
  encryption keys; tiered tenancy (NFR §4).

### F2 Auth + RBAC
- **Behaviour:** login issues JWT; routes enforce role→permission.
- **Prototype:** access+refresh JWT, argon2/bcrypt hashes, `requirePermission`
  middleware, deny-by-default; ownership/hierarchy checks layered on top.
- **Production:** SSO (SAML/OIDC), MFA; ABAC (OPA/Cedar) for per-field /
  department-scoped rules; custom roles per tenant.

### F3 Expense CRUD (both types)
- **Behaviour:** create/read/update/delete; reimbursement & company_paid.
- **Prototype:** zod-validated DTOs; edits restricted to requester and
  pre-decision states; delete only on drafts.
- **Production:** expense **line items** (G9), receipt-required rules (G10),
  category taxonomy, soft-delete + retention.

### F4 Lifecycle state machine
- **Behaviour:** `draft → submitted → in_review → approved/rejected → (paid)`,
  plus `withdrawn`.
- **Prototype:** transitions centralised in the service/engine; illegal
  transitions return `409`.
- **Production:** add `paid` execution (G8); `sent_back` substate (G13);
  explicit state diagram enforced by a transition table.

### F5 Multi-level approval engine
See §3. Built: sequential, policy-driven, snapshotted, self-approval-safe,
idempotent, SLA field set. Production: parallel/conditional, delegation, durable
timers.

### F6 Approve / reject
- **Behaviour:** only the assigned current-level approver can act; reject needs
  a reason; approve advances/finalises.
- **Prototype:** guards + audit + notification per decision.
- **Production:** bulk approve (G12), comments (G5), send-back (G13).

### F7 Policy CRUD
- **Behaviour:** finance/admin define rules and tolerance; versioned.
- **Prototype:** full CRUD, range validation (`max ≥ min`), `version` bump on
  update, active-policy selection.
- **Production:** richer predicates (category/dept), draft/publish workflow for
  policies themselves, effective-dated policies.

### F8 Budget enforcement
- **Behaviour:** block submit if user/org daily or monthly limit would be
  exceeded.
- **Prototype:** read-modify in the submit transaction; sums non-terminal
  expenses in the window; returns `422` with limit/spent details.
- **Production:** per-category budgets, soft (warn) vs hard (block) limits,
  rolling windows, forecast/alerting before breach.

### F9 Attachments
- **Behaviour:** request a presigned URL, upload the bill, reference the key.
- **Prototype:** **mock** presigned URL (no AWS); key namespaced by `org_id`.
- **Production:** real S3 `getSignedUrl` (private bucket), AV scan, OCR pipeline
  (G1), object-lock, signed downloads.

### F10 Multi-currency
- **Behaviour:** file in any supported currency; store base + fx.
- **Prototype:** static rate table; `amount`, `currency`, `base_amount`,
  `fx_rate` stored at create; conversion unit-tested.
- **Production:** live FX provider (G11), rate snapshot at submit, rounding rules
  per currency, historical rate audit.

### F11 Audit trail + history
- **Behaviour:** every state change recorded immutably; visible per expense.
- **Prototype:** append-only `audit_log`, written **in the same transaction** as
  the change; `GET /expenses/:id/history`; optional S3 shipping (flagged).
- **Production:** hash-chain tamper evidence, WORM, SIEM, 7-yr retention (NFR §5).

### F12 Notifications
- **Behaviour:** recipients notified on submit/approve/reject.
- **Prototype:** persisted in-app rows + console log; unread badge in UI.
- **Production:** email/Slack/push via async outbox workers (NFR §3); user
  preferences, digests, templating.

### F13 Views / queues
- **Behaviour:** "my expenses", "pending approvals", reportees, all (by role),
  paginated.
- **Prototype:** RBAC-scoped queries; pending queue indexed on
  `(org_id, approver_id, status)`.
- **Production:** read replicas + rollups for large tenants (NFR §4.6),
  saved filters, full-text search (G12).

### F14 Self-approval prevention
- **Behaviour:** you can never approve your own expense.
- **Prototype:** approver resolution skips the requester; `approve()` re-checks
  `requester_id !== actor.id`.
- **Production:** also block approving a subordinate-of-self conflict / segregation
  of duties (SoD) policies.

### F15 Observability dashboard
- **Behaviour:** spend, status mix, category, SLA breaches, audit volume + app
  health.
- **Prototype:** Postgres aggregations cached short-TTL; Chart.js UI; `/metrics`.
- **Production:** Grafana, OLAP-backed analytics for big tenants, alerting.

### F16 Tenant onboarding
- **Behaviour:** self-serve signup creates org + first admin + default policy +
  budget, atomically; auto-login.
- **Prototype:** `POST /auth/signup` in one DB transaction; audit `org.created`.
- **Production:** email verification, billing/plan selection, domain claim,
  guided setup wizard, sample-data toggle.

### F17 User management
- **Behaviour:** admin adds users with roles + manager assignment.
- **Prototype:** `POST/GET/PATCH /users`, UI form; unique email per org.
- **Production:** SCIM provisioning, bulk import (CSV), invite-by-email,
  deactivation flows, role change audit.

### F18 Chain re-evaluation on edit
- **Behaviour:** if an edit changes the amount across a threshold while in
  review, the chain is rebuilt.
- **Prototype:** pending steps deleted + `startApprovalChain` re-run, audited.
- **Production:** preserve already-completed approvals where still valid; notify
  affected approvers of the change; require re-consent.

### F19 Idempotency
- **Behaviour:** retried approve/reject doesn't double-apply.
- **Prototype:** `Idempotency-Key` → stored response in `idempotency_keys`;
  plus step-state no-op check.
- **Production:** Redis dedup with TTL; applied to create too (NFR §5.7).

### F20 Withdraw
- **Behaviour:** requester cancels before final decision.
- **Prototype:** allowed in draft/submitted/in_review; pending steps cleared;
  audited.
- **Production:** withdrawal reasons, re-open window, notify approvers.

---

## 6. Not-Built FRs — Production Design

Each: **why it matters · production design · data/API impact · edge cases.**

### G1 — OCR bill validation
- **Why:** detect blur, mismatched/forged amounts, duplicates; reduce fraud +
  manual review.
- **Design:** on attachment upload, emit `ocr.bill` event (outbox). A worker
  calls AWS Textract / Google Vision / Tesseract, extracts total + date +
  merchant, compares to claimed `amount`, stores `ocr_result_json` +
  `confidence`. If mismatch/low-confidence → flag the expense, route to a review
  queue, optionally block submit.
- **Impact:** new `attachment.ocr_result_json`, `expense.flags[]`; async worker;
  review-queue endpoint.
- **Edge cases:** non-receipt images, multi-currency receipts, partial OCR,
  provider downtime (fail-open: allow but flag), duplicate-receipt detection
  across expenses (hash + fuzzy match).

### G2 — Approver delegation (out-of-office)
- **Why:** approvals must not stall when an approver is on leave.
- **Design:** `user.delegation { delegate_id, from, to }`. At step creation (and
  at escalation), if the resolved approver is OOO, assign the delegate and record
  **both** principal + delegate in audit. Delegations are themselves auditable
  and bounded in time.
- **Impact:** `delegations` table; approver-resolution change; audit fields.
- **Edge cases:** delegate also OOO (chain to next), self-delegation loops,
  delegation crossing org hierarchy / SoD violations, delegate leaves company.

### G3 — SLA auto-escalation
- **Why:** `sla_due_at` is stored but nothing acts on it; stuck approvals need
  reminders + escalation.
- **Design:** durable scheduler (Temporal timer per step, or cron + queue
  scanning overdue steps). On T-minus reminder → notify; on breach → escalate to
  the approver's manager or next level, audited as `step.escalated`.
- **Impact:** scheduler/worker; `approval_step.escalated_from`; metrics
  (`sla_breached` already on dashboard).
- **Edge cases:** clock skew, business-hours vs wall-clock SLAs, holidays,
  escalation target also overdue, expense edited mid-SLA (reset timer?).

### G4 — Direct-payment tolerance re-approval
See §4.1. **Design:** reconcile step compares actual vs approved×(1+tolerance);
within → auto-pass + audit delta; over → delta-approval step for the overage.
**Edge cases:** currency drift between estimate and actual, refunds/credit notes,
multiple partial invoices against one pre-approval.

### G5 — Comments / notes thread
- **Design:** `comments(expense_id, author_id, body, created_at)`; visible to
  participants; approvers can request info without rejecting.
- **Edge cases:** visibility scoping (requester vs approver-only notes),
  mentions/notifications, edit/delete policy (immutable for audit?).

### G6 — Resubmit-after-reject
- **Design:** "resubmit" clones the rejected expense into a new draft with
  `parent_id` lineage so history is preserved; new chain on submit.
- **Edge cases:** policy changed since original, attachments re-link vs re-upload,
  infinite resubmit loops (cap / require change).

### G7 — Draft autosave
- **Design:** debounced `PATCH` from the client; or local draft + explicit save.
- **Edge cases:** concurrent edits from two tabs, offline buffering.

### G8 — Payout / payment-gateway + reconciliation
- **Why:** the real money-movement tail (reimburse employee / pay vendor).
- **Design:** on `approved`, emit `payout.requested`; a payment service
  integrates a provider (bank ACH/UPI, vendor AP). Track `payment_status`
  (`initiated/settled/failed`); reconcile against bank statements; expense →
  `paid`. Strongly idempotent + audited.
- **Impact:** `payments` table, provider adapter, reconciliation jobs, `paid`
  state execution.
- **Edge cases:** partial failures, retries, reversals/clawbacks, FX at payout,
  provider downtime, duplicate payout prevention (idempotency key per expense).

### G9 — Expense line items (multi-item reports)
- **Design:** `expense_line_item(expense_id, description, amount, category)`;
  the expense becomes a "report" header; policy evaluates on the total (and
  optionally per-line caps).
- **Edge cases:** per-line vs total budget, mixed currencies per line, partial
  approval of lines.

### G10 — Receipt-required & category-based policy
- **Design:** extend `rules_json` predicates: `require_receipt_above`, per-
  category caps, per-category approver overrides.
- **Edge cases:** missing receipt blocking submit, category remapping over time.

### G11 — Live FX rates
- **Design:** rates service (ECB/OpenExchangeRates) cached daily; snapshot the
  rate on the expense at submit; audit the source + timestamp.
- **Edge cases:** stale rates on provider outage (fall back to last good),
  weekend/holiday rates, rounding/precision per currency.

### G12 — Bulk approval & advanced search
- **Design:** `POST /approvals/bulk` with idempotency; search via indexed
  filters now, full-text (Postgres `tsvector` / OpenSearch) at scale.
- **Edge cases:** partial bulk failure (per-item result), permission per item.

### G13 — Reject "send-back-to-requester"
- **Design:** policy/option: reject can either terminate (current) or set
  `sent_back` so the requester edits and re-submits without a new record.
- **Edge cases:** which level it returns to, audit of the round-trip.

### G14 — Email / Slack / push delivery
- **Design:** async outbox workers per channel (NFR §3.6); user notification
  preferences; templates; digests.
- **Edge cases:** bounces, rate limits, quiet hours, per-tenant SMTP.

### G15 — Recurring expenses / per-diem
- **Design:** schedule definition that materialises expenses periodically;
  per-diem rates by location/role.
- **Edge cases:** schedule drift, policy changes between occurrences, proration.

---

## 7. Edge Cases Catalogue (functional)

| # | Scenario | Built behaviour | Production behaviour |
|---|---|---|---|
| 1 | Self-approval | Blocked (403) | + SoD policies |
| 2 | Wrong approver acts | Blocked (403) | same |
| 3 | Approve already-decided expense | 409 conflict | same (idempotent on key) |
| 4 | Concurrent approve + reject | DB txn serialises; 2nd sees non-pending | optimistic lock on step version |
| 5 | Edit crosses threshold mid-review | Chain rebuilt | preserve valid approvals |
| 6 | Submit over budget | 422 with details | soft vs hard, forecast warn |
| 7 | Submit with no active policy | 422 | onboarding guarantees a default |
| 8 | Requester has no manager | Falls back to first org manager | routing rules |
| 9 | Unsupported currency | 422 | live rates / allowlist |
| 10 | Approver on leave | Manual reassign (admin) | delegation (G2) |
| 11 | Stuck approval (SLA) | Stored + flagged on dashboard | auto-escalation (G3) |
| 12 | Actual > estimate (company-paid) | Stored tolerance; not enforced | delta re-approval (G4) |
| 13 | Cross-tenant access | 404 (no existence oracle) | + RLS |
| 14 | Duplicate receipt | Not detected | OCR hash/fuzzy match (G1) |
| 15 | Retried API call | Idempotent (approve/reject) | extend to create + bulk |

---

## 8. Tradeoffs & Decision Log

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Approval rules | Declarative `rules_json` | Hardcoded thresholds | Per-org config without deploys |
| Chain representation | Materialised `ApprovalStep` rows | Compute on the fly | Resumable, auditable, queryable |
| Policy on in-flight items | Snapshot at submit | Always-latest policy | In-flight requests must be stable |
| Reject semantics | Terminate chain | Send-back default | Simpler; send-back is an option (G13) |
| Approver resolution | Manager + first-with-role | Static config only | Works with seed; routing later |
| Money movement | Stop at `approved` | Build payout now | External integration; out of core scope |
| Multi-item | Single amount per expense | Line items now | Model simplicity; extend via G9 |
| Currency | Static table | Live provider now | No external dep in prototype |
| Notifications | In-app now, channels later | All channels now | Async infra is NFR work (deferred) |

---

## 9. Prototype Gap Summary

| Capability | Prototype | Production |
|---|---|---|
| Approval chain | Sequential, policy-driven, snapshotted, idempotent | + parallel/conditional, delegation, durable timers |
| Money flows | Both flows to `approved` | + payout + reconciliation + tolerance re-approval |
| Bill handling | Mock presign | Real S3 + AV + OCR validation |
| Policy expressiveness | Amount thresholds + tolerance | + category/dept/vendor predicates, effective dating |
| Notifications | In-app persisted | Email/Slack/push via outbox, preferences |
| Expense shape | Single amount | Line-item reports |
| FX | Static rates | Live provider, snapshot, audit |
| SLA | Stored + dashboard flag | Auto-escalation scheduler |
| Search/bulk | Paginated filters | Full-text + bulk approve |
| Onboarding | Signup + defaults | + email verify, billing, wizard |

> The prototype implements the **functional core end-to-end** (configurable
> multi-level approvals for both money flows, RBAC, audit, budgets, multi-tenant
> onboarding, observability). Every deferred FR is **additive** — it extends the
> data model or adds an async worker, without reworking the core workflow.
