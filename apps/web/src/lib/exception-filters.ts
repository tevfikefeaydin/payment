import {
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATES,
  isReconciliationRuleId,
  parseAmountMinor,
  type ExceptionSeverity,
  type ExceptionState,
} from "@payrecon/domain";
import type { ExceptionFilters, ExceptionSortField } from "@payrecon/db";

/**
 * URL <-> filter translation for the exception inbox.
 *
 * Filters live entirely in the query string so any view an operator reaches is
 * a shareable link. Parsing is total and forgiving: an unknown or malformed
 * value is dropped rather than erroring, because a link pasted into a ticket
 * must never render a broken page.
 *
 * Nothing here trusts the input for authorization — the organization always
 * comes from the verified route context, never from a query parameter.
 */

export type SearchParamsInput = Record<string, string | string[] | undefined>;

export const PARAM = {
  state: "state",
  severity: "severity",
  rule: "rule",
  assignee: "assignee",
  currency: "currency",
  min: "min",
  max: "max",
  from: "from",
  to: "to",
  search: "q",
  sort: "sort",
  direction: "dir",
  page: "page",
} as const;

/** The three states that still demand operator attention. */
const ACTIVE_STATES: ExceptionState[] = ["open", "acknowledged", "reopened"];

export const STATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any state" },
  { value: "active", label: "Active (open, acknowledged, reopened)" },
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "resolved", label: "Resolved" },
  { value: "reopened", label: "Reopened" },
];

export const SORT_OPTIONS: Array<{ value: ExceptionSortField; label: string }> = [
  { value: "createdAt", label: "First seen" },
  { value: "updatedAt", label: "Last updated" },
  { value: "severity", label: "Severity" },
  { value: "revenueAtRisk", label: "Revenue at risk" },
  { value: "occurredAt", label: "Occurred" },
];

const SORT_FIELDS = new Set<string>(SORT_OPTIONS.map((option) => option.value));

export const DEFAULT_PAGE_SIZE = 25;

function first(input: SearchParamsInput, key: string): string | undefined {
  const value = input[key];
  if (Array.isArray(value)) return value[0];
  return value;
}

function trimmed(input: SearchParamsInput, key: string): string | undefined {
  const value = first(input, key)?.trim();
  return value ? value : undefined;
}

/** Split a comma-separated list and keep only members of `allowed`. */
function parseList<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const permitted = new Set<string>(allowed);
  const seen = new Set<T>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (permitted.has(value)) seen.add(value as T);
  }
  return [...seen];
}

function parseBigIntOrUndefined(raw: string | undefined): bigint | undefined {
  if (!raw) return undefined;
  try {
    return parseAmountMinor(raw);
  } catch {
    // A malformed amount drops the filter rather than failing the page.
    return undefined;
  }
}

function parseDateOrUndefined(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  // `<input type="date">` submits YYYY-MM-DD; anchor it so the range is inclusive.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : raw;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export interface ParsedExceptionQuery {
  filters: ExceptionFilters;
  sort: ExceptionSortField;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
  /** Exact values as typed, for repopulating the filter form. */
  raw: {
    state: string;
    severity: string;
    rule: string;
    assignee: string;
    currency: string;
    min: string;
    max: string;
    from: string;
    to: string;
    search: string;
  };
  /** True when at least one filter narrows the result set. */
  hasFilters: boolean;
}

