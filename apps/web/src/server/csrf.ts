import "server-only";
import { cookies } from "next/headers";
import { CSRF_COOKIE_NAME } from "@payrecon/config";

/**
 * Read the double-submit CSRF token for the current session.
 *
 * Pages read this on the SERVER and pass it into the form components, which echo
 * it back in a hidden field. `orgAction`/`userAction` then require the submitted
 * value to match both the cookie and the HMAC bound to this session.
 *
 * Returning an empty string when there is no cookie is deliberate: the resulting
 * submission fails the CSRF check rather than silently succeeding.
 */
export async function getCsrfToken(): Promise<string> {
  return (await cookies()).get(CSRF_COOKIE_NAME)?.value ?? "";
}
