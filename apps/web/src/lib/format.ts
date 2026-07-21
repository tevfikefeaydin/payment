import { formatMoney, toDecimalString } from "@payrecon/domain";

/**
 * Presentation helpers.
 *
 * Money always arrives here as bigint minor units plus a currency and is
 * formatted exactly — no value is ever converted to a float on the way to the
 * screen. There is deliberately no helper that sums across currencies.
 */

export function displayMoney(
  amountMinor: bigint | null | undefined,
  currency: string | null | undefined,
  locale = "en-US",
): string {
  if (amountMinor === null || amountMinor === undefined || !currency) return "—";
  return formatMoney(amountMinor, currency, locale);
}

/** Exact decimal rendering without a currency symbol, for dense table cells. */
export function displayAmount(
  amountMinor: bigint | null | undefined,
  currency: string | null | undefined,
): string {
  if (amountMinor === null || amountMinor === undefined || !currency) return "—";
  return `${toDecimalString(amountMinor, currency)} ${currency}`;
}

/**
 * Absolute timestamp rendered in the viewer's locale.
 * Stored values are UTC; only the rendering is localised.
 */
export function displayDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function displayDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/**
 * Coarse relative time ("3 hours ago"), used for freshness indicators where the
 * exact instant matters less than whether the data is stale.
 */
export function displayRelative(value: Date | string | null | undefined): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "unknown";

  const deltaMs = Date.now() - date.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Turn a rule id into a readable label: PAYMENT_AMOUNT_MISMATCH -> "Payment amount mismatch". */
export function displayRuleName(ruleId: string): string {
  const words = ruleId.toLowerCase().split("_");
  const [first, ...rest] = words;
  if (!first) return ruleId;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}
