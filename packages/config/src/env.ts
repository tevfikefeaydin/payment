/**
 * Server-side environment validation.
 *
 * SECURITY: this module is server-only. It must never be imported from browser
 * code, and it must never print, log, or embed an environment VALUE in an error.
 * Validation failures report variable NAMES and a reason only.
 */
import { z } from "zod";

const nonEmpty = (name: string) =>
  z.string({ message: `${name} is required` }).min(1, `${name} must not be empty`);

/**
 * A 32-byte key, base64 encoded, used for AES-256-GCM.
 * Validated by decoding — length in characters is not a sufficient check.
 */
const base64Key32 = (name: string) =>
  nonEmpty(name).refine(
    (value) => {
      try {
        return Buffer.from(value, "base64").byteLength === 32;
      } catch {
        return false;
      }
    },
    {
      message: `${name} must be exactly 32 bytes, base64 encoded (generate: openssl rand -base64 32)`,
    },
  );

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65535);

/** True for URLs whose host is loopback, which browsers treat as secure. */
function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: nonEmpty("APP_URL").refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "APP_URL must be an absolute http(s) URL" },
  ),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: nonEmpty("DATABASE_URL").refine((v) => v.startsWith("postgres"), {
    message: "DATABASE_URL must be a postgres:// or postgresql:// connection string",
  }),
  TEST_DATABASE_URL: z.string().optional(),

  AUTH_SECRET: nonEmpty("AUTH_SECRET").min(32, "AUTH_SECRET must be at least 32 characters"),
  /**
   * When false, creating an account requires a pending invitation for that
   * email address. Existing accounts and invitation redemption are unaffected.
   */
  ALLOW_PUBLIC_SIGNUP: booleanish.default(true),
  SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(604_800),

  ENCRYPTION_KEY: base64Key32("ENCRYPTION_KEY"),
  ENCRYPTION_KEY_ID: nonEmpty("ENCRYPTION_KEY_ID").max(32),
  ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  ENCRYPTION_KEY_PREVIOUS_ID: z.string().optional(),

  STRIPE_CUSTOMER_TRANSPORT: z.enum(["live", "fake"]).default("live"),
  STRIPE_CUSTOMER_RATE_LIMIT_RPS: z.coerce.number().int().positive().max(100).default(8),

  PLATFORM_STRIPE_SECRET_KEY: z.string().optional(),
  PLATFORM_STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PLATFORM_STRIPE_PRICE_STARTER: z.string().optional(),
  PLATFORM_STRIPE_PRICE_GROWTH: z.string().optional(),
  PLATFORM_STRIPE_PRICE_SCALE: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanish.default(false),
  EMAIL_FROM: z.string().default("PayRecon <notifications@payrecon.local>"),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
  /** Port for the worker's liveness/readiness endpoints. */
  WORKER_HEALTH_PORT: port.default(3001),
  RECONCILIATION_SCHEDULE_CRON: z.string().default("0 * * * *"),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `See .env.example for the expected variables. Values are never printed.`,
    );
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

let cached: Env | null = null;

/**
 * Parse and cache the environment.
 *
 * @throws {EnvValidationError} listing variable names and reasons, never values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report the failing variable NAME and message only. `issue.input` is
    // deliberately never referenced so a secret cannot leak into a stack trace.
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(root)";
      return `${name}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }

  const env = result.data;

  // Cross-field rules that zod cannot express in isolation.
  const extra: string[] = [];
  if (env.ENCRYPTION_KEY_PREVIOUS && !env.ENCRYPTION_KEY_PREVIOUS_ID) {
    extra.push("ENCRYPTION_KEY_PREVIOUS_ID: required when ENCRYPTION_KEY_PREVIOUS is set");
  }
  if (env.ENCRYPTION_KEY_PREVIOUS) {
    try {
      if (Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, "base64").byteLength !== 32) {
        extra.push("ENCRYPTION_KEY_PREVIOUS: must be exactly 32 bytes, base64 encoded");
      }
    } catch {
      extra.push("ENCRYPTION_KEY_PREVIOUS: must be valid base64");
    }
  }
  if (env.ENCRYPTION_KEY_PREVIOUS_ID && env.ENCRYPTION_KEY_PREVIOUS_ID === env.ENCRYPTION_KEY_ID) {
    extra.push("ENCRYPTION_KEY_PREVIOUS_ID: must differ from ENCRYPTION_KEY_ID");
  }
  if (
    env.NODE_ENV === "production" &&
    env.APP_URL.startsWith("http://") &&
    !isLoopbackUrl(env.APP_URL)
  ) {
    // Loopback is exempt: browsers treat http://localhost and http://127.0.0.1
    // as secure contexts, and the end-to-end suite runs a production build
    // against loopback. Any other plaintext host in production is a real risk,
    // because the session cookie would travel unencrypted.
    extra.push("APP_URL: must use https in production (secure cookies require it)");
  }
  if (env.PLATFORM_STRIPE_SECRET_KEY && !env.PLATFORM_STRIPE_WEBHOOK_SECRET) {
    extra.push(
      "PLATFORM_STRIPE_WEBHOOK_SECRET: required when PLATFORM_STRIPE_SECRET_KEY is set (webhooks must be signature-verified)",
    );
  }
  if (
    env.PLATFORM_STRIPE_SECRET_KEY &&
    !/^sk_(test|live)_/.test(env.PLATFORM_STRIPE_SECRET_KEY) &&
    !/^rk_(test|live)_/.test(env.PLATFORM_STRIPE_SECRET_KEY)
  ) {
    extra.push(
      "PLATFORM_STRIPE_SECRET_KEY: must be a Stripe secret key for PayRecon's own account",
    );
  }

  if (extra.length > 0) throw new EnvValidationError(extra);

  cached = env;
  return env;
}

/** Reset the cache. Used by tests only. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Startup readiness check. Returns a structured result instead of throwing so
 * that health endpoints can report status without leaking configuration.
 */
export function checkEnv(source: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  problems: string[];
} {
  try {
    loadEnv(source);
    return { ok: true, problems: [] };
  } catch (error) {
    if (error instanceof EnvValidationError) return { ok: false, problems: error.problems };
    return { ok: false, problems: ["environment could not be validated"] };
  }
}

/** True when PayRecon's own billing is configured. */
export function isPlatformBillingConfigured(env: Env = loadEnv()): boolean {
  return Boolean(env.PLATFORM_STRIPE_SECRET_KEY && env.PLATFORM_STRIPE_WEBHOOK_SECRET);
}

/** True when a real SMTP transport is configured (otherwise: console transport). */
export function isSmtpConfigured(env: Env = loadEnv()): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_HOST.length > 0);
}
