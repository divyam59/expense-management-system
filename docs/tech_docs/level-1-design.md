# Expense Management System (EMS) — Level 1 Design Doc

> **Status:** Level 1 (baseline). This version captures the author's original
> brain-dump, organized into a clean structure. Gaps and refinements are listed
> in the **Appendix** and will be promoted into the body in Level 2.
>
> **Assignment:** Design a scalable, enterprise-grade, SaaS Expense Management
> Platform with configurable multi-level approval workflows and role-based
> access management. Employees can submit expenses for **reimbursement** or
> **direct company payment**.

---

## 1. Problem Statement (recap)

A SaaS expense platform used by organizations of different sizes (startups →
global enterprises). Core capabilities:

1. Expense creation and tracking
2. Multi-level, configurable approval workflows
3. Role-based access management (RBAC)

---

## 2. Key Assumptions

- **Multi-tenant SaaS:** one deployment serves many organizations; all data is
  scoped by `organization_id` and isolated per tenant.
- Two expense flows:
  - **Reimbursement** — employee pays first, then claims money back (approve-after-spend).
  - **Direct company payment** — employee raises request first, company pays the
    vendor after approval (approve-before-spend, amount is an *estimate*).
- Approval rules are **threshold (amount) based** and configured per organization
  via Policies.
- A "Manager" is **not** a separate entity — it is a `User` who has reportees
  (self-referencing hierarchy via `manager_id`).
- Base/reporting currency is configured per organization; expenses can be filed
  in any currency and converted at submission time.

---

## 3. Functional Requirements (FRs)

1. **CRUD on expense requests** — two types: self-paid (reimbursement) and
   company-paid (direct payment).
2. **Approval & rejection** with a mandatory reason.
3. **Level-based (multi-level) approval** driven by policy.
4. **Notifications** to the relevant person on each action (submit, approve,
   reject, escalate, paid).
5. **RBAC** — roles: `user (employee)`, `manager`, `finance`, `admin`.
6. **Budget enforcement** — daily / monthly budget limits per user/org
   (was phrased as "rate limit on budget").
7. **Attachments** — upload bill photo to S3; serve via **pre-signed URL**; store
   URL/key in expense metadata.
8. **Multi-currency** — support all currencies for orgs operating across countries.
9. **Approval SLA timer** — each request has a timer so it never gets stuck
   forever; on timeout → remind / escalate.
10. **Edit option** — requester can edit; approver has a response edit window
    (proposed: 1 week).
11. **Audit trail** — viewable via a "History" tab in the UI.

> Scope note (author): OCR bill validation (verify bill authenticity / amount,
> flag blur/invalid) is listed but treated as *possibly out of scope* — see Appendix.

---

## 4. Non-Functional Requirements (NFRs)

- **Secure** — authN/authZ, tenant isolation, least-privilege RBAC.
- **Auditable** — every state change recorded immutably.
- **Scalable** — more users + more approval-policy types/variations.
- **Consistent audits** — what is shown must match the recorded history.
- **Available** — multi-zone deployment.
- **Failure handling** — replication / failover.
- **Idempotency** — safe retries on submit/approve/reject (no double action).
- **Read-heavy optimization** — read replicas / materialized views for list & view.
- **Low latency** — Redis caching.

---

## 5. APIs (Level 1 list)

> Author's original action-style list, kept for reference. A REST resource-style
> redesign is proposed in the Appendix.

- `POST /reimbursement` — create reimbursement request
- `POST /company-paid` — create company-paid request
- `CRUD /policy` — manage approval/budget policies
- `POST /approve` — approve a request
- `POST /reject` — reject a request
- `GET /view-all` — list all requests (per permission)
- `GET /view-reportees` — list reportees' requests (manager)

---

## 6. Data Model (Level 1)

> Author's original entities, lightly normalized. A corrected schema is in the
> Appendix (notably: merge Employee/Manager, add `ExpenseRequest` +
> `ApprovalStep`).

- **Employee:** `employee_id`, `manager_id`, `name`
- **Manager:** `employee_id`, `manager_id`, `name`, `reportees[]`
- **Policy:** `id`, `conditions` (JSON)
- **Bill:** `s3_url`, `description`, `amount`
- **Role:** one of `manager`, `user`, `admin`, `finance`
- **Access per role:**
  - CRUD on requests
  - approve/reject + see specific requests
  - see all requests

---

## 7. Workflows

### 7.1 Reimbursement (self-paid)
1. Employee fills the reimbursement: bill + amount + description.
2. Notification sent to approver(s).
3. **Threshold-based approval** (configurable per organization):
   - if `amount > X` → immediate manager **and** dept head approval (defined in policy)
   - if `amount < X` → single manager approval
4. **Edit option** available (requester).
5. **Manager view:** approve/reject claims for immediate reportees, with reason
   → triggers notification.
6. **Approver edit/response window:** 1 week.

### 7.2 Direct company payment
- Created by employee; **same flow as above**, except there is **no pre-payment**
  — the amount is an **expected/estimated** amount.
- **Tolerance:** allow actual to be within **±5–10%** of approved amount.
  - If actual exceeds tolerance → must be re-applied with proper amount, or
    further approval required.
  - *(Author flagged this as an edge case — decide inclusion; see Appendix.)*

### 7.3 Audit
- All actions visible via the "History" tab in the UI.

---

## 8. Architecture (Level 1)

