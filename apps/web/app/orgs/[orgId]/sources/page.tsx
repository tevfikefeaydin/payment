import type { Metadata } from "next";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hasPermission } from "@payrecon/domain";
import { stripeConnections } from "@payrecon/db";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import {
  createConnectionAction,
  deleteConnectionAction,
  disableConnectionAction,
  enableConnectionAction,
  revalidateConnectionAction,
} from "@/server/connection-actions";
import { getCsrfToken } from "@/server/csrf";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Sources" };

export default async function SourcesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);
  if (!hasPermission(org.role, "connections:read")) {
    return (
      <>
        <PageHeader title="Sources" />
        <NotPermitted what="Stripe connections" role={org.role} />
      </>
    );
  }

  const [connections, csrf] = await Promise.all([
    db()
      .select({
        id: stripeConnections.id,
        name: stripeConnections.name,
        accountDisplayName: stripeConnections.accountDisplayName,
        stripeAccountId: stripeConnections.stripeAccountId,
        livemode: stripeConnections.livemode,
        status: stripeConnections.status,
        readableResources: stripeConnections.readableResources,
        lastValidationError: stripeConnections.lastValidationError,
      })
      .from(stripeConnections)
      .where(
        and(
          eq(stripeConnections.organizationId, org.organizationId),
          isNull(stripeConnections.deletedAt),
        ),
      )
      .orderBy(desc(stripeConnections.createdAt)),
    getCsrfToken(),
  ]);
  const canCreate = hasPermission(org.role, "connections:create");
  const canUpdate = hasPermission(org.role, "connections:update");
  const canDelete = hasPermission(org.role, "connections:delete");

  return (
    <>
      <PageHeader
        title="Sources"
        description="Read-only Stripe connections used to reconcile provider data. PayRecon never writes to a connected Stripe account."
      />
      <div className="space-y-6">
        <Card
          title="Connected Stripe accounts"
          description="Each connection uses a Stripe restricted key, encrypted at rest and validated before any sync is allowed."
        >
          {connections.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No Stripe accounts are connected.
            </p>
          ) : (
            <Table caption="Connected Stripe accounts">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Account</Th>
                  <Th>Mode</Th>
                  <Th>Status</Th>
                  <Th>Readable resources</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id}>
                    <Td>
                      {connection.name}
                      {connection.lastValidationError && (
                        <span className="mt-1 block text-xs text-[var(--color-critical)]">
                          {connection.lastValidationError}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <code className="text-xs">
                        {connection.accountDisplayName ??
                          connection.stripeAccountId ??
                          "Not validated"}
                      </code>
                    </Td>
                    <Td>{connection.livemode ? "Live" : "Test"}</Td>
                    <Td className="capitalize">{connection.status}</Td>
                    <Td>
                      {Array.isArray(connection.readableResources) &&
                      connection.readableResources.length > 0
                        ? connection.readableResources.join(", ")
                        : "Not probed"}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {canUpdate && connection.status !== "disabled" && (
                          <ActionForm
                            action={revalidateConnectionAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ connectionId: connection.id }}
                            submitLabel="Validate & sync"
                            pendingLabel="Validating…"
                            size="sm"
                          />
                        )}
                        {canUpdate && connection.status !== "disabled" && (
                          <ActionForm
                            action={disableConnectionAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ connectionId: connection.id }}
                            submitLabel="Disable"
                            pendingLabel="Disabling…"
                            size="sm"
                          />
                        )}
                        {canUpdate && connection.status === "disabled" && (
                          <ActionForm
                            action={enableConnectionAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ connectionId: connection.id }}
                            submitLabel="Enable"
                            pendingLabel="Enabling…"
                            size="sm"
                          />
                        )}
                        {canDelete && (
                          <ActionForm
                            action={deleteConnectionAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ connectionId: connection.id }}
                            submitLabel="Delete"
                            pendingLabel="Deleting…"
                            variant="danger"
                            size="sm"
                            confirm={`Delete ${connection.name}? Its credential is revoked immediately and future syncs stop.`}
                          />
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {canCreate && (
          <Card
            title="Connect Stripe"
            description="Only Stripe restricted read keys beginning rk_test_ or rk_live_ are accepted. Secret and publishable keys are rejected."
          >
            <ActionForm
              action={createConnectionAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Validate and connect"
              pendingLabel="Validating…"
              variant="primary"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Connection name"
                  htmlFor="connection-name"
                  hint="For example: production Stripe."
                >
                  <Input id="connection-name" name="name" required maxLength={100} />
                </Field>
                <Field
                  label="Stripe restricted key"
                  htmlFor="restricted-key"
                  hint="Encrypted before it is stored and never sent back to your browser."
                >
                  <Input
                    id="restricted-key"
                    name="restrictedKey"
                    type="password"
                    autoComplete="off"
                    required
                  />
                </Field>
              </div>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
