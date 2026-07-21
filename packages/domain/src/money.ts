/**
 * Exact monetary arithmetic.
 *
 * INVARIANT: money is always an integer count of a currency's minor units,
 * carried as a `bigint`, paired with an uppercase ISO-4217 code. No value in
 * this module is ever converted to `number` for arithmetic, and no
 * floating-point operation is performed on a monetary quantity. Unlike
 * currencies are never summed.
 *
 * See docs/adr/0004-money-representation.md.
 */

/**
 * Currencies Stripe treats as having no minor unit: the smallest unit IS the
 * major unit. An "amount" of 500 JPY means ¥500, not ¥5.00.
 * Source: Stripe zero-decimal currency list.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/**
 * Currencies with three minor-unit digits. Stripe additionally requires the
 * amount to be a multiple of 10 for these, which `assertStripeAmountValid`
 * checks.
 */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/**
 * Currencies Stripe presents as zero-decimal but which must be a multiple of
 * 100 when used as a payout/charge amount.
 */
const HUNDRED_MULTIPLE_CURRENCIES = new Set(["HUF", "TWD", "UGX"]);

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** A monetary amount in exact minor units. */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * Normalise and validate a currency code.
 * Accepts any case; always returns uppercase.
 */
export function normalizeCurrency(input: string): string {
  const code = input.trim().toUpperCase();
  if (!CURRENCY_PATTERN.test(code)) {
    throw new MoneyError(
      `Invalid currency code: expected three letters, received ${JSON.stringify(input)}`,
    );
  }
  return code;
}

export function isValidCurrency(input: string): boolean {
  try {
    normalizeCurrency(input);
    return true;
  } catch {
    return false;
  }
}

