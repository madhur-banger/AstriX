# 04 — Test Doubles, Fixtures, and Test Data

Every other file in this module asks "does the code under test behave correctly?" This one asks a quieter but equally load-bearing question: where does the *input* to that code come from, and how do you fake the parts of the world (a database row, an Express request) that the test can't afford to be real? Files 01–03 own the mocking *mechanics* — `vi.mock`, hoisting, chain-shaped return values, the London vs. Chicago question of what to fake at all. This file owns something narrower and more concrete: how AstriX *shapes* its fake data and its fake `req`/`res`, and the two small, reusable utilities — `backend/tests/setup/testFixtures.ts` and `backend/tests/setup/mockExpress.ts` — that every unit test in the backend imports to get there.

## 1. The Landscape

Before looking at AstriX specifically, it's worth naming the handful of ways teams generate fake test data, because they trade off against each other in predictable ways and AstriX's choice only makes sense in contrast to the alternatives.

**(a) Factory functions with override merging.** A plain function that returns an object with sensible defaults, and accepts a `Partial<T>` of overrides that get merged on top:

```typescript
function buildUser(overrides: Partial<User> = {}): User {
  return { id: "1", name: "Test User", isActive: true, ...overrides };
}

buildUser();                    // sensible defaults
buildUser({ isActive: false }); // defaults + your one override
```

This is the pattern AstriX uses, and it's popular precisely because it needs no library, no configuration, and no ceremony — it's a function, in TypeScript, that you can `Cmd+Click` into like any other code. The tradeoff is that it requires discipline: nothing forces the shape returned by `buildUser` to track the real `User` type as that type evolves. If a required field gets added to the real schema and nobody updates the factory, the factory silently starts producing objects that don't reflect reality.

**(b) The Object Mother pattern.** A more formalized, OOP-flavored cousin of (a), originating in the Java testing world and documented by Martin Fowler as one of several named "test data" strategies: instead of one generic builder with overrides, you write a dedicated class or module with named methods for specific *scenarios*, not just specific *shapes* —

```typescript
class UserMother {
  static aValidUser() { return { ...defaults, isActive: true }; }
  static anExpiredSession() { return { ...sessionDefaults, expiresAt: pastDate() }; }
  static anAdminWithNoPermissions() { return { ...defaults, role: "ADMIN", permissions: [] }; }
}
```

The name of the method documents the *intent* of the fixture, not just its field values — a reader sees `UserMother.anExpiredSession()` and immediately knows *why* this particular object exists in this particular test, without having to reverse-engineer that from a raw field like `expiresAt: new Date(0)`. This scales well when the same underlying shape needs many semantically distinct variants across a large test suite, but it's more code to maintain than a single builder function, and teams that adopt it often end up with dozens of near-duplicate Mother methods that drift apart from each other the same way plain factory functions can drift from the schema.

**(c) Fixture files.** Static data files — typically JSON or YAML — checked into the repo and loaded by the test runner, most associated with Rails' `ActiveRecord::FixtureSet` (`fixtures/users.yml`, loaded straight into the test database by name) and Django's `loaddata` (`fixtures/initial_data.json`). The appeal is that the data is declarative, framework-managed, and often gets loaded straight into a real (test) database before each test run, which sidesteps writing any builder code at all — the framework's test runner handles insertion, truncation, and referential wiring between fixture rows for you. The cost is that fixture files are data, not code: no type-checking against the schema, no autocomplete while writing one, and no easy way to say "give me a user like the default one but with `isActive: false`" without either duplicating the whole record in the YAML file or building a templating layer on top of a format that was never designed to support one.

**(d) Faker-generated data.** Libraries like `@faker-js/faker` generate randomized-but-realistic values — a different fake email and a different fake name on every test run, instead of the same hardcoded `"test@example.com"` every time. The appeal is that randomization surfaces a real class of bug: code that silently assumes something about fixed test data that isn't actually guaranteed by the schema — "this field is always exactly 10 characters," "this list always has at least one item" — assumptions that a hardcoded fixture will never violate but that faker's randomness eventually will. The cost is the flip side of that same randomness: a test failure becomes harder to reproduce and debug, because the exact object that caused the failure isn't the same object you'll get if you re-run the test a minute later, unless you've deliberately pinned a seed.

