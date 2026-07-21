import { describe, expect, it } from "vitest";
import {
  MAX_API_BODY_BYTES,
  MAX_BULK_RECORDS,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  amountMinorSchema,
  bulkUpsertSchema,
  currencySchema,
  internalPaymentRecordInputSchema,
  metadataSchema,
  normalizeRecordInput,
  timestampSchema,
  toFieldErrors,
  validate,
  type FieldError,
} from "./validation";

const VALID = {
  externalId: "order-1",
  customerId: "cus_1",
  orderId: "ord_1",
  subscriptionId: "sub_1",
  providerTransactionId: "pi_1",
  amountMinor: "1050",
  currency: "usd",
  status: "paid",
  occurredAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T11:00:00.000Z",
  metadata: { source: "checkout" },
};

/** Parse and return the field errors, failing loudly if the input was accepted. */
function errorsFor(input: unknown): FieldError[] {
  const outcome = validate(internalPaymentRecordInputSchema, input);
  expect(outcome.ok, `expected ${JSON.stringify(input)} to be rejected`).toBe(false);
  return outcome.errors ?? [];
}

const paths = (errors: FieldError[]) => errors.map((e) => e.path);

describe("a valid record", () => {
  it("is accepted and normalised", () => {
    const outcome = validate(internalPaymentRecordInputSchema, VALID);

    expect(outcome.ok).toBe(true);
    expect(outcome.errors).toBeUndefined();
    expect(outcome.value).toMatchObject({
      externalId: "order-1",
      customerId: "cus_1",
      amountMinor: "1050",
      currency: "USD", // normalised to uppercase
      status: "paid",
    });
  });

  it("is accepted with only the required fields", () => {
    const outcome = validate(internalPaymentRecordInputSchema, {
      externalId: "order-2",
      amountMinor: "0",
      currency: "JPY",
      status: "pending",
      occurredAt: "2026-01-15T00:00:00Z",
    });
    expect(outcome.ok).toBe(true);
  });

  it("trims surrounding whitespace on identifiers and currency", () => {
    const outcome = validate(internalPaymentRecordInputSchema, {
      ...VALID,
      externalId: "  order-3  ",
      currency: "  eur  ",
    });
    expect(outcome.value).toMatchObject({ externalId: "order-3", currency: "EUR" });
  });

  it("accepts every declared status and a negative amount", () => {
    for (const status of ["pending", "paid", "failed", "refunded", "partially_refunded"]) {
      expect(validate(internalPaymentRecordInputSchema, { ...VALID, status }).ok, status).toBe(
        true,
      );
    }
    expect(validate(internalPaymentRecordInputSchema, { ...VALID, amountMinor: "-1050" }).ok).toBe(
      true,
    );
  });
});

describe("currency", () => {
  it("rejects anything that is not a three-letter code", () => {
    for (const currency of ["US", "USDX", "US1", "", "   ", "12", "dollars"]) {
      const errors = errorsFor({ ...VALID, currency });
      expect(paths(errors), currency).toContain("currency");
      expect(errors[0]?.message).toContain("three-letter ISO 4217 code");
    }
  });

  it("rejects a non-string currency", () => {
    expect(paths(errorsFor({ ...VALID, currency: 840 }))).toContain("currency");
    expect(paths(errorsFor({ ...VALID, currency: null }))).toContain("currency");
    expect(paths(errorsFor({ ...VALID, currency: undefined }))).toContain("currency");
  });

  it("normalises case on the way through", () => {
    expect(currencySchema.parse("gbp")).toBe("GBP");
    expect(currencySchema.parse(" jpy ")).toBe("JPY");
  });
});

