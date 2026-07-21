import { redactSecretsInText } from "@payrecon/domain";
import { toSingleLine, truncate } from "./escaping";
import type { SlackBlock } from "./rendering";

/**
 * Outbound transports for notifications.
 *
 * Two rules shape everything here:
 *
 *  1. Failures are classified as `transient` or `permanent` so the delivery
 *     worker can decide between rescheduling and giving up, rather than
 *     retrying a malformed request until it exhausts its attempt budget.
 *  2. No transport ever writes a credential anywhere. A Slack webhook URL is a
 *     secret; it is carried on the message only for the duration of one POST,
 *     and every error message produced here is scrubbed at construction.
 */

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type TransportFailureKind = "transient" | "permanent";

/**
 * A delivery failure with a retry decision attached.
 *
 * The message is scrubbed in the constructor rather than at each call site,
 * because it is persisted on the delivery row and read by operators. A
 * provider's error body can quote the request URL, which for Slack is the
 * webhook secret itself.
 */
export class TransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly statusCode: number | null;

  constructor(message: string, kind: TransportFailureKind, statusCode: number | null = null) {
    super(redactSecretsInText(message));
    this.name = "TransportError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

/**
 * Classify an HTTP response status.
 *
 * 429 and 5xx describe the state of the server or the rate limiter, not the
 * request, so the identical request can succeed later. Any other 4xx means the
 * request is wrong (revoked webhook, invalid payload) and repeating it would
 * only burn attempts.
 */
export function classifyHttpStatus(status: number): TransportFailureKind {
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  return "permanent";
}

/**
 * Classify an SMTP response code.
 *
 * SMTP inverts the HTTP convention: 4xx is an explicitly temporary failure
 * ("try again later"), 5xx is a permanent rejection.
 */
export function classifySmtpResponseCode(code: number): TransportFailureKind {
  if (code >= 500) return "permanent";
  return "transient";
}

export function isTransientFailure(error: unknown): boolean {
  // Anything unclassified is treated as transient: an unexpected error is more
  // likely a blip than a permanently malformed message, and the attempt ceiling
  // still bounds the damage.
  if (error instanceof TransportError) return error.kind === "transient";
  return true;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown transport failure";
}

/** Read a numeric `responseCode` off a nodemailer error without widening to `any`. */
function smtpResponseCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { responseCode?: unknown }).responseCode;
  return typeof code === "number" ? code : null;
}

/** Upper bound on a persisted `lastError`, so one failure cannot bloat a row. */
export const MAX_STORED_ERROR_CHARS = 500;

/**
 * Turn any thrown value into a string that is safe to persist on a delivery row
 * and show to an operator.
 *
 * Stacks are dropped (they leak file paths), the text is scrubbed for anything
 * credential-shaped, flattened to one line, and bounded. A provider that echoes
 * the request URL back in an error body would otherwise write a live Slack
 * webhook straight into the database.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : messageOf(error);
  return truncate(redactSecretsInText(toSingleLine(raw)), MAX_STORED_ERROR_CHARS);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text alternative. Never interpreted, so markup in it is inert. */
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

/** The slice of nodemailer's Transporter this package actually uses. */
interface MailSender {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

/**
 * Real SMTP delivery, used when SMTP_HOST is configured.
 *
 * nodemailer is imported lazily so that unit tests — which only ever use the
 * memory transports — never load it, and so that a process with no SMTP
 * configuration never pays for the module at all.
 */
export class SmtpEmailTransport implements EmailTransport {
  private readonly options: SmtpTransportOptions;
  private sender: MailSender | null = null;

  constructor(options: SmtpTransportOptions) {
    this.options = options;
  }

  private async getSender(): Promise<MailSender> {
    if (this.sender) return this.sender;
    const { createTransport } = await import("nodemailer");
    this.sender = createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: this.options.secure,
      auth:
        this.options.user && this.options.password
          ? { user: this.options.user, pass: this.options.password }
          : undefined,
    });
    return this.sender;
  }

  async send(message: EmailMessage): Promise<void> {
    const sender = await this.getSender();
    try {
      await sender.sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (error) {
      const code = smtpResponseCode(error);
      throw new TransportError(
        `SMTP delivery failed: ${messageOf(error)}`,
        code === null ? "transient" : classifySmtpResponseCode(code),
        code,
      );
    }
  }
}

/**
 * Development transport used when SMTP_HOST is blank.
 *
 * Writes to console.warn rather than console.log so that a developer cannot
 * mistake an undelivered message for a delivered one while scanning normal
 * output, and passes the rendered body through the redactor as a last line of
 * defence before it reaches a terminal or a log aggregator.
 */
