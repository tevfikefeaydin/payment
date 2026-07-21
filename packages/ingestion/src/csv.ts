import { parse } from "csv-parse";
import {
  MAX_CSV_ROWS,
  internalPaymentRecordInputSchema,
  isValidCurrency,
  normalizeCurrency,
  normalizeRecordInput,
  parseAmount,
  redactSecretsInText,
  toCsvCell,
  type AmountUnit,
} from "@payrecon/domain";

/**
 * CSV import: header detection, preview, and row-by-row validation.
 *
 * This module is deliberately free of database and network dependencies so the
 * parsing and validation rules can be tested exactly as they behave in
 * production. It never throws for bad DATA — a bad row becomes a structured
 * `CsvRowError` and parsing continues — and it never silently repairs a value.
 */

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Canonical record fields an operator can map a CSV column onto.
 *
 * These are the field names of `InternalPaymentRecordInput`, so the mapping UI,
 * the API and the database all speak about a value by the same name. `metadata`
 * is absent on purpose: a CSV cell has no unambiguous encoding for a
 * key/value map, and guessing one would be exactly the kind of silent coercion
 * this module exists to prevent.
 */
export const CSV_CANONICAL_FIELDS = [
  "externalId",
  "customerId",
  "orderId",
  "subscriptionId",
  "providerTransactionId",
  "amountMinor",
  "currency",
  "status",
  "occurredAt",
  "updatedAt",
] as const;

export type CsvCanonicalField = (typeof CSV_CANONICAL_FIELDS)[number];

/** Fields without which a row cannot become a payment record. */
export const CSV_REQUIRED_FIELDS = [
  "externalId",
  "amountMinor",
  "currency",
  "status",
  "occurredAt",
] as const satisfies readonly CsvCanonicalField[];

/**
 * Date formats an operator may declare.
 *
 * The list is closed and every entry is unambiguous. `DD/MM/YYYY` and
 * `MM/DD/YYYY` are separate entries precisely because "03/04/2026" cannot be
 * resolved without being told which one it is — the importer refuses to guess.
 */
export const CSV_DATE_FORMATS = [
  "iso8601",
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "DD-MM-YYYY",
  "DD.MM.YYYY",
] as const;

export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

export interface CsvMapping {
  /** Canonical record field -> the CSV header that supplies it. */
  columns: Partial<Record<CsvCanonicalField, string>>;
  /**
   * Whether the amount column holds MINOR units ("1050") or a decimal
   * major-unit value ("10.50"). Never inferred: the operator states it.
   */
  amountUnit: AmountUnit;
  /** Defaults to `iso8601` when omitted. */
  dateFormat?: CsvDateFormat;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CsvRowError {
  /**
   * 1-based row number AS THE OPERATOR SEES IT IN A SPREADSHEET: the header is
   * row 1, so the first data row is row 2. A record spanning several physical
   * lines (a quoted field containing newlines) still occupies one spreadsheet
   * row and therefore gets one number.
   */
  rowNumber: number;
  /** The CSV header the problem belongs to, or null for whole-row problems. */
  column: string | null;
  message: string;
  /** Short, secret-scrubbed excerpt of the offending value. */
  valueExcerpt: string | null;
}

/** A row that passed every check, normalised into storage shape. */
export type CsvValidatedRecord = ReturnType<typeof normalizeRecordInput>;

export interface CsvParseResult {
  records: CsvValidatedRecord[];
  errors: CsvRowError[];
  /** Data rows read, excluding the header and excluding blank lines. */
  totalRows: number;
  validRows: number;
  errorRows: number;
  /** Blank/whitespace-only lines skipped; not counted as errors. */
  blankRows: number;
  /** True when `maxErrors` was hit and further errors were dropped. */
  errorsTruncated: boolean;
  /**
   * True when the file exceeded `maxRows`. Parsing stops and `records` is
   * emptied, because holding a partial result of an over-limit file wastes
   * memory for a batch that is going to be rejected anyway.
   */
  limitExceeded: boolean;
}

export interface CsvPreview {
  headers: string[];
  rows: Array<Record<string, string>>;
  /** True when more data rows exist beyond `limit`. */
  truncated: boolean;
}

export interface ParseAndValidateOptions {
  /** Defaults to `MAX_CSV_ROWS`. */
  maxRows?: number;
  /** Cap on collected row errors so a wholly malformed file stays bounded. */
  maxErrors?: number;
}

const DEFAULT_MAX_ERRORS = 1_000;
const DEFAULT_PREVIEW_ROWS = 10;
const VALUE_EXCERPT_LENGTH = 80;

// ---------------------------------------------------------------------------
// Low-level parsing
// ---------------------------------------------------------------------------

/**
 * `bom: true` strips a UTF-8 byte-order mark, which Excel writes by default and
 * which would otherwise become part of the first header's name. Line endings
 * (LF, CRLF, CR) are normalised by the parser itself.
 *
 * `relax_column_count` keeps a row with the wrong number of fields flowing
 * through as data instead of aborting the whole file, so it can be reported as
 * one row error while the remaining rows still import.
 */
function rowStream(content: string): AsyncIterable<string[]> {
  const parser = parse(content, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    // Values are preserved byte-for-byte; trimming is applied per field later
    // only where it is safe, so that a deliberately padded identifier is not
    // silently altered.
    trim: false,
  });
  // The stream is typed as `any` by Node's Readable; every record produced with
  // `columns: false` is a string array.
  return parser as unknown as AsyncIterable<string[]>;
}

