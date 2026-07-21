import { randomUUID } from "node:crypto";
import {
  PublicError,
  SEVERITY_RANK,
  normalizeCurrency,
  type ExceptionSeverity,
} from "@payrecon/domain";
import type { Keyring } from "@payrecon/auth/crypto";
import {
  loadSlackWebhook,
  markFailing,
  markVerified,
  toDestinationView,
  type DestinationView,
} from "./destinations";
import {
  renderDigestEmail,
  renderDigestSlack,
  renderTestEmail,
  renderTestSlack,
  summarizeDigest,
  toDeliverySummary,
  type DigestException,
  type DigestInput,
} from "./rendering";
import {
  TransportError,
  isTransientFailure,
  sanitizeErrorMessage,
  type NotificationTransports,
} from "./transports";
import type {
  DestinationRow,
  DeliveryRow,
  NotificationDigest,
  NotificationStore,
  PolicyRow,
} from "./store";

/**
 * Enqueueing and sending.
 *
 * The two properties this module exists to guarantee:
 *
 *  1. NO DUPLICATE ALERTS. Every delivery carries a deterministic dedupe key
 *     built from organization + policy + subject + digest window, and insertion
 *     relies on the unique `(organization_id, dedupe_key)` index with
 *     `ON CONFLICT DO NOTHING`. Two workers racing on the same exception, a
 *     reconciliation run replayed after a crash, or the same exception
 *     re-detected within one digest window all collapse onto one row.
 *
 *  2. BOUNDED, SAFE RETRIES. Transient failures reschedule with exponential
 *     backoff and jitter; permanent failures stop immediately rather than
 *     burning the attempt budget on a request that cannot succeed. Every stored
 *     error is sanitized first.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Version prefix on dedupe keys, so the scheme can change without collisions. */
export const DEDUPE_KEY_VERSION = "v1";

export const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLAIM_LIMIT = 50;
/** How long a claimed delivery is hidden from other workers. */
const DEFAULT_LEASE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Digest windows
// ---------------------------------------------------------------------------

/**
 * Start of the digest bucket containing `now`.
 *
 * Buckets are computed by flooring the epoch, which makes them UTC-aligned and
 * independent of the server's local timezone — two workers in different regions
 * must agree on the bucket or the dedupe key stops deduplicating.
 */
export function digestWindowStart(now: Date, digest: NotificationDigest): Date {
  if (digest === "immediate") return now;
  const size = digest === "daily" ? DAY_MS : HOUR_MS;
  return new Date(Math.floor(now.getTime() / size) * size);
}

/** End of the digest bucket: when a batched delivery becomes due. */
export function digestWindowEnd(now: Date, digest: NotificationDigest): Date {
  if (digest === "immediate") return now;
  const size = digest === "daily" ? DAY_MS : HOUR_MS;
  return new Date(digestWindowStart(now, digest).getTime() + size);
}

/**
 * The digest actually applied to one exception.
 *
 * A policy may let critical exceptions jump the queue, which is the whole point
 * of `criticalBypassesDigest`: an alert storm is worth suppressing, a critical
 * revenue loss is not.
 */
