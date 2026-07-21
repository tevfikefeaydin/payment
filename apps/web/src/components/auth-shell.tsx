import Link from "next/link";
import type { ReactNode } from "react";
import { PRODUCT } from "@payrecon/config";

/**
 * Shared chrome for the sign-in and sign-up screens, so the two pages cannot
 * drift apart visually. Server-rendered: only the form inside is a client
 * component.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}) {
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
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-[var(--color-text-muted)]">{description}</p>

        {children}

        <p className="mt-6 text-sm text-[var(--color-text-muted)]">{footer}</p>
      </main>
    </div>
  );
}
