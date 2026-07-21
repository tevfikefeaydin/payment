import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  canAssignRole,
  canManageMemberWithRole,
  hasPermission,
  isOrganizationRole,
  permissionsFor,
  wouldRemoveLastOwner,
  type OrganizationRole,
  type Permission,
} from "./permissions";

/**
 * The matrix is written out here IN FULL and independently of the source, so a
 * widening of access in permissions.ts fails this test rather than being
 * silently mirrored by it.
 */
const VIEWER: Permission[] = [
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

const ANALYST: Permission[] = [
  ...VIEWER,
  "imports:create",
  "reconciliation:run",
  "exceptions:assign",
  "exceptions:transition",
];

const ADMIN: Permission[] = [
  ...ANALYST,
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
  "billing:read",
];

const OWNER: Permission[] = [...ADMIN, "org:delete", "org:transfer_ownership", "billing:manage"];

const EXPECTED: Record<OrganizationRole, ReadonlySet<Permission>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  analyst: new Set(ANALYST),
  viewer: new Set(VIEWER),
};

/** Any permission that mutates state, by naming convention. */
const MUTATING =
  /:(create|update|delete|manage|run|transition|assign|invite|remove|revoke|change_role|test)$/;

describe("the role/permission matrix", () => {
  it("asserts every role x permission pair exactly", () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of PERMISSIONS) {
        const expected = EXPECTED[role].has(permission);
        expect(hasPermission(role, permission), `${role} -> ${permission}`).toBe(expected);
      }
    }
  });

  it("holds the expected number of permissions per role", () => {
    expect(permissionsFor("viewer")).toHaveLength(9);
    expect(permissionsFor("analyst")).toHaveLength(13);
    expect(permissionsFor("admin")).toHaveLength(29);
    expect(permissionsFor("owner")).toHaveLength(PERMISSIONS.length);
  });

  it("declares 32 distinct permissions", () => {
    expect(PERMISSIONS).toHaveLength(32);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect(new Set(ORGANIZATION_ROLES).size).toBe(ORGANIZATION_ROLES.length);
  });

  it("gives the owner every permission and nests roles strictly", () => {
    const [owner, admin, analyst, viewer] = [
      ROLE_PERMISSIONS.owner,
      ROLE_PERMISSIONS.admin,
      ROLE_PERMISSIONS.analyst,
      ROLE_PERMISSIONS.viewer,
    ];

    for (const permission of PERMISSIONS) expect(owner.has(permission)).toBe(true);
    for (const permission of viewer) expect(analyst.has(permission)).toBe(true);
    for (const permission of analyst) expect(admin.has(permission)).toBe(true);
    for (const permission of admin) expect(owner.has(permission)).toBe(true);

    expect(viewer.size).toBeLessThan(analyst.size);
    expect(analyst.size).toBeLessThan(admin.size);
    expect(admin.size).toBeLessThan(owner.size);
  });

  it("gives a VIEWER no mutating permission at all", () => {
    for (const permission of permissionsFor("viewer")) {
      expect(permission, `viewer must not hold ${permission}`).not.toMatch(MUTATING);
      expect(permission).toMatch(/:read$/);
    }
    // Sanity: the guard regex actually matches the mutating permissions.
    expect(PERMISSIONS.filter((p) => MUTATING.test(p)).length).toBeGreaterThan(15);
  });

  it("lets an analyst work but never administer", () => {
    expect(hasPermission("analyst", "reconciliation:run")).toBe(true);
    expect(hasPermission("analyst", "exceptions:transition")).toBe(true);
    expect(hasPermission("analyst", "imports:create")).toBe(true);
    for (const forbidden of [
      "members:invite",
      "members:remove",
      "members:change_role",
      "connections:create",
      "apikeys:create",
      "settings:manage",
      "billing:read",
      "demo:load",
    ] as Permission[]) {
      expect(hasPermission("analyst", forbidden), forbidden).toBe(false);
    }
  });

  it("lets an admin see billing but never change the subscription or delete the org", () => {
    expect(hasPermission("admin", "billing:read")).toBe(true);
    expect(hasPermission("admin", "billing:manage")).toBe(false);
    expect(hasPermission("admin", "org:delete")).toBe(false);
    expect(hasPermission("admin", "org:transfer_ownership")).toBe(false);
    expect(hasPermission("owner", "billing:manage")).toBe(true);
    expect(hasPermission("owner", "org:delete")).toBe(true);
    expect(hasPermission("owner", "org:transfer_ownership")).toBe(true);
  });

  it("returns a sorted permission list", () => {
    for (const role of ORGANIZATION_ROLES) {
      const list = permissionsFor(role);
      expect(list).toEqual([...list].sort());
    }
  });

  it("recognises only the declared roles", () => {
    for (const role of ORGANIZATION_ROLES) expect(isOrganizationRole(role)).toBe(true);
    for (const bad of ["", "OWNER", "superadmin", "member"]) {
      expect(isOrganizationRole(bad)).toBe(false);
    }
  });
});

