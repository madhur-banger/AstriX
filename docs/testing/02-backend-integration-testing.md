> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

# Backend Integration Testing

The [master testing file](./00-master-testing-strategy.md) already showed you the shape of `backend/tests/setup/vitest.setup.ts` and named the headline fact: AstriX's integration layer runs against a real, ephemeral `MongoMemoryReplSet` rather than mocked Mongoose models. This file goes underneath that summary. The question here isn't "what does the setup file look like" — it's "what problem is a database-backed integration layer actually solving, what are the real alternatives for solving it, and exactly how does AstriX's specific choice work, line by line, including the one race condition it had to be patched to avoid." [`08-database-queries-and-transactions.md`](../backend/08-database-queries-and-transactions.md) covers the same `vitest.setup.ts` file from the *database* angle — why transactions need a replica set at all. This file covers it from the *testing-strategy* angle: why this particular test-database architecture, what it costs, what it catches that a mocked test structurally cannot, and where to look when it breaks.

---

## 1. The Landscape

Any application that talks to a real database eventually has to answer an uncomfortable question in its test suite: unit tests that mock the database prove your code *calls* the database correctly, but they can never prove the database actually *does what you assume* in response. A mocked `UserModel.findOne` returns whatever you told it to return — it has no opinion on whether your query filter is spelled correctly, whether a schema default actually fires, or whether a `select: false` field really gets excluded. Something in the test suite has to talk to a real (or real-enough) database to close that gap. The industry has converged on a handful of named strategies for doing this, each with a real cost.

**(a) A fully in-memory / embedded database.** Boot a real instance of the database engine, but a throwaway one that lives in a temp directory or entirely in RAM, with no external process to manage. For MongoDB, the standard library is `mongodb-memory-server`, which downloads a real `mongod` binary once and spins up a disposable instance per test run:

```ts
import { MongoMemoryServer } from "mongodb-memory-server";
const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri());
```

The relational equivalent is SQLite's `:memory:` mode — a full SQL engine that never touches disk:

```js
const db = new Database(":memory:");
```

Java shops reach for the same idea with H2 running in embedded/in-memory mode standing in for a real Postgres or MySQL instance in tests. The appeal is speed (no container to pull or boot) and zero external dependencies (no Docker daemon required, so it runs identically on a laptop and in CI) — but embedded engines are, almost by definition, not byte-for-byte the same binary as whatever runs in production. `mongodb-memory-server` genuinely does run real MongoDB server binaries rather than a from-scratch reimplementation, so the gap is smaller than it sounds, but the exact patch version it happens to download is a separate concern from whatever version Atlas is actually running in production — a source of quiet drift that's worth naming honestly rather than assuming away.

**(b) Testcontainers.** Rather than an embedded stand-in, boot the *actual* production database engine — the real Docker image, the exact version you deploy — in a throwaway container that lives for the duration of the test run and is torn down automatically afterward. This is the dominant "high-fidelity" pattern across Java, Node, and Go ecosystems as of 2026, largely because it eliminates the "is the embedded engine really equivalent" question entirely — you're not testing against a stand-in, you're testing against the same image you ship:

```ts
import { MongoDBContainer } from "@testcontainers/mongodb";
const container = await new MongoDBContainer("mongo:7.0").start();
await mongoose.connect(container.getConnectionString());
```

The tradeoff is real: every test run now needs a working Docker daemon, container pull/boot time is meaningfully slower than an in-process embedded server (seconds per container versus a binary that, once cached, starts in a few hundred milliseconds), and CI runners need Docker-in-Docker or a Docker socket mounted, which isn't free on every CI provider or pricing tier. For a team that already has Docker as a first-class CI citizen, this is usually considered the gold standard for fidelity. For a team optimizing for the fastest possible feedback loop with the fewest moving parts, it's a real cost to accept.

**(c) A shared or persistent test database.** Point every test run at one long-lived database instance — a dedicated "test" database on a shared server, or a container that's started once and reused across many runs — and rely on each test suite cleaning up its own data (via `afterEach` deletes, or wrapping each test in a transaction that's rolled back rather than committed) instead of tearing the whole database down and rebuilding it. This avoids paying any boot cost per run at all, but it introduces a class of bug that pure ephemeral instances structurally can't have: cross-run pollution. If one CI job crashes mid-suite and skips its cleanup, the *next* run inherits stale data, and now a failure in test B might actually be caused by a leftover row from test A's previous, unrelated run days earlier. It also creates operational risk that doesn't exist with an ephemeral database at all — a shared instance is a real, addressable resource that a misconfigured environment variable could point at by accident, which is a meaningfully different risk profile than a database that only exists inside one test process's memory for thirty seconds.

