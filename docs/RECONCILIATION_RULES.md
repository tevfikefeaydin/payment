# Reconciliation rules

Complete reference for the ten deterministic rules in
`packages/domain/src/reconciliation.ts`.

**No language model participates in financial matching or exception creation.**
Every rule is a pure function of its inputs plus an injected `now`. There is no
randomness, no wall-clock read and no network access inside the engine, so two
runs over identical inputs produce byte-identical fingerprints — which is what
makes runs idempotent.

Current rule-set version: **`RULE_VERSION = 1`**.

---

## Shared concepts

### Inputs

`ReconciliationInput` (`packages/domain/src/types.ts`), already scoped to one
organization:

| Field                   | Contents                                           |
| ----------------------- | -------------------------------------------------- |
| `organizationId`        | Tenant. Part of every fingerprint.                 |
| `now`                   | Evaluation time, injected for determinism.         |
| `providerPayments`      | Normalised payment intents and charges             |
| `providerRefunds`       | Refunds, with the payment they apply to            |
| `providerInvoices`      | Invoices, with subscription link and attempt count |
| `providerSubscriptions` | Subscriptions and their status                     |
| `internalRecords`       | The customer's own payment records                 |
| `config`                | Tolerance windows (below)                          |

### Tolerance windows — `DEFAULT_RECONCILIATION_CONFIG`

| Setting                           | Default | Effect                                                                                                                                            |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internalPropagationGraceMinutes` | 30      | A provider payment younger than this is not reported as missing or not-paid; the customer's webhook handler may legitimately still be catching up |
| `stalePendingHours`               | 48      | Internal `pending` older than this is stale                                                                                                       |
| `heuristicMatchWindowHours`       | 72      | Maximum time separation for a heuristic (non-explicit) match                                                                                      |
| `duplicateWindowMinutes`          | 60      | Two identical successful charges inside this window are a potential duplicate                                                                     |
| `refundPropagationGraceMinutes`   | 60      | Grace before a provider refund not reflected internally is reported                                                                               |

### Matching precedence

`MatchIndex` (`packages/domain/src/matching.ts`) resolves the provider ↔ internal
correspondence. Highest precedence first:

1. **`strong` — explicit link.** Either the internal record names the provider
   transaction (`providerTransactionId` equals the payment id **or** its
   `paymentIntentId`), or provider metadata names the internal record. Metadata
   keys are checked in order and the first non-empty value wins:
   `payrecon_external_id`, `internal_payment_id`, `internal_id`, `external_id`,
   `order_id`.
2. **`heuristic` — mutually unique correlation.** No explicit link exists, but
   exactly **one** internal record and exactly **one** provider payment share
   customer, amount and currency and fall inside `heuristicMatchWindowHours`. The
   match must be unique in **both** directions. An internal record already bound
   to a _different_ provider transaction is excluded from heuristic matching.
3. **`none`** — no candidate.

A heuristic key requires a customer id on both sides. Amount plus currency alone
is far too loose to be treated as identifying, so the index refuses to group
rather than guess.

One asymmetry worth knowing: if an internal record names a
`providerTransactionId` that the provider does not have, that is **not**
ambiguity — it is a real signal, returned as `none`, and rule 3 reports it.

### Ambiguity and diagnostics policy

**Ambiguity is never resolved by picking "the closest" candidate.** When more
than one candidate exists and none can be chosen safely, the engine emits no
exception and increments a counter instead. The counters land in
`reconciliation_runs.diagnostics`:

| Counter                    | Meaning                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ambiguousProviderMatches` | A provider payment matched more than one internal record                                                              |
| `ambiguousInternalMatches` | An internal record matched more than one provider payment, or had neither a provider transaction id nor a customer id |
| `withinPropagationGrace`   | Provider payments skipped because they are younger than the grace window                                              |
| `invalidCurrencyRecords`   | Internal records whose currency could not be validated                                                                |

**Why diagnostics rather than exceptions.** An exception is a claim that
something is wrong, carrying a severity, an exact revenue-at-risk figure and a
recommended action. Ambiguous data supports no such claim — it means _the inputs
were insufficient_, which is a different problem with a different remedy
(populate `providerTransactionId`, add a correlation id to Stripe metadata).
Emitting a confident exception from a guess would corrode trust in the inbox, and
a false "you were charged twice" is far more expensive than a missed detection.
Surfacing the counter tells the operator exactly that: _N items could not be
matched, here is why_, without polluting the queue of things that genuinely need
action.

