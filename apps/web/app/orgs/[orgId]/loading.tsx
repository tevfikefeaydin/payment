/**
 * Loading state for every page inside an organization.
 *
 * Rendered by Next while the server component's data is still being fetched, so
 * navigation never leaves the user staring at the previous page wondering
 * whether their click registered.
 *
 * The skeleton is hidden from assistive technology and replaced by a single
 * polite status message: announcing a dozen empty boxes is noise, "Loading" is
 * information.
 */
export default function Loading() {
  return (
    <div>
      <p role="status" className="sr-only">
        Loading…
      </p>

      <div aria-hidden="true" className="animate-pulse space-y-6">
        <div className="space-y-2">
          <div className="h-6 w-64 rounded bg-[var(--color-surface-sunken)]" />
          <div className="h-4 w-96 max-w-full rounded bg-[var(--color-surface-sunken)]" />
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)]"
            />
          ))}
        </div>

        <div className="h-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-sunken)]" />
      </div>
    </div>
  );
}
