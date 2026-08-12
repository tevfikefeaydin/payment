import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { EXCEPTION_SEVERITIES, hasPermission } from "@payrecon/domain";
import { notificationDestinations, notificationPolicies } from "@payrecon/db";
import { ActionForm } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime, displayMoney, displayRelative } from "@/lib/format";
import {
  createNotificationDestinationAction,
  createNotificationPolicyAction,
  deleteNotificationDestinationAction,
  deleteNotificationPolicyAction,
  testNotificationDestinationAction,
  toggleNotificationPolicyAction,
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

  const [destinations, policies, csrf] = await Promise.all([
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
    db()
      .select({
        id: notificationPolicies.id,
        destinationName: notificationDestinations.name,
        minSeverity: notificationPolicies.minSeverity,
        minRevenueAtRiskMinor: notificationPolicies.minRevenueAtRiskMinor,
        currency: notificationPolicies.currency,
        digest: notificationPolicies.digest,
        criticalBypassesDigest: notificationPolicies.criticalBypassesDigest,
        enabled: notificationPolicies.enabled,
      })
      .from(notificationPolicies)
      .innerJoin(
        notificationDestinations,
        eq(notificationPolicies.destinationId, notificationDestinations.id),
      )
      .where(eq(notificationPolicies.organizationId, org.organizationId))
      .orderBy(notificationPolicies.createdAt),
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

        <Card
          title="Policies"
          description="A destination only receives notifications once a policy points at it. Policies choose which exceptions matter and how they are batched."
        >
          {policies.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No policies yet — nothing is being notified. Add one below to start receiving
              exception alerts.
            </p>
          ) : (
            <Table caption="Notification policies">
              <thead>
                <tr>
                  <Th>Destination</Th>
                  <Th>Min severity</Th>
                  <Th>Revenue threshold</Th>
                  <Th>Cadence</Th>
                  <Th>Status</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <Td>{policy.destinationName}</Td>
                    <Td className="capitalize">{policy.minSeverity}</Td>
                    <Td>
                      {policy.minRevenueAtRiskMinor !== null && policy.currency
                        ? `≥ ${displayMoney(policy.minRevenueAtRiskMinor, policy.currency)}`
                        : policy.currency
                          ? `${policy.currency} only`
                          : "Any"}
                    </Td>
                    <Td className="capitalize">
                      {policy.digest}
                      {policy.digest !== "immediate" && policy.criticalBypassesDigest && (
                        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                          Critical sends immediately
                        </span>
                      )}
                    </Td>
                    <Td>{policy.enabled ? "Enabled" : "Disabled"}</Td>
                    <Td>
                      {canManage ? (
                        <div className="flex flex-wrap gap-2">
                          <ActionForm
                            action={toggleNotificationPolicyAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ policyId: policy.id, enable: String(!policy.enabled) }}
                            submitLabel={policy.enabled ? "Disable" : "Enable"}
                            pendingLabel="Saving…"
                            size="sm"
                          />
                          <ActionForm
                            action={deleteNotificationPolicyAction}
                            csrf={csrf}
                            organizationId={org.organizationId}
                            fields={{ policyId: policy.id }}
                            submitLabel="Delete"
                            pendingLabel="Deleting…"
                            variant="danger"
                            size="sm"
                            confirm="Delete this policy? Notifications matching only this policy will stop."
                          />
                        </div>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {canManage && destinations.length > 0 && (
          <Card
            title="Add policy"
            description="Pick a destination and the exceptions worth telling it about. The revenue threshold is optional and applies to one currency."
          >
            <ActionForm
              action={createNotificationPolicyAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Add policy"
              pendingLabel="Adding…"
              variant="primary"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Destination" htmlFor="policy-destination">
                  <Select id="policy-destination" name="destinationId" required>
                    {destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>
                        {destination.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Minimum severity"
                  htmlFor="policy-severity"
                  hint="Exceptions below this severity are not sent."
                >
                  <Select id="policy-severity" name="minSeverity" defaultValue="high">
                    {EXCEPTION_SEVERITIES.map((severity) => (
                      <option key={severity} value={severity}>
                        {severity}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Cadence"
                  htmlFor="policy-digest"
                  hint="Immediate sends one message per detection; hourly and daily batch."
                >
                  <Select id="policy-digest" name="digest" defaultValue="hourly">
                    <option value="immediate">Immediate</option>
                    <option value="hourly">Hourly digest</option>
                    <option value="daily">Daily digest</option>
                  </Select>
                </Field>
                <Field
                  label="Currency (optional)"
                  htmlFor="policy-currency"
                  hint="Restricts the policy to one currency; required if a threshold is set."
                >
                  <Input id="policy-currency" name="currency" maxLength={3} placeholder="USD" />
                </Field>
                <Field
                  label="Revenue threshold (optional)"
                  htmlFor="policy-threshold"
                  hint="Only notify when revenue at risk reaches this amount, e.g. 250 or 99.50."
                >
                  <Input
                    id="policy-threshold"
                    name="minRevenueAtRisk"
                    inputMode="decimal"
                    placeholder="250"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="criticalBypassesDigest" defaultChecked />
                Let critical exceptions bypass the digest and send immediately
              </label>
            </ActionForm>
          </Card>
        )}

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
