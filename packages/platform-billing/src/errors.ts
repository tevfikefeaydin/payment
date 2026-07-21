/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * This package sells PayRecon subscriptions. It is NOT the customer data
 * integration: it never touches a customer's restricted key, their connection
 * rows, or any provider_* table, and revenue recorded here is PayRecon's
 * revenue — never a customer's reconciled operational revenue.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Error types for platform billing.
 *
 * Each failure mode gets its OWN class rather than a shared error with a
 * `code` string, because callers branch on them for very different reasons:
 * a webhook route must answer 400 for a bad signature but 500 for a database
 * failure, and matching on `instanceof` cannot drift the way a string can.
 *
 * Every message that could carry Stripe-supplied text is run through
 * `redactSecretsInText` before it is stored or surfaced. Stripe echoes request
 * parameters in some error messages, so an unsanitised message is a plausible
 * route for key material to reach a database row or a log line.
 */
import { redactSecretsInText } from "@payrecon/domain";

/**
 * Longest message we will persist. Billing error text is normally short; the
 * cap exists so a pathological upstream response cannot bloat a
 * `billing_webhook_events` row.
 */
const MAX_MESSAGE_LENGTH = 400;

/** Redact, collapse whitespace, and bound the length of any message we keep. */
export function sanitizeBillingMessage(message: string): string {
  const redacted = redactSecretsInText(message).replace(/\s+/g, " ").trim();
  if (redacted.length === 0) return "Billing operation failed with no message.";
  return redacted.length > MAX_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}…`
    : redacted;
}

/** Normalise anything thrown into a message that is safe to persist. */
export function sanitizeUnknownError(error: unknown): string {
  if (error instanceof Error) return sanitizeBillingMessage(error.message);
  if (typeof error === "string") return sanitizeBillingMessage(error);
  return "Billing operation failed with a non-Error value.";
}

/**
 * PayRecon's own Stripe account is not configured.
 *
 * Deliberately distinct from a request failure: the remedy is an operator
 * setting `PLATFORM_STRIPE_*`, not a retry. The message names variables only —
 * never a value — so it is safe to surface on an admin screen.
 */
export class BillingNotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `PayRecon platform billing is not configured. Missing or invalid: ${missing.join(", ")}. ` +
        `Values are never printed.`,
    );
    this.name = "BillingNotConfiguredError";
    this.missing = missing;
  }
}

/**
 * The request is well-formed but the server's plan/price configuration cannot
 * satisfy it — e.g. a purchasable plan whose price environment variable is
 * unset. Separate from `BillingNotConfiguredError` so a partially configured
 * deployment reports the specific plan rather than "billing is off".
 */
export class BillingConfigurationError extends Error {
  constructor(message: string) {
    super(sanitizeBillingMessage(message));
    this.name = "BillingConfigurationError";
  }
}

/**
 * The caller asked for something that does not exist or is not purchasable.
 * Safe to render to an end user.
 */
export class BillingRequestError extends Error {
  constructor(message: string) {
    super(sanitizeBillingMessage(message));
    this.name = "BillingRequestError";
  }
}
