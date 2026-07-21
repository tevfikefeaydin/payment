/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Public entry point for @payrecon/platform-billing: PayRecon's own
 * subscription billing.
 *
 * This package is one half of a deliberately split pair. The other half — the
 * customer-data integration package — talks to a CUSTOMER's Stripe account
 * with their restricted read-only key to read THEIR operational payments. This
 * half talks to PAYRECON's Stripe account to sell PayRecon subscriptions.
 *
 * (That package is referred to by description rather than by name throughout
 * this source tree, because `context-separation.test.ts` fails the build if its
 * name appears anywhere in it — see that file.)
 *
 * They never mix:
 *   - different credentials — only PLATFORM_STRIPE_* is read here;
 *   - different tables — nothing here reads or writes the connection,
 *     credential or provider tables;
 *   - different meaning — revenue recorded here is PayRecon's revenue and must
 *     never be presented as a customer's reconciled operational revenue.
 *
 * ESLint forbids the two packages from importing each other, and
 * `context-separation.test.ts` re-checks the boundary against the source on
 * disk so it cannot decay into a convention.
 *
 * See docs/adr/0007-stripe-context-separation.md.
 */

export {
  PLATFORM_STRIPE_API_VERSION,
  PLATFORM_STRIPE_SECRET_KEY_VAR,
  PLATFORM_STRIPE_WEBHOOK_SECRET_VAR,
  getPlatformStripeClient,
  getWebhookSecret,
  isBillingConfigured,
  resetPlatformStripeClient,
  resolveStripeClient,
  type BillingEnvSource,
  type PlatformStripeClient,
} from "./client";

export {
  BillingConfigurationError,
  BillingNotConfiguredError,
  BillingRequestError,
  sanitizeBillingMessage,
  sanitizeUnknownError,
} from "./errors";

export {
  isPurchasablePlan,
  listConfiguredPlanKeys,
  planForPriceId,
  priceIdForPlan,
  toPurchasablePlanKey,
} from "./plan-mapping";

export {
  OVER_LIMIT_BLOCKED_ACTIONS,
  OVER_LIMIT_PRESERVED_ACTIONS,
  checkLimit,
  defaultEntitlements,
  describeLimit,
  getEntitlements,
  isReadPreserved,
  statusIsEntitled,
  type BlockedAction,
  type CheckLimitInput,
  type Entitlements,
  type ExternallyCountedLimitMetric,
  type LimitCheck,
  type LimitMetric,
  type OverLimitAction,
  type PreservedAction,
  type SelfCountedLimitMetric,
} from "./entitlements";

export {
  createCheckoutSession,
  createPortalSession,
  type BillingSessionDeps,
  type CheckoutSessionResult,
  type CreateCheckoutSessionInput,
  type CreatePortalSessionInput,
  type PortalSessionResult,
} from "./checkout";

export {
  HANDLED_EVENT_TYPES,
  WebhookPayloadError,
  WebhookSignatureError,
  isHandledEventType,
  processEvent,
  toBillingEvent,
  verifyAndParse,
  type BillingEvent,
  type ProcessEventDeps,
  type ProcessEventResult,
  type SignatureVerifier,
  type VerifyOptions,
} from "./webhooks";

export {
  USAGE_METRIC_INGESTED_RECORDS,
  isBillingStore,
  resolveBillingStore,
  usagePeriodKey,
  type BillingAuditInput,
  type BillingCustomerRecord,
  type BillingStore,
  type BillingStoreLike,
  type BillingSubscriptionRecord,
  type BillingSubscriptionStatus,
  type OrganizationRecord,
  type UpsertSubscriptionInput,
  type WebhookEventRecord,
  type WebhookProcessingStatus,
} from "./store";

export { createDrizzleBillingStore } from "./store-drizzle";

/**
 * Test doubles. Exported from the package root so integration tests and the
 * demo seeder can use the same in-memory store the unit tests do, rather than
 * each inventing their own half-correct fake.
 */
export { createMemoryBillingStore, type MemoryBillingStore } from "./memory-store";
export * as fixtures from "./fixtures";
