import {
  EXCEPTION_SEVERITIES,
  isValidCurrency,
  normalizeCurrency,
  PublicError,
  type ExceptionSeverity,
} from "@payrecon/domain";
import type { NotificationDigest, NotificationStore, PolicyRow } from "./store";

/**
 * Notification policy management.
 *
 * A policy decides WHICH exceptions reach a destination and HOW they are
 * batched. Destinations without a policy never receive anything, so this module
 * is what makes the notifications screen actually produce notifications.
 *
 * Validation lives here, not in the UI: severity and digest are checked against
 * the closed domain lists, and a revenue threshold requires a currency — the
 * alternative would compare minor units across unlike currencies, which this
 * codebase never does.
 */

export const NOTIFICATION_DIGESTS = ["immediate", "hourly", "daily"] as const;

export interface CreatePolicyInput {
  organizationId: string;
  destinationId: string;
  minSeverity: string;
  digest: string;
  /** Minor units, already parsed. Requires `currency`. */
  minRevenueAtRiskMinor?: bigint | null;
  currency?: string | null;
  criticalBypassesDigest?: boolean;
  actorUserId?: string | null;
  now?: Date;
}

function parseSeverity(input: string): ExceptionSeverity {
  const severity = EXCEPTION_SEVERITIES.find((candidate) => candidate === input);
  if (!severity) throw new PublicError("invalid_severity", "Choose a valid minimum severity.");
  return severity;
}

function parseDigest(input: string): NotificationDigest {
  const digest = NOTIFICATION_DIGESTS.find((candidate) => candidate === input);
  if (!digest) throw new PublicError("invalid_digest", "Choose a valid digest cadence.");
  return digest;
}

export async function createPolicy(
  db: NotificationStore,
  input: CreatePolicyInput,
): Promise<PolicyRow> {
  const now = input.now ?? new Date();

  // The destination is re-read under the organization id, so a policy can
  // never be attached to another tenant's destination.
  const destination = await db.getDestination(input.organizationId, input.destinationId);
  if (!destination) {
    throw new PublicError("not_found", "That notification destination was not found.", 404);
  }

  const minSeverity = parseSeverity(input.minSeverity);
  const digest = parseDigest(input.digest);

  const threshold = input.minRevenueAtRiskMinor ?? null;
  let currency = input.currency ?? null;
  if (currency !== null) {
    if (!isValidCurrency(currency)) {
      throw new PublicError("invalid_currency", "Enter a valid ISO-4217 currency code.");
    }
    currency = normalizeCurrency(currency);
  }
  if (threshold !== null) {
    if (threshold <= 0n) {
      throw new PublicError("invalid_threshold", "The revenue threshold must be positive.");
    }
    if (currency === null) {
      throw new PublicError(
        "threshold_needs_currency",
        "A revenue threshold needs a currency: amounts in different currencies are never compared.",
      );
    }
  }

  const created = await db.insertPolicy({
    organizationId: input.organizationId,
    destinationId: input.destinationId,
    minSeverity,
    minRevenueAtRiskMinor: threshold,
    currency,
    digest,
    criticalBypassesDigest: input.criticalBypassesDigest ?? true,
    enabled: true,
    createdAt: now,
  });

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.actorUserId ?? null },
    action: "notification.policy_changed",
    targetType: "notification_policy",
    targetId: created.id,
    metadata: {
      op: "created",
      destinationName: destination.name,
      minSeverity,
      digest,
      currency,
      hasRevenueThreshold: threshold !== null,
    },
  });

  return created;
}

export interface PolicyRefInput {
  organizationId: string;
  policyId: string;
  actorUserId?: string | null;
  now?: Date;
}

export async function setPolicyEnabled(
  db: NotificationStore,
  input: PolicyRefInput & { enabled: boolean },
): Promise<PolicyRow | null> {
  const updated = await db.updatePolicy(input.organizationId, input.policyId, {
    enabled: input.enabled,
    updatedAt: input.now ?? new Date(),
  });
  if (!updated) return null;

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.actorUserId ?? null },
    action: "notification.policy_changed",
    targetType: "notification_policy",
    targetId: updated.id,
    metadata: { op: input.enabled ? "enabled" : "disabled" },
  });

  return updated;
}

export async function deletePolicy(db: NotificationStore, input: PolicyRefInput): Promise<boolean> {
  const deleted = await db.deletePolicy(input.organizationId, input.policyId);
  if (!deleted) return false;

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.actorUserId ?? null },
    action: "notification.policy_changed",
    targetType: "notification_policy",
    targetId: input.policyId,
    metadata: { op: "deleted" },
  });

  return true;
}

export async function listPolicies(
  db: NotificationStore,
  organizationId: string,
): Promise<PolicyRow[]> {
  return db.listPolicies(organizationId);
}
