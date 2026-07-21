"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";

/**
 * Error boundary.
 *
 * Shows no stack trace, no error message and no internal identifiers. Next
 * replaces the message with a generic one in production anyway, but relying on
 * that would make development the only place this component is ever correct.
 *
 * `digest` is the one thing worth surfacing: it correlates what the user saw
 * with the server log line, without revealing anything about the failure.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Name only — the message can quote row values or a driver's internals.
    console.error("[ui] render error", { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        This page could not be displayed. The problem has been logged. Trying again often works — if
        it does not, the underlying issue is on our side, not yours.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/app">
          <Button variant="secondary">Back to your workspace</Button>
        </Link>
      </div>

      {error.digest && (
        <p className="mt-6 text-xs text-[var(--color-text-subtle)]">
          Reference: <code className="tabular">{error.digest}</code>
        </p>
      )}
    </div>
  );
}
