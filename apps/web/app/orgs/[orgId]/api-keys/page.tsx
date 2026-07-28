import type { Metadata } from "next";
import { createDrizzleIngestionStore, listApiKeys } from "@payrecon/ingestion";
import { hasPermission } from "@payrecon/domain";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime, displayRelative } from "@/lib/format";
import { createApiKeyAction, revokeApiKeyAction } from "@/server/api-key-actions";
import { getCsrfToken } from "@/server/csrf";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "apikeys:read")) {
    return (
      <>
        <PageHeader title="API keys" />
        <NotPermitted what="API keys" role={org.role} />
      </>
    );
  }

  const [keys, csrf] = await Promise.all([
    listApiKeys(createDrizzleIngestionStore(db()), org.organizationId),
    getCsrfToken(),
  ]);
  const canCreate = hasPermission(org.role, "apikeys:create");
  const canRevoke = hasPermission(org.role, "apikeys:revoke");

  return (
    <>
      <PageHeader
        title="API keys"
        description="Organization-scoped keys for pushing payment records into PayRecon."
      />

      <div className="space-y-6">
        <Card
          title="Active and historical keys"
          description="Only a safe prefix is displayed. The full key is never stored and cannot be recovered."
        >
          {keys.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No API keys have been created.</p>
          ) : (
            <Table caption="Organization API keys">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Prefix</Th>
                  <Th>Scopes</Th>
                  <Th>Status</Th>
                  <Th>Last used</Th>
                  <Th>Expires</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <Td>{key.name}</Td>
                    <Td>
                      <code className="text-xs">{key.prefix}</code>
                    </Td>
                    <Td>{key.scopes.join(", ")}</Td>
                    <Td className="capitalize">{key.status}</Td>
                    <Td>
                      {key.lastUsedAt ? (
                        <span title={displayDateTime(key.lastUsedAt)}>
                          {displayRelative(key.lastUsedAt)}
                        </span>
                      ) : (
                        "Never"
                      )}
                    </Td>
                    <Td>
                      {key.expiresAt ? (
                        <span title={displayDateTime(key.expiresAt)}>
                          {displayRelative(key.expiresAt)}
                        </span>
                      ) : (
                        "Never"
                      )}
                    </Td>
                    <Td>
                      {canRevoke && key.status === "active" ? (
                        <ActionForm
                          action={revokeApiKeyAction}
                          csrf={csrf}
                          organizationId={org.organizationId}
                          fields={{ apiKeyId: key.id }}
                          submitLabel="Revoke"
                          pendingLabel="Revokingâ€¦"
                          variant="danger"
                          size="sm"
                          confirm={`Revoke ${key.name}? Any integration using this key stops working immediately.`}
                        />
                      ) : (
                        "â€”"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {canCreate && (
          <Card
            title="Create API key"
            description="The key is displayed once after creation. Store it in your deployment secret manager before leaving this page."
          >
            <ActionForm
              action={createApiKeyAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Create API key"
              pendingLabel="Creatingâ€¦"
              variant="primary"
              refreshOnSuccess={false}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Key name"
                  htmlFor="api-key-name"
                  hint="For example: production importer."
                >
                  <Input id="api-key-name" name="name" required maxLength={100} />
                </Field>
                <Field
                  label="Expiry (optional)"
                  htmlFor="api-key-expiry"
                  hint="Leave blank for no expiry."
                >
                  <Input id="api-key-expiry" name="expiresAt" type="date" />
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Scopes</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="scopes" value="records:write" defaultChecked />
                  Write internal payment records
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="scopes" value="records:read" />
                  Read internal payment records
                </label>
              </fieldset>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