function normalizeHeader(value: string): string {
  // A stray BOM can survive inside a concatenated file even when `bom: true`
  // handled the first one. Written as an escape so the byte is visible in
  // source review rather than being an invisible character.
  return value.replace(/^\uFEFF/, "").trim();
}

function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim().length === 0);
}

function excerpt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const scrubbed = redactSecretsInText(value);
  if (scrubbed.length === 0) return "";
  return scrubbed.length > VALUE_EXCERPT_LENGTH
    ? `${scrubbed.slice(0, VALUE_EXCERPT_LENGTH)}…`
    : scrubbed;
}

/** Turn a thrown parser failure into a message safe to show the operator. */
function parserErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // csv-parse messages describe structure ("Quote Not Closed…"), never data,
    // but they are scrubbed anyway on the principle that nothing reaches a user
    // unfiltered.
    return redactSecretsInText(error.message);
  }
  return "The file could not be parsed as CSV.";
}

// ---------------------------------------------------------------------------
// Header detection and preview
// ---------------------------------------------------------------------------

/**
 * Read only the header row.
 *
 * Iteration stops after the first record, which destroys the underlying parser,
 * so a large file is not parsed just to learn its column names.
 */
export async function detectHeaders(content: string): Promise<string[]> {
  for await (const row of rowStream(content)) {
    return row.map(normalizeHeader);
  }
  return [];
}

/** First `limit` data rows, keyed by header, for the column-mapping screen. */
export async function previewRows(
  content: string,
  limit: number = DEFAULT_PREVIEW_ROWS,
): Promise<CsvPreview> {
  const bounded = Math.max(0, Math.min(limit, 100));
  let headers: string[] = [];
  const rows: Array<Record<string, string>> = [];
  let truncated = false;

  for await (const row of rowStream(content)) {
    if (headers.length === 0) {
      headers = row.map(normalizeHeader);
      continue;
    }
    if (isBlankRow(row)) continue;
    if (rows.length >= bounded) {
      // One row beyond the limit is enough to know there are more.
      truncated = true;
      break;
    }
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      // A duplicated header keeps its first column; the mapping UI shows the
      // duplicate so the operator can fix the export instead of us guessing.
      if (!(header in record)) record[header] = row[index] ?? "";
    });
    rows.push(record);
  }

  return { headers, rows, truncated };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

interface DatePattern {
  regex: RegExp;
  /** 1-based capture-group indices. */
  day: number;
  month: number;
  year: number;
}

/**
 * Optional time component, shared by every non-ISO format.
 * A value without a time is interpreted at 00:00:00 UTC — deterministic, and
 * therefore identical no matter which machine runs the import. Interpreting it
 * in the server's local zone would make the same file import differently in
 * different deployments.
 */
const TIME_PART = "(?:[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?)?Z?";

