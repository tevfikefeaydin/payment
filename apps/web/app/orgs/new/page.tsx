import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT } from "@payrecon/config";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input } from "@/components/ui";
import { createOrganizationAction } from "@/server/org-actions";
import { getCsrfToken } from "@/server/csrf";
import { getUserOrganizations, requireUser } from "@/server/session";

export const metadata: Metadata = { title: "New organization" };

// Depends on the session cookie: never prerendered, never cached.
export const dynamic = "force-dynamic";

export default async function NewOrganizationPage() {
  const user = await requireUser();
  const [organizations, csrf] = await Promise.all([getUserOrganizations(user.id), getCsrfToken()]);

  const isFirst = organizations.length === 0;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <span className="text-sm font-semibold tracking-tight">{PRODUCT.name}</span>
          {!isFirst && (
            <Link href="/app" className="text-sm underline">
              Back to your workspace
            </Link>
          )}
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-md flex-1 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight">
          {isFirst ? "Create your organization" : "Create another organization"}
        </h1>
        <p className="mt-1 mb-6 text-sm text-[var(--color-text-muted)]">
          An organization owns its own Stripe connections, payment records, exceptions and members.
          Nothing is shared between organizations.
        </p>

        <Card>
          {/* No organizationId: this is a `userAction`, there is no org context yet. */}
          <ActionForm
            action={createOrganizationAction}
            csrf={csrf}
            submitLabel="Create organization"
            pendingLabel="Creating…"
            variant="primary"
            fullWidthSubmit
            // The action returns a redirect, so refreshing here would be wasted work.
            refreshOnSuccess={false}
          >
            <Field
              label="Organization name"
              htmlFor="name"
              hint="Between 2 and 100 characters. You can change this later in settings."
            >
              <Input
                id="name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={100}
                autoFocus
                placeholder="Acme Payments"
              />
            </Field>
          </ActionForm>
        </Card>

        <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
          You become the owner of this organization. Ownership can be transferred to another member
          later.
        </p>
      </main>
    </div>
  );
}
