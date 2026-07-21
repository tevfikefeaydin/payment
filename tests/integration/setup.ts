import { afterAll, beforeEach } from "vitest";
import { closeTestDb, resetDatabase } from "./helpers";

/**
 * Per-file setup: every test starts from an empty database, so tests cannot
 * depend on each other's leftovers and a failure cannot cascade.
 */
beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestDb();
});
