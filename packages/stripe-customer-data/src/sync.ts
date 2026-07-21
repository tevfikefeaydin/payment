/**
 * Incremental, resumable synchronisation of a customer's Stripe data.
 *
 * READ-ONLY CONTEXT: every Stripe interaction reachable from this file is a list
 * or retrieve. No code path here creates, updates, deletes, refunds or replays
 * anything in the customer's Stripe account.
 *
 * Three invariants shape the whole file, and every design choice below follows
 * from one of them:
 *
 *  1. IDEMPOTENT. Upserts target `(organization_id, provider_id)`, so running the
 *     same sync twice produces the same rows. That is what makes it safe to
 *     re-read pages after a failure instead of trying to resume mid-page.
 *
 *  2. CHECKPOINTS ONLY MOVE ON CLEAN COMPLETION. `lastAttemptedAt` is written
 *     before any page is fetched, so a failed run is always visible. Nothing
 *     else — cursor, `syncedThrough`, `lastSuccessfulAt` — moves unless the
 *     resource finished its whole sweep. A failure on page 7 therefore cannot
 *     advance the window past unread data, and cannot discard the checkpoint an
 *     earlier successful run earned. Re-reading pages 1-6 is cheap precisely
 *     because of invariant 1.
 *
 *  3. RESOURCES ARE INDEPENDENT. One failing resource must not abort the others
 *     or delete anything already synced; the run simply ends `partial`.
 */
import { PublicError, normalizeCurrency, redactSecretsInText } from "@payrecon/domain";
import type { AuditActor } from "@payrecon/db";
import { classifyStripeError, sanitizeMessage, type StripeErrorCategory } from "./errors";
import {
  DEFAULT_RETRY_POLICY,
  defaultSleep,
  withRetry,
  type RetryPolicy,
  type SleepFn,
} from "./retry";
import {
  resolveStore,
  type ProviderRowsByResource,
  type ProviderInvoiceStatus,
  type ProviderPaymentStatus,
  type ProviderRefundStatus,
  type ProviderSubscriptionStatus,
  type StripeDataStore,
  type StripeDataStoreLike,
  type SyncStatus,
} from "./store";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SYNC_RESOURCE_ORDER,
  listResource,
  type StripeChargeDto,
  type StripeCustomerDto,
  type StripeDisputeDto,
  type StripeInvoiceDto,
  type StripePaymentIntentDto,
  type StripePayoutDto,
  type StripeReadTransport,
  type StripeRefundDto,
  type StripeSubscriptionDto,
  type StripeBalanceTransactionDto,
  type SyncResource,
} from "./transport";

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------
//
// Stripe's vocabulary is wider than the enums in packages/db/src/schema/enums.ts
// and it grows over time. Every mapper returns `null` for a value it does not
// recognise, and the caller SKIPS that record rather than guessing. Inventing a
// status for an unknown value would fabricate financial state — a reconciliation
// product must under-report rather than assert something it cannot support.