**(d) Mocking the database entirely, even at the integration layer.** Some suites label a test "integration" while still stubbing out every database call the way a unit test would — the test exercises multiple layers of application code together (a controller calling a service calling a repository, say) but never actually touches a database engine at any point. This is generally considered an anti-pattern specifically for this layer: the entire reason to write an integration test instead of another unit test is to verify the boundary with the real dependency, and mocking that boundary away removes the one thing the test was supposed to add. It's not that mocking is wrong in general — unit tests should absolutely mock the database — it's that calling a test "integration" while still mocking the actual database interaction is a mislabeling that gives a false sense of coverage: the suite reports green, but the exact class of bug integration tests exist to catch (a wrong field name, a broken schema default, a query that returns rows but not the *right* rows) sails through untested.

Each of these is a legitimate choice for some team; none of them is universally "correct." The right one depends on how much fidelity you need against production, how much Docker-in-CI costs your specific setup, and how large your test suite is (boot-cost-per-run matters a lot more at 500 test files than at 50).

---

## 2. AstriX's Choice

AstriX uses option (a) — `mongodb-memory-server`'s `MongoMemoryReplSet`, specifically, rather than the simpler single-node `MongoMemoryServer` — and it uses a **single shared instance across the entire integration-plus-e2e portion of the test run**, booted exactly once in a global `beforeAll` hook and cleaned between individual tests rather than being torn down and rebuilt for every test file. This means every integration test file in `backend/tests/integration/` (and every e2e test, which reuses the same setup) is really running against the *same* live in-memory MongoDB replica set for the whole `vitest run` invocation, with isolation between tests coming from data cleanup rather than from process-level isolation.

---

## 3. AstriX Implementation

### 3.1 The shared setup file, in full

Everything in this section is one file, registered as the second entry in `vitest.config.ts`'s `setupFiles` array (the ordering matters — covered in §4):

