import type { Metadata } from "next";
import { hasPermission } from "@payrecon/domain";
import { PageHeader } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { StubPage } from "@/components/stub-page";
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

  return (
    <StubPage
      title="Billing"
      description="PayRecon's own subscription. Entirely separate from the read-only Stripe connection used to monitor your payments."
      emptyTitle="Subscription management is not available in this build"
      emptyDescription="This is where you will see the current plan, metered usage for the period, and invoices. Your current plan and limits are already visible, read-only, under Settings."
    />
  );
}
