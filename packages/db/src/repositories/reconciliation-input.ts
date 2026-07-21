import { and, eq, gte, sql } from "drizzle-orm";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  type InternalPaymentRecord,
  type ProviderInvoice,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderSubscription,
  type ReconciliationConfig,
  type ReconciliationInput,
} from "@payrecon/domain";
import type { Database } from "../client";
import { internalPaymentRecords } from "../schema/ingestion";
import {
  providerInvoices,
  providerPayments,
  providerRefunds,
  providerSubscriptions,
  stripeConnections,
  syncCheckpoints,
} from "../schema/sources";

/**
 * Load one organization's reconciliation inputs from the database and map them
 * into the engine's provider-neutral domain types.
 *
 * WINDOWING: the engine holds its inputs in memory, so the load is bounded to a
 * rolling window rather than the full history. The window must comfortably
 * exceed the largest rule window (the 72-hour heuristic match and the stale
 * pending threshold) so that no rule is starved of the data it needs; 180 days
 * is the default. Exceptions already created for older data are unaffected —
 * they live in their own table.
 */

export const DEFAULT_WINDOW_DAYS = 180;

export interface LoadInputOptions {
  organizationId: string;
  now: Date;
  windowDays?: number;
  config?: ReconciliationConfig;
}

export async function loadReconciliationInput(
  db: Database,
  options: LoadInputOptions,
): Promise<ReconciliationInput> {
  const { organizationId, now } = options;
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [paymentRows, refundRows, invoiceRows, subscriptionRows, internalRows] = await Promise.all([
    db
      .select()
      .from(providerPayments)
      .where(
        and(
          eq(providerPayments.organizationId, organizationId),
          gte(providerPayments.providerCreatedAt, since),
        ),
      ),
    db
      .select()
      .from(providerRefunds)
      .where(
        and(
          eq(providerRefunds.organizationId, organizationId),
          gte(providerRefunds.providerCreatedAt, since),
        ),
      ),
    db
      .select()
      .from(providerInvoices)
      .where(
        and(
          eq(providerInvoices.organizationId, organizationId),
          gte(providerInvoices.providerCreatedAt, since),
        ),
      ),
    // Subscriptions are loaded without the window: an old subscription can still
    // be the reason a recent invoice is wrong.
    db
      .select()
      .from(providerSubscriptions)
      .where(eq(providerSubscriptions.organizationId, organizationId)),
    db
      .select()
      .from(internalPaymentRecords)
      .where(
        and(
          eq(internalPaymentRecords.organizationId, organizationId),
          gte(internalPaymentRecords.occurredAt, since),
        ),
      ),
  ]);

  return {
    organizationId,
    now,
    config: options.config ?? DEFAULT_RECONCILIATION_CONFIG,
    providerPayments: paymentRows.map(toDomainPayment),
    providerRefunds: refundRows.map(toDomainRefund),
    providerInvoices: invoiceRows.map(toDomainInvoice),
    providerSubscriptions: subscriptionRows.map(toDomainSubscription),
    internalRecords: internalRows.map(toDomainRecord),
  };
}

type PaymentRow = typeof providerPayments.$inferSelect;
type RefundRow = typeof providerRefunds.$inferSelect;
type InvoiceRow = typeof providerInvoices.$inferSelect;
type SubscriptionRow = typeof providerSubscriptions.$inferSelect;
type InternalRow = typeof internalPaymentRecords.$inferSelect;

function toDomainPayment(row: PaymentRow): ProviderPayment {
  return {
    id: row.providerId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    kind: row.kind === "charge" ? "charge" : "payment_intent",
    status: row.status,
    amountMinor: row.amountMinor,
    amountRefundedMinor: row.amountRefundedMinor,
    currency: row.currency,
    createdAt: row.providerCreatedAt,
    customerId: row.providerCustomerId,
    invoiceId: row.providerInvoiceId,
    paymentIntentId: row.paymentIntentId,
    disputed: row.disputed,
    metadata: (row.metadata ?? {}) as Record<string, string>,
  };
}

function toDomainRefund(row: RefundRow): ProviderRefund {
  return {
    id: row.providerId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    paymentId: row.providerPaymentId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    createdAt: row.providerCreatedAt,
  };
}

function toDomainInvoice(row: InvoiceRow): ProviderInvoice {
  return {
    id: row.providerId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    status: row.status,
    amountDueMinor: row.amountDueMinor,
    amountPaidMinor: row.amountPaidMinor,
    currency: row.currency,
    customerId: row.providerCustomerId,
    subscriptionId: row.providerSubscriptionId,
    createdAt: row.providerCreatedAt,
    paidAt: row.paidAt,
    attemptCount: row.attemptCount,
  };
}

function toDomainSubscription(row: SubscriptionRow): ProviderSubscription {
  return {
    id: row.providerId,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    status: row.status,
    customerId: row.providerCustomerId,
    currency: row.currency,
    createdAt: row.providerCreatedAt,
    canceledAt: row.canceledAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

function toDomainRecord(row: InternalRow): InternalPaymentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    externalId: row.externalId,
    customerId: row.customerId,
    orderId: row.orderId,
    subscriptionId: row.subscriptionId,
    providerTransactionId: row.providerTransactionId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    occurredAt: row.occurredAt,
    recordUpdatedAt: row.recordUpdatedAt,
    metadata: (row.metadata ?? {}) as Record<string, string>,
  };
}

/**
 * Source freshness recorded on each run, so an operator can see exactly how
 * current the inputs were when a conclusion was drawn.
 */
export async function loadSourceSnapshot(
  db: Database,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const connections = await db
    .select({
      id: stripeConnections.id,
      name: stripeConnections.name,
      status: stripeConnections.status,
      livemode: stripeConnections.livemode,
    })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.organizationId, organizationId),
        sql`${stripeConnections.deletedAt} is null`,
      ),
    );

  const checkpoints = await db
    .select({
      connectionId: syncCheckpoints.connectionId,
      resource: syncCheckpoints.resource,
      lastSuccessfulAt: syncCheckpoints.lastSuccessfulAt,
    })
    .from(syncCheckpoints)
    .where(eq(syncCheckpoints.organizationId, organizationId));

  const [recordStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      latest: sql<string | null>`max(${internalPaymentRecords.updatedAt})::text`,
    })
    .from(internalPaymentRecords)
    .where(eq(internalPaymentRecords.organizationId, organizationId));

  return {
    connections: connections.map((connection) => ({
      ...connection,
      lastSuccessfulSyncByResource: Object.fromEntries(
        checkpoints
          .filter((checkpoint) => checkpoint.connectionId === connection.id)
          .map((checkpoint) => [
            checkpoint.resource,
            checkpoint.lastSuccessfulAt?.toISOString() ?? null,
          ]),
      ),
    })),
    internalRecords: {
      total: recordStats?.total ?? 0,
      lastUpdatedAt: recordStats?.latest ?? null,
    },
  };
}
