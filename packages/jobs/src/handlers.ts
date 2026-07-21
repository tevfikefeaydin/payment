import type { PgBoss, Job } from "pg-boss";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  importBatches,
  organizations,
  recordAudit,
  runReconciliationForOrganization,
  type Database,
} from "@payrecon/db";
import { purgeDeadSessions } from "@payrecon/auth";
import { errorCategory, redactSecretsInText } from "@payrecon/domain";
import {
  QUEUE_NAMES,
  emptyPayload,
  enqueueReconciliation,
  reconciliationRunPayload,
  type ReconciliationRunPayload,
} from "./queue";
import {
  handleImportProcess,
  handleNotificationDispatch,
  handleNotificationSend,
  handleStripeSync,
  type IntegrationDeps,
} from "./worker-handlers";

/**
 * Job handlers.
 *
 * Every handler:
 *   1. re-validates its payload (a deploy can change the schema after enqueue),
 *   2. re-derives tenant context from the database rather than trusting the
 *      payload's organization id blindly,
 *   3. is idempotent, because pg-boss guarantees at-least-once delivery,
 *   4. lets genuinely transient failures throw so the queue can retry, while
 *      recording permanent failures where an operator can see them.
 */

export interface HandlerDeps {
  db: Database;
  queue: PgBoss;
  reconciliationCron: string;
  /**
   * Configuration for the handlers that reach outside the database (Stripe
   * sync, CSV import, notification delivery). Omit to run a worker that only
   * performs reconciliation and maintenance.
   */
  integrations?: IntegrationDeps;
}

/** Confirm the organization still exists and is not deleted. */
async function assertLiveOrganization(db: Database, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .limit(1);
  return Boolean(row);
}

export async function handleReconciliationRun(deps: HandlerDeps, raw: unknown): Promise<void> {
  const payload: ReconciliationRunPayload = reconciliationRunPayload.parse(raw);

  // A run queued before the organization was deleted must not resurrect it.
  if (!(await assertLiveOrganization(deps.db, payload.organizationId))) return;

  await runReconciliationForOrganization(deps.db, {
    organizationId: payload.organizationId,
    trigger: payload.trigger,
    triggeredByUserId: payload.triggeredByUserId ?? null,
    correlationId: payload.correlationId ?? null,
  });
}

/**
 * Fan out scheduled reconciliation.
 *
 * Enqueuing per organization (rather than reconciling them all inside this one
 * job) means a single slow tenant cannot delay everyone else, and each run gets
 * its own retry budget.
 */
export async function handleReconciliationScheduleTick(deps: HandlerDeps): Promise<void> {
  const rows = await deps.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  for (const row of rows) {
    await enqueueReconciliation(deps.queue, {
      organizationId: row.id,
      trigger: "scheduled",
      triggeredByUserId: null,
    });
  }
}

/**
 * Retention cleanup.
 *
 * Removes the raw uploaded CSV content once it is older than the organization's
 * retention window. The BATCH and its row-level errors are kept — an operator
 * still needs to see that an import happened and what failed — but the source
 * file, which is the part containing customer data, does not need to persist.
 *
 * Audit rows are never touched here; they are append-only and are removed only
 * by the privileged purge path.
 */
export async function handleRetentionCleanup(deps: HandlerDeps): Promise<void> {
  const orgs = await deps.db
    .select({ id: organizations.id, retentionDays: organizations.retentionDays })
    .from(organizations)
    .where(isNull(organizations.deletedAt));

  for (const org of orgs) {
    const cutoff = new Date(Date.now() - org.retentionDays * 24 * 60 * 60 * 1000);

    const cleared = await deps.db
      .update(importBatches)
      .set({ rawContent: null })
      .where(
        and(
          eq(importBatches.organizationId, org.id),
          lt(importBatches.createdAt, cutoff),
          sql`${importBatches.rawContent} is not null`,
        ),
      )
      .returning({ id: importBatches.id });

    if (cleared.length > 0) {
      await recordAudit(deps.db, {
        organizationId: org.id,
        actor: { type: "system" },
        action: "retention.cleanup_ran",
        targetType: "import_batches",
        metadata: {
          clearedBatches: cleared.length,
          retentionDays: org.retentionDays,
        },
      });
    }
  }
}

/** Remove long-dead sessions so the table does not grow without bound. */
export async function handleSessionCleanup(deps: HandlerDeps): Promise<void> {
  await purgeDeadSessions(deps.db, 30);
}

/**
 * Register every handler with the queue.
 *
 * pg-boss delivers an ARRAY of jobs to a handler. Each job is processed
 * independently so that one bad payload cannot fail its whole batch.
 */
export async function registerHandlers(deps: HandlerDeps): Promise<void> {
  const work = async (name: string, handler: (raw: unknown) => Promise<void>): Promise<void> => {
    await deps.queue.work<unknown>(name, { batchSize: 1 }, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        try {
          await handler(job.data);
        } catch (error) {
          // Log a sanitised summary, then rethrow so pg-boss applies its retry
          // policy and, on exhaustion, records a terminal failure.
          console.error("[worker] job failed", {
            queue: name,
            jobId: job.id,
            category: errorCategory(error),
            message:
              error instanceof Error ? redactSecretsInText(error.message).slice(0, 300) : "unknown",
          });
          throw error;
        }
      }
    });
  };

  await work(QUEUE_NAMES.reconciliationRun, (raw) => handleReconciliationRun(deps, raw));
  await work(QUEUE_NAMES.reconciliationScheduleTick, async (raw) => {
    emptyPayload.parse(raw ?? {});
    await handleReconciliationScheduleTick(deps);
  });
  await work(QUEUE_NAMES.retentionCleanup, async () => handleRetentionCleanup(deps));
  await work(QUEUE_NAMES.sessionCleanup, async () => handleSessionCleanup(deps));

  // Integration handlers are optional: a deployment that has not configured the
  // integrations still runs reconciliation. Without this, those queues would
  // accept jobs that nothing ever consumes — a silent backlog.
  if (deps.integrations) {
    const integrations = deps.integrations;
    await work(QUEUE_NAMES.stripeSync, (raw) => handleStripeSync(integrations, raw));
    await work(QUEUE_NAMES.importProcess, (raw) => handleImportProcess(integrations, raw));
    await work(QUEUE_NAMES.notificationDispatch, (raw) =>
      handleNotificationDispatch(integrations, raw),
    );
    await work(QUEUE_NAMES.notificationSend, async () => handleNotificationSend(integrations));
  }
}
