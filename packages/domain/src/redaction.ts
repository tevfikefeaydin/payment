/**
 * Redaction and output sanitisation.
 *
 * Every value that leaves the process — a log line, an audit metadata blob, an
 * error shown to a user, a CSV cell — passes through this module. The rules
 * here are deliberately conservative: it is always better to over-redact a log
 * than to leak a credential.
 */

/** Keys whose values are never logged, at any nesting depth. */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|cookie|session|credential|private[_-]?key|encryption[_-]?key|webhook[_-]?url|signature|otp|pin|cvv|card[_-]?number|iban|ssn)/i;

/** Value patterns that look like credentials regardless of their key. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b[sr]k_(test|live)_[A-Za-z0-9]{8,}\b/g, // Stripe secret / restricted keys
  /\bpk_(test|live)_[A-Za-z0-9]{8,}\b/g, // Stripe publishable keys
  /\bwhsec_[A-Za-z0-9]{8,}\b/g, // Stripe webhook signing secrets
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, // bearer tokens
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // Slack webhooks
];

export const REDACTED = "[redacted]";

/** Replace anything that looks like a credential inside a free-text string. */
export function redactSecretsInText(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * Mask a value while keeping just enough to correlate it in support.
 * Never reveals more than the last four characters, and never for short values.
 */
export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return REDACTED;
  return `${REDACTED}${value.slice(-visible)}`;
}

/**
 * Redact a provider object identifier for logging.
 *
 * Stripe ids are not secret, but the specification requires minimising them in
 * logs. The type prefix is retained because it is operationally useful, while
 * the unique portion is truncated.
 */
export function redactProviderId(id: string | null | undefined): string | null {
  if (!id) return null;
  const match = /^([a-z]+)_(.+)$/.exec(id);
  if (!match) return maskTail(id);
  const [, prefix, rest] = match;
  if (!prefix || !rest) return maskTail(id);
  return `${prefix}_${rest.slice(0, 2)}…${rest.slice(-4)}`;
}

/** Redact an email address to a shape that is still recognisable in support. */
export function redactEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return REDACTED;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

type Redactable =
  string | number | boolean | null | undefined | Redactable[] | { [k: string]: Redactable };

/**
 * Deep-redact a structure for logging or audit metadata.
 *
 * - Values under a sensitive key become `[redacted]`.
 * - Free-text values are scanned for credential-shaped substrings.
 * - Recursion is depth-limited so a hostile or cyclic structure cannot hang the
 *   logger, and long strings are truncated so a whole request body cannot be
 *   accidentally logged.
 */
export function redactObject(input: unknown, depth = 0): Redactable {
  const MAX_DEPTH = 6;
  const MAX_STRING = 512;
  const MAX_ARRAY = 50;

  if (depth > MAX_DEPTH) return "[truncated: max depth]";
  if (input === null || input === undefined) return null;

  if (typeof input === "string") {
    const redacted = redactSecretsInText(input);
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
  }
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString(10);
  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) return redactSecretsInText(input.message);

  if (Array.isArray(input)) {
    const items = input.slice(0, MAX_ARRAY).map((item) => redactObject(item, depth + 1));
    if (input.length > MAX_ARRAY) items.push(`[truncated: ${input.length - MAX_ARRAY} more]`);
    return items;
  }

  if (typeof input === "object") {
    const out: Record<string, Redactable> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactObject(value, depth + 1);
    }
    return out;
  }

  return "[unserialisable]";
}

// ---------------------------------------------------------------------------
// User-facing errors
// ---------------------------------------------------------------------------

/**
 * An error whose message is intentionally safe to show to an end user.
 * Anything that is not a `PublicError` is replaced with a generic message so
 * that stack traces and internal details never reach the browser.
 */
export class PublicError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.code = code;
    this.status = status;
  }
}

export interface SafeErrorView {
  code: string;
  message: string;
  status: number;
}

const GENERIC_MESSAGE =
  "Something went wrong. Please try again, or contact support if it persists.";

/** Convert any thrown value into something safe to render or return. */
export function toSafeError(error: unknown): SafeErrorView {
  if (error instanceof PublicError) {
    return {
      code: error.code,
      message: redactSecretsInText(error.message),
      status: error.status,
    };
  }
  return { code: "internal_error", message: GENERIC_MESSAGE, status: 500 };
}

/**
 * Categorise an error for metrics and logs without recording its content.
 * Used so dashboards can show failure classes without storing sensitive text.
 */
export function errorCategory(error: unknown): string {
  if (error instanceof PublicError) return error.code;
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Spreadsheet / CSV output safety
// ---------------------------------------------------------------------------

/**
 * Neutralise spreadsheet formula injection.
 *
 * A cell beginning with `=`, `+`, `-`, `@`, tab or carriage return is executed
 * as a formula by Excel, Sheets and LibreOffice. Prefixing with an apostrophe
 * forces the value to be treated as text. Embedded quotes and newlines are
 * handled by the CSV writer's quoting, not here.
 */
export function sanitizeCsvValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.length === 0) return "";
  if (/^[=+\-@\t\r]/.test(text)) return `'${text}`;
  return text;
}

/** Quote a value for CSV output, applying formula-injection protection first. */
export function toCsvCell(value: string | null | undefined): string {
  const safe = sanitizeCsvValue(value);
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/**
 * Sanitise a user-supplied filename before it is used in a Content-Disposition
 * header or written to disk. Strips directory separators and control characters.
 */
export function safeFilename(input: string, fallback = "export.csv"): string {
  // Strip control characters by code point rather than with a regex, which keeps
  // this readable and avoids embedding raw control bytes in source.
  const withoutControls = [...input]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("");

  const base = withoutControls
    .replace(/[\\/]/g, "_") // no directory traversal
    .replace(/^\.+/, "") // no leading dots ("..", hidden files)
    .trim();

  const truncated = base.slice(0, 120);
  return truncated.length > 0 ? truncated : fallback;
}
