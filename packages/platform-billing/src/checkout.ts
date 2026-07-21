/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * These sessions charge a customer FOR PAYRECON. The customer record created
 * here lives in PayRecon's Stripe account and is unrelated to the customer's
 * own Stripe account, which this package must never touch.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Checkout and billing-portal session creation.
 *
 * Two rules govern both functions:
 *
 *  1. THE PRICE IS RESOLVED SERVER-SIDE. The caller passes a `PlanKey`, which
 *     is validated against `PLANS`; the Stripe price id is then looked up from
 *     environment configuration. Neither input type has a `priceId` field, so a
 *     browser cannot express one, and an extra property on a request body is
 *     simply never read. See plan-mapping.ts.
 *
 *  2. THE STRIPE CUSTOMER ID IS NEVER ACCEPTED FROM THE CALLER. It is looked up
 *     from `billing_customers` by organization, or created. Accepting one would
 *     let anyone who learned another tenant's customer id start a session
 *     against their billing account.
 */
import { PLANS, type PlanKey } from "@payrecon/config";
import { resolveStripeClient, type BillingEnvSource, type PlatformStripeClient } from "./client";
import { BillingConfigurationError, BillingRequestError } from "./errors";
import { isPurchasablePlan, priceIdForPlan } from "./plan-mapping";
import { resolveBillingStore, type BillingStore, type BillingStoreLike } from "./store";

/** Injectable seams. Present so tests need no network and no live key. */
export interface BillingSessionDeps {
  stripe?: PlatformStripeClient;
  env?: BillingEnvSource;
  now?: Date;
}

export interface CreateCheckoutSessionInput {
  organizationId: string;
  /**
   * Internal plan key. Validated against `PLANS` and exchanged for a price id
   * server-side. NOTE the absence of any `priceId`, `amount`, `currency` or
   * `customer` field — that absence is the security property.
   */
  planKey: PlanKey;
  successUrl: string;
  cancelUrl: string;
  /** Null for a system-initiated session. Recorded in the audit trail. */
  actorUserId: string | null;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
  planKey: PlanKey;
}

export interface CreatePortalSessionInput {
  organizationId: string;
  returnUrl: string;
  actorUserId: string | null;
}

export interface PortalSessionResult {
  url: string;
}

/**
 * Find or create the organization's customer in PAYRECON's Stripe account.
 *
 * The Stripe customer is created first and the row second: if the row write
 * fails we leak an unused Stripe customer, which is harmless and visible. The
 * other order would risk a row pointing at a customer that does not exist.
 * `insertBillingCustomerIfAbsent` absorbs the race between two concurrent
 * checkout clicks, and its return value — not the id we just created — is what
 * we use, so both racers converge on the same customer.
 */
async function ensureBillingCustomer(
  store: BillingStore,
  stripe: PlatformStripeClient,
  params: { organizationId: string; organizationName: string; now: Date },
): Promise<string> {
  const existing = await store.findBillingCustomerByOrganization(params.organizationId);
  if (existing) return existing.stripeCustomerId;

  const created = await stripe.customers.create({
    name: params.organizationName,
    // The organization id is the link back to our tenant. Set by the SERVER, so
    // a webhook can trust it as a hint — though the authoritative mapping stays
    // the `billing_customers` row, not this metadata.
    metadata: { organizationId: params.organizationId },
  });

  const row = await store.insertBillingCustomerIfAbsent({
    organizationId: params.organizationId,
    stripeCustomerId: created.id,
    now: params.now,
  });

  return row.stripeCustomerId;
}

/**
 * Start a Stripe Checkout session for a PayRecon plan.
 *
 * @throws {BillingRequestError} when the organization or plan is not valid.
 * @throws {BillingConfigurationError} when the plan has no configured price.
 */
export async function createCheckoutSession(
  db: BillingStoreLike,
  input: CreateCheckoutSessionInput,
  deps: BillingSessionDeps = {},
): Promise<CheckoutSessionResult> {
  const store = resolveBillingStore(db);
  const stripe = resolveStripeClient(deps.stripe, deps.env);
  const now = deps.now ?? new Date();

  const organization = await store.findOrganization(input.organizationId);
  if (!organization) {
    throw new BillingRequestError("Organization not found.");
  }

  // Validate the plan against the catalogue BEFORE touching Stripe. A key that
  // is not a real plan, or names the free tier, has nothing to sell.
  if (!(input.planKey in PLANS) || !isPurchasablePlan(input.planKey)) {
    throw new BillingRequestError(`Plan "${input.planKey}" is not available for purchase.`);
  }

  // The one and only place a price id enters this flow.
  const priceId = priceIdForPlan(input.planKey, deps.env);
  if (priceId === null) {
    throw new BillingConfigurationError(
      `No Stripe price is configured for plan "${input.planKey}".`,
    );
  }

  const customerId = await ensureBillingCustomer(store, stripe, {
    organizationId: input.organizationId,
    organizationName: organization.name,
    now,
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Server-set tenant markers. `client_reference_id` survives on the session
    // and the subscription metadata survives on every later subscription event,
    // which lets a webhook resolve the tenant even before the customer row is
    // readable.
    client_reference_id: input.organizationId,
    metadata: { organizationId: input.organizationId },
    subscription_data: { metadata: { organizationId: input.organizationId } },
  });

  if (!session.url) {
    throw new BillingConfigurationError("Stripe did not return a checkout URL.");
  }

  await store.recordAudit({
    organizationId: input.organizationId,
    actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId },
    action: "billing.checkout_started",
    targetType: "billing_checkout_session",
    targetId: session.id,
    // The plan is recorded; the price id is not needed downstream and the
    // secret key is of course never anywhere near this object.
    metadata: { planKey: input.planKey },
  });

  return { sessionId: session.id, url: session.url, planKey: input.planKey };
}

/**
 * Open Stripe's billing portal so the customer can manage payment methods,
 * invoices and cancellation themselves.
 *
 * Requires an existing billing customer: there is nothing to manage before the
 * first checkout, and creating one here would produce empty Stripe customers
 * for every organization that merely visited the billing screen.
 *
 * @throws {BillingRequestError} when the organization has never checked out.
 */
export async function createPortalSession(
  db: BillingStoreLike,
  input: CreatePortalSessionInput,
  deps: BillingSessionDeps = {},
): Promise<PortalSessionResult> {
  const store = resolveBillingStore(db);
  const stripe = resolveStripeClient(deps.stripe, deps.env);

  const organization = await store.findOrganization(input.organizationId);
  if (!organization) {
    throw new BillingRequestError("Organization not found.");
  }

  // Looked up by organization — never accepted from the caller.
  const customer = await store.findBillingCustomerByOrganization(input.organizationId);
  if (!customer) {
    throw new BillingRequestError(
      "This organization has no billing account yet. Start a subscription first.",
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customer.stripeCustomerId,
    return_url: input.returnUrl,
  });

  await store.recordAudit({
    organizationId: input.organizationId,
    actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId },
    action: "billing.portal_opened",
    targetType: "billing_customer",
    targetId: customer.id,
  });

  return { url: session.url };
}
