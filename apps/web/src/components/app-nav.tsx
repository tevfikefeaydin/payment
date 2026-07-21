"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary organization navigation.
 *
 * A client component purely so the current route can be marked with
 * `aria-current="page"` — screen reader users otherwise have no way to tell
 * which section they are in, since highlight styling alone is not announced.
 *
 * Which items appear is decided on the SERVER from the user's role. This
 * component renders what it is given; it makes no authorization decision.
 */

export interface NavItem {
  href: string;
  label: string;
  /** Dashboard matches its path exactly; sections also match their children. */
  exact?: boolean;
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Organization sections">
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "block rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-[var(--color-accent-subtle)] font-medium text-[var(--color-accent)]"
                    : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]",
                ].join(" ")}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