export function parseExceptionQuery(input: SearchParamsInput): ParsedExceptionQuery {
  const rawState = trimmed(input, PARAM.state) ?? "";
  const rawSeverity = trimmed(input, PARAM.severity) ?? "";
  const rawRule = trimmed(input, PARAM.rule) ?? "";
  const rawAssignee = trimmed(input, PARAM.assignee) ?? "";
  const rawCurrency = trimmed(input, PARAM.currency) ?? "";
  const rawMin = trimmed(input, PARAM.min) ?? "";
  const rawMax = trimmed(input, PARAM.max) ?? "";
  const rawFrom = trimmed(input, PARAM.from) ?? "";
  const rawTo = trimmed(input, PARAM.to) ?? "";
  const rawSearch = trimmed(input, PARAM.search) ?? "";

  const state = rawState === "active" ? [...ACTIVE_STATES] : parseList(rawState, EXCEPTION_STATES);
  const severity = parseList<ExceptionSeverity>(rawSeverity, EXCEPTION_SEVERITIES);
  const ruleId = rawRule
    .split(",")
    .map((value) => value.trim())
    .filter((value) => isReconciliationRuleId(value));

  const assigneeId =
    rawAssignee === "unassigned"
      ? ("unassigned" as const)
      : rawAssignee.length > 0
        ? rawAssignee
        : undefined;

  const currency = /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : undefined;
  const minRevenueAtRiskMinor = parseBigIntOrUndefined(rawMin);
  const maxRevenueAtRiskMinor = parseBigIntOrUndefined(rawMax);
  const createdFrom = parseDateOrUndefined(rawFrom);
  const createdTo = parseDateOrUndefined(rawTo, true);
  // Bounded so a pathological search term cannot become an expensive scan.
  const search = rawSearch ? rawSearch.slice(0, 120) : undefined;

  const sortRaw = trimmed(input, PARAM.sort);
  const sort: ExceptionSortField =
    sortRaw && SORT_FIELDS.has(sortRaw) ? (sortRaw as ExceptionSortField) : "createdAt";
  const direction = trimmed(input, PARAM.direction) === "asc" ? "asc" : "desc";

  const pageRaw = Number.parseInt(trimmed(input, PARAM.page) ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 100_000) : 1;

  const filters: ExceptionFilters = {
    ...(state.length ? { state } : {}),
    ...(severity.length ? { severity } : {}),
    ...(ruleId.length ? { ruleId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(currency ? { currency } : {}),
    ...(minRevenueAtRiskMinor !== undefined ? { minRevenueAtRiskMinor } : {}),
    ...(maxRevenueAtRiskMinor !== undefined ? { maxRevenueAtRiskMinor } : {}),
    ...(createdFrom ? { createdFrom } : {}),
    ...(createdTo ? { createdTo } : {}),
    ...(search ? { search } : {}),
  };

  return {
    filters,
    sort,
    direction,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    raw: {
      state: rawState,
      severity: rawSeverity,
      rule: rawRule,
      assignee: rawAssignee,
      currency: rawCurrency,
      min: rawMin,
      max: rawMax,
      from: rawFrom,
      to: rawTo,
      search: rawSearch,
    },
    hasFilters: Object.keys(filters).length > 0,
  };
}

/**
 * Rebuild the query string with some parameters replaced.
 * Passing `undefined` (or an empty string) for a key removes it, which is how
 * "clear this filter" and "back to page 1" are expressed.
 */
export function buildQuery(
  input: SearchParamsInput,
  overrides: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(input)) {
    if (key in overrides) continue;
    const single = Array.isArray(value) ? value[0] : value;
    if (single) params.set(key, single);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value) params.set(key, value);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Href for a sortable column header: same field toggles direction. */
export function sortHref(
  pathname: string,
  input: SearchParamsInput,
  field: ExceptionSortField,
  current: { sort: ExceptionSortField; direction: "asc" | "desc" },
): string {
  const nextDirection = current.sort === field && current.direction === "desc" ? "asc" : "desc";
  return `${pathname}${buildQuery(input, {
    [PARAM.sort]: field,
    [PARAM.direction]: nextDirection,
    // Changing the ordering invalidates the current page number.
    [PARAM.page]: undefined,
  })}`;
}

/** `aria-sort` value for a column header, so the ordering is announced. */
export function ariaSort(
  field: ExceptionSortField,
  current: { sort: ExceptionSortField; direction: "asc" | "desc" },
): "ascending" | "descending" | "none" {
  if (current.sort !== field) return "none";
  return current.direction === "asc" ? "ascending" : "descending";
}