describe("amountMinor", () => {
  it("REJECTS a decimal amount rather than guessing what it meant", () => {
    const errors = errorsFor({ ...VALID, amountMinor: "10.50" });
    expect(paths(errors)).toContain("amountMinor");
    expect(errors[0]?.message).toContain("integer number of minor units");
  });

  it("rejects empty, non-numeric and exponential strings", () => {
    for (const amountMinor of ["", "   ", "abc", "1e5", "1,050", "+5", "10.0"]) {
      expect(paths(errorsFor({ ...VALID, amountMinor })), amountMinor).toContain("amountMinor");
    }
  });

  it("rejects a JSON number, because doubles lose precision above 2^53", () => {
    const errors = errorsFor({ ...VALID, amountMinor: 1050 });
    expect(paths(errors)).toContain("amountMinor");
    expect(errors[0]?.code).toBe("invalid_type");
    expect(errors[0]?.message).toContain("string");
  });

  it("accepts an integer string beyond Number.MAX_SAFE_INTEGER", () => {
    expect(amountMinorSchema.parse("9007199254740993")).toBe("9007199254740993");
    expect(
      validate(internalPaymentRecordInputSchema, {
        ...VALID,
        amountMinor: "9007199254740993",
      }).ok,
    ).toBe(true);
  });
});

describe("timestamps", () => {
  it("rejects an unparseable date", () => {
    for (const occurredAt of ["", "not-a-date", "2026-13-45", "yesterday"]) {
      const errors = errorsFor({ ...VALID, occurredAt });
      expect(paths(errors), occurredAt).toContain("occurredAt");
    }
  });

  it("rejects a date outside the supported range", () => {
    for (const occurredAt of [
      "1999-12-31T23:59:59Z",
      "2101-01-01T00:00:00Z",
      "1970-01-01T00:00:00Z",
    ]) {
      const errors = errorsFor({ ...VALID, occurredAt });
      expect(paths(errors), occurredAt).toContain("occurredAt");
      expect(errors[0]?.message).toContain("between 2000 and 2100");
    }
  });

  it("accepts the range boundaries", () => {
    expect(timestampSchema.safeParse("2000-01-01T00:00:00Z").success).toBe(true);
    expect(timestampSchema.safeParse("2100-12-31T23:59:59Z").success).toBe(true);
    expect(timestampSchema.safeParse("2101-01-01T00:00:00Z").success).toBe(false);
  });

  it("validates updatedAt with the same rule when present", () => {
    expect(paths(errorsFor({ ...VALID, updatedAt: "nope" }))).toContain("updatedAt");
    expect(validate(internalPaymentRecordInputSchema, { ...VALID, updatedAt: undefined }).ok).toBe(
      true,
    );
  });
});

describe("identifiers", () => {
  it("rejects an empty or whitespace-only externalId", () => {
    for (const externalId of ["", "   ", "\t"]) {
      const errors = errorsFor({ ...VALID, externalId });
      expect(paths(errors), JSON.stringify(externalId)).toContain("externalId");
      expect(errors[0]?.message).toContain("must not be empty");
    }
  });

  it("rejects a missing externalId as a type error", () => {
    const errors = errorsFor({ ...VALID, externalId: undefined });
    expect(errors[0]?.code).toBe("invalid_type");
    expect(errors[0]?.message).toBe("externalId must be a string");
  });

  it("rejects an over-long externalId", () => {
    const errors = errorsFor({ ...VALID, externalId: "x".repeat(256) });
    expect(paths(errors)).toContain("externalId");
    expect(errors[0]?.message).toContain("at most 255 characters");
    expect(errors[0]?.code).toBe("too_big");
  });

  it("accepts an identifier of exactly the maximum length", () => {
    expect(
      validate(internalPaymentRecordInputSchema, {
        ...VALID,
        externalId: "x".repeat(255),
      }).ok,
    ).toBe(true);
  });

  it("rejects over-long optional identifiers", () => {
    for (const field of ["customerId", "orderId", "subscriptionId", "providerTransactionId"]) {
      const errors = errorsFor({ ...VALID, [field]: "y".repeat(256) });
      expect(paths(errors), field).toContain(field);
      expect(errors[0]?.code).toBe("too_big");
    }
  });

  it("treats an empty optional identifier as absent", () => {
    const outcome = validate(internalPaymentRecordInputSchema, { ...VALID, customerId: "" });
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.customerId).toBeUndefined();
  });
});

