import { eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { organizations } from "../schema/organizations";

/**
 * Organization deletion.
 *
 * There are deliberately TWO operations, because "delete my organization" and
 * "erase every trace of this tenant" are different requests with different risk.
 *
 * 1. `softDeleteOrganization` — the ORDINARY product path. Sets `deleted_at`,
 *    which immediately removes the organization from every tenant-scoped query
 *    (`resolveOrgContext` and `listUserOrganizations` both filter it out), so
 *    access ends at once. Nothing is destroyed, so an accidental deletion is
 *    recoverable and the audit trail survives.
 *
 * 2. `purgeOrganization` — the PRIVILEGED maintenance path. Physically removes
 *    the tenant's rows, including its audit events.
 *
 * WHY PURGE NEEDS SPECIAL HANDLING
 * --------------------------------
 * `audit_events` is append-only, enforced by a database trigger that rejects
 * DELETE (see guards.ts). That guard is doing its job: it also blocks the FK
 * cascade from an organization delete. Rather than weakening the guard — which
 * would let any buggy or compromised code path erase history — purge explicitly
 * disables it for the duration of one transaction.
 *
 * The DDL is transactional in PostgreSQL, so if the delete fails the trigger is
 * restored automatically. `ALTER TABLE` takes an ACCESS EXCLUSIVE lock, which is
 * acceptable for a rare, operator-initiated maintenance action and is one more
 * reason this is not something an ordinary request can reach.
 *
 * CASCADE ORDER: every tenant-owned table declares
 * `organization_id ... onDelete: "cascade"`, so PostgreSQL removes children
 * before the parent in one statement. No manual ordering is required. Tables
 * that reference a user rather than an organization use `set null`, so removing
 * a tenant never deletes a user who belongs to other organizations.
 */

export async function softDeleteOrganization(db: Database, organizationId: string): Promise<void> {
  await db
    .update(organizations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

/** Restore a soft-deleted organization. */
export async function restoreOrganization(db: Database, organizationId: string): Promise<void> {
  await db
    .update(organizations)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(eq(organizations.id, organizationId));
}

/**
 * Permanently remove an organization and everything belonging to it.
 *
 * Callers must have already recorded WHY this happened somewhere durable
 * (the organization's own audit rows are among the data being destroyed).
 * See docs/OPERATIONS.md for the operator runbook.
 */
export async function purgeOrganization(db: Database, organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Suspend the append-only guard for this transaction only.
    await tx.execute(sql`alter table audit_events disable trigger audit_events_no_delete`);
    try {
      await tx.delete(organizations).where(eq(organizations.id, organizationId));
    } finally {
      await tx.execute(sql`alter table audit_events enable trigger audit_events_no_delete`);
    }
  });
}
