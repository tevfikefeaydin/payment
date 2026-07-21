import Link from "next/link";
import type { Metadata } from "next";
import { listExceptions, listMembers, type ExceptionSortField } from "@payrecon/db";
import { EXCEPTION_SEVERITIES, RECONCILIATION_RULE_IDS, hasPermission } from "@payrecon/domain";
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  SeverityBadge,
  StateBadge,
  Table,
  Td,
  Th,
  PageHeader,
} from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import {
  DEFAULT_PAGE_SIZE,
  PARAM,
  STATE_OPTIONS,
  ariaSort,
  buildQuery,
  parseExceptionQuery,
  sortHref,
  type SearchParamsInput,
} from "@/lib/exception-filters";
import { displayAmount, displayDateTime, displayRelative, displayRuleName } from "@/lib/format";
import { db } from "@/server/db";
import { listExceptionCurrencies } from "@/server/queries";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Exceptions" };

const TH_CLASS =
  "border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]";

/**
 * A column header that sorts. Rendered as a real `<th>` rather than through the
 * shared `Th` so it can carry `aria-sort`, which is what actually communicates
 * the current ordering to a screen reader.
 */
function SortableTh({
  label,
  field,
  numeric,
  pathname,
  searchParams,
  current,
}: {
  label: string;
  field: ExceptionSortField;
  numeric?: boolean;
  pathname: string;
  searchParams: SearchParamsInput;
  current: { sort: ExceptionSortField; direction: "asc" | "desc" };
}) {
  const active = current.sort === field;
  const indicator = !active ? "↕" : current.direction === "asc" ? "▲" : "▼";

  return (
    <th
      scope="col"
      aria-sort={ariaSort(field, current)}
      className={`${TH_CLASS} ${numeric ? "text-right" : "text-left"}`}
    >
      <Link
        href={sortHref(pathname, searchParams, field, current)}
        className="inline-flex items-center gap-1 hover:underline"
      >
        {label}
        <span aria-hidden="true" className={active ? undefined : "opacity-40"}>
          {indicator}
        </span>
      </Link>
    </th>
  );
}

