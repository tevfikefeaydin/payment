/**
 * Error normalisation for the READ-ONLY customer Stripe integration.
 *
 * Nothing in this package performs a Stripe write, so every error handled here
 * originates from a list or retrieve call. The point of this module is to answer
 * one question the sync loop needs: *is retrying this worth doing?* Retrying an
 * expired key forever burns rate-limit budget and hides a real operator problem;
 * giving up on a 503 loses data that would have arrived a second later.
 *
 * Every message is passed through `redactSecretsInText` before it is stored or
 * surfaced. Stripe echoes request parameters in some error messages, and a
 * careless upstream change could otherwise put key material into `sync_runs`.
 */
import { redactSecretsInText } from "@payrecon/domain";

export type StripeErrorCategory =
  "auth" | "permission" | "rate_limited" | "transient" | "permanent";

/** Categories worth retrying. Everything else needs an operator, not a retry. */
const RETRYABLE: ReadonlySet<StripeErrorCategory> = new Set<StripeErrorCategory>([
  "rate_limited",
  "transient",
]);

export function isRetryableCategory(category: StripeErrorCategory): boolean {
  return RETRYABLE.has(category);
}

/**
 * Longest message we will persist. Stripe error text is normally short; the cap
 * exists so a pathological upstream response cannot bloat a `sync_runs` row.
 */
const MAX_MESSAGE_LENGTH = 400;

export interface StripeSyncErrorOptions {
  statusCode?: number | null;
  /** Stripe's own error type, e.g. "StripeRateLimitError". Non-sensitive. */
  stripeErrorType?: string | null;
  cause?: unknown;
}

/**
 * The only error type this package throws outward from a transport call.
 *
 * `category` — not the message — drives retry and run-status decisions, so
 * behaviour never depends on matching human-readable text.
 */
export class StripeSyncError extends Error {
  readonly category: StripeErrorCategory;
  readonly statusCode: number | null;
  readonly stripeErrorType: string | null;

  constructor(
    category: StripeErrorCategory,
    message: string,
    options: StripeSyncErrorOptions = {},
  ) {
    super(sanitizeMessage(message));
    this.name = "StripeSyncError";
    this.category = category;
    this.statusCode = options.statusCode ?? null;
    this.stripeErrorType = options.stripeErrorType ?? null;
    if (options.cause !== undefined) {
      // Retained for local debugging only. Nothing serialises `cause`.
      this.cause = options.cause;
    }
  }

  get retryable(): boolean {
    return isRetryableCategory(this.category);
  }
}

/** Redact, collapse whitespace, and bound the length of any message we keep. */
export function sanitizeMessage(message: string): string {
  const redacted = redactSecretsInText(message).replace(/\s+/g, " ").trim();
  if (redacted.length === 0) return "Stripe returned an error with no message.";
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

/**
 * Node/undici socket-level failures. These are always worth retrying: the
 * request never reached Stripe, so re-issuing it cannot double-apply anything
 * (and could not even if it did, since every call is a read).
 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Stripe SDK error type names, mapped to how we treat them. */
const STRIPE_TYPE_CATEGORIES: Readonly<Record<string, StripeErrorCategory>> = {
  StripeAuthenticationError: "auth",
  StripePermissionError: "permission",
  StripeRateLimitError: "rate_limited",
  StripeConnectionError: "transient",
  StripeAPIError: "transient",
  StripeInvalidRequestError: "permanent",
  StripeCardError: "permanent",
  StripeIdempotencyError: "permanent",
  StripeSignatureVerificationError: "permanent",
};

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringProperty(value: unknown, key: string): string | null {
  const found = property(value, key);
  return typeof found === "string" && found.length > 0 ? found : null;
}

function numberProperty(value: unknown, key: string): number | null {
  const found = property(value, key);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function categoryForStatus(status: number): StripeErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limited";
  // 408 and 409 are worth another attempt; both describe a momentary condition.
  if (status === 408 || status === 409) return "transient";
  if (status >= 500) return "transient";
  return "permanent";
}

/**
 * Normalise anything thrown by the transport into a `StripeSyncError`.
 *
 * Precedence is deliberate: an explicit HTTP status is the most reliable signal,
 * then the SDK's error class name, then a socket error code. An unrecognised
 * value is treated as PERMANENT rather than transient — a bug in our own
 * normalisation code must fail loudly on the first attempt instead of being
 * retried four times and then reported as a Stripe outage.
 */
export function classifyStripeError(err: unknown): StripeSyncError {
  if (err instanceof StripeSyncError) return err;

  const statusCode = numberProperty(err, "statusCode") ?? numberProperty(err, "status");
  const stripeErrorType = stringProperty(err, "type");
  const errorCode = stringProperty(err, "code");
  const rawMessage =
    (err instanceof Error ? err.message : null) ??
    stringProperty(err, "message") ??
    "Stripe request failed.";

  if (statusCode !== null) {
    return new StripeSyncError(categoryForStatus(statusCode), rawMessage, {
      statusCode,
      stripeErrorType,
      cause: err,
    });
  }

  if (stripeErrorType !== null && stripeErrorType in STRIPE_TYPE_CATEGORIES) {
    const category = STRIPE_TYPE_CATEGORIES[stripeErrorType] ?? "permanent";
    return new StripeSyncError(category, rawMessage, { stripeErrorType, cause: err });
  }

  if (errorCode !== null && NETWORK_ERROR_CODES.has(errorCode)) {
    return new StripeSyncError("transient", rawMessage, {
      stripeErrorType: errorCode,
      cause: err,
    });
  }

  return new StripeSyncError("permanent", rawMessage, { stripeErrorType, cause: err });
}

/**
 * A message safe to show an operator for a resource that could not be read.
 *
 * Auth and permission failures deliberately omit Stripe's own text: it can name
 * the exact API route and permission, which is more detail than a connection
 * form should surface. The remedy is the same in every case, so the fixed
 * wording loses nothing actionable.
 */
export function describeCategory(category: StripeErrorCategory): string {
  switch (category) {
    case "auth":
      return "Stripe rejected the restricted key. It may have been revoked or rotated.";
    case "permission":
      return "The restricted key does not grant read access to this resource.";
    case "rate_limited":
      return "Stripe rate-limited the request. PayRecon will retry automatically.";
    case "transient":
      return "Stripe was temporarily unavailable. PayRecon will retry automatically.";
    case "permanent":
      return "Stripe rejected the request and retrying will not help.";
  }
}
