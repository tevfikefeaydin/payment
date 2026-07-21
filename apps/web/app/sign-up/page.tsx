import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { SignUpForm } from "@/components/auth-forms";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "Create an account" };

// Reads the session cookie to bounce an already-signed-in visitor.
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/app");

  return (
    <AuthShell
      title="Create an account"
      description="You will get an organization to work in straight away. You can load demo data before connecting anything of your own."
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
