# Testing Strategy — Master

AstriX ships a backend and a frontend that are tested very differently on purpose, and understanding *why* they diverge is more useful than memorizing either one in isolation. This file is the map: what exists, why it's shaped this way, and which deep-dive to open next.

## 1. The Landscape, briefly

Three shapes show up repeatedly when people describe how a test suite *should* be distributed across layers:

- **The testing pyramid** (Mike Cohn): many fast unit tests at the base, fewer integration tests in the middle, a thin layer of slow end-to-end tests at the top. The classic argument is cost and feedback speed — a unit test fails in milliseconds and points at one function; an E2E test fails in seconds-to-minutes and could be lying about *where* the bug is.
- **The testing trophy** (Kent C. Dodds, popularized alongside React Testing Library): shrinks the unit layer, fattens the integration layer, on the theory that integration tests give the best confidence-per-dollar — they exercise real collaborators instead of mocks, without paying full E2E cost.
- **The ice-cream cone** (anti-pattern, common in legacy systems): top-heavy — lots of slow, flaky manual/E2E tests and almost no unit tests, usually because unit testing was never built into the culture and E2E became the only trusted signal.

AstriX's backend is closer to a pyramid with a deliberately thick integration layer — the numbers below show that shape. Its frontend is unit/component-heavy with no E2E layer at all, which §7's dive addresses honestly rather than glossing over.

## 2. What actually exists, by the numbers

| | Backend (`backend/tests/`) | Frontend (`client/src/**/__tests__/`) |
|---|---|---|
| Test files | 46 | 22 |
| Runner | Vitest (`vitest run`) | Vitest (`vitest run`) |
| Environment | `node` | `jsdom` |
| Layers | `unit/` (25 files: services, controllers, models, utils, middlewares, providers, config), `integration/` (5 files, real in-memory Mongo), `e2e/` (6 files, real Express app + supertest) | Component/hook tests only — no separate integration or E2E directories |
| DB in tests | `mongodb-memory-server` (`MongoMemoryReplSet`) | N/A (no database in the browser) |
| Coverage gate | Yes — v8 provider, thresholds enforced in CI | No coverage threshold configured |
| Browser-level E2E | None (Playwright/Cypress not present) | None |

Source of the file counts:

```
$ find backend/tests -name "*.test.ts" | wc -l
46
$ find client/src -iname "*.test.*" | wc -l
22
```

## 3. Backend: vitest.config.ts, in full

`backend/vitest.config.ts`:

```typescript
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

    // How long a single test is allowed to run before Vitest kills it and fails it.
    // DB operations against mongodb-memory-server are usually fast, but the FIRST
    // test in a run pays the cost of downloading/booting the in-memory binary,
    // so we give generous headroom.
    testTimeout: 20000,
    hookTimeout: 20000,

    // Thresholds set once real coverage existed to compare against - full
    // suite currently sits around 99% statements/lines, ~95% branches.
    // Thresholds are set a bit below that so normal future work has
    // headroom, while still failing the build if coverage regresses
    // meaningfully.
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
```
*`backend/vitest.config.ts:1-49`*

The `setupFiles` ordering comment is worth internalizing before reading any individual test: `testEnv.setup.ts` populates `process.env` with fake-but-shaped-like-production secrets (JWT keys, cookie config, Google OAuth placeholders) so that `src/config/app.config.ts` — which fails fast on missing env vars by design — doesn't throw the moment any test file transitively imports it. `vitest.setup.ts` then boots a real, disposable MongoDB.

## 4. Backend: the shared in-memory database, in full

`backend/tests/setup/vitest.setup.ts`:

