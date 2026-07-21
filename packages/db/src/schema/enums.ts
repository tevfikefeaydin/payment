import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Database-level enumerations.
 *
 * These mirror the union types in @payrecon/domain. Enforcing them in the
 * database as well as in TypeScript means a bad value cannot be written by a
 * migration, a manual query, or a future code path that skips validation.
 */

export const organizationRoleEnum = pgEnum("organization_role", [
  "owner",
  "admin",
  "analyst",
  "viewer",
]);

export const planKeyEnum = pgEnum("plan_key", ["free", "starter", "growth", "scale"]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending_validation",
  "active",
  "disabled",
  "revoked",
]);

export const syncStatusEnum = pgEnum("sync_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "partial",
]);

export const syncResourceEnum = pgEnum("sync_resource", [
  "customers",
  "payment_intents",
  "charges",
  "invoices",
  "subscriptions",
  "refunds",
  "disputes",
  "balance_transactions",
  "payouts",
]);

export const internalPaymentStatusEnum = pgEnum("internal_payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
]);

export const recordSourceEnum = pgEnum("record_source", ["csv", "api", "demo"]);

export const providerPaymentStatusEnum = pgEnum("provider_payment_status", [
  "succeeded",
  "processing",
  "requires_action",
  "requires_payment_method",
  "canceled",
  "failed",
]);

export const providerRefundStatusEnum = pgEnum("provider_refund_status", [
  "succeeded",
  "pending",
  "failed",
  "canceled",
]);

export const providerInvoiceStatusEnum = pgEnum("provider_invoice_status", [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
]);

export const providerSubscriptionStatusEnum = pgEnum("provider_subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

export const importStatusEnum = pgEnum("import_status", [
  "uploaded",
  "mapping",
  "validating",
  "queued",
  "processing",
  "completed",
  "completed_with_errors",
  "failed",
  "canceled",
]);

export const exceptionSeverityEnum = pgEnum("exception_severity", [
  "critical",
  "high",
  "medium",
  "low",
]);

export const exceptionStateEnum = pgEnum("exception_state", [
  "open",
  "acknowledged",
  "resolved",
  "reopened",
]);

export const reconciliationRunStatusEnum = pgEnum("reconciliation_run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const runTriggerEnum = pgEnum("run_trigger", ["manual", "scheduled", "import", "sync"]);

export const actorTypeEnum = pgEnum("actor_type", ["user", "api_key", "system"]);

export const notificationKindEnum = pgEnum("notification_kind", ["email", "slack"]);

export const notificationDestinationStatusEnum = pgEnum("notification_destination_status", [
  "pending_verification",
  "active",
  "disabled",
  "failing",
]);

export const notificationDigestEnum = pgEnum("notification_digest", [
  "immediate",
  "hourly",
  "daily",
]);

export const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "pending",
  "sent",
  "failed",
  "skipped",
]);

export const billingSubscriptionStatusEnum = pgEnum("billing_subscription_status", [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "unpaid",
  "paused",
]);

export const webhookProcessingStatusEnum = pgEnum("webhook_processing_status", [
  "received",
  "processed",
  "ignored",
  "failed",
]);
