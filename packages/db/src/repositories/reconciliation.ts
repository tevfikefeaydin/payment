import { and, eq, inArray, sql } from "drizzle-orm";
import {
  stateAfterRedetection,
  type ExceptionCandidate,
  type ExceptionState,
  type ReconciliationDiagnostics,
} from "@payrecon/domain";
import type { Database } from "../client";
import { exceptionEvents, exceptions, reconciliationRuns } from "../schema/reconciliation";

/**
 * Persistence for reconciliation runs and the exceptions they produce.
 *
 * IDEMPOTENCY MODEL
 * -----------------
 * `(organization_id, fingerprint)` is unique. Re-running reconciliation over
 * unchanged inputs therefore cannot create a second exception for the same
 * problem: each candidate either matches an existing row (which is refreshed) or
 * is new.
 *
 * CONCURRENCY MODEL
 * -----------------
 * The whole persist step runs inside one transaction that first takes a
 * PostgreSQL advisory lock keyed on the organization. Two workers processing the
 * same organization serialise rather than interleave, so the created/reopened
 * counts reported to the operator are accurate. The unique index remains the
 * correctness backstop if a lock is ever bypassed.
 *
 * RE-DETECTION POLICY
 * -------------------
 * A candidate whose fingerprint matches an existing exception:
 *   - resolved  -> reopened  (the problem genuinely came back)
 *   - open / acknowledged / reopened -> unchanged state
 * Re-detecting an acknowledged exception deliberately does NOT reset it to open:
 * that would erase an operator's triage every hour.
 *
 * Exceptions that STOP being detected are not auto-resolved. Silently closing
 * them would hide that money was once at risk, and the underlying data may have
 * merely aged out of the sync window rather than been fixed. `lastSeenAt` records
 * when the problem was last observed and the UI surfaces that staleness, leaving
 * closure as an explicit, audited operator decision.
 */

export interface StartRunInput {
  organizationId: string;
  trigger: "manual" | "scheduled" | "import" | "sync";
  ruleVersion: number;
  triggeredByUserId?: string | null;
  sourceSnapshot?: Record<string, unknown>;
}

export async function startReconciliationRun(db: Database, input: StartRunInput): Promise<string> {
  const [row] = await db
    .insert(reconciliationRuns)
    .values({
      organizationId: input.organizationId,
      trigger: input.trigger,
      ruleVersion: input.ruleVersion,
      status: "running",
      startedAt: new Date(),
      triggeredByUserId: input.triggeredByUserId ?? null,
      sourceSnapshot: input.sourceSnapshot ?? {},
    })
    .returning({ id: reconciliationRuns.id });

  if (!row) throw new Error("Failed to create reconciliation run");
  return row.id;
}

export interface PersistOutcome {
  created: number;
  reopened: number;
  unchanged: number;
  /** Ids of exceptions that are newly actionable, for notification fan-out. */
  notifiableExceptionIds: string[];
}

/**
 * Write a run's candidates into the exception inbox.
 *
 * Returns per-outcome counts so the run summary and the notification step can
 * distinguish "new problem" from "same problem, seen again".
 */
