import { defineConfig } from "vitest/config";

// This file lives at your PROJECT ROOT (same level as package.json), not
// inside /src or /tests. Vitest auto-detects it there.
//
// Post Phase-6 cutover (backend/migrations/phase-6-cutover-and-cleanup.md):
// this is now the ONLY test suite - the app is Postgres/Redis end to end,
// so this runs against real testcontainers Postgres/Redis rather than
// mongodb-memory-server.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",

    // Boots real Postgres 16 + Redis 7 containers once for the whole run
    // and publishes DATABASE_URL/REDIS_URL into process.env for every test
    // file - see tests/setup/global-setup.ts for why this has to be a
    // `globalSetup`, not a per-file `setupFiles` entry.
    globalSetup: ["./tests/setup/global-setup.ts"],

    // ORDER MATTERS: test-env.setup.ts sets the non-container env vars
    // (JWT secrets, frontend URLs, ...) that src/config/app.config.ts needs
    // at import time; reset-between-tests.ts then truncates Postgres tables
    // and flushes Redis before every single test so tests never see another
    // test's leftover rows/keys.
    setupFiles: [
      "./tests/setup/test-env.setup.ts",
      "./tests/setup/reset-between-tests.ts",
    ],

    // Real containers + real network round trips per test are slower than
    // an in-memory double; containers only cold-start once (globalSetup),
    // but individual tests still pay real Postgres/Redis round-trip cost.
    testTimeout: 30000,
    hookTimeout: 60000,
    teardownTimeout: 60000,

    // All test files share the SAME Postgres/Redis containers (started once
    // in globalSetup), and reset-between-tests.ts's TRUNCATE/FLUSHALL would
    // otherwise race across files running against that shared state in
    // parallel - so files run one at a time, not across worker threads.
    fileParallelism: false,

    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/@types/**",
        "src/docs/**",
        "src/db/migrations/**",
        "src/db/seed-roles.ts",
        "src/index.ts",
        "src/config/swagger.config.ts",
        // Network-dependent OAuth code exchange - no live Google double to
        // test against.
        "src/providers/google.provider.ts",
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