### Fingerprints

```
fingerprint = sha256( Σ len(part) + ":" + part  for part in
                      [organizationId, ruleId, ...components] )
```

Components are length-prefixed, so `("ab","c")` and `("a","bc")` cannot collide.
`(organization_id, fingerprint)` is unique in the database, which is what
prevents duplicate open exceptions across runs while letting a resolved exception
reopen in place with its history intact.

**The rule version is deliberately excluded.** If it were included, publishing a
new rule version would orphan every existing exception and create a duplicate for
each one. See [`adr/0006-exception-fingerprints.md`](adr/0006-exception-fingerprints.md).

### Revenue at risk

Always exact `bigint` minor units with an explicit currency, **never summed
across currencies**. A helper used repeatedly:

```
netAtRisk(payment) = max(payment.amountMinor - payment.amountRefundedMinor, 0)
```

so an already-refunded payment contributes nothing and cannot be double-counted.

### Behaviour when source data later changes

Handled uniformly by `persistCandidates`
(`packages/db/src/repositories/reconciliation.ts`), under a per-organization
advisory transaction lock:

| Situation on the next run                                                | Result                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same fingerprint, no existing exception                                  | **Created** as `open`, with a `created` timeline event                                                                                           |
| Same fingerprint, exception is `resolved`                                | **Reopened** — state becomes `reopened`, `resolved_at`/`resolved_by` cleared, a `reopened` timeline event is written, and it is notifiable again |
| Same fingerprint, exception is active (`open`/`acknowledged`/`reopened`) | **Unchanged state.** An operator's acknowledgement is never reset by re-detection                                                                |
| Fingerprint no longer produced (problem fixed)                           | **Nothing happens.** The exception is not auto-resolved — a human confirms the fix and resolves it                                               |

In all three "seen again" cases the **evidence is refreshed**: severity, summary,
revenue at risk, currency, evidence rows, probable causes, recommended actions,
rule version, occurred-at and the provider/internal identifiers are rewritten
from the new candidate, `last_seen_at` and `last_run_id` are updated, and
`version` is incremented. So if a partial refund lands, the amount shown moves;
if a duplicate cluster grows, the count moves. Rules note below where this is
especially visible.

Per-rule notes use "source data changes" to mean specifically: what happens to an
existing exception when the underlying rows are later corrected.

---

## Rule 1 — `PAYMENT_SUCCEEDED_INTERNAL_MISSING`

> Stripe captured money and the customer's system has no record of it at all.