export default async function ExceptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<SearchParamsInput>;
}) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  // Hiding the nav link is a courtesy; this is the check that matters.
  if (!hasPermission(org.role, "exceptions:read")) {
    return (
      <>
        <PageHeader title="Exceptions" />
        <NotPermitted what="the exception inbox" role={org.role} />
      </>
    );
  }

  const rawSearchParams = await searchParams;
  const query = parseExceptionQuery(rawSearchParams);
  const pathname = `/orgs/${org.organizationId}/exceptions`;

  const [result, members, currencies] = await Promise.all([
    listExceptions(db(), {
      // The organization comes from the VERIFIED context, never the query string.
      organizationId: org.organizationId,
      ...query.filters,
      sort: query.sort,
      direction: query.direction,
      page: query.page,
      pageSize: query.pageSize,
    }),
    listMembers(db(), org.organizationId),
    listExceptionCurrencies(org.organizationId),
  ]);

  const current = { sort: query.sort, direction: query.direction };
  const totalPages = Math.max(Math.ceil(result.total / result.pageSize), 1);
  const firstRow = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const lastRow = Math.min(result.page * result.pageSize, result.total);

  return (
    <>
      <PageHeader
        title="Exceptions"
        description="Every filter lives in the URL, so any view you reach can be pasted into a ticket."
      />

      {/* Filters. A plain GET form: no JavaScript required, and the resulting
          URL is the shareable link. */}
      <Card title="Filters" className="mb-6">
        <form method="get" action={pathname} className="space-y-4">
          {/* Preserve the current ordering when filters change. */}
          <input type="hidden" name={PARAM.sort} value={query.sort} />
          <input type="hidden" name={PARAM.direction} value={query.direction} />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Search"
              htmlFor="filter-q"
              hint="Matches provider and internal identifiers, and rule names."
            >
              <Input
                id="filter-q"
                name={PARAM.search}
                type="search"
                defaultValue={query.raw.search}
                maxLength={120}
                placeholder="pi_… or order-1234"
              />
            </Field>

            <Field label="State" htmlFor="filter-state">
              <Select id="filter-state" name={PARAM.state} defaultValue={query.raw.state}>
                {STATE_OPTIONS.map((option) => (
                  <option key={option.value || "any"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Severity" htmlFor="filter-severity">
              <Select id="filter-severity" name={PARAM.severity} defaultValue={query.raw.severity}>
                <option value="">Any severity</option>
                {EXCEPTION_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Rule" htmlFor="filter-rule">
              <Select id="filter-rule" name={PARAM.rule} defaultValue={query.raw.rule}>
                <option value="">Any rule</option>
                {RECONCILIATION_RULE_IDS.map((ruleId) => (
                  <option key={ruleId} value={ruleId}>
                    {displayRuleName(ruleId)}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Assignee" htmlFor="filter-assignee">
              <Select id="filter-assignee" name={PARAM.assignee} defaultValue={query.raw.assignee}>
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Currency" htmlFor="filter-currency">
              <Select id="filter-currency" name={PARAM.currency} defaultValue={query.raw.currency}>
                <option value="">Any currency</option>
                {currencies.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Min at risk"
              htmlFor="filter-min"
              hint="Smallest currency unit: 2500 = 25.00 USD."
            >
              <Input
                id="filter-min"
                name={PARAM.min}
                type="text"
                inputMode="numeric"
                defaultValue={query.raw.min}
                placeholder="0"
              />
            </Field>

            <Field label="Max at risk" htmlFor="filter-max" hint="Leave blank for no upper bound.">
              <Input
                id="filter-max"
                name={PARAM.max}
                type="text"
                inputMode="numeric"
                defaultValue={query.raw.max}
              />
            </Field>

            <Field label="Created from" htmlFor="filter-from">
              <Input id="filter-from" name={PARAM.from} type="date" defaultValue={query.raw.from} />
            </Field>

            <Field label="Created to" htmlFor="filter-to">
              <Input id="filter-to" name={PARAM.to} type="date" defaultValue={query.raw.to} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="sm">
              Apply filters
            </Button>
            {query.hasFilters ? (
              <Link href={pathname} className="text-sm underline">
                Clear all filters
              </Link>
            ) : (
              <span className="text-sm text-[var(--color-text-subtle)]">No filters applied</span>
            )}
          </div>
        </form>
      </Card>

      {result.total === 0 ? (
        query.hasFilters ? (
          <EmptyState
            title="No exceptions match these filters"
            description="There are exceptions in this organization, but none of them match every filter you have applied. Widen or clear the filters to see more."
            action={
              <Link href={pathname}>
                <Button variant="secondary">Clear all filters</Button>
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No exceptions yet"
            description="Nothing has been flagged. Either reconciliation has not run against your data yet, or the last run found no disagreements between Stripe and your records."
            action={
              <Link href={`/orgs/${org.organizationId}/runs`}>
                <Button variant="secondary">See reconciliation runs</Button>
              </Link>
            }
          />
        )
      ) : (
        <>
          <Table caption="Exceptions matching the current filters">
            <thead>
              <tr>
                <SortableTh
                  label="Severity"
                  field="severity"
                  pathname={pathname}
                  searchParams={rawSearchParams}
                  current={current}
                />
                <Th>State</Th>
                <Th>Rule</Th>
                <Th>Problem</Th>
                <SortableTh
                  label="At risk"
                  field="revenueAtRisk"
                  numeric
                  pathname={pathname}
                  searchParams={rawSearchParams}
                  current={current}
                />
                <Th>Assignee</Th>
                <SortableTh
                  label="First seen"
                  field="createdAt"
                  pathname={pathname}
                  searchParams={rawSearchParams}
                  current={current}
                />
                <SortableTh
                  label="Last updated"
                  field="updatedAt"
                  pathname={pathname}
                  searchParams={rawSearchParams}
                  current={current}
                />
              </tr>
            </thead>
            <tbody>
              {result.items.map((exception) => (
                <tr key={exception.id}>
                  <Td>
                    <SeverityBadge severity={exception.severity} />
                  </Td>
                  <Td>
                    <StateBadge state={exception.state} />
                  </Td>
                  <Td>
                    <span className="text-xs">{displayRuleName(exception.ruleId)}</span>
                  </Td>
                  <Td className="max-w-md">
                    <Link
                      href={`${pathname}/${exception.id}`}
                      className="underline underline-offset-2"
                    >
                      {exception.summary}
                    </Link>
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      last seen {displayRelative(exception.lastSeenAt)}
                    </span>
                  </Td>
                  {/* Exact amount, formatted server-side from bigint minor units. */}
                  <Td numeric>{displayAmount(exception.revenueAtRiskMinor, exception.currency)}</Td>
                  <Td>
                    {exception.assignedToName ?? (
                      <span className="text-[var(--color-text-subtle)]">Unassigned</span>
                    )}
                  </Td>
                  <Td>
                    <span title={displayDateTime(exception.createdAt)}>
                      {displayRelative(exception.createdAt)}
                    </span>
                  </Td>
                  <Td>
                    <span title={displayDateTime(exception.updatedAt)}>
                      {displayRelative(exception.updatedAt)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <nav
            aria-label="Pagination"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-[var(--color-text-muted)]" role="status">
              Showing <span className="tabular">{firstRow}</span>–
              <span className="tabular">{lastRow}</span> of{" "}
              <span className="tabular">{result.total}</span>
              {result.total === 1 ? " exception" : " exceptions"} · page {result.page} of{" "}
              {totalPages}
            </p>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={`${pathname}${buildQuery(rawSearchParams, {
                    [PARAM.page]: String(result.page - 1),
                  })}`}
                  rel="prev"
                >
                  <Button variant="secondary" size="sm">
                    Previous
                  </Button>
                </Link>
              ) : (
                <Button variant="secondary" size="sm" disabled title="You are on the first page">
                  Previous
                </Button>
              )}
              {result.page < totalPages ? (
                <Link
                  href={`${pathname}${buildQuery(rawSearchParams, {
                    [PARAM.page]: String(result.page + 1),
                  })}`}
                  rel="next"
                >
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

          {result.pageSize !== DEFAULT_PAGE_SIZE && (
            <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
              Showing {result.pageSize} rows per page.
            </p>
          )}
        </>
      )}
    </>
  );
}