```
User
  │
  ▼
API Gateway
  │
  ├── Service 1: CRUD + Approve/Reject
  ├── Service 2: Notifications
  └── Service 3: Read/View builder (Redis-backed views)
        │
        ▼
   Databases (sharded, replicated, multi-zone)
```

- Microservices behind an API gateway.
- Each service connected to its DB.
- DBs are **sharded, replicated, multi-zone**.

---

## 9. Edge Cases (Level 1)

- First approver is on leave → (delegation/escalation needed).
- Approved amount is larger than the actual expense.
- Direct-payment actual amount exceeds approved + tolerance.

---

---

# Appendix — Gap Analysis & Level 2 Candidates

> These are review notes. They will be merged into the main body in Level 2.

## A. Missing Functional Requirements
- **Multi-tenancy / org isolation** (critical — assignment is SaaS).
- **Expense categories** (policies often depend on category, not just amount).
- **Draft → Submit** lifecycle (save without submitting).
- **Resubmit after rejection** loop (explicit).
- **Withdraw/cancel** by employee before approval.
- **Approval chain visibility** for the employee (where is it stuck, who's next).
- **Comments/notes thread** on a request.
- **Currency conversion at submit** + store FX rate used.
- **Receipt-required policy** (amount > X requires a bill).
- **Reimbursement payout / payment status** (final money-movement step).
- **Delegation** (approver on leave) — promote from edge case to FR.
- Rename "rate limit on budget" → **Budget/Policy enforcement** (not API rate-limiting).

## B. Missing Non-Functional Requirements
- **Consistency split:** approvals/money = strong consistency; views/dashboards =
  eventual (read replica). State this tradeoff explicitly.
- **Observability** (structured logs, metrics, tracing).
- **Data retention / compliance** (financial records ~7 yrs; PII/GDPR).
- **Backup + DR** (RPO/RTO).
- **Performance targets** (e.g. p99 API < 300ms).

## C. API Redesign (resource-based REST)
- `POST /expenses`, `GET /expenses`, `GET /expenses/{id}`,
  `PATCH /expenses/{id}`, `DELETE /expenses/{id}`
- State transitions: `POST /expenses/{id}/submit|approve|reject|withdraw`
- `POST /attachments/presign` (S3 pre-signed URL)
- `GET /approvals/pending` (my approval queue)
- `CRUD /policies`, `CRUD /users`, `CRUD /roles`
- Cross-cutting: pagination, filtering, `Idempotency-Key` header, auth on all.

## D. Corrected Data Model (target for Level 2)
Entities:
`Organization, User, Role, Permission, RolePermission, ExpenseRequest,
ExpenseLineItem (optional), Attachment, Policy, ApprovalStep, AuditLog,
Notification, Budget`.

Key fixes:
- **Merge Employee + Manager** → single `User` with self-referencing `manager_id`
  and `organization_id`.
- Add central **`ExpenseRequest`** entity (type, amount, currency, base_amount,
  fx_rate, status, requester_id, org_id, policy_snapshot, timestamps).
- Add **`ApprovalStep`** entity (expense_id, level, approver_id, status, reason,
  acted_at, sla_due_at) — this is the heart of the workflow engine.
- **`AuditLog`** (immutable: actor, action, entity, before/after, timestamp).

## E. Workflow Engine — decisions to document
- Sequential vs parallel approvers at a level.
- **Snapshot the policy** at submission (in-flight requests unaffected by policy edits).
- **Re-evaluate chain on edit** (if amount crosses threshold after edit).
- **Self-approval prevention**.
- **Escalation on SLA timeout** (the "timer" idea → remind + auto-escalate).
- Editing an *approved* expense should re-trigger the workflow.

## F. More Edge Cases
- Duplicate submission (idempotency).
- Approver leaves company mid-flow.
- Concurrent approve/reject on the same request.
- Circular manager hierarchy.
- Currency rounding.
- Budget exceeded at submission.

## G. Tolerance edge case (the author's question)
**Verdict: keep in the doc, keep code simple.** Make `tolerance_percent` a Policy
field. Rule: `actual <= approved * (1 + tolerance)` → auto-pass; else → re-approval.
Implement the field + simple check; the complex re-approval branch can be parked
for discussion.

---

# Build Scope for the Working Prototype (1-day deadline)

> Strategy: **build a modular monolith** that demonstrates the assignment's
> heart (workflow + RBAC + audit + multi-tenancy). **Design** the rest
> (microservices, sharding, multi-zone) in the doc but do not build it.

| Build NOW (demo-able) | Side-park (document & discuss) |
|---|---|
| Auth + RBAC (employee/manager/finance/admin) | OCR bill validation (Textract/Tesseract, async) |
| Expense CRUD (reimbursement + company-paid) | DB sharding (strategy only) |
| Threshold-based multi-level approval engine | Microservices split (build modular monolith) |
| Approve/reject + reason + status lifecycle | Multi-zone HA / replication (document) |
| Audit log + history view | Materialized views (use Redis cache / query) |
| Notifications (persisted + console log) | Real payment gateway / payout |
| Policy (thresholds + budget) | Full delegation engine (do simple reassign) |
| S3 presigned upload (MinIO/local fallback ok) | Tolerance re-approval branch (field + note only) |
| Multi-tenancy (`org_id` scoping) | |
| Multi-currency (amount + currency + FX, static rates) | |
