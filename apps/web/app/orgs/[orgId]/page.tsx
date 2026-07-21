import Link from "next/link";
import type { Metadata } from "next";
import {
  countOpenBySeverity,
  getLatestRun,
  newExceptionsByDay,
  recentHighPriority,
  revenueAtRiskByCurrency,
} from "@payrecon/db";
import { EXCEPTION_SEVERITIES, hasPermission } from "@payrecon/domain";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  SeverityBadge,
  StateBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import {
  displayAmount,
  displayDateTime,
  displayMoney,
  displayRelative,
  displayRuleName,
} from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { getDataPresence, getSourceFreshness } from "@/server/queries";
import { requireOrg } from "@/server/session";
import { loadDemoDataAction, runReconciliationAction } from "@/server/org-actions";

export const metadata: Metadata = { title: "Dashboard" };

const TREND_DAYS = 14;

/**
 * Fill in the days the query returned nothing for.
 *
 * A gap-free series is what makes the trend readable: without this, three
 * exceptions on three scattered days render as three adjacent bars and look
 * like a continuous run.
 */
function buildTrend(
  rows: Array<{ day: string; count: number }>,
  days: number,
): Array<{ day: string; count: number }> {
  const byDay = new Map(rows.map((row) => [row.day, row.count]));
  const now = new Date();
  const series: Array<{ day: string; count: number }> = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset),
    );
    const key = date.toISOString().slice(0, 10);
    series.push({ day: key, count: byDay.get(key) ?? 0 });
  }

  return series;
}

