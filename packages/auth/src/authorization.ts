import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import { organizationMembers, organizations } from "@payrecon/db/schema";
import {
  hasPermission,
  PublicError,
  type OrganizationRole,
  type Permission,
} from "@payrecon/domain";
import type { SessionUser } from "./session";

/**
 * Server-side authorization.
 *
 * TENANT ISOLATION RULE: an organization id arriving from the browser (a URL
 * segment, a form field, a header, a cookie) is never trusted. It is always
 * resolved through `resolveOrgContext`, which proves the authenticated user has
 * a membership row for that organization. Every tenant-scoped query then uses
 * the organization id from the RESULTING context, not the one from the request.
 *
 * NOT-FOUND OVER FORBIDDEN: accessing another tenant's resource yields 404, not
 * 403. Returning 403 would confirm that the id exists, which is itself a
 * cross-tenant information leak.
 */

export class UnauthorizedError extends PublicError {
  constructor(message = "You must be signed in to do that.") {
    super("unauthorized", message, 401);
  }
}

export class ForbiddenError extends PublicError {
  constructor(message = "You do not have permission to do that.") {
    super("forbidden", message, 403);
  }
}

export class NotFoundError extends PublicError {
  constructor(message = "Not found.") {
    super("not_found", message, 404);
  }
}

/** An authenticated user acting inside one specific organization. */
export interface OrgContext {
  user: SessionUser;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationRole;
  isDemo: boolean;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  isDemo: boolean;
}

/** Every organization the user belongs to, for the switcher. */
export async function listUserOrganizations(
  db: Database,
  userId: string,
): Promise<OrganizationSummary[]> {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
      isDemo: organizations.isDemo,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.deletedAt)))
    .orderBy(organizations.name);

  return rows;
}

/**
 * Resolve and VERIFY an organization context.
 *
 * Returns null when the organization does not exist, is deleted, or the user is
 * not a member — the caller cannot distinguish these cases, by design.
 */
export async function resolveOrgContext(
  db: Database,
  user: SessionUser,
  organizationId: string,
): Promise<OrgContext | null> {
  if (!isUuid(organizationId)) return null;

  const [row] = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      isDemo: organizations.isDemo,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.userId, user.id),
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;
  return { user, ...row };
}

/** Same as `resolveOrgContext` but by slug, for human-friendly URLs. */
export async function resolveOrgContextBySlug(
  db: Database,
  user: SessionUser,
  slug: string,
): Promise<OrgContext | null> {
  const [row] = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      organizationSlug: organizations.slug,
      isDemo: organizations.isDemo,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.userId, user.id),
        eq(organizations.slug, slug),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;
  return { user, ...row };
}

/** Throwing variant used by route handlers and server actions. */
export async function requireOrgContext(
  db: Database,
  user: SessionUser | null,
  organizationId: string,
): Promise<OrgContext> {
  if (!user) throw new UnauthorizedError();
  const context = await resolveOrgContext(db, user, organizationId);
  if (!context) throw new NotFoundError("That organization does not exist.");
  return context;
}

/** The single gate for every privileged action. */
export function assertPermission(context: OrgContext, permission: Permission): void {
  if (!hasPermission(context.role, permission)) {
    throw new ForbiddenError(`Your role (${context.role}) does not allow this action.`);
  }
}

export function can(context: OrgContext, permission: Permission): boolean {
  return hasPermission(context.role, permission);
}

/**
 * Convenience for routes: resolve the organization AND check a permission in one
 * step, so a handler cannot accidentally do the first without the second.
 */
export async function requirePermissionInOrg(
  db: Database,
  user: SessionUser | null,
  organizationId: string,
  permission: Permission,
): Promise<OrgContext> {
  const context = await requireOrgContext(db, user, organizationId);
  assertPermission(context, permission);
  return context;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
