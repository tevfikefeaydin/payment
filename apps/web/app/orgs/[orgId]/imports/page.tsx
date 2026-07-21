import type { Metadata } from "next";
import { hasPermission } from "@payrecon/domain";
import { PageHeader } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { StubPage } from "@/components/stub-page";
import { requireOrg } from "@/server/session";

export const metadata: Metadata = { title: "Imports" };

export default async function ImportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await requireOrg(orgId);

  if (!hasPermission(org.role, "imports:read")) {
    return (
      <>
        <PageHeader title="Imports" />
        <NotPermitted what="data imports" role={org.role} />
      </>
    );
  }

  return (
    <StubPage
      title="Imports"
      description="CSV uploads of your internal payment records, and the column mapping used for each."
      emptyTitle="Importing is not available in this build"
      emptyDescription="This is where you will upload a CSV, map its columns to the canonical payment record, review rejected rows with their exact reasons, and re-import safely — imports are keyed on your own external id, so replaying a file updates rows rather than duplicating them."
    />
  );
}
