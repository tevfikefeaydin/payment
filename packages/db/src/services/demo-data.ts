import { eq } from "drizzle-orm";
import type { Database } from "../client";
import { internalPaymentRecords } from "../schema/ingestion";
import {
  providerCustomers,
  providerInvoices,
  providerPayments,
  providerRefunds,
  providerSubscriptions,
  stripeConnections,
} from "../schema/sources";
import { recordAudit } from "../repositories/audit";

/**
 * Deterministic demo dataset.
 *
 * Contains healthy, cleanly-reconciling records plus exactly one worked example
 * for each of the ten reconciliation rules. It is fed through the SAME engine
 * and the SAME persistence path as production data — there is no demo-only
 * reconciliation code — so what a prospect sees is genuinely what the product
 * does.
 *
 * DESIGN CONSTRAINTS
 *  - Amounts and customers are unique per scenario so that one scenario cannot
 *    accidentally satisfy another rule's matcher (which would make the demo's
 *    exception count unstable).
 *  - Every intentionally-matched pair is linked by an explicit
 *    `providerTransactionId`, so matching is `strong` and never heuristic.
 *  - Timestamps are computed as offsets from the seed time, so the data always
 *    looks current while the relationships between records stay fixed.
 *  - Re-seeding is idempotent: existing demo rows for the organization are
 *    removed first, so the demo can be reloaded without duplicating anything.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Marks a synthetic Stripe connection so it can be recognised and re-seeded. */
export const DEMO_CONNECTION_NAME = "Demo Stripe account (sample data)";

export interface SeedDemoOptions {
  organizationId: string;
  /** Injected for determinism in tests. */
  now?: Date;
  actorUserId?: string | null;
}

export interface SeedDemoResult {
  connectionId: string;
  providerPayments: number;
  providerInvoices: number;
  providerSubscriptions: number;
  providerRefunds: number;
  internalRecords: number;
}