export function effectiveDigest(
  policy: PolicyRow,
  severity: ExceptionSeverity,
): NotificationDigest {
  if (policy.criticalBypassesDigest && severity === "critical") return "immediate";
  return policy.digest;
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

export interface DedupeKeyInput {
  organizationId: string;
  policyId: string;
  digest: NotificationDigest;
  exceptionId: string;
  now: Date;
}

/**
 * Build the deterministic dedupe key.
 *
 * Immediate deliveries are keyed by the exception, so one exception can notify
 * one policy exactly once. Batched deliveries are keyed by the time bucket, so
 * every exception falling in the same window joins the same delivery and the
 * next window opens a new one.
 */
export function buildDedupeKey(input: DedupeKeyInput): string {
  const subject =
    input.digest === "immediate"
      ? `exception:${input.exceptionId}`
      : `window:${digestWindowStart(input.now, input.digest).toISOString()}`;

  return [
    DEDUPE_KEY_VERSION,
    `org:${input.organizationId}`,
    `policy:${input.policyId}`,
    `digest:${input.digest}`,
    subject,
  ].join("|");
}

/** Recover the digest from a key this module built, for labelling a message. */
function digestFromDedupeKey(dedupeKey: string): NotificationDigest | undefined {
  const part = dedupeKey.split("|").find((segment) => segment.startsWith("digest:"));
  const value = part?.slice("digest:".length);
  return value === "immediate" || value === "hourly" || value === "daily" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Threshold matching
// ---------------------------------------------------------------------------

export interface ExceptionTrigger {
  severity: ExceptionSeverity;
  revenueAtRiskMinor: bigint | null;
  currency: string | null;
}

/**
 * Does this exception meet a policy's thresholds?
 *
 * `SEVERITY_RANK` counts UP as severity falls (critical = 0), so "at least as
 * severe as the minimum" is `rank <= minRank`.
 */
export function policyMatches(policy: PolicyRow, exception: ExceptionTrigger): boolean {
  if (!policy.enabled) return false;

  if (SEVERITY_RANK[exception.severity] > SEVERITY_RANK[policy.minSeverity]) return false;

  if (policy.currency) {
    if (!exception.currency) return false;
    if (normalizeCurrency(exception.currency) !== normalizeCurrency(policy.currency)) return false;
  }

  if (policy.minRevenueAtRiskMinor !== null) {
    // An exception with no monetary exposure cannot clear a monetary threshold.
    if (exception.revenueAtRiskMinor === null) return false;
    if (exception.revenueAtRiskMinor < policy.minRevenueAtRiskMinor) return false;
    // NOTE: when a policy sets a threshold but no currency filter, minor units
    // are compared across currencies. That is the schema's design; a customer
    // wanting an exact monetary threshold pins the currency on the policy.
  }

  return true;
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface EnqueueForExceptionInput extends ExceptionTrigger {
  organizationId: string;
  exceptionId: string;
  now: Date;
}

export interface EnqueuedDelivery {
  deliveryId: string;
  policyId: string;
  destinationId: string;
  dedupeKey: string;
  /** False when an existing delivery absorbed this exception. */
  created: boolean;
  /** False when this exception was already linked to the delivery. */
  linked: boolean;
}

export interface EnqueueResult {
  matchedPolicies: number;
  deliveries: EnqueuedDelivery[];
}

/**
 * Queue notifications for one exception against every policy it matches.
 *
 * Safe to call repeatedly for the same exception: the unique dedupe index makes
 * a second call a no-op rather than a second alert.
 */
export async function enqueueForException(
  db: NotificationStore,
  input: EnqueueForExceptionInput,
): Promise<EnqueueResult> {
  const policies = await db.listEnabledPolicies(input.organizationId);
  const deliveries: EnqueuedDelivery[] = [];

  for (const policy of policies) {
    if (!policyMatches(policy, input)) continue;

    const digest = effectiveDigest(policy, input.severity);
    const dedupeKey = buildDedupeKey({
      organizationId: input.organizationId,
      policyId: policy.id,
      digest,
      exceptionId: input.exceptionId,
      now: input.now,
    });

    const { id, created } = await db.insertDeliveryIfAbsent({
      id: randomUUID(),
      organizationId: input.organizationId,
      policyId: policy.id,
      destinationId: policy.destinationId,
      dedupeKey,
      // Batched deliveries become due when their window closes; immediate ones now.
      scheduledFor: digest === "immediate" ? input.now : digestWindowEnd(input.now, digest),
      createdAt: input.now,
    });

    const linked = await db.linkException(input.organizationId, id, input.exceptionId);

    deliveries.push({
      deliveryId: id,
      policyId: policy.id,
      destinationId: policy.destinationId,
      dedupeKey,
      created,
      linked,
    });
  }

  return { matchedPolicies: deliveries.length, deliveries };
}

// ---------------------------------------------------------------------------
// Retry scheduling
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay removed at random, between 0 and 1. */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  jitterRatio: 0.2,
};

/**
 * Delay before attempt number `attempt` is retried.
 *
 * Jitter is subtractive so the result can never exceed `maxDelayMs`; a delivery
 * that keeps failing therefore has a hard upper bound on how far it slides into
 * the future, while a batch that failed together still spreads out instead of
 * retrying in lockstep.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(attempt - 1, 0);
  const capped = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const jittered = capped * (1 - policy.jitterRatio * random());
  return Math.max(Math.round(jittered), 0);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendPendingOptions {
  now: Date;
  transports: NotificationTransports;
  keyring: Keyring;
  maxAttempts?: number;
  limit?: number;
  /**
   * Base URL for the deep links, i.e. APP_URL. Injected rather than read from
   * the environment so this package never touches `process.env`.
   */
  appUrl: string;
  retry?: RetryPolicy;
  /** Injected so jitter is deterministic under test. */
  random?: () => number;
  /** Injected so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Pause between sends. Slack rate-limits incoming webhooks per workspace, so
   * a large batch is paced rather than fired as a burst that earns 429s.
   */
  pacingDelayMs?: number;
  leaseMs?: number;
}

export interface SendPendingResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function toDigestExceptions(
  rows: Array<{
    id: string;
    ruleId: string;
    severity: ExceptionSeverity;
    summary: string;
    revenueAtRiskMinor: bigint | null;
    currency: string | null;
  }>,
): DigestException[] {
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.ruleId,
    severity: row.severity,
    summary: row.summary,
    revenueAtRiskMinor: row.revenueAtRiskMinor,
    currency: row.currency,
  }));
}

