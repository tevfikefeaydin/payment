import {
  RULE_VERSION,
  errorCategory,
  redactSecretsInText,
  runReconciliation,
  type ReconciliationConfig,
} from "@payrecon/domain";
import type { Database } from "../client";
import { recordAudit } from "../repositories/audit";
import { loadReconciliationInput, loadSourceSnapshot } from "../repositories/reconciliation-input";
import {
  finishReconciliationRun,
  persistCandidates,
  startReconciliationRun,
} from "../repositories/reconciliation";

/**
 * Orchestrates one reconciliation run for one organization.
 *
 * This is the ONLY path that produces exceptions. The demo, a manual run from
 * the UI, a post-import run and the scheduled run all call this same function
 * with the same engine — there is deliberately no separate "demo" code path,
 * so what a prospect sees in the demo is exactly what production does.
 */

export interface RunReconciliationOptions {
  organizationId: string;
  trigger: "manual" | "scheduled" | "import" | "sync";
  triggeredByUserId?: string | null;
  /** Injected so runs are deterministic and testable. */
  now?: Date;
  windowDays?: number;
  config?: ReconciliationConfig;
  correlationId?: string | null;
}

export interface RunReconciliationResult {
  runId: string;
  status: "succeeded" | "failed";
  created: number;
  reopened: number;
  unchanged: number;
  candidateCount: number;
  countsByRule: Record<string, number>;
  notifiableExceptionIds: string[];
}

export async function runReconciliationForOrganization(
  db: Database,
  options: RunReconciliationOptions,
): Promise<RunReconciliationResult> {
  const now = options.now ?? new Date();
  const { organizationId } = options;

  const sourceSnapshot = await loadSourceSnapshot(db, organizationId);

  const runId = await startReconciliationRun(db, {
    organizationId,
    trigger: options.trigger,
    ruleVersion: RULE_VERSION,
    triggeredByUserId: options.triggeredByUserId ?? null,
    sourceSnapshot,
  });

  await recordAudit(db, {
    organizationId,
    actor: options.triggeredByUserId
      ? { type: "user", userId: options.triggeredByUserId }
      : { type: "system" },
    action: "reconciliation.started",
    targetType: "reconciliation_run",
    targetId: runId,
    correlationId: options.correlationId ?? null,
    metadata: { trigger: options.trigger, ruleVersion: RULE_VERSION },
  });

  try {
    const input = await loadReconciliationInput(db, {
      organizationId,
      now,
      windowDays: options.windowDays,
      config: options.config,
    });

    const result = runReconciliation(input);

    const outcome = await persistCandidates(db, {
      organizationId,
      runId,
      candidates: result.candidates,
      now,
    });

    const counts = {
      ...result.countsByRule,
      totalCandidates: result.candidates.length,
      created: outcome.created,
      reopened: outcome.reopened,
      unchanged: outcome.unchanged,
      providerPayments: input.providerPayments.length,
      internalRecords: input.internalRecords.length,
    };

    await finishReconciliationRun(db, {
      organizationId,
      runId,
      status: "succeeded",
      counts,
      diagnostics: result.diagnostics,
    });

    await recordAudit(db, {
      organizationId,
      actor: options.triggeredByUserId
        ? { type: "user", userId: options.triggeredByUserId }
        : { type: "system" },
      action: "reconciliation.completed",
      targetType: "reconciliation_run",
      targetId: runId,
      correlationId: options.correlationId ?? null,
      metadata: {
        created: outcome.created,
        reopened: outcome.reopened,
        unchanged: outcome.unchanged,
        diagnostics: result.diagnostics,
      },
    });

    return {
      runId,
      status: "succeeded",
      created: outcome.created,
      reopened: outcome.reopened,
      unchanged: outcome.unchanged,
      candidateCount: result.candidates.length,
      countsByRule: result.countsByRule,
      notifiableExceptionIds: outcome.notifiableExceptionIds,
    };
  } catch (error) {
    // Record the failure against the run so it is visible in the UI, with a
    // sanitised message: a driver error can quote row values.
    const message = error instanceof Error ? redactSecretsInText(error.message) : "unknown error";

    await finishReconciliationRun(db, {
      organizationId,
      runId,
      status: "failed",
      errorCategory: errorCategory(error),
      errorMessage: message.slice(0, 500),
    });

    await recordAudit(db, {
      organizationId,
      actor: options.triggeredByUserId
        ? { type: "user", userId: options.triggeredByUserId }
        : { type: "system" },
      action: "reconciliation.failed",
      targetType: "reconciliation_run",
      targetId: runId,
      correlationId: options.correlationId ?? null,
      metadata: { errorCategory: errorCategory(error) },
    });

    throw error;
  }
}