None of these four is objectively "correct" — they represent different points on a determinism-vs-coverage and simplicity-vs-power tradeoff curve, and a codebase's choice usually says more about its size and testing maturity than about right and wrong.

## 2. AstriX's Choice

AstriX uses hand-written factory functions with override merging — approach (a) above — collected in a single shared file, `backend/tests/setup/testFixtures.ts`, rather than Object Mother classes, fixture files, or faker-generated randomness. On top of that base pattern it adds two small, purpose-built helper utilities that exist to solve two specific TypeScript/JavaScript mocking problems that plain factory functions don't address on their own: `asConstructorMock`, which fixes a real JavaScript-spec gotcha around using arrow functions as `new Model()` stand-ins, and `createMockReqRes` (in the sibling file `backend/tests/setup/mockExpress.ts`), which builds a chainable fake Express `req`/`res`/`next` triple so controller unit tests never need a real HTTP server.

## 3. AstriX Implementation

### `testFixtures.ts`, in full

`backend/tests/setup/testFixtures.ts:1-190`:

```typescript
/**
 * TEST FIXTURES / FACTORIES
 * -------------------------
 * A "fixture" is just reusable fake test data. Instead of retyping
 * `{ name: "Test User", email: "..." }` in 20 different test files (and
 * having to update all 20 when the schema changes), we write one function
 * that builds it, and every test calls that function.
 *
 * Pattern used below: a "builder function" that takes optional overrides.
 * This is the single most useful testing pattern you'll reuse forever:
 *
 *   buildFakeUser()                          -> sensible defaults
 *   buildFakeUser({ name: "Custom Name" })   -> defaults + your override
 *
 * As you add tests for tasks/members/projects, ADD MORE FUNCTIONS HERE
 * (buildFakeTask, buildFakeProject, etc.) following the exact same shape.
 * Keeping them all in one file means every test file imports from the
 * same source of truth instead of duplicating fake objects everywhere.
 */

import mongoose from "mongoose";

/**
 * Wraps an arrow function so it becomes safe to use as a mock for a
 * Mongoose model CONSTRUCTOR (anything called with `new Model(...)`).
 *
 * WHY THIS IS NEEDED: arrow functions have no [[Construct]] internal slot -
 * `new someArrowFn()` throws "TypeError: ... is not a constructor" every
 * time, by JS spec, no exceptions. Vitest's `vi.mocked(X).mockImplementation(fn)`
 * just stores whatever `fn` you give it and calls it as-is (with `new`, if
 * that's how the real code calls X) - it doesn't fix this for you.
 * A plain `function` expression DOES have [[Construct]], and when a
 * constructor function explicitly returns an object, that returned object
 * is used instead of `this` - which is exactly the pattern our fake
 * Workspace/User/Account/Member objects rely on.
 */
export function asConstructorMock<T extends (...args: any[]) => any>(fn: T) {
  return function (this: any, ...args: Parameters<T>) {
    return fn(...args);
  };
}

// ---------------------------------------------------------------------------
// Generic helper: makes a valid-looking random MongoDB ObjectId.
// Use this instead of hardcoding a string like "abc123" - Mongoose will
// reject "abc123" as an invalid ObjectId format in real (non-mocked) calls,
// and even in mocked unit tests, using real ObjectIds keeps your tests
// honest about what production data actually looks like.
// ---------------------------------------------------------------------------
export function makeObjectId(): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId();
}

// ---------------------------------------------------------------------------
// Fake USER
// Adjust the field names/types here to EXACTLY match your real
// src/models/user.model.ts schema. This is a best-guess based on how
// UserModel is used in workspace.service.ts (it has _id, currentWorkspace,
// and a .save() method).
// ---------------------------------------------------------------------------
export function buildFakeUser(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "Test User",
    email: `test-${Date.now()}@example.com`,
    currentWorkspace: null,
    // Checked by src/middlewares/auth.middleware.ts - defaults to true so
    // most tests don't need to think about it; override to `false` in the
    // specific test that exercises the "deactivated user" guard clause.
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake WORKSPACE
// Matches src/models/workspace.model.ts: name, description, owner, inviteCode.
// ---------------------------------------------------------------------------
export function buildFakeWorkspace(
  overrides: Partial<Record<string, any>> = {}
) {
  return {
    _id: makeObjectId(),
    name: "Test Workspace",
    description: "A workspace created for testing",
    owner: makeObjectId(),
    inviteCode: "TEST-INVITE-CODE",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ROLE (roles-permission.model.ts)
// Used for OWNER/ADMIN/MEMBER roles with a permissions array.
// ---------------------------------------------------------------------------
export function buildFakeRole(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "OWNER",
    permissions: [] as string[],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake MEMBER (join table between User <-> Workspace <-> Role)
// ---------------------------------------------------------------------------
export function buildFakeMember(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    workspaceId: makeObjectId(),
    role: makeObjectId(),
    joinedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ACCOUNT (account.model.ts) - links a User to an auth provider
// (email/password, google, etc). Used by auth.service.ts.
// ---------------------------------------------------------------------------
export function buildFakeAccount(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    provider: "email",
    providerId: "test@example.com",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake SESSION (session.model.ts) - one row per logged-in device/browser.
// Used by auth.service.ts for refresh-token rotation and "log out all devices".
// ---------------------------------------------------------------------------
export function buildFakeSession(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    userAgent: "vitest-test-agent",
    ipAddress: "127.0.0.1",
    isValid: true,
    // Default to one hour in the future so "is this session expired?" checks
    // pass by default - override with a past Date to test the expired path.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake PROJECT (project.model.ts)
// Matches src/models/project.model.ts: name, description, emoji, workspace, createdBy.
// ---------------------------------------------------------------------------
export function buildFakeProject(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "Test Project",
    description: "A project created for testing",
    emoji: "📊",
    workspace: makeObjectId(),
    createdBy: makeObjectId(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake TASK (task.model.ts)
// Matches src/models/task.model.ts: taskCode, title, description, project,
// workspace, status (default TODO), priority (default MEDIUM), assignedTo,
// createdBy, dueDate.
// ---------------------------------------------------------------------------
export function buildFakeTask(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    taskCode: `task-${Math.random().toString(36).slice(2, 5)}`,
    title: "Test Task",
    description: "A task created for testing",
    status: "TODO",
    priority: "MEDIUM",
    workspace: makeObjectId(),
    project: makeObjectId(),
    assignedTo: null,
    createdBy: makeObjectId(),
    dueDate: null,
    ...overrides,
  };
}
```