export async function seedDemoData(
  db: Database,
  options: SeedDemoOptions,
): Promise<SeedDemoResult> {
  const now = options.now ?? new Date();
  const { organizationId } = options;
  const at = (offsetMs: number): Date => new Date(now.getTime() - offsetMs);

  return db.transaction(async (tx) => {
    // --- Idempotency: clear any previous demo data for THIS organization only.
    await tx
      .delete(internalPaymentRecords)
      .where(eq(internalPaymentRecords.organizationId, organizationId));
    await tx.delete(providerRefunds).where(eq(providerRefunds.organizationId, organizationId));
    await tx.delete(providerInvoices).where(eq(providerInvoices.organizationId, organizationId));
    await tx
      .delete(providerSubscriptions)
      .where(eq(providerSubscriptions.organizationId, organizationId));
    await tx.delete(providerPayments).where(eq(providerPayments.organizationId, organizationId));
    await tx.delete(providerCustomers).where(eq(providerCustomers.organizationId, organizationId));
    await tx.delete(stripeConnections).where(eq(stripeConnections.organizationId, organizationId));

    const [connection] = await tx
      .insert(stripeConnections)
      .values({
        organizationId,
        name: DEMO_CONNECTION_NAME,
        stripeAccountId: "acct_demo_sample",
        accountDisplayName: "Northwind Software (demo)",
        livemode: false,
        status: "active",
        lastValidatedAt: now,
        readableResources: [
          "customers",
          "payment_intents",
          "charges",
          "invoices",
          "subscriptions",
          "refunds",
        ],
        createdByUserId: options.actorUserId ?? null,
      })
      .returning({ id: stripeConnections.id });

    if (!connection) throw new Error("Failed to create demo connection");
    const connectionId = connection.id;
    const base = { organizationId, connectionId };

    // --- Customers -------------------------------------------------------
    const customers = [
      { providerId: "cus_demo_healthy1", email: "ana@northwind.example", name: "Ana Fischer" },
      { providerId: "cus_demo_healthy2", email: "ben@contoso.example", name: "Ben Okafor" },
      { providerId: "cus_demo_missing", email: "cleo@fabrikam.example", name: "Cleo Marchetti" },
      { providerId: "cus_demo_notpaid", email: "dev@tailspin.example", name: "Devi Raman" },
      { providerId: "cus_demo_amount", email: "eli@adventure.example", name: "Eli Nakamura" },
      { providerId: "cus_demo_currency", email: "fay@wingtip.example", name: "Fay Lindqvist" },
      { providerId: "cus_demo_duplicate", email: "gus@proseware.example", name: "Gus Almeida" },
      { providerId: "cus_demo_refund", email: "hana@lucerne.example", name: "Hana Varga" },
      { providerId: "cus_demo_ghost", email: "ivo@litware.example", name: "Ivo Petrov" },
      { providerId: "cus_demo_stale", email: "jun@vanarsdel.example", name: "Jun Park" },
      { providerId: "cus_demo_cancelled", email: "kay@relecloud.example", name: "Kay Mensah" },
      { providerId: "cus_demo_dunning", email: "lou@woodgrove.example", name: "Lou Baptiste" },
    ];

    await tx.insert(providerCustomers).values(
      customers.map((customer) => ({
        ...base,
        providerId: customer.providerId,
        email: customer.email,
        name: customer.name,
        providerCreatedAt: at(120 * DAY),
      })),
    );

    // --- Provider payments -----------------------------------------------
    const payments = [
      // Healthy: matched, correct amount and currency, recorded as paid.
      {
        providerId: "pi_demo_healthy_1",
        status: "succeeded" as const,
        amountMinor: 4900n,
        currency: "USD",
        providerCustomerId: "cus_demo_healthy1",
        providerCreatedAt: at(6 * DAY),
      },
      {
        providerId: "pi_demo_healthy_2",
        status: "succeeded" as const,
        amountMinor: 14900n,
        currency: "USD",
        providerCustomerId: "cus_demo_healthy2",
        providerCreatedAt: at(5 * DAY),
      },
      {
        providerId: "pi_demo_healthy_3",
        status: "succeeded" as const,
        amountMinor: 250000n,
        currency: "JPY", // zero-decimal: proves currency handling end to end
        providerCustomerId: "cus_demo_healthy1",
        providerCreatedAt: at(4 * DAY),
      },
      // Rule 1: succeeded in Stripe, absent internally.
      {
        providerId: "pi_demo_missing_internal",
        status: "succeeded" as const,
        amountMinor: 7900n,
        currency: "USD",
        providerCustomerId: "cus_demo_missing",
        providerCreatedAt: at(3 * DAY),
      },
      // Rule 2: succeeded in Stripe, still "pending" internally.
      {
        providerId: "pi_demo_not_paid",
        status: "succeeded" as const,
        amountMinor: 12900n,
        currency: "USD",
        providerCustomerId: "cus_demo_notpaid",
        providerCreatedAt: at(2 * DAY),
      },
      // Rule 4: amount disagrees (tax applied on one side only).
      {
        providerId: "pi_demo_amount_mismatch",
        status: "succeeded" as const,
        amountMinor: 10800n,
        currency: "USD",
        providerCustomerId: "cus_demo_amount",
        providerCreatedAt: at(4 * DAY),
      },
      // Rule 5: currency disagrees.
      {
        providerId: "pi_demo_currency_mismatch",
        status: "succeeded" as const,
        amountMinor: 8900n,
        currency: "EUR",
        providerCustomerId: "cus_demo_currency",
        providerCreatedAt: at(3 * DAY),
      },
      // Rule 6: the same customer charged the same amount twice, 4 minutes apart.
      {
        providerId: "pi_demo_duplicate_a",
        status: "succeeded" as const,
        amountMinor: 24900n,
        currency: "USD",
        providerCustomerId: "cus_demo_duplicate",
        providerCreatedAt: at(2 * DAY),
      },
      {
        providerId: "pi_demo_duplicate_b",
        status: "succeeded" as const,
        amountMinor: 24900n,
        currency: "USD",
        providerCustomerId: "cus_demo_duplicate",
        providerCreatedAt: at(2 * DAY - 4 * MINUTE),
      },
      // Rule 7: refunded in Stripe, still "paid" internally.
      {
        providerId: "pi_demo_refunded",
        status: "succeeded" as const,
        amountMinor: 19900n,
        amountRefundedMinor: 19900n,
        currency: "USD",
        providerCustomerId: "cus_demo_refund",
        providerCreatedAt: at(9 * DAY),
      },
      // A failed payment that the internal system also shows as failed: healthy.
      {
        providerId: "pi_demo_failed_ok",
        status: "failed" as const,
        amountMinor: 5900n,
        currency: "USD",
        providerCustomerId: "cus_demo_healthy2",
        providerCreatedAt: at(7 * DAY),
      },
    ];

    await tx.insert(providerPayments).values(
      payments.map((payment) => ({
        ...base,
        providerId: payment.providerId,
        kind: "payment_intent",
        status: payment.status,
        amountMinor: payment.amountMinor,
        amountRefundedMinor: payment.amountRefundedMinor ?? 0n,
        currency: payment.currency,
        providerCustomerId: payment.providerCustomerId,
        providerInvoiceId: null,
        paymentIntentId: null,
        disputed: false,
        metadata: {},
        providerCreatedAt: payment.providerCreatedAt,
      })),
    );

    // --- Refund backing rule 7 -------------------------------------------
    await tx.insert(providerRefunds).values([
      {
        ...base,
        providerId: "re_demo_refund_1",
        providerPaymentId: "pi_demo_refunded",
        amountMinor: 19900n,
        currency: "USD",
        status: "succeeded",
        // Comfortably older than the 60-minute refund propagation grace.
        providerCreatedAt: at(8 * DAY),
      },
    ]);

    // --- Subscriptions ----------------------------------------------------
    await tx.insert(providerSubscriptions).values([
      {
        ...base,
        providerId: "sub_demo_cancelled",
        status: "canceled",
        providerCustomerId: "cus_demo_cancelled",
        currency: "USD",
        providerCreatedAt: at(200 * DAY),
        canceledAt: at(20 * DAY),
        currentPeriodStart: at(35 * DAY),
        currentPeriodEnd: at(5 * DAY),
      },
      {
        ...base,
        providerId: "sub_demo_active_dunning",
        status: "active",
        providerCustomerId: "cus_demo_dunning",
        currency: "USD",
        providerCreatedAt: at(150 * DAY),
        canceledAt: null,
        currentPeriodStart: at(10 * DAY),
        currentPeriodEnd: at(-20 * DAY), // still in its current period
      },
      {
        ...base,
        providerId: "sub_demo_healthy",
        status: "active",
        providerCustomerId: "cus_demo_healthy1",
        currency: "USD",
        providerCreatedAt: at(90 * DAY),
        canceledAt: null,
        currentPeriodStart: at(6 * DAY),
        currentPeriodEnd: at(-24 * DAY),
      },
    ]);

    // --- Invoices ---------------------------------------------------------
    await tx.insert(providerInvoices).values([
      // Rule 8: paid AFTER the subscription was cancelled.
      {
        ...base,
        providerId: "in_demo_paid_cancelled",
        status: "paid",
        amountDueMinor: 14900n,
        amountPaidMinor: 14900n,
        currency: "USD",
        providerCustomerId: "cus_demo_cancelled",
        providerSubscriptionId: "sub_demo_cancelled",
        attemptCount: 1,
        providerCreatedAt: at(6 * DAY),
        paidAt: at(5 * DAY), // after canceledAt (20 days ago)
      },
      // Rule 9: repeatedly failing to collect while the subscription stays active.
      {
        ...base,
        providerId: "in_demo_failed_active",
        status: "open",
        amountDueMinor: 29900n,
        amountPaidMinor: 0n,
        currency: "USD",
        providerCustomerId: "cus_demo_dunning",
        providerSubscriptionId: "sub_demo_active_dunning",
        attemptCount: 4,
        providerCreatedAt: at(11 * DAY),
        paidAt: null,
      },
      // Healthy: paid invoice on an active subscription.
      {
        ...base,
        providerId: "in_demo_healthy",
        status: "paid",
        amountDueMinor: 4900n,
        amountPaidMinor: 4900n,
        currency: "USD",
        providerCustomerId: "cus_demo_healthy1",
        providerSubscriptionId: "sub_demo_healthy",
        attemptCount: 1,
        providerCreatedAt: at(6 * DAY),
        paidAt: at(6 * DAY),
      },
    ]);

    // --- Internal records -------------------------------------------------
    const records = [
      // Healthy matched pairs.
      {
        externalId: "ord_1001",
        customerId: "cus_demo_healthy1",
        providerTransactionId: "pi_demo_healthy_1",
        amountMinor: 4900n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(6 * DAY),
      },
      {
        externalId: "ord_1002",
        customerId: "cus_demo_healthy2",
        providerTransactionId: "pi_demo_healthy_2",
        amountMinor: 14900n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(5 * DAY),
      },
      {
        externalId: "ord_1003",
        customerId: "cus_demo_healthy1",
        providerTransactionId: "pi_demo_healthy_3",
        amountMinor: 250000n,
        currency: "JPY",
        status: "paid" as const,
        occurredAt: at(4 * DAY),
      },
      {
        externalId: "ord_1004",
        customerId: "cus_demo_healthy2",
        providerTransactionId: "pi_demo_failed_ok",
        amountMinor: 5900n,
        currency: "USD",
        status: "failed" as const,
        occurredAt: at(7 * DAY),
      },
      // Rule 2: linked to a succeeded payment but never advanced past pending.
      {
        externalId: "ord_2001",
        customerId: "cus_demo_notpaid",
        providerTransactionId: "pi_demo_not_paid",
        amountMinor: 12900n,
        currency: "USD",
        status: "pending" as const,
        occurredAt: at(2 * DAY),
      },
      // Rule 3: marked paid internally, but Stripe has no such payment.
      {
        externalId: "ord_3001",
        customerId: "cus_demo_ghost",
        providerTransactionId: "pi_demo_never_existed",
        amountMinor: 6400n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(8 * DAY),
      },
      // Rule 4: internal amount excludes tax.
      {
        externalId: "ord_4001",
        customerId: "cus_demo_amount",
        providerTransactionId: "pi_demo_amount_mismatch",
        amountMinor: 9900n, // Stripe captured 10800
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(4 * DAY),
      },
      // Rule 5: internal system assumed its default currency.
      {
        externalId: "ord_5001",
        customerId: "cus_demo_currency",
        providerTransactionId: "pi_demo_currency_mismatch",
        amountMinor: 8900n,
        currency: "USD", // Stripe settled in EUR
        status: "paid" as const,
        occurredAt: at(3 * DAY),
      },
      // Rule 6: both duplicate charges were recorded, so matching stays strong
      // and the duplicate is detected from the provider side.
      {
        externalId: "ord_6001",
        customerId: "cus_demo_duplicate",
        providerTransactionId: "pi_demo_duplicate_a",
        amountMinor: 24900n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(2 * DAY),
      },
      {
        externalId: "ord_6002",
        customerId: "cus_demo_duplicate",
        providerTransactionId: "pi_demo_duplicate_b",
        amountMinor: 24900n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(2 * DAY - 4 * MINUTE),
      },
      // Rule 7: refunded in Stripe, still paid internally.
      {
        externalId: "ord_7001",
        customerId: "cus_demo_refund",
        providerTransactionId: "pi_demo_refunded",
        amountMinor: 19900n,
        currency: "USD",
        status: "paid" as const,
        occurredAt: at(9 * DAY),
      },
      // Rule 10: pending far longer than any real payment takes, with no
      // corresponding provider payment at all.
      {
        externalId: "ord_10001",
        customerId: "cus_demo_stale",
        providerTransactionId: null,
        amountMinor: 3300n,
        currency: "USD",
        status: "pending" as const,
        occurredAt: at(6 * DAY),
      },
    ];

    await tx.insert(internalPaymentRecords).values(
      records.map((record) => ({
        organizationId,
        externalId: record.externalId,
        customerId: record.customerId,
        orderId: record.externalId,
        subscriptionId: null,
        providerTransactionId: record.providerTransactionId,
        amountMinor: record.amountMinor,
        currency: record.currency,
        status: record.status,
        occurredAt: record.occurredAt,
        recordUpdatedAt: record.occurredAt,
        metadata: {},
        source: "demo" as const,
      })),
    );

    await recordAudit(tx as unknown as Database, {
      organizationId,
      actor: options.actorUserId
        ? { type: "user", userId: options.actorUserId }
        : { type: "system" },
      action: "records.upserted",
      targetType: "demo_data",
      targetId: connectionId,
      metadata: {
        providerPayments: payments.length,
        internalRecords: records.length,
        note: "Demo dataset loaded",
      },
    });

    return {
      connectionId,
      providerPayments: payments.length,
      providerInvoices: 3,
      providerSubscriptions: 3,
      providerRefunds: 1,
      internalRecords: records.length,
    };
  });
}
