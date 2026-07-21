"use server";

import { and, eq, isNull } from "drizzle-orm";
import {
  changeMemberRole,
  invitations,
  isAlreadyMember,
  listPendingInvitations,
  recordAudit,
  removeMember,
  transferOwnership,
} from "@payrecon/db";
import { generateToken, hashToken } from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import { canAssignRole, isOrganizationRole } from "@payrecon/domain";
import { db } from "./db";
import { acceptInvitationAction } from "./auth-actions";
import { actionError, actionSuccess, orgAction, userAction, type ActionState } from "./actions";

/**
 * Membership and invitation actions.
 *
 * The interesting rules (privilege escalation, last-owner protection) live in
 * the repository and are mirrored by a database trigger. What these wrappers add
 * is: an authenticated, CSRF-checked, permission-gated entry point, an audit
 * event, and a readable message for the failures an operator can actually fix.
 */

/** Invitations expire quickly: a link that lives forever is a standing key. */
const INVITATION_TTL_DAYS = 7;

function normalizeEmail(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !email.includes("@")) return null;
  if (/\s/.test(email)) return null;
  return email;
}

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

const inviteHandler = orgAction("members:invite", async (context, formData) => {
  const email = normalizeEmail(formData.get("email"));
  const rawRole = formData.get("role");

  if (!email) return actionError("Enter a valid email address.", "invalid_email");
  if (typeof rawRole !== "string" || !isOrganizationRole(rawRole)) {
    return actionError("Choose a valid role.", "invalid_role");
  }

  // Escalation guard: an admin cannot mint an owner, and nobody can grant a
  // role more senior than their own.
  if (!canAssignRole(context.org.role, rawRole)) {
    return actionError(
      rawRole === "owner"
        ? "Only an owner can invite another owner."
        : "You cannot grant a role more senior than your own.",
      "forbidden_role_assignment",
    );
  }

  if (await isAlreadyMember(db(), context.org.organizationId, email)) {
    return actionError("That person is already a member of this organization.", "already_member");
  }

  const pending = await listPendingInvitations(db(), context.org.organizationId);
  if (pending.some((invitation) => invitation.email.toLowerCase() === email)) {
    return actionError(
      "An invitation is already pending for that address. Revoke it first to issue a new link.",
      "invitation_exists",
    );
  }

  // Only the HASH is stored. The plaintext token exists once, in the response
  // below, and is never recoverable afterwards.
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

  try {
    await db()
      .insert(invitations)
      .values({
        organizationId: context.org.organizationId,
        email,
        role: rawRole,
        tokenHash: hashToken(token),
        invitedByUserId: context.org.user.id,
        expiresAt,
      });
  } catch {
    // The partial unique index is the real guard against a concurrent duplicate.
    return actionError("An invitation is already pending for that address.", "invitation_exists");
  }

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "member.invited",
    targetType: "invitation",
    targetId: email,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { role: rawRole, expiresAt: expiresAt.toISOString() },
  });

  const inviteUrl = `${loadEnv().APP_URL.replace(/\/$/, "")}/invitations/${token}`;
  return actionSuccess(
    `Invitation created for ${email}. Copy this link now — it is shown only once and expires in ${INVITATION_TTL_DAYS} days: ${inviteUrl}`,
  );
});

export async function inviteMemberAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return inviteHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Revoke invitation
// ---------------------------------------------------------------------------

const revokeInvitationHandler = orgAction("members:invite", async (context, formData) => {
  const invitationId = formData.get("invitationId");
  if (typeof invitationId !== "string" || invitationId.length === 0) {
    return actionError("Missing invitation.", "bad_request");
  }

  const [revoked] = await db()
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        // Tenant scope is part of the WHERE clause: an id alone is not authority.
        eq(invitations.organizationId, context.org.organizationId),
        eq(invitations.id, invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ email: invitations.email });

  if (!revoked) {
    return actionError("That invitation is no longer pending.", "not_found");
  }

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "member.invitation_revoked",
    targetType: "invitation",
    targetId: invitationId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
  });

  return actionSuccess(`Invitation for ${revoked.email} revoked. The link no longer works.`);
});

