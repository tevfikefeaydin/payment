import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { hashIp } from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import { auditEvents } from "@payrecon/db";
import { db } from "./db";

/**
 * Fixed-window rate limiting for the authentication endpoints.
 *
 * The counters are the audit log itself: failed sign-ins, completed sign-ups
 * and password-reset requests are already recorded there with a keyed hash of
 * the caller's IP. Counting those rows needs no new table, works across
 * serverless instances because the state lives in PostgreSQL, and cannot drift
 * from reality because the audit log is append-only.
 *
 * The IP hash is keyed with AUTH_SECRET (see hashIp), so the audit log never
 * becomes a directory of raw addresses.
 */

export const AUTH_RATE_LIMITS = {
  /** Failed sign-in attempts per IP before further attempts are refused. */
  signIn: { action: "auth.sign_in_failed", limit: 10, windowMinutes: 15 },
  /** Accounts one IP may create per window. */
  signUp: { action: "auth.signed_up", limit: 5, windowMinutes: 60 },
  /** Password-reset emails one IP may trigger per window. */
  passwordReset: { action: "auth.password_reset_requested", limit: 5, windowMinutes: 60 },
} as const;

/** Keyed hash of the caller's IP; null when no address is available. */
export async function clientIpHash(): Promise<string | null> {
  const headerList = await headers();
  return hashIp(headerList.get("x-forwarded-for")?.split(",")[0]?.trim(), loadEnv().AUTH_SECRET);
}

/**
 * True when the caller has exhausted the allowance for this action.
 *
 * A missing IP (direct local invocation) is never limited: refusing in that
 * case would lock out development environments without slowing an attacker,
 * who always arrives through the proxy that sets x-forwarded-for.
 */
export async function isAuthRateLimited(
  ipHash: string | null,
  rule: { action: string; limit: number; windowMinutes: number },
): Promise<boolean> {
  if (!ipHash) return false;

  const since = new Date(Date.now() - rule.windowMinutes * 60_000);
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, rule.action),
        eq(auditEvents.ipHash, ipHash),
        gt(auditEvents.createdAt, since),
      ),
    );

  return (row?.count ?? 0) >= rule.limit;
}