describe("metadata", () => {
  const withMetadata = (metadata: unknown) => errorsFor({ ...VALID, metadata });

  it("rejects more than 20 keys", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) many[`k${i}`] = "v";

    const errors = withMetadata(many);
    expect(errors[0]?.message).toContain("at most 20 keys");
    expect(paths(errors)).toContain("metadata");
  });

  it("accepts exactly 20 keys", () => {
    const twenty: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) twenty[`k${i}`] = "v";
    expect(metadataSchema.safeParse(twenty).success).toBe(true);
  });

  it("rejects an over-long key", () => {
    const errors = withMetadata({ ["k".repeat(65)]: "v" });
    expect(errors[0]?.message).toContain("at most 64 characters");
  });

  it("rejects an over-long value", () => {
    const errors = withMetadata({ note: "v".repeat(501) });
    expect(errors[0]?.message).toContain("at most 500 characters");
  });

  it("accepts a key and value at exactly the limit", () => {
    expect(metadataSchema.safeParse({ ["k".repeat(64)]: "v".repeat(500) }).success).toBe(true);
  });

  it("REJECTS credential-like keys so secrets cannot be smuggled in", () => {
    for (const key of [
      "password",
      "secret",
      "api_key",
      "api-key",
      "apiKey",
      "token",
      "authorization",
      "credential",
      "STRIPE_SECRET",
      "user_password",
    ]) {
      const result = metadataSchema.safeParse({ [key]: "value" });
      expect(result.success, key).toBe(false);
      if (!result.success) {
        expect(toFieldErrors(result.error)[0]?.message).toContain("credential-like keys");
      }
    }
  });

  it("accepts ordinary keys", () => {
    expect(metadataSchema.safeParse({ source: "checkout", campaign: "spring" }).success).toBe(true);
    expect(metadataSchema.safeParse({}).success).toBe(true);
  });

  it("rejects non-string values, keeping metadata flat and small", () => {
    expect(metadataSchema.safeParse({ n: 5 }).success).toBe(false);
    expect(metadataSchema.safeParse({ nested: { a: "b" } }).success).toBe(false);
    expect(metadataSchema.safeParse({ list: ["a"] }).success).toBe(false);
  });
});

describe("bulkUpsertSchema", () => {
  const record = (externalId: string) => ({ ...VALID, externalId });

  it("accepts a well-formed batch", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: [record("order-1"), record("order-2")],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.records).toHaveLength(2);
  });

  it("REJECTS an empty array", () => {
    const outcome = validate(bulkUpsertSchema, { records: [] });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.message).toContain("at least one item");
    expect(outcome.errors?.[0]?.path).toBe("records");
    expect(outcome.errors?.[0]?.code).toBe("too_small");
  });

  it("REJECTS more than MAX_BULK_RECORDS", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: Array.from({ length: MAX_BULK_RECORDS + 1 }, (_, i) => record(`order-${i}`)),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.message).toContain(`at most ${MAX_BULK_RECORDS} items`);
    expect(outcome.errors?.[0]?.code).toBe("too_big");
  });

  it("accepts exactly MAX_BULK_RECORDS", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: Array.from({ length: MAX_BULK_RECORDS }, (_, i) => record(`order-${i}`)),
    });
    expect(outcome.ok).toBe(true);
  });

  it("REJECTS a duplicate externalId inside one request", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: [record("order-1"), record("order-2"), record("order-1")],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.message).toContain("duplicate externalId");
  });

  it("detects duplicates that differ only by surrounding whitespace", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: [record("order-1"), record("  order-1  ")],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.message).toContain("duplicate externalId");
  });

  it("rejects a missing records array", () => {
    const outcome = validate(bulkUpsertSchema, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.errors?.[0]?.path).toBe("records");
    expect(outcome.errors?.[0]?.code).toBe("invalid_type");
  });
});

