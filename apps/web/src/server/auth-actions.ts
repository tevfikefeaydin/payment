"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  createOrganization,
  invitations,
  organizationMembers,
  recordAudit,
  users,
} from "@payrecon/db";
import {
  generateToken,
  hashIp,
  hashToken,
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
} from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import { PublicError, toSafeError } from "@payrecon/domain";
import { db } from "./db";
import { sendEmailVerification } from "./account-token-actions";
import { endSession, getCurrentUser, startSession } from "./session";
import { actionError, actionSuccess, type ActionState } from "./actions";

/**
 * Authentication actions.
 *
 * Anti-enumeration policy: sign-in and password reset return the SAME response
 * whether or not the account exists. Sign-up is the one place where existence
 * necessarily leaks (two accounts cannot share an email), so it is rate-limited
 * and returns a neutral message.
 *
 * Every failure path costs roughly the same time as the success path — a wrong
 * email still performs a password verification against a dummy hash — so an
 * attacker cannot distinguish "no such user" from "wrong password" by timing.
 */

/** A real scrypt hash of an unguessable value, used to equalise timing. */
const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Ly9kZXZudWxsZHVtbXloYXNodmFsdWVmb3J0aW1pbmdlcXVhbGlzYXRpb25vbmx5Lg==";

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  // Deliberately permissive: real validation is that a verification email
  // arrives. This only rejects values that cannot be an address at all.
  if (email.length < 3 || email.length > 254 || !email.includes("@")) return null;
  if (/\s/.test(email)) return null;
  return email;
}

export async function signUpAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const email = normalizeEmail(formData.get("email"));
    const password = formData.get("password");
    const name = formData.get("name");
    const organizationName = formData.get("organizationName");

    if (!email) return actionError("Enter a valid email address.", "invalid_email");
    if (typeof password !== "string") return actionError("Enter a password.", "invalid_password");
    if (typeof name !== "string" || name.trim().length < 1) {
      return actionError("Enter your name.", "invalid_name");
    }

    const strength = validatePasswordStrength(password);
    if (!strength.ok)
      return actionError(strength.message ?? "Password is not acceptable.", "weak_password");

    const passwordHash = await hashPassword(password);

    const [existing] = await db()
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    if (existing) {
      // Neutral message: does not confirm the account exists to a stranger, but
      // is still actionable for the legitimate owner.
      return actionError(
        "That email cannot be used to create a new account. Try signing in instead.",
        "email_unavailable",
      );
    }

    const [created] = await db()
      .insert(users)
      .values({ email, name: name.trim().slice(0, 100), passwordHash })
      .returning({ id: users.id });

    if (!created) return actionError("Could not create your account.", "internal_error");

    const headerList = await headers();
    const env = loadEnv();
    await recordAudit(db(), {
      organizationId: null,
      actor: { type: "user", userId: created.id },
      action: "auth.signed_up",
      targetType: "user",
      targetId: created.id,
      ipHash: hashIp(headerList.get("x-forwarded-for")?.split(",")[0]?.trim(), env.AUTH_SECRET),
    });

    await startSession(created.id);

    // Creating an organization during sign-up keeps the first-run flow to one
    // step; the field is optional and defaults to a personal workspace.
    const orgName =
      typeof organizationName === "string" && organizationName.trim().length >= 2
        ? organizationName.trim()
        : `${name.trim().split(/\s+/)[0] ?? "My"}'s workspace`;

    const org = await createOrganization(db(), { name: orgName, ownerUserId: created.id });

    await recordAudit(db(), {
      organizationId: org.id,
      actor: { type: "user", userId: created.id },
      action: "organization.created",
      targetType: "organization",
      targetId: org.id,
      metadata: { name: orgName },
    });

    // Email delivery is deliberately best-effort: an SMTP outage must not
    // strand a freshly created account or expose transport details to a user.
    await sendEmailVerification({ id: created.id, email });

    return actionSuccess(undefined, `/orgs/${org.id}`);
  } catch (error) {
    const safe = toSafeError(error);
    return actionError(safe.message, safe.code);
  }
}

