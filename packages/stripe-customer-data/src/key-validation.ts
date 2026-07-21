/**
 * Admission control for customer-supplied Stripe keys.
 *
 * READ-ONLY CONTEXT: no code path in @payrecon/stripe-customer-data performs a
 * Stripe write. Refusing anything but a restricted key is the first line of that
 * defence — a leaked or misused `rk_` key cannot create a charge, issue a refund,
 * or mutate the customer's account, so the blast radius of a compromise here is
 * bounded to reading data the customer already agreed to share.
 *
 * The candidate key is never echoed. No branch below copies the supplied value
 * into a return value, an error message, a thrown object, or a log line. Callers
 * that must show something to an operator use `keyKindOf` and `keyLastFour`,
 * which reveal only the non-secret prefix and the trailing four characters.
 */
import { PublicError } from "@payrecon/domain";

export type StripeKeyRejectionReason = "empty" | "secret_key" | "publishable_key" | "malformed";

export type StripeKeyClassification =
  | { ok: true; kind: "restricted"; livemode: boolean }
  | { ok: false; reason: StripeKeyRejectionReason; message: string };

/**
 * A minimum body length is required in addition to the prefix so that a
 * truncated paste such as "rk_live_" is rejected as malformed rather than
 * accepted and then failing opaquely at the first API call.
 */
const RESTRICTED_KEY = /^rk_(test|live)_[A-Za-z0-9]{8,}$/;
const SECRET_KEY = /^sk_(test|live)_/;
const PUBLISHABLE_KEY = /^pk_(test|live)_/;

/** Stable, non-leaking rejection messages, one per reason. */
const REJECTION_MESSAGES: Record<StripeKeyRejectionReason, string> = {
  empty: "A Stripe restricted key is required.",
  secret_key:
    "That is a Stripe secret key. PayRecon only accepts restricted keys (rk_test_… or rk_live_…) " +
    "because a secret key would allow writes to your Stripe account. Create a restricted key with " +
    "read-only permissions and submit that instead.",
  publishable_key:
    "That is a Stripe publishable key. Publishable keys cannot read your payment data. " +
    "Create a restricted key (rk_test_… or rk_live_…) with read-only permissions and submit that instead.",
  malformed:
    "That is not a recognised Stripe restricted key. A restricted key begins with rk_test_ or rk_live_ " +
    "followed by the key body. Copy the whole value from the Stripe dashboard.",
};

/** Machine-readable error codes, distinct per reason so clients can branch. */
const REJECTION_CODES: Record<StripeKeyRejectionReason, string> = {
  empty: "stripe_key_empty",
  secret_key: "stripe_key_secret",
  publishable_key: "stripe_key_publishable",
  malformed: "stripe_key_malformed",
};

/**
 * Trim a pasted key.
 *
 * Clipboard pastes routinely carry a trailing newline or space. Trimming here —
 * rather than in each caller — means the value that is classified is byte-for-byte
 * the value that gets encrypted.
 */
export function normalizeStripeKey(key: string): string {
  return key.trim();
}

/**
 * Classify a candidate key without throwing.
 *
 * The return value deliberately carries no reference to the input, so it is safe
 * to log, serialise into an audit event, or return to a browser.
 */
export function classifyStripeKey(key: string): StripeKeyClassification {
  const candidate = normalizeStripeKey(key);

  if (candidate.length === 0) return reject("empty");

  const restricted = RESTRICTED_KEY.exec(candidate);
  if (restricted) {
    return { ok: true, kind: "restricted", livemode: restricted[1] === "live" };
  }

  // Ordered most-specific first: a secret key and a publishable key each get a
  // message that explains the actual problem, rather than a generic "invalid".
  if (SECRET_KEY.test(candidate)) return reject("secret_key");
  if (PUBLISHABLE_KEY.test(candidate)) return reject("publishable_key");
  return reject("malformed");
}

function reject(reason: StripeKeyRejectionReason): StripeKeyClassification {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

/** True when the key is a restricted key. Convenience over `classifyStripeKey`. */
export function isRestrictedKey(key: string): boolean {
  return classifyStripeKey(key).ok;
}

/**
 * Assert that a key is a restricted key, or throw a message that is safe to show
 * to the user. Called before any network use and before any encryption, so an
 * unacceptable key never reaches Stripe or the database.
 */
export function assertRestrictedKey(key: string): { kind: "restricted"; livemode: boolean } {
  const result = classifyStripeKey(key);
  if (result.ok) return { kind: result.kind, livemode: result.livemode };
  throw new PublicError(REJECTION_CODES[result.reason], result.message, 400);
}

/** Non-secret prefix recorded alongside a stored credential, e.g. "rk_live". */
export function keyKindOf(livemode: boolean): "rk_live" | "rk_test" {
  return livemode ? "rk_live" : "rk_test";
}

/**
 * The trailing four characters, for operator recognition. Never more: the
 * database enforces this too via a length check on `key_last_four`.
 */
export function keyLastFour(key: string): string {
  return normalizeStripeKey(key).slice(-4);
}
