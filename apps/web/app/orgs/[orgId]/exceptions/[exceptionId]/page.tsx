import Link from "next/link";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getException, getExceptionTimeline, listMembers } from "@payrecon/db";
import { MAX_TRANSITION_NOTE_LENGTH, availableTransitions, hasPermission } from "@payrecon/domain";
import {
  Alert,
  Card,
  Identifier,
  PageHeader,
  SeverityBadge,
  StateBadge,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { NotPermitted } from "@/components/forbidden";
import { asEvidenceFields, asStringArray } from "@/lib/json";
import { displayDateTime, displayMoney, displayRelative, displayRuleName } from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { requireOrg } from "@/server/session";
import { assignExceptionAction, transitionExceptionAction } from "@/server/exception-actions";

/**
 * Resolve the organization and the exception, once per request.
 *
 * `cache` dedupes the work between `generateMetadata` and the page body.
 *
 * The lookup deliberately lives in `generateMetadata` as well: Next resolves
 * metadata BEFORE it flushes the streaming shell, so a `notFound()` raised here
 * produces a genuine 404 status. Raised from the page body alone it would only
 * swap the rendered UI, because the enclosing `loading.tsx` has already
 * committed a 200 to the wire.
 */
const loadException = cache(async (orgId: string, exceptionId: string) => {
  const org = await requireOrg(orgId);

  // Someone who cannot read exceptions is told so, rather than being given a
  // 404 that would imply the exception does not exist.
  if (!hasPermission(org.role, "exceptions:read")) {
    return { org, exception: null, permitted: false as const };
  }

  // The tenant is part of the lookup, so an exception belonging to another
  // organization is indistinguishable from one that does not exist. This is the
  // cross-tenant defence for this route.
  return {
    org,
    exception: await getException(db(), org.organizationId, exceptionId),
    permitted: true as const,
  };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ orgId: string; exceptionId: string }>;
}): Promise<Metadata> {
  const { orgId, exceptionId } = await params;
  const { exception, permitted } = await loadException(orgId, exceptionId);
  if (permitted && !exception) notFound();
  return { title: exception ? exception.summary.slice(0, 60) : "Exception" };
}

/** Row of the evidence comparison. `differs` is marked in text, not just colour. */
function EvidenceRow({
  label,
  providerValue,
  internalValue,
  differs,
}: {
  label: string;
  providerValue: string | null;
  internalValue: string | null;
  differs: boolean;
}) {
  return (
    <tr className={differs ? "bg-[var(--color-critical-bg)]" : undefined}>
      <th
        scope="row"
        className="border-b border-[var(--color-border)] px-3 py-2 text-left align-top text-sm font-medium"
      >
        {label}
        {differs && (
          <span className="ml-2 rounded bg-[var(--color-critical)] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            differs
          </span>
        )}
      </th>
      <Td className={differs ? "font-medium" : undefined}>
        {providerValue ?? <span className="text-[var(--color-text-subtle)]">not present</span>}
      </Td>
      <Td className={differs ? "font-medium" : undefined}>
        {internalValue ?? <span className="text-[var(--color-text-subtle)]">not present</span>}
      </Td>
    </tr>
  );
}