export async function revokeInvitationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return revokeInvitationHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Change role
// ---------------------------------------------------------------------------

const changeRoleHandler = orgAction("members:change_role", async (context, formData) => {
  const targetUserId = formData.get("userId");
  const rawRole = formData.get("role");

  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return actionError("Missing member.", "bad_request");
  }
  if (typeof rawRole !== "string" || !isOrganizationRole(rawRole)) {
    return actionError("Choose a valid role.", "invalid_role");
  }

  // Throws a PublicError for escalation, owner-protection and last-owner cases;
  // `orgAction` turns those into the exact message shown to the operator.
  await changeMemberRole(db(), {
    organizationId: context.org.organizationId,
    actorRole: context.org.role,
    targetUserId,
    newRole: rawRole,
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "member.role_changed",
    targetType: "user",
    targetId: targetUserId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { newRole: rawRole },
  });

  return actionSuccess(`Role updated to ${rawRole}.`);
});

export async function changeMemberRoleAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return changeRoleHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Remove member
// ---------------------------------------------------------------------------

const removeMemberHandler = orgAction("members:remove", async (context, formData) => {
  const targetUserId = formData.get("userId");
  if (typeof targetUserId !== "string" || targetUserId.length === 0) {
    return actionError("Missing member.", "bad_request");
  }

  await removeMember(db(), {
    organizationId: context.org.organizationId,
    actorRole: context.org.role,
    targetUserId,
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "member.removed",
    targetType: "user",
    targetId: targetUserId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
  });

  return actionSuccess("Member removed. They immediately lose access to this organization.");
});

export async function removeMemberAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return removeMemberHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Transfer ownership
// ---------------------------------------------------------------------------

const transferOwnershipHandler = orgAction("org:transfer_ownership", async (context, formData) => {
  const newOwnerUserId = formData.get("userId");
  if (typeof newOwnerUserId !== "string" || newOwnerUserId.length === 0) {
    return actionError("Choose the member who should become owner.", "bad_request");
  }

  // The acting user is the current owner by construction: `org:transfer_ownership`
  // is an owner-only permission, and the id comes from the verified context.
  await transferOwnership(db(), {
    organizationId: context.org.organizationId,
    currentOwnerUserId: context.org.user.id,
    newOwnerUserId,
    demoteTo: "admin",
  });

  await recordAudit(db(), {
    organizationId: context.org.organizationId,
    actor: { type: "user", userId: context.org.user.id },
    action: "organization.ownership_transferred",
    targetType: "user",
    targetId: newOwnerUserId,
    correlationId: context.correlationId,
    ipHash: context.ipHash,
    metadata: { previousOwnerUserId: context.org.user.id, demotedTo: "admin" },
  });

  return actionSuccess("Ownership transferred. You are now an admin of this organization.");
});

export async function transferOwnershipAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return transferOwnershipHandler(previous, formData);
}

// ---------------------------------------------------------------------------
// Accept an invitation
// ---------------------------------------------------------------------------

/**
 * `userAction` rather than `orgAction`: the whole point is that the caller is
 * NOT yet a member. Authentication and CSRF still apply, and
 * `acceptInvitationAction` does the real work — matching the token by hash,
 * rejecting expired/revoked/already-accepted invitations, and requiring the
 * signed-in user's email to match the address the invitation was issued to, so
 * a leaked link cannot be redeemed by a different account.
 */
const acceptInvitationHandler = userAction(async (_context, formData) => {
  const token = formData.get("token");
  if (typeof token !== "string" || token.length === 0) {
    return actionError("This invitation link is incomplete.", "bad_request");
  }

  const { organizationId } = await acceptInvitationAction(token);
  return actionSuccess("Invitation accepted.", `/orgs/${organizationId}`);
});

export async function acceptInvitationFormAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return acceptInvitationHandler(previous, formData);
}
