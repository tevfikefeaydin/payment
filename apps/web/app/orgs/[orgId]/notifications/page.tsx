import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { hasPermission } from "@payrecon/domain";
import { notificationDestinations } from "@payrecon/db";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime, displayRelative } from "@/lib/format";
import {
  createNotificationDestinationAction,
  deleteNotificationDestinationAction,
  testNotificationDestinationAction,
} from "@/server/notification-actions";
import { getCsrfToken } from "@/server/csrf";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "notifications:read")) {
    return (
      <>
        <PageHeader title="Notifications" />
        <NotPermitted what="notification settings" role={org.role} />
      </>
    );
  }

  const [destinations, csrf] = await Promise.all([
    db()
      .select({
        id: notificationDestinations.id,
        kind: notificationDestinations.kind,
        name: notificationDestinations.name,
        target: notificationDestinations.target,
        secretHint: notificationDestinations.secretHint,
        status: notificationDestinations.status,
        verifiedAt: notificationDestinations.verifiedAt,
        lastError: notificationDestinations.lastError,
      })
      .from(notificationDestinations)
      .where(eq(notificationDestinations.organizationId, org.organizationId))
      .orderBy(notificationDestinations.createdAt),
    getCsrfToken(),
  ]);
  const canManage = hasPermission(org.role, "notifications:manage");
  const canTest = hasPermission(org.role, "notifications:test");

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where new exceptions are announced, and which ones are worth interrupting someone for."
      />

      <div className="space-y-6">
        <Card
          title="Destinations"
          description="A destination only becomes active once a test message has been delivered. Slack webhook URLs are encrypted and never shown again."
        >
          {destinations.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No notification destinations yet.
            </p>
          ) : (
            <Table caption="Notification destinations">
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Target</Th>
                  <Th>Status</Th>
                  <Th>Verified</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {destinations.map((destination) => (
                  <tr key={destination.id}>
                    <Td>{destination.name}</Td>
                    <Td className="capitalize">{destination.kind}</Td>
                    <Td className="break-all text-xs">
                      {destination.target ?? destination.secretHint}
                    </Td>
                    <Td className="capitalize">
                      {destination.status}
                      {destination.lastError && (
                        <span className="mt-1 block text-xs text-[var(--color-critical)]">
                          Delivery failed
                        </span>
                      )}
                    </Td>
                    <Td>
                      {destination.verifiedAt ? (
                        <span title={displayDateTime(destination.verifiedAt)}>
                          {displayRelative(destination.verifiedAt)}
                        </span>
                      ) : (
                        "Not yet"
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-2">
                        {canTest && (
                          <ActionForm
                            action={testNotificationDestinationAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ destinationId: destination.id }}
                            submitLabel="Send test"
                            pendingLabel="Sendingâ€¦"
                            size="sm"
                          />
                        )}
                        {canManage && (
                          <ActionForm
                            action={deleteNotificationDestinationAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ destinationId: destination.id }}
                            submitLabel="Delete"
                            pendingLabel="Deletingâ€¦"
                            variant="danger"
                            size="sm"
                            confirm={`Delete ${destination.name}? Future notifications to it will stop immediately.`}
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

        {canManage && (
          <Card
            title="Add destination"
            description="For email, enter an address. For Slack, enter an incoming-webhook URL. Only the selected type is used."
          >
            <ActionForm
              action={createNotificationDestinationAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Add destination"
              pendingLabel="Addingâ€¦"
              variant="primary"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor="destination-name">
                  <Input
                    id="destination-name"
                    name="name"
                    required
                    maxLength={80}
                    placeholder="On-call"
                  />
                </Field>
                <Field label="Type" htmlFor="destination-kind">
                  <Select id="destination-kind" name="kind" defaultValue="email">
                    <option value="email">Email</option>
                    <option value="slack">Slack</option>
                  </Select>
                </Field>
                <Field
                  label="Email address"
                  htmlFor="destination-email"
                  hint="Used when type is Email."
                >
                  <Input id="destination-email" name="email" type="email" maxLength={254} />
                </Field>
                <Field
                  label="Slack incoming webhook"
                  htmlFor="destination-slack"
                  hint="Used when type is Slack; it is encrypted at rest."
                >
                  <Input id="destination-slack" name="webhookUrl" type="url" autoComplete="off" />
                </Field>
              </div>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