describe("toFieldErrors", () => {
  it("produces dotted paths that point at the offending record and field", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: [
        { ...VALID, externalId: "order-0" },
        { ...VALID, externalId: "order-1", amountMinor: "10.50" },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toEqual([
      {
        path: "records.1.amountMinor",
        message:
          'amountMinor must be an integer number of minor units expressed as a string, for example "1050" for $10.50',
        code: "custom",
      },
    ]);
  });

  it("reports several problems at once, each with its own path", () => {
    const outcome = validate(bulkUpsertSchema, {
      records: [
        { ...VALID, externalId: "order-0", currency: "US" },
        { ...VALID, externalId: "", amountMinor: "nope" },
      ],
    });

    expect(outcome.ok).toBe(false);
    const reported = outcome.errors ?? [];
    expect(reported.map((e) => e.path).sort()).toEqual([
      "records.0.currency",
      "records.1.amountMinor",
      "records.1.externalId",
    ]);
    for (const error of reported) {
      expect(typeof error.code).toBe("string");
      expect(error.code.length).toBeGreaterThan(0);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("labels a root-level problem", () => {
    const result = metadataSchema.safeParse({ password: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFieldErrors(result.error)[0]?.path).toBe("(root)");
    }
  });
});

describe("normalizeRecordInput", () => {
  it("converts the amount to bigint and maps absent optionals to null", () => {
    const parsed = internalPaymentRecordInputSchema.parse({
      externalId: "order-9",
      amountMinor: "-1050",
      currency: "usd",
      status: "refunded",
      occurredAt: "2026-03-01T10:00:00.000Z",
    });
    const normalized = normalizeRecordInput(parsed);

    expect(normalized).toEqual({
      externalId: "order-9",
      customerId: null,
      orderId: null,
      subscriptionId: null,
      providerTransactionId: null,
      amountMinor: -1050n,
      currency: "USD",
      status: "refunded",
      occurredAt: new Date("2026-03-01T10:00:00.000Z"),
      recordUpdatedAt: null,
      metadata: {},
    });
    expect(typeof normalized.amountMinor).toBe("bigint");
    expect(normalized.occurredAt).toBeInstanceOf(Date);
  });

  it("carries present optionals through unchanged", () => {
    const normalized = normalizeRecordInput(internalPaymentRecordInputSchema.parse(VALID));

    expect(normalized.customerId).toBe("cus_1");
    expect(normalized.orderId).toBe("ord_1");
    expect(normalized.subscriptionId).toBe("sub_1");
    expect(normalized.providerTransactionId).toBe("pi_1");
    expect(normalized.metadata).toEqual({ source: "checkout" });
    expect(normalized.recordUpdatedAt).toEqual(new Date("2026-03-01T11:00:00.000Z"));
  });

  it("maps an empty-string optional to null, not to an empty string", () => {
    const normalized = normalizeRecordInput(
      internalPaymentRecordInputSchema.parse({ ...VALID, customerId: "", orderId: "" }),
    );
    expect(normalized.customerId).toBeNull();
    expect(normalized.orderId).toBeNull();
  });

  it("keeps an amount beyond 2^53 exact", () => {
    const normalized = normalizeRecordInput(
      internalPaymentRecordInputSchema.parse({ ...VALID, amountMinor: "9007199254740993" }),
    );
    expect(normalized.amountMinor).toBe(9007199254740993n);
  });
});

describe("declared bounds", () => {
  it("are documented as explicit constants", () => {
    expect(MAX_BULK_RECORDS).toBe(1000);
    expect(MAX_API_BODY_BYTES).toBe(1_048_576);
    expect(MAX_CSV_BYTES).toBe(20 * 1_048_576);
    expect(MAX_CSV_ROWS).toBe(100_000);
  });
});
