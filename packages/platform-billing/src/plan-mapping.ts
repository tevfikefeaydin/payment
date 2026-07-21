/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * The price ids resolved here belong to PayRecon's Stripe account and price
 * PayRecon's subscription plans. They have nothing to do with a customer's
 * own products, prices, or reconciled operational revenue.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Server-side mapping between an internal `PlanKey` and a Stripe price id.
 *
 * ============================================================================
 * THE BROWSER NEVER SUPPLIES A PRICE ID, AND ITS PLAN KEY IS NEVER TRUSTED.
 * ============================================================================
 *
 * A checkout request carries a `PlanKey` and nothing else. That key is
 * validated against `PLANS` and then exchanged HERE, on the server, for a
 * price id read from environment configuration. The browser cannot reach the
 * price id at all, so it cannot:
 *
 *   - substitute a cheaper price (or a $0 test price) for an expensive plan,
 *   - subscribe to a price that exists in the account but is not a PayRecon
 *     plan (an internal price, a partner price, a legacy price),
 *   - or invent a plan key that maps to entitlements no plan actually sells.
 *
 * The inverse direction matters just as much: when a webhook arrives, the
 * plan is derived from the price id on the subscription — never from event
 * metadata — so entitlements always trace back to a price PayRecon configured.
 */
import { PLAN_KEYS, PLANS, isPlanKey, type PlanKey } from "@payrecon/config";
import type { BillingEnvSource } from "./client";

/**
 * Plans that can actually be bought.
 *
 * Derived from `priceEnvVar` rather than listed separately: the free plan has
 * no price variable and therefore cannot be checked out, and that stays true
 * automatically if the plan catalogue changes.
 */
export function isPurchasablePlan(planKey: PlanKey): boolean {
  return PLANS[planKey].priceEnvVar !== null;
}

/** Validate an untrusted string as a purchasable plan key. */
export function toPurchasablePlanKey(value: string): PlanKey | null {
  if (!isPlanKey(value)) return null;
  return isPurchasablePlan(value) ? value : null;
}

/**
 * The Stripe price id configured for a plan, or null.
 *
 * Null means one of two things, and the caller should treat them the same:
 * the plan is not purchasable (free), or its price variable is unset in this
 * environment. Either way there is nothing to sell.
 */
export function priceIdForPlan(
  planKey: PlanKey,
  source: BillingEnvSource = process.env,
): string | null {
  const envVar = PLANS[planKey].priceEnvVar;
  if (envVar === null) return null;

  const value = source[envVar];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The internal plan a Stripe price id corresponds to, or null.
 *
 * Built fresh on each call rather than memoised. The map is four entries wide,
 * so caching buys nothing measurable, and a stale cache after a configuration
 * reload would mean billing a customer for one plan and entitling them to
 * another — a far worse trade than a handful of object lookups.
 *
 * An id that matches MORE than one plan is treated as unmappable. A duplicate
 * is a misconfiguration, and guessing would mean picking, half the time, the
 * more generous of two plans.
 */
export function planForPriceId(
  priceId: string,
  source: BillingEnvSource = process.env,
): PlanKey | null {
  const needle = priceId.trim();
  if (needle.length === 0) return null;

  let match: PlanKey | null = null;
  for (const planKey of PLAN_KEYS) {
    if (priceIdForPlan(planKey, source) !== needle) continue;
    if (match !== null) return null; // ambiguous configuration — refuse to guess
    match = planKey;
  }
  return match;
}

/**
 * Every plan that is purchasable AND has its price configured here.
 * Used to render a pricing table that cannot offer a plan checkout would
 * then reject.
 */
export function listConfiguredPlanKeys(source: BillingEnvSource = process.env): PlanKey[] {
  return PLAN_KEYS.filter((key) => priceIdForPlan(key, source) !== null);
}