```typescript
import { beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";

let mongod: MongoMemoryReplSet;

// Tracks which models we've already forced into existence, so we don't
// redo this work before every single test - just the first time each
// model shows up.
const initializedModels = new Set<string>();

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
});

// NEW: runs before every test. By the time THIS fires, the test file's own
// top-level imports (which register models like RoleModel, UserModel, etc.
// via `mongoose.model(...)`) have already executed - so mongoose.modelNames()
// is populated here, unlike in beforeAll above, which runs before the test
// file's imports resolve.
//
// `.init()` explicitly creates the collection and builds its indexes RIGHT
// NOW, as a plain (non-transactional) operation. That's the whole fix: it
// guarantees "does this collection exist" is already answered before any
// transaction gets anywhere near it, so the transaction never hits the
// implicit-creation-triggers-a-lock-wait path that was failing.
beforeEach(async () => {
  const pending = mongoose
    .modelNames()
    .filter((name) => !initializedModels.has(name));
  await Promise.all(
    pending.map(async (name) => {
      await mongoose.model(name).init();
      initializedModels.add(name);
    })
  );
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
```
*`backend/tests/setup/vitest.setup.ts:1-45`*

Note `MongoMemoryReplSet` rather than the simpler single-node `MongoMemoryServer` — AstriX's services use multi-document transactions in places (see the backend module's database-transactions dive), and MongoDB only supports transactions against a replica set, even a one-node one. This is a real, non-obvious integration-testing decision covered in depth in file 02.

## 5. The three backend layers, one representative test each

**Unit** (`backend/tests/unit/services/auth.service.test.ts`) — every Mongoose model mocked, JWT utilities left real because they're pure:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import crypto from "crypto";

import {
  createSessionService,
  registerUserService,
  verifyUserService,
  // ...
} from "../../../src/services/auth.service";

