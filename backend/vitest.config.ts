import { defineConfig } from "vitest/config";

// This file lives at your PROJECT ROOT (same level as package.json),
// not inside /src or /tests. Vitest auto-detects it there.
export default defineConfig({
  test: {
    // "globals: true" means you don't have to `import { describe, it, expect } from "vitest"`
    // in every single file - they become available like Jest's global style.
    // (We still import them explicitly in the examples below for clarity - it's
    // considered better practice because your editor can autocomplete/typecheck them.)
    globals: true,

    // We're testing a Node/Express backend, not browser code, so environment = "node".
    environment: "node",

    // Runs once before the whole suite starts (and its afterAll runs once after
    // everything finishes). This is where we boot the in-memory MongoDB.
    // ORDER MATTERS: testEnv.setup.ts sets process.env values that
    // src/config/app.config.ts needs at import time. It must run BEFORE
    // vitest.setup.ts (and before any test file's own imports resolve).
    setupFiles: [
      "./tests/setup/testEnv.setup.ts",
      "./tests/setup/vitest.setup.ts",
    ],

    // Vitest runs test files in parallel by default across worker processes.
    // For our in-memory Mongo setup (one shared instance) this is fine because
    // we clean collections between tests, but if you ever see weird cross-test
    // data bleed, the first thing to try is forcing single-threaded execution:
    // pool: "threads",
    // poolOptions: { threads: { singleThread: true } },

    // How long a single test is allowed to run before Vitest kills it and fails it.
    // DB operations against mongodb-memory-server are usually fast, but the FIRST
    // test in a run pays the cost of downloading/booting the in-memory binary,
    // so we give generous headroom.
    testTimeout: 20000,
    hookTimeout: 20000,

    // Thresholds set once real coverage existed to compare against (see
    // backend/PLAN.md) - full suite currently sits around 99% statements/
    // lines, ~95% branches. Thresholds are set a bit below that so normal
    // future work has headroom, while still failing the build if coverage
    // regresses meaningfully.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/@types/**",
        "src/docs/**",
        "src/seeders/**",
        "src/index.ts",
        "src/config/database.config.ts",
        "src/config/swagger.config.ts",
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
