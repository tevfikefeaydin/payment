/**
 * Centralised public product metadata.
 *
 * The specification requires the product name to be renameable from one place.
 * Nothing outside this file should hard-code the string "PayRecon" — import
 * `PRODUCT` instead. This module is safe to import from browser code: it must
 * never contain secrets.
 */
export const PRODUCT = {
  /** Public product name, shown in UI chrome, emails and page titles. */
  name: "PayRecon",
  /** Lowercase machine-safe identifier used in cookie names and log fields. */
  slug: "payrecon",
  /** One-line primary promise used as the marketing hero headline. */
  tagline: "Catch payment bugs before they become lost revenue.",
  /** Supporting message shown beneath the tagline. */
  description: "Monitor Stripe and your application's payment records from one exception inbox.",
  /** Short description used in metadata and social cards. */
  shortDescription:
    "Reconciliation and payment reliability monitoring for small software companies.",
  /** Support contact surfaced in the UI and transactional email footers. */
  supportEmail: "support@payrecon.local",
  /** Company/legal entity name shown in footers. */
  legalName: "PayRecon",
} as const;

/** Name of the session cookie. Derived from the product slug. */
export const SESSION_COOKIE_NAME = `${PRODUCT.slug}_session`;

/** Name of the CSRF cookie. Derived from the product slug. */
export const CSRF_COOKIE_NAME = `${PRODUCT.slug}_csrf`;

/** Name of the cookie remembering the last active organization. */
export const ACTIVE_ORG_COOKIE_NAME = `${PRODUCT.slug}_org`;