const DATE_PATTERNS: Record<Exclude<CsvDateFormat, "iso8601">, DatePattern> = {
  "YYYY-MM-DD": {
    regex: new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${TIME_PART}$`),
    year: 1,
    month: 2,
    day: 3,
  },
  "DD/MM/YYYY": {
    regex: new RegExp(`^(\\d{2})/(\\d{2})/(\\d{4})${TIME_PART}$`),
    day: 1,
    month: 2,
    year: 3,
  },
  "MM/DD/YYYY": {
    regex: new RegExp(`^(\\d{2})/(\\d{2})/(\\d{4})${TIME_PART}$`),
    month: 1,
    day: 2,
    year: 3,
  },
  "DD-MM-YYYY": {
    regex: new RegExp(`^(\\d{2})-(\\d{2})-(\\d{4})${TIME_PART}$`),
    day: 1,
    month: 2,
    year: 3,
  },
  "DD.MM.YYYY": {
    regex: new RegExp(`^(\\d{2})\\.(\\d{2})\\.(\\d{4})${TIME_PART}$`),
    day: 1,
    month: 2,
    year: 3,
  },
};

/**
 * Convert a cell to an ISO-8601 instant using the DECLARED format.
 * Returns null when the value does not match, including for dates that look
 * well-formed but do not exist (2026-02-30).
 */
export function parseCsvDate(value: string, format: CsvDateFormat): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (format === "iso8601") {
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString();
  }

  const pattern = DATE_PATTERNS[format];
  const match = pattern.regex.exec(trimmed);
  if (!match) return null;

  const year = Number(match[pattern.year]);
  const month = Number(match[pattern.month]);
  const day = Number(match[pattern.day]);
  // Groups 4-6 are always the optional time, whatever the date field order.
  const hour = Number(match[4] ?? "0");
  const minute = Number(match[5] ?? "0");
  const second = Number(match[6] ?? "0");

  if (hour > 23 || minute > 59 || second > 59) return null;

  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  // Date.UTC rolls 31 April over into 1 May; comparing the components back
  // catches a date that never existed instead of importing the wrong day.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ColumnBinding {
  field: CsvCanonicalField;
  header: string;
  index: number;
}

/** Resolve the mapping against the actual header row, once, before parsing. */
function bindColumns(
  headers: readonly string[],
  mapping: CsvMapping,
): { bindings: ColumnBinding[]; errors: CsvRowError[] } {
  const bindings: ColumnBinding[] = [];
  const errors: CsvRowError[] = [];

  for (const field of CSV_CANONICAL_FIELDS) {
    const header = mapping.columns[field];
    if (header === undefined || header.length === 0) continue;
    const wanted = normalizeHeader(header);
    const index = headers.indexOf(wanted);
    if (index === -1) {
      errors.push({
        rowNumber: 1,
        column: wanted,
        message: `Mapped column "${wanted}" was not found in the file's header row.`,
        valueExcerpt: null,
      });
      continue;
    }
    bindings.push({ field, header: wanted, index });
  }

  for (const field of CSV_REQUIRED_FIELDS) {
    if (!bindings.some((b) => b.field === field)) {
      errors.push({
        rowNumber: 1,
        column: null,
        message: `Required field "${field}" is not mapped to any column.`,
        valueExcerpt: null,
      });
    }
  }

  return { bindings, errors };
}

/** Map a zod issue path back to the CSV column the operator has to fix. */
function headerForField(bindings: readonly ColumnBinding[], field: string): string | null {
  return bindings.find((b) => b.field === field)?.header ?? null;
}

/**
 * Parse and validate an entire CSV against a column mapping.
 *
 * Rows are consumed one at a time from the parser, so peak memory is bounded by
 * the accepted-record set rather than by a second full copy of the file.
 */
