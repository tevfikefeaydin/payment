import "server-only";
import { cookies, headers } from "next/headers";
import { assertPermission, hashIp, verifyCsrfToken, type OrgContext } from "@payrecon/auth";
import { CSRF_COOKIE_NAME } from "@payrecon/config";
import { loadEnv } from "@payrecon/config/env";
import { PublicError, toSafeError, type Permission } from "@payrecon/domain";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { getCurrentSession, requireOrg } from "./session";

/**
 * Server action plumbing.
 *
 * Every state-changing action goes through `orgAction`, which enforces, in a
 * fixed order and before any business logic runs:
 *
 *   1. an authenticated session exists,
 *   2. the CSRF token in the form matches the one bound to that session,
 *   3. the user is a member of the target organization,
 *   4. the user's role carries the required permission.
 *
 * Doing this in one wrapper is what keeps authorization off the components. A
 * page may hide a button the user cannot use, but hiding is a courtesy — this
 * function is the actual boundary.
 */

/** Discriminated result returned to `useActionState` on the client. */
export type ActionState =
  | { status: "idle" }
  | { status: "success"; message?: string; redirectTo?: string }
  | { status: "error"; message: string; code?: string; fieldErrors?: Record<string, string> };

export const IDLE: ActionState = { status: "idle" };

export function actionError(message: string, code?: string): ActionState {
  return { status: "error", message, code };
}

export function actionSuccess(message?: string, redirectTo?: string): ActionState {
  return { status: "success", message, redirectTo };
}

/** CSRF failure is a 403 with a deliberately unhelpful message. */
class CsrfError extends PublicError {
  constructor() {
    super("csrf_failed", "Your session expired. Please reload the page and try again.", 403);
  }
}

async function assertCsrf(formData: FormData, sessionId: string): Promise<void> {
  const env = loadEnv();
  const submitted = formData.get("csrf");
  const cookieValue = (await cookies()).get(CSRF_COOKIE_NAME)?.value;

  if (typeof submitted !== "string" || !cookieValue) throw new CsrfError();
  // The submitted token must match BOTH the cookie and the value derived from
  // this session, so a stolen cookie from another session is useless.
  if (submitted !== cookieValue) throw new CsrfError();
  if (!verifyCsrfToken(submitted, sessionId, env.AUTH_SECRET)) throw new CsrfError();
}

export interface ActionContext {
  org: OrgContext;
  /** Correlates the audit event, the log line and the job this action spawns. */
  correlationId: string;
  ipHash: string | null;
}

/**
 * Wrap a permission-gated organization action.
 *
 * Usage:
 *   export const resolveExceptionAction = orgAction(
 *     "exceptions:transition",
 *     async (ctx, formData) => { ... },
 *   );
 */
export function orgAction(
  permission: Permission,
  handler: (context: ActionContext, formData: FormData) => Promise<ActionState>,
): (previous: ActionState, formData: FormData) => Promise<ActionState> {
  return async (_previous: ActionState, formData: FormData): Promise<ActionState> => {
    try {
      const session = await getCurrentSession();
      if (!session) {
        return actionError("You must be signed in to do that.", "unauthorized");
      }

      await assertCsrf(formData, session.sessionId);

      const organizationId = formData.get("organizationId");
      if (typeof organizationId !== "string" || organizationId.length === 0) {
        return actionError("Missing organization.", "bad_request");
      }

      // Membership is proven here; the id from the form is never trusted alone.
      const org = await requireOrg(organizationId);
      assertPermission(org, permission);

      const env = loadEnv();
      const headerList = await headers();
      const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

      return await handler(
        {
          org,
          correlationId: randomUUID(),
          ipHash: hashIp(forwarded, env.AUTH_SECRET),
        },
        formData,
      );
    } catch (error) {
      // Only PublicError messages reach the user; anything else becomes generic.
      const safe = toSafeError(error);
      if (safe.status >= 500) {
        console.error("[action] unhandled error", {
          code: safe.code,
          name: error instanceof Error ? error.name : "unknown",
        });
      }
      return actionError(safe.message, safe.code);
    }
  };
}

/**
 * Same guarantees as `orgAction` for actions with no organization context
 * (sign-in, sign-up, creating the first organization).
 */
export function userAction(
  handler: (
    context: { userId: string; correlationId: string; ipHash: string | null },
    formData: FormData,
  ) => Promise<ActionState>,
): (previous: ActionState, formData: FormData) => Promise<ActionState> {
  return async (_previous: ActionState, formData: FormData): Promise<ActionState> => {
    try {
      const session = await getCurrentSession();
      if (!session) return actionError("You must be signed in to do that.", "unauthorized");

      await assertCsrf(formData, session.sessionId);

      const env = loadEnv();
      const headerList = await headers();
      const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

      return await handler(
        {
          userId: session.user.id,
          correlationId: randomUUID(),
          ipHash: hashIp(forwarded, env.AUTH_SECRET),
        },
        formData,
      );
    } catch (error) {
      const safe = toSafeError(error);
      if (safe.status >= 500) {
        console.error("[action] unhandled error", { code: safe.code });
      }
      return actionError(safe.message, safe.code);
    }
  };
}

/** Re-export for actions that need direct database access. */
export { db };
