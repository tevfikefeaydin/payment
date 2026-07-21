import type { Metadata } from "next";
import { hasPermission } from "@payrecon/domain";
import { PageHeader } from "@/components/ui";
import { NotPermitted } from "@/components/forbidden";
import { StubPage } from "@/components/stub-page";
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

  return (
    <StubPage
      title="Notifications"
      description="Where new exceptions are announced, and which ones are worth interrupting someone for."
      emptyTitle="Notification routing is not available in this build"
      emptyDescription="This is where you will add email and Slack destinations, send a test message before a destination goes live, and set severity and value thresholds so a batch of low-severity findings does not page anyone at 3am."
    />
  );
}
