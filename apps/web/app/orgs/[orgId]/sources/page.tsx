import type { Metadata } from "next";
import { hasPermission } from "@payrecon/domain";
import { PageHeader } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { StubPage } from "@/components/stub-page";
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

  return (
    <StubPage
      title="Sources"
      description="Read-only Stripe connections and their synchronisation status."
      emptyTitle="Stripe connections are not available in this build"
      emptyDescription="This is where you will add a Stripe restricted key, see exactly which resources it can read, and follow each connection's sync history. Until then, you can load the demo dataset from the dashboard to see the reconciliation engine working end to end."
    />
  );
}
