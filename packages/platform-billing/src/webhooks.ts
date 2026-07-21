/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * These webhooks are signed by PAYRECON's Stripe account and describe PayRecon
 * subscriptions. They are a completely separate stream from anything read out
 * of a customer's own Stripe account, verified with a different secret
 * (`PLATFORM_STRIPE_WEBHOOK_SECRET`), and they never write a provider_* table.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Signature verification and idempotent, order-tolerant event processing.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. AUTHENTICITY — nothing is applied that was not signed by Stripe.
 *  2. IDEMPOTENCY  — a redelivered event applies exactly once.
 *  3. ORDER TOLERANCE — webhooks arrive out of order; an older event must
 *     never overwrite newer subscription state.
 */
import { DEFAULT_PLAN, type PlanKey } from "@payrecon/config";
import { billingSubscriptionStatusEnum } from "@payrecon/db/schema";
import { getPlatformStripeClient, getWebhookSecret, type BillingEnvSource } from "./client";
import { sanitizeBillingMessage, sanitizeUnknownError } from "./errors";
import { statusIsEntitled } from "./entitlements";
import { planForPriceId } from "./plan-mapping";
import {
  resolveBillingStore,
  type BillingStore,
  type BillingStoreLike,
  type BillingSubscriptionRecord,
  type BillingSubscriptionStatus,
} from "./store";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Signature verification failed.
 *
 * A DISTINCT type because the HTTP response differs from every other failure:
 * a bad signature is a permanent 400 (Stripe must not retry — retrying an
 * unverifiable payload can never succeed), whereas a database failure is a 500
 * that Stripe SHOULD retry. The message never echoes the payload or the secret.
 */
export class WebhookSignatureError extends Error {
  constructor(message = "Stripe webhook signature verification failed.") {
    super(sanitizeBillingMessage(message));
    this.name = "WebhookSignatureError";
  }
}

/** The signature verified but the envelope is not a usable Stripe event. */
export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(sanitizeBillingMessage(message));
    this.name = "WebhookPayloadError";
  }
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

/**
 * The slice of a Stripe event this package reads.
 *
 * Deliberately NOT `Stripe.Event`. That type is a union of 260 event-specific
 * interfaces, each demanding a complete resource object, so a hand-written
 * fixture could not satisfy it without inventing dozens of irrelevant fields —
 * and the test suite has to run with no live Stripe account. Narrowing at the
 * boundary also means an SDK upgrade that reshapes some unrelated resource
 * cannot ripple into the persistence logic below. A real `Stripe.Event` is
 * structurally assignable to this.
 */
export interface BillingEvent {
  id: string;
  type: string;
  /** Stripe's creation time, in SECONDS since the epoch. */
  created: number;
  data: { object: unknown };
}

/** Event types this package acts on. Anything else is recorded and ignored. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

const HANDLED: ReadonlySet<string> = new Set<string>(HANDLED_EVENT_TYPES);

export function isHandledEventType(type: string): boolean {
  return HANDLED.has(type);
}

// ---------------------------------------------------------------------------
// Defensive payload readers
// ---------------------------------------------------------------------------
//
// Everything below treats the payload as `unknown` and narrows explicitly. The
// payload is signed, so it is authentic — but "authentic" is not "the shape I
// expected": Stripe adds fields, moves them between API versions, and replays
// old events rendered against the API version that was current when they were
// created. A cast would turn any of those into a runtime crash inside a
// database write.

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(source: Record<string, unknown> | null, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

/** Stripe references are either a bare id or an expanded object with an `id`. */
function readReferenceId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return readString(asRecord(value), "id");
}

/** Unix seconds → Date. Null-safe, because most of these fields are nullable. */
function toDate(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(seconds * 1000);
}

function readMetadataOrganizationId(source: Record<string, unknown> | null): string | null {
  return readString(asRecord(source?.metadata), "organizationId");
}

const SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set<string>(
  billingSubscriptionStatusEnum.enumValues,
);

function toSubscriptionStatus(value: string | null): BillingSubscriptionStatus | null {
  if (value === null || !SUBSCRIPTION_STATUSES.has(value)) return null;
  return value as BillingSubscriptionStatus;
}

/**
 * Normalise anything into the event envelope.
 *
 * Accepts `unknown` because the verifier is injectable: in production it is the
 * Stripe SDK and returns a real event, but a test double returns whatever the
 * fixture says.
 */
export function toBillingEvent(value: unknown): BillingEvent {
  const record = asRecord(value);
  const id = readString(record, "id");
  const type = readString(record, "type");
  const created = readNumber(record, "created");
  const data = asRecord(record?.data);

  if (id === null || type === null || created === null || data === null) {
    throw new WebhookPayloadError("Stripe event is missing id, type, created or data.");
  }

  return { id, type, created, data: { object: data.object } };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verifies a signature against a raw body and returns the parsed event.
 *
 * Production is `stripe.webhooks.constructEvent`; tests inject their own.
 */
export type SignatureVerifier = (
  rawBody: string | Buffer,
  signature: string,
  secret: string,
) => unknown;

export interface VerifyOptions {
  verifier?: SignatureVerifier;
  env?: BillingEnvSource;
  /** Explicit secret, otherwise read from `PLATFORM_STRIPE_WEBHOOK_SECRET`. */
  webhookSecret?: string;
}

/**
 * Verify a Stripe webhook signature and parse the event.
 *
 * ============================================================================
 * THE BODY MUST BE THE RAW BYTES, EXACTLY AS RECEIVED.
 * ============================================================================
 *
 * The signature is an HMAC over the literal request body. Any of the following
 * silently invalidates it, and all of them are easy to do by accident in a
 * framework route:
 *
 *   - `JSON.parse` followed by `JSON.stringify` (key order, whitespace and
 *     number formatting are all free to change),
 *   - reading the body through a JSON body-parser middleware and re-encoding,
 *   - transcoding the bytes to a different character encoding,
 *   - pretty-printing or trimming.
 *
 * So the route must capture `await request.text()` / the raw Buffer BEFORE
 * anything parses it, and hand that same value here. If verification suddenly
 * fails for every event in a working deployment, a re-serialising body parser
 * is the first thing to look at.
 *
 * @throws {WebhookSignatureError} on an invalid or missing signature.
 * @throws {WebhookPayloadError}   when the verified payload is not an event.
 */
export function verifyAndParse(
  rawBody: string | Buffer,
  signature: string,
  options: VerifyOptions = {},
): BillingEvent {
  if (typeof signature !== "string" || signature.length === 0) {
    throw new WebhookSignatureError("Missing Stripe-Signature header.");
  }

  const secret = options.webhookSecret ?? getWebhookSecret(options.env);
  const verifier: SignatureVerifier =
    options.verifier ??
    ((body, sig, key) =>
      getPlatformStripeClient(options.env).webhooks.constructEvent(body, sig, key));

  let verified: unknown;
  try {
    verified = verifier(rawBody, signature, secret);
  } catch (error) {
    // Stripe's own error text is discarded rather than forwarded: it can echo
    // parts of the payload, and the only actionable fact is "not authentic".
    throw new WebhookSignatureError(
      `Stripe webhook signature verification failed (${sanitizeUnknownError(error)}).`,
    );
  }

  return toBillingEvent(verified);
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export interface ProcessEventDeps {
  env?: BillingEnvSource;
  now?: Date;
}

export type ProcessEventResult =
  | {
      status: "processed";
      stripeEventId: string;
      organizationId: string;
      planKey: PlanKey;
      subscriptionStatus: BillingSubscriptionStatus | null;
    }
  /** Already applied. The caller should answer 2xx so Stripe stops retrying. */
  | { status: "duplicate"; stripeEventId: string }
  /** Superseded by newer state. Also a 2xx: replaying it will never help. */
  | { status: "ignored_stale"; stripeEventId: string }
  | { status: "ignored_unhandled"; stripeEventId: string; type: string }
  /** Could not be tied to a tenant. Recorded for an operator; still a 2xx. */
  | { status: "ignored_unmapped"; stripeEventId: string; type: string }
  /**
   * Something went wrong applying it. The caller SHOULD answer non-2xx so that
   * Stripe redelivers — the receipt row is left `failed`, which is what allows
   * the redelivery to be reprocessed rather than dismissed as a duplicate.
   */
  | { status: "failed"; stripeEventId: string; message: string };

/**
 * Statuses of an existing receipt that mean "already decided".
 *
 * `received` and `failed` are deliberately absent: the first means a previous
 * attempt died mid-flight, the second that it errored. Both should be retried
 * when Stripe redelivers, and doing so is safe because every write below is
 * idempotent and guarded by the ordering check.
 */
const TERMINAL_RECEIPT_STATUSES: ReadonlySet<string> = new Set<string>(["processed", "ignored"]);

/**
 * Apply one verified Stripe event.
 *
 * Never throws for an expected condition; returns a discriminated result so the
 * route can choose the HTTP status deliberately. See `ProcessEventResult`.
 */
export async function processEvent(
  db: BillingStoreLike,
  event: BillingEvent,
  deps: ProcessEventDeps = {},
): Promise<ProcessEventResult> {
  const store = resolveBillingStore(db);
  const now = deps.now ?? new Date();
  const eventCreatedAt = new Date(event.created * 1000);

  // ---- 1. Durable receipt, and the idempotency gate -----------------------
  //
  // The unique index on `stripe_event_id` is the whole mechanism: whichever
  // delivery inserts the row first owns the work, and any other delivery of the
  // same event id sees `created: false`.
  const claim = await store.claimWebhookEvent({
    stripeEventId: event.id,
    type: event.type,
    organizationId: null, // resolved below, once the payload has been read
    eventCreatedAt,
  });

  if (!claim.created && claim.existing && TERMINAL_RECEIPT_STATUSES.has(claim.existing.status)) {
    return { status: "duplicate", stripeEventId: event.id };
  }

  if (!isHandledEventType(event.type)) {
    await store.markWebhookEvent(event.id, { status: "ignored", processedAt: now });
    return { status: "ignored_unhandled", stripeEventId: event.id, type: event.type };
  }

  try {
    return await applyEvent(store, event, eventCreatedAt, now, deps.env);
  } catch (error) {
    const message = sanitizeUnknownError(error);
    await store.markWebhookEvent(event.id, { status: "failed", errorMessage: message });
    return { status: "failed", stripeEventId: event.id, message };
  }
}

async function applyEvent(
  store: BillingStore,
  event: BillingEvent,
  eventCreatedAt: Date,
  now: Date,
  env: BillingEnvSource | undefined,
): Promise<ProcessEventResult> {
  switch (event.type) {
    case "checkout.session.completed":
      return applyCheckoutCompleted(store, event, now);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscriptionEvent(store, event, eventCreatedAt, now, env);
    case "invoice.paid":
      return applyInvoiceOutcome(store, event, eventCreatedAt, now, "paid");
    case "invoice.payment_failed":
      return applyInvoiceOutcome(store, event, eventCreatedAt, now, "failed");
    default:
      await store.markWebhookEvent(event.id, { status: "ignored", processedAt: now });
      return { status: "ignored_unhandled", stripeEventId: event.id, type: event.type };
  }
}

/**
 * Resolve the tenant an event belongs to.
 *
 * Order matters. The `billing_customers` row is OUR OWN mapping and is
 * authoritative; event metadata is only a hint, and is used solely as a
 * fallback for the window before that row exists (a checkout completed by a
 * flow that created the Stripe customer out of band). Even then the id is
 * checked against a real organization, so a metadata value can only ever
 * select an existing tenant — never conjure one.
 */
async function resolveOrganizationId(
  store: BillingStore,
  params: { stripeCustomerId: string | null; metadataOrganizationId: string | null },
): Promise<string | null> {
  if (params.stripeCustomerId !== null) {
    const customer = await store.findBillingCustomerByStripeId(params.stripeCustomerId);
    if (customer) return customer.organizationId;
  }

  if (params.metadataOrganizationId !== null) {
    const organization = await store.findOrganization(params.metadataOrganizationId);
    if (organization) return organization.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

/**
 * Bind the Stripe customer to the organization.
 *
 * Deliberately does NOT set subscription state. A completed checkout says a
 * payment method was accepted; the authoritative subscription — its status,
 * price, and period — arrives moments later as `customer.subscription.created`,
 * and reading it out of the session too would be a second, racier source of
 * truth for the same fact.
 */
async function applyCheckoutCompleted(
  store: BillingStore,
  event: BillingEvent,
  now: Date,
): Promise<ProcessEventResult> {
  const session = asRecord(event.data.object);
  const stripeCustomerId = readReferenceId(session?.customer);
  // `client_reference_id` is set by createCheckoutSession — server-side.
  const referencedOrganizationId =
    readString(session, "client_reference_id") ?? readMetadataOrganizationId(session);

  const organizationId = await resolveOrganizationId(store, {
    stripeCustomerId,
    metadataOrganizationId: referencedOrganizationId,
  });

  if (organizationId === null) {
    await store.markWebhookEvent(event.id, {
      status: "ignored",
      processedAt: now,
      errorMessage: "Checkout session could not be tied to an organization.",
    });
    return { status: "ignored_unmapped", stripeEventId: event.id, type: event.type };
  }

  if (stripeCustomerId !== null) {
    // Idempotent, and converges when two flows raced to create the row.
    await store.insertBillingCustomerIfAbsent({ organizationId, stripeCustomerId, now });
  }

  const existing = await store.findSubscriptionByOrganization(organizationId);

  await store.markWebhookEvent(event.id, { status: "processed", organizationId, processedAt: now });
  await store.recordAudit({
    organizationId,
    actor: { type: "system" },
    action: "billing.subscription_changed",
    targetType: "billing_customer",
    targetId: stripeCustomerId,
    metadata: { reason: "checkout_completed", eventType: event.type },
  });

  return {
    status: "processed",
    stripeEventId: event.id,
    organizationId,
    planKey: existing?.planKey ?? DEFAULT_PLAN,
    subscriptionStatus: existing?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// customer.subscription.*
// ---------------------------------------------------------------------------

interface SubscriptionSnapshot {
  subscriptionId: string;
  stripeCustomerId: string | null;
  status: BillingSubscriptionStatus | null;
  priceIds: string[];
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  metadataOrganizationId: string | null;
}

/**
 * Read a subscription payload.
 *
 * `current_period_end` needs care: it used to sit on the subscription and now
 * lives on each subscription ITEM. Both are read — the item is preferred, the
 * top-level field is the fallback — because Stripe renders a replayed event
 * against the API version that was current when the event was created, so a
 * redelivery from before an account's version bump can still arrive in the old
 * shape.
 */
function readSubscription(payload: unknown): SubscriptionSnapshot | null {
  const subscription = asRecord(payload);
  const subscriptionId = readString(subscription, "id");
  if (subscriptionId === null) return null;

  const itemsData = asRecord(subscription?.items)?.data;
  const items = Array.isArray(itemsData) ? itemsData : [];

  const priceIds: string[] = [];
  let periodEndSeconds: number | null = null;

  for (const rawItem of items) {
    const item = asRecord(rawItem);
    const priceId = readReferenceId(item?.price);
    if (priceId !== null) priceIds.push(priceId);

    const itemPeriodEnd = readNumber(item, "current_period_end");
    // Latest period end across items: a subscription's period is over when its
    // last item's is. PayRecon plans are single-item, so this is normally just
    // "the one value", but taking the max cannot be wrong.
    if (itemPeriodEnd !== null && (periodEndSeconds === null || itemPeriodEnd > periodEndSeconds)) {
      periodEndSeconds = itemPeriodEnd;
    }
  }

  if (periodEndSeconds === null) {
    periodEndSeconds = readNumber(subscription, "current_period_end");
  }

  return {
    subscriptionId,
    stripeCustomerId: readReferenceId(subscription?.customer),
    status: toSubscriptionStatus(readString(subscription, "status")),
    priceIds,
    currentPeriodEnd: toDate(periodEndSeconds),
    cancelAtPeriodEnd: readBoolean(subscription, "cancel_at_period_end") ?? false,
    trialEndsAt: toDate(readNumber(subscription, "trial_end")),
    canceledAt: toDate(readNumber(subscription, "canceled_at")),
    metadataOrganizationId: readMetadataOrganizationId(subscription),
  };
}

/**
 * Map the subscription's price to an internal plan.
 *
 * SERVER-SIDE, from the price id, always. Event metadata is never consulted for
 * this: metadata is writable from the Stripe dashboard and from any integration
 * with write access to the account, so trusting it would make "which plan is
 * this customer on" an editable field rather than a consequence of what they
 * are actually being charged.
 */
function resolvePlanKey(
  priceIds: readonly string[],
  existing: BillingSubscriptionRecord | null,
  env: BillingEnvSource | undefined,
): { planKey: PlanKey; priceId: string | null; unmapped: boolean } {
  for (const priceId of priceIds) {
    const planKey = planForPriceId(priceId, env);
    if (planKey !== null) return { planKey, priceId, unmapped: false };
  }

  // No price matched a configured plan — a misconfiguration (a price added in
  // Stripe but not wired up here), not a customer action. Keeping the plan the
  // customer already had is the non-destructive choice: silently dropping a
  // paying customer to `free` because of OUR configuration gap would be exactly
  // the destructive downgrade this package is supposed to avoid.
  return {
    planKey: existing?.planKey ?? DEFAULT_PLAN,
    priceId: priceIds[0] ?? existing?.stripePriceId ?? null,
    unmapped: true,
  };
}

async function applySubscriptionEvent(
  store: BillingStore,
  event: BillingEvent,
  eventCreatedAt: Date,
  now: Date,
  env: BillingEnvSource | undefined,
): Promise<ProcessEventResult> {
  const snapshot = readSubscription(event.data.object);
  if (snapshot === null) {
    throw new WebhookPayloadError("Subscription event carried no subscription object.");
  }

  const organizationId = await resolveOrganizationId(store, {
    stripeCustomerId: snapshot.stripeCustomerId,
    metadataOrganizationId: snapshot.metadataOrganizationId,
  });

  if (organizationId === null) {
    await store.markWebhookEvent(event.id, {
      status: "ignored",
      processedAt: now,
      errorMessage: "Subscription event could not be tied to an organization.",
    });
    return { status: "ignored_unmapped", stripeEventId: event.id, type: event.type };
  }

  const existing = await store.findSubscriptionByOrganization(organizationId);

  // ---- Order tolerance ---------------------------------------------------
  //
  // Stripe does not guarantee delivery order, and a retried delivery of an old
  // event routinely lands after a newer one. Applying it would resurrect stale
  // state — e.g. re-activating a subscription that has since been canceled.
  // Strictly OLDER is rejected; equal timestamps are applied, since two events
  // in the same second are genuinely concurrent and last-write-wins is fine.
  if (
    existing &&
    existing.stripeSubscriptionId === snapshot.subscriptionId &&
    existing.lastEventAt !== null &&
    eventCreatedAt.getTime() < existing.lastEventAt.getTime()
  ) {
    await store.markWebhookEvent(event.id, {
      status: "ignored",
      organizationId,
      processedAt: now,
      errorMessage: "Event is older than the state already applied.",
    });
    return { status: "ignored_stale", stripeEventId: event.id };
  }

  // A deletion event may or may not carry `status: "canceled"`; treat the event
  // type as authoritative for it, since that is what it means.
  const deleted = event.type === "customer.subscription.deleted";
  const status: BillingSubscriptionStatus = deleted
    ? "canceled"
    : (snapshot.status ??
      (() => {
        throw new WebhookPayloadError("Subscription event carried no recognised status.");
      })());

  const { planKey, priceId, unmapped } = resolvePlanKey(snapshot.priceIds, existing, env);

  await store.upsertSubscription({
    organizationId,
    stripeSubscriptionId: snapshot.subscriptionId,
    status,
    planKey,
    stripePriceId: priceId,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    trialEndsAt: snapshot.trialEndsAt,
    // A deletion without an explicit timestamp is stamped with the event time,
    // so "when did this cancel?" is always answerable.
    canceledAt: deleted ? (snapshot.canceledAt ?? eventCreatedAt) : snapshot.canceledAt,
    lastEventAt: eventCreatedAt,
    now,
  });

  await store.recordAudit({
    organizationId,
    actor: { type: "system" },
    action: "billing.subscription_changed",
    targetType: "billing_subscription",
    targetId: snapshot.subscriptionId,
    metadata: {
      eventType: event.type,
      status,
      planKey,
      previousStatus: existing?.status ?? null,
      previousPlanKey: existing?.planKey ?? null,
      ...(unmapped ? { unmappedPrice: true } : {}),
    },
  });

  await syncOrganizationPlan(store, organizationId, planKey, status);

  await store.markWebhookEvent(event.id, {
    status: "processed",
    organizationId,
    processedAt: now,
    // Recorded even on success: an unmapped price is a live misconfiguration
    // that an operator needs to see, and it is greppable here.
    errorMessage: unmapped
      ? "Subscription price is not mapped to a PayRecon plan; previous plan retained."
      : null,
  });

  return {
    status: "processed",
    stripeEventId: event.id,
    organizationId,
    planKey,
    subscriptionStatus: status,
  };
}

// ---------------------------------------------------------------------------
// invoice.paid / invoice.payment_failed
// ---------------------------------------------------------------------------

/**
 * The subscription an invoice belongs to.
 *
 * Current API versions nest it under `parent.subscription_details`; older ones
 * put it directly on the invoice. Both are read, for the same replay reason as
 * `current_period_end`.
 */
function readInvoiceSubscriptionId(payload: Record<string, unknown> | null): string | null {
  const parent = asRecord(payload?.parent);
  const nested = readReferenceId(asRecord(parent?.subscription_details)?.subscription);
  return nested ?? readReferenceId(payload?.subscription);
}

/**
 * Dunning transitions driven by invoice outcomes.
 *
 * Narrow on purpose. An invoice does not describe the subscription's plan or
 * period, so it only ever nudges STATUS, and only in the two directions that
 * are unambiguous:
 *
 *   paid   : past_due | unpaid  →  active   (payment recovered)
 *   failed : active | trialing  →  past_due (dunning begins)
 *
 * Everything else is left alone so an invoice event can never overwrite a
 * cancellation, and `customer.subscription.updated` remains the authoritative
 * source for the full picture.
 */
const INVOICE_TRANSITIONS: Readonly<
  Record<
    "paid" | "failed",
    Readonly<Partial<Record<BillingSubscriptionStatus, BillingSubscriptionStatus>>>
  >
> = {
  paid: { past_due: "active", unpaid: "active" },
  failed: { active: "past_due", trialing: "past_due" },
};

async function applyInvoiceOutcome(
  store: BillingStore,
  event: BillingEvent,
  eventCreatedAt: Date,
  now: Date,
  outcome: "paid" | "failed",
): Promise<ProcessEventResult> {
  const invoice = asRecord(event.data.object);
  const stripeCustomerId = readReferenceId(invoice?.customer);
  const subscriptionId = readInvoiceSubscriptionId(invoice);

  const organizationId = await resolveOrganizationId(store, {
    stripeCustomerId,
    metadataOrganizationId: readMetadataOrganizationId(invoice),
  });

  if (organizationId === null) {
    await store.markWebhookEvent(event.id, {
      status: "ignored",
      processedAt: now,
      errorMessage: "Invoice event could not be tied to an organization.",
    });
    return { status: "ignored_unmapped", stripeEventId: event.id, type: event.type };
  }

  const existing = await store.findSubscriptionByOrganization(organizationId);

  // A one-off invoice, or an invoice for some other subscription, tells us
  // nothing about the subscription we track.
  const applies =
    existing !== null &&
    subscriptionId !== null &&
    existing.stripeSubscriptionId === subscriptionId;

  const next = applies ? INVOICE_TRANSITIONS[outcome][existing.status] : undefined;

  if (!applies || next === undefined) {
    await store.markWebhookEvent(event.id, { status: "ignored", organizationId, processedAt: now });
    return { status: "ignored_unmapped", stripeEventId: event.id, type: event.type };
  }

  if (existing.lastEventAt !== null && eventCreatedAt.getTime() < existing.lastEventAt.getTime()) {
    await store.markWebhookEvent(event.id, {
      status: "ignored",
      organizationId,
      processedAt: now,
      errorMessage: "Event is older than the state already applied.",
    });
    return { status: "ignored_stale", stripeEventId: event.id };
  }

  await store.upsertSubscription({
    organizationId,
    stripeSubscriptionId: existing.stripeSubscriptionId,
    status: next,
    // Plan and period are NOT touched: this event does not carry them, and
    // omitting them leaves the stored values intact.
    planKey: existing.planKey,
    lastEventAt: eventCreatedAt,
    now,
  });

  await store.recordAudit({
    organizationId,
    actor: { type: "system" },
    action: "billing.subscription_changed",
    targetType: "billing_subscription",
    targetId: existing.stripeSubscriptionId,
    metadata: { eventType: event.type, status: next, previousStatus: existing.status },
  });

  await syncOrganizationPlan(store, organizationId, existing.planKey, next);

  await store.markWebhookEvent(event.id, { status: "processed", organizationId, processedAt: now });

  return {
    status: "processed",
    stripeEventId: event.id,
    organizationId,
    planKey: existing.planKey,
    subscriptionStatus: next,
  };
}

// ---------------------------------------------------------------------------
// Entitlement sync
// ---------------------------------------------------------------------------

/**
 * Keep `organizations.plan_key` in step with the subscription.
 *
 * That column is a denormalised copy for display and cheap joins —
 * `getEntitlements` never reads it — but it must not drift, or the billing
 * screen will contradict what the customer can actually do. A lapsed
 * subscription maps to the free plan here, which is the same rule
 * `getEntitlements` applies.
 */
async function syncOrganizationPlan(
  store: BillingStore,
  organizationId: string,
  planKey: PlanKey,
  status: BillingSubscriptionStatus,
): Promise<void> {
  const effectivePlanKey = statusIsEntitled(status) ? planKey : DEFAULT_PLAN;
  const organization = await store.findOrganization(organizationId);
  if (!organization || organization.planKey === effectivePlanKey) return;

  await store.updateOrganizationPlan(organizationId, effectivePlanKey);
  await store.recordAudit({
    organizationId,
    actor: { type: "system" },
    action: "billing.entitlements_changed",
    targetType: "organization",
    targetId: organizationId,
    metadata: {
      previousPlanKey: organization.planKey,
      planKey: effectivePlanKey,
      subscriptionStatus: status,
    },
  });
}
