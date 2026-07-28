import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { loadEnv } from "@payrecon/config/env";
import { AuthShell } from "@/components/auth-shell";
import { SignUpForm } from "@/components/auth-forms";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Create an account" };

// Reads the session cookie to bounce an already-signed-in visitor.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  // In invite-only mode the form stays available — invited people create their
  // account here — but visitors are told up front what to expect.
  const inviteOnly = !loadEnv().ALLOW_PUBLIC_SIGNUP;

  return (
    <AuthShell
      title="Create an account"
      description={
        inviteOnly
          ? "Sign-ups are currently invite-only. If you received an invitation, create your account with the email address it was sent to."
          : "You will get an organization to work in straight away. You can load demo data before connecting anything of your own."
      }
      footer={
        <>
          Already have an account?{" "}
          <Link href="/sign-in" className="underline">
            Sign in
          </Link>
          .
        </>
      }
    >
      <SignUpForm />
    </AuthShell>
  );
}
