# 0006 — Exception fingerprints

**Status:** Accepted

## Context

Reconciliation runs repeatedly: on a schedule, after an import, after a sync, and
whenever an operator clicks the button. Every run re-evaluates the same data and
re-derives the same findings.

Three behaviours must hold simultaneously:

1. A repeated run must **not** create duplicate open exceptions. An inbox that
   grows by ten items an hour is an inbox nobody reads.
2. A resolved exception must **reopen** when the problem genuinely returns —
   silently swallowing a recurrence would hide the very failure the product
   exists to catch.
3. State-transition history must be preserved. "This was resolved on Tuesday and
   came back on Friday" is precisely what an operator needs to know.

That requires a stable identity for "the same underlying problem" across runs.

## Decision

**A SHA-256 fingerprint over length-prefixed components, unique per
organization.**

```
fingerprint = sha256( Σ len(part) + ":" + part
                      for part in [organizationId, ruleId, ...components] )
```

`(organization_id, fingerprint)` is a unique index on `exceptions`.

### Components per rule

| Rule                                  | Components                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `PAYMENT_SUCCEEDED_INTERNAL_MISSING`  | `[payment.id]`                                                                |
| `PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID` | `[payment.id, record.externalId]`                                             |
| `INTERNAL_PAID_PROVIDER_MISSING`      | `[record.externalId]`                                                         |
| `PAYMENT_AMOUNT_MISMATCH`             | `[payment.id, record.externalId]`                                             |
| `PAYMENT_CURRENCY_MISMATCH`           | `[payment.id, record.externalId]`                                             |
| `DUPLICATE_SUCCEEDED_PAYMENT`         | `[customerId, amountMinor, currency, earliestPaymentId]`                      |
| `REFUND_STATUS_MISMATCH`              | `[payment.id, record.externalId, "provider_refunded" \| "internal_refunded"]` |
| `PAID_INVOICE_INACTIVE_SUBSCRIPTION`  | `[invoice.id]`                                                                |
| `FAILED_INVOICE_ACTIVE_SUBSCRIPTION`  | `[invoice.id]`                                                                |
| `STALE_INTERNAL_PENDING_PAYMENT`      | `[record.externalId]`                                                         |

Components are **identifiers**, never mutable values. Amounts, statuses and
timestamps are deliberately excluded (except in the duplicate rule, where the
amount is part of what defines the cluster's identity), so that a _changing_
amount updates the existing exception rather than creating a new one.

Two structural choices deserve explanation.

### Length-prefixed components

Joining components with a separator invites collisions whenever the separator can
appear in a value. Length-prefixing removes the question entirely: `("ab","c")`
encodes as `2:ab1:c` and `("a","bc")` as `1:a2:bc`. They cannot collide,
regardless of what characters the identifiers contain.

### The organization is the first component

Two tenants can legitimately hold the same Stripe object id — a shared platform
account, an imported fixture, the same test data. Including `organizationId` in
the hash means their fingerprints differ even when everything else matches, so
the unique index cannot cause one tenant's finding to suppress another's.

### The rule version is deliberately excluded

`RULE_VERSION` is recorded on the run **and** on the exception, but it is **not**
part of the fingerprint.

If it were, bumping the rule version — a routine act, done whenever a trigger
condition changes — would change **every** fingerprint in the system. The next
run would find no matching existing exception for anything, so it would:

- create a brand-new exception for every problem that was already open,
- orphan every existing exception, since nothing would ever re-detect the old
  fingerprint, so acknowledgements and assignments would be stranded on rows that
  never update again,
- fail to reopen anything, since a resolved exception's fingerprint would never
  be produced again,
- double the inbox overnight, with two entries per problem and no relationship
  between them.

Excluding the version means a rule-set upgrade lands quietly: the same problems
keep the same identity, their history and assignments survive, and the newer
`rule_version` value on the row records which version last observed them. If a
rule change genuinely alters _which_ problem is being described, that change
naturally alters the components too, and a new fingerprint is then correct.

## Consequences

**Good.**

- Repeated runs are idempotent. Verified: a second run over the demo dataset
  creates zero new exceptions (`docs/IMPLEMENTATION_STATUS.md`).
- Reopening works, in place, with history intact. `stateAfterRedetection` maps
  `resolved → reopened` and leaves active states alone, so re-detecting an open
  problem never resets an operator's acknowledgement.
- Deduplication is enforced by a **database constraint**, not by application
  logic. `persistCandidates` additionally uses `onConflictDoNothing` as a
  backstop, so even if the advisory lock were bypassed, a concurrent insert
  cannot fail an entire run.
- Rule-set upgrades do not disturb the inbox.
- The engine de-duplicates by fingerprint within a single run too, so a
  fingerprint produced twice cannot violate the constraint on insert.

**Costs.**

- **Fingerprint components are effectively a public API.** Changing them for an
  existing rule orphans that rule's open exceptions — the old fingerprint is
  never produced again, and a new one appears. Any such change needs a
  deliberate migration or a documented one-off cleanup.
- **Identity is tied to identifiers, so re-created records fragment history.** If
  an internal record is deleted and re-created with a new `external_id`, the
  rules that key on it produce a new fingerprint and a new exception; the old one
  must be resolved manually.
- **Resolved exceptions are never auto-closed.** If a problem is fixed, the
  candidate simply stops being produced and the existing exception sits
  untouched. That is intentional — a human should confirm a fix — but it means
  the inbox needs periodic operator attention rather than self-cleaning.
- SHA-256 hex is 64 characters per row: larger than an integer key, negligible in
  practice, and it makes fingerprints safe to log and compare directly.

## Alternatives considered

**Natural-key uniqueness (`org + rule + provider_id`).** Simpler, but it cannot
express rules with composite identity (the duplicate cluster) or rules with two
directions sharing one id (refund mismatch), and it would need a nullable column
per identifier shape.

**Including a hash of the evidence.** Rejected: evidence changes whenever an
amount moves, so every partial refund would create a new exception instead of
updating the existing one.

**Including the rule version.** Rejected for the reasons above — this is the
central decision of this ADR.
