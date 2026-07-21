import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  createSession,
  deriveCsrfToken,
  listUserOrganizations,
  resolveOrgContext,
  revokeSession,
  validateSession,
  type OrgContext,
  type OrganizationSummary,
  type SessionUser,
} from "@payrecon/auth";
import { ACTIVE_ORG_COOKIE_NAME, CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "@payrecon/config";
import { loadEnv } from "@payrecon/config/env";
import { db } from "./db";

/**
 * Request-scoped session and organization resolution.
 *
 * Cookie policy:
 *   - session cookie: httpOnly, SameSite=Lax, Secure in production, Path=/
 *   - CSRF cookie:    readable by scripts (double-submit), same lifetime
 *   - active-org:     a hint only; it is ALWAYS re-verified against membership,
 *                     so tampering with it cannot grant access.
 */

function isSecureContext(): boolean {
  return loadEnv().APP_URL.startsWith("https://");
}

export async function setSessionCookies(token: string, sessionId: string): Promise<void> {
  const env = loadEnv();
  const store = await cookies();
  const secure = isSecureContext();

  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_MAX_AGE_SECONDS,
  });

  // Double-submit CSRF token. Not httpOnly by design: the client must echo it
  // back in a form field. It is an HMAC bound to this session, so it is useless
  // for any other session.
  store.set(CSRF_COOKIE_NAME, deriveCsrfToken(sessionId, env.AUTH_SECRET), {
    httpOnly: false,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
  store.delete(CSRF_COOKIE_NAME);
  store.delete(ACTIVE_ORG_COOKIE_NAME);
}

export async function startSession(userId: string): Promise<void> {
  const env = loadEnv();
  const headerList = await headers();

  const { token, session } = await createSession(db(), {
    userId,
    policy: {
      maxAgeSeconds: env.SESSION_MAX_AGE_SECONDS,
      idleTimeoutSeconds: env.SESSION_IDLE_TIMEOUT_SECONDS,
    },
    ip: clientIp(headerList),
    userAgent: headerList.get("user-agent"),
    secret: env.AUTH_SECRET,
  });

  await setSessionCookies(token, session.id);
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (token) await revokeSession(db(), token);
  await clearSessionCookies();
}

export interface CurrentSession {
  user: SessionUser;
  sessionId: string;
}

/** Resolve the current session, or null when signed out. */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const env = loadEnv();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const result = await validateSession(db(), token, {
    maxAgeSeconds: env.SESSION_MAX_AGE_SECONDS,
    idleTimeoutSeconds: env.SESSION_IDLE_TIMEOUT_SECONDS,
  });
  if (!result) return null;

  return { user: result.user, sessionId: result.session.id };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  return (await getCurrentSession())?.user ?? null;
}

/** Redirects to sign-in when unauthenticated. For use in server components. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  return user;
}

export async function getUserOrganizations(userId: string): Promise<OrganizationSummary[]> {
  return listUserOrganizations(db(), userId);
}

/**
 * Resolve the organization context for a route.
 *
 * The organization id comes from the URL, but membership is ALWAYS verified
 * server-side. A non-member (or a nonexistent organization) yields 404 rather
 * than 403, so an id's existence is never confirmed to an outsider.
 */
export async function requireOrg(organizationId: string): Promise<OrgContext> {
  const user = await requireUser();
  const context = await resolveOrgContext(db(), user, organizationId);
  // `notFound()` returns `never`, which is what narrows `context` below. That
  // only works with a static import — a dynamic one loses the signature.
  if (!context) notFound();
  await rememberActiveOrg(context.organizationId);
  return context;
}

/** Store the last-used organization so "/app" can send the user somewhere sensible. */
export async function rememberActiveOrg(organizationId: string): Promise<void> {
  try {
    const store = await cookies();
    if (store.get(ACTIVE_ORG_COOKIE_NAME)?.value === organizationId) return;
    store.set(ACTIVE_ORG_COOKIE_NAME, organizationId, {
      httpOnly: true,
      secure: isSecureContext(),
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  } catch {
    // Server components cannot always set cookies (e.g. during static render).
    // This is a convenience hint only, so failing to persist it is harmless.
  }
}

export async function getActiveOrgHint(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACTIVE_ORG_COOKIE_NAME)?.value ?? null;
}

/** Best-effort client IP from common proxy headers. Hashed before storage. */
export function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headerList.get("x-real-ip");
}
