import Link from "next/link";
import type { Metadata } from "next";
import { and, eq, isNull } from "drizzle-orm";
import { invitations, organizations } from "@payrecon/db";
import { hashToken } from "@payrecon/auth";
import { PRODUCT } from "@payrecon/config";
import { Alert, Button, Card } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { displayDateTime } from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { requireUser } from "@/server/session";
import { acceptInvitationFormAction } from "@/server/member-actions";

export const metadata: Metadata = { title: "Invitation" };

// Depends on the session cookie and a one-time token: never cached.
export const dynamic = "force-dynamic";

/**
 * Accept an organization invitation.
 *
 * The token is looked up by HASH — the plaintext is never stored — and the
 * organization's name is revealed only once the signed-in user's email matches
 * the address the invitation was issued to. Someone who merely holds a link
 * therefore learns nothing about the organization behind it.
 */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Signing in first is required: an invitation is bound to an email address,
  // and we cannot check that binding against an anonymous visitor.
  const user = await requireUser();
  const csrf = await getCsrfToken();

  const [invitation] = await db()
    .select({
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      organizationName: organizations.name,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  const expired = invitation ? invitation.expiresAt.getTime() < Date.now() : false;
  const matchesUser = invitation
    ? invitation.email.toLowerCase() === user.email.toLowerCase()
    : false;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            {PRODUCT.name}
          </Link>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-12"
      >
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Organization invitation</h1>

        {!invitation || expired ? (
          <Card>
            <Alert tone="error" title="This invitation is no longer valid">
              <p>
                It may have expired, been revoked, or already been accepted. Ask whoever invited you
                to issue a new link.
              </p>
            </Alert>
            <div className="mt-4">
              <Link href="/app">
                <Button variant="secondary">Go to your workspace</Button>
              </Link>
            </div>
          </Card>
        ) : !matchesUser ? (
          <Card>
            <Alert tone="error" title="This invitation was sent to a different address">
              <p>
                You are signed in as <strong>{user.email}</strong>. Sign in with the account the
                invitation was addressed to, then open this link again.
              </p>
            </Alert>
            <div className="mt-4">
              <Link href="/app">
                <Button variant="secondary">Go to your workspace</Button>
              </Link>
            </div>
          </Card>
        ) : (
          <Card
            title={`Join ${invitation.organizationName}`}
            description={`You have been invited as ${invitation.role}. This invitation expires ${displayDateTime(invitation.expiresAt)}.`}
          >
            <p className="mb-4 text-sm text-[var(--color-text-muted)]">
              Accepting gives you access to this organization's payment records, exceptions and
              audit log at the {invitation.role} level. Your membership is recorded in the audit
              log.
            </p>
            <ActionForm
              action={acceptInvitationFormAction}
              csrf={csrf}
              fields={{ token }}
              submitLabel="Accept invitation"
              pendingLabel="Joining…"
              variant="primary"
              refreshOnSuccess={false}
            />
          </Card>
        )}
      </main>
    </div>
  );
}
