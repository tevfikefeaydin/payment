# 0001 — Toolchain and version pinning

**Status:** Accepted

## Context

A monorepo with ten workspace packages plus two applications will drift if each
package declares its own dependency versions. Two packages resolving different
minor versions of `drizzle-orm` or `zod` produces type incompatibilities that
appear as baffling errors far from their cause.

There is also a specific, live incompatibility in the current registry. The
latest published `typescript` is **7.0.2**. The latest `typescript-eslint` (8.x)
declares a peer range of `typescript: >=4.8.4 <6.1.0`. Installing TypeScript 7
does not fail loudly — it produces a peer warning, after which typescript-eslint
either refuses to parse or silently degrades. Linting would appear to pass while
checking far less than intended, which is the worst possible failure mode for a
tool whose entire job is catching mistakes.

The build machine had no Node.js, no package manager, no Docker and no
PostgreSQL. Whatever was chosen had to be installable as portable binaries and
reproducible by a script.

## Decision

**Centralise every version in the pnpm catalog.** `pnpm-workspace.yaml` declares
a `catalog:` block and every workspace package references `catalog:` instead of a
literal version. A version is defined exactly once for the whole monorepo, and
upgrading is a one-line change reviewed in one place.

**Pin TypeScript to 5.9.3, not 7.0.2.** typescript-eslint 8 requires `<6.1.0`.
Between "newest TypeScript" and "linting that actually works", working lint wins.
The alternative — abandoning typescript-eslint, or running it against an
unsupported compiler — trades a mechanically enforced set of invariants
(including the money-safety and Stripe-context rules in `eslint.config.js`) for a
version number.

Chosen versions:

| Tool                | Version          | Note                                                      |
| ------------------- | ---------------- | --------------------------------------------------------- |
| Node.js             | 24.18.0          | `engines.node: ">=22.0.0"`; portable zip in `.toolchain/` |
| pnpm                | 10.34.5          | `packageManager` field; installed via npm                 |
| TypeScript          | 5.9.3            | **Deliberately not 7.x** — see above                      |
| ESLint              | 9.39.5           | Flat config                                               |
| typescript-eslint   | 8.64.0           | Requires TypeScript `<6.1.0`                              |
| PostgreSQL          | 17.6             | Portable binaries, cluster in `.toolchain/pgdata`         |
| Next.js / React     | 16.2.10 / 19.2.7 |                                                           |
| Drizzle ORM / Kit   | 0.45.2 / 0.31.10 |                                                           |
| pg-boss             | 12.26.1          | Named export, not default, in v12                         |
| Vitest / Playwright | 4.1.10 / 1.61.1  |                                                           |
| Zod                 | 4.4.3            |                                                           |

**Bootstrap the toolchain into `.toolchain/`**, which is git-ignored, and make
`scripts/setup-local.ps1` reproduce it idempotently.

## Consequences

**Good.**

- One place to review a dependency bump; no cross-package version skew.
- Linting genuinely runs, so `eslint.config.js` can carry architectural
  invariants — banning `Math.round` on money, forbidding the two Stripe packages
  from importing each other — that would otherwise be documentation nobody
  enforces.
- A clean machine can be brought to a working state by one script.
- Reproducible CI: `pnpm install --frozen-lockfile` resolves exactly what was
  developed against.

**Costs.**

- TypeScript 5.9.3 lags the registry. Newer language features are unavailable
  until typescript-eslint widens its peer range. This must be revisited whenever
  typescript-eslint publishes support for TypeScript 6 or 7 — the pin is a
  compatibility decision, not a preference, and should not outlive its reason.
- The catalog adds indirection: reading a package's `package.json` no longer tells
  you the version, and you must look at `pnpm-workspace.yaml`.
- `.toolchain/` binaries are large and machine-specific. They are git-ignored, so
  a new contributor pays the bootstrap cost once.
- Dependabot cannot update catalog entries the way it updates ordinary ranges;
  catalog bumps are a manual, deliberate step.

## Alternatives considered

**Per-package versions with a "keep them in sync" convention.** Rejected: this is
exactly the discipline that fails silently under time pressure.

**Adopt TypeScript 7 and drop typescript-eslint.** Rejected: it would remove the
only mechanical enforcement of the money and Stripe-context invariants.

**Adopt TypeScript 7 and keep typescript-eslint anyway.** Rejected: an unsupported
peer combination that lints less than it appears to is worse than an older
compiler that lints correctly.
