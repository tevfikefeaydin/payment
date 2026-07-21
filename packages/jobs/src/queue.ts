// pg-boss v12 ships a named export, not a default.
import { PgBoss } from "pg-boss";
import { z } from "zod";

/**
 * PostgreSQL-backed job queue.
 *
 * pg-boss stores jobs in the same database as the domain data, which means a
 * job and the rows it produces can be committed under one connection's
 * guarantees and no second broker has to be operated or backed up.
 *
 * Every job payload declares:
 *   - a zod schema, validated on BOTH enqueue and execution (a payload that
 *     was valid when queued can still be rejected after a deploy changes it),
 *   - tenant context (`organizationId`), which handlers re-verify rather than
 *     trust,
 *   - a singleton key where duplicate concurrent work would be wrong,
 *   - retry limits and backoff appropriate to the failure mode.
 */

export const QUEUE_NAMES = {
  reconciliationRun: "reconciliation.run",
  /** Periodic tick that fans out one reconciliation job per active organization. */
  reconciliationScheduleTick: "reconciliation.schedule-tick",
  stripeSync: "stripe.sync",
  importProcess: "import.process",
  notificationDispatch: "notification.dispatch",
  notificationSend: "notification.send-pending",
  retentionCleanup: "retention.cleanup",
  sessionCleanup: "session.cleanup",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

export const reconciliationRunPayload = z.object({
  organizationId: uuid,
  trigger: z.enum(["manual", "scheduled", "import", "sync"]),
  triggeredByUserId: uuid.nullable().optional(),
  correlationId: z.string().max(64).nullable().optional(),
});
export type ReconciliationRunPayload = z.infer<typeof reconciliationRunPayload>;

export const stripeSyncPayload = z.object({
  organizationId: uuid,
  connectionId: uuid,
  isInitial: z.boolean().default(false),
  correlationId: z.string().max(64).nullable().optional(),
});
export type StripeSyncPayload = z.infer<typeof stripeSyncPayload>;

export const importProcessPayload = z.object({
  organizationId: uuid,
  batchId: uuid,
  correlationId: z.string().max(64).nullable().optional(),
});
export type ImportProcessPayload = z.infer<typeof importProcessPayload>;

export const notificationDispatchPayload = z.object({
  organizationId: uuid,
  exceptionIds: z.array(uuid).min(1).max(500),
});
export type NotificationDispatchPayload = z.infer<typeof notificationDispatchPayload>;

export const emptyPayload = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

/**
 * Retry classes.
 *
 * `retryBackoff` gives pg-boss exponential growth; pg-boss also applies its own
 * jitter, which prevents a fleet of workers retrying in lockstep after a shared
 * outage (the thundering-herd failure mode).
 */
export const RETRY_POLICIES = {
  /** Network-ish work that usually succeeds on a later attempt. */
  network: { retryLimit: 6, retryDelay: 30, retryBackoff: true },
  /** Work that is expensive to repeat; fail visibly sooner. */
  compute: { retryLimit: 3, retryDelay: 60, retryBackoff: true },
  /** Delivery attempts, which have their own application-level backoff too. */
  delivery: { retryLimit: 5, retryDelay: 60, retryBackoff: true },
  /** Maintenance that will simply run again on its next schedule. */
  maintenance: { retryLimit: 1, retryDelay: 300, retryBackoff: false },
} as const;

let boss: PgBoss | null = null;

export interface QueueOptions {
  connectionString: string;
  /** Worker concurrency; the web tier only ever enqueues. */
  max?: number;
}

/**
 * Start (or reuse) the queue.
 *
 * Queues must exist before work can be sent to them in pg-boss v10+, so they are
 * created idempotently at startup by both the web tier and the worker.
 */
export async function getQueue(options: QueueOptions): Promise<PgBoss> {
  if (boss) return boss;

  // pg-boss owns its own schema so its tables never collide with the domain
  // schema and can be migrated independently.
  const instance = new PgBoss({
    connectionString: options.connectionString,
    max: options.max ?? 5,
    schema: "pgboss",
  });

  // An unhandled 'error' event would crash the process; log and keep serving.
  instance.on("error", (error: Error) => {
    console.error("[queue] error", { name: error.name, message: error.message });
  });

  await instance.start();

  for (const name of Object.values(QUEUE_NAMES)) {
    await instance.createQueue(name);
  }

  boss = instance;
  return instance;
}

export async function stopQueue(): Promise<void> {
  if (!boss) return;
  // Let in-flight jobs finish rather than relying on retries to recover work
  // that was moments from completing.
  await boss.stop({ graceful: true, close: true });
  boss = null;
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a reconciliation run.
 *
 * `singletonKey` is the organization id, so a burst of "run reconciliation"
 * clicks, a post-import trigger and the hourly schedule collapse into ONE queued
 * run per organization rather than stacking. This is the queue-level half of the
 * duplicate-work defence; the advisory lock in `persistCandidates` is the other.
 */
export async function enqueueReconciliation(
  queue: PgBoss,
  payload: ReconciliationRunPayload,
): Promise<string | null> {
  const data = reconciliationRunPayload.parse(payload);
  return queue.send(QUEUE_NAMES.reconciliationRun, data, {
    ...RETRY_POLICIES.compute,
    singletonKey: data.organizationId,
    expireInSeconds: 900,
  });
}

export async function enqueueStripeSync(
  queue: PgBoss,
  payload: StripeSyncPayload,
): Promise<string | null> {
  const data = stripeSyncPayload.parse(payload);
  return queue.send(QUEUE_NAMES.stripeSync, data, {
    ...RETRY_POLICIES.network,
    // One sync per connection at a time: concurrent syncs would fight over the
    // same checkpoint rows.
    singletonKey: data.connectionId,
    expireInSeconds: 1800,
  });
}

export async function enqueueImport(
  queue: PgBoss,
  payload: ImportProcessPayload,
): Promise<string | null> {
  const data = importProcessPayload.parse(payload);
  return queue.send(QUEUE_NAMES.importProcess, data, {
    ...RETRY_POLICIES.compute,
    singletonKey: data.batchId,
    expireInSeconds: 1800,
  });
}

export async function enqueueNotificationDispatch(
  queue: PgBoss,
  payload: NotificationDispatchPayload,
): Promise<string | null> {
  const data = notificationDispatchPayload.parse(payload);
  return queue.send(QUEUE_NAMES.notificationDispatch, data, RETRY_POLICIES.delivery);
}

/** Recurring schedules, registered by the worker at startup. */
export async function registerSchedules(
  queue: PgBoss,
  options: { reconciliationCron: string },
): Promise<void> {
  await queue.schedule(QUEUE_NAMES.notificationSend, "* * * * *", {}, RETRY_POLICIES.delivery);
  await queue.schedule(QUEUE_NAMES.retentionCleanup, "0 3 * * *", {}, RETRY_POLICIES.maintenance);
  await queue.schedule(QUEUE_NAMES.sessionCleanup, "30 3 * * *", {}, RETRY_POLICIES.maintenance);
  // One scheduled TICK fans out a job per organization. Registering one cron
  // entry per tenant would not scale, and would have to be reconciled every time
  // an organization is created or deleted.
  await queue.schedule(
    QUEUE_NAMES.reconciliationScheduleTick,
    options.reconciliationCron,
    {},
    RETRY_POLICIES.maintenance,
  );
}
