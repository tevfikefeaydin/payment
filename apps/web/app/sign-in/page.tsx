import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { SignInForm } from "@/components/auth-forms";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Sign in" };

// Reads the session cookie to bounce an already-signed-in visitor.
export const dynamic = "force-dynamic";

export default async function SignInPage() {
  // Someone already signed in has no use for this screen.
  if (await getCurrentUser()) redirect("/app");

  return (
    <AuthShell
      title="Sign in"
      description="Continue to your exception inbox."
      footer={
        <>
          No account yet?{" "}
          <Link href="/sign-up" className="underline">
            Create one
          </Link>
          .
        </>
      }
    >
      <SignInForm />
    </AuthShell>
  );
}