Seven `buildFake*` functions, one shared `makeObjectId` helper, and one `asConstructorMock` utility — every unit test in `backend/tests/unit/` that needs a fake Mongoose document imports from this one file.

### `mockExpress.ts`, in full

`backend/tests/setup/mockExpress.ts:1-71`:

```typescript
/**
 * FAKE EXPRESS REQUEST / RESPONSE HELPER
 * ---------------------------------------
 * When unit-testing a CONTROLLER (not a full HTTP call via supertest), you
 * don't have a real `req`/`res` from Express - there's no actual HTTP server
 * involved. So we build minimal fake stand-ins that behave just enough like
 * the real thing for your controller code to run.
 *
 * The trick that trips people up: `res.status(200).json({...})` is a CHAIN -
 * `res.status()` must RETURN something that has a `.json()` method on it.
 * So our fake `res.status` mock returns `res` itself, letting the chain work.
 * The same applies to `res.cookie(...)`, which Express also lets you chain.
 *
 * Every method is a `vi.fn()` (a "spy") so that in your test's Assert step
 * you can check things like:
 *   expect(res.status).toHaveBeenCalledWith(201)
 *   expect(res.cookie).toHaveBeenCalledWith("refreshToken", "abc", expect.any(Object))
 *
 * EXTENDED FOR AUTH: auth controllers also read `req.cookies`, `req.headers`,
 * `req.ip`, and call `res.cookie()`, `res.clearCookie()`, and `res.redirect()`
 * - none of which the original workspace controllers needed. This file is
 * SHARED across all features, so we add support here once and every future
 * controller test (task, member, project, auth) can use it.
 */

import { vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

interface MockReqOptions {
  body?: Record<string, any>;
  params?: Record<string, any>;
  query?: Record<string, any>;
  user?: Record<string, any> | null; // populated by your auth middleware in real life
  cookies?: Record<string, any>;
  headers?: Record<string, any>;
  ip?: string;
}

export function createMockReqRes(options: MockReqOptions = {}) {
  const req = {
    body: options.body ?? {},
    params: options.params ?? {},
    query: options.query ?? {},
    // Pass `user: null` explicitly (not just omitting it) to simulate an
    // UNauthenticated request - the default below assumes authenticated,
    // since most controllers you'll test expect req.user to exist.
    user:
      options.user === null
        ? undefined
        : (options.user ?? { _id: "mock-user-id" }),
    cookies: options.cookies ?? {},
    headers: options.headers ?? { "user-agent": "vitest-test-agent" },
    ip: options.ip ?? "127.0.0.1",
  } as unknown as Request;

  const res = {} as unknown as Response;

  // Every one of these returns `res` itself so chains like
  // res.status(200).cookie(...).json(...) keep working, exactly like real Express.
  (res as any).status = vi.fn().mockReturnValue(res);
  (res as any).json = vi.fn().mockReturnValue(res);
  (res as any).send = vi.fn().mockReturnValue(res);
  (res as any).cookie = vi.fn().mockReturnValue(res);
  (res as any).clearCookie = vi.fn().mockReturnValue(res);
  (res as any).redirect = vi.fn().mockReturnValue(res);

  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}
```

