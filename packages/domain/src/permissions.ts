/**
 * Centralised role/permission matrix.
 *
 * The specification forbids scattering string role checks through UI
 * components. Every authorization decision in the product resolves to a
 * `Permission` and is checked here, on the server. UI code may consult the same
 * helpers to decide whether to render a control, but rendering is never the
 * security boundary.
 *
 * The matrix is mirrored in docs/SECURITY.md and covered by unit tests that
 * assert every role/permission pair, so an accidental widening of access fails
 * the build.
 */

export const ORGANIZATION_ROLES = ["owner", "admin", "analyst", "viewer"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

/** Seniority ordering. A lower index is more privileged. */
const ROLE_RANK: Record<OrganizationRole, number> = {
  owner: 0,
  admin: 1,
  analyst: 2,
  viewer: 3,
};

export const PERMISSIONS = [
  // Organization
  "org:read",
  "org:update",
  "org:delete",
  "org:transfer_ownership",

  // Membership
  "members:read",
  "members:invite",
  "members:remove",
  "members:change_role",

  // Customer Stripe connections (read-only integrations)
  "connections:read",
  "connections:create",
  "connections:update",
  "connections:delete",

  // Internal data ingestion
  "imports:read",
  "imports:create",

  // Organization API keys
  "apikeys:read",
  "apikeys:create",
  "apikeys:revoke",

  // Reconciliation
  "reconciliation:read",
  "reconciliation:run",

  // Exceptions
  "exceptions:read",
  "exceptions:assign",
  "exceptions:transition",

  // Notifications
  "notifications:read",
  "notifications:manage",
  "notifications:test",

  // PayRecon's own billing
  "billing:read",
  "billing:manage",

  // Audit and settings
  "audit:read",
  "settings:read",
  "settings:manage",
  "retention:manage",

  // Demo data
  "demo:load",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: Permission[] = [
  "org:read",
  "members:read",
  "connections:read",
  "imports:read",
  "reconciliation:read",
  "exceptions:read",
  "notifications:read",
  "audit:read",
  "settings:read",
];

const ANALYST_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  "imports:create",
  "reconciliation:run",
  "exceptions:assign",
  "exceptions:transition",
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...ANALYST_PERMISSIONS,
  "org:update",
  "members:invite",
  "members:remove",
  "members:change_role",
  "connections:create",
  "connections:update",
  "connections:delete",
  "apikeys:read",
  "apikeys:create",
  "apikeys:revoke",
  "notifications:manage",
  "notifications:test",
  "settings:manage",
  "retention:manage",
  "demo:load",
  // Admins may SEE the plan and usage, but not change the subscription.
  "billing:read",
];

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  "org:delete",
  "org:transfer_ownership",
  "billing:manage",
];

export const ROLE_PERMISSIONS: Record<OrganizationRole, ReadonlySet<Permission>> = {
  owner: new Set(OWNER_PERMISSIONS),
  admin: new Set(ADMIN_PERMISSIONS),
  analyst: new Set(ANALYST_PERMISSIONS),
  viewer: new Set(VIEWER_PERMISSIONS),
};

/** The single predicate every server-side authorization check goes through. */
export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: OrganizationRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]].sort();
}

/**
 * Whether `actor` may assign `target` as a role.
 *
 * Prevents privilege escalation and the "silent ownership grab": only an owner
 * may create another owner. An actor may never grant a role more senior than
 * their own.
 */
export function canAssignRole(actor: OrganizationRole, target: OrganizationRole): boolean {
  if (!hasPermission(actor, "members:change_role")) return false;
  if (target === "owner") return actor === "owner";
  return ROLE_RANK[actor] <= ROLE_RANK[target];
}

/**
 * Whether `actor` may remove or modify a member holding `target`.
 *
 * An admin may manage analysts and viewers and other admins, but may not remove
 * an owner. Owners may manage anyone (subject to the last-owner rule below).
 */
export function canManageMemberWithRole(
  actor: OrganizationRole,
  target: OrganizationRole,
): boolean {
  if (!hasPermission(actor, "members:remove")) return false;
  if (target === "owner") return actor === "owner";
  return true;
}

/**
 * Last-owner protection.
 *
 * An organization must always retain at least one owner, so the final owner can
 * neither leave nor be demoted. The caller must transfer ownership first.
 */
export function wouldRemoveLastOwner(params: {
  targetCurrentRole: OrganizationRole;
  targetNewRole: OrganizationRole | null;
  ownerCount: number;
}): boolean {
  const { targetCurrentRole, targetNewRole, ownerCount } = params;
  if (targetCurrentRole !== "owner") return false;
  if (targetNewRole === "owner") return false;
  return ownerCount <= 1;
}