export async function parseAndValidate(
  content: string,
  mapping: CsvMapping,
  options: ParseAndValidateOptions = {},
): Promise<CsvParseResult> {
  const maxRows = options.maxRows ?? MAX_CSV_ROWS;
  const maxErrors = options.maxErrors ?? DEFAULT_MAX_ERRORS;
  const dateFormat: CsvDateFormat = mapping.dateFormat ?? "iso8601";

  const records: CsvValidatedRecord[] = [];
  const errors: CsvRowError[] = [];
  let errorsTruncated = false;
  let totalRows = 0;
  let errorRows = 0;
  let blankRows = 0;
  let limitExceeded = false;
  let parseFailed = false;

  const addError = (error: CsvRowError): void => {
    if (errors.length >= maxErrors) {
      errorsTruncated = true;
      return;
    }
    errors.push(error);
  };

  let headers: string[] | null = null;
  let bindings: ColumnBinding[] = [];
  /** Field -> column index, resolved once so per-row lookup is O(1). */
  const columnIndex = new Map<CsvCanonicalField, number>();
  /** externalId -> the spreadsheet row that first claimed it. */
  const seenExternalIds = new Map<string, number>();
  let rowNumber = 1; // the header occupies row 1

  try {
    for await (const row of rowStream(content)) {
      if (headers === null) {
        headers = row.map(normalizeHeader);
        const bound = bindColumns(headers, mapping);
        bindings = bound.bindings;
        if (bound.errors.length > 0) {
          // A mapping that does not fit the file is a whole-file problem: every
          // row would fail identically, so stop rather than emit N copies.
          return {
            records: [],
            errors: bound.errors,
            totalRows: 0,
            validRows: 0,
            errorRows: 0,
            blankRows: 0,
            errorsTruncated: false,
            limitExceeded: false,
          };
        }
        for (const binding of bindings) columnIndex.set(binding.field, binding.index);
        continue;
      }

      rowNumber += 1;

      if (isBlankRow(row)) {
        blankRows += 1;
        continue;
      }

      if (totalRows >= maxRows) {
        // Stop reading and drop what was accumulated: this file is going to be
        // rejected, so there is no reason to keep holding its rows.
        limitExceeded = true;
        records.length = 0;
        errors.length = 0;
        errors.push({
          rowNumber,
          column: null,
          message: `The file exceeds the maximum of ${maxRows.toLocaleString("en-US")} data rows. Split it and import the parts separately.`,
          valueExcerpt: null,
        });
        break;
      }

      totalRows += 1;

      if (row.length !== headers.length) {
        errorRows += 1;
        addError({
          rowNumber,
          column: null,
          message: `Malformed row: expected ${headers.length} columns but found ${row.length}.`,
          valueExcerpt: excerpt(row.join(",")),
        });
        continue;
      }

      const cell = (field: CsvCanonicalField): string | undefined => {
        const index = columnIndex.get(field);
        return index === undefined ? undefined : row[index];
      };

      let rowFailed = false;
      const fail = (field: CsvCanonicalField | null, message: string, value?: string): void => {
        rowFailed = true;
        addError({
          rowNumber,
          column: field ? headerForField(bindings, field) : null,
          message,
          valueExcerpt: excerpt(value),
        });
      };

      // --- required presence ---------------------------------------------
      for (const field of CSV_REQUIRED_FIELDS) {
        if ((cell(field) ?? "").trim().length === 0) {
          fail(field, `${field} is required but the cell is empty.`);
        }
      }
      if (rowFailed) {
        errorRows += 1;
        continue;
      }

      // --- currency (needed before the amount can be interpreted) --------
      const rawCurrency = (cell("currency") ?? "").trim();
      if (!isValidCurrency(rawCurrency)) {
        fail(
          "currency",
          "currency must be a three-letter ISO 4217 code, for example USD.",
          rawCurrency,
        );
        errorRows += 1;
        continue;
      }
      const currency = normalizeCurrency(rawCurrency);

      // --- amount ---------------------------------------------------------
      const rawAmount = (cell("amountMinor") ?? "").trim();
      let amountMinor: bigint;
      try {
        amountMinor = parseAmount(rawAmount, currency, mapping.amountUnit);
      } catch (error) {
        // `parseAmount` refuses ambiguity rather than rounding, and its message
        // already explains which unit was expected. Surfacing it verbatim is
        // what makes the failure actionable.
        fail(
          "amountMinor",
          error instanceof Error
            ? redactSecretsInText(error.message)
            : `Invalid amount for amountUnit "${mapping.amountUnit}".`,
          rawAmount,
        );
        errorRows += 1;
        continue;
      }

      // --- dates ------------------------------------------------------------
      const rawOccurredAt = (cell("occurredAt") ?? "").trim();
      const occurredAt = parseCsvDate(rawOccurredAt, dateFormat);
      if (occurredAt === null) {
        fail("occurredAt", `occurredAt is not a valid ${dateFormat} date.`, rawOccurredAt);
      }

      const rawUpdatedAt = (cell("updatedAt") ?? "").trim();
      let updatedAt: string | undefined;
      if (rawUpdatedAt.length > 0) {
        const parsed = parseCsvDate(rawUpdatedAt, dateFormat);
        if (parsed === null) {
          fail("updatedAt", `updatedAt is not a valid ${dateFormat} date.`, rawUpdatedAt);
        } else {
          updatedAt = parsed;
        }
      }

      if (rowFailed) {
        errorRows += 1;
        continue;
      }

      // --- full-record validation -------------------------------------------
      const candidate = {
        externalId: (cell("externalId") ?? "").trim(),
        customerId: cell("customerId")?.trim(),
        orderId: cell("orderId")?.trim(),
        subscriptionId: cell("subscriptionId")?.trim(),
        providerTransactionId: cell("providerTransactionId")?.trim(),
        amountMinor: amountMinor.toString(10),
        currency,
        status: (cell("status") ?? "").trim().toLowerCase(),
        occurredAt,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      };

      const parsed = internalPaymentRecordInputSchema.safeParse(candidate);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const field = String(issue.path[0] ?? "");
          addError({
            rowNumber,
            column: headerForField(bindings, field),
            message: issue.message,
            valueExcerpt: excerpt(field.length > 0 ? cell(field as CsvCanonicalField) : undefined),
          });
        }
        errorRows += 1;
        continue;
      }

      // --- duplicate detection WITHIN this file ------------------------------
      const firstSeenAt = seenExternalIds.get(parsed.data.externalId);
      if (firstSeenAt !== undefined) {
        addError({
          rowNumber,
          column: headerForField(bindings, "externalId"),
          message: `Duplicate externalId: already used on row ${firstSeenAt}. Each externalId may appear only once per file.`,
          valueExcerpt: excerpt(parsed.data.externalId),
        });
        errorRows += 1;
        continue;
      }
      seenExternalIds.set(parsed.data.externalId, rowNumber);

      records.push(normalizeRecordInput(parsed.data));
    }
  } catch (error) {
    // A structural failure (an unterminated quote) aborts the parser. csv-parse
    // may not have emitted anything at all, so this is reported as a file-level
    // problem located at the last row that was reached.
    parseFailed = true;
    addError({
      rowNumber: headers === null ? 1 : rowNumber + 1,
      column: null,
      message:
        headers === null
          ? `The file could not be parsed as CSV: ${parserErrorMessage(error)}`
          : `The file could not be parsed from this point onward: ${parserErrorMessage(error)}`,
      valueExcerpt: null,
    });
    errorRows += 1;
  }

  // Only a genuinely empty file reports "empty" — a parse failure must not be
  // disguised as one, or the operator would be told the wrong thing entirely.
  if (headers === null && !parseFailed) {
    return {
      records: [],
      errors: [
        {
          rowNumber: 1,
          column: null,
          message: "The file is empty: no header row was found.",
          valueExcerpt: null,
        },
      ],
      totalRows: 0,
      validRows: 0,
      errorRows: 0,
      blankRows: 0,
      errorsTruncated: false,
      limitExceeded: false,
    };
  }

  return {
    records,
    errors,
    totalRows,
    validRows: records.length,
    errorRows,
    blankRows,
    errorsTruncated,
    limitExceeded,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type CsvExportValue = string | number | bigint | Date | null | undefined;

function toText(value: CsvExportValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Render rows as CSV text.
 *
 * EVERY cell — including headers — goes through `toCsvCell`, which prefixes an
 * apostrophe to anything starting with `=`, `+`, `-`, `@`, tab or CR. Without
 * it, a value such as `=cmd|'/c calc'!A1` that was imported as harmless data
 * would execute when the exported file is opened in Excel, Sheets or
 * LibreOffice. CRLF is the RFC 4180 line terminator.
 */
export function toCsvExport(
  rows: ReadonlyArray<Readonly<Record<string, CsvExportValue>>>,
  columns?: readonly string[],
): string {
  const headers = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];

  const lines: string[] = [headers.map((header) => toCsvCell(header)).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => toCsvCell(toText(row[header]))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
