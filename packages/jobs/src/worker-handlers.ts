import { and, eq } from "drizzle-orm";
import {
  getException,
  importBatches,
  importRowErrors,
  recordAudit,
  stripeConnections,
  upsertInternalRecords,
  type Database,
} from "@payrecon/db";
import { getKeyring } from "@payrecon/auth";
import { redactSecretsInText } from "@payrecon/domain";
import {
  createDrizzleStore,
  createTransportFactory,
  loadCredential,
  runSync,
} from "@payrecon/stripe-customer-data";
import {
  createDrizzleNotificationStore,
  createTransports,
  enqueueForException,
  sendPendingDeliveries,
} from "@payrecon/notifications";
import { parseAndValidate, type CsvMapping } from "@payrecon/ingestion";
import { importProcessPayload, notificationDispatchPayload, stripeSyncPayload } from "./queue";

/**
 * Handlers for the work that reaches out beyond the database: Stripe
 * synchronisation, CSV import processing and notification delivery.
 *
 * These live in their own module because they pull in the heavier integration
 * packages; keeping them separate means the core reconciliation handler stays
 * cheap to load and reason about.
 *
 * Every handler re-validates its payload and re-derives tenant context from the
 * database rather than trusting the queued job.
 */

export interface IntegrationDeps {
  db: Database;
  appUrl: string;
  smtp: {
    host?: string | undefined;
    port: number;
    user?: string | undefined;
    password?: string | undefined;
    secure: boolean;
    from: string;
  };
  stripeTransport: "live" | "fake";
  stripeRateLimitRps: number;
}

// ---------------------------------------------------------------------------
// Stripe synchronisation
// ---------------------------------------------------------------------------

/**
 * Synchronise one customer Stripe connection.
 *
 * The connection is re-read under its organization id, so a job whose payload
 * named another tenant's connection simply finds nothing and exits.
 */