describe("canAssignRole", () => {
  it("only an OWNER may create another owner", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("analyst", "owner")).toBe(false);
    expect(canAssignRole("viewer", "owner")).toBe(false);
  });

  it("an owner may assign any role", () => {
    for (const target of ORGANIZATION_ROLES) {
      expect(canAssignRole("owner", target), target).toBe(true);
    }
  });

  it("an admin may assign admin and below", () => {
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "analyst")).toBe(true);
    expect(canAssignRole("admin", "viewer")).toBe(true);
  });

  it("an analyst may not assign ANY role", () => {
    for (const target of ORGANIZATION_ROLES) {
      expect(canAssignRole("analyst", target), target).toBe(false);
    }
  });

  it("a viewer may not assign ANY role", () => {
    for (const target of ORGANIZATION_ROLES) {
      expect(canAssignRole("viewer", target), target).toBe(false);
    }
  });

  it("never lets an actor grant a role more senior than their own", () => {
    const rank: Record<OrganizationRole, number> = { owner: 0, admin: 1, analyst: 2, viewer: 3 };
    for (const actor of ORGANIZATION_ROLES) {
      for (const target of ORGANIZATION_ROLES) {
        if (canAssignRole(actor, target)) {
          expect(rank[actor], `${actor} -> ${target}`).toBeLessThanOrEqual(rank[target]);
        }
      }
    }
  });
});

describe("canManageMemberWithRole", () => {
  it("an admin may manage admins and below but NOT an owner", () => {
    expect(canManageMemberWithRole("admin", "admin")).toBe(true);
    expect(canManageMemberWithRole("admin", "analyst")).toBe(true);
    expect(canManageMemberWithRole("admin", "viewer")).toBe(true);
    expect(canManageMemberWithRole("admin", "owner")).toBe(false);
  });

  it("an owner may manage anyone", () => {
    for (const target of ORGANIZATION_ROLES) {
      expect(canManageMemberWithRole("owner", target), target).toBe(true);
    }
  });

  it("analysts and viewers may manage nobody", () => {
    for (const actor of ["analyst", "viewer"] as OrganizationRole[]) {
      for (const target of ORGANIZATION_ROLES) {
        expect(canManageMemberWithRole(actor, target), `${actor} -> ${target}`).toBe(false);
      }
    }
  });
});

describe("wouldRemoveLastOwner", () => {
  it("blocks demoting the sole owner", () => {
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: "admin", ownerCount: 1 }),
    ).toBe(true);
  });

  it("blocks removing the sole owner", () => {
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: null, ownerCount: 1 }),
    ).toBe(true);
  });

  it("allows demotion and removal when a second owner exists", () => {
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: "admin", ownerCount: 2 }),
    ).toBe(false);
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: null, ownerCount: 2 }),
    ).toBe(false);
  });

  it("does not fire for a non-owner target", () => {
    for (const current of ["admin", "analyst", "viewer"] as OrganizationRole[]) {
      expect(
        wouldRemoveLastOwner({ targetCurrentRole: current, targetNewRole: null, ownerCount: 1 }),
        current,
      ).toBe(false);
      expect(
        wouldRemoveLastOwner({ targetCurrentRole: current, targetNewRole: "owner", ownerCount: 1 }),
        current,
      ).toBe(false);
    }
  });

  it("does not fire when the owner stays an owner", () => {
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: "owner", ownerCount: 1 }),
    ).toBe(false);
  });

  it("treats a corrupt zero owner count as still protected", () => {
    expect(
      wouldRemoveLastOwner({ targetCurrentRole: "owner", targetNewRole: null, ownerCount: 0 }),
    ).toBe(true);
  });
});
