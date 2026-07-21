# 0007 — Separating the two Stripe contexts

**Status:** Accepted

## Context

PayRecon touches Stripe for two entirely unrelated reasons:

1. **Customer data integration.** A customer supplies a restricted key so
   PayRecon can **read** their operational Stripe data for reconciliation.
2. **Platform billing.** PayRecon uses its **own** Stripe account to sell
   PayRecon subscriptions.

Both are "Stripe". Both need a client, a key, webhook handling and tables. The
temptation to share a `stripeClient()` helper, a `stripe_events` table or a
`STRIPE_SECRET_KEY` variable is real, and every one of those shortcuts creates a
catastrophic failure mode:

- A customer's restricted key reaching platform-billing code would attempt writes
  against the customer's account — violating the product's core promise that
  PayRecon never writes to a customer's Stripe account.
- PayRecon's platform credential reaching customer-data code would read
  PayRecon's own account and reconcile _PayRecon's_ revenue against a customer's
  internal records. Nonsense output, presented confidently.
- A shared webhook table would let a customer-account event be processed by
  billing logic, potentially granting entitlements from a foreign event.
- A shared client factory would make "which key am I holding?" a runtime question
  rather than a structural one.

These are not hypothetical slips. They are the natural consequence of two things
with the same name sharing a helper.

## Decision

**Separate the two contexts at every layer, and enforce the separation
mechanically.**

| Layer                | Customer data integration                                          | Platform billing                                                                          |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Package              | `@payrecon/stripe-customer-data`                                   | `@payrecon/platform-billing`                                                              |
| Environment          | `STRIPE_CUSTOMER_TRANSPORT`, `STRIPE_CUSTOMER_RATE_LIMIT_RPS`      | `PLATFORM_STRIPE_SECRET_KEY`, `PLATFORM_STRIPE_WEBHOOK_SECRET`, `PLATFORM_STRIPE_PRICE_*` |
| Credential source    | Per-tenant, submitted through the UI, encrypted at rest            | Process environment / secret manager                                                      |
| Accepted key formats | `rk_test_` / `rk_live_` only                                       | `sk_…` (or `rk_…`) for PayRecon's own account                                             |
| Schema file          | `packages/db/src/schema/sources.ts`                                | `packages/db/src/schema/billing.ts`                                                       |
| Tables               | `stripe_connections`, `stripe_credentials`, `sync_*`, `provider_*` | `billing_customers`, `billing_subscriptions`, `billing_webhook_events`                    |
| Direction            | **Read only.** No write call exists                                | Read and write, against PayRecon's own account only                                       |
| Permissions          | `connections:*`                                                    | `billing:read`, `billing:manage`                                                          |
| Webhooks             | None                                                               | Signature-verified against the raw body                                                   |

No table in `billing.ts` references `stripe_connections`, and no table in
`sources.ts` references anything in `billing.ts`. The two halves of the schema do
not know about each other.

**Enforcement.** `eslint.config.js` declares `no-restricted-imports` in **both
directions**:

```js
// packages/platform-billing/**/*.ts
{ group: ["@payrecon/stripe-customer-data", "@payrecon/stripe-customer-data/*"],
  message: "Platform billing must never touch customer Stripe data. See ADR 0007." }

// packages/stripe-customer-data/**/*.ts
{ group: ["@payrecon/platform-billing", "@payrecon/platform-billing/*"],
  message: "Customer data integration must never touch platform billing. See ADR 0007." }
```

Bidirectionality matters. A one-way rule only stops the mistake you thought of
first; the rule that catches "billing imports the sync helper because it looked
convenient" is a different rule from the one that catches the reverse.

**Supporting guards.**

- `packages/stripe-customer-data/src/key-validation.ts` accepts only `rk_test_` /
  `rk_live_` and rejects `sk_…`, `pk_…` and malformed input, each with a distinct
  explanation. The prefix is checked before any network call.
- `packages/config/src/env.ts` refuses `PLATFORM_STRIPE_SECRET_KEY` without
  `PLATFORM_STRIPE_WEBHOOK_SECRET`, so billing cannot be deployed with signature
  verification effectively disabled.
- `billing_subscriptions.plan_key` is resolved **server-side** from the price id
  and is never accepted from a client payload.
- Revenue recorded by platform billing is PayRecon's revenue and is never mixed
  into a customer's reconciled operational revenue.

## Consequences

**Good.**

- The dangerous mistake is a **build failure**, not a code-review catch. Reviewers
  are unreliable; lint is not.
- Reading either package, it is unambiguous which Stripe account is in play,
  because the package boundary answers the question.
- A customer's restricted key is never in scope in code that can write, so "does
  PayRecon ever write to a customer's account?" is answered structurally rather
  than by auditing call sites.
- The separation is visible in the schema, which is where a future contributor is
  most likely to look first.
- Each context can evolve independently: billing can adopt a newer Stripe API
  version without touching the sync path.

**Costs.**

- **Deliberate duplication.** Retry logic, pagination and error classification
  exist (or will exist) in both packages rather than in one shared `stripe-common`
  helper. This is accepted: a shared helper is exactly the seam through which the
  contexts would leak into each other. The duplication is small and the isolation
  is the product's core safety property.
- Two sets of environment variables, two sets of tests, two sets of fixtures.
- A genuinely shared concern — say, a Stripe error-code taxonomy — has nowhere
  neutral to live. It would have to go into `@payrecon/domain` as pure data with
  no client, no credentials and no I/O.
- The lint rule blocks legitimate-looking imports and will occasionally frustrate
  someone. The error messages point at this ADR so the reason is one click away.

**Current status.** Both packages are implemented. The separation is additionally
covered by two tests:
`packages/platform-billing/src/context-separation.test.ts` and
`packages/stripe-customer-data/src/read-only-invariant.test.ts` — the latter
reads the package's own source from disk on every run and fails if a
write-capable Stripe call, a non-GET verb, or a cross-context import ever
appears. That is a stronger guarantee than the lint rule alone: it survives
someone constructing a client dynamically.

Neither context has been exercised against a live Stripe account in this
environment. The customer integration is verified through a controlled fake
transport and the platform billing path through signed fixtures.