function windowLabel(digest: NotificationDigest | undefined): string | undefined {
  if (digest === "hourly") return "hourly digest";
  if (digest === "daily") return "daily digest";
  return undefined;
}

/**
 * Render for the destination's channel and hand the result to its transport.
 *
 * The Slack webhook is decrypted here and lives only as an argument to
 * `send`; it is never returned, stored, or logged.
 */
async function deliverDigest(
  db: NotificationStore,
  destination: DestinationRow,
  digestInput: DigestInput,
  transports: NotificationTransports,
  keyring: Keyring,
): Promise<void> {
  if (destination.kind === "email") {
    if (!destination.target) {
      throw new TransportError("Email destination has no address configured", "permanent");
    }
    const rendered = renderDigestEmail(digestInput);
    await transports.email.send({
      to: destination.target,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    return;
  }

  const webhookUrl = await loadSlackWebhook(db, {
    organizationId: destination.organizationId,
    destinationId: destination.id,
    keyring,
  });
  if (!webhookUrl) {
    throw new TransportError("Slack destination has no stored webhook", "permanent");
  }

  const rendered = renderDigestSlack(digestInput);
  await transports.slack.send({
    webhookUrl,
    text: rendered.text,
    blocks: rendered.blocks,
  });
}

/**
 * Drain the due queue.
 *
 * Deliveries are claimed by leasing them forward, so a second worker running at
 * the same time cannot pick up the same rows and send twice.
 */
export async function sendPendingDeliveries(
  db: NotificationStore,
  options: SendPendingOptions,
): Promise<SendPendingResult> {
  const now = options.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
  const appUrl = options.appUrl;
  const retry = options.retry ?? DEFAULT_RETRY_POLICY;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const pacingDelayMs = options.pacingDelayMs ?? 0;
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));

  const claimed = await db.claimDueDeliveries(now, limit, leaseUntil);
  const result: SendPendingResult = {
    claimed: claimed.length,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
  };

  for (const delivery of claimed) {
    const outcome = await processDelivery(db, delivery, {
      now,
      appUrl,
      maxAttempts,
      retry,
      random,
      transports: options.transports,
      keyring: options.keyring,
    });
    result[outcome] += 1;

    if (pacingDelayMs > 0) await sleep(pacingDelayMs);
  }

  return result;
}

interface ProcessContext {
  now: Date;
  appUrl: string;
  maxAttempts: number;
  retry: RetryPolicy;
  random: () => number;
  transports: NotificationTransports;
  keyring: Keyring;
}

type DeliveryOutcome = "sent" | "retried" | "failed" | "skipped";

async function processDelivery(
  db: NotificationStore,
  delivery: DeliveryRow,
  context: ProcessContext,
): Promise<DeliveryOutcome> {
  const organizationId = delivery.organizationId;

  const destination = await db.getDestination(organizationId, delivery.destinationId);
  if (!destination) {
    await db.updateDelivery(organizationId, delivery.id, {
      status: "skipped",
      attempts: delivery.attempts,
      lastError: "Destination no longer exists.",
    });
    return "skipped";
  }

  // A disabled destination must not be woken up by a queued delivery; the
  // operator turned it off deliberately. An unverified one has never been
  // proven to work, and "active only after a successful test send" would mean
  // nothing if digests went out regardless. A `failing` destination IS still
  // attempted, because the condition that broke it may have cleared.
  if (destination.status === "disabled" || destination.status === "pending_verification") {
    await db.updateDelivery(organizationId, delivery.id, {
      status: "skipped",
      attempts: delivery.attempts,
      lastError:
        destination.status === "disabled"
          ? "Destination is disabled."
          : "Destination has not been verified.",
    });
    return "skipped";
  }

  const exceptions = await db.listDeliveryExceptions(organizationId, delivery.id);
  if (exceptions.length === 0) {
    // Can happen when every linked exception was deleted by retention cleanup.
    await db.updateDelivery(organizationId, delivery.id, {
      status: "skipped",
      attempts: delivery.attempts,
      lastError: "No exceptions remain for this delivery.",
    });
    return "skipped";
  }

  const digestExceptions = toDigestExceptions(exceptions);
  const summary = summarizeDigest(digestExceptions);
  const organizationName = (await db.getOrganizationName(organizationId)) ?? "your organization";

  const digestInput: DigestInput = {
    organizationId,
    organizationName,
    appUrl: context.appUrl,
    exceptions: digestExceptions,
    windowLabel: windowLabel(digestFromDedupeKey(delivery.dedupeKey)),
  };

  try {
    await deliverDigest(db, destination, digestInput, context.transports, context.keyring);
  } catch (error) {
    return failDelivery(db, delivery, destination, error, context);
  }

  await db.updateDelivery(organizationId, delivery.id, {
    status: "sent",
    attempts: delivery.attempts + 1,
    sentAt: context.now,
    lastError: null,
    summary: toDeliverySummary(summary),
  });
  return "sent";
}

