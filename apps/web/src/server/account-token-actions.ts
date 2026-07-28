"use server";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { generateToken, hashPassword, hashToken, validatePasswordStrength } from "@payrecon/auth";
import { isSmtpConfigured, loadEnv } from "@payrecon/config/env";
import { PRODUCT } from "@payrecon/config";
import { authTokens, recordAudit, sessions, users } from "@payrecon/db";
import { createTransports } from "@payrecon/notifications";
import { actionError, actionSuccess, type ActionState } from "./actions";
import { AUTH_RATE_LIMITS, clientIpHash, isAuthRateLimited } from "./auth-rate-limit";
import { db } from "./db";
import { startSession } from "./session";

const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && email.includes("@") && !/\s/.test(email)
    ? email
    : null;
}

async function issueAndSendToken(input: {
  userId: string;
  email: string;
  purpose: "password_reset" | "email_verification";
}): Promise<void> {
  // Without an SMTP transport, do not create a token that can never reach its
  // owner. The request remains deliberately indistinguishable to callers.
  if (!isSmtpConfigured()) return;

  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + (input.purpose === "password_reset" ? RESET_TTL_MS : VERIFY_TTL_MS),
  );
  await db()
    .insert(authTokens)
    .values({
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: hashToken(token),
      expiresAt,
    });

  const env = loadEnv();
  const path = input.purpose === "password_reset" ? "/reset-password" : "/verify-email";
  const url = new URL(`${path}/${token}`, env.APP_URL).toString();
  const subject =
    input.purpose === "password_reset"
      ? `Reset your ${PRODUCT.name} password`
      : `Verify your ${PRODUCT.name} email`;
  const instruction =
    input.purpose === "password_reset" ? "Reset your password" : "Verify your email address";

  await createTransports({
    email: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      secure: env.SMTP_SECURE,
      from: env.EMAIL_FROM,
    },
  }).email.send({
    to: input.email,
    subject,
    text: `${instruction}: ${url}`,
    html: `<p>${instruction} by opening this link:</p><p><a href="${url}">${instruction}</a></p>`,
  });
}

export async function sendEmailVerification(user: { id: string; email: string }): Promise<void> {
  try {
    await issueAndSendToken({ userId: user.id, email: user.email, purpose: "email_verification" });
  } catch (error) {
    // Do not surface mail-provider details or links to a browser or a log.
    console.error("[auth] verification email failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function requestPasswordResetAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const generic = "If an account matches that address, we sent a password reset link.";
  const email = normalizeEmail(formData.get("email"));
  if (!email) return actionSuccess(generic);

  // Rate-limited callers get the SAME generic success and simply no email:
  // revealing the limit would confirm that earlier requests matched accounts.
  const ipHash = await clientIpHash();
  if (await isAuthRateLimited(ipHash, AUTH_RATE_LIMITS.passwordReset)) {
    return actionSuccess(generic);
  }

  const [user] = await db()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!user) return actionSuccess(generic);

  try {
    await issueAndSendToken({ userId: user.id, email: user.email, purpose: "password_reset" });
    await recordAudit(db(), {
      organizationId: null,
      actor: { type: "user", userId: user.id },
      action: "auth.password_reset_requested",
      targetType: "user",
      targetId: user.id,
      // The limiter counts these rows per network, so the hash must be present.
      ipHash,
    });
  } catch (error) {
    console.error("[auth] password reset email failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
  return actionSuccess(generic);
}

export async function resetPasswordAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = formData.get("token");
  const password = formData.get("password");
  if (typeof token !== "string" || typeof password !== "string")
    return actionError("This password reset link is invalid or expired.");
  const strength = validatePasswordStrength(password);
  if (!strength.ok)
    return actionError(strength.message ?? "Choose a stronger password.", "weak_password");

  const now = new Date();
  const [row] = await db()
    .select({ id: authTokens.id, userId: authTokens.userId })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, "password_reset"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return actionError("This password reset link is invalid or expired.");

  const passwordHash = await hashPassword(password);
  const consumed = await db().transaction(async (tx) => {
    const updated = await tx
      .update(authTokens)
      .set({ consumedAt: now })
      .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
      .returning({ id: authTokens.id });
    if (updated.length === 0) return false;
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, row.userId));
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
    return true;
  });
  if (!consumed) return actionError("This password reset link has already been used.");

  await recordAudit(db(), {
    organizationId: null,
    actor: { type: "user", userId: row.userId },
    action: "auth.password_reset_completed",
    targetType: "user",
    targetId: row.userId,
  });
  await startSession(row.userId);
  return actionSuccess("Password reset. Taking you to your workspace…", "/app");
}

export async function verifyEmailAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = formData.get("token");
  if (typeof token !== "string")
    return actionError("This email verification link is invalid or expired.");
  const now = new Date();
  const [row] = await db()
    .select({ id: authTokens.id, userId: authTokens.userId })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.tokenHash, hashToken(token)),
        eq(authTokens.purpose, "email_verification"),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return actionError("This email verification link is invalid or expired.");
  const consumed = await db().transaction(async (tx) => {
    const updated = await tx
      .update(authTokens)
      .set({ consumedAt: now })
      .where(and(eq(authTokens.id, row.id), isNull(authTokens.consumedAt)))
      .returning({ id: authTokens.id });
    if (updated.length === 0) return false;
    await tx
      .update(users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(eq(users.id, row.userId));
    return true;
  });
  if (!consumed) return actionError("This email verification link has already been used.");
  return actionSuccess("Email verified. You can now continue to your workspace.", "/app");
}
