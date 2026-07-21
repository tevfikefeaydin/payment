import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import {
  assertTransition,
  MAX_TRANSITION_NOTE_LENGTH,
  PublicError,
  type ExceptionSeverity,
  type ExceptionState,
} from "@payrecon/domain";
import type { Database } from "../client";
import { exceptionEvents, exceptions } from "../schema/reconciliation";
import { users } from "../schema/auth";

/**
 * Tenant-scoped access to the exception inbox.
 *
 * Every exported function takes `organizationId` as a required argument and
 * includes it in the WHERE clause. There is deliberately no "get by id" that
 * omits the tenant: an id alone is never sufficient authority to read a row.
 */

export class ConcurrencyError extends PublicError {
  constructor() {
    super(
      "conflict",
      "Someone else updated this exception while you were viewing it. Reload to see the latest state.",
      409,
    );
  }
}

export interface ExceptionFilters {
  state?: ExceptionState[];
  severity?: ExceptionSeverity[];
  ruleId?: string[];
  assigneeId?: string | "unassigned";
  currency?: string;
  minRevenueAtRiskMinor?: bigint;
  maxRevenueAtRiskMinor?: bigint;
  createdFrom?: Date;
  createdTo?: Date;
  /** Free-text search across safe identifiers only — never across evidence. */
  search?: string;
}

export type ExceptionSortField =
  "createdAt" | "updatedAt" | "severity" | "revenueAtRisk" | "occurredAt";

