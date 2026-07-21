/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * The client built here authenticates as PAYRECON and is used to sell PayRecon
 * subscriptions. It must never be pointed at, or confused with, a customer's
 * restricted read-only key (that lives in a different package, behind a
 * different environment variable, and is enforced by ESLint).
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Lazily-constructed Stripe client for PayRecon's own account.
 */
import Stripe from "stripe";
import { BillingNotConfiguredError } from "./errors";

/**
 * The ONLY environment variables this package may read for credentials.
 *
 * Named as constants so a grep for "which key does platform billing use?"
 * lands in one place, and so nothing here can accidentally reach for a
 * customer's key.
 */
export const PLATFORM_STRIPE_SECRET_KEY_VAR = "PLATFORM_STRIPE_SECRET_KEY";
export const PLATFORM_STRIPE_WEBHOOK_SECRET_VAR = "PLATFORM_STRIPE_WEBHOOK_SECRET";

/**
 * Pinned Stripe API version.
 *
 * Explicit rather than "whatever the account default is": the shapes this
 * package reads out of webhook payloads (where `current_period_end` lives, how
 * an invoice points at its subscription) changed between API versions, so an
 * account-level default flipping under us would silently corrupt subscription
 * state. Pinning to the literal also means a future SDK upgrade fails to
 * COMPILE rather than changing behaviour quietly — the version bump has to be
 * a deliberate, reviewed edit.
 */
export const PLATFORM_STRIPE_API_VERSION = "2026-06-24.dahlia" satisfies Stripe.LatestApiVersion;

/** Anything that can answer `env[name]`. Injectable so tests need no globals. */
export type BillingEnvSource = Readonly<Record<string, string | undefined>>;

function readVar(source: BillingEnvSource, name: string): string | null {
  const value = source[name];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * True when PayRecon's own billing is configured.
 *
 * Reads the two variables directly instead of calling `loadEnv()`, which
 * validates the ENTIRE application environment and throws when an unrelated
 * variable is missing. Billing readiness has to be answerable in isolation —
 * by a unit test, or by a health screen on a half-configured deployment. The
 * two variables checked here are exactly the pair `isPlatformBillingConfigured`
 * checks in @payrecon/config/env; they must stay in agreement.
 */
export function isBillingConfigured(source: BillingEnvSource = process.env): boolean {
  return (
    readVar(source, PLATFORM_STRIPE_SECRET_KEY_VAR) !== null &&
    readVar(source, PLATFORM_STRIPE_WEBHOOK_SECRET_VAR) !== null
  );
}

/**
 * The webhook signing secret.
 *
 * Returned rather than logged, and never included in an error message. The
 * only caller is signature verification.
 *
 * @throws {BillingNotConfiguredError} naming the variable, never its value.
 */
export function getWebhookSecret(source: BillingEnvSource = process.env): string {
  const secret = readVar(source, PLATFORM_STRIPE_WEBHOOK_SECRET_VAR);
  if (secret === null) throw new BillingNotConfiguredError([PLATFORM_STRIPE_WEBHOOK_SECRET_VAR]);
  return secret;
}

// ---------------------------------------------------------------------------
// Client port
// ---------------------------------------------------------------------------

/**
 * The Stripe surface this package actually uses — three creates and one
 * verifier — and nothing else.
 *
 * Why a narrow port instead of passing `Stripe` around: the default unit test
 * suite must run with no network and no live key, and satisfying the full
 * `Stripe` type in a fake would mean hand-building complete `Customer` and
 * `Session` objects. Narrowing also documents, in the type system, that
 * platform billing performs exactly these writes against PayRecon's account.
 *
 * Note there is no `subscriptions.*` or `prices.*` here: subscription state is
 * only ever learned from a SIGNED webhook, never from an unauthenticated read.
 */
export interface PlatformStripeClient {
  customers: {
    create(params: Stripe.CustomerCreateParams): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
    };
  };
}

/**
 * Compile-time proof that a real `Stripe` instance satisfies the port. If the
 * SDK changes a signature this fails to build here, at the boundary, rather
 * than at some call site deep in the webhook handler.
 */
const _assertRealClientSatisfiesPort = (stripe: Stripe): PlatformStripeClient => stripe;
void _assertRealClientSatisfiesPort;

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let cached: Stripe | null = null;

/**
 * Build (once) the Stripe client for PayRecon's OWN account.
 *
 * Constructed lazily so that importing this package — which the web app does
 * on every request path that renders a billing link — does not require billing
 * to be configured. A deployment with billing switched off must still boot.
 *
 * @throws {BillingNotConfiguredError} when `PLATFORM_STRIPE_SECRET_KEY` is unset.
 */
export function getPlatformStripeClient(source: BillingEnvSource = process.env): Stripe {
  if (cached) return cached;

  const secretKey = readVar(source, PLATFORM_STRIPE_SECRET_KEY_VAR);
  if (secretKey === null) throw new BillingNotConfiguredError([PLATFORM_STRIPE_SECRET_KEY_VAR]);

  cached = new Stripe(secretKey, {
    apiVersion: PLATFORM_STRIPE_API_VERSION,
    // Identifies PayRecon in Stripe's request logs. Non-sensitive.
    appInfo: { name: "PayRecon Platform Billing" },
    // Network blips on a checkout create are worth one automatic retry; more
    // than that and the operator should see the failure.
    maxNetworkRetries: 2,
  });
  return cached;
}

/** Reset the memoised client. Used by tests only. */
export function resetPlatformStripeClient(): void {
  cached = null;
}

/**
 * Resolve the client a service call should use: an injected one (tests, or a
 * caller that already holds a client) or the lazily built singleton.
 */
export function resolveStripeClient(
  injected: PlatformStripeClient | undefined,
  source: BillingEnvSource = process.env,
): PlatformStripeClient {
  return injected ?? getPlatformStripeClient(source);
}
