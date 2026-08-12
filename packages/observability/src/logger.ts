import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { redactObject, redactSecretsInText } from "@payrecon/domain";

/**
 * The shared structured logger.
 *
 * One place decides how PayRecon processes log, so every line is JSON, carries
 * its component, and — most importantly — passes through the same redaction the
 * audit trail uses. A secret that reaches a log call is neutralised here rather
 * than depending on every call site remembering to sanitise.
 *
 * This package exists because the logger cannot live in @payrecon/domain
 * (domain is pure and must not depend on pino) and cannot live in
 * @payrecon/config (domain depends on config, and the logger needs domain's
 * redaction — that would be a cycle).
 */

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);

export interface CreateLoggerOptions {
  /** Appears on every line, e.g. "worker", "queue", "web". */
  component: string;
  /** Defaults to LOG_LEVEL from the environment, then "info". */
  level?: string;
  /** Test seam: capture lines instead of writing to stdout. */
  destination?: DestinationStream;
}

export type { Logger };

export function createLogger(options: CreateLoggerOptions): Logger {
  const envLevel = process.env.LOG_LEVEL;
  const level =
    options.level && LEVELS.has(options.level)
      ? options.level
      : envLevel && LEVELS.has(envLevel)
        ? envLevel
        : "info";

  const pinoOptions: LoggerOptions = {
    level,
    base: { component: options.component },
    formatters: {
      // Every merge object is deep-redacted: sensitive keys are blanked,
      // free text is scanned for credential shapes, depth and length are
      // bounded so a hostile structure cannot hang or flood the logger.
      log(object: Record<string, unknown>): Record<string, unknown> {
        return redactObject(object) as Record<string, unknown>;
      },
    },
    hooks: {
      // The message string itself gets the same credential scan.
      logMethod(args: Parameters<Logger["info"]>, method): void {
        const sanitized = args.map((argument) =>
          typeof argument === "string" ? redactSecretsInText(argument) : argument,
        ) as Parameters<Logger["info"]>;
        method.apply(this, sanitized);
      },
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}
