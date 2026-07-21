/**
 * Developer smoke check for the reconciliation core.
 *
 * Seeds the demo dataset into a scratch organization, runs reconciliation
 * through the production engine and persistence path, and prints which rules
 * fired. Also re-runs to prove idempotency. Intended to be run by hand:
 *
 *   pnpm --filter @payrecon/db exec tsx src/verify-core.ts
 *
 * The scratch organization is removed at the end.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client";
import { users } from "./schema/auth";
import { exceptions } from "./schema/reconciliation";
import { createOrganization } from "./repositories/organizations";
import { purgeOrganization } from "./services/purge-organization";
import { seedDemoData } from "./services/demo-data";
import { runReconciliationForOrganization } from "./services/run-reconciliation";
import { countOpenBySeverity, revenueAtRiskByCurrency } from "./repositories/exceptions";
import { RECONCILIATION_RULE_IDS } from "@payrecon/domain";

async function main(): Promise<void> {
  loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const { db, pool } = createDatabase({ connectionString, maxConnections: 4 });
  let organizationId: string | null = null;
  let userId: string | null = null;

  try {
    const [user] = await db
      .insert(users)
      .values({
        email: `verify-core-${Date.now()}@example.test`,
        name: "Core Verifier",
        passwordHash: "scrypt$65536$8$1$AAAA$AAAA",
      })
      .returning({ id: users.id });
    if (!user) throw new Error("failed to create scratch user");
    userId = user.id;

    const org = await createOrganization(db, {
      name: `Core Verification ${Date.now()}`,
      ownerUserId: user.id,
    });
    organizationId = org.id;

    const seeded = await seedDemoData(db, { organizationId, actorUserId: user.id });
    console.warn("seeded:", JSON.stringify(seeded));

    const first = await runReconciliationForOrganization(db, {
      organizationId,
      trigger: "manual",
      triggeredByUserId: user.id,
    });
    console.warn(
      `run 1 -> created=${first.created} reopened=${first.reopened} unchanged=${first.unchanged}`,
    );

    // Every required rule must have produced at least one exception.
    const missing = RECONCILIATION_RULE_IDS.filter((rule) => !first.countsByRule[rule]);
    console.warn("rules fired:", JSON.stringify(first.countsByRule, null, 2));
    if (missing.length > 0) {
      console.error("RULES THAT DID NOT FIRE:", missing.join(", "));
    } else {
      console.warn("ALL 10 RULES FIRED");
    }

    // Idempotency: an identical second run must create nothing new.
    const second = await runReconciliationForOrganization(db, {
      organizationId,
      trigger: "manual",
      triggeredByUserId: user.id,
    });
    console.warn(
      `run 2 -> created=${second.created} reopened=${second.reopened} unchanged=${second.unchanged}`,
    );
    if (second.created !== 0) {
      console.error(`IDEMPOTENCY FAILURE: second run created ${second.created} exceptions`);
    } else {
      console.warn("IDEMPOTENT: second run created 0 new exceptions");
    }

    const severities = await countOpenBySeverity(db, organizationId);
    console.warn("open by severity:", JSON.stringify(severities));

    const risk = await revenueAtRiskByCurrency(db, organizationId);
    console.warn(
      "revenue at risk per currency:",
      risk.map((r) => `${r.currency}=${r.amountMinor.toString()} (${r.count})`).join(", "),
    );

    const total = await db
      .select({ id: exceptions.id })
      .from(exceptions)
      .where(eq(exceptions.organizationId, organizationId));
    console.warn(`total exceptions: ${total.length}`);
  } finally {
    if (organizationId) {
      // Uses the privileged purge path: an ordinary delete is blocked by the
      // append-only audit guard, which is exactly the intended behaviour.
      await purgeOrganization(db, organizationId);
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId));
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("verify-core failed:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
