"use server";

import {
  createOrganization,
  recordAudit,
  seedDemoData,
  updateOrganizationSettings,
} from "@payrecon/db";
import { loadEnv } from "@payrecon/config/env";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "@payrecon/config";
import { PublicError } from "@payrecon/domain";
import { enqueueReconciliation, getQueue } from "@payrecon/jobs";
import { db } from "./db";
import { actionError, actionSuccess, orgAction, userAction, type ActionState } from "./actions";

/**
 * Organization lifecycle, demo data, and reconciliation triggers.
 *
 * Every export is a thin async wrapper around a handler built by `orgAction` /
 * `userAction`. The wrapper exists because a `"use server"` module may only
 * export async functions; keeping the declaration explicit also makes the
 * required permission visible at the definition site.
 */

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Hand a reconciliation run to the worker.
 *
 * The enqueue is deliberately NOT audited here: `runReconciliationForOrganization`
 * writes `reconciliation.started` when the work actually begins, and the queue
 * payload carries `triggeredByUserId`, so attribution survives without a second,
 * misleading "started" event for a run that has not started.
 */
async function queueReconciliation(params: {
  organizationId: string;
  triggeredByUserId: string;
  correlationId: string;
}): Promise<void> {
  const env = loadEnv();
  try {
    const queue = await getQueue({ connectionString: env.DATABASE_URL, max: 2 });
    await enqueueReconciliation(queue, {
      organizationId: params.organizationId,
      trigger: "manual",
      triggeredByUserId: params.triggeredByUserId,
      correlationId: params.correlationId,
    });
  } catch (error) {
    console.error("[action] failed to enqueue reconciliation", {
      name: error instanceof Error ? error.name : "unknown",
    });
    throw new PublicError(
      "queue_unavailable",
      "Could not queue the reconciliation run. The background job queue is not reachable right now — try again shortly.",
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Create organization
// ---------------------------------------------------------------------------

const createOrganizationHandler = userAction(async (context, formData) => {
  const rawName = formData.get("name");
  if (typeof rawName !== "string" || rawName.trim().length < 2) {
    return actionError("Organization name must be at least 2 characters.", "invalid_name");
  }

  // `createOrganization` enforces the length bounds and makes the creator the
  // owner in the same transaction, so an ownerless organization never exists.
  const organization = await createOrganization(db(), {
    name: rawName.trim().slice(0, 100),
    ownerUserId: context.userId,
  });

  await recordAudit(db(), {
    organizationId: organization.id,
    actor: { type: "user", userId: context.userId },
    action: "organization.created",
    targetType: "organization",
    targetId: organization.id,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { name: rawName.trim().slice(0, 100) },
  });

  return actionSuccess("Organization created.", `/orgs/${organization.id}`);
});

export async function createOrganizationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createOrganizationHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

const loadDemoDataHandler = orgAction("demo:load", async (context) => {
  // `seedDemoData` is idempotent per organization and records its own audit
  // event, so reloading the demo cannot duplicate rows.
  const result = await seedDemoData(db(), {
    organizationId: context.org.organizationId,
    actorUserId: context.org.user.id,
  });

  await queueReconciliation({
    organizationId: context.org.organizationId,
    triggeredByUserId: context.org.user.id,
    correlationId: context.correlationId,
  });

  return actionSuccess(
    `Loaded ${result.internalRecords} internal records and ${result.providerPayments} provider payments. ` +
      "A reconciliation run has been queued — results appear here once the worker finishes.",
  );
});

export async function loadDemoDataAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return loadDemoDataHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Run reconciliation
// ---------------------------------------------------------------------------

const runReconciliationHandler = orgAction("reconciliation:run", async (context) => {
  await queueReconciliation({
    organizationId: context.org.organizationId,
    triggeredByUserId: context.org.user.id,
    correlationId: context.correlationId,
  });

  return actionSuccess(
    "Reconciliation queued. Repeated clicks collapse into a single run per organization.",
  );
});

export async function runReconciliationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runReconciliationHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const updateSettingsHandler = orgAction("settings:manage", async (context, formData) => {
  const rawName = formData.get("name");
  const rawRetention = formData.get("retentionDays");

  if (typeof rawName !== "string" || rawName.trim().length < 2) {
    return actionError("Organization name must be between 2 and 100 characters.", "invalid_name");
  }

  const retentionDays = Number.parseInt(typeof rawRetention === "string" ? rawRetention : "", 10);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < RETENTION_MIN_DAYS ||
    retentionDays > RETENTION_MAX_DAYS
  ) {
    return actionError(
      `Retention must be a whole number between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days.`,
      "invalid_retention",
    );
  }

  // The repository re-validates both fields; this check exists to give a
  // field-specific message rather than a generic one.
  await updateOrganizationSettings(db(), {
    organizationId: context.org.organizationId,
    name: rawName.trim(),
    retentionDays,
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "organization.updated",
    targetType: "organization",
    targetId: context.org.organizationId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { name: rawName.trim(), retentionDays },
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "retention.settings_changed",
    targetType: "organization",
    targetId: context.org.organizationId,
    correlationId: context.correlationId,
    metadata: { retentionDays },
  });

  return actionSuccess("Settings saved.");
});

export async function updateSettingsAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return updateSettingsHandler(previous, formData);
}