### Real call sites

These aren't hypothetical usages — they're pulled directly from consuming test files.

`buildFakeUser` + `.save()` override, used to test the `createWorkspaceService` happy path (`backend/tests/unit/services/workspace.service.test.ts:135-138`):

```typescript
const fakeUser = buildFakeUser();
fakeUser.save = vi.fn().mockResolvedValue(undefined); // .save() is called on the user at the end
const fakeRole = buildFakeRole({ name: "OWNER" });
const newWorkspaceId = makeObjectId();
```

`asConstructorMock` wrapping a `new WorkspaceModel({...})` mock (`backend/tests/unit/services/workspace.service.test.ts:149-163`):

```typescript
// WorkspaceModel and MemberModel are called with `new`, so we mock the
// CONSTRUCTOR itself. Whatever object we return here is what
// `const workspace = new WorkspaceModel({...})` becomes inside the service.
const saveWorkspaceSpy = vi.fn().mockResolvedValue(undefined);
vi.mocked(WorkspaceModel).mockImplementation(
  asConstructorMock(
    (data: any) =>
      ({
        ...data,
        _id: newWorkspaceId,
        save: saveWorkspaceSpy,
      }) as any
  )
);
```

`buildFakeWorkspace` overriding just `owner`, everything else left default (`backend/tests/unit/services/workspace.service.test.ts:312-315`):

```typescript
const ownerId = makeObjectId();
const fakeWorkspace = buildFakeWorkspace({ owner: ownerId });
vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);
```

`createMockReqRes` driving a controller test end to end, overriding only `body` (`backend/tests/unit/controllers/auth.controller.test.ts:66-85`):