export interface ExceptionListQuery extends ExceptionFilters {
  organizationId: string;
  sort?: ExceptionSortField;
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ExceptionListItem {
  id: string;
  ruleId: string;
  severity: ExceptionSeverity;
  state: ExceptionState;
  summary: string;
  revenueAtRiskMinor: bigint | null;
  currency: string | null;
  providerObjectId: string | null;
  internalExternalId: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  occurredAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const MAX_PAGE_SIZE = 100;

/** Build the tenant-scoped WHERE clause shared by list and count. */
function buildWhere(query: ExceptionListQuery): SQL {
  const conditions: SQL[] = [eq(exceptions.organizationId, query.organizationId)];

  if (query.state?.length) conditions.push(inArray(exceptions.state, query.state));
  if (query.severity?.length) conditions.push(inArray(exceptions.severity, query.severity));
  if (query.ruleId?.length) conditions.push(inArray(exceptions.ruleId, query.ruleId));

  if (query.assigneeId === "unassigned") {
    conditions.push(sql`${exceptions.assignedToUserId} is null`);
  } else if (query.assigneeId) {
    conditions.push(eq(exceptions.assignedToUserId, query.assigneeId));
  }

  if (query.currency) conditions.push(eq(exceptions.currency, query.currency.toUpperCase()));
  if (query.minRevenueAtRiskMinor !== undefined) {
    conditions.push(gte(exceptions.revenueAtRiskMinor, query.minRevenueAtRiskMinor));
  }
  if (query.maxRevenueAtRiskMinor !== undefined) {
    conditions.push(lte(exceptions.revenueAtRiskMinor, query.maxRevenueAtRiskMinor));
  }
  if (query.createdFrom) conditions.push(gte(exceptions.createdAt, query.createdFrom));
  if (query.createdTo) conditions.push(lte(exceptions.createdAt, query.createdTo));

  if (query.search) {
    // Search only over identifier columns. Evidence is excluded on purpose: it
    // can contain customer detail that should not be full-text searchable here.
    // `ilike` with an escaped term keeps this a parameterised query.
    const term = `%${escapeLike(query.search.trim())}%`;
    const searchCondition = or(
      ilike(exceptions.providerObjectId, term),
      ilike(exceptions.internalExternalId, term),
      ilike(exceptions.ruleId, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return and(...conditions) as SQL;
}

/** Escape LIKE wildcards so user input cannot broaden the match. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function listExceptions(
  db: Database,
  query: ExceptionListQuery,
): Promise<{ items: ExceptionListItem[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), MAX_PAGE_SIZE);
  const page = Math.max(query.page ?? 1, 1);
  const where = buildWhere(query);

  const direction = query.direction === "asc" ? asc : desc;
  // PostgreSQL requires the null placement AFTER the direction keyword
  // (`col asc nulls last`). Wrapping the expression in drizzle's `asc()`/`desc()`
  // would append the keyword last and produce `col nulls last asc`, which is a
  // syntax error, so these two cases build the clause explicitly.
  const directionKeyword = query.direction === "asc" ? sql`asc` : sql`desc`;
  const orderBy = (() => {
    switch (query.sort) {
      case "severity":
        // Enum ordering is declaration order: critical, high, medium, low.
        return [direction(exceptions.severity), desc(exceptions.createdAt)];
      case "revenueAtRisk":
        // Nulls last in BOTH directions: an exception with no quantified amount
        // should never head a list the operator sorted by amount.
        return [
          sql`${exceptions.revenueAtRiskMinor} ${directionKeyword} nulls last`,
          desc(exceptions.createdAt),
        ];
      case "occurredAt":
        return [sql`${exceptions.occurredAt} ${directionKeyword} nulls last`];
      case "updatedAt":
        return [direction(exceptions.updatedAt)];
      case "createdAt":
      default:
        return [direction(exceptions.createdAt)];
    }
  })();

  const items = await db
    .select({
      id: exceptions.id,
      ruleId: exceptions.ruleId,
      severity: exceptions.severity,
      state: exceptions.state,
      summary: exceptions.summary,
      revenueAtRiskMinor: exceptions.revenueAtRiskMinor,
      currency: exceptions.currency,
      providerObjectId: exceptions.providerObjectId,
      internalExternalId: exceptions.internalExternalId,
      assignedToUserId: exceptions.assignedToUserId,
      assignedToName: users.name,
      occurredAt: exceptions.occurredAt,
      firstSeenAt: exceptions.firstSeenAt,
      lastSeenAt: exceptions.lastSeenAt,
      createdAt: exceptions.createdAt,
      updatedAt: exceptions.updatedAt,
      version: exceptions.version,
    })
    .from(exceptions)
    .leftJoin(users, eq(users.id, exceptions.assignedToUserId))
    .where(where)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(exceptions)
    .where(where);

  return { items, total: countRow?.count ?? 0, page, pageSize };
}

export interface ExceptionDetail extends ExceptionListItem {
  ruleVersion: number;
  fingerprint: string;
  evidence: unknown;
  probableCauses: unknown;
  recommendedActions: unknown;
  internalRecordId: string | null;
  resolvedAt: Date | null;
}

export async function getException(
  db: Database,
  organizationId: string,
  exceptionId: string,
): Promise<ExceptionDetail | null> {
  const [row] = await db
    .select({
      id: exceptions.id,
      ruleId: exceptions.ruleId,
      ruleVersion: exceptions.ruleVersion,
      fingerprint: exceptions.fingerprint,
      severity: exceptions.severity,
      state: exceptions.state,
      summary: exceptions.summary,
      revenueAtRiskMinor: exceptions.revenueAtRiskMinor,
      currency: exceptions.currency,
      providerObjectId: exceptions.providerObjectId,
      internalRecordId: exceptions.internalRecordId,
      internalExternalId: exceptions.internalExternalId,
      evidence: exceptions.evidence,
      probableCauses: exceptions.probableCauses,
      recommendedActions: exceptions.recommendedActions,
      assignedToUserId: exceptions.assignedToUserId,
      assignedToName: users.name,
      occurredAt: exceptions.occurredAt,
      firstSeenAt: exceptions.firstSeenAt,
      lastSeenAt: exceptions.lastSeenAt,
      resolvedAt: exceptions.resolvedAt,
      createdAt: exceptions.createdAt,
      updatedAt: exceptions.updatedAt,
      version: exceptions.version,
    })
    .from(exceptions)
    .leftJoin(users, eq(users.id, exceptions.assignedToUserId))
    // Tenant scope is part of the lookup, not a post-filter.
    .where(and(eq(exceptions.organizationId, organizationId), eq(exceptions.id, exceptionId)))
    .limit(1);

  return row ?? null;
}

export interface TimelineEntry {
  id: string;
  action: string;
  fromState: ExceptionState | null;
  toState: ExceptionState | null;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  note: string | null;
  createdAt: Date;
}

export async function getExceptionTimeline(
  db: Database,
  organizationId: string,
  exceptionId: string,
): Promise<TimelineEntry[]> {
  return db
    .select({
      id: exceptionEvents.id,
      action: exceptionEvents.action,
      fromState: exceptionEvents.fromState,
      toState: exceptionEvents.toState,
      actorType: exceptionEvents.actorType,
      actorUserId: exceptionEvents.actorUserId,
      actorName: users.name,
      note: exceptionEvents.note,
      createdAt: exceptionEvents.createdAt,
    })
    .from(exceptionEvents)
    .leftJoin(users, eq(users.id, exceptionEvents.actorUserId))
    .where(
      and(
        eq(exceptionEvents.organizationId, organizationId),
        eq(exceptionEvents.exceptionId, exceptionId),
      ),
    )
    .orderBy(asc(exceptionEvents.createdAt));
}

/**
 * Move an exception to a new state.
 *
 * Guards, in order:
 *   1. the row belongs to this organization (tenant scope),
 *   2. the transition is legal for a user actor (central state machine),
 *   3. the caller's `expectedVersion` still matches (optimistic concurrency).
 *
 * The version check is part of the UPDATE's WHERE clause, so two operators
 * acting at once cannot both succeed — the loser gets a 409 instead of silently
 * overwriting the winner.
 */
export async function transitionException(
  db: Database,
  params: {
    organizationId: string;
    exceptionId: string;
    toState: ExceptionState;
    expectedVersion: number;
    actorUserId: string;
    note?: string | null;
    correlationId?: string | null;
  },
): Promise<{ fromState: ExceptionState; toState: ExceptionState; version: number }> {
  const note = params.note?.trim() ? params.note.trim() : null;
  if (note && note.length > MAX_TRANSITION_NOTE_LENGTH) {
    throw new PublicError(
      "note_too_long",
      `Notes must be at most ${MAX_TRANSITION_NOTE_LENGTH} characters.`,
      400,
    );
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: exceptions.id, state: exceptions.state, version: exceptions.version })
      .from(exceptions)
      .where(
        and(
          eq(exceptions.organizationId, params.organizationId),
          eq(exceptions.id, params.exceptionId),
        ),
      )
      .limit(1);

    if (!current) throw new PublicError("not_found", "Exception not found.", 404);

    // Throws InvalidTransitionError for an illegal move.
    assertTransition(current.state, params.toState, "user");

    const isResolving = params.toState === "resolved";
    const [updated] = await tx
      .update(exceptions)
      .set({
        state: params.toState,
        resolvedAt: isResolving ? new Date() : null,
        resolvedByUserId: isResolving ? params.actorUserId : null,
        updatedAt: new Date(),
        version: sql`${exceptions.version} + 1`,
      })
      .where(
        and(
          eq(exceptions.organizationId, params.organizationId),
          eq(exceptions.id, params.exceptionId),
          eq(exceptions.version, params.expectedVersion),
        ),
      )
      .returning({ version: exceptions.version });

    if (!updated) throw new ConcurrencyError();

    await tx.insert(exceptionEvents).values({
      organizationId: params.organizationId,
      exceptionId: params.exceptionId,
      action: "state_changed",
      fromState: current.state,
      toState: params.toState,
      actorType: "user",
      actorUserId: params.actorUserId,
      note,
      correlationId: params.correlationId ?? null,
    });

    return { fromState: current.state, toState: params.toState, version: updated.version };
  });
}

/** Assign or unassign an exception. Assignment is not a state transition. */
export async function assignException(
  db: Database,
  params: {
    organizationId: string;
    exceptionId: string;
    assigneeUserId: string | null;
    actorUserId: string;
    correlationId?: string | null;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(exceptions)
      .set({ assignedToUserId: params.assigneeUserId, updatedAt: new Date() })
      .where(
        and(
          eq(exceptions.organizationId, params.organizationId),
          eq(exceptions.id, params.exceptionId),
        ),
      )
      .returning({ id: exceptions.id });

    if (!updated) throw new PublicError("not_found", "Exception not found.", 404);

    await tx.insert(exceptionEvents).values({
      organizationId: params.organizationId,
      exceptionId: params.exceptionId,
      action: "assigned",
      actorType: "user",
      actorUserId: params.actorUserId,
      note: params.assigneeUserId ? null : "Unassigned",
      correlationId: params.correlationId ?? null,
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

export interface SeverityCount {
  severity: ExceptionSeverity;
  count: number;
}

export async function countOpenBySeverity(
  db: Database,
  organizationId: string,
): Promise<SeverityCount[]> {
  const rows = await db
    .select({
      severity: exceptions.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        inArray(exceptions.state, ["open", "acknowledged", "reopened"]),
      ),
    )
    .groupBy(exceptions.severity);

  return rows;
}

/**
 * Revenue at risk, grouped BY CURRENCY.
 *
 * There is intentionally no combined total: summing unlike currencies without an
 * explicit, sourced FX rate would be misleading, and the MVP has no FX.
 */
export async function revenueAtRiskByCurrency(
  db: Database,
  organizationId: string,
): Promise<Array<{ currency: string; amountMinor: bigint; count: number }>> {
  const rows = await db
    .select({
      currency: exceptions.currency,
      amountMinor: sql<string>`coalesce(sum(${exceptions.revenueAtRiskMinor}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        inArray(exceptions.state, ["open", "acknowledged", "reopened"]),
        sql`${exceptions.currency} is not null`,
        sql`${exceptions.revenueAtRiskMinor} is not null`,
      ),
    )
    .groupBy(exceptions.currency)
    .orderBy(exceptions.currency);

  // sum() returns numeric; it is read as text and converted to bigint so a large
  // total never passes through a float.
  return rows
    .filter((row): row is typeof row & { currency: string } => row.currency !== null)
    .map((row) => ({
      currency: row.currency,
      amountMinor: BigInt(row.amountMinor),
      count: row.count,
    }));
}

export async function countByRule(
  db: Database,
  organizationId: string,
): Promise<Array<{ ruleId: string; count: number }>> {
  return db
    .select({ ruleId: exceptions.ruleId, count: sql<number>`count(*)::int` })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        inArray(exceptions.state, ["open", "acknowledged", "reopened"]),
      ),
    )
    .groupBy(exceptions.ruleId)
    .orderBy(desc(sql`count(*)`));
}

/** Recently changed critical/high exceptions for the dashboard. */
export async function recentHighPriority(
  db: Database,
  organizationId: string,
  limit = 5,
): Promise<ExceptionListItem[]> {
  return db
    .select({
      id: exceptions.id,
      ruleId: exceptions.ruleId,
      severity: exceptions.severity,
      state: exceptions.state,
      summary: exceptions.summary,
      revenueAtRiskMinor: exceptions.revenueAtRiskMinor,
      currency: exceptions.currency,
      providerObjectId: exceptions.providerObjectId,
      internalExternalId: exceptions.internalExternalId,
      assignedToUserId: exceptions.assignedToUserId,
      assignedToName: users.name,
      occurredAt: exceptions.occurredAt,
      firstSeenAt: exceptions.firstSeenAt,
      lastSeenAt: exceptions.lastSeenAt,
      createdAt: exceptions.createdAt,
      updatedAt: exceptions.updatedAt,
      version: exceptions.version,
    })
    .from(exceptions)
    .leftJoin(users, eq(users.id, exceptions.assignedToUserId))
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        inArray(exceptions.severity, ["critical", "high"]),
        inArray(exceptions.state, ["open", "acknowledged", "reopened"]),
      ),
    )
    .orderBy(desc(exceptions.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 20));
}

/** New exceptions per day, for the dashboard trend. */
export async function newExceptionsByDay(
  db: Database,
  organizationId: string,
  days = 14,
): Promise<Array<{ day: string; count: number }>> {
  const boundedDays = Math.min(Math.max(days, 1), 90);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${exceptions.firstSeenAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(exceptions)
    .where(
      and(
        eq(exceptions.organizationId, organizationId),
        sql`${exceptions.firstSeenAt} >= now() - make_interval(days => ${boundedDays})`,
      ),
    )
    .groupBy(sql`date_trunc('day', ${exceptions.firstSeenAt})`)
    .orderBy(sql`date_trunc('day', ${exceptions.firstSeenAt})`);

  return rows;
}
