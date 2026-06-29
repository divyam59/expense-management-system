# AI Features — Proposal & Roadmap

> Status: **proposal / roadmap** (not yet implemented). This document captures
> where AI fits in the Expense Management System (EMS), the high-value features,
> and the engineering principles for building them in a robust, testable way.

Expense management is a strong fit for AI: the system already has the two inputs
AI needs — **unstructured data** (uploaded bills) and **structured rules**
(policies + analytics). The plan is to add AI as a *swappable, untrusted,
observable* component that mirrors the patterns the codebase already uses
(`BlobStorage` abstraction, Zod validation, audit logging, tenant scoping).

---

## 1. High-value features (mapped to existing modules)

| # | Feature | What it does | Plugs into | Priority |
|---|---------|--------------|------------|----------|
| 1 | **Receipt OCR + auto-fill** ⭐ | On bill upload, extract merchant, date, amount, currency, tax, line items → pre-fill the draft | `attachments` → `expenses` | **Highest** |
| 2 | **Auto-categorization** | Suggest a category from merchant / description | `expenses` + `categories` | High |
| 3 | **Duplicate / fraud detection** | Flag the same receipt twice, amount ≠ receipt, split bills, round-number / weekend anomalies | `attachments` + `expenses` + `audit` | High |
| 4 | **Approver copilot** | NL summary + policy check + an "Approve / Reject because…" recommendation in the queue | `workflow` + `policies` | High |
| 5 | **Chat-to-analytics** | "How much did we spend on travel last quarter?" → safe, read-only query | `analytics` | Medium |
| 6 | **NL policy authoring** | Admin describes a rule in English → generates the policy JSON rules | `policies` | Medium |
| 7 | **Email / forward ingestion** | Forward a receipt to an inbox → AI parses → draft created | `attachments` | Nice-to-have |

**Build first: #1 (Receipt OCR auto-fill).** It is the most useful, and it
directly extends the existing bill-upload flow.

---

## 2. Engineering principles ("the good way")

AI is treated as an **untrusted, swappable, observable** component — not magic
sprinkled into business logic.

1. **Provider abstraction** — one interface, swappable implementations
   (Azure / OpenAI / local), with a **mock** used in tests so AI features are
   deterministically testable (same idea as the `BlobStorage` abstraction).

   ```ts
   export interface AiProvider {
     extractReceipt(file: { buffer: Buffer; mimetype: string }): Promise<ReceiptExtraction>;
     classify(input: string, labels: string[]): Promise<{ label: string; confidence: number }>;
     complete(prompt: string, schema: ZodSchema): Promise<unknown>; // structured output
   }
   ```

2. **Model output is untrusted input** — always parse it through **Zod**, exactly
   like request bodies. If it does not validate, fall back to manual entry. Never
   `JSON.parse` a model blob straight into the database.

3. **Human-in-the-loop by default** — AI **suggests**, a person confirms. OCR
   pre-fills an editable draft; the copilot **recommends** but the approver still
   clicks. Never auto-approve on AI alone.

4. **Tenant isolation & privacy** — never put another org's data in a prompt;
   scope all retrieval by `org_id`; redact PII where possible; make AI opt-in per
   org; avoid providers that train on customer data.

5. **Async + graceful degradation** — run OCR off the request path (job/queue),
   show an "extracting…" state, and if the provider is down the user simply types
   manually. An AI failure must never block the core flow.

6. **Guardrails** — receipts contain attacker-controlled text, so
   **prompt-injection** is a real risk. Keep extraction read-only, constrain
   outputs to a schema, and for chat-to-analytics use a **read-only DB role +
   query validation / allowlist** — never run raw model-generated SQL on a write
   connection.

7. **Observability + evals** — log prompt / response / token usage / latency into
   the existing **audit** module; keep a small **labeled fixture set** to measure
   OCR / categorization accuracy and prevent regressions in CI (the mock provider
   returns fixtures so parsing and guardrail logic are tested deterministically).

---

## 3. First slice — Receipt OCR auto-fill

A vertical slice that proves the architecture end-to-end:

- **New module** `modules/ai/`:
  - `ai.provider.ts` — the `AiProvider` interface.
  - `ai.mock.ts` — `mockAiProvider` returning fixtures (default in tests / CI).
  - `ai.openai.ts` — real implementation behind an `AI_PROVIDER` env flag.
- **Hook** into `attachment.service.uploadBill`: after bytes are stored, call
  `extractReceipt`, validate the result with Zod, and attach the suggestions to
  the draft (or return them to the UI).
- **UI**: an "AI extracted — please review" banner on the create-expense form,
  pre-filling amount / date / merchant / category — all editable.
- **Tests**: mock provider → assert fields map correctly, low-confidence results
  fall back to manual, malformed output is rejected; the extraction is recorded
  in the audit log.

This reuses the storage / validation / audit / multi-tenant patterns already in
the codebase, adds **no hard dependency on a specific vendor**, and stays fully
testable.

### Configuration (proposed)

| Env var | Purpose | Default |
|---------|---------|---------|
| `AI_PROVIDER` | `mock` \| `openai` \| `azure` | `mock` |
| `AI_API_KEY` | provider key (when not `mock`) | — |
| `AI_MODEL` | model / deployment name | `gpt-4.1-mini` |
| `AI_ENABLED` | per-deploy kill switch | `false` |

---

## 4. Suggested rollout order

1. Receipt OCR auto-fill (#1) — vertical slice + provider abstraction + mock.
2. Auto-categorization (#2) — reuses the same provider, cheap win.
3. Duplicate / fraud detection (#3) — adds real money protection.
4. Approver copilot (#4) — speeds up the review queue.
5. Chat-to-analytics (#5) and NL policy authoring (#6) — once the foundation and
   guardrails are proven.
