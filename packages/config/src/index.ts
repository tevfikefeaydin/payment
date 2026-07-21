/**
 * Public entry point for @payrecon/config.
 *
 * Only browser-safe values are re-exported here. Server-only environment
 * access lives in `@payrecon/config/env` and must be imported explicitly so
 * that a stray client import is obvious in review.
 */
export { PRODUCT, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, ACTIVE_ORG_COOKIE_NAME } from "./product";

export {
  PLAN_KEYS,
  PLANS,
  DEFAULT_PLAN,
  RETENTION_MIN_DAYS,
  RETENTION_MAX_DAYS,
  getPlan,
  listPlans,
  isPlanKey,
  type PlanKey,
  type PlanLimits,
  type PlanDefinition,
} from "./plans";
