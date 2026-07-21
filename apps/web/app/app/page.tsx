import { redirect } from "next/navigation";
import { getActiveOrgHint, getUserOrganizations, requireUser } from "@/server/session";

// Depends on the session cookie: never prerendered, never cached.
export const dynamic = "force-dynamic";

/**
 * Entry point after signing in.
 *
 * The active-organization cookie is only ever a HINT. It is re-checked against
 * the membership list loaded for this user, so tampering with the cookie can at
 * worst send someone to their own first organization.
 */
export default async function AppEntryPage() {
  const user = await requireUser();
  const organizations = await getUserOrganizations(user.id);

  const first = organizations[0];
  if (!first) redirect("/orgs/new");

  const hint = await getActiveOrgHint();
  const target =
    hint && organizations.some((organization) => organization.id === hint) ? hint : first.id;

  redirect(`/orgs/${target}`);
}