export class ConsoleEmailTransport implements EmailTransport {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = (line) => console.warn(line)) {
    this.write = write;
  }

  send(message: EmailMessage): Promise<void> {
    this.write(
      redactSecretsInText(
        [
          "[email:console] message not delivered — no SMTP_HOST configured",
          `to: ${message.to}`,
          `subject: ${message.subject}`,
          "",
          message.text,
        ].join("\n"),
      ),
    );
    return Promise.resolve();
  }
}

/**
 * Test transport. Records the fully rendered message so a test can assert on
 * real content instead of asserting that a mock was called.
 */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  private readonly queuedFailures: Error[] = [];
  private standingFailure: Error | null = null;

  /** Fail only the next send. Used to exercise retry-then-succeed paths. */
  failNextWith(error: Error): this {
    this.queuedFailures.push(error);
    return this;
  }

  /** Fail every send until cleared with `failAlwaysWith(null)`. */
  failAlwaysWith(error: Error | null): this {
    this.standingFailure = error;
    return this;
  }

  send(message: EmailMessage): Promise<void> {
    const failure = this.queuedFailures.shift() ?? this.standingFailure;
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve();
  }

  reset(): void {
    this.sent.length = 0;
    this.queuedFailures.length = 0;
    this.standingFailure = null;
  }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export interface SlackMessage {
  /**
   * SECRET. Held only for the duration of one POST. Never logged, never stored
   * on a delivery row, never placed in audit metadata.
   */
  webhookUrl: string;
  /** Fallback text used in notifications and by clients that cannot render blocks. */
  text: string;
  blocks: SlackBlock[];
}

export interface SlackTransport {
  send(message: SlackMessage): Promise<void>;
}

/** The slice of `fetch` this package uses, so tests can supply a stub. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const MAX_ERROR_BODY_CHARS = 200;

export class HttpSlackTransport implements SlackTransport {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetchImpl: FetchLike = globalThis.fetch, timeoutMs = 10_000) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(message: SlackMessage): Promise<void> {
    let response: { ok: boolean; status: number; text(): Promise<string> };
    try {
      response = await this.fetchImpl(message.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message.text, blocks: message.blocks }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // DNS failure, connection reset, timeout: the message itself is fine.
      throw new TransportError(`Slack request failed: ${messageOf(error)}`, "transient");
    }

    if (response.ok) return;

    let body = "";
    try {
      body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    } catch {
      // A body we cannot read must not mask the status we already have.
    }

    throw new TransportError(
      `Slack responded ${response.status}${body ? `: ${body}` : ""}`,
      classifyHttpStatus(response.status),
      response.status,
    );
  }
}

/** Test transport. Records real rendered Slack payloads. */
export class MemorySlackTransport implements SlackTransport {
  readonly sent: SlackMessage[] = [];
  private readonly queuedFailures: Error[] = [];
  private standingFailure: Error | null = null;

  failNextWith(error: Error): this {
    this.queuedFailures.push(error);
    return this;
  }

  failAlwaysWith(error: Error | null): this {
    this.standingFailure = error;
    return this;
  }

  send(message: SlackMessage): Promise<void> {
    const failure = this.queuedFailures.shift() ?? this.standingFailure;
    if (failure) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve();
  }

  reset(): void {
    this.sent.length = 0;
    this.queuedFailures.length = 0;
    this.standingFailure = null;
  }
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export interface NotificationTransports {
  email: EmailTransport;
  slack: SlackTransport;
}

/**
 * Configuration is injected rather than read from the environment here, so this
 * package never reaches for `process.env`. The caller maps it from validated
 * config, e.g. `{ host: env.SMTP_HOST, port: env.SMTP_PORT, ... }`.
 */
export interface EmailTransportConfig {
  /** Blank or absent selects the development console transport. */
  host?: string | undefined;
  port?: number | undefined;
  secure?: boolean | undefined;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export function createEmailTransport(config: EmailTransportConfig): EmailTransport {
  if (!config.host || config.host.length === 0) return new ConsoleEmailTransport();
  return new SmtpEmailTransport({
    host: config.host,
    port: config.port ?? 587,
    secure: config.secure ?? false,
    user: config.user,
    password: config.password,
    from: config.from,
  });
}

export function createTransports(options: {
  email: EmailTransportConfig;
  slackFetch?: FetchLike;
}): NotificationTransports {
  return {
    email: createEmailTransport(options.email),
    slack: new HttpSlackTransport(options.slackFetch),
  };
}

/** Both memory transports together, for tests and local exploration. */
export function createMemoryTransports(): {
  email: MemoryEmailTransport;
  slack: MemorySlackTransport;
} {
  return { email: new MemoryEmailTransport(), slack: new MemorySlackTransport() };
}
