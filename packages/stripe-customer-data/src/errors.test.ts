import { describe, expect, it } from "vitest";
import {
  StripeSyncError,
  classifyStripeError,
  describeCategory,
  isRetryableCategory,
  sanitizeMessage,
} from "./errors";

/** Shape of a stripe-node error, without depending on the SDK in a unit test. */
function stripeError(options: {
  type?: string;
  statusCode?: number;
  code?: string;
  message?: string;
}): Error & { type?: string; statusCode?: number; code?: string } {
  const error = new Error(options.message ?? "Stripe failed") as Error & {
    type?: string;
    statusCode?: number;
    code?: string;
  };
  if (options.type) error.type = options.type;
  if (options.statusCode) error.statusCode = options.statusCode;
  if (options.code) error.code = options.code;
  return error;
}

describe("classifyStripeError", () => {
  it("maps HTTP status codes to categories", () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [403, "permission"],
      [429, "rate_limited"],
      [408, "transient"],
      [409, "transient"],
      [500, "transient"],
      [502, "transient"],
      [503, "transient"],
      [400, "permanent"],
      [404, "permanent"],
      [422, "permanent"],
    ];
    for (const [status, expected] of cases) {
      expect(classifyStripeError(stripeError({ statusCode: status })).category).toBe(expected);
    }
  });

  it("falls back to the SDK error class when no status is present", () => {
    expect(classifyStripeError(stripeError({ type: "StripeRateLimitError" })).category).toBe(
      "rate_limited",
    );
    expect(classifyStripeError(stripeError({ type: "StripeConnectionError" })).category).toBe(
      "transient",
    );
    expect(classifyStripeError(stripeError({ type: "StripeAPIError" })).category).toBe("transient");
    expect(classifyStripeError(stripeError({ type: "StripeAuthenticationError" })).category).toBe(
      "auth",
    );
    expect(classifyStripeError(stripeError({ type: "StripePermissionError" })).category).toBe(
      "permission",
    );
    expect(classifyStripeError(stripeError({ type: "StripeInvalidRequestError" })).category).toBe(
      "permanent",
    );
  });

  it("treats socket-level failures as transient", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET"]) {
      expect(classifyStripeError(stripeError({ code })).category).toBe("transient");
    }
  });

  it("treats an unrecognised failure as permanent so a bug fails fast", () => {
    expect(classifyStripeError(new TypeError("cannot read property of undefined")).category).toBe(
      "permanent",
    );
    expect(classifyStripeError("a bare string").category).toBe("permanent");
    expect(classifyStripeError(undefined).category).toBe("permanent");
  });

  it("returns an existing StripeSyncError untouched", () => {
    const original = new StripeSyncError("rate_limited", "slow down");
    expect(classifyStripeError(original)).toBe(original);
  });

  it("preserves the status code and Stripe error type for diagnostics", () => {
    const error = classifyStripeError(
      stripeError({ statusCode: 429, type: "StripeRateLimitError" }),
    );
    expect(error.statusCode).toBe(429);
    expect(error.stripeErrorType).toBe("StripeRateLimitError");
  });

  /**
   * Stripe echoes request parameters in some messages. If a key ever reached one,
   * classification must strip it before it can land in `sync_runs.error_message`.
   */
  it("redacts credential-shaped substrings out of the message", () => {
    const error = classifyStripeError(
      stripeError({
        statusCode: 401,
        message: "Invalid API Key provided: rk_live_ZYXWVUTS9876543210zyxwvuABCD",
      }),
    );
    expect(error.message).not.toContain("rk_live_");
    expect(error.message).not.toContain("ZYXWVUTS9876543210zyxwvuABCD");
    expect(error.message).toContain("[redacted]");
  });

  it("bounds the message length", () => {
    const error = classifyStripeError(stripeError({ statusCode: 500, message: "x".repeat(5_000) }));
    expect(error.message.length).toBeLessThanOrEqual(401);
  });
});

describe("isRetryableCategory", () => {
  it("retries only categories that can plausibly succeed later", () => {
    expect(isRetryableCategory("rate_limited")).toBe(true);
    expect(isRetryableCategory("transient")).toBe(true);
    expect(isRetryableCategory("auth")).toBe(false);
    expect(isRetryableCategory("permission")).toBe(false);
    expect(isRetryableCategory("permanent")).toBe(false);
  });

  it("exposes the same decision on the error itself", () => {
    expect(new StripeSyncError("transient", "later").retryable).toBe(true);
    expect(new StripeSyncError("auth", "no").retryable).toBe(false);
  });
});

describe("sanitizeMessage", () => {
  it("collapses whitespace and never returns an empty message", () => {
    expect(sanitizeMessage("  a   b \n c ")).toBe("a b c");
    expect(sanitizeMessage("   ")).toBe("Stripe returned an error with no message.");
  });
});

describe("describeCategory", () => {
  it("returns operator-facing wording for every category", () => {
    for (const category of [
      "auth",
      "permission",
      "rate_limited",
      "transient",
      "permanent",
    ] as const) {
      const message = describeCategory(category);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("rk_");
    }
  });
});
