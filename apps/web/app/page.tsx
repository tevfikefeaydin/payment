import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT } from "@payrecon/config";
import { RECONCILIATION_RULE_IDS } from "@payrecon/domain";
import { displayRuleName } from "@/lib/format";
import { buttonClassName } from "@/components/ui";

export const metadata: Metadata = {
  title: `${PRODUCT.name} — ${PRODUCT.tagline}`,
  description: PRODUCT.shortDescription,
};

/**
 * Marketing page.
 *
 * Deliberately contains no testimonials, no customer counts, no "limited time"
 * framing and no claims the product cannot support. Everything stated here is
 * something the code actually does; the ten checks are read from the same
 * constant the reconciliation engine uses, so this page cannot drift out of
 * sync with the engine.
 */

const RULE_DESCRIPTIONS: Record<string, string> = {
  PAYMENT_SUCCEEDED_INTERNAL_MISSING:
    "Stripe captured a payment your application has no record of at all.",
  PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID:
    "Stripe reports a successful payment while your own record still says pending or failed.",
  INTERNAL_PAID_PROVIDER_MISSING:
    "Your application marked an order as paid, but no matching successful payment exists in Stripe.",
  PAYMENT_AMOUNT_MISMATCH:
    "The amount Stripe captured differs from the amount your application recorded.",
  PAYMENT_CURRENCY_MISMATCH: "The two sides of the same payment disagree about the currency.",
  DUPLICATE_SUCCEEDED_PAYMENT:
    "One customer was charged more than once for what looks like a single purchase.",
  REFUND_STATUS_MISMATCH: "A refund exists on one side only, or the refunded amounts disagree.",
  PAID_INVOICE_INACTIVE_SUBSCRIPTION:
    "An invoice was paid against a subscription that is cancelled, unpaid or expired.",
  FAILED_INVOICE_ACTIVE_SUBSCRIPTION:
    "A subscription is still serving the customer while its invoices are failing.",
  STALE_INTERNAL_PENDING_PAYMENT:
    "A payment has been stuck in a pending state far longer than it should take to settle.",
};

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Connect Stripe, read-only",
    body: "Paste a Stripe restricted key with read permissions. We validate what it can actually read and store it encrypted.",
  },
  {
    title: "Bring your own records",
    body: "Upload a CSV of your payment records or push them through the API. Re-importing the same file changes nothing — imports are idempotent.",
  },
  {
    title: "Deterministic rules run",
    body: "Versioned TypeScript rules compare both sides on a schedule. No model guesses at whether two payments are the same.",
  },
  {
    title: "Work the exception inbox",
    body: "Each finding carries side-by-side evidence, probable causes, recommended next steps, and a full audit timeline.",
  },
];

export default function MarketingPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--color-border)]">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4"
        >
          <span className="text-sm font-semibold tracking-tight">{PRODUCT.name}</span>
          <div className="flex items-center gap-2">
            <Link href="/sign-in" className={buttonClassName("ghost", "sm")}>
              Sign in
            </Link>

            <Link href="/sign-up" className={buttonClassName("primary", "sm")}>
              Create an account
            </Link>
          </div>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-6 pb-24">
        {/* Hero */}
        <section className="border-b border-[var(--color-border)] py-16 sm:py-24">
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
            {PRODUCT.tagline}
          </h1>
          <p className="mt-4 max-w-2xl text-base text-[var(--color-text-muted)]">
            {PRODUCT.description}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/sign-up" className={buttonClassName("primary")}>
              Create an account
            </Link>

            <Link href="/sign-in" className={buttonClassName("secondary")}>
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
            You can load a built-in demo dataset after signing up, so you can see real findings
            before connecting anything of your own.
          </p>
        </section>

        {/* Read-only posture */}
        <section aria-labelledby="posture" className="border-b border-[var(--color-border)] py-12">
          <h2 id="posture" className="text-lg font-semibold tracking-tight">
            We never write to your Stripe account
          </h2>
          <div className="mt-4 grid gap-6 sm:grid-cols-3">
            <div>
              <h3 className="text-sm font-medium">Read-only by construction</h3>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                {PRODUCT.name} connects using a Stripe restricted key. No code path in the product
                issues a refund, creates a charge, cancels a subscription, or modifies any Stripe
                object.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-medium">We store less than you might expect</h3>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Only the fields needed for matching and evidence are kept — amounts, statuses,
                identifiers and timestamps. No card details, no billing addresses, no raw payloads.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-medium">Findings are explanations, not actions</h3>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                An exception tells you what disagrees and what to check. Fixing it stays in your
                hands, in your systems.
              </p>
            </div>
          </div>
        </section>

        {/* The ten checks */}
        <section aria-labelledby="checks" className="border-b border-[var(--color-border)] py-12">
          <h2 id="checks" className="text-lg font-semibold tracking-tight">
            The ten checks
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-text-muted)]">
            Each check is a deterministic, versioned rule with a documented trigger condition,
            tolerance window and revenue-at-risk calculation. The same rules run against demo data
            and production data — there is no separate demo path.
          </p>
          <ol className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {RECONCILIATION_RULE_IDS.map((ruleId, index) => (
              <li key={ruleId} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="tabular mt-0.5 text-xs text-[var(--color-text-subtle)]"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-sm font-medium">{displayRuleName(ruleId)}</h3>
                  <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                    {RULE_DESCRIPTIONS[ruleId] ?? "Documented in the reconciliation rules."}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* How it works */}
        <section aria-labelledby="how" className="border-b border-[var(--color-border)] py-12">
          <h2 id="how" className="text-lg font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span
                  aria-hidden="true"
                  className="tabular text-xs text-[var(--color-text-subtle)]"
                >
                  Step {index + 1}
                </span>
                <h3 className="mt-1 text-sm font-medium">{step.title}</h3>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Honest constraints */}
        <section aria-labelledby="limits" className="py-12">
          <h2 id="limits" className="text-lg font-semibold tracking-tight">
            What it does not do
          </h2>
          <ul className="mt-4 max-w-2xl list-disc space-y-2 pl-5 text-sm text-[var(--color-text-muted)]">
            <li>
              It does not convert between currencies. Revenue at risk is reported per currency, as
              separate figures, because summing unlike currencies without a sourced rate would be
              misleading.
            </li>
            <li>
              It does not close findings on your behalf. An exception that stops being detected
              stays open until someone decides it is resolved, and that decision is recorded.
            </li>
            <li>
              It does not use a language model to decide whether two payments match. Matching
              favours explicit provider transaction identifiers, and ambiguous data is surfaced as
              ambiguous rather than guessed at.
            </li>
          </ul>
        </section>
      </main>

      <footer className="border-t border-[var(--color-border)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-[var(--color-text-muted)]">
          <span>
            {PRODUCT.legalName} — {PRODUCT.shortDescription}
          </span>
          <a className="underline" href={`mailto:${PRODUCT.supportEmail}`}>
            {PRODUCT.supportEmail}
          </a>
        </div>
      </footer>
    </div>
  );
}