```ts
// backend/tests/setup/vitest.setup.ts:1-50 (in full)
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

Four hooks, four distinct jobs, and each one deserves to be understood on its own rather than glossed over as "test setup boilerplate."

**`beforeAll` — boot once, for the whole run.** `MongoMemoryReplSet.create({ replSet: { count: 1 } })` downloads (or reuses a cached copy of) a real `mongod` binary and starts it as a one-node replica set, then `mongoose.connect(mongod.getUri())` opens the single shared Mongoose connection every test file will use. Because this is a `beforeAll` at the top level of a setup file rather than something each test file repeats, it runs exactly once per `vitest run` invocation — not once per file, not once per test.

**`beforeEach` — the race-condition fix, explained mechanically.** This is the hook worth understanding at the level of *why*, not just *what*. MongoDB collections are created lazily by default: the first write to `db.someCollection` implicitly creates that collection (and, the first time a model is used, builds its indexes) if it doesn't already exist. That implicit creation is itself a server-side operation that takes a lock. Now put that inside a multi-document transaction: AstriX's transactional service functions (covered in depth in [`08-database-queries-and-transactions.md`](../backend/08-database-queries-and-transactions.md) §3.2 — `registerUserService`, `loginOrCreateAccountService`, `createWorkspaceService`, and others) open a session, call `session.startTransaction()`, and then issue writes like `user.save({ session })` against collections that, on a brand-new in-memory database, might not exist yet. If the *first* write MongoDB ever sees against a given collection happens to be a transactional one, the implicit collection-creation has to happen while a transaction is already in flight and holding locks — and that collection-creation-inside-a-transaction path is exactly where MongoDB can hit a lock-wait: the transaction is waiting on a metadata lock that the (also transactional) creation operation itself needs, a contention pattern that's fragile enough to surface as an intermittent timeout rather than a clean, repeatable failure. The fix sidesteps the whole problem rather than working around it: `mongoose.model(name).init()` is called as a **plain, non-transactional** operation, explicitly creating the collection and building its indexes before any test body — and therefore before any transaction — gets anywhere near it. By the time a test's own code opens a session and starts writing, "does this collection exist" has already been answered outside of any transaction, so the transaction never has to answer it itself. The `initializedModels` Set is a pure performance guard on top of that fix — it makes sure this `.init()` call happens once per model for the whole run, not on every single test, since `mongoose.modelNames()` only grows (models get registered by import, never unregistered) and re-initializing an already-initialized model would be redundant work repeated hundreds of times over a 46-file test suite.

It's worth being explicit about why this hook has to be `beforeEach` and not folded into the top-level `beforeAll`. `beforeAll` runs *before* any test file's own top-level imports have resolved — and it's those imports (`import UserModel from "../../src/models/user.model"`, and so on, at the top of every integration test file) that actually call `mongoose.model(...)` and register a model's name. `mongoose.modelNames()` inside `beforeAll` would see nothing, because nothing has been imported into the test yet. By the time `beforeEach` fires for the very first test, at least the current file's imports have already run, so the list of registered models is real and growing as more test files execute.

**`afterEach` — blanket cleanup.** After every single test, every collection currently attached to the connection gets `deleteMany({})`'d. This is a data-only wipe — it empties every collection's documents but does not drop the collection or its indexes, so the `.init()` work done in `beforeEach` never has to be redone. This is what provides test isolation on top of one shared, long-lived database instance: nothing about the database *process* resets between tests, but its *contents* do.

**`afterAll` — full teardown.** Once, at the very end of the whole run, the Mongoose connection is closed and the in-memory replica set process is stopped, releasing the resources it was holding for the duration of the suite.

### 3.2 Why `MongoMemoryReplSet`, specifically, and not `MongoMemoryServer`

This choice is not a stylistic preference — it's forced by a real constraint in how MongoDB implements transactions. MongoDB has supported multi-document ACID transactions since version 4.0, but only against a replica set (or a sharded cluster); a standalone `mongod` — which is exactly what the simpler `MongoMemoryServer` boots — cannot run `session.startTransaction()` at all. It will reject the attempt outright, because the underlying replication machinery a transaction relies on for its consistency guarantees simply isn't present on a single unreplicated node.

AstriX's services genuinely use `mongoose.startSession()`/`startTransaction()` in six real places — user registration, OAuth login-or-create, account deletion, workspace creation, and workspace deletion all wrap multiple collection writes in a single atomic transaction (the full inventory and code for each is in [`08-database-queries-and-transactions.md`](../backend/08-database-queries-and-transactions.md) §3.2). Every one of those code paths is exercised somewhere in `backend/tests/integration/`. If the test database were a `MongoMemoryServer` standalone instance, none of those transactional functions could even be called from a test without immediately throwing on `session.startTransaction()` — the most failure-prone code in the entire backend (multi-collection writes that must succeed or fail together) would be structurally impossible to integration-test at all, leaving it covered only by unit tests whose mocked sessions can't verify a real commit-or-abort actually happened against a real database. `{ replSet: { count: 1 } }` is the minimal topology that avoids this: one node is enough to satisfy MongoDB's "this must be a replica set" requirement for transactions, without paying the cost (or the added test flakiness surface) of standing up a multi-node cluster for every test run. Put plainly: this integration test module doesn't just test collection reads and writes — because of this one config choice, it's also the only layer in the whole test suite capable of exercising AstriX's transactional code paths against a database that can actually run a transaction.

### 3.3 Two real examples

**The auth register → login roundtrip.** This is the single test file whose own header comment states its purpose better than any summary could:

```ts
// backend/tests/integration/auth.service.integration.test.ts:1-14
/**
 * INTEGRATION TESTS: auth.service.ts
 * --------------------------------------
 * No mocking at all here - real Mongoose models against the in-memory DB.
 *
 * WHY THIS FILE MATTERS MORE THAN USUAL:
 * Unit tests mock `user.comparePassword()` to return true/false on command -
 * they can NEVER catch a bug where your bcrypt hashing or comparison logic
 * is actually broken (e.g. hashing twice, comparing against the wrong
 * field, a schema `select: false` on password silently returning
 * `undefined` to bcrypt.compare). Only a REAL register -> REAL login
 * roundtrip proves password auth actually works end to end. This is the
 * single most important integration test in your whole auth system.
 */