```typescript
const { req, res, next } = createMockReqRes({
  body: {
    email: "new@example.com",
    name: "New User",
    password: "Hunter@22",
  },
});

await registerUserController(req, res, next);

expect(authService.registerUserService).toHaveBeenCalledWith({
  email: "new@example.com",
  name: "New User",
  password: "Hunter@22",
});
expect(res.status).toHaveBeenCalledWith(201);
```

`createMockReqRes({ user: null })` deliberately overriding the authenticated-by-default `user` to test the unauthenticated path (`backend/tests/unit/controllers/auth.controller.test.ts:351-357`):

```typescript
it("returns 401 directly when req.user is missing (not authenticated)", async () => {
  const { req, res, next } = createMockReqRes({ user: null });

  await logOutAllController(req, res, next);

  expect(authService.invalidateAllSessionsService).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});
```

## 4. Request/Data Flow

**Trace 1 — `buildFakeWorkspace({ name: "Custom" })` end to end.**

Call `buildFakeWorkspace({ name: "Custom" })`. Before the function body's object literal is even evaluated, JavaScript evaluates `makeObjectId()` twice (`testFixtures.ts:83` for `_id`, `testFixtures.ts:86` for `owner`) — each call runs `new mongoose.Types.ObjectId()`, which is the exact same constructor the real Mongoose driver uses to generate real `_id`s in production. This matters because a hardcoded string like `"abc123"` is not a valid ObjectId — it's 24 fewer hex characters than a real one, and any code path that calls `.toString()`, `.equals()`, or `.toHexString()` on it (all real methods on a real `ObjectId` instance) would either throw or silently misbehave against a plain string. Using `makeObjectId()` keeps the fake honest about what production `_id` values actually look like, even in a fully-mocked unit test where no real database is involved.

The function then returns an object literal:

```typescript
return {
  _id: makeObjectId(),
  name: "Test Workspace",
  description: "A workspace created for testing",
  owner: makeObjectId(),
  inviteCode: "TEST-INVITE-CODE",
  ...overrides,
};
```

The order here is the entire mechanism, and it's easy to get backwards by accident: `...overrides` is spread **last**, after every default field. Object literal spread in JavaScript resolves left-to-right, and a later key always overwrites an earlier one with the same name. So `buildFakeWorkspace({ name: "Custom" })` first lays down `name: "Test Workspace"` as part of the base object, and then the spread of `{ name: "Custom" }` immediately overwrites it — the caller's value always wins over the default, never the reverse. If the file had written `{ ...overrides, name: "Test Workspace", ... }` instead, overrides would be silently discarded by the hardcoded defaults, which would be a genuinely nasty bug to track down (a test that sets an override and watches it get ignored). AstriX gets this right in every one of its seven `buildFake*` functions — `...overrides` is the final key in all of them.

The resulting plain object — `{ _id: ObjectId("..."), name: "Custom", description: "...", owner: ObjectId("..."), inviteCode: "..." }` — is now indistinguishable, as far as any consuming code is concerned, from a real (if minimal) Mongoose document's enumerable fields. It gets handed straight to a mocked model method: `vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any)` (see `backend/tests/unit/services/workspace.service.test.ts:315`). When the service under test calls `await WorkspaceModel.findById(id)`, Vitest's mock intercepts the call and resolves the promise with exactly this object — no database, no network, no Mongoose query engine involved at any point. The service code that reads `workspace.owner` or `workspace.name` has no way to tell it isn't talking to a real document, which is the entire point of a unit test: the object under test is real, everything around it is a controllable stand-in.

**Trace 2 — `asConstructorMock`, and why it exists at all.**

The problem `asConstructorMock` solves is a specific, spec-mandated quirk of JavaScript, not a Mongoose or Vitest quirk. Every function in JS has an internal `[[Call]]` slot (how it behaves when invoked as `fn()`), and *some* functions additionally have an internal `[[Construct]]` slot (how they behave when invoked as `new fn()`). Arrow functions are defined by the spec to have `[[Call]]` only — they were deliberately designed without their own `this` binding, and `[[Construct]]` requires a function to be able to create and bind a fresh `this`. The practical result: `new (() => {})()` throws `TypeError: (intermediate value) is not a constructor`, unconditionally, in every JS engine, every time — this is not configurable and not a bug to be worked around with a try/catch.