/** Number of decimal digits in the currency's minor unit (0, 2 or 3). */
export function currencyExponent(currency: string): number {
  const code = normalizeCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function isZeroDecimalCurrency(currency: string): boolean {
  return currencyExponent(currency) === 0;
}

/** Construct a Money value, validating the currency. */
export function money(amountMinor: bigint, currency: string): Money {
  return { amountMinor, currency: normalizeCurrency(currency) };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Refusing to combine unlike currencies: ${a.currency} and ${b.currency}. ` +
        `Totals must be reported per currency.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negateMoney(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function absMoney(a: Money): Money {
  return { amountMinor: a.amountMinor < 0n ? -a.amountMinor : a.amountMinor, currency: a.currency };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZeroMoney(a: Money): boolean {
  return a.amountMinor === 0n;
}

/** Absolute difference between two amounts of the SAME currency. */
export function absoluteDifference(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const diff = a.amountMinor - b.amountMinor;
  return { amountMinor: diff < 0n ? -diff : diff, currency: a.currency };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a string that already expresses an amount in MINOR units.
 *
 * Strict on purpose: only an optional sign followed by digits is accepted.
 * A decimal point is rejected, because a value like "10.50" in a field
 * documented as minor units is ambiguous and must not be silently coerced.
 */
export function parseAmountMinor(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new MoneyError("Amount is required");
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MoneyError(
      `Invalid minor-unit amount ${JSON.stringify(input)}: expected an integer number of ` +
        `minor units (for example "1050" for $10.50). Decimal points are not accepted here.`,
    );
  }
  return BigInt(trimmed);
}

/**
 * Parse a human decimal string ("10.50", "-3", "1,234.56") into minor units for
 * a specific currency, without floating point.
 *
 * Rejects values whose precision exceeds the currency's minor unit rather than
 * rounding, so that ambiguous money is never silently coerced.
 */
export function parseDecimalToMinor(input: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  let s = input.trim();
  if (s.length === 0) throw new MoneyError("Amount is required");

  // Accept thousands separators only in the integer part, and only when they
  // are consistently placed; simply removing them is safe after the shape check.
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    s = s.replace(/,/g, "");
  }

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) {
    throw new MoneyError(
      `Invalid decimal amount ${JSON.stringify(input)}: expected a plain number such as "10.50".`,
    );
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";

  if (fraction.length > exponent) {
    // Trailing zeros beyond the exponent are harmless and can be dropped.
    const significant = fraction.slice(exponent);
    if (/[^0]/.test(significant)) {
      throw new MoneyError(
        `Amount ${JSON.stringify(input)} has more precision than ${normalizeCurrency(currency)} ` +
          `supports (${exponent} decimal places). Refusing to round.`,
      );
    }
  }

  const paddedFraction = fraction.padEnd(exponent, "0").slice(0, exponent);
  const digits = `${whole}${paddedFraction}`;
  return sign * BigInt(digits);
}

/**
 * Parse an amount where the unit is declared by the caller. Used by CSV import,
 * where the operator explicitly states whether a column holds minor units or a
 * decimal major-unit value.
 */
export type AmountUnit = "minor" | "decimal";

export function parseAmount(input: string, currency: string, unit: AmountUnit): bigint {
  return unit === "minor" ? parseAmountMinor(input) : parseDecimalToMinor(input, currency);
}

// ---------------------------------------------------------------------------
// Serialisation and formatting
// ---------------------------------------------------------------------------

/**
 * Serialise minor units for transport. Always a decimal STRING so that a
 * bigint never becomes an unsafe JavaScript number at an API boundary.
 */
export function serializeAmountMinor(amountMinor: bigint): string {
  return amountMinor.toString(10);
}

/** Convert minor units to a plain decimal string, e.g. 1050n USD -> "10.50". */
export function toDecimalString(amountMinor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return amountMinor.toString(10);

  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString(10).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Locale-aware display string, e.g. "$10.50".
 *
 * Formatting happens on the exact decimal string, so no precision is lost for
 * amounts beyond Number.MAX_SAFE_INTEGER: `Intl.NumberFormat` is given a
 * bigint-backed string rather than a float.
 */
export function formatMoney(amountMinor: bigint, currency: string, locale = "en-US"): string {
  const code = normalizeCurrency(currency);
  const exponent = currencyExponent(code);
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    // Intl accepts a string for exact decimal formatting of large values.
    return formatter.format(toDecimalString(amountMinor, code) as unknown as number);
  } catch {
    // Unknown/unsupported ISO code: fall back to an unambiguous plain rendering.
    return `${toDecimalString(amountMinor, code)} ${code}`;
  }
}

export function formatMoneyValue(value: Money, locale = "en-US"): string {
  return formatMoney(value.amountMinor, value.currency, locale);
}

// ---------------------------------------------------------------------------
// Stripe amount validation
// ---------------------------------------------------------------------------

/**
 * Validate an amount against Stripe's per-currency granularity rules.
 * Used when normalising synced provider data so that impossible values are
 * surfaced instead of silently reconciled.
 */
export function isValidStripeAmount(amountMinor: bigint, currency: string): boolean {
  const code = normalizeCurrency(currency);
  if (THREE_DECIMAL_CURRENCIES.has(code) && amountMinor % 10n !== 0n) return false;
  if (HUNDRED_MULTIPLE_CURRENCIES.has(code) && amountMinor % 100n !== 0n) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Multi-currency totals
// ---------------------------------------------------------------------------

/**
 * A set of per-currency totals.
 *
 * The specification forbids presenting a single combined total across
 * currencies, so there is deliberately no `.total()` method: callers must
 * iterate entries and render each currency separately.
 */
export class MoneyBag {
  private readonly totals = new Map<string, bigint>();

  static from(values: Iterable<Money>): MoneyBag {
    const bag = new MoneyBag();
    for (const value of values) bag.add(value);
    return bag;
  }

  add(value: Money): this {
    const currency = normalizeCurrency(value.currency);
    this.totals.set(currency, (this.totals.get(currency) ?? 0n) + value.amountMinor);
    return this;
  }

  addAmount(amountMinor: bigint, currency: string): this {
    return this.add({ amountMinor, currency });
  }

  get(currency: string): bigint {
    return this.totals.get(normalizeCurrency(currency)) ?? 0n;
  }

  currencies(): string[] {
    return [...this.totals.keys()].sort();
  }

  isEmpty(): boolean {
    return this.totals.size === 0;
  }

  /** Entries sorted by currency code for stable rendering and snapshots. */
  entries(): Money[] {
    return this.currencies().map((currency) => ({
      currency,
      amountMinor: this.totals.get(currency) ?? 0n,
    }));
  }

  /** Entries with amounts serialised as decimal strings, for API responses. */
  toJSON(): Array<{ currency: string; amountMinor: string }> {
    return this.entries().map((entry) => ({
      currency: entry.currency,
      amountMinor: serializeAmountMinor(entry.amountMinor),
    }));
  }

  merge(other: MoneyBag): this {
    for (const entry of other.entries()) this.add(entry);
    return this;
  }
}
