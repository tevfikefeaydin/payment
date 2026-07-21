import { EmptyState, PageHeader } from "./ui";

/**
 * Shell for a section whose behaviour is not wired up in this build.
 *
 * These are real pages with real navigation and real permission checks, not
 * dead links. They state plainly that the feature is not configured yet rather
 * than showing fabricated data or a control that does nothing.
 */
export function StubPage({
  title,
  description,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState title={emptyTitle} description={emptyDescription} />
    </>
  );
}
