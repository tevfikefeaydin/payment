import { EmptyState } from "./ui";

/**
 * Rendered when a member opens a page their role does not cover.
 *
 * Membership is already proven at this point, so being explicit is helpful
 * rather than a leak — the person knows the organization exists. Cross-tenant
 * access is a different case entirely and is answered with 404 by `requireOrg`.
 */
export function NotPermitted({
  what,
  role,
}: {
  /** Plain-language description of the page, e.g. "the audit log". */
  what: string;
  role: string;
}) {
  return (
    <EmptyState
      title={`You do not have access to ${what}`}
      description={`Your role in this organization is "${role}", which does not include this permission. An owner or admin can change your role from the Members page.`}
    />
  );
}
