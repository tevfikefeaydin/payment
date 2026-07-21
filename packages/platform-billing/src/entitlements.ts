/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Entitlements describe what a customer has bought FROM PAYRECON. They are
 * derived from PayRecon's own subscription rows, never from a customer's
 * connected Stripe account, and the numbers here are plan limits — not money,
 * and never a customer's reconciled operational revenue.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Plan entitlements and server-side limit enforcement.
 */
import { DEFAULT_PLAN, PLANS, getPlan, type PlanKey, type PlanLimits } from "@payrecon/config";
import {
  resolveBillingStore,
  type BillingStoreLike,
  type BillingSubscriptionStatus,
} from "./store";

// ---------------------------------------------------------------------------
// Status policy
// ---------------------------------------------------------------------------

/**
 * Which subscription statuses grant the plan's entitlements.
 *
 * Written as an exhaustive record rather than a set literal so that adding a
 * status to the database enum fails to COMPILE until someone decides, in
 * writing, whether it pays for anything.
 *
 * The interesting case is `past_due`. Stripe puts a subscription there while it
 * retries a failed payment — dunning typically runs for weeks. Cutting a
 * customer off at the first failed charge would punish an expired card by
 * breaking the product on the day they most need to get into it and fix their
 * billing details, so `past_due` REMAINS ENTITLED. `unpaid` is the state Stripe
 * moves to once dunning has genuinely given up, and that one does downgrade.
 *
 * `incomplete` means the very first payment never completed, so nothing has
 * been paid for yet. `paused` is an explicit stop to billing.
 */
const STATUS_GRANTS_ENTITLEMENT: Readonly<Record<BillingSubscriptionStatus, boolean>> = {
  trialing: true,
  active: true,
  past_due: true,
  canceled: false,
  incomplete: false,
  incomplete_expired: false,
  unpaid: false,
  paused: false,
};

export function statusIsEntitled(status: BillingSubscriptionStatus): boolean {
  return STATUS_GRANTS_ENTITLEMENT[status];
}

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

export interface Entitlements {
  /**
   * The plan whose limits actually apply right now. For a lapsed subscription
   * this is the free plan even though `subscribedPlanKey` still names what was
   * bought.
   */
  planKey: PlanKey;
  limits: PlanLimits;
  /** Null when the organization has never had a subscription. */
  status: BillingSubscriptionStatus | null;
  currentPeriodEnd: Date | null;
  /** True when the subscription's status grants its plan's entitlements. */
  isActive: boolean;
  /** What was purchased, regardless of whether it currently entitles. */
  subscribedPlanKey: PlanKey | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
}

/** Free-plan entitlements: the floor every organization always has. */
export function defaultEntitlements(): Entitlements {
  return {
    planKey: DEFAULT_PLAN,
    limits: getPlan(DEFAULT_PLAN).limits,
    status: null,
    currentPeriodEnd: null,
    isActive: false,
    subscribedPlanKey: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
  };
}

/**
 * Resolve what an organization is entitled to.
 *
 * Authoritative source is `billing_subscriptions`, which is written ONLY from
 * signature-verified Stripe webhooks. `organizations.plan_key` is a
 * denormalised copy kept in step for display and for cheap joins; it is
 * deliberately NOT consulted here, so a stray write to that column can never
 * hand out entitlements nobody paid for.
 *
 * No subscription at all falls back to the free plan rather than to "no
 * access": the free plan is a real product tier, and a customer who has never
 * paid still gets it.
 */
