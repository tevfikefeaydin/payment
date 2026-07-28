import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

/**
 * Shared UI primitives.
 *
 * Accessibility rules that are enforced here rather than left to each caller:
 *   - status is never conveyed by colour alone; every badge carries a text label,
 *   - every input is paired with a real <label> tied by id,
 *   - validation messages are wired via aria-describedby and aria-invalid,
 *   - disabled controls state WHY they are disabled through `title`.
 */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent-strong)] text-white hover:bg-[var(--color-accent-strong-hover)] border-transparent",
  secondary:
    "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-raised)] border-[var(--color-border-strong)]",
  ghost:
    "bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] border-transparent",
  danger: "bg-[var(--color-critical)] text-white hover:opacity-90 border-transparent",
};

/**
 * Button styling as a bare class string, for elements that must remain links.
 *
 * A `<Link>` wrapped around a `<Button>` is nested interactive content: it is
 * invalid HTML, assistive technology announces a button inside a link, and the
 * link's accessible name becomes unreliable. Anything that navigates should be
 * an anchor that LOOKS like a button — which is what this is for.
 */
export function buttonClassName(
  variant: ButtonVariant = "secondary",
  size: "sm" | "md" = "md",
): string {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-md border font-medium",
    "transition-colors no-underline",
    size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
    BUTTON_STYLES[variant],
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        BUTTON_STYLES[variant],
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)]",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badges — colour PLUS text, never colour alone
// ---------------------------------------------------------------------------

/**
 * Severity pills follow the design's violet scale: critical is the only filled
 * violet pill, high is outlined violet, medium and low step down to grey. The
 * ranking reads at a glance while the text label keeps it unambiguous.
 */
const SEVERITY_STYLES: Record<string, string> = {
  critical: "border-transparent bg-[var(--color-accent-strong)] text-white",
  high: "border-[var(--color-accent)] bg-transparent text-[var(--color-accent)]",
  medium: "border-transparent bg-[var(--color-low-bg)] text-[var(--color-text)]",
  low: "border-[var(--color-border-strong)] bg-transparent text-[var(--color-text-muted)]",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
        SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.low,
      )}
    >
      {severity}
    </span>
  );
}

const STATE_LABELS: Record<string, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  reopened: "Reopened",
};

export function StateBadge({ state }: { state: string }) {
  const resolved = state === "resolved";
  return (
    <span
      className={cx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
        resolved
          ? "border-[var(--color-success)] bg-[var(--color-success-bg)] text-[var(--color-success)]"
          : "border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]",
      )}
    >
      {STATE_LABELS[state] ?? state}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "error" | "success" | "warning";
  title?: string;
  children?: ReactNode;
}) {
  const styles: Record<string, string> = {
    info: "border-[var(--color-border-strong)] bg-[var(--color-surface-raised)]",
    error:
      "border-[var(--color-critical)] bg-[var(--color-critical-bg)] text-[var(--color-critical)]",
    success:
      "border-[var(--color-success)] bg-[var(--color-success-bg)] text-[var(--color-success)]",
    warning: "border-[var(--color-high)] bg-[var(--color-high-bg)] text-[var(--color-high)]",
  };
  return (
    <div
      // Errors must be announced to screen readers as they appear.
      role={tone === "error" ? "alert" : "status"}
      className={cx("rounded-md border px-3 py-2 text-sm", styles[tone])}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={title ? "mt-0.5" : undefined}>{children}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border-strong)] px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-sm text-[var(--color-text-muted)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-xs text-[var(--color-text-muted)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="text-xs text-[var(--color-critical)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input({
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      aria-describedby={
        invalid && props.id ? `${props.id}-error` : props.id ? `${props.id}-hint` : undefined
      }
      className={cx(
        "w-full rounded-md border bg-[var(--color-surface)] px-3 py-2 text-sm",
        "placeholder:text-[var(--color-text-subtle)] disabled:opacity-60",
        invalid ? "border-[var(--color-critical)]" : "border-[var(--color-border-strong)]",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)]",
        "px-3 py-2 text-sm disabled:opacity-60",
        className,
      )}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  numeric,
  scope = "col",
}: {
  children: ReactNode;
  numeric?: boolean;
  scope?: "col" | "row";
}) {
  return (
    <th
      scope={scope}
      className={cx(
        "border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium uppercase tracking-wide",
        "text-[var(--color-text-muted)]",
        numeric ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  numeric,
  className,
}: {
  children: ReactNode;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cx(
        "border-b border-[var(--color-border)] px-3 py-2 align-top",
        numeric && "tabular text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Monospace treatment for provider/internal identifiers. */
export function Identifier({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-[var(--color-text-subtle)]">—</span>;
  return <code className="tabular text-xs">{value}</code>;
}
