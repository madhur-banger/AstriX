/**
 * GLOBAL SETUP: real Postgres + Redis via testcontainers
 * -------------------------------------------------------
 * Runs once before the whole `vitest.pg.config.ts` suite (integration, e2e,
 * and unit tests alike). Starts a throwaway Postgres 16 and Redis 7
 * container each, runs the real Drizzle migrations against the Postgres
 * one, seeds the `roles` table (every pg service assumes OWNER/ADMIN/MEMBER
 * already exist, same as production's `seed-roles.ts`), then publishes
 * DATABASE_URL/REDIS_URL into process.env.
 *
 * Vitest injects env vars set here into every test file's process.env
 * (worker threads and forked processes both inherit it) - see
 * https://vitest.dev/config/#globalsetup. This must run BEFORE any test
 * file imports src/db/client.ts or src/redis/client.ts, since both modules
 * read DATABASE_URL/REDIS_URL and open their connection at import time.
 */
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "path";
import { RolePermissions } from "../../src/utils/role-permission";
import * as schema from "../../src/db/schema";

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;

const seedRoles = async (connectionString: string): Promise<void> => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  for (const [name, permissions] of Object.entries(RolePermissions)) {
    await db
      .insert(schema.roles)
      .values({ name: name as keyof typeof RolePermissions, permissions })
      .onConflictDoNothing({ target: schema.roles.name });
  }

  await pool.end();
};

export default async function setup(): Promise<() => Promise<void>> {
  [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16").start(),
    new GenericContainer("redis:7").withExposedPorts(6379).start(),
  ]);

  const databaseUrl = postgresContainer.getConnectionUri();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const migrationPool = new Pool({ connectionString: databaseUrl });
  const migrationDb = drizzle(migrationPool);
  await migrate(migrationDb, {
    migrationsFolder: path.resolve(__dirname, "../../src/db/migrations"),
  });
  await migrationPool.end();

  await seedRoles(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;

  return async () => {
    await Promise.all([postgresContainer.stop(), redisContainer.stop()]);
  };
}
