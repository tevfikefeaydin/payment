import Link from "next/link";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { VerifyEmailForm } from "@/components/auth-forms";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell
      title="Verify email"
      description="Confirm that this email address belongs to you."
      footer={
        <Link href="/sign-in" className="underline">
          Back to sign in
        </Link>
      }
    >
      <VerifyEmailForm token={token} />
    </AuthShell>
  );
}
