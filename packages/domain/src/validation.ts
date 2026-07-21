import { z } from "zod";
import { isValidCurrency, normalizeCurrency, parseAmountMinor } from "./money";
import { INTERNAL_PAYMENT_STATUSES, type InternalPaymentRecordInput } from "./types";

/**
 * Runtime validation for everything crossing an external boundary.
 *
 * The same schemas back CSV import and the REST API so that a record accepted
 * by one path is accepted identically by the other, and rejected identically
 * too. Limits are explicit constants so they can be documented and tested.
 */

// --- Bounds -----------------------------------------------------------------

/** Maximum records accepted in a single bulk upsert request. */
export const MAX_BULK_RECORDS = 1000;
/** Maximum JSON body size accepted by the ingestion API, in bytes. */
export const MAX_API_BODY_BYTES = 1_048_576; // 1 MiB
/** Maximum uploadable CSV size, in bytes. */
export const MAX_CSV_BYTES = 20 * 1_048_576; // 20 MiB
/** Maximum data rows accepted from a single CSV file. */
export const MAX_CSV_ROWS = 100_000;

const MAX_METADATA_KEYS = 20;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_VALUE_LENGTH = 500;
const MAX_IDENTIFIER_LENGTH = 255;

// --- Primitives -------------------------------------------------------------

const identifier = (label: string) =>
  z
    .string({ message: `${label} must be a string` })
    .trim()
    .min(1, `${label} must not be empty`)
    .max(MAX_IDENTIFIER_LENGTH, `${label} must be at most ${MAX_IDENTIFIER_LENGTH} characters`);

const optionalIdentifier = (label: string) =>
  z
    .string()
    .trim()
    .max(MAX_IDENTIFIER_LENGTH, `${label} must be at most ${MAX_IDENTIFIER_LENGTH} characters`)
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v));

export const currencySchema = z
  .string({ message: "currency is required" })
  .trim()
  .refine((v) => isValidCurrency(v), {
    message: "currency must be a three-letter ISO 4217 code, for example USD",
  })
  .transform((v) => normalizeCurrency(v));

/**
 * Amount in MINOR units, as a string.
 *
 * Accepting a string rather than a number is deliberate: JSON numbers become
 * IEEE-754 doubles and would silently lose precision above 2^53. The value is
 * validated by `parseAmountMinor`, which rejects decimal points outright rather
 * than guessing whether "10.50" meant 1050 or 10.
 */
export const amountMinorSchema = z
  .string({ message: 'amountMinor must be a string of minor units, for example "1050"' })
  .trim()
  .refine(
    (v) => {
      try {
        parseAmountMinor(v);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'amountMinor must be an integer number of minor units expressed as a string, for example "1050" for $10.50',
    },
  );

/** An ISO-8601 timestamp that parses to a real date within a sane range. */
export const timestampSchema = z
  .string({ message: "timestamp must be an ISO-8601 string" })
  .trim()
  .refine(
    (v) => {
      const parsed = Date.parse(v);
      if (Number.isNaN(parsed)) return false;
      const year = new Date(parsed).getUTCFullYear();
      return year >= 2000 && year <= 2100;
    },
    { message: "timestamp must be a valid ISO-8601 date between 2000 and 2100" },
  );

/**
 * Bounded metadata. Kept small and string-only so that an import cannot be used
 * to smuggle large payloads, nested structures, or secrets into the database.
 */
export const metadataSchema = z
  .record(z.string(), z.string())
  .refine((value) => Object.keys(value).length <= MAX_METADATA_KEYS, {
    message: `metadata may contain at most ${MAX_METADATA_KEYS} keys`,
  })
  .refine((value) => Object.keys(value).every((k) => k.length <= MAX_METADATA_KEY_LENGTH), {
    message: `metadata keys must be at most ${MAX_METADATA_KEY_LENGTH} characters`,
  })
  .refine((value) => Object.values(value).every((v) => v.length <= MAX_METADATA_VALUE_LENGTH), {
    message: `metadata values must be at most ${MAX_METADATA_VALUE_LENGTH} characters`,
  })
  .refine(
    (value) =>
      !Object.keys(value).some((k) =>
        /(password|secret|token|api[_-]?key|authorization|credential)/i.test(k),
      ),
    { message: "metadata must not contain credential-like keys" },
  );

// --- Internal payment record ------------------------------------------------

export const internalPaymentRecordInputSchema = z.object({
  externalId: identifier("externalId"),
  customerId: optionalIdentifier("customerId"),
  orderId: optionalIdentifier("orderId"),
  subscriptionId: optionalIdentifier("subscriptionId"),
  providerTransactionId: optionalIdentifier("providerTransactionId"),
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  status: z.enum(INTERNAL_PAYMENT_STATUSES, {
    message: `status must be one of: ${INTERNAL_PAYMENT_STATUSES.join(", ")}`,
  }),
  occurredAt: timestampSchema,
  updatedAt: timestampSchema.optional(),
  metadata: metadataSchema.optional(),
});

export type ValidatedInternalPaymentRecord = z.infer<typeof internalPaymentRecordInputSchema>;

export const bulkUpsertSchema = z.object({
  records: z
    .array(internalPaymentRecordInputSchema)
    .min(1, "records must contain at least one item")
    .max(MAX_BULK_RECORDS, `records must contain at most ${MAX_BULK_RECORDS} items`)
    .refine((records) => new Set(records.map((r) => r.externalId)).size === records.length, {
      message: "records must not contain duplicate externalId values within one request",
    }),
});

// --- Structured error reporting ---------------------------------------------

/** A single field-level validation problem, safe to return to the caller. */
export interface FieldError {
  /** Dotted path, e.g. `records.3.amountMinor`. */
  path: string;
  message: string;
  /** Stable machine-readable code for clients to branch on. */
  code: string;
}

/** Convert a zod error into a stable, transport-friendly shape. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

export interface ValidationOutcome<T> {
  ok: boolean;
  value?: T;
  errors?: FieldError[];
}

export function validate<T>(schema: z.ZodType<T>, input: unknown): ValidationOutcome<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: toFieldErrors(result.error) };
}

/**
 * Normalise a validated input into the shape stored in the database.
 * Amounts become bigint here, once, at the boundary.
 */
export function normalizeRecordInput(input: ValidatedInternalPaymentRecord): {
  externalId: string;
  customerId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: InternalPaymentRecordInput["status"];
  occurredAt: Date;
  recordUpdatedAt: Date | null;
  metadata: Record<string, string>;
} {
  return {
    externalId: input.externalId,
    customerId: input.customerId ?? null,
    orderId: input.orderId ?? null,
    subscriptionId: input.subscriptionId ?? null,
    providerTransactionId: input.providerTransactionId ?? null,
    amountMinor: parseAmountMinor(input.amountMinor),
    currency: input.currency,
    status: input.status,
    occurredAt: new Date(input.occurredAt),
    recordUpdatedAt: input.updatedAt ? new Date(input.updatedAt) : null,
    metadata: input.metadata ?? {},
  };
}
