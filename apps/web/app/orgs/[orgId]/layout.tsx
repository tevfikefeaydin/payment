import Link from "next/link";
import type { ReactNode } from "react";
import { PRODUCT } from "@payrecon/config";
import { hasPermission, type Permission } from "@payrecon/domain";
import { AppNav, type NavItem } from "@/components/app-nav";
import { Button } from "@/components/ui";
import { getCsrfToken } from "@/server/csrf";
import { signOutAction } from "@/server/auth-actions";
import { getUserOrganizations, requireOrg } from "@/server/session";

/**
 * Application shell for one organization.
 *
 * `requireOrg` proves membership before anything renders; a non-member (or a
 * nonexistent id) gets 404, never 403, so an outsider cannot confirm that an
 * organization id exists.
 *
 * Nav items are filtered by role as a COURTESY — the pages themselves check the
 * same permission again. Hiding a link is not a security control.
 */

/**
 * Never prerender or cache anything under an organization. Every page here is
 * scoped to one authenticated user's role and one tenant's data; a cached copy
 * would be a cross-tenant leak waiting to happen. Applies to all child segments.
 */
export const dynamic = "force-dynamic";

interface NavDefinition extends NavItem {
  permission: Permission;
}

function navigationFor(orgId: string): NavDefinition[] {
  const base = `/orgs/${orgId}`;
  return [
    { href: base, label: "Dashboard", exact: true, permission: "org:read" },
    { href: `${base}/exceptions`, label: "Exceptions", permission: "exceptions:read" },
    { href: `${base}/runs`, label: "Reconciliation runs", permission: "reconciliation:read" },
    { href: `${base}/sources`, label: "Sources", permission: "connections:read" },
    { href: `${base}/imports`, label: "Imports", permission: "imports:read" },
    { href: `${base}/api-keys`, label: "API keys", permission: "apikeys:read" },
    { href: `${base}/notifications`, label: "Notifications", permission: "notifications:read" },
    { href: `${base}/members`, label: "Members", permission: "members:read" },
    { href: `${base}/billing`, label: "Billing", permission: "billing:read" },
    { href: `${base}/audit`, label: "Audit log", permission: "audit:read" },
    { href: `${base}/settings`, label: "Settings", permission: "settings:read" },
  ];
}

export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  const [organizations, csrf] = await Promise.all([
    getUserOrganizations(org.user.id),
    getCsrfToken(),
  ]);

  const items: NavItem[] = navigationFor(org.organizationId)
    .filter((item) => hasPermission(org.role, item.permission))
    .map(({ href, label, exact }) => ({ href, label, exact }));

  const otherOrganizations = organizations.filter(
    (organization) => organization.id !== org.organizationId,
  );

  return (
    <div className="min-h-screen md:flex">
      {/* Sidebar */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] md:w-64 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex flex-col gap-4 px-4 py-4 md:h-screen md:sticky md:top-0 md:overflow-y-auto">
          <div>
            <Link href="/app" className="text-lg font-semibold tracking-tight">
              {PRODUCT.name}
            </Link>
          </div>

          {/* Organization switcher. A native <details> is keyboard operable and
              needs no JavaScript. */}
          <details className="group rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold tracking-widest text-[var(--color-accent)] uppercase">
                  {org.organizationName}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">
                  Your role: {org.role}
                  {org.isDemo ? " · demo data" : ""}
                </span>
              </span>
              <span aria-hidden="true" className="text-xs text-[var(--color-text-muted)]">
                ▾
              </span>
            </summary>
            <div className="border-t border-[var(--color-border)] p-2">
              {otherOrganizations.length > 0 ? (
                <>
                  <p className="px-1 pb-1 text-xs text-[var(--color-text-muted)]">
                    Switch organization
                  </p>
                  <ul className="space-y-0.5">
                    {otherOrganizations.map((organization) => (
                      <li key={organization.id}>
                        <Link
                          href={`/orgs/${organization.id}`}
                          className="block truncate rounded px-2 py-1.5 text-sm hover:bg-[var(--color-surface-raised)]"
                        >
                          {organization.name}
                          <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                            ({organization.role})
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="px-1 py-1 text-xs text-[var(--color-text-muted)]">
                  This is your only organization.
                </p>
              )}
              <Link
                href="/orgs/new"
                className="mt-1 block rounded px-2 py-1.5 text-sm underline hover:bg-[var(--color-surface-raised)]"
              >
                Create a new organization
              </Link>
            </div>
          </details>

          <AppNav items={items} />

          {/* User menu */}
          <details className="mt-auto rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)]">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{org.user.name}</span>
                <span className="block truncate text-xs text-[var(--color-text-muted)]">
                  {org.user.email}
                </span>
              </span>
              <span aria-hidden="true" className="text-xs text-[var(--color-text-muted)]">
                ▾
              </span>
            </summary>
            <div className="border-t border-[var(--color-border)] p-2">
              {/* `signOutAction` revokes the session server-side and redirects;
                  the CSRF field is submitted for consistency with every other
                  mutating form in the app. */}
              <form action={signOutAction}>
                <input type="hidden" name="csrf" value={csrf} />
                <Button type="submit" variant="secondary" size="sm" className="w-full">
                  Sign out
                </Button>
              </form>
            </div>
          </details>
        </div>
      </div>

      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        {children}
      </main>
    </div>
  );
}