This becomes a real problem the moment a test needs to mock a Mongoose model that production code calls with `new`, like `new WorkspaceModel({ name, description, owner })`. The intuitive fix — `vi.mocked(WorkspaceModel).mockImplementation((data) => ({ ...data, save: vi.fn() }))` — looks correct and type-checks, but silently fails at runtime if the arrow function passed to `mockImplementation` is invoked with `new` internally by Vitest's mock machinery mirroring however the real code calls it. `vi.fn().mockImplementation(fn)` doesn't rewrite `fn` into something constructible; it just stores whatever function you hand it and *calls it however the code under test calls it* — with `new`, if that's the pattern being mocked. An arrow function stored there still has no `[[Construct]]` slot, so `new WorkspaceModel(...)` inside the service still throws.

`asConstructorMock` sidesteps this by wrapping the caller's logic in a plain `function` expression instead of an arrow function:

```typescript
export function asConstructorMock<T extends (...args: any[]) => any>(fn: T) {
  return function (this: any, ...args: Parameters<T>) {
    return fn(...args);
  };
}
```

A plain `function` expression *does* have `[[Construct]]`, so `new` on it no longer throws. But that alone would just mean `this` inside the wrapper gets bound to a fresh, empty object the way a real constructor's `this` normally does — which still isn't what the test wants, since the test's `fn` (e.g. `(data) => ({ ...data, _id: newWorkspaceId, save: saveWorkspaceSpy })`) builds and returns its own object, ignoring `this` entirely. This is where a second, separate rule in the JS spec does the actual work: when a constructor function's body *explicitly returns an object* (not a primitive), the `new` expression evaluates to that returned object instead of to the freshly bound `this`. Because `fn(...args)` is called and its return value is returned directly from the wrapper, `new WorkspaceModel({...})` in the service ends up evaluating to exactly whatever plain object `fn` constructed — same as if `WorkspaceModel` had been called as an ordinary function. `this` is accepted as a parameter (`this: any`) purely to satisfy TypeScript's strict mode, which requires an explicit `this` type on any function that might be invoked with `new`; it's never read inside the body.

## 5. Design Decisions & Tradeoffs

**One shared fixtures file, not per-test-file duplicated fakes.** Every unit test that needs a fake user, workspace, role, member, account, session, project, or task imports from the single `testFixtures.ts`, rather than each test file hand-rolling its own `{ name: "Test User", ... }` object inline. The upside is a genuine single source of truth: when the shape of a fake user needs to change — a new field added, a default tweaked — it changes in exactly one place, and every one of the dozens of tests that call `buildFakeUser()` picks up the change automatically. The cost is coupling: every consuming test file now has a real dependency on this one module staying correct and staying backward-compatible. A change to `buildFakeUser`'s signature, or a default value someone quietly "fixes" without checking who relies on the old default, can ripple into test failures across services and controllers that have nothing to do with why the change was made. Centralization trades local blast radius for global leverage — the right trade for a codebase where the underlying schemas are genuinely shared, which AstriX's are.

