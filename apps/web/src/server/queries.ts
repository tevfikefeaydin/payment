import "server-only";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  exceptions,
  importBatches,
  internalPaymentRecords,
  reconciliationRuns,
  stripeConnections,
  syncCheckpoints,
} from "@payrecon/db";
import { db } from "./db";

/**
 * Read-only aggregates the dashboard and filter controls need but that no
 * repository owns.
 *
 * Every query takes `organizationId` and puts it in the WHERE clause. These are
 * called only from pages that have already proven membership via `requireOrg`,
 * and the id passed in is always the one from that verified context.
 */

export interface ConnectionFreshness {
  id: string;
  name: string;
  status: string;
  livemode: boolean;
  /** Newest successful checkpoint across all resources for this connection. */
  lastSuccessfulSyncAt: Date | null;
}

export interface ImportFreshness {
  id: string;
  filename: string;
  status: string;
  /** Finish time when the batch completed, otherwise when it was created. */
  at: Date;
}

export interface SourceFreshness {
  connections: ConnectionFreshness[];
  lastImport: ImportFreshness | null;
  internalRecords: { total: number; lastUpdatedAt: Date | null };
}

export async function getSourceFreshness(organizationId: string): Promise<SourceFreshness> {
  const database = db();

  const connectionRows = await database
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
        isNull(stripeConnections.deletedAt),
      ),
    )
    .orderBy(stripeConnections.createdAt);

  // One row per connection: the most recent resource-level success. A per-resource
  // breakdown belongs on the sources page, not the dashboard summary.
  const checkpointRows = await database
    .select({
      connectionId: syncCheckpoints.connectionId,
      lastSuccessfulAt: sql<Date | null>`max(${syncCheckpoints.lastSuccessfulAt})`,
    })
    .from(syncCheckpoints)
    .where(eq(syncCheckpoints.organizationId, organizationId))
    .groupBy(syncCheckpoints.connectionId);

  const lastSyncByConnection = new Map(
    checkpointRows.map((row) => [row.connectionId, row.lastSuccessfulAt]),
  );

  const [lastImportRow] = await database
    .select({
      id: importBatches.id,
      filename: importBatches.filename,
      status: importBatches.status,
      finishedAt: importBatches.finishedAt,
      createdAt: importBatches.createdAt,
    })
    .from(importBatches)
    .where(eq(importBatches.organizationId, organizationId))
    .orderBy(desc(importBatches.createdAt))
    .limit(1);

  const [recordStats] = await database
    .select({
      total: sql<number>`count(*)::int`,
      lastUpdatedAt: sql<Date | null>`max(${internalPaymentRecords.updatedAt})`,
    })
    .from(internalPaymentRecords)
    .where(eq(internalPaymentRecords.organizationId, organizationId));

  return {
    connections: connectionRows.map((connection) => ({
      ...connection,
      lastSuccessfulSyncAt: lastSyncByConnection.get(connection.id) ?? null,
    })),
    lastImport: lastImportRow
      ? {
          id: lastImportRow.id,
          filename: lastImportRow.filename,
          status: lastImportRow.status,
          at: lastImportRow.finishedAt ?? lastImportRow.createdAt,
        }
      : null,
    internalRecords: {
      total: recordStats?.total ?? 0,
      lastUpdatedAt: recordStats?.lastUpdatedAt ?? null,
    },
  };
}

export interface DataPresence {
  exceptions: number;
  internalRecords: number;
  connections: number;
  runs: number;
  /** True when the organization has never ingested or produced anything. */
  isEmpty: boolean;
}

/**
 * Decide whether to show the first-run empty state.
 *
 * "Empty" means no inputs AND no outputs. An organization that has run
 * reconciliation and legitimately found nothing is NOT empty — telling it to
 * load demo data would be wrong.
 */
export async function getDataPresence(organizationId: string): Promise<DataPresence> {
  const database = db();

  const count = async (
    table: typeof exceptions | typeof internalPaymentRecords | typeof reconciliationRuns,
  ): Promise<number> => {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.organizationId, organizationId));
    return row?.count ?? 0;
  };

  const [exceptionCount, recordCount, runCount] = await Promise.all([
    count(exceptions),
    count(internalPaymentRecords),
    count(reconciliationRuns),
  ]);

  const [connectionRow] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.organizationId, organizationId),
        isNull(stripeConnections.deletedAt),
      ),
    );
  const connectionCount = connectionRow?.count ?? 0;

  return {
    exceptions: exceptionCount,
    internalRecords: recordCount,
    connections: connectionCount,
    runs: runCount,
    isEmpty: exceptionCount === 0 && recordCount === 0 && connectionCount === 0 && runCount === 0,
  };
}

/** Currencies actually present in this organization's exceptions, for the filter. */
export async function listExceptionCurrencies(organizationId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ currency: exceptions.currency })
    .from(exceptions)
    .where(and(eq(exceptions.organizationId, organizationId), isNotNull(exceptions.currency)))
    .orderBy(exceptions.currency);

  return rows.flatMap((row) => (row.currency ? [row.currency] : []));
}