export async function handleStripeSync(deps: IntegrationDeps, raw: unknown): Promise<void> {
  const payload = stripeSyncPayload.parse(raw);

  const [connection] = await deps.db
    .select({
      id: stripeConnections.id,
      status: stripeConnections.status,
      livemode: stripeConnections.livemode,
    })
    .from(stripeConnections)
    .where(
      and(
        eq(stripeConnections.organizationId, payload.organizationId),
        eq(stripeConnections.id, payload.connectionId),
      ),
    )
    .limit(1);

  // A deleted or disabled connection must not keep syncing.
  if (!connection || connection.status !== "active") return;

  const store = createDrizzleStore(deps.db);

  // Decrypting happens here and nowhere wider: the key goes straight into the
  // transport and is never returned, logged or stored.
  const restrictedKey = await loadCredential(store, {
    organizationId: payload.organizationId,
    connectionId: payload.connectionId,
    keyring: getKeyring(),
  });

  // A revoked credential yields no key. That is a normal end state for a
  // disabled connection, not a transient failure worth retrying.
  if (!restrictedKey) return;

  // The factory may build the transport asynchronously (the live transport
  // resolves its client lazily), so await regardless of which one is selected.
  const transport = await createTransportFactory()({
    restrictedKey,
    livemode: connection.livemode,
  });

  await runSync(store, {
    organizationId: payload.organizationId,
    connectionId: payload.connectionId,
    transport,
    isInitial: payload.isInitial,
    now: new Date(),
  });
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

/**
 * Process an uploaded CSV batch.
 *
 * Runs in the worker because a large file must not hold a browser request open.
 * Idempotent: the upsert targets `(organization_id, external_id)`, so a retried
 * job converges on the same rows rather than duplicating them, and the row-error
 * table is cleared before being rewritten.
 */
export async function handleImportProcess(deps: IntegrationDeps, raw: unknown): Promise<void> {
  const payload = importProcessPayload.parse(raw);

  const [batch] = await deps.db
    .select({
      id: importBatches.id,
      status: importBatches.status,
      mapping: importBatches.mapping,
      rawContent: importBatches.rawContent,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, payload.organizationId),
        eq(importBatches.id, payload.batchId),
      ),
    )
    .limit(1);

  if (!batch) return;
  // Already finished: a duplicate delivery must not reprocess and double-count.
  if (batch.status === "completed" || batch.status === "completed_with_errors") return;

  if (!batch.mapping || !batch.rawContent) {
    await deps.db
      .update(importBatches)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage: batch.rawContent
          ? "No column mapping was supplied for this import."
          : "The uploaded file is no longer available (it may have passed its retention window).",
      })
      .where(eq(importBatches.id, batch.id));
    return;
  }

  await deps.db
    .update(importBatches)
    .set({ status: "processing", startedAt: new Date() })
    .where(eq(importBatches.id, batch.id));

  try {
    const result = await parseAndValidate(batch.rawContent, batch.mapping as CsvMapping);

    // Clear previous errors so a retry does not accumulate duplicates.
    await deps.db.delete(importRowErrors).where(eq(importRowErrors.batchId, batch.id));

    if (result.errors.length > 0) {
      // Chunked: a file with thousands of bad rows must not build one huge insert.
      for (let offset = 0; offset < result.errors.length; offset += 500) {
        await deps.db.insert(importRowErrors).values(
          result.errors.slice(offset, offset + 500).map((error) => ({
            organizationId: payload.organizationId,
            batchId: batch.id,
            rowNumber: error.rowNumber,
            column: error.column,
            message: error.message,
            valueExcerpt: error.valueExcerpt,
          })),
        );
      }
    }

    const outcome =
      result.records.length > 0
        ? await upsertInternalRecords(deps.db, {
            organizationId: payload.organizationId,
            source: "csv",
            records: result.records,
            importBatchId: batch.id,
          })
        : { inserted: 0, updated: 0, total: 0 };

    await deps.db
      .update(importBatches)
      .set({
        status: result.errors.length > 0 ? "completed_with_errors" : "completed",
        finishedAt: new Date(),
        totalRows: result.totalRows,
        validRows: result.records.length,
        errorRows: result.errors.length,
        insertedRows: outcome.inserted,
        updatedRows: outcome.updated,
      })
      .where(eq(importBatches.id, batch.id));

    await recordAudit(deps.db, {
      organizationId: payload.organizationId,
      actor: { type: "system" },
      action: "import.completed",
      targetType: "import_batch",
      targetId: batch.id,
      correlationId: payload.correlationId ?? null,
      metadata: {
        totalRows: result.totalRows,
        validRows: result.records.length,
        errorRows: result.errors.length,
        inserted: outcome.inserted,
        updated: outcome.updated,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? redactSecretsInText(error.message) : "unknown error";
    await deps.db
      .update(importBatches)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: message.slice(0, 500) })
      .where(eq(importBatches.id, batch.id));

    await recordAudit(deps.db, {
      organizationId: payload.organizationId,
      actor: { type: "system" },
      action: "import.failed",
      targetType: "import_batch",
      targetId: batch.id,
      correlationId: payload.correlationId ?? null,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Fan newly actionable exceptions out to the organization's notification
 * policies. Enqueuing is deduplicated on `(organization_id, dedupe_key)`, so a
 * retried job cannot notify twice for the same exception and window.
 */
export async function handleNotificationDispatch(
  deps: IntegrationDeps,
  raw: unknown,
): Promise<void> {
  const payload = notificationDispatchPayload.parse(raw);
  const store = createDrizzleNotificationStore(deps.db);
  const now = new Date();

  // Read the exceptions back under their organization id rather than trusting
  // severity/amount from the job payload: the exception may have been refreshed
  // by a later reconciliation run between enqueue and delivery.
  for (const exceptionId of payload.exceptionIds) {
    const exception = await getException(deps.db, payload.organizationId, exceptionId);
    if (!exception) continue;

    await enqueueForException(store, {
      organizationId: payload.organizationId,
      exceptionId: exception.id,
      severity: exception.severity,
      revenueAtRiskMinor: exception.revenueAtRiskMinor,
      currency: exception.currency,
      now,
    });
  }
}

/** Deliver everything that is due. Scheduled every minute. */
export async function handleNotificationSend(deps: IntegrationDeps): Promise<void> {
  const store = createDrizzleNotificationStore(deps.db);

  await sendPendingDeliveries(store, {
    now: new Date(),
    transports: createTransports({ email: deps.smtp }),
    keyring: getKeyring(),
    appUrl: deps.appUrl,
  });
}
