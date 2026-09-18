/**
 * Runs before every test in the pg/redis suite. The Postgres and Redis
 * containers are shared across the whole run (booting one per test file
 * would dominate the run time), so each test needs a clean slate instead -
 * this is the testcontainers-suite equivalent of `tests/setup/vitest.setup.ts`
 * dropping in-memory Mongo collections between tests.
 *
 * `roles` is seeded once by global-setup.ts and deliberately NOT truncated
 * here - every pg service assumes OWNER/ADMIN/MEMBER already exist, exactly
 * like production's seed-roles.ts guarantees before the app ever serves a
 * request.
 */
import { beforeEach } from "vitest";
import { db } from "../../src/db/client";
import { redis } from "../../src/redis/client";

export const resetDatabase = async (): Promise<void> => {
  await db.execute(
    `TRUNCATE TABLE tasks, accounts, workspace_members, projects, workspaces, users RESTART IDENTITY CASCADE`
  );
};

export const resetRedis = async (): Promise<void> => {
  await redis.flushall();
};

beforeEach(async () => {
  await resetDatabase();
  await resetRedis();
});
