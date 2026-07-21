import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getOrganization, listMembers } from "@payrecon/db";
import {
  DEFAULT_PLAN,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  getPlan,
  isPlanKey,
} from "@payrecon/config";
import { hasPermission } from "@payrecon/domain";
import { Alert, Card, Field, Identifier, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { NotPermitted } from "@/components/forbidden";
import { displayDateTime } from "@/lib/format";
import { db } from "@/server/db";
import { getCsrfToken } from "@/server/csrf";
import { getDataPresence } from "@/server/queries";
import { requireOrg } from "@/server/session";
import { updateSettingsAction } from "@/server/org-actions";

export const metadata: Metadata = { title: "Settings" };

/** Render a plan limit, where `null` means the plan does not cap it. */
function limitText(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString();
}

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "settings:read")) {
    return (
      <>
        <PageHeader title="Settings" />
        <NotPermitted what="organization settings" role={org.role} />
      </>
    );
  }

  const organization = await getOrganization(db(), org.organizationId);
  // Membership was already proven, so a missing row here means the organization
  // was deleted between the two reads.
  if (!organization) notFound();

  const canManage = hasPermission(org.role, "settings:manage");
  const [members, presence, csrf] = await Promise.all([
    listMembers(db(), org.organizationId),
    getDataPresence(org.organizationId),
    getCsrfToken(),
  ]);

  const plan = getPlan(isPlanKey(organization.planKey) ? organization.planKey : DEFAULT_PLAN);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization identity and data retention. Plan and usage are shown read-only."
      />

      <div className="space-y-6">
        <Card
          title="Organization"
          description={
            canManage
              ? "Changing these values is audited."
              : `Your role (${org.role}) can view these settings but not change them.`
          }
        >
          {canManage ? (
            <ActionForm
              action={updateSettingsAction}
              csrf={csrf}
              organizationId={org.organizationId}
              submitLabel="Save settings"
              pendingLabel="Saving…"
              variant="primary"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Organization name"
                  htmlFor="org-name"
                  hint="Between 2 and 100 characters."
                >
                  <Input
                    id="org-name"
                    name="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={100}
                    defaultValue={organization.name}
                  />
                </Field>

                <Field
                  label="Retention (days)"
                  htmlFor="org-retention"
                  hint={`Between ${RETENTION_MIN_DAYS} and ${RETENTION_MAX_DAYS}. Your plan (${plan.name}) is intended for up to ${plan.limits.maxRetentionDays} days.`}
                >
                  <Input
                    id="org-retention"
                    name="retentionDays"
                    type="number"
                    required
                    min={RETENTION_MIN_DAYS}
                    max={RETENTION_MAX_DAYS}
                    step={1}
                    defaultValue={organization.retentionDays}
                  />
                </Field>
              </div>

              <Alert tone="warning" title="Lowering retention deletes data">
                <p>
                  Imported source data older than the retention window is removed by the daily
                  cleanup job. Exceptions and audit events are kept — only the raw ingested source
                  rows they were derived from age out.
                </p>
              </Alert>
            </ActionForm>
          ) : (
            <dl className="grid gap-4 sm:grid-cols-2 text-sm">
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">Name</dt>
                <dd>{organization.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--color-text-muted)]">Retention</dt>
                <dd className="tabular">{organization.retentionDays} days</dd>
              </div>
            </dl>
          )}
        </Card>

        <Card
          title="Plan"
          description="Read-only here. Subscriptions are managed on the Billing page."
        >
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="text-lg font-semibold">{plan.name}</p>
            <p className="text-sm text-[var(--color-text-muted)]">{plan.description}</p>
          </div>

          <Table caption="Plan limits and current usage">
            <thead>
              <tr>
                <Th>Limit</Th>
                <Th numeric>Plan allows</Th>
                <Th numeric>Currently</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>Members</Td>
                <Td numeric>{limitText(plan.limits.members)}</Td>
                <Td numeric>{members.length}</Td>
              </tr>
              <tr>
                <Td>Stripe connections</Td>
                <Td numeric>{limitText(plan.limits.stripeConnections)}</Td>
                <Td numeric>{presence.connections}</Td>
              </tr>
              <tr>
                <Td>Internal payment records stored</Td>
                <Td numeric>
                  <span className="text-[var(--color-text-muted)]">
                    {limitText(plan.limits.monthlyIngestedRecords)} ingested / month
                  </span>
                </Td>
                <Td numeric>{presence.internalRecords.toLocaleString()}</Td>
              </tr>
              <tr>
                <Td>Notification destinations</Td>
                <Td numeric>{limitText(plan.limits.notificationDestinations)}</Td>
                <Td numeric>
                  <span className="text-[var(--color-text-muted)]">see Notifications</span>
                </Td>
              </tr>
              <tr>
                <Td>Retention</Td>
                <Td numeric>{plan.limits.maxRetentionDays} days</Td>
                <Td numeric>{organization.retentionDays} days</Td>
              </tr>
            </tbody>
          </Table>

          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            Monthly ingestion is metered by the ingestion pipeline; the figure above is the number
            of records currently stored, which is not the same thing.{" "}
            <Link href={`/orgs/${org.organizationId}/billing`} className="underline">
              Billing
            </Link>
          </p>
        </Card>

        <Card title="About this organization">
          <dl className="grid gap-4 sm:grid-cols-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">Identifier</dt>
              <dd>
                <Identifier value={organization.id} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">Slug</dt>
              <dd>
                <Identifier value={organization.slug} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">Created</dt>
              <dd>{displayDateTime(organization.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-[var(--color-text-muted)]">Demo data</dt>
              <dd>{organization.isDemo ? "Yes" : "No"}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
