import Link from "next/link";
import { PRODUCT } from "@payrecon/config";
import { Button } from "@/components/ui";

/**
 * 404 page.
 *
 * Says nothing about why the page was not found. The same response is returned
 * for a genuinely missing page and for a resource belonging to another
 * organization, so an outsider cannot use it to discover that an id exists.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <div className="mx-auto max-w-5xl px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            {PRODUCT.name}
          </Link>
        </div>
      </header>

      <main
        id="main"
        className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-12"
      >
        <p className="text-sm font-medium text-[var(--color-text-muted)]">404</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">We could not find that page</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          The link may be out of date, or the page may belong to an organization you are not a
          member of.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/app">
            <Button variant="primary">Go to your workspace</Button>
          </Link>
          <Link href="/">
            <Button variant="secondary">Home</Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