function mapPaymentIntentStatus(status: string): ProviderPaymentStatus | null {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "processing":
      // A captured-but-unsettled intent is still in flight for our purposes.
      return "processing";
    case "requires_capture":
      return "processing";
    case "requires_action":
    case "requires_confirmation":
      return "requires_action";
    case "requires_payment_method":
      return "requires_payment_method";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

function mapChargeStatus(status: string): ProviderPaymentStatus | null {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "pending":
      return "processing";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function mapRefundStatus(status: string | null): ProviderRefundStatus | null {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "pending":
    case "requires_action":
      return "pending";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

function mapInvoiceStatus(status: string | null): ProviderInvoiceStatus | null {
  switch (status) {
    case "draft":
      return "draft";
    case "open":
      return "open";
    case "paid":
      return "paid";
    case "uncollectible":
      return "uncollectible";
    case "void":
      return "void";
    default:
      return null;
  }
}

function mapSubscriptionStatus(status: string): ProviderSubscriptionStatus | null {
  switch (status) {
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return status;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

const MAX_METADATA_KEYS = 10;
const MAX_METADATA_VALUE_LENGTH = 200;

/**
 * Keep a bounded, non-sensitive slice of Stripe metadata.
 *
 * Metadata is customer-controlled free text. It is worth keeping because it is
 * where an application's own order id usually lives, but it must not become an
 * unbounded dumping ground: keys are sorted (so the stored subset is stable
 * rather than dependent on object key order), values are truncated, and anything
 * credential-shaped is redacted.
 */
export function boundMetadata(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(metadata).sort().slice(0, MAX_METADATA_KEYS)) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    out[key] = redactSecretsInText(value).slice(0, MAX_METADATA_VALUE_LENGTH);
  }
  return out;
}

/** Uppercase ISO code, or null when Stripe sent something unusable. */
function safeCurrency(currency: string): string | null {
  try {
    return normalizeCurrency(currency);
  } catch {
    return null;
  }
}

/**
 * Cross-resource facts gathered earlier in the same run.
 *
 * A payment intent carries no refunded amount and no dispute flag of its own, so
 * `SYNC_RESOURCE_ORDER` sweeps refunds and disputes first and the totals land
 * here. When those resources fail, the maps stay empty and payments are stored
 * with a zero refund total rather than a wrong one.
 */
interface SyncContext {
  refundedByPaymentId: Map<string, bigint>;
  disputedPaymentIds: Set<string>;
}

function createSyncContext(): SyncContext {
  return { refundedByPaymentId: new Map(), disputedPaymentIds: new Set() };
}

interface NormalizedBatch {
  rows: Array<ProviderRowsByResource[SyncResource]>;
  /** Records dropped because a status or currency could not be mapped. */
  skipped: number;
}

/**
 * Convert a page of DTOs into rows, dropping anything that cannot be represented
 * faithfully. Also feeds `context` from the resources that other resources need.
 */
function normalizeBatch(
  resource: SyncResource,
  dtos: readonly unknown[],
  context: SyncContext,
): NormalizedBatch {
  const rows: Array<ProviderRowsByResource[SyncResource]> = [];
  let skipped = 0;

  switch (resource) {
    case "customers": {
      for (const dto of dtos as readonly StripeCustomerDto[]) {
        rows.push({
          providerId: dto.id,
          email: dto.email,
          name: dto.name,
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "refunds": {
      for (const dto of dtos as readonly StripeRefundDto[]) {
        const status = mapRefundStatus(dto.status);
        const currency = safeCurrency(dto.currency);
        if (!status || !currency) {
          skipped += 1;
          continue;
        }
        // Only settled refunds reduce what a payment is worth.
        if (status === "succeeded") {
          for (const paymentId of [dto.chargeId, dto.paymentIntentId]) {
            if (!paymentId) continue;
            const running = context.refundedByPaymentId.get(paymentId) ?? 0n;
            context.refundedByPaymentId.set(paymentId, running + dto.amountMinor);
          }
        }
        rows.push({
          providerId: dto.id,
          providerPaymentId: dto.chargeId ?? dto.paymentIntentId,
          amountMinor: dto.amountMinor,
          currency,
          status,
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "disputes": {
      for (const dto of dtos as readonly StripeDisputeDto[]) {
        const currency = safeCurrency(dto.currency);
        if (!currency) {
          skipped += 1;
          continue;
        }
        if (dto.chargeId) context.disputedPaymentIds.add(dto.chargeId);
        if (dto.paymentIntentId) context.disputedPaymentIds.add(dto.paymentIntentId);
        rows.push({
          providerId: dto.id,
          providerPaymentId: dto.chargeId ?? dto.paymentIntentId,
          amountMinor: dto.amountMinor,
          currency,
          status: dto.status,
          reason: dto.reason,
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "payment_intents": {
      for (const dto of dtos as readonly StripePaymentIntentDto[]) {
        const status = mapPaymentIntentStatus(dto.status);
        const currency = safeCurrency(dto.currency);
        if (!status || !currency) {
          skipped += 1;
          continue;
        }
        rows.push({
          providerId: dto.id,
          kind: "payment_intent",
          status,
          amountMinor: dto.amountMinor,
          // Stripe exposes no refunded total on an intent; it is derived from
          // the refunds swept earlier in this run.
          amountRefundedMinor: context.refundedByPaymentId.get(dto.id) ?? 0n,
          currency,
          providerCustomerId: dto.customerId,
          providerInvoiceId: dto.invoiceId,
          paymentIntentId: dto.id,
          disputed: context.disputedPaymentIds.has(dto.id),
          metadata: boundMetadata(dto.metadata),
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "charges": {
      for (const dto of dtos as readonly StripeChargeDto[]) {
        const status = mapChargeStatus(dto.status);
        const currency = safeCurrency(dto.currency);
        if (!status || !currency) {
          skipped += 1;
          continue;
        }
        // Stripe's own figure wins; the accumulated total is a floor, covering
        // the case where a refund is newer than the charge page we hold.
        const accumulated = context.refundedByPaymentId.get(dto.id) ?? 0n;
        const refunded =
          dto.amountRefundedMinor > accumulated ? dto.amountRefundedMinor : accumulated;
        rows.push({
          providerId: dto.id,
          kind: "charge",
          status,
          amountMinor: dto.amountMinor,
          amountRefundedMinor: refunded,
          currency,
          providerCustomerId: dto.customerId,
          providerInvoiceId: dto.invoiceId,
          paymentIntentId: dto.paymentIntentId,
          disputed: dto.disputed || context.disputedPaymentIds.has(dto.id),
          metadata: boundMetadata(dto.metadata),
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "invoices": {
      for (const dto of dtos as readonly StripeInvoiceDto[]) {
        const status = mapInvoiceStatus(dto.status);
        const currency = safeCurrency(dto.currency);
        if (!status || !currency) {
          skipped += 1;
          continue;
        }
        rows.push({
          providerId: dto.id,
          status,
          amountDueMinor: dto.amountDueMinor,
          amountPaidMinor: dto.amountPaidMinor,
          currency,
          providerCustomerId: dto.customerId,
          providerSubscriptionId: dto.subscriptionId,
          attemptCount: dto.attemptCount,
          providerCreatedAt: dto.created,
          paidAt: dto.paidAt,
        });
      }
      break;
    }

    case "subscriptions": {
      for (const dto of dtos as readonly StripeSubscriptionDto[]) {
        const status = mapSubscriptionStatus(dto.status);
        const currency = safeCurrency(dto.currency);
        if (!status || !currency) {
          skipped += 1;
          continue;
        }
        rows.push({
          providerId: dto.id,
          status,
          providerCustomerId: dto.customerId,
          currency,
          providerCreatedAt: dto.created,
          canceledAt: dto.canceledAt,
          currentPeriodStart: dto.currentPeriodStart,
          currentPeriodEnd: dto.currentPeriodEnd,
        });
      }
      break;
    }

    case "balance_transactions": {
      for (const dto of dtos as readonly StripeBalanceTransactionDto[]) {
        const currency = safeCurrency(dto.currency);
        if (!currency) {
          skipped += 1;
          continue;
        }
        rows.push({
          providerId: dto.id,
          type: dto.type,
          amountMinor: dto.amountMinor,
          feeMinor: dto.feeMinor,
          netMinor: dto.netMinor,
          currency,
          sourceId: dto.sourceId,
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    case "payouts": {
      for (const dto of dtos as readonly StripePayoutDto[]) {
        const currency = safeCurrency(dto.currency);
        if (!currency) {
          skipped += 1;
          continue;
        }
        rows.push({
          providerId: dto.id,
          amountMinor: dto.amountMinor,
          currency,
          status: dto.status,
          arrivalDate: dto.arrivalDate,
          providerCreatedAt: dto.created,
        });
      }
      break;
    }

    default: {
      const unreachable: never = resource;
      throw new Error(`Unsupported sync resource: ${String(unreachable)}`);
    }
  }

  return { rows, skipped };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface ResourceSyncStat {
  status: "succeeded" | "failed";
  fetched: number;
  upserted: number;
  /** Records dropped because they could not be normalised faithfully. */
  skipped: number;
  pages: number;
  /** Transport calls made, including retries. */
  attempts: number;
  errorCategory?: StripeErrorCategory;
  /** Sanitised. Never contains key material or a raw payload. */
  errorMessage?: string;
}

export type SyncRunStatus = Extract<SyncStatus, "succeeded" | "failed" | "partial">;

export interface SyncRunResult {
  runId: string;
  status: SyncRunStatus;
  stats: Partial<Record<SyncResource, ResourceSyncStat>>;
  errorCategory: string | null;
  errorMessage: string | null;
}

export interface RunSyncInput {
  organizationId: string;
  connectionId: string;
  transport: StripeReadTransport;
  /** True for a full backfill: the stored window is ignored. */
  isInitial: boolean;
  /** Injected so runs are deterministic and testable. */
  now: Date;
  resources?: readonly SyncResource[];
  pageSize?: number;
  retryPolicy?: RetryPolicy;
  /** Injected so tests never actually wait through a backoff. */
  sleep?: SleepFn;
  /** Injected so jitter is reproducible in tests. */
  random?: () => number;
  actor?: AuditActor;
  /** Hard ceiling per resource, so a misbehaving transport cannot loop forever. */
  maxPagesPerResource?: number;
}

const DEFAULT_MAX_PAGES_PER_RESOURCE = 1_000;

/** Most-actionable-first, used to pick one category to summarise a run. */
const CATEGORY_SEVERITY: readonly StripeErrorCategory[] = [
  "auth",
  "permission",
  "permanent",
  "rate_limited",
  "transient",
];

export async function runSync(
  db: StripeDataStoreLike,
  input: RunSyncInput,
): Promise<SyncRunResult> {
  const store = resolveStore(db);
  const {
    organizationId,
    connectionId,
    transport,
    isInitial,
    now,
    actor = { type: "system" } satisfies AuditActor,
  } = input;

  // Tenant check before anything else: a connection id from another
  // organization must not even produce a sync_runs row.
  const connection = await store.findConnection(organizationId, connectionId);
  if (!connection || connection.deletedAt !== null) {
    throw new PublicError("connection_not_found", "That Stripe connection does not exist.", 404);
  }

  const resources = input.resources ?? SYNC_RESOURCE_ORDER;
  const pageSize = Math.min(Math.max(input.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const maxPages = input.maxPagesPerResource ?? DEFAULT_MAX_PAGES_PER_RESOURCE;
  const retryPolicy = input.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const sleep = input.sleep ?? defaultSleep;
  const random = input.random ?? Math.random;

  const run = await store.insertSyncRun({
    organizationId,
    connectionId,
    status: "running",
    isInitial,
    startedAt: now,
    now,
  });

  await store.recordAuditEvent({
    organizationId,
    actor,
    action: "sync.started",
    targetType: "stripe_connection",
    targetId: connectionId,
    metadata: { runId: run.id, isInitial, resources: [...resources] },
  });

  const context = createSyncContext();
  const stats: Partial<Record<SyncResource, ResourceSyncStat>> = {};

  // Sequential on purpose: resources share one Stripe rate-limit budget, and
  // payments depend on refunds and disputes having been swept first.
  for (const resource of resources) {
    stats[resource] = await syncOneResource({
      store,
      organizationId,
      connectionId,
      resource,
      transport,
      context,
      isInitial,
      now,
      pageSize,
      maxPages,
      retryPolicy,
      sleep,
      random,
    });
  }

  const attempted = resources.length;
  const failures = resources
    .map((resource) => ({ resource, stat: stats[resource] }))
    .filter(
      (entry): entry is { resource: SyncResource; stat: ResourceSyncStat } =>
        entry.stat !== undefined && entry.stat.status === "failed",
    );

  const status: SyncRunStatus =
    failures.length === 0 ? "succeeded" : failures.length === attempted ? "failed" : "partial";

  const errorCategory =
    failures.length === 0
      ? null
      : (CATEGORY_SEVERITY.find((candidate) =>
          failures.some((failure) => failure.stat.errorCategory === candidate),
        ) ?? "permanent");

  // Only resource names and categories: the detailed (already sanitised)
  // message stays in per-resource stats rather than the run summary.
  const errorMessage =
    failures.length === 0
      ? null
      : sanitizeMessage(
          `${failures.length} of ${attempted} resources failed: ` +
            failures
              .map((failure) => `${failure.resource} (${failure.stat.errorCategory ?? "unknown"})`)
              .join(", "),
        );

  await store.updateSyncRun(organizationId, run.id, {
    status,
    finishedAt: new Date(now.getTime()),
    stats: statsToJson(stats),
    errorCategory,
    errorMessage,
  });

  // A partial run is audited as a failure: an operator needs to see that some
  // data did not arrive, and a "succeeded" event would hide that.
  await store.recordAuditEvent({
    organizationId,
    actor,
    action: status === "succeeded" ? "sync.succeeded" : "sync.failed",
    targetType: "stripe_connection",
    targetId: connectionId,
    metadata: {
      runId: run.id,
      status,
      isInitial,
      errorCategory,
      failedResources: failures.map((failure) => failure.resource),
    },
  });

  return { runId: run.id, status, stats, errorCategory, errorMessage };
}

/** Stats are stored as jsonb, so every value must be plainly serialisable. */
function statsToJson(
  stats: Partial<Record<SyncResource, ResourceSyncStat>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [resource, stat] of Object.entries(stats)) {
    if (!stat) continue;
    out[resource] = {
      status: stat.status,
      fetched: stat.fetched,
      upserted: stat.upserted,
      skipped: stat.skipped,
      pages: stat.pages,
      attempts: stat.attempts,
      ...(stat.errorCategory ? { errorCategory: stat.errorCategory } : {}),
      ...(stat.errorMessage ? { errorMessage: stat.errorMessage } : {}),
    };
  }
  return out;
}

interface SyncOneResourceInput {
  store: StripeDataStore;
  organizationId: string;
  connectionId: string;
  resource: SyncResource;
  transport: StripeReadTransport;
  context: SyncContext;
  isInitial: boolean;
  now: Date;
  pageSize: number;
  maxPages: number;
  retryPolicy: RetryPolicy;
  sleep: SleepFn;
  random: () => number;
}

/**
 * Sweep one resource to completion, or fail without disturbing its checkpoint.
 *
 * Never throws: a resource failure is a value, because the run must continue
 * with the remaining resources (invariant 3).
 */
async function syncOneResource(input: SyncOneResourceInput): Promise<ResourceSyncStat> {
  const { store, organizationId, connectionId, resource, transport, context, now } = input;

  const checkpoint = await store.findCheckpoint(organizationId, connectionId, resource);

  // Recorded before the first request so an attempt is visible even if every
  // page fails. This is the ONLY checkpoint field a failed sweep may move.
  await store.upsertCheckpoint({
    organizationId,
    connectionId,
    resource,
    lastAttemptedAt: now,
    now,
  });

  // A backfill deliberately ignores the stored window and re-reads everything;
  // idempotent upserts make that safe and it is the only way to repair a gap.
  const createdGte = input.isInitial ? undefined : (checkpoint?.syncedThrough ?? undefined);

  let fetched = 0;
  let upserted = 0;
  let skipped = 0;
  let pages = 0;
  let attempts = 0;
  let startingAfter: string | undefined;
  let lastId: string | null = null;

  try {
    for (;;) {
      // Counted inside the operation so failed attempts are recorded too: an
      // operator investigating a rate-limited connection needs to see the calls
      // that did not succeed.
      const outcome = await withRetry(
        () => {
          attempts += 1;
          return listResource(transport, resource, {
            startingAfter,
            createdGte,
            limit: input.pageSize,
          });
        },
        { policy: input.retryPolicy, sleep: input.sleep, random: input.random },
      );
      const page = outcome.value;
      pages += 1;
      fetched += page.data.length;

      const normalized = normalizeBatch(resource, page.data, context);
      skipped += normalized.skipped;
      if (normalized.rows.length > 0) {
        upserted += await store.upsertProviderRows({
          organizationId,
          connectionId,
          resource,
          rows: normalized.rows,
          syncedAt: now,
        });
      }

      if (page.lastId) lastId = page.lastId;
      // A page without a cursor cannot be advanced past, so stop rather than
      // re-request the same page forever.
      if (!page.hasMore || !page.lastId) break;
      if (pages >= input.maxPages) break;
      startingAfter = page.lastId;
    }

    // Clean completion, and only now: the window and the success marker move
    // together, so they can never disagree about what has been read.
    await store.upsertCheckpoint({
      organizationId,
      connectionId,
      resource,
      cursor: lastId,
      syncedThrough: now,
      lastSuccessfulAt: now,
      lastAttemptedAt: now,
      now,
    });

    return { status: "succeeded", fetched, upserted, skipped, pages, attempts };
  } catch (caught) {
    const error = classifyStripeError(caught);
    // No checkpoint write: `lastAttemptedAt` is already recorded, and cursor,
    // syncedThrough and lastSuccessfulAt must keep the values the last clean
    // sweep left. Rows upserted before the failure stay — they are correct, and
    // deleting them would lose data a later run would only have to fetch again.
    return {
      status: "failed",
      fetched,
      upserted,
      skipped,
      pages,
      attempts,
      errorCategory: error.category,
      errorMessage: error.message,
    };
  }
}
