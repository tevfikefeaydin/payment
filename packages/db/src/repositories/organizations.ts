import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  canAssignRole,
  canManageMemberWithRole,
  PublicError,
  wouldRemoveLastOwner,
  type OrganizationRole,
} from "@payrecon/domain";
import { DEFAULT_PLAN, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "@payrecon/config";
import type { Database } from "../client";
import { invitations, organizationMembers, organizations } from "../schema/organizations";
import { users } from "../schema/auth";

/**
 * Organization and membership management.
 *
 * The rules that protect an organization from becoming unusable — last-owner
 * protection and privilege-escalation prevention — are enforced here, in one
 * place, and again by a database trigger as a backstop.
 */

export class MembershipError extends PublicError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, status);
  }
}

/** Build a URL-safe slug and guarantee uniqueness by suffixing on collision. */
export async function generateUniqueSlug(db: Database, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org";

  // The slug check constraint requires at least 3 characters.
  const seed = base.length >= 3 ? base : `${base}-org`;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? seed : `${seed}-${attempt + 1}`;
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
  }

  // Fall back to a random suffix rather than looping forever.
  return `${seed}-${Math.floor(Date.now() % 100000)}`;
}

export interface CreateOrganizationInput {
  name: string;
  ownerUserId: string;
  isDemo?: boolean;
}

/**
 * Create an organization and make the creator its owner, atomically.
 * An organization without an owner is never observable.
 */
export async function createOrganization(
  db: Database,
  input: CreateOrganizationInput,
): Promise<{ id: string; slug: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 100) {
    throw new MembershipError(
      "invalid_name",
      "Organization name must be between 2 and 100 characters.",
    );
  }

  const slug = await generateUniqueSlug(db, name);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({
        name,
        slug,
        planKey: DEFAULT_PLAN,
        isDemo: input.isDemo ?? false,
      })
      .returning({ id: organizations.id, slug: organizations.slug });

    if (!org) throw new Error("Failed to create organization");

    await tx.insert(organizationMembers).values({
      organizationId: org.id,
      userId: input.ownerUserId,
      role: "owner",
    });

    return org;
  });
}

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  joinedAt: Date;
}

export async function listMembers(db: Database, organizationId: string): Promise<MemberRow[]> {
  return db
    .select({
      userId: organizationMembers.userId,
      name: users.name,
      email: users.email,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(organizationMembers.createdAt);
}

async function countOwners(db: Database, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, "owner"),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Change a member's role.
 *
 * Rejects, in order: escalation beyond the actor's own role, an admin trying to
 * mint an owner, and demoting the last remaining owner.
 */
export async function changeMemberRole(
  db: Database,
  params: {
    organizationId: string;
    actorRole: OrganizationRole;
    targetUserId: string;
    newRole: OrganizationRole;
  },
): Promise<void> {
  if (!canAssignRole(params.actorRole, params.newRole)) {
    throw new MembershipError(
      "forbidden_role_assignment",
      params.newRole === "owner"
        ? "Only an owner can grant the owner role."
        : "You cannot grant a role more senior than your own.",
      403,
    );
  }

  const [target] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, params.organizationId),
        eq(organizationMembers.userId, params.targetUserId),
      ),
    )
    .limit(1);

  if (!target) throw new MembershipError("not_found", "That member was not found.", 404);

  if (!canManageMemberWithRole(params.actorRole, target.role)) {
    throw new MembershipError("forbidden", "You cannot change the role of an owner.", 403);
  }

  if (
    wouldRemoveLastOwner({
      targetCurrentRole: target.role,
      targetNewRole: params.newRole,
      ownerCount: await countOwners(db, params.organizationId),
    })
  ) {
    throw new MembershipError(
      "last_owner",
      "This is the only owner. Promote another member to owner first.",
      409,
    );
  }

  await db
    .update(organizationMembers)
    .set({ role: params.newRole, updatedAt: new Date() })
    .where(
      and(
        eq(organizationMembers.organizationId, params.organizationId),
        eq(organizationMembers.userId, params.targetUserId),
      ),
    );
}