import UserModel from "../../../src/models/user.model";
import AccountModel from "../../../src/models/account.model";
// ... every model this service touches, imported so it can be mocked
```
*`backend/tests/unit/services/auth.service.test.ts:1-51` (excerpt)*

**Integration** (`backend/tests/integration/auth.service.integration.test.ts`) — no mocks, real hashing, real Mongo:

```typescript
describe("auth.service (integration - real in-memory MongoDB)", () => {
  beforeEach(async () => {
    await RoleModel.create({ name: Roles.OWNER, permissions: [] });
  });

  it("REGISTER -> LOGIN roundtrip: the password set at registration actually verifies at login", async () => {
    const { userId, workspaceId } = await registerUserService({
      email: "roundtrip@example.com",
      name: "Roundtrip User",
      password: "Correc@123",
    });

    expect(userId).toBeDefined();
    expect(workspaceId).toBeDefined();

    const rawUser = await UserModel.findById(userId).select("+password");
    expect(rawUser!.password).not.toBe("Correc@123");

    const loggedInUser = await verifyUserService({
      email: "roundtrip@example.com",
      password: "Correc@123",
    });
    expect(String(loggedInUser._id)).toBe(String(userId));
    expect((loggedInUser as any).password).toBeUndefined();
  });
```
*`backend/tests/integration/auth.service.integration.test.ts:36-63` (excerpt)*

The test file's own header comment states the reason this layer exists at all better than any external explanation could: *"Unit tests mock `user.comparePassword()` to return true/false on command — they can NEVER catch a bug where your bcrypt hashing or comparison logic is actually broken."*

**E2E** (`backend/tests/e2e/auth.routes.e2e.test.ts`) — a real Express app, mounted through the production `authenticate` and `errorHandler` middleware, driven by `supertest`. Full treatment, including the `buildRoutedApp`/`createAuthenticatedUser` helpers, is in file 03.

## 6. Frontend: vite.config.ts test block, in full

`client/vite.config.ts`:

```typescript
import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.ANALYZE
      ? [
          visualizer({
            filename: "dist/stats.html",
            gzipSize: true,
            open: true,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
```
*`client/vite.config.ts:1-31`*

`client/src/test/setup.ts`, in full:

```typescript
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
```
*`client/src/test/setup.ts:1-7`*

No `coverage` block exists here — that asymmetry with the backend is real and is covered honestly in file 05, not smoothed over.

## 7. The CI gate: `pr-check.yml`

Three jobs run on every PR into `main`:

```yaml
jobs:
  secret-scan:
    name: Secret Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  check-backend:
    name: Backend Build Check
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Type-check & build
        run: npm run build
      - name: Test (coverage-gated)
        run: npm run test:coverage
      - name: Build Docker image (not pushed)
        run: docker build -t astrix-backend:pr-${{ github.event.pull_request.number }} .
      - name: Scan image for vulnerabilities
        uses: aquasecurity/trivy-action@0.24.0
        with:
          image-ref: astrix-backend:pr-${{ github.event.pull_request.number }}
          severity: CRITICAL,HIGH
          exit-code: '1'
          ignore-unfixed: true

  check-frontend:
    name: Frontend Build Check
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: client/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Lint
        run: npm run lint
      - name: Test
        run: npm run test
      - name: Build (with placeholder API URL)
        run: npm run build
        env:
          VITE_API_BASE_URL: https://placeholder.example.com
```
*`.github/workflows/pr-check.yml:1-77`*

Two asymmetries worth flagging up front, both covered in depth further into the module: `check-backend` runs `test:coverage` (the threshold-gated script) while `check-frontend` runs plain `test` — only the backend can fail a PR on a coverage regression. And the backend job also builds and Trivy-scans a real Docker image inline, tying container security scanning into the same job that runs the test suite — file 08 traces how this connects to the infra module's own image-scanning story.

## 8. Tech-stack table

| Concern | Backend | Frontend |
|---|---|---|
| Test runner | Vitest | Vitest |
| Environment | Node | jsdom |
| Assertion style | Vitest `expect` (Jest-compatible) | Vitest `expect` + `@testing-library/jest-dom` matchers |
| Component/DOM testing | N/A | `@testing-library/react`, `@testing-library/user-event` |
| Mocking | `vi.mock` on Mongoose models; hand-built `createMockReqRes` req/res spies | `vi.mock` per test file |
| Database in tests | `mongodb-memory-server` (`MongoMemoryReplSet`) | N/A |
| HTTP-layer testing | `supertest` against a real Express app | N/A (no MSW, no network layer tested) |
| Coverage | v8 provider, CI-enforced thresholds | Not configured |
| Browser E2E | N/A (no Playwright/Cypress anywhere in the repo) | None |
| Security/supply-chain scanning | gitleaks (secrets), Trivy (container image) — both in `pr-check.yml` | Same `pr-check.yml`; also tfsec for Terraform in `infra.yml` |

## 9. Where to go next

- **01 — Backend Unit Testing** — the mocking shapes, the London/Chicago tradeoff, why JWT utilities are deliberately *not* mocked.
- **02 — Backend Integration Testing** — `MongoMemoryReplSet` in depth, the `.init()` race fix, what integration tests catch that unit tests structurally cannot.
- **03 — Backend E2E and API Testing** — `buildRoutedApp`, `createAuthenticatedUser`, testing through real middleware instead of stand-ins.
- **04 — Test Doubles, Fixtures, and Test Data** — the `buildFake*` factory pattern, the `asConstructorMock` `[[Construct]]` gotcha, chainable `res` spies.
- **05 — Coverage Thresholds and CI Test Gates** — what a threshold actually buys you, why frontend doesn't have one, mutation testing as the road not taken.
- **06 — Frontend Component and Hook Testing** — RTL query philosophy, the global `cleanup`/`clearAllMocks` setup, representative component and hook tests.
- **07 — Frontend Testing Gaps and E2E Considerations** — no Playwright/Cypress, no MSW, no coverage gate: named honestly, with what each would buy.
- **08 — Security Testing and Scanning** — gitleaks, Trivy, tfsec, Dependabot, and the DAST/pen-testing gap, tying the testing module to the infra module's own security-scanning dive.
