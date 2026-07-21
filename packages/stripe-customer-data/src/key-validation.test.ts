import { describe, expect, it } from "vitest";
import { PublicError } from "@payrecon/domain";
import {
  assertRestrictedKey,
  classifyStripeKey,
  isRestrictedKey,
  keyKindOf,
  keyLastFour,
  normalizeStripeKey,
} from "./key-validation";

/**
 * Realistic shapes. The bodies are long enough to pass the minimum-length rule
 * and are obviously fake so no scanner mistakes them for a real credential.
 */
const RK_TEST = "rk_test_ABCDEFGH0123456789abcdefXYZW";
const RK_LIVE = "rk_live_ZYXWVUTS9876543210zyxwvuABCD";
const SK_TEST = "sk_test_ABCDEFGH0123456789abcdefXYZW";
const SK_LIVE = "sk_live_ZYXWVUTS9876543210zyxwvuABCD";
const PK_TEST = "pk_test_ABCDEFGH0123456789abcdefXYZW";
const PK_LIVE = "pk_live_ZYXWVUTS9876543210zyxwvuABCD";

describe("classifyStripeKey", () => {
  it("accepts a restricted test key and reports test mode", () => {
    expect(classifyStripeKey(RK_TEST)).toEqual({ ok: true, kind: "restricted", livemode: false });
  });

  it("accepts a restricted live key and reports live mode", () => {
    expect(classifyStripeKey(RK_LIVE)).toEqual({ ok: true, kind: "restricted", livemode: true });
  });

  it("tolerates whitespace around a pasted key", () => {
    expect(classifyStripeKey(`  ${RK_LIVE}\n`)).toEqual({
      ok: true,
      kind: "restricted",
      livemode: true,
    });
    expect(normalizeStripeKey(`  ${RK_LIVE}\n`)).toBe(RK_LIVE);
  });

  it("rejects secret keys with a secret-specific reason", () => {
    for (const key of [SK_TEST, SK_LIVE]) {
      const result = classifyStripeKey(key);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("secret_key");
    }
  });

  it("rejects publishable keys with a publishable-specific reason", () => {
    for (const key of [PK_TEST, PK_LIVE]) {
      const result = classifyStripeKey(key);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("publishable_key");
    }
  });

  it("rejects an empty value distinctly from a malformed one", () => {
    const empty = classifyStripeKey("");
    const blank = classifyStripeKey("   ");
    const garbage = classifyStripeKey("garbage");
    expect(empty.ok).toBe(false);
    expect(blank.ok).toBe(false);
    expect(garbage.ok).toBe(false);
    if (empty.ok || blank.ok || garbage.ok) throw new Error("unreachable");
    expect(empty.reason).toBe("empty");
    expect(blank.reason).toBe("empty");
    expect(garbage.reason).toBe("malformed");
    expect(empty.message).not.toBe(garbage.message);
  });

  it("rejects a truncated restricted key rather than accepting the bare prefix", () => {
    for (const key of ["rk_live_", "rk_test_", "rk_live_abc", "rk_", "rk_prod_ABCDEFGH12345678"]) {
      const result = classifyStripeKey(key);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("malformed");
    }
  });

  it("rejects a restricted key with characters Stripe never emits", () => {
    expect(classifyStripeKey("rk_live_ABCDEFGH-1234!5678").ok).toBe(false);
  });

  it("gives every rejection reason its own message", () => {
    const messages = [
      classifyStripeKey(""),
      classifyStripeKey(SK_LIVE),
      classifyStripeKey(PK_LIVE),
      classifyStripeKey("garbage"),
    ].map((result) => (result.ok ? "" : result.message));
    expect(new Set(messages).size).toBe(messages.length);
  });

  /**
   * The security property: whatever the operator pasted must not survive into
   * anything the classifier hands back.
   */
  it("never echoes the rejected key in the message", () => {
    const secrets = [SK_TEST, SK_LIVE, PK_TEST, PK_LIVE, "garbage", "rk_live_short"];
    for (const secret of secrets) {
      const result = classifyStripeKey(secret);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).not.toContain(secret);
      // Not even the distinctive body of the key, where there is one.
      const body = secret.slice(8);
      if (body.length > 0) expect(result.message).not.toContain(body);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
});

describe("isRestrictedKey", () => {
  it("agrees with classifyStripeKey", () => {
    expect(isRestrictedKey(RK_LIVE)).toBe(true);
    expect(isRestrictedKey(SK_LIVE)).toBe(false);
  });
});

describe("assertRestrictedKey", () => {
  it("returns the classification for a restricted key", () => {
    expect(assertRestrictedKey(RK_LIVE)).toEqual({ kind: "restricted", livemode: true });
  });

  it("throws a user-safe error that does not contain the key", () => {
    for (const key of [SK_TEST, SK_LIVE, PK_TEST, PK_LIVE, "", "garbage"]) {
      let thrown: unknown;
      try {
        assertRestrictedKey(key);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PublicError);
      const error = thrown as PublicError;
      expect(error.status).toBe(400);
      if (key.length > 0) expect(error.message).not.toContain(key);
    }
  });

  it("uses a distinct error code per rejection reason", () => {
    const codes = [SK_LIVE, PK_LIVE, "", "garbage"].map((key) => {
      try {
        assertRestrictedKey(key);
        return "accepted";
      } catch (error) {
        return error instanceof PublicError ? error.code : "unknown";
      }
    });
    expect(codes).toEqual([
      "stripe_key_secret",
      "stripe_key_publishable",
      "stripe_key_empty",
      "stripe_key_malformed",
    ]);
  });
});

describe("key display helpers", () => {
  it("describes the non-secret key kind", () => {
    expect(keyKindOf(true)).toBe("rk_live");
    expect(keyKindOf(false)).toBe("rk_test");
  });

  it("reveals at most the last four characters", () => {
    expect(keyLastFour(RK_LIVE)).toBe(RK_LIVE.slice(-4));
    expect(keyLastFour(RK_LIVE)).toHaveLength(4);
  });
});