export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  const canReadExceptions = hasPermission(org.role, "exceptions:read");
  const canRunReconciliation = hasPermission(org.role, "reconciliation:run");
  const canLoadDemo = hasPermission(org.role, "demo:load");

  const base = `/orgs/${org.organizationId}`;
  const csrf = await getCsrfToken();
  const presence = await getDataPresence(org.organizationId);

  // ---------------------------------------------------------------------
  // First-run state: nothing ingested and nothing produced.
  // ---------------------------------------------------------------------
  if (presence.isEmpty) {
    return (
      <>
        <PageHeader
          title={org.organizationName}
          description="Nothing has been ingested yet, so there is nothing to reconcile."
        />

        <EmptyState
          title="This organization has no data yet"
          description={
            canLoadDemo
              ? "Load the built-in demo dataset to see genuine findings from the same engine production uses, or connect a read-only Stripe key and import your own records."
              : "Ask an admin to connect a read-only Stripe key and import your payment records, or to load the demo dataset."
          }
          action={
            <div className="flex flex-wrap items-start justify-center gap-3">
              {canLoadDemo && (
                <ActionForm
                  action={loadDemoDataAction}
                  csrf={csrf}
                  organizationId={org.organizationId}
                  submitLabel="Load demo data"
                  pendingLabel="Loading demo data…"
                  variant="primary"
                />
              )}
              {canRunReconciliation && (
                <ActionForm
                  action={runReconciliationAction}
                  csrf={csrf}
                  organizationId={org.organizationId}
                  submitLabel="Run reconciliation"
                  pendingLabel="Queueing…"
                  variant="secondary"
                />
              )}
              <Link href={`${base}/sources`}>
                <Button variant="secondary">Connect Stripe</Button>
              </Link>
            </div>
          }
        />
      </>
    );
  }

  // ---------------------------------------------------------------------
  // Normal state
  // ---------------------------------------------------------------------
  const [severityCounts, revenueRows, trendRows, freshness, latestRun, recent] = await Promise.all([
    countOpenBySeverity(db(), org.organizationId),
    revenueAtRiskByCurrency(db(), org.organizationId),
    newExceptionsByDay(db(), org.organizationId, TREND_DAYS),
    getSourceFreshness(org.organizationId),
    getLatestRun(db(), org.organizationId),
    recentHighPriority(db(), org.organizationId, 6),
  ]);

  const countBySeverity = new Map(severityCounts.map((row) => [row.severity, row.count]));
  const openTotal = severityCounts.reduce((total, row) => total + row.count, 0);

  const trend = buildTrend(trendRows, TREND_DAYS);
  const trendMax = trend.reduce((max, point) => Math.max(max, point.count), 0);
  const trendTotal = trend.reduce((total, point) => total + point.count, 0);

  return (
    <>
      <PageHeader
        title={org.organizationName}
        description={`${openTotal} exception${openTotal === 1 ? "" : "s"} currently need attention.`}
        actions={
          canRunReconciliation ? (
            <ActionForm
              action={runReconciliationAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Run reconciliation"
              pendingLabel="Queueing…"
              variant="primary"
              size="sm"
              className="space-y-2"
            />
          ) : undefined
        }
      />

      <div className="space-y-6">
        {/* Open exceptions by severity */}
        <section aria-labelledby="severity-heading">
          <h2 id="severity-heading" className="mb-2 text-sm font-semibold">
            Open exceptions by severity
          </h2>
          <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {EXCEPTION_SEVERITIES.map((severity) => {
              const count = countBySeverity.get(severity) ?? 0;
              return (
                <li key={severity}>
                  <Link
                    href={`${base}/exceptions?state=active&severity=${severity}`}
                    className="block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:bg-[var(--color-surface-raised)]"
                    aria-label={`${count} ${severity} severity exceptions needing attention`}
                  >
                    <SeverityBadge severity={severity} />
                    <p className="tabular mt-2 text-2xl font-semibold">{count}</p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      open, acknowledged or reopened
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Revenue at risk — one row per currency, never combined */}
          <Card
            title="Revenue at risk"
            description="Reported per currency. Amounts in different currencies are never added together."
          >
            {revenueRows.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No unresolved exception currently carries a quantified amount at risk.
              </p>
            ) : (
              <Table caption="Revenue at risk grouped by currency">
                <thead>
                  <tr>
                    <Th>Currency</Th>
                    <Th numeric>At risk</Th>
                    <Th numeric>Exceptions</Th>
                  </tr>
                </thead>
                <tbody>
                  {revenueRows.map((row) => (
                    <tr key={row.currency}>
                      <Td>
                        <span className="font-medium">{row.currency}</span>
                      </Td>
                      {/* bigint is formatted here, on the server, and only the
                          resulting string is ever rendered. */}
                      <Td numeric>{displayMoney(row.amountMinor, row.currency)}</Td>
                      <Td numeric>{row.count}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* Trend */}
          <Card
            title={`New exceptions, last ${TREND_DAYS} days`}
            description={`${trendTotal} first detected in this window.`}
          >
            {trendMax === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No new exceptions were detected in the last {TREND_DAYS} days.
              </p>
            ) : (
              <>
                {/* The bars are decorative: the same data is exposed to assistive
                    technology as a real table below. */}
                <div aria-hidden="true" className="flex h-28 items-end gap-1">
                  {trend.map((point) => (
                    <div
                      key={point.day}
                      className="flex h-full flex-1 flex-col justify-end"
                      title={`${point.day}: ${point.count}`}
                    >
                      <div
                        className="rounded-sm bg-[var(--color-accent)]"
                        style={{
                          // A non-zero day always shows at least a sliver, so
                          // "one exception" never looks identical to "none".
                          height: point.count === 0 ? "2px" : `${(point.count / trendMax) * 100}%`,
                          opacity: point.count === 0 ? 0.25 : 1,
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div
                  aria-hidden="true"
                  className="mt-1 flex justify-between text-xs text-[var(--color-text-subtle)]"
                >
                  <span>{trend[0]?.day}</span>
                  <span>peak {trendMax}</span>
                  <span>{trend[trend.length - 1]?.day}</span>
                </div>
                <table className="sr-only">
                  <caption>New exceptions per day over the last {TREND_DAYS} days</caption>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">New exceptions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trend.map((point) => (
                      <tr key={point.day}>
                        <th scope="row">{point.day}</th>
                        <td>{point.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </div>

        {/* Source freshness */}
        <Card
          title="Source freshness"
          description="How current the inputs were the last time a conclusion was drawn."
          actions={
            <Link href={`${base}/runs`} className="text-sm underline">
              Reconciliation runs
            </Link>
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">
                Last reconciliation run
              </dt>
              <dd className="mt-0.5 text-sm">
                {latestRun ? (
                  <>
                    <span className="font-medium">{latestRun.status}</span>{" "}
                    <span className="text-[var(--color-text-muted)]">
                      · {displayRelative(latestRun.finishedAt ?? latestRun.createdAt)}
                    </span>
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      trigger: {latestRun.trigger} · rule version {latestRun.ruleVersion}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">Never run</span>
                )}
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">
                Internal payment records
              </dt>
              <dd className="mt-0.5 text-sm">
                <span className="tabular font-medium">{freshness.internalRecords.total}</span>{" "}
                <span className="text-[var(--color-text-muted)]">records</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  updated {displayRelative(freshness.internalRecords.lastUpdatedAt)}
                </span>
              </dd>
            </div>

            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">Last import</dt>
              <dd className="mt-0.5 text-sm">
                {freshness.lastImport ? (
                  <>
                    <span className="font-medium">{freshness.lastImport.status}</span>
                    <span className="block truncate text-xs text-[var(--color-text-muted)]">
                      {freshness.lastImport.filename} · {displayRelative(freshness.lastImport.at)}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-muted)]">No imports yet</span>
                )}
              </dd>
            </div>
          </dl>

          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
              Stripe connections
            </h3>
            {freshness.connections.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No Stripe connection has been added.{" "}
                <Link href={`${base}/sources`} className="underline">
                  Sources
                </Link>
              </p>
            ) : (
              <Table caption="Stripe connections and their last successful sync">
                <thead>
                  <tr>
                    <Th>Connection</Th>
                    <Th>Mode</Th>
                    <Th>Status</Th>
                    <Th>Last successful sync</Th>
                  </tr>
                </thead>
                <tbody>
                  {freshness.connections.map((connection) => (
                    <tr key={connection.id}>
                      <Td>{connection.name}</Td>
                      <Td>{connection.livemode ? "live" : "test"}</Td>
                      <Td>{connection.status}</Td>
                      <Td>
                        {displayRelative(connection.lastSuccessfulSyncAt)}
                        <span className="block text-xs text-[var(--color-text-subtle)]">
                          {displayDateTime(connection.lastSuccessfulSyncAt)}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </Card>

        {/* Recently changed critical/high */}
        <Card
          title="Recently changed critical and high exceptions"
          description="Unresolved findings, most recently updated first."
          actions={
            canReadExceptions ? (
              <Link href={`${base}/exceptions?state=active`} className="text-sm underline">
                All exceptions
              </Link>
            ) : undefined
          }
        >
          {!canReadExceptions ? (
            <Alert tone="info">Your role does not include access to the exception inbox.</Alert>
          ) : recent.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Nothing critical or high is currently unresolved.
            </p>
          ) : (
            <Table caption="Recently changed critical and high severity exceptions">
              <thead>
                <tr>
                  <Th>Severity</Th>
                  <Th>State</Th>
                  <Th>Problem</Th>
                  <Th numeric>At risk</Th>
                  <Th>Updated</Th>
                </tr>
              </thead>
              <tbody>
                {recent.map((exception) => (
                  <tr key={exception.id}>
                    <Td>
                      <SeverityBadge severity={exception.severity} />
                    </Td>
                    <Td>
                      <StateBadge state={exception.state} />
                    </Td>
                    <Td>
                      <Link
                        href={`${base}/exceptions/${exception.id}`}
                        className="underline underline-offset-2"
                      >
                        {exception.summary}
                      </Link>
                      <span className="block text-xs text-[var(--color-text-muted)]">
                        {displayRuleName(exception.ruleId)}
                      </span>
                    </Td>
                    <Td numeric>
                      {displayAmount(exception.revenueAtRiskMinor, exception.currency)}
                    </Td>
                    <Td>{displayRelative(exception.updatedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