export async function removeMember(
  db: Database,
  params: {
    organizationId: string;
    actorRole: OrganizationRole;
    targetUserId: string;
  },
): Promise<void> {
  const [target] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, params.organizationId),
        eq(organizationMembers.userId, params.targetUserId),
      ),
    )
    .limit(1);

  if (!target) throw new MembershipError("not_found", "That member was not found.", 404);

  if (!canManageMemberWithRole(params.actorRole, target.role)) {
    throw new MembershipError("forbidden", "You cannot remove an owner.", 403);
  }

  if (
    wouldRemoveLastOwner({
      targetCurrentRole: target.role,
      targetNewRole: null,
      ownerCount: await countOwners(db, params.organizationId),
    })
  ) {
    throw new MembershipError(
      "last_owner",
      "This is the only owner. Transfer ownership before removing them.",
      409,
    );
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, params.organizationId),
        eq(organizationMembers.userId, params.targetUserId),
      ),
    );
}

/**
 * Transfer ownership: promote the target, then demote the current owner, in one
 * transaction so the organization always has at least one owner.
 */
export async function transferOwnership(
  db: Database,
  params: {
    organizationId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
    demoteTo?: OrganizationRole;
  },
): Promise<void> {
  if (params.currentOwnerUserId === params.newOwnerUserId) {
    throw new MembershipError("invalid_target", "That member is already the owner.");
  }

  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, params.organizationId),
          eq(organizationMembers.userId, params.newOwnerUserId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new MembershipError("not_found", "That member is not part of this organization.", 404);
    }

    // Promote first: the trigger that requires at least one owner is satisfied
    // at every point in this sequence.
    await tx
      .update(organizationMembers)
      .set({ role: "owner", updatedAt: new Date() })
      .where(
        and(
          eq(organizationMembers.organizationId, params.organizationId),
          eq(organizationMembers.userId, params.newOwnerUserId),
        ),
      );

    await tx
      .update(organizationMembers)
      .set({ role: params.demoteTo ?? "admin", updatedAt: new Date() })
      .where(
        and(
          eq(organizationMembers.organizationId, params.organizationId),
          eq(organizationMembers.userId, params.currentOwnerUserId),
        ),
      );
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function updateOrganizationSettings(
  db: Database,
  params: {
    organizationId: string;
    name?: string;
    retentionDays?: number;
  },
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (params.name !== undefined) {
    const name = params.name.trim();
    if (name.length < 2 || name.length > 100) {
      throw new MembershipError("invalid_name", "Name must be between 2 and 100 characters.");
    }
    patch.name = name;
  }

  if (params.retentionDays !== undefined) {
    if (
      !Number.isInteger(params.retentionDays) ||
      params.retentionDays < RETENTION_MIN_DAYS ||
      params.retentionDays > RETENTION_MAX_DAYS
    ) {
      throw new MembershipError(
        "invalid_retention",
        `Retention must be between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS} days.`,
      );
    }
    patch.retentionDays = params.retentionDays;
  }

  await db.update(organizations).set(patch).where(eq(organizations.id, params.organizationId));
}

export async function getOrganization(
  db: Database,
  organizationId: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
  planKey: string;
  retentionDays: number;
  isDemo: boolean;
  createdAt: Date;
} | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      planKey: organizations.planKey,
      retentionDays: organizations.retentionDays,
      isDemo: organizations.isDemo,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface PendingInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  createdAt: Date;
  invitedByName: string | null;
}

export async function listPendingInvitations(
  db: Database,
  organizationId: string,
): Promise<PendingInvitation[]> {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
      invitedByName: users.name,
    })
    .from(invitations)
    .leftJoin(users, eq(users.id, invitations.invitedByUserId))
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .orderBy(invitations.createdAt);
}

/** True when the email already belongs to a member of this organization. */
export async function isAlreadyMember(
  db: Database,
  organizationId: string,
  email: string,
): Promise<boolean> {
  const [row] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        sql`lower(${users.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Members other than the given user, used for reassignment UI. */
export async function listOtherMembers(
  db: Database,
  organizationId: string,
  excludeUserId: string,
): Promise<MemberRow[]> {
  return db
    .select({
      userId: organizationMembers.userId,
      name: users.name,
      email: users.email,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        ne(organizationMembers.userId, excludeUserId),
      ),
    )
    .orderBy(users.name);
}
