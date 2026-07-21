"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Alert, Button } from "./ui";
import type { ActionState } from "@/server/actions";

/**
 * The single client-side wrapper for every mutating form.
 *
 * It guarantees the two things that are easy to forget per-form:
 *   - the CSRF token and the organization id are always submitted,
 *   - the result is always shown, as a live-announced Alert, rather than the
 *     button appearing to do nothing.
 *
 * The type is imported with `import type` so the server-only module it lives in
 * is erased at compile time and never reaches the browser bundle.
 */

const IDLE: ActionState = { status: "idle" };

export type FormAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

function SubmitButton({
  label,
  pendingLabel,
  variant,
  size,
  confirm,
  disabled,
  disabledReason,
  full,
}: {
  label: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  confirm?: string;
  disabled?: boolean;
  disabledReason?: string;
  full?: boolean;
}) {
  const { pending } = useFormStatus();
  const isDisabled = pending || Boolean(disabled);

  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      disabled={isDisabled}
      // A disabled control must say WHY it is disabled.
      title={disabled ? disabledReason : undefined}
      className={full ? "w-full" : undefined}
      onClick={
        confirm
          ? (event) => {
              // Destructive actions confirm their exact scope before submitting.
              if (!window.confirm(confirm)) event.preventDefault();
            }
          : undefined
      }
    >
      {pending ? (pendingLabel ?? "Working…") : label}
    </Button>
  );
}

export interface ActionFormProps {
  action: FormAction;
  csrf: string;
  /** Omit only for `userAction` forms, which have no organization context. */
  organizationId?: string;
  /** Extra hidden inputs, e.g. the exception id and its expected version. */
  fields?: Record<string, string>;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  /** Native confirm text. Set for anything destructive. */
  confirm?: string;
  disabled?: boolean;
  disabledReason?: string;
  fullWidthSubmit?: boolean;
  /** Rendered above the submit button. */
  children?: ReactNode;
  className?: string;
  /** Shown when the action succeeds without its own message. */
  successMessage?: string;
  /** Re-fetch server data on success. Disable for actions that navigate away. */
  refreshOnSuccess?: boolean;
}

export function ActionForm({
  action,
  csrf,
  organizationId,
  fields,
  submitLabel,
  pendingLabel,
  variant = "secondary",
  size = "md",
  confirm,
  disabled,
  disabledReason,
  fullWidthSubmit,
  children,
  className,
  successMessage,
  refreshOnSuccess = true,
}: ActionFormProps) {
  const [state, formAction] = useActionState(action, IDLE);
  const router = useRouter();

  useEffect(() => {
    if (state.status !== "success") return;
    if (state.redirectTo) {
      router.push(state.redirectTo);
      return;
    }
    // Server components hold the data; refreshing is what makes the change
    // visible without a full page reload.
    if (refreshOnSuccess) router.refresh();
  }, [state, router, refreshOnSuccess]);

  const message = state.status === "success" ? (state.message ?? successMessage) : undefined;

  return (
    <form action={formAction} className={className ?? "space-y-3"}>
      <input type="hidden" name="csrf" value={csrf} />
      {organizationId !== undefined && (
        <input type="hidden" name="organizationId" value={organizationId} />
      )}
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children}

      <SubmitButton
        label={submitLabel}
        pendingLabel={pendingLabel}
        variant={variant}
        size={size}
        confirm={confirm}
        disabled={disabled}
        disabledReason={disabledReason}
        full={fullWidthSubmit}
      />

      {/* `break-words` matters: some success messages carry a one-time invite
          URL, which would otherwise overflow its container. */}
      {state.status === "error" && (
        <Alert tone="error">
          <span className="break-words">{state.message}</span>
        </Alert>
      )}
      {state.status === "success" && message && (
        <Alert tone="success">
          <span className="break-words">{message}</span>
        </Alert>
      )}
    </form>
  );
}
