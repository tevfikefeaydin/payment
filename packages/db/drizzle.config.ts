import { defineConfig } from "drizzle-kit";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// Migrations are generated from the repository root's .env so that a developer
// never has to duplicate connection settings.
//
// drizzle-kit bundles this config before evaluating it, so `import.meta.dirname`
// is not reliable here. drizzle-kit always runs with the package directory as
// the working directory, which is.
loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env before generating or applying migrations.",
  );
}

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  // Keep generated SQL reviewable: no destructive statements without a prompt.
  strict: true,
  verbose: true,
});
