import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import { sessions, users } from "@payrecon/db/schema";
import { generateToken, hashIp, hashToken } from "./tokens";

/**
 * Server-side session management.
 *
 * Sessions live in PostgreSQL, not in a signed cookie, so that revocation is
 * immediate and total: signing out, disabling an account, or changing a password
 * invalidates access on the very next request rather than when a JWT happens to
 * expire.
 *
 * The cookie carries only an opaque random token; the database stores only its
 * SHA-256 hash.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | null;
}

export interface ActiveSession {
  id: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

export interface SessionPolicy {
  /** Absolute lifetime, regardless of activity. */
  maxAgeSeconds: number;
  /** Session dies after this long without a request. */
  idleTimeoutSeconds: number;
}

export interface CreateSessionInput {
  userId: string;
  policy: SessionPolicy;
  ip?: string | null;
  userAgent?: string | null;
  /** AUTH_SECRET, used to key the IP hash. */
  secret: string;
}

/**
 * Create a session and return the plaintext token exactly once.
 * The caller is responsible for setting it as an httpOnly, Secure, SameSite
 * cookie; the token must never be rendered into HTML or logged.
 */
export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<{ token: string; session: ActiveSession }> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + input.policy.maxAgeSeconds * 1000);

  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash,
      expiresAt,
      ipHash: hashIp(input.ip, input.secret),
      userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
    })
    .returning({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
    });

  if (!row) throw new Error("Failed to create session");
  return { token, session: row };
}

/**
 * Resolve a session token to its user.
 *
 * Enforces, in SQL: not revoked, not past absolute expiry, and the owning
 * account not disabled. The idle timeout is enforced in application code so the
 * expired row can be revoked as a side effect.
 *
 * Returns null for every failure mode — an invalid token and an expired one are
 * indistinguishable to the caller.
 */
export async function validateSession(
  db: Database,
  token: string,
  policy: SessionPolicy,
): Promise<{ user: SessionUser; session: ActiveSession } | null> {
  if (!token || token.length < 16) return null;
  const tokenHash = hashToken(token);
  const now = new Date();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        isNull(users.disabledAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Idle timeout: revoke rather than merely reject, so the row cannot be reused.
  const idleMs = policy.idleTimeoutSeconds * 1000;
  if (now.getTime() - row.lastSeenAt.getTime() > idleMs) {
    await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.sessionId));
    return null;
  }

  // Advance activity at most once a minute to avoid a write on every request.
  if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
  }

  return {
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      emailVerifiedAt: row.emailVerifiedAt,
    },
    session: {
      id: row.sessionId,
      userId: row.userId,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
    },
  };
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
}

/**
 * Revoke every session for a user. Called on password change, account
 * disablement, and "sign out everywhere".
 */
export async function revokeAllUserSessions(db: Database, userId: string): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * Delete sessions that are expired or long revoked.
 * Run on a schedule by the worker so the table does not grow without bound.
 */
export async function purgeDeadSessions(db: Database, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });
  return deleted.length;
}