export async function persistCandidates(
  db: Database,
  params: {
    organizationId: string;
    runId: string;
    candidates: ExceptionCandidate[];
    now: Date;
  },
): Promise<PersistOutcome> {
  const { organizationId, runId, candidates, now } = params;

  if (candidates.length === 0) {
    return { created: 0, reopened: 0, unchanged: 0, notifiableExceptionIds: [] };
  }

  return db.transaction(async (tx) => {
    // Serialise concurrent reconciliation for this organization. `hashtextextended`
    // gives a stable 64-bit key from the organization id.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}::text, 0))`,
    );

    const fingerprints = candidates.map((c) => c.fingerprint);
    const existingRows = await tx
      .select({
        id: exceptions.id,
        fingerprint: exceptions.fingerprint,
        state: exceptions.state,
      })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.organizationId, organizationId),
          inArray(exceptions.fingerprint, fingerprints),
        ),
      );

    const existing = new Map(existingRows.map((row) => [row.fingerprint, row]));

    let created = 0;
    let reopened = 0;
    let unchanged = 0;
    const notifiableExceptionIds: string[] = [];

    for (const candidate of candidates) {
      const prior = existing.get(candidate.fingerprint);

      if (!prior) {
        const [inserted] = await tx
          .insert(exceptions)
          .values({
            organizationId,
            ruleId: candidate.ruleId,
            ruleVersion: candidate.ruleVersion,
            fingerprint: candidate.fingerprint,
            severity: candidate.severity,
            state: "open",
            summary: candidate.summary,
            revenueAtRiskMinor: candidate.revenueAtRiskMinor,
            currency: candidate.currency,
            providerObjectId: candidate.providerObjectId,
            internalRecordId: candidate.internalRecordId,
            internalExternalId: candidate.internalExternalId,
            evidence: candidate.evidence,
            probableCauses: candidate.probableCauses,
            recommendedActions: candidate.recommendedActions,
            occurredAt: candidate.occurredAt,
            firstSeenAt: now,
            lastSeenAt: now,
            firstRunId: runId,
            lastRunId: runId,
          })
          // Backstop for the case where the advisory lock was bypassed: never
          // fail a whole run because another worker inserted the same finding.
          .onConflictDoNothing({
            target: [exceptions.organizationId, exceptions.fingerprint],
          })
          .returning({ id: exceptions.id });

        if (inserted) {
          created += 1;
          notifiableExceptionIds.push(inserted.id);
          await tx.insert(exceptionEvents).values({
            organizationId,
            exceptionId: inserted.id,
            action: "created",
            toState: "open",
            actorType: "system",
            runId,
          });
        } else {
          unchanged += 1;
        }
        continue;
      }

      const nextState: ExceptionState = stateAfterRedetection(prior.state);
      const isReopening = nextState !== prior.state;

      await tx
        .update(exceptions)
        .set({
          // Refresh the evidence: the underlying numbers may have moved.
          severity: candidate.severity,
          summary: candidate.summary,
          revenueAtRiskMinor: candidate.revenueAtRiskMinor,
          currency: candidate.currency,
          evidence: candidate.evidence,
          probableCauses: candidate.probableCauses,
          recommendedActions: candidate.recommendedActions,
          ruleVersion: candidate.ruleVersion,
          occurredAt: candidate.occurredAt,
          providerObjectId: candidate.providerObjectId,
          internalRecordId: candidate.internalRecordId,
          internalExternalId: candidate.internalExternalId,
          state: nextState,
          resolvedAt: isReopening ? null : undefined,
          resolvedByUserId: isReopening ? null : undefined,
          lastSeenAt: now,
          lastRunId: runId,
          updatedAt: now,
          // Bump the optimistic-concurrency version ONLY when the state actually
          // changes. `version` exists to stop two operators overwriting each
          // other; a routine re-detection that merely refreshes evidence is not
          // a competing edit. Bumping it on every run would invalidate the
          // version an operator is holding in an open form and reject their
          // acknowledge/resolve with a spurious conflict — every scheduled run,
          // for every open exception.
          ...(isReopening ? { version: sql`${exceptions.version} + 1` } : {}),
        })
        .where(and(eq(exceptions.organizationId, organizationId), eq(exceptions.id, prior.id)));

      if (isReopening) {
        reopened += 1;
        notifiableExceptionIds.push(prior.id);
        await tx.insert(exceptionEvents).values({
          organizationId,
          exceptionId: prior.id,
          action: "reopened",
          fromState: prior.state,
          toState: nextState,
          actorType: "system",
          note: "Detected again by a later reconciliation run.",
          runId,
        });
      } else {
        unchanged += 1;
      }
    }

    return { created, reopened, unchanged, notifiableExceptionIds };
  });
}

export interface FinishRunInput {
  organizationId: string;
  runId: string;
  status: "succeeded" | "failed";
  counts?: Record<string, unknown>;
  diagnostics?: ReconciliationDiagnostics;
  errorCategory?: string | null;
  errorMessage?: string | null;
}

export async function finishReconciliationRun(db: Database, input: FinishRunInput): Promise<void> {
  await db
    .update(reconciliationRuns)
    .set({
      status: input.status,
      finishedAt: new Date(),
      counts: input.counts ?? {},
      diagnostics: (input.diagnostics ?? {}) as Record<string, unknown>,
      errorCategory: input.errorCategory ?? null,
      errorMessage: input.errorMessage ?? null,
    })
    .where(
      and(
        eq(reconciliationRuns.organizationId, input.organizationId),
        eq(reconciliationRuns.id, input.runId),
      ),
    );
}

export interface RunSummary {
  id: string;
  status: string;
  trigger: string;
  ruleVersion: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: unknown;
  diagnostics: unknown;
  errorCategory: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export async function listReconciliationRuns(
  db: Database,
  organizationId: string,
  limit = 25,
): Promise<RunSummary[]> {
  return db
    .select({
      id: reconciliationRuns.id,
      status: reconciliationRuns.status,
      trigger: reconciliationRuns.trigger,
      ruleVersion: reconciliationRuns.ruleVersion,
      startedAt: reconciliationRuns.startedAt,
      finishedAt: reconciliationRuns.finishedAt,
      counts: reconciliationRuns.counts,
      diagnostics: reconciliationRuns.diagnostics,
      errorCategory: reconciliationRuns.errorCategory,
      errorMessage: reconciliationRuns.errorMessage,
      createdAt: reconciliationRuns.createdAt,
    })
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.organizationId, organizationId))
    .orderBy(sql`${reconciliationRuns.createdAt} desc`)
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function getLatestRun(
  db: Database,
  organizationId: string,
): Promise<RunSummary | null> {
  const rows = await listReconciliationRuns(db, organizationId, 1);
  return rows[0] ?? null;
}
