# 0004 — Money representation

**Status:** Accepted

## Context

PayRecon's entire value proposition is telling a company that a number is wrong.
If PayRecon's own arithmetic is wrong, the product is worse than useless — it
manufactures false alarms and hides real ones.

IEEE-754 doubles cannot represent most decimal fractions exactly. `0.1 + 0.2`
is `0.30000000000000004`. Compounded across thousands of records, a
floating-point reconciliation engine invents differences that do not exist and
misses ones that do. JavaScript numbers are also only safe to
`Number.MAX_SAFE_INTEGER` (about 9.007e15) — comfortable for most currencies, but
not for high-volume totals in a currency like IDR or VND.

Currencies also disagree about what "a cent" is. JPY has no minor unit at all, so
an amount of `500` means ¥500, not ¥5.00. BHD, JOD, KWD, OMR and TND have three
minor digits. Stripe additionally requires three-decimal amounts to be multiples
of 10, and treats HUF, TWD and UGX as needing multiples of 100.

And two amounts in different currencies are simply not comparable without an
explicit, sourced exchange rate.

## Decision

**Money is an integer count of a currency's minor units, carried as `bigint`,
paired with an uppercase ISO-4217 code.**

- Database columns are `BIGINT`, with a `currency ~ '^[A-Z]{3}$'` check
  constraint alongside. An amount never exists without its currency; the
  `exceptions` table has an explicit check that revenue at risk requires a
  currency.
- All arithmetic lives in `packages/domain/src/money.ts` and is `bigint`
  throughout. No monetary value is ever converted to `number` for arithmetic.
- **Unlike currencies are never summed.** `addMoney`, `subtractMoney`,
  `compareMoney` and `absoluteDifference` all call `assertSameCurrency` and throw
  a `MoneyError` on mismatch. `MoneyBag` accumulates per-currency totals and
  **deliberately has no `.total()` method** — callers must iterate entries and
  render each currency separately.
- **No FX conversion in the MVP.** Where a rule spans currencies
  (`PAYMENT_CURRENCY_MISMATCH`), exposure is stated in the currency that actually
  settled and is never converted.
- Currency exponents are looked up from explicit sets: zero-decimal (JPY, KRW,
  VND, …), three-decimal (BHD, JOD, KWD, OMR, TND), otherwise two.
  `isValidStripeAmount` enforces Stripe's multiple-of-10 and multiple-of-100
  granularity rules.
- **Parsing refuses to guess.** `parseAmountMinor` accepts only an optional sign
  followed by digits — `"10.50"` in a field documented as minor units is
  ambiguous and is rejected, not coerced. `parseDecimalToMinor` rejects a value
  whose precision exceeds the currency's minor unit rather than rounding.
  `parseAmount` requires the caller to state the unit explicitly, which is why
  CSV import makes the operator declare whether a column holds minor units or a
  decimal.
- **Serialisation uses decimal strings.** `serializeAmountMinor` returns
  `toString(10)`, so a `bigint` never becomes an unsafe JavaScript number at an
  API boundary. `formatMoney` hands `Intl.NumberFormat` a bigint-backed decimal
  string rather than a float, so precision survives beyond
  `Number.MAX_SAFE_INTEGER`.
- **ESLint enforces this mechanically.** Inside `packages/domain/**`:
  `no-restricted-properties` bans `Math.round`, `Math.floor`, `Math.ceil` and
  `Number.parseFloat`; `no-restricted-globals` bans `parseFloat` and `parseInt`.
  Each carries a message pointing at the money helpers.

## Consequences

**Good.**

- Arithmetic is exact. A one-cent difference is a real one-cent difference.
- Large totals are safe: `bigint` has no upper bound.
- Zero-decimal and three-decimal currencies are handled correctly rather than
  approximately, which matters because getting them wrong produces exactly the
  100× and 1000× errors this product exists to detect.
- A cross-currency sum cannot be written by accident — it throws, and the type
  that would tempt you into it does not exist.
- The lint rule makes the invariant self-enforcing. A new contributor reaching for
  `Math.round` on an amount is stopped at the keyboard with an explanation, not in
  review.

**Costs.**

- `bigint` does not serialise to JSON natively, so every boundary must call
  `serializeAmountMinor` explicitly. Forgetting throws at runtime — noisy, but
  noisy is the right failure mode here.
- `bigint` and `number` cannot be mixed in an expression, which produces friction
  whenever a monetary value meets a count or a duration. That friction is the
  point: it marks exactly where a unit error would otherwise hide.
- The lint rule is **absolute**, with no exemption for non-monetary arithmetic
  inside the domain package. Rule 10 needs whole hours from a millisecond
  duration and uses `BigInt(age) / BigInt(HOUR_MS)` rather than `Math.floor`. An
  exemption would blunt the rule, and bigint division is exact and expresses the
  intent directly, so the cost is a comment rather than a workaround.
- drizzle-kit cannot serialise a `bigint` column default, so defaults are written
  as SQL literals (`.default(sql`0`)`) — discovered by a crash during migration
  generation.
- No FX means multi-currency customers see separate totals rather than one
  headline number. That is honest, and the alternative — an unsourced rate
  embedded in an exception — would be a fabrication in a product whose job is
  detecting fabricated numbers.

## Alternatives considered

**Floating point.** Rejected outright.

**PostgreSQL `NUMERIC` with a decimal library.** Exact, and it would carry the
scale in the database. Rejected because it needs a third-party decimal library on
the JavaScript side, is slower to compare and index, and — most importantly —
still leaves the "what is a minor unit for this currency?" question unanswered.
Minor units make the unit explicit at every layer.

**A `Money` value object everywhere, including the database.** `Money` exists in
the domain layer, but storing amounts as `BIGINT` + `TEXT` columns keeps SQL
queries, indexes and constraints straightforward, and lets the database enforce
non-negativity and currency format.
