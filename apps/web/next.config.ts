import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import type { NextConfig } from "next";

/**
 * The monorepo keeps a single `.env` at its root. Next only auto-loads `.env`
 * from the application directory, so the root file is loaded explicitly here —
 * the same thing `apps/worker` does at startup, so both tiers read one file.
 */
loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/**
 * Next.js configuration.
 *
 * Workspace packages export TypeScript source directly (no build step), so they
 * must be transpiled by Next rather than consumed as pre-built JavaScript.
 */
const config: NextConfig = {
  reactStrictMode: true,

  transpilePackages: [
    "@payrecon/auth",
    "@payrecon/config",
    "@payrecon/db",
    "@payrecon/domain",
    "@payrecon/jobs",
    "@payrecon/notifications",
    "@payrecon/platform-billing",
    "@payrecon/stripe-customer-data",
  ],

  // Never leak framework details or source paths to a browser in production.
  poweredByHeader: false,
  productionBrowserSourceMaps: false,

  serverExternalPackages: ["pg", "pg-boss", "nodemailer", "stripe"],

  /**
   * Production-safe response headers.
   *
   * The CSP is deliberately strict: no third-party script origins are needed
   * because the application ships no external scripts, fonts or analytics.
   * `'unsafe-inline'` is required for styles because Tailwind's runtime and
   * Next's inlined critical CSS both emit style attributes.
   */
  async headers() {
    const scriptSources = ["'self'", "'unsafe-inline'"];
    if (process.env.NODE_ENV === "development") {
      scriptSources.push("'unsafe-eval'");
    }

    const csp = [
      "default-src 'self'",
      // Next injects a small inline bootstrap script; nonce-based CSP is not
      // yet expressible for it in a static header, so scripts stay same-origin.
      `script-src ${scriptSources.join(" ")}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default config;