export default async function ExceptionDetailPage({
  params,
}: {
  params: Promise<{ orgId: string; exceptionId: string }>;
}) {
  const { orgId, exceptionId } = await params;
  // Deduped with the call made in `generateMetadata`.
  const { org, exception, permitted } = await loadException(orgId, exceptionId);

  if (!permitted) {
    return (
      <>
        <PageHeader title="Exception" />
        <NotPermitted what="the exception inbox" role={org.role} />
      </>
    );
  }

  // `generateMetadata` already raised a 404 for a missing or foreign exception;
  // this repeats the guard so the page never depends on that ordering.
  if (!exception) notFound();

  const [timeline, members, csrf] = await Promise.all([
    getExceptionTimeline(db(), org.organizationId, exceptionId),
    listMembers(db(), org.organizationId),
    getCsrfToken(),
  ]);

  const evidence = asEvidenceFields(exception.evidence);
  const probableCauses = asStringArray(exception.probableCauses);
  const recommendedActions = asStringArray(exception.recommendedActions);
  const transitions = availableTransitions(exception.state);

  const canTransitionException = hasPermission(org.role, "exceptions:transition");
  const canAssign = hasPermission(org.role, "exceptions:assign");
  const base = `/orgs/${org.organizationId}/exceptions`;

  // Every transition form carries the version the page was rendered with. If
  // someone else writes first, the UPDATE matches no row and the operator is
  // told, rather than silently overwriting them.
  const versionFields = {
    exceptionId: exception.id,
    fromState: exception.state,
    expectedVersion: String(exception.version),
  };

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href={base} className="underline">
          ← Back to exceptions
        </Link>
      </p>

      <PageHeader title={exception.summary} description={displayRuleName(exception.ruleId)} />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <SeverityBadge severity={exception.severity} />
        <StateBadge state={exception.state} />
        <span className="text-sm text-[var(--color-text-muted)]">
          Revenue at risk:{" "}
          <span className="tabular font-medium text-[var(--color-text)]">
            {displayMoney(exception.revenueAtRiskMinor, exception.currency)}
          </span>
          {exception.revenueAtRiskMinor === null && " (this rule implies no direct exposure)"}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Evidence */}
          <Card
            title="Evidence"
            description="What each side reports, compared field by field. Rows marked “differs” are the disagreement."
          >
            {evidence.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                This exception carries no structured field comparison.
              </p>
            ) : (
              <Table caption="Provider evidence compared with internal evidence">
                <thead>
                  <tr>
                    <Th>Field</Th>
                    <Th>Stripe (provider)</Th>
                    <Th>Your records (internal)</Th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.map((field, index) => (
                    <EvidenceRow key={`${field.label}-${index}`} {...field} />
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {/* Causes and actions */}
          <div className="grid gap-6 sm:grid-cols-2">
            <Card title="Probable causes">
              {probableCauses.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]">
                  No probable causes were recorded for this finding.
                </p>
              ) : (
                <ul className="list-disc space-y-2 pl-5 text-sm text-[var(--color-text-muted)]">
                  {probableCauses.map((cause, index) => (
                    <li key={index}>{cause}</li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Recommended next steps">
              {recommendedActions.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]">
                  No recommended actions were recorded for this finding.
                </p>
              ) : (
                <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--color-text-muted)]">
                  {recommendedActions.map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          {/* Timeline */}
          <Card
            title="Timeline"
            description="Every state change and assignment, in order. Append-only."
          >
            {timeline.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No events have been recorded for this exception.
              </p>
            ) : (
              <ol className="space-y-4">
                {timeline.map((entry) => (
                  <li
                    key={entry.id}
                    className="border-l-2 border-[var(--color-border-strong)] pl-4"
                  >
                    <p className="text-sm font-medium">
                      {entry.action === "state_changed" && entry.fromState && entry.toState
                        ? `Moved from ${entry.fromState} to ${entry.toState}`
                        : entry.action === "created"
                          ? "Detected by reconciliation"
                          : entry.action === "reopened"
                            ? "Reopened automatically"
                            : entry.action === "assigned"
                              ? "Assignment changed"
                              : entry.action}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {entry.actorType === "system" ? "System" : (entry.actorName ?? "A member")} ·{" "}
                      {displayDateTime(entry.createdAt)} ({displayRelative(entry.createdAt)})
                    </p>
                    {entry.note && (
                      <p className="mt-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-sm">
                        {entry.note}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <Card title="Actions">
            {!canTransitionException ? (
              <Alert tone="info">
                Your role ({org.role}) can view exceptions but not change their state.
              </Alert>
            ) : transitions.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                There are no state changes available from “{exception.state}”.
              </p>
            ) : (
              <div className="space-y-4">
                {transitions.map((transition) => {
                  const isResolve = transition.to === "resolved";
                  return (
                    <ActionForm
                      key={`${transition.from}-${transition.to}`}
                      action={transitionExceptionAction}
                      csrf={csrf}
                      organizationId={org.organizationId}
                      fields={{ ...versionFields, toState: transition.to }}
                      submitLabel={transition.label}
                      pendingLabel={`${transition.label}…`}
                      variant={isResolve ? "primary" : "secondary"}
                      size="sm"
                      className="space-y-2"
                    >
                      {isResolve && (
                        <div className="space-y-1.5">
                          <label htmlFor="resolve-note" className="block text-sm font-medium">
                            Resolution note (optional)
                          </label>
                          <textarea
                            id="resolve-note"
                            name="note"
                            rows={3}
                            maxLength={MAX_TRANSITION_NOTE_LENGTH}
                            aria-describedby="resolve-note-hint"
                            className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                            placeholder="What did you find, and what did you change?"
                          />
                          <p
                            id="resolve-note-hint"
                            className="text-xs text-[var(--color-text-muted)]"
                          >
                            Up to {MAX_TRANSITION_NOTE_LENGTH} characters. Visible to everyone in
                            this organization — never paste keys or customer secrets.
                          </p>
                        </div>
                      )}
                    </ActionForm>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Assignment">
            <p className="mb-3 text-sm">
              Currently:{" "}
              <span className="font-medium">{exception.assignedToName ?? "Unassigned"}</span>
            </p>
            {canAssign ? (
              <ActionForm
                action={assignExceptionAction}
                csrf={csrf}
                organizationId={org.organizationId}
                fields={{ exceptionId: exception.id }}
                submitLabel="Update assignment"
                pendingLabel="Saving…"
                size="sm"
              >
                <div className="space-y-1.5">
                  <label htmlFor="assignee" className="block text-sm font-medium">
                    Assign to
                  </label>
                  <Select
                    id="assignee"
                    name="assigneeUserId"
                    defaultValue={exception.assignedToUserId ?? ""}
                  >
                    <option value="">Unassigned</option>
                    {members.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.name} ({member.role})
                      </option>
                    ))}
                  </Select>
                </div>
              </ActionForm>
            ) : (
              <Alert tone="info">Your role ({org.role}) cannot change assignment.</Alert>
            )}
          </Card>

          <Card title="Details">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">Rule</dt>
                <dd>
                  {displayRuleName(exception.ruleId)}{" "}
                  <span className="text-xs text-[var(--color-text-muted)]">
                    (version {exception.ruleVersion})
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">
                  Provider object
                </dt>
                <dd>
                  <Identifier value={exception.providerObjectId} />
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">
                  Internal record
                </dt>
                <dd>
                  <Identifier value={exception.internalExternalId} />
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">Occurred</dt>
                <dd>{displayDateTime(exception.occurredAt)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">First seen</dt>
                <dd>{displayDateTime(exception.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">
                  Last seen by reconciliation
                </dt>
                <dd>
                  {displayRelative(exception.lastSeenAt)}
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    {displayDateTime(exception.lastSeenAt)}
                  </span>
                </dd>
              </div>
              {exception.resolvedAt && (
                <div>
                  <dt className="text-xs font-medium text-[var(--color-text-muted)]">Resolved</dt>
                  <dd>{displayDateTime(exception.resolvedAt)}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">Fingerprint</dt>
                <dd>
                  <Identifier value={exception.fingerprint} />
                  <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                    Stable across runs, so re-detecting this problem updates it rather than creating
                    a duplicate.
                  </span>
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