```

And the test itself:

```ts
// backend/tests/integration/auth.service.integration.test.ts:45-71
it("REGISTER -> LOGIN roundtrip: the password set at registration actually verifies at login", async () => {
  // This is the test that catches "the schema hashes on save but
  // comparePassword compares against the plaintext" type bugs - a
  // mistake that's invisible to any mocked unit test.
  const { userId, workspaceId } = await registerUserService({
    email: "roundtrip@example.com",
    name: "Roundtrip User",
    password: "Correc@123",
  });

  expect(userId).toBeDefined();
  expect(workspaceId).toBeDefined();

  // Confirm the password was NOT stored in plaintext - if this fails,
  // your pre-save hashing hook isn't running.
  const rawUser = await UserModel.findById(userId).select("+password");
  expect(rawUser!.password).not.toBe("Correc@123");

  // Now actually log in with the SAME password via the real service.
  const loggedInUser = await verifyUserService({
    email: "roundtrip@example.com",
    password: "Correc@123",
  });
  expect(String(loggedInUser._id)).toBe(String(userId));
  // omitPassword() should mean the password never comes back to the caller.
  expect((loggedInUser as any).password).toBeUndefined();
});
```

Notice what this test is actually verifying and why a mock can't: it calls the real `registerUserService`, which under the hood relies on a Mongoose pre-save hook to hash the password before it's written. It then reads the raw document back out of the real database — with `.select("+password")`, deliberately overriding the schema's default `select: false` on that field — and asserts the stored value is *not* the plaintext password. Then, separately, it calls the real `verifyUserService` with the same plaintext password and confirms the login succeeds. A unit test that mocks `UserModel` can be told to make this assertion pass regardless of whether the actual bcrypt hashing logic works; this test can only pass if hashing-on-save and comparison-at-login are both genuinely correct and genuinely compatible with each other, because both operations run against the same real document.

**Workspace creation, verified independently of its own return value.** From the workspace integration suite:

```ts
// backend/tests/integration/workspace.service.integration.test.ts:68-94
it("persists a real workspace document and links it via a real member document", async () => {
  // Act
  const { workspace } = await createWorkspaceService(userId, {
    name: "Integration Workspace",
    description: "created for real via mongoose",
  });

  // Assert: re-read from the DB independently of the function under test,
  // to prove the write actually landed (not just that the in-memory
  // return value looked right).
  const persistedWorkspace = await WorkspaceModel.findById(workspace._id);
  expect(persistedWorkspace).not.toBeNull();
  expect(persistedWorkspace!.name).toBe("Integration Workspace");
  // inviteCode has a `default: generateInviteCode` in the schema - verify
  // the default actually fired, since defaults are a common source of
  // "works in mocked tests, mysteriously null in prod" bugs.
  expect(persistedWorkspace!.inviteCode).toBeTruthy();

  const member = await MemberModel.findOne({ workspaceId: workspace._id });
  expect(member).not.toBeNull();
  expect(member!.userId.toString()).toBe(userId);

  const updatedUser = await UserModel.findById(userId);
  expect(updatedUser!.currentWorkspace?.toString()).toBe(
    workspace._id.toString()
  );
});
```

The test file's own header comment makes the same point this whole document is making, just about a different failure mode: *"If you get a filter field name wrong (e.g. `{ workspace: id }` instead of `{ workspaceId: id }`), a mocked test won't notice — YOU told the mock to return data for that exact call, so it happily does. A REAL query with a wrong field name just silently returns zero results, and only an integration test against a real DB will expose that."* This particular test doesn't just check the value `createWorkspaceService` returns — it re-queries three separate collections (`WorkspaceModel`, `MemberModel`, `UserModel`) independently of the function under test, to prove the writes actually landed in the database and not just that the in-memory object handed back to the caller happened to look correct. It also verifies a schema-level default (`inviteCode`'s `default: generateInviteCode`) actually fired, which is a category of bug a mock can never surface, since a mocked model has no schema to apply defaults from in the first place.

---

## 4. Request/Data Flow

Tracing exactly what happens, in order, when `npm run test` runs the integration suite (the script itself is `"test": "vitest run"` in `backend/package.json:11`, with no separate integration-only command — the integration files run as part of the same single Vitest invocation as everything else in `backend/tests/`):

1. **Vitest boots and reads `vitest.config.ts`.** It sees `setupFiles: ["./tests/setup/testEnv.setup.ts", "./tests/setup/vitest.setup.ts"]` and, critically, runs them **in that array order**, before loading any test file.
2. **`testEnv.setup.ts` runs first and populates `process.env`.** This file's own header comment explains why it has to go first: `src/config/app.config.ts` reads required environment variables (JWT secrets, cookie config, Google OAuth placeholders) at *import time*, via a strict env-var loader that's designed to fail fast on anything missing. The moment any test file imports something that transitively imports `app.config.ts` — which `jwt.ts`, `auth.service.ts`, and `auth.controller.ts` all do — that import would throw unless the right variables already exist in `process.env`. So this file sets fake, deterministic, harmless values for each one before anything else runs:

   ```ts
   // backend/tests/setup/testEnv.setup.ts:29-37
   // --- JWT ---
   process.env.JWT_ACCESS_TOKEN_SECRET = "test-access-token-secret";
   process.env.JWT_REFRESH_TOKEN_SECRET = "test-refresh-token-secret";
   process.env.JWT_ACCESS_TOKEN_EXPIRES_IN = "15m";
   process.env.JWT_REFRESH_TOKEN_EXPIRES_IN = "7d";

   // --- Cookies ---
   process.env.COOKIE_REFRESH_TOKEN_NAME = "refreshToken";
   process.env.COOKIE_DOMAIN = "localhost";
   ```

3. **`vitest.setup.ts` runs second**, and its `beforeAll` fires: `MongoMemoryReplSet.create(...)` downloads or reuses the cached in-memory `mongod` binary, boots a one-node replica set, and `mongoose.connect(mongod.getUri())` opens the connection every subsequent test in the run will share.
4. **Each integration test file's own top-level imports execute.** `import UserModel from "../../src/models/user.model"`, and similarly for every other model each file needs, run their `mongoose.model("User", UserSchema)` calls at this point — this is what populates `mongoose.modelNames()` for the `beforeEach` hook to see.
5. **Before each individual `it(...)` block, two `beforeEach` hooks fire in order**: `vitest.setup.ts`'s global one (forcing `.init()` on any newly-registered model, as covered in §3.1), and then each test file's own local `beforeEach`, which seeds whatever rows that specific test needs — for example, `auth.service.integration.test.ts`'s `beforeEach` creating a real `RoleModel.create({ name: Roles.OWNER, permissions: [] })` document, or `workspace.service.integration.test.ts`'s `beforeEach` creating both a role and a real `UserModel` document before the test body runs.
6. **The test body calls the real service function** — `registerUserService`, `createWorkspaceService`, `createTaskService`, and so on — with no mocks anywhere in the call chain, and asserts against either the function's return value, a fresh re-read from the database, or both.
7. **After the test, `vitest.setup.ts`'s global `afterEach` wipes every collection's documents** with `deleteMany({})`, so the next test (whichever file it belongs to) starts against empty collections but with all indexes and collection metadata already intact from step 4/5.
8. **After the entire suite finishes, `afterAll` disconnects Mongoose and stops the in-memory replica set process**, releasing every resource it held for the run.

---

## 5. Design Decisions & Tradeoffs

**Why one shared instance across the whole suite, not one per file.** Booting `MongoMemoryReplSet` isn't free — pulling or verifying the cached binary and starting a one-node replica set takes real wall-clock time, and `vitest.config.ts`'s comment on `testTimeout`/`hookTimeout` says so directly: *"the FIRST test in a run pays the cost of downloading/booting the in-memory binary."* Paying that cost once, in a single global `beforeAll`, and amortizing it across every integration and e2e test file in the run is dramatically cheaper than paying it per file — with 5 integration files (and 6 e2e files reusing the same setup) that would mean 11 separate boot cycles instead of one. The cost of sharing an instance is the risk this document has already named twice: cross-test pollution, where one test's leftover data changes another test's outcome. AstriX's answer to that risk is the blanket `afterEach` `deleteMany({})` loop — by wiping every collection's documents after every single test, not just the ones the current test file happens to know about, the shared instance behaves, from each test's point of view, as if it always started from an empty database, even though the underlying process, connection, and indexes never actually reset. This is a deliberate trade: real isolation without real reboot, paid for by a small per-test cleanup cost instead of a large per-file boot cost.

**Why 20-second timeouts.** `vitest.config.ts` sets `testTimeout: 20000` and `hookTimeout: 20000`, and its own comment states the specific reason plainly: *"DB operations against mongodb-memory-server are usually fast, but the FIRST test in a run pays the cost of downloading/booting the in-memory binary, so we give generous headroom."* This is a deliberately asymmetric allowance — almost every individual test in the suite finishes in well under 20 seconds once the shared instance is already running, since after boot a query against an in-memory replica set is genuinely fast. The generous ceiling exists specifically to cover the one hook, once per run, where a binary might need to be fetched (on a cold cache, such as a fresh CI runner) before the very first `beforeAll` can even complete — a cost every *other* hook and test in the run never has to pay again:

```ts
// backend/vitest.config.ts:33-38
// How long a single test is allowed to run before Vitest kills it and fails it.
// DB operations against mongodb-memory-server are usually fast, but the FIRST
// test in a run pays the cost of downloading/booting the in-memory binary,
// so we give generous headroom.
testTimeout: 20000,
hookTimeout: 20000,
```

**What this approach gives up compared to Testcontainers-against-real-MongoDB.** `mongodb-memory-server` genuinely runs real `mongod` binaries rather than an emulation layer, which narrows the fidelity gap named in §1(a) considerably — but it does not close it entirely. Reviewing `backend/tests/setup/vitest.setup.ts`, the call is `MongoMemoryReplSet.create({ replSet: { count: 1 } })` with no `binary.version` option passed — meaning whichever MongoDB server version the library resolves to (by its own default resolution logic, not an explicit pin in this codebase) is what every test in this suite actually runs against, and nothing in the reviewed configuration ties that version to whatever MongoDB version the production Atlas cluster is actually running (`backend/package.json:59` pins `mongodb-memory-server` itself at `^11.2.0` — a library version, not a `mongod` server version). If the production cluster and the in-memory test binary ever drift onto different major MongoDB versions, a behavioral difference introduced in one but not the other — a changed default, a deprecated operator, a subtly different aggregation edge case — would be invisible to this entire test layer, passing locally and in CI while behaving differently against the real deployed database. This isn't a defect in AstriX's setup so much as an honest, general property of the embedded-server approach from §1(a): it buys speed and zero external dependencies at the cost of an assumption (this binary behaves like production Mongo) that nothing in the suite actively verifies.

---

## 6. Security Considerations

Integration tests occupy a specific, valuable position in the security posture of this codebase: they are the first layer capable of catching a real *query-shape* bug rather than a logic bug in isolation. A `.select('+password')` misconfiguration, a schema field that's supposed to carry `select: false` but doesn't, or an authorization filter that looks right in source but silently isn't applied to the actual Mongoose query — none of these are visible to a unit test that mocks the model, because a mock has no schema, no field-level `select` behavior, and no query engine to apply a filter against in the first place. The register → login roundtrip test covered in §3.3 is the clearest example already in this codebase: its entire purpose, stated in its own header comment, is to verify that a password is genuinely hashed before storage and genuinely never returned to a caller — both real, security-relevant behaviors of the schema and the service function together, not of either one in isolation. The assertion `expect(rawUser!.password).not.toBe("Correc@123")` only means anything because the test reads the *actual persisted document* out of a *real database* using `.select("+password")` to defeat the schema's own hiding default — a unit test that mocked `UserModel.findById` could never make this assertion meaningful, because the mock would simply return whatever the test told it to, hashing logic or no hashing logic involved at all. The same test's final line, `expect((loggedInUser as any).password).toBeUndefined()`, closes the loop from the other direction: it confirms the *read path* (`omitPassword()`) genuinely strips the field before returning it to a caller, rather than trusting that the function's name implies its behavior.

Test isolation itself is also a security-adjacent concern here, in two distinct ways worth naming plainly rather than assuming away. First, everything `testEnv.setup.ts` writes into `process.env` — `JWT_ACCESS_TOKEN_SECRET`, `JWT_REFRESH_TOKEN_SECRET`, the Google OAuth client ID/secret — is explicitly fake, deterministic, and harmless, and the file's own header comment is direct that these values exist *only* to satisfy `app.config.ts`'s fail-fast loader at import time, not to represent anything real. These values must never be reused as actual production secrets; if a real JWT secret or OAuth credential were ever copy-pasted into this file "to make a test pass," it would defeat the entire point of keeping test and production credentials in separate universes, and would put a real secret in source control under a misleadingly test-flavored filename. Second, and just as important operationally: CI must never be configured to point this integration suite at a real database connection string. The whole design covered in this document — an in-memory, disposable, per-run `MongoMemoryReplSet` — depends on the test database existing nowhere outside the current test process's own memory. If a `MONGO_URI` environment variable pointing at a real cluster were ever set in a CI environment running this suite, the blanket `afterEach` cleanup loop (`deleteMany({})` on every collection, unconditionally, after every single test) would silently and repeatedly wipe real data rather than throwaway in-memory data — a genuinely destructive outcome from a test suite that was never designed to run against anything durable.

---

## 7. Best Practice Check

Is `mongodb-memory-server` still a reasonable 2026 choice, or has the industry moved decisively to Testcontainers? The honest answer is that both remain legitimate, widely-used approaches, and the "right" one is a function of team size and CI economics rather than one being definitively obsolete. Testcontainers has become the default recommendation in a large share of current Java, Node, and Go tutorials and framework documentation specifically because it removes the fidelity question this document raised in §5 entirely — you're testing against the literal image you deploy, version pin and all — and Docker-in-CI has gotten cheap and standard enough on most modern CI providers (GitHub Actions included, which is what runs AstriX's own `pr-check.yml`) that the "needs a Docker daemon" cost that used to be a real barrier mostly isn't one anymore for teams already running containerized builds. That said, embedded/in-memory servers like `mongodb-memory-server` remain genuinely attractive for smaller teams and projects at AstriX's scale specifically because of what they *don't* require: no Docker socket wiring in CI, no container pull latency added to every cold run, and a setup that a contributor can run locally with nothing installed beyond `npm install`. For a single-service, single-database backend with a 46-file test suite run by a small team, the version-drift risk named in §5 is a real but currently-unmitigated-and-honestly-small cost, not a structural flaw serious enough to justify the added CI complexity Testcontainers would bring. If AstriX's team or CI budget grows, or if a MongoDB-version-specific bug ever actually slips through this gap in production, migrating the setup file covered in §3.1 to Testcontainers' `MongoDBContainer` would be a contained, well-scoped change — the replacement only has to satisfy the same `mongoose.connect(...)`-compatible URI contract this file already relies on — rather than a rearchitecture of the test suite itself.

---

## 8. Debug Drill

**Scenario:** A transaction-using integration test — say, one of the register/login or workspace-creation tests covered in §3.3, both of which go through a real `mongoose.startSession()`/`startTransaction()` call inside the service under test — starts intermittently failing in CI with a Mongo write-conflict or lock-wait timeout. Locally, on your own machine, the exact same test passes reliably every time you run it. Where do you look first, and why?

1. **Suspect a new or moved model before anything else.** The most likely explanation, given everything covered in §3.1, is that a new Mongoose model was recently added (or an existing one's collection was touched for the first time by a *new* code path), and that model's very first write in the run is now happening to land inside a transaction rather than outside one — reintroducing the exact implicit-collection-creation-inside-a-transaction race the `beforeEach` `.init()` loop exists to prevent. Check whether the failing test (or a test that runs immediately before it in file order) is the first place in the whole suite that touches a particular model.
2. **Confirm the `.init()` loop is actually running for that model, not silently skipping it.** The loop in `vitest.setup.ts`'s `beforeEach` only initializes models that show up in `mongoose.modelNames()` — which depends entirely on that model having been `import`ed (and therefore registered via `mongoose.model(...)`) by the time the hook runs. A model imported *lazily*, inside a function body rather than at a test file's top level, might not be registered yet when `beforeEach` runs for an early test, meaning its `.init()` never happens before that model's first real write — reproducing the original race the whole mechanism was built to close.
3. **Ask why CI reproduces this and your machine doesn't, specifically.** Timing-sensitive races like this one are classically more likely to surface under CI's resource constraints — a shared, often slower or more contended CI runner is more likely to have the implicit collection-creation operation and the transaction's own lock acquisition actually overlap in time than a fast, unloaded local machine, where the creation might complete quickly enough that the race window never actually gets hit in practice, even when the underlying hazard is equally present in both environments.
4. **Check whether the `beforeEach` hook itself might have failed or timed out on a previous test without being obviously reported as such.** Because `initializedModels` persists for the whole `vitest run` process (it's a module-level `Set`, not reset per test), if the `.init()` call for a given model ever throws or times out once, early in the run, that model may never get marked as initialized, and every subsequent test using it inherits the same unprotected race for the rest of the run — worth checking whether the failure is truly isolated to one test, or whether it's actually the *first* manifestation of a problem that started several tests earlier.
