import { getPlan, isPlanKey, type PlanKey } from "@payrecon/config";

/**
 * Plan-limit enforcement for ingestion volume.
 *
 * Kept as a pure function so the decision can be tested without a database and
 * so the API route, the CSV import worker and the billing screens all compute
 * "over limit" the same way.
 *
 * Enforcement is never destructive: exceeding the limit blocks NEW ingestion
 * only. Reads, exports and the billing screens stay available so the customer
 * can actually resolve the situation.
 */

/** Usage counter metric name. One constant so writers and readers agree. */
export const USAGE_METRIC_INGESTED_RECORDS = "ingested_records";

export interface PlanLimitDecision {
  allowed: boolean;
  /** Null means the plan has no ingestion cap. */
  limit: number | null;
  used: number;
  requested: number;
  /** Records still ingestible this month, or null when uncapped. */
  remaining: number | null;
}

export function resolvePlanKey(value: string): PlanKey {
  // An unrecognised plan key falls back to the most restrictive plan rather
  // than to "unlimited": a bad value must never widen entitlements.
  return isPlanKey(value) ? value : "free";
}

export function checkMonthlyIngestionLimit(params: {
  planKey: string;
  /** Records already ingested this calendar month. */
  used: bigint | number;
  /** Records this request would add. */
  requested: number;
}): PlanLimitDecision {
  const limit = getPlan(resolvePlanKey(params.planKey)).limits.monthlyIngestedRecords;
  const used = Number(params.used);

  if (limit === null) {
    return { allowed: true, limit: null, used, requested: params.requested, remaining: null };
  }

  const remaining = Math.max(limit - used, 0);
  return {
    // The whole batch is rejected rather than partially applied, so the caller
    // never has to work out which of its records landed.
    allowed: used + params.requested <= limit,
    limit,
    used,
    requested: params.requested,
    remaining,
  };
}
