import Link from "next/link";
import type { Metadata } from "next";
import { listAuditActions, listAuditEvents, listMembers } from "@payrecon/db";
import { hasPermission } from "@payrecon/domain";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Identifier,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { asDisplayPairs, humanizeKey } from "@/lib/json";
import { buildQuery, type SearchParamsInput } from "@/lib/exception-filters";
import { displayDateTime, displayRelative } from "@/lib/format";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Audit log" };

const PAGE_SIZE = 50;

function single(input: SearchParamsInput, key: string): string {
  const value = input[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ?? "";
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<SearchParamsInput>;
}) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "audit:read")) {
    return (
      <>
        <PageHeader title="Audit log" />
        <NotPermitted what="the audit log" role={org.role} />
      </>
    );
  }

  const raw = await searchParams;
  const pathname = `/orgs/${org.organizationId}/audit`;

  const actionFilter = single(raw, "action");
  const actorFilter = single(raw, "actor");
  const pageRaw = Number.parseInt(single(raw, "page") || "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const [members, actions] = await Promise.all([
    listMembers(db(), org.organizationId),
    listAuditActions(db(), org.organizationId),
  ]);

  // Only accept an actor id that belongs to this organization. An id from the
  // query string is otherwise just an unvalidated filter on a tenant-scoped
  // table — harmless, but this keeps the filter honest.
  const actorUserId = members.some((member) => member.userId === actorFilter)
    ? actorFilter
    : undefined;
  const action = actions.includes(actionFilter) ? actionFilter : undefined;

  const { rows, total } = await listAuditEvents(db(), {
    organizationId: org.organizationId,
    ...(action ? { action } : {}),
    ...(actorUserId ? { actorUserId } : {}),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const memberNames = new Map(members.map((member) => [member.userId, member.name]));
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const hasFilters = Boolean(action || actorUserId);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of security- and finance-relevant actions in this organization. Entries cannot be edited or deleted."
      />

      <Card title="Filters" className="mb-6">
        <form method="get" action={pathname} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Action" htmlFor="audit-action">
              <Select id="audit-action" name="action" defaultValue={action ?? ""}>
                <option value="">Any action</option>
                {actions.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Actor"
              htmlFor="audit-actor"
              hint="System and API-key actors are always shown."
            >
              <Select id="audit-actor" name="actor" defaultValue={actorUserId ?? ""}>
                <option value="">Anyone</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="sm">
              Apply filters
            </Button>
            {hasFilters ? (
              <Link href={pathname} className="text-sm underline">
                Clear filters
              </Link>
            ) : (
              <span className="text-sm text-[var(--color-text-subtle)]">No filters applied</span>
            )}
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        hasFilters ? (
          <EmptyState
            title="No audit events match these filters"
            description="Try a different action or actor, or clear the filters to see the full log."
            action={
              <Link href={pathname}>
                <Button variant="secondary">Clear filters</Button>
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No audit events yet"
            description="Actions such as sign-ins, membership changes, connection changes and reconciliation runs are recorded here as they happen."
          />
        )
      ) : (
        <>
          <Table caption="Audit events, most recent first">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                <Th>Target</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const metadata = asDisplayPairs(row.metadata);
                return (
                  <tr key={row.id}>
                    <Td>
                      <span title={displayDateTime(row.createdAt)}>
                        {displayRelative(row.createdAt)}
                      </span>
                      <span className="block text-xs text-[var(--color-text-subtle)]">
                        {displayDateTime(row.createdAt)}
                      </span>
                    </Td>
                    <Td>
                      <Identifier value={row.action} />
                    </Td>
                    <Td>
                      {row.actorType === "user"
                        ? (memberNames.get(row.actorUserId ?? "") ??
                          "A user who is no longer a member")
                        : row.actorType === "api_key"
                          ? "API key"
                          : "System"}
                    </Td>
                    <Td>
                      {row.targetType ? (
                        <>
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {humanizeKey(row.targetType)}
                          </span>
                          <span className="block">
                            <Identifier value={row.targetId} />
                          </span>
                        </>
                      ) : (
                        <span className="text-[var(--color-text-subtle)]">—</span>
                      )}
                    </Td>
                    <Td>
                      {metadata.length === 0 ? (
                        <span className="text-[var(--color-text-subtle)]">—</span>
                      ) : (
                        <dl className="space-y-0.5 text-xs">
                          {metadata.map(([key, value]) => (
                            <div key={key} className="flex gap-2">
                              <dt className="text-[var(--color-text-muted)]">
                                {humanizeKey(key)}:
                              </dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          <nav
            aria-label="Pagination"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-[var(--color-text-muted)]" role="status">
              <span className="tabular">{total}</span> event{total === 1 ? "" : "s"} · page {page}{" "}
              of {totalPages}
            </p>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link href={`${pathname}${buildQuery(raw, { page: String(page - 1) })}`} rel="prev">
                  <Button variant="secondary" size="sm">
                    Previous
                  </Button>
                </Link>
              ) : (
                <Button variant="secondary" size="sm" disabled title="You are on the first page">
                  Previous
                </Button>
              )}
              {page < totalPages ? (
                <Link href={`${pathname}${buildQuery(raw, { page: String(page + 1) })}`} rel="next">
                  <Button variant="secondary" size="sm">
                    Next
                  </Button>
                </Link>
              ) : (
                <Button variant="secondary" size="sm" disabled title="You are on the last page">
                  Next
                </Button>
              )}
            </div>
          </nav>
        </>
      )}
    </>
  );
}
