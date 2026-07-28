import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { PasswordResetRequestForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset password"
      description="Enter your email and we will send a one-time password reset link if an account matches it."
      footer={
        <Link href="/sign-in" className="underline">
          Back to sign in
        </Link>
      }
    >
      <PasswordResetRequestForm />
    </AuthShell>
  );
}
