import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product's single most important safety guarantee:
 *
 *   "No code path writes to a connected customer's Stripe account."
 *
 * A code review can confirm that today. This test confirms it on every commit,
 * for everyone, forever. It reads the package's own source from disk and fails
 * if a write-capable Stripe call, or a Stripe HTTP verb other than GET, ever
 * appears.
 *
 * If a future change legitimately needs a new Stripe READ, it will pass. If it
 * introduces a write, this fails loudly and the reviewer has to justify it.
 */

const SOURCE_DIR = __dirname;

function sourceFiles(): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"));
}

/** Stripe SDK methods that mutate the connected account. */
const FORBIDDEN_CALL =
  /\bstripe\s*\.\s*[a-zA-Z]+\s*\.\s*(create|update|del|cancel|capture|confirm|expire|finalizeInvoice|pay|send|void|reverse|release|resume|retrieveUpcoming)\b/;

/** Any explicit non-GET HTTP verb aimed at Stripe. */
const FORBIDDEN_VERB = /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i;

/** Raw request helpers that could smuggle a write past the checks above. */
const FORBIDDEN_RAW = /\bstripe\s*\.\s*(rawRequest|_request)\b/;

describe("customer Stripe integration is strictly read-only", () => {
  it("contains no write-capable Stripe SDK call", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const contents = readFileSync(join(SOURCE_DIR, file), "utf8");
      contents.split(/\r?\n/).forEach((line, index) => {
        // Skip comment lines: the files deliberately DESCRIBE the forbidden
        // verbs in their header comments to explain the guarantee.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;

        if (FORBIDDEN_CALL.test(line) || FORBIDDEN_RAW.test(line)) {
          offenders.push(`${file}:${index + 1}: ${trimmed}`);
        }
      });
    }

    expect(offenders, `Write-capable Stripe calls found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("issues no non-GET HTTP request to Stripe", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const contents = readFileSync(join(SOURCE_DIR, file), "utf8");
      contents.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        if (FORBIDDEN_VERB.test(line)) offenders.push(`${file}:${index + 1}: ${trimmed}`);
      });
    }

    expect(offenders, `Non-GET Stripe requests found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("never imports the platform billing context", () => {
    // The two Stripe contexts must stay separate. ESLint enforces this too; the
    // test makes the invariant visible in the suite rather than only in CI lint.
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const contents = readFileSync(join(SOURCE_DIR, file), "utf8");
      if (/from\s+["'`]@payrecon\/platform-billing/.test(contents)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