async function failDelivery(
  db: NotificationStore,
  delivery: DeliveryRow,
  destination: DestinationRow,
  error: unknown,
  context: ProcessContext,
): Promise<DeliveryOutcome> {
  const organizationId = delivery.organizationId;
  const attempts = delivery.attempts + 1;
  const reason = sanitizeErrorMessage(error);
  const transient = isTransientFailure(error);

  if (transient && attempts < context.maxAttempts) {
    const delayMs = computeBackoffMs(attempts, context.retry, context.random);
    await db.updateDelivery(organizationId, delivery.id, {
      status: "pending",
      attempts,
      scheduledFor: new Date(context.now.getTime() + delayMs),
      lastError: reason,
    });
    return "retried";
  }

  // Either the request can never succeed, or the attempt budget is spent.
  await db.updateDelivery(organizationId, delivery.id, {
    status: "failed",
    attempts,
    lastError: reason,
  });

  await markFailing(db, {
    organizationId,
    destinationId: destination.id,
    error,
    now: context.now,
  });

  await db.recordAudit({
    organizationId,
    actor: { type: "system" },
    action: "notification.delivery_failed",
    targetType: "notification_delivery",
    targetId: delivery.id,
    metadata: {
      destinationKind: destination.kind,
      attempts,
      permanent: !transient,
      // Already sanitized; the audit writer redacts it a second time.
      reason,
    },
  });

  return "failed";
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface SendTestMessageInput {
  organizationId: string;
  destinationId: string;
  transports: NotificationTransports;
  keyring: Keyring;
  now?: Date;
  /** Base URL for the deep links, i.e. APP_URL. */
  appUrl: string;
  actorUserId?: string | null;
}

export interface SendTestMessageResult {
  ok: boolean;
  /** Sanitized failure reason. Null on success. */
  error: string | null;
  destination: DestinationView | null;
}

/**
 * Send a verification message and, only if it is actually delivered, promote
 * the destination to `active`.
 *
 * This is what makes `active` a claim about reality rather than about what
 * someone typed into a form.
 */
export async function sendTestMessage(
  db: NotificationStore,
  input: SendTestMessageInput,
): Promise<SendTestMessageResult> {
  const now = input.now ?? new Date();
  const appUrl = input.appUrl;

  const destination = await db.getDestination(input.organizationId, input.destinationId);
  if (!destination) {
    throw new PublicError(
      "notification.destination_not_found",
      "That notification destination does not exist.",
      404,
    );
  }

  const organizationName =
    (await db.getOrganizationName(input.organizationId)) ?? "your organization";
  const messageInput = {
    organizationId: input.organizationId,
    organizationName,
    appUrl,
    destinationName: destination.name,
  };

  try {
    if (destination.kind === "email") {
      if (!destination.target) {
        throw new TransportError("Email destination has no address configured", "permanent");
      }
      const rendered = renderTestEmail(messageInput);
      await input.transports.email.send({
        to: destination.target,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } else {
      const webhookUrl = await loadSlackWebhook(db, {
        organizationId: input.organizationId,
        destinationId: input.destinationId,
        keyring: input.keyring,
      });
      if (!webhookUrl) {
        throw new TransportError("Slack destination has no stored webhook", "permanent");
      }
      const rendered = renderTestSlack(messageInput);
      await input.transports.slack.send({
        webhookUrl,
        text: rendered.text,
        blocks: rendered.blocks,
      });
    }
  } catch (error) {
    const reason = sanitizeErrorMessage(error);
    const failed = await markFailing(db, {
      organizationId: input.organizationId,
      destinationId: input.destinationId,
      error,
      now,
    });
    await db.recordAudit({
      organizationId: input.organizationId,
      actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId ?? null },
      action: "notification.delivery_failed",
      targetType: "notification_destination",
      targetId: input.destinationId,
      metadata: { destinationKind: destination.kind, test: true, reason },
    });
    return { ok: false, error: reason, destination: failed };
  }

  const verified = await markVerified(db, {
    organizationId: input.organizationId,
    destinationId: input.destinationId,
    now,
    actorUserId: input.actorUserId ?? null,
  });

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId ?? null },
    action: "notification.test_sent",
    targetType: "notification_destination",
    targetId: input.destinationId,
    metadata: { destinationKind: destination.kind, name: destination.name },
  });

  return {
    ok: true,
    error: null,
    destination: verified ?? toDestinationView(destination),
  };
}
