import type { Metadata } from "next";
import { hasPermission } from "@payrecon/domain";
import { PageHeader } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { StubPage } from "@/components/stub-page";
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

  return (
    <StubPage
      title="API keys"
      description="Organization-scoped keys for pushing payment records into PayRecon."
      emptyTitle="API keys are not available in this build"
      emptyDescription="This is where you will mint a key (shown once, stored only as a hash), see when each was last used, and revoke one immediately. Keys are scoped to this organization and cannot read any other tenant's data."
    />
  );
}
