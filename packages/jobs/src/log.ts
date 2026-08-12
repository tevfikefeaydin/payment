import { createLogger, type Logger } from "@payrecon/observability";

/**
 * Lazy singleton so importing this package (the web tier imports the enqueue
 * helpers) does not construct a logger until something actually logs.
 */
let logger: Logger | null = null;

export function jobsLogger(): Logger {
  if (!logger) logger = createLogger({ component: "jobs" });
  return logger;
}