**Hand-written factories instead of `@faker-js/faker`.** AstriX's fixtures use fixed, readable constants — `"Test User"`, `"Test Workspace"`, `"TEST-INVITE-CODE"` — rather than randomized values. The direct benefit is determinism: when a test fails, the exact object that caused the failure is reproducible on the next run, byte for byte, because nothing about `buildFakeUser()`'s output varies between invocations except the freshly generated `_id` and the timestamp baked into the default email (`test-${Date.now()}@example.com`, `testFixtures.ts:65`, which is itself a narrow, deliberate use of variation — just enough to avoid duplicate-key collisions across parallel test runs, not enough to make assertions on the field's *value* unstable, since almost nothing asserts on the literal email string). A `console.log`-free failure is reproducible failure; you can paste the exact fixture call from the failing test into a REPL and get the identical shape back. The cost, honestly stated, is the flip side of (d) in the Landscape section: nothing about AstriX's fixed-string fixtures would ever catch a bug like "this code silently assumes `name` is never longer than 20 characters" — because `"Test User"` is always exactly the same 9 characters, that assumption is never exercised, let alone violated. Faker-based data would catch it; AstriX's approach structurally cannot.

**The "best-guess" comments, and what they actually mean.** Read closely, `testFixtures.ts` isn't shy about a real limitation of the whole approach. The comment directly above `buildFakeUser` says: *"Adjust the field names/types here to EXACTLY match your real `src/models/user.model.ts` schema. This is a best-guess based on how `UserModel` is used in `workspace.service.ts`"* (`testFixtures.ts:56-59`). That's not boilerplate hedging — it names a real risk plainly: nothing in the type system or the test runner enforces that `buildFakeUser()`'s returned shape actually matches `UserModel`'s Mongoose schema. Comparing the two directly makes the risk concrete rather than theoretical. The real `UserDocument` interface (`backend/src/models/user.model.ts:4-19`) declares `profilePicture: string | null`, `isEmailVerified: boolean`, and `lastLogin: Date | null` as real schema fields — none of which `buildFakeUser` produces (`testFixtures.ts:61-73`). For a unit test where the service under test never reads `isEmailVerified`, that gap is invisible and harmless. But it is exactly the kind of thing that can silently start mattering: the day a service adds a check like `if (!user.isEmailVerified) throw ...`, every unit test using `buildFakeUser()` unmodified will hand that service `user.isEmailVerified === undefined` — which is falsy, and would trip the new guard in every single test that didn't ask for it, for a reason that has nothing to do with what the test claims to be checking. Nothing catches this drift automatically; a factory function and a Mongoose schema are two independently-maintained pieces of code with no compiler link between them. This is precisely the gap that file 02's integration tests exist to close: they run the real `UserModel` against a real (in-memory) MongoDB, so a service that relies on real schema defaults, real validation, or a real field the fixture omitted gets caught there even when the unit-test layer, working entirely from `testFixtures.ts`'s best-guess shapes, would have no way to notice.

## 6. Security Considerations

Test doubles and fixtures are a low-risk area compared to files like auth or input validation — nothing in `testFixtures.ts` or `mockExpress.ts` ever runs against production data or a production request — but two narrow, real risks are worth naming rather than skipping past.

**Fixture data resembling real PII.** `buildFakeUser`'s defaults are obviously synthetic (`"Test User"`, a `Date.now()`-suffixed `@example.com` address) — there's no indication anywhere in `testFixtures.ts` that any field was ever seeded from a real person's actual data. That's good practice, worth naming as a norm precisely because it's easy for a team to violate it later: someone debugging a production issue copy-pastes a real user's actual email or name into a fixture "just to reproduce the bug," and it gets committed. Once that happens, real PII sits in test code and, worse, potentially in CI logs and error output every time the test runs — a genuine, if easily-avoidable, hygiene risk. AstriX's current fixtures give no reason to suspect this has happened, but it's the specific failure mode this category of file is exposed to.

**`createMockReqRes`'s authenticated-by-default `user`.** `createMockReqRes`'s default request has `user: { _id: "mock-user-id" }` unless the caller explicitly passes `user: null` (`mockExpress.ts:47-50`). This default is a deliberate, documented convenience — most controllers under test genuinely expect `req.user` to already be populated by the real auth middleware, which never runs in a unit test, so defaulting to "authenticated" saves every ordinary test from having to opt in. The risk is specifically in what it does for tests that *forget* to opt out: a controller unit test written for an endpoint that's supposed to reject unauthenticated requests, but whose author simply calls `createMockReqRes({ body: {...} })` without ever setting `user: null`, will silently exercise the *authenticated* branch of that controller and never touch the authorization guard at all — while still passing, and still counting toward coverage. AstriX's own `auth.controller.test.ts` shows the correct pattern is known and used (`user: null` is passed explicitly in the `logOutAllController` and `getSessionsController` 401 tests, `backend/tests/unit/controllers/auth.controller.test.ts:351-357`), but the safety of every *other* controller test in the suite depends on each author remembering to do the same thing for any endpoint whose auth-guard behavior actually matters. Nothing in `createMockReqRes` itself forces that; it's a discipline requirement carried by the default, not a structural guarantee.

## 7. Best Practice Check

Hand-rolled factory functions with override merging remain a completely standard, widely-recommended pattern in the current (2026) testing landscape — it's close to the exact shape most teams reach for before they've outgrown it, and a lot of teams never outgrow it. Dedicated factory libraries exist for TypeScript/JS specifically to add the features a plain function starts to strain under at scale: `fishery`, `rosie`, and `factory.ts` (the naming is not coincidental — they're all riffing on the same idea AstriX implements by hand) add *sequences* (auto-incrementing values so 100 generated users don't collide on a unique field without every test remembering to pass one), *associations* (a factory that automatically builds and links a related record, e.g. a task factory that also builds its parent project), and *traits* (named, composable variants — `buildUser.trait("admin")` — closer to the Object Mother idea from section 1 but layered on top of the same builder-with-overrides base).

AstriX has none of these, and at its current size that's a reasonable "hasn't needed the extra power yet" call rather than a gap: there are only seven fixture types, uniqueness collisions are already avoided ad hoc where they matter (`buildFakeUser`'s `Date.now()`-suffixed email, `buildFakeTask`'s randomized `taskCode`), and nothing in the current unit-test suite builds deep object graphs that would benefit from automatic associations. Adopting one of those libraries would be a legitimate, low-risk upgrade if the fixture file keeps growing — but replacing seven simple functions with a dependency to get sequences and traits none of the seven currently need would be solving a problem the codebase doesn't have yet.

## 8. Debug Drill

A new unit test uses `buildFakeSession({ expiresAt: pastDate })` to exercise the "expired session" branch of a service, and it passes. The equivalent scenario — logging in with an actual expired session seeded into the real in-memory MongoDB — fails in the integration suite. Where do you look first?

Start by comparing the fake session's shape against the real `session.model.ts` schema field by field, the same way this file compared `buildFakeUser` against `UserDocument` in section 5. `buildFakeSession` returns `{ _id, userId, userAgent, ipAddress, isValid, expiresAt, createdAt, ...overrides }` (`testFixtures.ts:137-150`) — a specific, fixed set of fields. If the real schema has additional fields the expiry check actually depends on (a boolean flag, a different field name for the timestamp, a virtual or a pre-save hook that recomputes something on read), the unit test's fake object sails past the check because it never had that field to begin with — `undefined` compares as neither expired nor valid, and the surrounding logic may take whichever branch `undefined` happens to satisfy, which is not the same branch a real, fully-populated Mongoose document would take. The integration test, running the actual `SessionModel` against a real MongoDB, exercises the real schema in full — including any field, hook, or default the unit-test fixture silently omitted — so it's the first place this class of bug becomes visible.

This is exactly the failure mode `testFixtures.ts`'s own comments are warning about, just for a different model than the one they call out by name. The file states outright, for `buildFakeUser`, that its shape is *"a best-guess based on how `UserModel` is used"* rather than a verified match against the real schema (`testFixtures.ts:56-59`) — and nothing about that caveat is unique to `buildFakeUser`; every `buildFake*` function in the file carries the same implicit risk, whether or not its comment says so as explicitly. The fix is mechanical once you know where to look: open the real `session.model.ts`, diff its field list against `buildFakeSession`'s returned object, and add whatever's missing — or, more durably, treat the integration-suite failure as the signal it is and audit every `buildFake*` function against its corresponding real model the next time schemas change, rather than waiting for the next drift bug to surface the same way.