| Aspect              | Detail                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerPayments`                                                                                                                                                                                          |
| **Required fields** | `status`, `amountMinor`, `amountRefundedMinor`, `currency`, `createdAt`, `id`                                                                                                                               |
| **Matching**        | `findInternalFor(payment)` — full precedence                                                                                                                                                                |
| **Window**          | `internalPropagationGraceMinutes` (30)                                                                                                                                                                      |
| **Trigger**         | `status === "succeeded"` **and** `now - createdAt >= grace` **and** the match is not ambiguous **and** no internal record was found                                                                         |
| **Non-trigger**     | Payment not succeeded; payment younger than the grace window (counted as `withinPropagationGrace`); match ambiguous (counted as `ambiguousProviderMatches`); any internal record found, whatever its status |
| **Severity**        | `critical`                                                                                                                                                                                                  |
| **Revenue at risk** | `netAtRisk(payment)`, in the payment's currency                                                                                                                                                             |
| **Fingerprint**     | `[payment.id]`                                                                                                                                                                                              |

**Why critical.** Revenue was collected and nothing was provisioned. This is the
highest-impact failure in the set: the customer paid and received nothing, so it
is simultaneously a revenue problem and a support incident.

**Evidence.** Provider payment id; Status (`succeeded` vs `not found`); Amount;
Currency; Customer; Invoice; Created.

**Probable causes.**

- The webhook that records successful payments failed or was never delivered.
- The payment was created outside the normal checkout flow (Stripe Dashboard, API,
  or a recovery link).
- The internal write failed after the charge succeeded and was not retried.

**Recommended actions.**

- Locate the payment in Stripe and confirm what the customer purchased.
- Replay or re-run your own webhook handler for this payment, then re-run
  reconciliation.
- Check your webhook endpoint's error rate around the payment time.

**When source data changes.** Once an internal record appears that matches this
payment, the rule stops producing the candidate. The exception is not
auto-resolved — an operator confirms and resolves it. If the payment is later
refunded, `netAtRisk` falls and the displayed exposure drops on the next run;
once fully refunded it shows `0`.

---

## Rule 2 — `PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID`

> The internal record exists and is linked, but does not reflect a successful
> payment.

| Aspect              | Detail                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerPayments`                                                                                                                                                                                                                                    |
| **Required fields** | Payment `status`, `amountMinor`, `amountRefundedMinor`, `currency`, `createdAt`; record `status`, `externalId`, `amountMinor`, `currency`, `occurredAt`                                                                                               |
| **Matching**        | `findInternalFor(payment)` — a match is **required**                                                                                                                                                                                                  |
| **Window**          | `internalPropagationGraceMinutes` (30)                                                                                                                                                                                                                |
| **Trigger**         | `status === "succeeded"` **and** past the grace window **and** a record was matched **and** the record's status is **not** `paid`, `refunded` or `partially_refunded` — i.e. it is `pending` or `failed`                                              |
| **Non-trigger**     | No matched record (rule 1's territory); record already `paid`; record `refunded` or `partially_refunded` — both imply the payment _was_ recognised as successful at some point, so they are not a not-paid condition; payment inside the grace window |
| **Severity**        | `critical` when the record says `failed`, otherwise `high`                                                                                                                                                                                            |
| **Revenue at risk** | `netAtRisk(payment)`                                                                                                                                                                                                                                  |
| **Fingerprint**     | `[payment.id, record.externalId]`                                                                                                                                                                                                                     |

**Why the split severity.** A record saying `failed` for a payment Stripe
captured means the application actively believes the payment did not happen — it
has almost certainly denied the customer access and may have sent a failure
email. A `pending` record is merely stalled.

**Evidence.** Provider payment vs the record's `providerTransactionId`; Internal
record id; Status on each side; Amount on each side; Occurred on each side; Last
updated internally.

**Probable causes.**

- If the record is `failed`: a failure was recorded for a payment Stripe
  ultimately captured — often a timeout on the first attempt followed by a
  successful retry.
- Otherwise: the success webhook was lost, delayed, or errored before the record
  was updated.
- A race condition left the record in its pre-confirmation state.

**Recommended actions.**

- Confirm in Stripe that the payment is captured and not disputed.
- Update the internal record to paid and provision whatever the customer
  purchased.
- Review handler logs for this payment id to find why the state was never
  advanced.

**When source data changes.** Setting the record to `paid` stops the candidate.
Note the fingerprint includes `record.externalId`: if the record is deleted and
re-created under a **new** external id, this becomes a different fingerprint and a
new exception — the old one must be resolved manually.

---

## Rule 3 — `INTERNAL_PAID_PROVIDER_MISSING`

> The internal system believes a payment succeeded, but the provider has no such
> payment.

| Aspect              | Detail                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Iterates**        | `internalRecords`                                                                                                                                                                                                                                                                                                                          |
| **Required fields** | `status`, `occurredAt`, `amountMinor`, `currency`, `externalId`; at least one of `providerTransactionId` or `customerId`                                                                                                                                                                                                                   |
| **Matching**        | `findProviderFor(record)`                                                                                                                                                                                                                                                                                                                  |
| **Window**          | `internalPropagationGraceMinutes` (30), measured from `occurredAt`                                                                                                                                                                                                                                                                         |
| **Trigger**         | `status === "paid"` **and** `now - occurredAt >= grace` **and** the match is not ambiguous **and** no provider payment was found **and** the record has a `providerTransactionId` **or** a `customerId`                                                                                                                                    |
| **Non-trigger**     | Record not `paid`; inside the grace window; match ambiguous (counted as `ambiguousInternalMatches`); a provider payment was found; **the record has neither a provider transaction id nor a customer id** — there is no safe basis on which to assert the provider is missing it, so this is counted as `ambiguousInternalMatches` instead |
| **Severity**        | `high`                                                                                                                                                                                                                                                                                                                                     |
| **Revenue at risk** | `record.amountMinor`, in the record's currency                                                                                                                                                                                                                                                                                             |
| **Fingerprint**     | `[record.externalId]`                                                                                                                                                                                                                                                                                                                      |

**Why not critical.** The most common real-world cause is benign — the payment
lives in a different Stripe account or mode — so the rule reports it as a serious
discrepancy to investigate rather than a confirmed loss.

**Evidence.** Provider payment (`not found` when the record named one); Internal
record; Status (`not found` vs `paid`); Amount; Customer; Occurred.

**Probable causes.**

- The payment was marked paid optimistically before the provider confirmed it.
- A manual or test record was created in the internal system.
- The payment was taken through a different provider or account than the one
  connected here.
- The connected Stripe account is in a different mode (test vs live) than the
  internal data.

**Recommended actions.**

- Search Stripe for the customer to confirm no payment exists.
- If no payment was taken, decide whether to invoice the customer or reverse the
  entitlement.
- If the payment lives in another Stripe account, connect that account as an
  additional source.

**When source data changes.** Connecting the correct Stripe account, or syncing
the missing payment, makes the match succeed and the candidate disappear. Changing
the record's status away from `paid` also stops it.

---

## Rule 4 — `PAYMENT_AMOUNT_MISMATCH`

> A matched pair disagrees on amount, within the same currency.

| Aspect              | Detail                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerPayments`                                                                                                                                                                                                                                                                                                              |
| **Required fields** | Both sides' `amountMinor` and `currency`; a match                                                                                                                                                                                                                                                                               |
| **Matching**        | `findInternalFor(payment)` — a match is required                                                                                                                                                                                                                                                                                |
| **Window**          | **None.** An amount mismatch on a matched pair is a fact, not a propagation delay                                                                                                                                                                                                                                               |
| **Trigger**         | `status === "succeeded"` **and** a record matched **and** the record's currency is valid **and** the normalised currencies are **equal** **and** `payment.amountMinor !== record.amountMinor`                                                                                                                                   |
| **Non-trigger**     | No match; amounts equal; **currencies differ** — comparing across currencies is meaningless without an FX rate, so rule 5 owns that case exclusively; the record's currency fails validation — normalising it here would throw and abort the entire run, so the record is silently skipped and rule 5 records it in diagnostics |
| **Severity**        | `high`                                                                                                                                                                                                                                                                                                                          |
| **Revenue at risk** | `abs(payment.amountMinor - record.amountMinor)` — the **difference**, not either full amount, in the payment's currency                                                                                                                                                                                                         |
| **Fingerprint**     | `[payment.id, record.externalId]`                                                                                                                                                                                                                                                                                               |

**Why the difference, not the whole amount.** Only the delta is genuinely at
risk; the agreed portion was correctly collected and recorded. Reporting the full
amount would wildly overstate exposure across an inbox.

**Evidence.** Provider payment vs record's `providerTransactionId`; Amount on each
side; Currency on each side; a Difference row stating direction (`provider higher
by …` / `internal higher by …`); Occurred on each side.

**Probable causes.**

- A discount, coupon, tax or shipping amount was applied on one side only.
- The internal record stores the pre-tax or pre-discount amount.
- A currency minor-unit conversion error (for example treating JPY as
  two-decimal).
- The order was modified after the payment was captured.

**Recommended actions.**

- Compare the Stripe line items with the internal order breakdown.
- Confirm which figure is authoritative and correct the other side.
- If the customer was overcharged, decide whether a refund is owed; if
  undercharged, decide whether to collect the difference. (The recommendation
  adapts to the direction.)

**When source data changes.** Correcting either amount stops the candidate. If a
_different_ wrong amount is written, the fingerprint is unchanged (it is built
from ids, not amounts), so the same exception is updated in place with the new
difference — it does not spawn a second exception.

---

## Rule 5 — `PAYMENT_CURRENCY_MISMATCH`

> A matched pair disagrees on currency.

| Aspect              | Detail                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerPayments`                                                                                                                                                                                                                                       |
| **Required fields** | Both sides' `currency`; a match                                                                                                                                                                                                                          |
| **Matching**        | `findInternalFor(payment)` — a match is required                                                                                                                                                                                                         |
| **Window**          | None                                                                                                                                                                                                                                                     |
| **Trigger**         | `status === "succeeded"` **and** a record matched **and** the record's currency is valid **and** the normalised currencies differ                                                                                                                        |
| **Non-trigger**     | No match; currencies equal after normalisation (case is not a mismatch — `usd` and `USD` are the same); **the record's currency fails validation** — this is a data-quality problem, not a currency mismatch, and is counted as `invalidCurrencyRecords` |
| **Severity**        | `critical`                                                                                                                                                                                                                                               |
| **Revenue at risk** | `netAtRisk(payment)`, denominated in the **provider's** currency — the money that actually moved — and never converted                                                                                                                                   |
| **Fingerprint**     | `[payment.id, record.externalId]`                                                                                                                                                                                                                        |

**Why critical.** Every downstream number is wrong: revenue reporting, refund
amounts, tax. And because there is no FX conversion in the MVP, the two sides
cannot even be compared, so the defect is invisible to ordinary totals.

**Why the provider's currency.** PayRecon performs no FX conversion. Stating the
exposure in the currency that actually settled is the only honest option, and the
figure is never summed with the internal side's currency.

**Evidence.** Provider payment vs record's `providerTransactionId`; Currency on
each side (normalised); Amount on each side, each rendered in its own currency;
Occurred on each side.

**Probable causes.**

- The internal system assumes a single default currency and ignores the
  provider's.
- A multi-currency checkout writes the presentment currency instead of the
  settlement currency.
- The currency column was populated from a hard-coded constant.

**Recommended actions.**

- Confirm the settlement currency in Stripe for this payment.
- Store the provider's currency verbatim on the internal record.
- Audit other records for the same customer for the same defect.

**When source data changes.** Correcting the internal currency stops the
candidate — and may immediately surface a **rule 4** exception if the amounts also
disagree, which is correct: the currency defect was masking an amount defect.

---

## Rule 6 — `DUPLICATE_SUCCEEDED_PAYMENT`

> The same customer was charged the same amount more than once in a short window.

| Aspect              | Detail                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Iterates**        | `providerPayments`, grouped                                                                                                                                                                                                                                                                |
| **Required fields** | `customerId` (**mandatory**), `amountMinor`, `currency`, `createdAt`, `id`                                                                                                                                                                                                                 |
| **Matching**        | Not used. Grouping key is `customerId + amountMinor + normalisedCurrency`                                                                                                                                                                                                                  |
| **Window**          | `duplicateWindowMinutes` (60)                                                                                                                                                                                                                                                              |
| **Trigger**         | Two or more `succeeded` payments share the grouping key, and each falls within the window of the **cluster's first** payment                                                                                                                                                               |
| **Non-trigger**     | **No customer id** — "same amount twice" is not evidence of a duplicate without one, so such payments are excluded from grouping entirely; fewer than two payments in a cluster; payments separated by more than the window (they start a new cluster, and a lone payment is not reported) |
| **Severity**        | `critical`, or `low` when every excess charge has already been refunded                                                                                                                                                                                                                    |
| **Revenue at risk** | `Σ netAtRisk(p)` over the **extras only** — every payment after the earliest                                                                                                                                                                                                               |
| **Fingerprint**     | `[first.customerId, first.amountMinor, normalisedCurrency, first.id]`                                                                                                                                                                                                                      |

**Clustering.** Payments are sorted by `createdAt`, then by `id` for stability.
Each payment joins the current cluster if it is within the window of that
cluster's **first** member; otherwise the cluster is flushed and a new one starts.
So a slow drip of charges every 45 minutes forms several clusters rather than one
enormous one.

**Why only the extras, net of refunds.** The first charge was legitimate — the
customer intended to buy once. Counting the whole cluster would double-count
money that was correctly collected. Subtracting refunds means a duplicate that
was already refunded contributes `0`, which is exactly why the severity drops to
`low` in that case: it is a bug worth fixing but the customer is whole.

**Why the fingerprint is anchored on the earliest payment.** A third duplicate
arriving later joins the same cluster, whose first member is unchanged, so it
**updates the existing exception** — raising the count and the amount at risk —
rather than creating a second exception for the same incident.

**Evidence.** Customer; Charge count; Amount each; the full list of payment ids;
First charged; Last charged; Excess not refunded.

**Probable causes.**

- The customer double-submitted a checkout form with no idempotency key.
- A client-side retry re-sent the payment request after a slow response.
- A webhook retry re-triggered charge creation instead of being treated as
  idempotent.

**Recommended actions.** When money is still exposed: verify with the customer
whether multiple purchases were intended; refund the excess charges in Stripe if
unintended; add an idempotency key to the charge-creation path. When everything is
already refunded: confirm the refunds are complete and the customer was made
whole, and still add the idempotency key.

**When source data changes.** Refunding the duplicates drops the risk to `0` and
the severity to `low` on the next run, and the summary rewords itself. A further
duplicate inside the window raises the count and the amount. The exception is
never auto-resolved.

---

## Rule 7 — `REFUND_STATUS_MISMATCH`

> Refund state disagrees between the provider and the internal system, in either
> direction.

Both directions share one rule id because they describe the same class of
problem, but they carry distinct summaries, causes, evidence and — crucially —
distinct fingerprints, so they can coexist and be resolved independently.

| Aspect              | Detail                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerPayments`, with `providerRefunds` used to find the latest succeeded refund time per payment                                              |
| **Required fields** | `amountMinor`, `amountRefundedMinor`, `currency`; record `status`, `amountMinor`, `currency`, `externalId`; refunds need `status` and `paymentId` |
| **Matching**        | `findInternalFor(payment)` — a match is required                                                                                                  |
| **Window**          | `refundPropagationGraceMinutes` (60), **direction A only**                                                                                        |
| **Severity**        | `high` for both directions                                                                                                                        |

### Direction A — provider refunded, internal system unaware

|                     |                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Trigger**         | `payment.amountRefundedMinor > 0` **and** the record's status is neither `refunded` nor `partially_refunded` **and** (no succeeded refund timestamp is known **or** the latest one is older than the grace window) |
| **Non-trigger**     | Nothing refunded on the provider side; the record already reflects a refund; the refund happened within the last 60 minutes — the customer's webhook may still be catching up                                      |
| **Revenue at risk** | `payment.amountRefundedMinor` — the amount that left the business but is still recognised internally                                                                                                               |
| **Fingerprint**     | `[payment.id, record.externalId, "provider_refunded"]`                                                                                                                                                             |
| **Evidence**        | Provider payment; Refunded amount (provider vs `0`); Refund type (`full`/`partial`); Status (`refunded`/`partially_refunded` vs the record's status); Refunded at                                                  |
| **Occurred at**     | The latest succeeded refund time, falling back to the payment's creation time                                                                                                                                      |

**Probable causes.** The refund was issued from the Stripe Dashboard and no
webhook updated the internal record; the `charge.refunded` webhook is not
subscribed to or is failing; the internal system has no representation for partial
refunds.

**Recommended actions.** Update the internal record to reflect the refund and
revoke any entitlement it granted; subscribe to and verify handling of refund
webhooks.

### Direction B — internal system believes a refund happened, provider disagrees

|                     |                                                                                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**         | The record's status is `refunded` or `partially_refunded` **and** `payment.amountRefundedMinor === 0`                                                                                                                                                                                                |
| **Non-trigger**     | Any refund exists on the provider side (even a partial one against a fully-refunded internal record — direction A owns the "amounts disagree" nuance); the record does not claim a refund. **No grace window** — an internal system claiming a refund that never happened is not a propagation delay |
| **Revenue at risk** | `record.amountMinor`, in the **record's** currency — the customer was likely credited or granted a reversal without money being returned                                                                                                                                                             |
| **Fingerprint**     | `[payment.id, record.externalId, "internal_refunded"]`                                                                                                                                                                                                                                               |
| **Evidence**        | Provider payment; Refunded amount (`0` vs `recorded as refunded`); Status on each side; Amount on each side                                                                                                                                                                                          |

**Probable causes.** A refund was recorded internally but the provider call
failed or was never made; the refund was issued against a different payment or
provider account; a support tool marks records refunded without calling the
provider.

**Recommended actions.** Confirm in Stripe whether a refund exists for this
payment; if the customer is owed money, issue the refund in Stripe directly;
ensure the internal refund path fails loudly when the provider call does not
succeed.

**When source data changes (both directions).** Aligning the two sides stops the
candidate. Direction A's revenue at risk tracks `amountRefundedMinor`, so an
additional partial refund raises it on the next run. Because the two directions
have different fingerprints, resolving one never hides the other.

---

## Rule 8 — `PAID_INVOICE_INACTIVE_SUBSCRIPTION`

> An invoice was paid, but the subscription it belongs to is not in a state that
> should be billing.

| Aspect              | Detail                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerInvoices`, with `providerSubscriptions` indexed by id                                                                                                                                                                                                                                                                                                 |
| **Required fields** | Invoice `status`, `subscriptionId`, `amountPaidMinor`, `currency`, `paidAt`/`createdAt`; subscription `status`, `canceledAt`                                                                                                                                                                                                                                   |
| **Matching**        | Direct id lookup — `invoice.subscriptionId` → subscription. No heuristics                                                                                                                                                                                                                                                                                      |
| **Window**          | None, but see the cancellation-ordering non-trigger                                                                                                                                                                                                                                                                                                            |
| **Trigger**         | `invoice.status === "paid"` **and** the invoice names a subscription **and** that subscription exists in the synced data **and** its status is **not** in `ACTIVE_SUBSCRIPTION_STATUSES` (`trialing`, `active`)                                                                                                                                                |
| **Non-trigger**     | Invoice not paid; no subscription id (a one-off invoice); the subscription is not in the synced data — the rule refuses to conclude anything about a subscription it cannot see; the subscription is `trialing` or `active`; **the invoice was paid strictly before the cancellation timestamp** — a final invoice paid before cancellation is entirely normal |
| **Severity**        | `high`                                                                                                                                                                                                                                                                                                                                                         |
| **Revenue at risk** | `invoice.amountPaidMinor`, in the invoice's currency                                                                                                                                                                                                                                                                                                           |
| **Fingerprint**     | `[invoice.id]`                                                                                                                                                                                                                                                                                                                                                 |

**Why the cancellation-ordering check matters.** Without it, every clean
cancellation would raise an exception, because the final invoice is naturally paid
by a subscription that is now `canceled`. Only payment **at or after** the
cancellation moment is suspicious.

**Evidence.** Invoice id; Invoice status; Amount paid; Subscription id;
Subscription status; Canceled at; Invoice paid at.

**Probable causes.**

- The subscription was cancelled but a scheduled invoice still collected payment.
- Cancellation was processed internally without cancelling in Stripe.
- A dunning retry succeeded after the subscription had already been marked unpaid.

**Recommended actions.**

- Confirm whether the customer should still have access.
- If the charge was not owed, refund it in Stripe.
- Align the cancellation flow so internal and Stripe state change together.

**When source data changes.** Reactivating the subscription (to `active` or
`trialing`) or refunding and voiding the invoice stops the candidate. Note that
refunding alone does **not** stop it — this rule reads `amountPaidMinor`, not the
refunded amount — so the operator resolves it explicitly after handling it.

---

## Rule 9 — `FAILED_INVOICE_ACTIVE_SUBSCRIPTION`

> An invoice has failed to collect, yet the subscription is still active or
> trialing. Service is being delivered without payment.

| Aspect              | Detail                                                                                                                                                                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `providerInvoices`, with `providerSubscriptions` indexed by id                                                                                                                                                                                                                                            |
| **Required fields** | Invoice `status`, `attemptCount`, `amountDueMinor`, `amountPaidMinor`, `currency`, `subscriptionId`, `createdAt`; subscription `status`                                                                                                                                                                   |
| **Matching**        | Direct id lookup                                                                                                                                                                                                                                                                                          |
| **Window**          | None. `attemptCount > 0` is the maturity signal instead of elapsed time                                                                                                                                                                                                                                   |
| **Trigger**         | The invoice is failing — `status === "uncollectible"` **or** (`status === "open"` **and** `attemptCount > 0`) — **and** it names a subscription **and** that subscription exists **and** its status **is** `trialing` or `active` **and** `amountDueMinor - amountPaidMinor > 0`                          |
| **Non-trigger**     | An `open` invoice with `attemptCount === 0` — it simply has not been attempted yet and is not a failure; `draft` or `void` invoices; a paid invoice; no subscription id; subscription not synced; subscription **not** active (dunning is working as designed); nothing outstanding after partial payment |
| **Severity**        | `high`                                                                                                                                                                                                                                                                                                    |
| **Revenue at risk** | `amountDueMinor - amountPaidMinor` — the **outstanding** balance, so a partial payment correctly reduces the exposure                                                                                                                                                                                     |
| **Fingerprint**     | `[invoice.id]`                                                                                                                                                                                                                                                                                            |

**Evidence.** Invoice id; Invoice status; Amount due; Amount paid; Outstanding;
Attempts; Subscription id; Subscription status.

**Probable causes.**

- Dunning is exhausted but the subscription was never downgraded or paused.
- The application grants access on subscription status alone and ignores invoice
  state.
- The customer's payment method expired and no recovery flow ran.

**Recommended actions.**

- Decide whether access should be suspended until the invoice is paid.
- Prompt the customer to update their payment method.
- Gate entitlement on invoice payment, not only on subscription status.

**When source data changes.** Paying the invoice, voiding it, or moving the
subscription out of `active`/`trialing` stops the candidate. A partial payment
lowers the outstanding amount and the exception updates in place on the next run.

---

## Rule 10 — `STALE_INTERNAL_PENDING_PAYMENT`

> An internal payment has been pending far longer than any real payment takes.

| Aspect              | Detail                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iterates**        | `internalRecords`                                                                                                                                                                                  |
| **Required fields** | `status`, `occurredAt`, `amountMinor`, `currency`, `externalId`                                                                                                                                    |
| **Matching**        | `findProviderFor(record)`, used only to enrich evidence and to suppress overlap with rule 2                                                                                                        |
| **Window**          | `stalePendingHours` (48)                                                                                                                                                                           |
| **Trigger**         | `status === "pending"` **and** `now - occurredAt >= 48 hours` **and** the matched provider payment (if any) is **not** `succeeded`                                                                 |
| **Non-trigger**     | Record not `pending`; younger than the threshold; **the matched provider payment is `succeeded`** — rule 2 reports that with better evidence, and reporting both would double-count the same money |
| **Severity**        | `medium`                                                                                                                                                                                           |
| **Revenue at risk** | `record.amountMinor`                                                                                                                                                                               |
| **Fingerprint**     | `[record.externalId]`                                                                                                                                                                              |

**Why medium.** A stale pending record usually means an abandoned checkout, where
no money was ever at stake. It is a data-hygiene and reporting problem more often
than a revenue loss — but occasionally it is a lost terminal-state webhook, which
is why it is reported at all.

**Age calculation.** Whole hours via exact `bigint` division. The money-safety
lint rule banning `Math.floor` in this package is deliberately absolute — an
exemption would blunt it — and bigint division expresses "whole hours" directly
anyway.

**Evidence.** Internal record; Status (the provider's status or `not found`, vs
`pending`); Amount; Pending since; Age in hours; Provider payment (its id or `not
found`, vs the record's `providerTransactionId`).

**Probable causes.**

- If a provider payment exists: it is in some non-succeeded state and the internal
  record was never advanced to a terminal state.
- Otherwise: the payment was never completed and no failure was recorded.
- The customer abandoned checkout and the record was left pending.
- A terminal-state webhook (success or failure) was never processed.

**Recommended actions.**

- Check the provider for a terminal outcome and update the record accordingly.
- Expire abandoned pending payments automatically after a defined period.
- Alert on records that stay pending beyond your expected settlement time.

**When source data changes.** Moving the record to any terminal status stops the
candidate. If the provider payment later becomes `succeeded` while the record is
still `pending`, this rule goes quiet and **rule 2** takes over — deliberately, so
the same money is never counted by two rules at once.

---

## Rule interaction summary

Where rules could overlap, exactly one owns each case:

| Situation                                    | Owning rule | Why the others stand down                                         |
| -------------------------------------------- | ----------- | ----------------------------------------------------------------- |
| Succeeded payment, no internal record        | 1           | Rules 2, 4, 5, 7 all require a matched record                     |
| Succeeded payment, record `pending`/`failed` | 2           | Rule 10 explicitly skips records whose provider payment succeeded |
| Matched pair, currencies differ              | 5           | Rule 4 skips when the normalised currencies differ                |
| Matched pair, same currency, amounts differ  | 4           | Rule 5 skips when the currencies match                            |
| Internal record's currency is unparseable    | diagnostics | Rule 4 skips it; rule 5 counts `invalidCurrencyRecords`           |
| More than one plausible match on either side | diagnostics | Every matching rule refuses to guess                              |
| Duplicate charges already refunded           | 6, `low`    | `netAtRisk` is `0`, so nothing is double-counted                  |

Within a single run, `runReconciliation` also de-duplicates by fingerprint before
returning, so a fingerprint collision cannot violate the
`(organization_id, fingerprint)` uniqueness constraint on insert. Candidates are
sorted by severity, then rule id, then fingerprint, so output ordering is stable.

---

## Testing

Rule behaviour is covered by `packages/domain/src/reconciliation.test.ts`, with
supporting suites for matching, fingerprints, money and the state machine.

The full path — demo dataset, production engine, real persistence — is exercised
by `packages/db/src/verify-core.ts`:

```bash
pnpm --filter @payrecon/db exec tsx src/verify-core.ts
```

Its recorded output (see `docs/IMPLEMENTATION_STATUS.md`) shows all ten rules
firing exactly once from realistic data, a second run creating zero new
exceptions, and revenue at risk reported per currency and never summed.