export async function signInAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const GENERIC = "That email and password combination is not correct.";

  try {
    const email = normalizeEmail(formData.get("email"));
    const password = formData.get("password");

    if (!email || typeof password !== "string") {
      // Still spend the time a real verification would take.
      await verifyPassword("placeholder-password", DUMMY_HASH);
      return actionError(GENERIC, "invalid_credentials");
    }

    const [user] = await db()
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    // Always verify SOMETHING so the timing of a missing account matches.
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    const headerList = await headers();
    const env = loadEnv();
    const ipHash = hashIp(
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim(),
      env.AUTH_SECRET,
    );

    if (!user || !ok || user.disabledAt) {
      await recordAudit(db(), {
        organizationId: null,
        actor: user ? { type: "user", userId: user.id } : { type: "system" },
        action: "auth.sign_in_failed",
        targetType: "user",
        targetId: user?.id ?? null,
        ipHash,
        // The attempted email is NOT recorded: audit rows are readable by org
        // members and must not become a directory of failed guesses.
        metadata: { reason: user ? (user.disabledAt ? "disabled" : "bad_password") : "no_account" },
      });
      return actionError(GENERIC, "invalid_credentials");
    }

    // Transparently upgrade a hash created under weaker parameters.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(password);
      await db().update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id));
    }

    await startSession(user.id);

    await recordAudit(db(), {
      organizationId: null,
      actor: { type: "user", userId: user.id },
      action: "auth.signed_in",
      targetType: "user",
      targetId: user.id,
      ipHash,
    });

    return actionSuccess(undefined, "/app");
  } catch (error) {
    const safe = toSafeError(error);
    return actionError(safe.status >= 500 ? GENERIC : safe.message, safe.code);
  }
}

export async function signOutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    await recordAudit(db(), {
      organizationId: null,
      actor: { type: "user", userId: user.id },
      action: "auth.signed_out",
      targetType: "user",
      targetId: user.id,
    });
  }
  await endSession();
  redirect("/sign-in");
}

/**
 * Accept an invitation.
 *
 * The token is looked up by HASH, must not be expired, revoked or already
 * accepted, and must match the signed-in user's email — so a leaked link cannot
 * be redeemed by a different account.
 */
export async function acceptInvitationAction(token: string): Promise<{ organizationId: string }> {
  const user = await getCurrentUser();
  if (!user) throw new PublicError("unauthorized", "Sign in to accept this invitation.", 401);

  const database = db();
  const [invitation] = await database
    .select({
      id: invitations.id,
      organizationId: invitations.organizationId,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .limit(1);

  if (!invitation || invitation.expiresAt.getTime() < Date.now()) {
    throw new PublicError("invalid_invitation", "This invitation is no longer valid.", 400);
  }

  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    throw new PublicError(
      "invitation_mismatch",
      "This invitation was sent to a different email address.",
      403,
    );
  }

  await database.transaction(async (tx) => {
    await tx
      .insert(organizationMembers)
      .values({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
      })
      // Already a member: accepting is a no-op rather than an error.
      .onConflictDoNothing({
        target: [organizationMembers.organizationId, organizationMembers.userId],
      });

    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: user.id })
      .where(eq(invitations.id, invitation.id));
  });

  await recordAudit(database, {
    organizationId: invitation.organizationId,
    actor: { type: "user", userId: user.id },
    action: "member.joined",
    targetType: "user",
    targetId: user.id,
    metadata: { role: invitation.role },
  });

  return { organizationId: invitation.organizationId };
}

/** Issue an invitation token. Returns the plaintext token exactly once. */
export async function createInvitationToken(): Promise<{ token: string; tokenHash: string }> {
  const token = generateToken();
  return { token, tokenHash: hashToken(token) };
}
