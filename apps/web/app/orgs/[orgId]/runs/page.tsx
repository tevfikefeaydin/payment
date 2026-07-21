import type { Metadata } from "next";
import { listReconciliationRuns } from "@payrecon/db";
import { hasPermission } from "@payrecon/domain";
import { Alert, Card, EmptyState, Identifier, PageHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { NotPermitted } from "@/components/forbidden";
import { asDisplayPairs, humanizeKey } from "@/lib/json";
import { displayDateTime, displayRelative } from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { requireOrg } from "@/server/session";
import { runReconciliationAction } from "@/server/org-actions";

export const metadata: Metadata = { title: "Reconciliation runs" };

const RUN_LIMIT = 25;

/** Duration between two instants, or null while a run is still going. */
function duration(startedAt: Date | null, finishedAt: Date | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function RunsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "reconciliation:read")) {
    return (
      <>
        <PageHeader title="Reconciliation runs" />
        <NotPermitted what="reconciliation runs" role={org.role} />
      </>
    );
  }

  const canRun = hasPermission(org.role, "reconciliation:run");
  const [runs, csrf] = await Promise.all([
    listReconciliationRuns(db(), org.organizationId, RUN_LIMIT),
    getCsrfToken(),
  ]);

  return (
    <>
      <PageHeader
        title="Reconciliation runs"
        description={`The ${RUN_LIMIT} most recent runs. Each records the rule version it used and the source snapshot it saw, so a past conclusion can be explained.`}
        actions={
          canRun ? (
            <ActionForm
              action={runReconciliationAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Run reconciliation now"
              pendingLabel="Queueing…"
              variant="primary"
              size="sm"
              className="space-y-2"
            />
          ) : undefined
        }
      />

      {!canRun && (
        <Alert tone="info">
          <p>
            Your role ({org.role}) can read run history but not start a run. An analyst, admin or
            owner can trigger one.
          </p>
        </Alert>
      )}

      {runs.length === 0 ? (
        <EmptyState
          title="No reconciliation has run yet"
          description={
            canRun
              ? "Start a run to compare your Stripe data with your internal payment records. Runs are queued and processed by the background worker."
              : "Once a run has happened, its status, counts and any sanitised error will appear here."
          }
        />
      ) : (
        <ul className="mt-4 space-y-4">
          {runs.map((run) => {
            const counts = asDisplayPairs(run.counts);
            const diagnostics = asDisplayPairs(run.diagnostics);
            const elapsed = duration(run.startedAt, run.finishedAt);

            return (
              <li key={run.id}>
                <Card
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="capitalize">{run.status}</span>
                      <span className="text-xs font-normal text-[var(--color-text-muted)]">
                        trigger: {run.trigger} · rule version {run.ruleVersion}
                      </span>
                    </span>
                  }
                  description={`Started ${displayDateTime(run.startedAt ?? run.createdAt)} · ${displayRelative(run.finishedAt ?? run.startedAt ?? run.createdAt)}${elapsed ? ` · took ${elapsed}` : " · still running"}`}
                >
                  {run.status === "failed" && (
                    <div className="mb-4">
                      <Alert tone="error" title="This run failed">
                        <p>
                          {run.errorMessage ?? "No further detail was recorded for this failure."}
                        </p>
                        {run.errorCategory && (
                          <p className="mt-1 text-xs">
                            Category: <Identifier value={run.errorCategory} />
                          </p>
                        )}
                        <p className="mt-1 text-xs">
                          Messages are sanitised before storage, so they never contain key material
                          or row values.
                        </p>
                      </Alert>
                    </div>
                  )}

                  <div className="grid gap-6 sm:grid-cols-2">
                    <div>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                        Counts
                      </h3>
                      {counts.length === 0 ? (
                        <p className="text-sm text-[var(--color-text-muted)]">
                          No counts were recorded.
                        </p>
                      ) : (
                        <dl className="space-y-1 text-sm">
                          {counts.map(([key, value]) => (
                            <div key={key} className="flex justify-between gap-4">
                              <dt className="text-[var(--color-text-muted)]">{humanizeKey(key)}</dt>
                              <dd className="tabular">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>

                    <div>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                        Diagnostics
                      </h3>
                      {diagnostics.length === 0 ? (
                        <p className="text-sm text-[var(--color-text-muted)]">
                          No diagnostics were recorded.
                        </p>
                      ) : (
                        <dl className="space-y-1 text-sm">
                          {diagnostics.map(([key, value]) => (
                            <div key={key} className="flex justify-between gap-4">
                              <dt className="text-[var(--color-text-muted)]">{humanizeKey(key)}</dt>
                              <dd className="tabular text-right">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  </div>

                  <p className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
                    Run <Identifier value={run.id} />
                    {run.finishedAt && ` · finished ${displayDateTime(run.finishedAt)}`}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
