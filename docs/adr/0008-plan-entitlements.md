# 0008 — Plans and entitlements

**Status:** Accepted

## Context

PayRecon sells subscription plans with usage limits. Two questions have to be
answered carefully:

1. **Where does the truth about a plan live?** A client that can influence its own
   plan, price or entitlements is a client that gets the product for free. Every
   value visible to a browser — a price, a plan key, a limit — is a value an
   attacker can change.
2. **What happens when a customer exceeds a limit, or downgrades below their
   current usage?** The tempting answer, "stop working", is wrong in a
   reconciliation product. Locking someone out of the exception inbox because
   they downgraded means unresolved payment problems go uninvestigated — the
   product actively causing the harm it was bought to prevent. It also traps the
   customer: they cannot export their data or reach the billing screen to fix the
   situation.

## Decision

**Plans are defined once, on the server, and enforcement is non-destructive.**

### Server-derived plans

- `packages/config/src/plans.ts` is the single definition of every plan, its
  display price, and its limits. Nothing else defines a plan.
- A plan's Stripe price id is referenced **by environment variable name**
  (`priceEnvVar: "PLATFORM_STRIPE_PRICE_GROWTH"`), so price ids differ between
  environments without the plan table changing, and no price id is compiled into
  client code.
- `billing_subscriptions.plan_key` is resolved **server-side from the price id on
  the verified Stripe event**. The browser never supplies a plan key, a price, or
  an entitlement — the schema comment states this explicitly.
- `organizations.plan_key` carries the effective plan; `plan_key` is a PostgreSQL
  enum, so an invalid value cannot be written by any path.
- `displayAmountMinor` is `bigint` minor units with an explicit currency, and is
  **display only** — the amount actually charged is whatever Stripe's price says.
  A stale display price cannot cause a wrong charge.

### The plans

| Plan    | Monthly records | Connections | Members   | Destinations | Max retention |
| ------- | --------------- | ----------- | --------- | ------------ | ------------- |
| Free    | 5 000           | 1           | 3         | 1            | 30 days       |
| Starter | 50 000          | 2           | 10        | 5            | 90 days       |
| Growth  | 250 000         | 5           | 25        | 15           | 180 days      |
| Scale   | unlimited       | unlimited   | unlimited | unlimited    | 365 days      |

`null` means no limit. New organizations get `free` (`DEFAULT_PLAN`).

Retention is bounded independently of plan by `RETENTION_MIN_DAYS = 7` and
`RETENTION_MAX_DAYS = 365`, backed by a check constraint on `organizations`
(`retention_days between 7 and 365`). A plan may lower the effective maximum but
**never below the floor** — a customer cannot configure retention so short that
the product's own guarantees break, nor so long that data is kept indefinitely by
accident.

### Usage measurement

`usage_counters` is keyed by `(organization_id, period, metric)` with `period` a
UTC `YYYY-MM` string, constrained by a regex check. A month boundary is therefore
unambiguous and timezone-independent — "did this record count against January or
February?" has exactly one answer.

### Non-destructive enforcement

When a limit is reached, enforcement:

- **blocks new over-limit usage** — the next ingest beyond the cap, the next
  connection beyond the allowance;
- **preserves everything else**: reading dashboards, investigating and resolving
  exceptions, exporting data, and reaching the billing screens needed to resolve
  the situation.

Nothing is deleted, disabled or hidden on a downgrade. If an organization
downgrades from Growth (5 connections) to Starter (2), the existing connections
keep working; the third creation attempt is refused. Enforcement is always
server-side and produces a clear product message naming the limit and the plan
that would raise it.

## Consequences

**Good.**

- A client cannot grant itself a plan, a price or an entitlement. The only path is
  a signature-verified Stripe event mapped to a price id the server recognises.
- Adding or repricing a plan is a change to one file plus an environment
  variable.
- Prices differ per environment without code changes, and test mode needs no
  special casing.
- A downgraded or over-limit customer can always resolve their payment problems
  and pay their bill — the two things that matter most to both parties.
- The retention floor and ceiling are enforced by the database, so no code path
  can bypass them.

**Costs.**

- **Enforcement is scattered by nature.** Each limit must be checked at its own
  call site — ingestion, connection creation, invitation, destination creation.
  There is no single choke point, so a new feature with a plan limit needs its own
  check. A limits helper mitigates this but cannot eliminate it.
- **Over-limit usage is possible in a race.** Two concurrent ingests can both
  observe a counter below the limit. The counter is a monthly aggregate rather
  than a transactional reservation, so the overshoot is bounded and small; making
  it exact would require serialising ingestion per tenant, which is a poor trade.
- **`displayAmountMinor` can drift** from the real Stripe price. It is
  display-only, so the consequence is a misleading marketing page rather than a
  wrong charge — but it must be kept in step by hand.
- Plan definitions live in `@payrecon/config`, which is imported by browser code
  for the pricing table. That is safe because the module contains no secrets, but
  it means plan **limits** are visible to clients. Acceptable: limits are public
  product information. Only their **enforcement** must be server-side.
- Someone on Scale (unlimited) generates no counter pressure, so cost control for
  a pathological tenant is an operational matter rather than a product one.

**Current status.** Plan definitions, limits, retention bounds, the enum and the
usage-counter table all exist, and `packages/platform-billing/src` implements
checkout, signature-verified webhooks, server-side plan mapping
(`plan-mapping.ts`) and entitlements (`entitlements.ts`), each with unit tests.
Verification uses signed fixtures rather than a live Stripe account, which is
recorded as a limitation rather than claimed as complete.
