"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { signInAction, signUpAction } from "@/server/auth-actions";
import {
  requestPasswordResetAction,
  resetPasswordAction,
  verifyEmailAction,
} from "@/server/account-token-actions";
import type { ActionState } from "@/server/actions";
import { Alert, Button, Field, Input } from "./ui";

/**
 * Authentication forms.
 *
 * The server actions deliberately return coarse error codes rather than
 * per-field detail (sign-in must not reveal whether an account exists), so the
 * mapping from code to field lives here, in presentation, where being wrong is
 * a cosmetic problem rather than an information leak.
 */

const IDLE: ActionState = { status: "idle" };

/** Which input, if any, an error code should be attached to. */
const FIELD_FOR_CODE: Record<string, string> = {
  invalid_email: "email",
  email_unavailable: "email",
  invalid_password: "password",
  weak_password: "password",
  invalid_name: "name",
  invalid_organization: "organizationName",
};

function fieldError(state: ActionState, field: string): string | undefined {
  if (state.status !== "error") return undefined;
  if (state.fieldErrors?.[field]) return state.fieldErrors[field];
  if (state.code && FIELD_FOR_CODE[state.code] === field) return state.message;
  return undefined;
}

/** True when the error belongs to no specific field and needs the summary Alert. */
function generalError(state: ActionState): string | undefined {
  if (state.status !== "error") return undefined;
  if (state.code && FIELD_FOR_CODE[state.code]) return undefined;
  return state.message;
}

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending} className="w-full">
      {pending ? pendingLabel : label}
    </Button>
  );
}

/** Navigate once the action reports success with a destination. */
function useRedirectOnSuccess(state: ActionState): void {
  const router = useRouter();
  useEffect(() => {
    if (state.status === "success" && state.redirectTo) router.push(state.redirectTo);
  }, [state, router]);
}

export function SignInForm() {
  const [state, formAction] = useActionState(signInAction, IDLE);
  useRedirectOnSuccess(state);

  const summary = generalError(state);

  return (
    <form action={formAction} className="space-y-4">
      {summary && <Alert tone="error">{summary}</Alert>}

      <Field label="Email" htmlFor="email" error={fieldError(state, "email")}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          invalid={Boolean(fieldError(state, "email"))}
        />
      </Field>

      <Field label="Password" htmlFor="password" error={fieldError(state, "password")}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          invalid={Boolean(fieldError(state, "password"))}
        />
      </Field>

      <Submit label="Sign in" pendingLabel="Signing in…" />

      {state.status === "success" && (
        <Alert tone="success">Signed in. Taking you to your workspace…</Alert>
      )}
    </form>
  );
}

export function SignUpForm() {
  const [state, formAction] = useActionState(signUpAction, IDLE);
  useRedirectOnSuccess(state);

  const summary = generalError(state);

  return (
    <form action={formAction} className="space-y-4">
      {summary && <Alert tone="error">{summary}</Alert>}

      <Field label="Your name" htmlFor="name" error={fieldError(state, "name")}>
        <Input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          autoFocus
          maxLength={100}
          invalid={Boolean(fieldError(state, "name"))}
        />
      </Field>

      <Field label="Work email" htmlFor="email" error={fieldError(state, "email")}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          invalid={Boolean(fieldError(state, "email"))}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        hint="At least 12 characters. Longer passphrases are stronger than complex short ones."
        error={fieldError(state, "password")}
      >
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          invalid={Boolean(fieldError(state, "password"))}
        />
      </Field>

      <Field
        label="Organization name"
        htmlFor="organizationName"
        hint="Optional. Leave blank and we will create a personal workspace you can rename later."
        error={fieldError(state, "organizationName")}
      >
        <Input
          id="organizationName"
          name="organizationName"
          type="text"
          maxLength={100}
          invalid={Boolean(fieldError(state, "organizationName"))}
        />
      </Field>

      <Submit label="Create account" pendingLabel="Creating your account…" />

      {state.status === "success" && (
        <Alert tone="success">Account created. Taking you to your workspace…</Alert>
      )}
    </form>
  );
}

export function PasswordResetRequestForm() {
  const [state, formAction] = useActionState(requestPasswordResetAction, IDLE);
  return (
    <form action={formAction} className="space-y-4">
      {generalError(state) && <Alert tone="error">{generalError(state)}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Submit label="Send reset link" pendingLabel="Sending…" />
      {state.status === "success" && <Alert tone="success">{state.message}</Alert>}
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(resetPasswordAction, IDLE);
  useRedirectOnSuccess(state);
  return (
    <form action={formAction} className="space-y-4">
      {generalError(state) && <Alert tone="error">{generalError(state)}</Alert>}
      <input type="hidden" name="token" value={token} />
      <Field label="New password" htmlFor="password" hint="At least 12 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Submit label="Reset password" pendingLabel="Resetting…" />
      {state.status === "success" && <Alert tone="success">{state.message}</Alert>}
    </form>
  );
}

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(verifyEmailAction, IDLE);
  useRedirectOnSuccess(state);
  return (
    <form action={formAction} className="space-y-4">
      {generalError(state) && <Alert tone="error">{generalError(state)}</Alert>}
      <input type="hidden" name="token" value={token} />
      <Submit label="Verify email" pendingLabel="Verifying…" />
      {state.status === "success" && <Alert tone="success">{state.message}</Alert>}
    </form>
  );
}
