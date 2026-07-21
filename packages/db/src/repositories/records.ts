import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { internalPaymentRecords, usageCounters } from "../schema/ingestion";

/**
 * Internal payment record ingestion.
 *
 * UPSERT SEMANTICS: `(organization_id, external_id)` is the natural key. A
 * record that already exists is UPDATED in place. This makes a CSV re-import, an
 * API retry and a worker retry all idempotent — replaying the same payload
 * converges on the same rows rather than multiplying them.
 *
 * Fields absent from a later payload are left untouched rather than nulled, so a
 * partial update from one source cannot erase data supplied by another.
 */

export interface UpsertRecordInput {
  externalId: string;
  customerId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded" | "partially_refunded";
  occurredAt: Date;
  recordUpdatedAt: Date | null;
  metadata: Record<string, string>;
}

export interface UpsertOutcome {
  inserted: number;
  updated: number;
  total: number;
}

/**
 * Upsert a batch of records for ONE organization.
 *
 * Chunked so a large import cannot build a single oversized statement, and so
 * memory stays bounded regardless of file size.
 */
export async function upsertInternalRecords(
  db: Database,
  params: {
    organizationId: string;
    source: "csv" | "api" | "demo";
    records: UpsertRecordInput[];
    importBatchId?: string | null;
    chunkSize?: number;
  },
): Promise<UpsertOutcome> {
  const chunkSize = params.chunkSize ?? 500;
  let inserted = 0;
  let updated = 0;

  for (let offset = 0; offset < params.records.length; offset += chunkSize) {
    const chunk = params.records.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;

    const rows = await db
      .insert(internalPaymentRecords)
      .values(
        chunk.map((record) => ({
          organizationId: params.organizationId,
          externalId: record.externalId,
          customerId: record.customerId,
          orderId: record.orderId,
          subscriptionId: record.subscriptionId,
          providerTransactionId: record.providerTransactionId,
          amountMinor: record.amountMinor,
          currency: record.currency,
          status: record.status,
          occurredAt: record.occurredAt,
          recordUpdatedAt: record.recordUpdatedAt,
          metadata: record.metadata,
          source: params.source,
          importBatchId: params.importBatchId ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [internalPaymentRecords.organizationId, internalPaymentRecords.externalId],
        set: {
          customerId: sql`excluded.customer_id`,
          orderId: sql`excluded.order_id`,
          subscriptionId: sql`excluded.subscription_id`,
          providerTransactionId: sql`excluded.provider_transaction_id`,
          amountMinor: sql`excluded.amount_minor`,
          currency: sql`excluded.currency`,
          status: sql`excluded.status`,
          occurredAt: sql`excluded.occurred_at`,
          recordUpdatedAt: sql`excluded.record_updated_at`,
          metadata: sql`excluded.metadata`,
          source: sql`excluded.source`,
          importBatchId: sql`excluded.import_batch_id`,
          updatedAt: sql`now()`,
        },
      })
      // `xmax = 0` is true only for a freshly inserted tuple, which is how we
      // distinguish an insert from an update in a single round trip.
      .returning({ isInsert: sql<boolean>`(xmax = 0)` });

    for (const row of rows) {
      if (row.isInsert) inserted += 1;
      else updated += 1;
    }
  }

  return { inserted, updated, total: inserted + updated };
}

/**
 * Increment a monthly usage counter, used for plan-limit enforcement.
 * `period` is a UTC `YYYY-MM` key so month boundaries are unambiguous.
 */
export async function incrementUsage(
  db: Database,
  params: { organizationId: string; metric: string; amount: number; now?: Date },
): Promise<bigint> {
  const now = params.now ?? new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const [row] = await db
    .insert(usageCounters)
    .values({
      organizationId: params.organizationId,
      period,
      metric: params.metric,
      count: BigInt(params.amount),
    })
    .onConflictDoUpdate({
      target: [usageCounters.organizationId, usageCounters.period, usageCounters.metric],
      set: {
        count: sql`${usageCounters.count} + ${params.amount}`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ count: usageCounters.count });

  return row?.count ?? 0n;
}

export async function getUsage(
  db: Database,
  params: { organizationId: string; metric: string; now?: Date },
): Promise<bigint> {
  const now = params.now ?? new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, params.organizationId),
        eq(usageCounters.period, period),
        eq(usageCounters.metric, params.metric),
      ),
    )
    .limit(1);

  return row?.count ?? 0n;
}

export interface InternalRecordDetail {
  id: string;
  externalId: string;
  customerId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  occurredAt: Date;
  recordUpdatedAt: Date | null;
  metadata: unknown;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fetch ONE record by its natural key.
 *
 * `organizationId` is a required argument rather than an optional filter, so a
 * cross-tenant read is not expressible: an externalId that exists for another
 * organization simply returns null.
 */
export async function getInternalRecordByExternalId(
  db: Database,
  params: { organizationId: string; externalId: string },
): Promise<InternalRecordDetail | null> {
  const [row] = await db
    .select({
      id: internalPaymentRecords.id,
      externalId: internalPaymentRecords.externalId,
      customerId: internalPaymentRecords.customerId,
      orderId: internalPaymentRecords.orderId,
      subscriptionId: internalPaymentRecords.subscriptionId,
      providerTransactionId: internalPaymentRecords.providerTransactionId,
      amountMinor: internalPaymentRecords.amountMinor,
      currency: internalPaymentRecords.currency,
      status: internalPaymentRecords.status,
      occurredAt: internalPaymentRecords.occurredAt,
      recordUpdatedAt: internalPaymentRecords.recordUpdatedAt,
      metadata: internalPaymentRecords.metadata,
      source: internalPaymentRecords.source,
      createdAt: internalPaymentRecords.createdAt,
      updatedAt: internalPaymentRecords.updatedAt,
    })
    .from(internalPaymentRecords)
    .where(
      and(
        eq(internalPaymentRecords.organizationId, params.organizationId),
        eq(internalPaymentRecords.externalId, params.externalId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export interface RecordListItem {
  id: string;
  externalId: string;
  customerId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  occurredAt: Date;
  source: string;
  updatedAt: Date;
}

export async function listInternalRecords(
  db: Database,
  params: { organizationId: string; page?: number; pageSize?: number },
): Promise<{ items: RecordListItem[]; total: number }> {
  const pageSize = Math.min(Math.max(params.pageSize ?? 25, 1), 100);
  const page = Math.max(params.page ?? 1, 1);

  const items = await db
    .select({
      id: internalPaymentRecords.id,
      externalId: internalPaymentRecords.externalId,
      customerId: internalPaymentRecords.customerId,
      providerTransactionId: internalPaymentRecords.providerTransactionId,
      amountMinor: internalPaymentRecords.amountMinor,
      currency: internalPaymentRecords.currency,
      status: internalPaymentRecords.status,
      occurredAt: internalPaymentRecords.occurredAt,
      source: internalPaymentRecords.source,
      updatedAt: internalPaymentRecords.updatedAt,
    })
    .from(internalPaymentRecords)
    .where(eq(internalPaymentRecords.organizationId, params.organizationId))
    .orderBy(desc(internalPaymentRecords.occurredAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(internalPaymentRecords)
    .where(eq(internalPaymentRecords.organizationId, params.organizationId));

  return { items, total: countRow?.count ?? 0 };
}
