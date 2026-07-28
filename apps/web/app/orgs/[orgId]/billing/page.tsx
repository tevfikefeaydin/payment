import type { Metadata } from "next";
import { PLANS } from "@payrecon/config";
import { hasPermission } from "@payrecon/domain";
import { isBillingConfigured, getEntitlements } from "@payrecon/platform-billing";
import { ActionForm } from "@/components/action-form";
import { Alert, Card, PageHeader, Select } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { openBillingPortalAction, startCheckoutAction } from "@/server/billing-actions";
import { getCsrfToken } from "@/server/csrf";
import { db } from "@/server/db";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "billing:read")) {
    return (
      <>
        <PageHeader title="Billing" />
        <NotPermitted what="billing" role={org.role} />
      </>
    );
  }

  const [entitlements, csrf] = await Promise.all([
    getEntitlements(db(), org.organizationId),
    getCsrfToken(),
  ]);
  const canManage = hasPermission(org.role, "billing:manage");
  const configured = isBillingConfigured();
  const currentPlan = PLANS[entitlements.planKey];

  return (
    <>
      <PageHeader
        title="Billing"
        description="PayRecon's own subscription. It is entirely separate from the read-only connection used to monitor your payment data."
      />

      <div className="space-y-6">
        {!configured && (
          <Alert tone="info" title="Billing is not configured">
            Checkout and the billing portal require the platform Stripe credentials and plan prices
            to be configured by the operator. Your current free-plan limits remain active.
          </Alert>
        )}

        <Card title="Current plan" description={currentPlan.description}>
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-[var(--color-text-muted)]">Plan</dt>
              <dd className="mt-1 font-medium">{currentPlan.name}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-muted)]">Subscription status</dt>
              <dd className="mt-1 font-medium capitalize">
                {entitlements.status ?? "No subscription"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-muted)]">Period ends</dt>
              <dd className="mt-1 font-medium">
                {entitlements.currentPeriodEnd?.toLocaleDateString() ?? "â€”"}
              </dd>
            </div>
          </dl>
        </Card>

        <Card
          title="Plan limits"
          description="Limits are enforced server-side and never remove existing data."
        >
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-[var(--color-text-muted)]">Monthly records</dt>
              <dd className="mt-1 font-medium">
                {currentPlan.limits.monthlyIngestedRecords?.toLocaleString() ?? "Unlimited"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-muted)]">Stripe connections</dt>
              <dd className="mt-1 font-medium">
                {currentPlan.limits.stripeConnections ?? "Unlimited"}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-muted)]">Team members</dt>
              <dd className="mt-1 font-medium">{currentPlan.limits.members ?? "Unlimited"}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-text-muted)]">Notification destinations</dt>
              <dd className="mt-1 font-medium">
                {currentPlan.limits.notificationDestinations ?? "Unlimited"}
              </dd>
            </div>
          </dl>
        </Card>

        {canManage && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card
              title="Choose a plan"
              description="The price is resolved on the server; your browser never sends a Stripe price or customer id."
            >
              <ActionForm
                action={startCheckoutAction}
                csrf={csrf}
                organizationId={org.organizationId}
                submitLabel="Continue to secure checkout"
                pendingLabel="Opening checkoutâ€¦"
                variant="primary"
                disabled={!configured}
                disabledReason="Billing has not been configured for this deployment."
              >
                <label htmlFor="billing-plan" className="sr-only">
                  Plan
                </label>
                <Select id="billing-plan" name="planKey" defaultValue="starter">
                  {(["starter", "growth", "scale"] as const).map((planKey) => (
                    <option key={planKey} value={planKey}>
                      {PLANS[planKey].name}
                    </option>
                  ))}
                </Select>
              </ActionForm>
            </Card>

            <Card
              title="Manage subscription"
              description="Update payment method, view invoices, or cancel through the secure billing portal."
            >
              <ActionForm
                action={openBillingPortalAction}
                csrf={csrf}
                organizationId={org.organizationId}
                submitLabel="Open billing portal"
                pendingLabel="Opening portalâ€¦"
                disabled={!configured || entitlements.subscribedPlanKey === null}
                disabledReason={
                  !configured
                    ? "Billing has not been configured for this deployment."
                    : "Start a subscription before opening the billing portal."
                }
              />
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
