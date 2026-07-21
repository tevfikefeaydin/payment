/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * This test IS the boundary check. It reads this package's source off disk and
 * asserts that no file mentions the customer-data integration — the package,
 * its tables, or its Drizzle table exports.
 *
 * Why a filesystem test rather than trusting review: the two Stripe contexts
 * are the single most important invariant in the product, and the cost of
 * getting it wrong is a customer's restricted key or their operational payment
 * data ending up in PayRecon's own billing path. ESLint already forbids the
 * import; this catches the ways around an import — a raw SQL string naming the
 * table, a Drizzle export pulled in through a barrel, a copy-pasted query — and
 * it keeps working if someone edits the ESLint config.
 *
 * NOTE FOR ANYONE EDITING THIS FILE: the forbidden strings are ASSEMBLED FROM
 * FRAGMENTS below, never written out. This file lives in the directory it
 * scans, so a literal here would fail its own check.
 *
 * See docs/adr/0007-stripe-context-separation.md.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * Identifiers that belong exclusively to the customer-data context.
 *
 * Assembled at runtime so this file does not contain them. `label` is only for
 * the failure message; `needle` is what is searched for.
 */
const FORBIDDEN: ReadonlyArray<{ label: string; needle: string }> = [
  { label: "the customer-data package", needle: ["stripe", "customer", "data"].join("-") },
  { label: "the customer connections table", needle: ["stripe", "connections"].join("_") },
  { label: "the connections Drizzle export", needle: `stripe${"Connections"}` },
  { label: "the credentials Drizzle export", needle: `stripe${"Credentials"}` },
  { label: "the provider payments table", needle: ["provider", "payments"].join("_") },
];

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

const sourceFiles = listSourceFiles(SRC_DIR);

describe("Stripe context separation", () => {
  it("finds the package source to scan", () => {
    // Guards against the scan silently passing because it found nothing.
    expect(sourceFiles.length).toBeGreaterThan(8);
    expect(sourceFiles.some((file) => file.endsWith("webhooks.ts"))).toBe(true);
    expect(sourceFiles.some((file) => file.endsWith("entitlements.ts"))).toBe(true);
  });

  it.each(FORBIDDEN)("no source file mentions $label", ({ needle }) => {
    const offenders = sourceFiles.filter((file) => readFileSync(file, "utf8").includes(needle));

    expect(offenders).toEqual([]);
  });

  it("declares no dependency on the customer-data package", () => {
    const manifest = readFileSync(PACKAGE_JSON, "utf8");
    for (const { needle } of FORBIDDEN) {
      expect(manifest).not.toContain(needle);
    }
  });

  it("reads only PayRecon's own Stripe environment variables", () => {
    // The other context's credentials are per-connection and encrypted at rest,
    // never environment variables — but a global Stripe key would be the
    // obvious way to blur the line, so it is checked for by name. Assembled
    // from fragments for the same reason as FORBIDDEN above: this file is one
    // of the files it scans.
    const forbiddenVars = [
      ["STRIPE", "SECRET", "KEY"].join("_"),
      ["STRIPE", "API", "KEY"].join("_"),
      ["STRIPE", "RESTRICTED", "KEY"].join("_"),
    ];

    for (const file of sourceFiles) {
      const contents = readFileSync(file, "utf8");
      for (const variable of forbiddenVars) {
        // Every legitimate mention is prefixed `PLATFORM_`.
        const bare = new RegExp(`(?<!PLATFORM_)\\b${variable}\\b`);
        expect(bare.test(contents), `${file} references a non-platform ${variable}`).toBe(false);
      }
    }
  });
});
