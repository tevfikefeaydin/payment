/**
 * Central plan and entitlement definitions.
 *
 * Plans are defined here and only here. Prices are resolved server-side from
 * environment configuration; the browser never supplies or influences a price,
 * a plan key, or an entitlement. See docs/adr/0008-plan-entitlements.md.
 */

export const PLAN_KEYS = ["free", "starter", "growth", "scale"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/**
 * Server-enforced limits. `null` means "no limit".
 *
 * Enforcement is never destructive: exceeding a limit blocks NEW over-limit
 * usage but always preserves read access, exports, and the billing screens
 * needed to resolve the situation.
 */
export interface PlanLimits {
  /** Internal payment records ingested per calendar month (CSV + API + sync). */
  monthlyIngestedRecords: number | null;
  /** Simultaneously enabled customer Stripe connections. */
  stripeConnections: number | null;
  /** Organization members, including the owner. */
  members: number | null;
  /** Configured notification destinations. */
  notificationDestinations: number | null;
  /** Days of imported source data retained before scheduled cleanup. */
  maxRetentionDays: number;
}

export interface PlanDefinition {
  key: PlanKey;
  name: string;
  /** Short description shown on the billing screen. */
  description: string;
  /**
   * Environment variable holding the Stripe price ID for this plan in
   * PayRecon's OWN Stripe account. `null` for plans that are not purchasable.
   */
  priceEnvVar: string | null;
  /** Display-only monthly price in minor units, or null when not purchasable. */
  displayAmountMinor: bigint | null;
  displayCurrency: string;
  limits: PlanLimits;
}

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: "free",
    name: "Free",
    description: "Evaluate reconciliation on a single connection.",
    priceEnvVar: null,
    displayAmountMinor: 0n,
    displayCurrency: "USD",
    limits: {
      monthlyIngestedRecords: 5_000,
      stripeConnections: 1,
      members: 3,
      notificationDestinations: 1,
      maxRetentionDays: 30,
    },
  },
  starter: {
    key: "starter",
    name: "Starter",
    description: "For small teams reconciling a single production Stripe account.",
    priceEnvVar: "PLATFORM_STRIPE_PRICE_STARTER",
    displayAmountMinor: 4900n,
    displayCurrency: "USD",
    limits: {
      monthlyIngestedRecords: 50_000,
      stripeConnections: 2,
      members: 10,
      notificationDestinations: 5,
      maxRetentionDays: 90,
    },
  },
  growth: {
    key: "growth",
    name: "Growth",
    description: "Higher volume, more connections and full notification routing.",
    priceEnvVar: "PLATFORM_STRIPE_PRICE_GROWTH",
    displayAmountMinor: 14900n,
    displayCurrency: "USD",
    limits: {
      monthlyIngestedRecords: 250_000,
      stripeConnections: 5,
      members: 25,
      notificationDestinations: 15,
      maxRetentionDays: 180,
    },
  },
  scale: {
    key: "scale",
    name: "Scale",
    description: "Unlimited ingestion volume and extended retention.",
    priceEnvVar: "PLATFORM_STRIPE_PRICE_SCALE",
    displayAmountMinor: 39900n,
    displayCurrency: "USD",
    limits: {
      monthlyIngestedRecords: null,
      stripeConnections: null,
      members: null,
      notificationDestinations: null,
      maxRetentionDays: 365,
    },
  },
};

/** The plan assigned to a newly created organization. */
export const DEFAULT_PLAN: PlanKey = "free";

export function isPlanKey(value: string): value is PlanKey {
  return (PLAN_KEYS as readonly string[]).includes(value);
}

export function getPlan(key: PlanKey): PlanDefinition {
  return PLANS[key];
}

/** Ordered list used to render the pricing table. */
export function listPlans(): PlanDefinition[] {
  return PLAN_KEYS.map((k) => PLANS[k]);
}

/**
 * Retention bounds enforced on organization settings, independent of plan.
 * A plan may lower the effective maximum but never below the floor.
 */
export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 365;