export async function getEntitlements(
  db: BillingStoreLike,
  organizationId: string,
): Promise<Entitlements> {
  const store = resolveBillingStore(db);
  const subscription = await store.findSubscriptionByOrganization(organizationId);

  if (!subscription) return defaultEntitlements();

  const entitled = statusIsEntitled(subscription.status);
  // A lapsed subscription drops to the free plan's LIMITS while keeping its
  // real status and plan on the record, so the billing screen can say
  // "your Growth subscription was canceled" rather than pretending it never
  // existed.
  const effectivePlanKey = entitled ? subscription.planKey : DEFAULT_PLAN;

  return {
    planKey: effectivePlanKey,
    limits: getPlan(effectivePlanKey).limits,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd,
    isActive: entitled,
    subscribedPlanKey: subscription.planKey,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    trialEndsAt: subscription.trialEndsAt,
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Metrics a plan caps.
 *
 * Derived from `PlanLimits` by subtraction rather than written out, so adding a
 * limit to the plan catalogue immediately produces a compile error at every
 * `switch` below until it is counted. `maxRetentionDays` is excluded because it
 * is a scheduling parameter, not a quantity anyone can exceed.
 */
export type LimitMetric = Exclude<keyof PlanLimits, "maxRetentionDays">;

/** Metrics this package can count for itself, from tables it is allowed to read. */
export type SelfCountedLimitMetric =
  "monthlyIngestedRecords" | "members" | "notificationDestinations";

/**
 * Metrics whose current usage lives in the CUSTOMER-DATA context.
 *
 * Platform billing is forbidden from reading those tables, so the caller — which
 * is already in that context — has to hand the count in. Expressing it as a
 * subtraction rather than a name keeps this file free of any customer-data
 * identifier, which the context-separation test checks mechanically.
 */
export type ExternallyCountedLimitMetric = Exclude<LimitMetric, SelfCountedLimitMetric>;

export interface LimitCheck {
  metric: LimitMetric;
  allowed: boolean;
  /** Null means the plan does not cap this metric. */
  limit: number | null;
  current: number;
  requested: number;
  /** Headroom left, or null when uncapped. Never negative. */
  remaining: number | null;
  /** The plan the decision was made against (already the effective plan). */
  planKey: PlanKey;
}

interface CheckLimitBase {
  organizationId: string;
  /** How much this request would add. Use 0 to ask "am I already over?". */
  requested: number;
  /** Injectable clock, so the monthly counter boundary is testable. */
  now?: Date;
}

export type CheckLimitInput =
  | (CheckLimitBase & {
      metric: SelfCountedLimitMetric;
      /** Optional override; otherwise counted from the database. */
      current?: number;
    })
  | (CheckLimitBase & {
      metric: ExternallyCountedLimitMetric;
      /** REQUIRED: this package may not read the table that holds this count. */
      current: number;
    });

async function currentUsage(
  db: BillingStoreLike,
  input: CheckLimitInput,
  now: Date,
): Promise<number> {
  if (typeof input.current === "number") return Math.max(input.current, 0);

  const store = resolveBillingStore(db);
  switch (input.metric) {
    case "monthlyIngestedRecords": {
      const count = await store.countIngestedRecordsThisMonth(input.organizationId, now);
      // Counter is bigint in the database; plan limits are plain numbers well
      // inside the safe-integer range, so narrowing here is lossless in every
      // case that can affect the decision.
      return Number(count);
    }
    case "members":
      return store.countMembers(input.organizationId);
    case "notificationDestinations":
      return store.countNotificationDestinations(input.organizationId);
    default:
      // Only the externally-counted metrics reach here, and the type union
      // already requires `current` for those — so this is unreachable unless a
      // caller defeated the types.
      throw new TypeError(
        `checkLimit: metric "${String(input.metric)}" requires an explicit current count.`,
      );
  }
}

/**
 * Decide whether a request fits inside the organization's plan.
 *
 * The whole request is allowed or refused as a unit rather than partially
 * applied, so a caller never has to work out which half of its batch landed.
 *
 * Boundary semantics: landing EXACTLY on the limit is allowed; one over is not.
 * A plan that says "10 members" means ten members are usable.
 */
export async function checkLimit(
  db: BillingStoreLike,
  input: CheckLimitInput,
): Promise<LimitCheck> {
  const now = input.now ?? new Date();
  const entitlements = await getEntitlements(db, input.organizationId);
  const limit = entitlements.limits[input.metric];
  const current = await currentUsage(db, input, now);
  const requested = Math.max(input.requested, 0);

  if (limit === null) {
    return {
      metric: input.metric,
      allowed: true,
      limit: null,
      current,
      requested,
      remaining: null,
      planKey: entitlements.planKey,
    };
  }

  return {
    metric: input.metric,
    allowed: current + requested <= limit,
    limit,
    current,
    requested,
    // Clamped at zero: an organization that downgraded while over its new limit
    // has negative headroom, and reporting "-40 remaining" helps nobody.
    remaining: Math.max(limit - current, 0),
    planKey: entitlements.planKey,
  };
}

// ---------------------------------------------------------------------------
// Non-destructive enforcement
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * ENFORCEMENT IS NEVER DESTRUCTIVE.
 * ============================================================================
 *
 * Going over a limit — by growing, or by downgrading onto a smaller plan —
 * blocks NEW over-limit usage and nothing else. It never deletes data, never
 * revokes access to what is already there, and never locks the customer out of
 * the screens they need to fix the situation.
 *
 * That is a product decision with a hard edge: a customer whose card expired
 * must still be able to read their reconciliation results, EXPORT their data,
 * and reach checkout or the billing portal. A plan limit is a reason to stop
 * selling more capacity, never a reason to hold someone's data hostage.
 *
 * The two lists below make that testable instead of aspirational.
 */

/** Always permitted, even when the organization is over every limit. */
export const OVER_LIMIT_PRESERVED_ACTIONS = [
  // read
  "records.read",
  "reconciliation.read",
  "exceptions.read",
  "audit.read",
  "settings.read",
  // getting your data out
  "records.export",
  "reconciliation.export",
  "exceptions.export",
  // resolving the situation
  "billing.read",
  "billing.checkout",
  "billing.portal",
  "exceptions.resolve",
  // shrinking back under the limit
  "members.remove",
  "notifications.destination_delete",
] as const;

/** Refused while the relevant limit is exceeded. All of these ADD capacity. */
export const OVER_LIMIT_BLOCKED_ACTIONS = [
  "records.ingest",
  "imports.start",
  "members.invite",
  "notifications.destination_create",
  "connections.create",
] as const;

export type PreservedAction = (typeof OVER_LIMIT_PRESERVED_ACTIONS)[number];
export type BlockedAction = (typeof OVER_LIMIT_BLOCKED_ACTIONS)[number];
export type OverLimitAction = PreservedAction | BlockedAction;

const PRESERVED: ReadonlySet<string> = new Set<string>(OVER_LIMIT_PRESERVED_ACTIONS);
const BLOCKED: ReadonlySet<string> = new Set<string>(OVER_LIMIT_BLOCKED_ACTIONS);

/**
 * True when an action must remain available even while the organization is over
 * its plan limits.
 *
 * The default for an UNCLASSIFIED action is "preserved", not "blocked". That
 * asymmetry is intentional: wrongly allowing a read costs nothing, while
 * wrongly blocking one locks a paying customer out of their own data over a
 * string somebody forgot to add to a list.
 */
export function isReadPreserved(action: OverLimitAction | string): boolean {
  if (PRESERVED.has(action)) return true;
  return !BLOCKED.has(action);
}

// ---------------------------------------------------------------------------
// Product messages
// ---------------------------------------------------------------------------

/**
 * Human nouns for the metrics this file can name.
 *
 * Partial on purpose. Any metric without an entry is humanised from its own
 * key, which keeps this module free of customer-data identifiers — the
 * context-separation test checks that mechanically, and a hard-coded label
 * would trip it.
 */
const METRIC_NOUNS: Partial<Readonly<Record<LimitMetric, string>>> = {
  monthlyIngestedRecords: "payment records this month",
  members: "team members",
  notificationDestinations: "notification destinations",
};

/** `someMetricName` → `some metric name`. */
function humanizeMetric(metric: string): string {
  return metric.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * A message safe to show an end user.
 *
 * Always names the remedy, and never implies data was removed — because it
 * never is. See the enforcement note above.
 */
export function describeLimit(check: LimitCheck): string {
  if (check.allowed || check.limit === null) return "";

  const noun = METRIC_NOUNS[check.metric] ?? humanizeMetric(check.metric);
  const planName = PLANS[check.planKey].name;
  return (
    `Your ${planName} plan allows ${check.limit} ${noun} and you are using ${check.current}. ` +
    `Existing data and exports are unaffected — upgrade to add more.`
  );
}
