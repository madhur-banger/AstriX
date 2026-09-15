> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

# Backend Unit Testing

A unit test is supposed to answer one narrow question fast: does this one function, given these inputs, do the right thing? In a backend that talks to a real database over the network, that narrow question gets tangled up with a much slower one — is Mongo up, is the schema right, did the index build — unless you deliberately cut the function off from its real collaborators first. This chapter is about that cut: the different ways an industry has invented to make it, which one AstriX picked, and exactly what the code looks like when you actually do it 25 files and several hundred `it(...)` blocks in a row.

The [master testing strategy](./00-master-testing-strategy.md) already showed you the shape of AstriX's whole suite — 46 backend test files split across `unit/`, `integration/`, and `e2e/`, with the unit layer alone holding 25 of them (services, controllers, models, utils, middlewares). This chapter is the deep dive on that unit layer specifically: what "mocked" actually means line-by-line in this codebase, and — just as importantly — what AstriX deliberately does *not* mock.

---

## 1. The Landscape

Before touching a single line of AstriX code, it's worth knowing that "how do I unit-test a function that depends on other things" has several genuinely different, well-established answers in the software testing literature. They aren't stylistic variants — they disagree about what a "unit" even is, and that disagreement changes what a red test actually tells you.

### (a) Solitary unit tests with test doubles — the "London school" / mockist style

Associated most directly with Steve Freeman and Nat Pryce's *Growing Object-Oriented Software, Guided by Tests* (2009), this style treats "the unit" as the single function or class under test, full stop — every collaborator it calls out to (a database, another service, a class it composes) is replaced with a test double (a mock, stub, or fake) before the test runs. The test then asserts two things: the return value/thrown error, and the *interactions* — did the function call its collaborator with the right arguments, the right number of times, in the right order?

```ts
// Pseudocode, illustrating the pattern generically
it("charges the customer via the payment gateway", () => {
  const gateway = { charge: vi.fn().mockResolvedValue({ ok: true }) };
  const orderService = new OrderService(gateway);

  await orderService.checkout(order);

  expect(gateway.charge).toHaveBeenCalledWith(order.total, order.customerId);
});
```

**Tradeoff.** A solitary test is fast (no real I/O of any kind) and pinpoints failure precisely — if it goes red, the bug is inside the function under test, not somewhere three layers downstream, because everything downstream was faked. The cost is that it can't tell you whether the *real* collaborator actually behaves the way your mock assumes it does — a mock that always resolves `{ ok: true }` proves nothing about whether the real payment gateway's API actually returns that shape. This is the exact failure mode integration tests exist to catch, covered in file 02 of this module.

### (b) Sociable unit tests with real collaborators — the "Chicago/Detroit school" / classicist style

Associated with Kent Beck's original *Test-Driven Development: By Example* lineage, this style keeps collaborators real whenever they're cheap and deterministic (an in-memory data structure, another plain object, a pure function), and reserves test doubles for things that are genuinely slow, non-deterministic, or external (network calls, wall-clock time, randomness). "The unit" here is looser — it's whatever graph of real objects it takes to exercise the behavior under test, as long as that graph stays fast and repeatable.

```ts
// Pseudocode: OrderService is exercised together with a REAL in-memory Cart,
// only the payment gateway (a genuine external dependency) is faked.
it("charges the customer via the payment gateway", () => {
  const cart = new Cart();
  cart.add(item, 2);
  const gateway = { charge: vi.fn().mockResolvedValue({ ok: true }) };
  const orderService = new OrderService(gateway);

  await orderService.checkout(cart.toOrder());

  expect(gateway.charge).toHaveBeenCalledWith(cart.total(), cart.customerId);
});
```

**Tradeoff.** Sociable tests catch real integration bugs between the classes involved, because those classes are actually running together, not standing in for each other. The cost is weaker isolation: a bug in `Cart` can make an `OrderService` test fail even though `OrderService` itself is correct, so a red run tells you less about *where* to look. It also blurs the line between "unit" and "integration" test — which is exactly why AstriX, as you'll see in §2, keeps these as two structurally separate test suites rather than one blended style.

### (c) Dependency-injection-based testing

Orthogonal to (a) and (b), this is a design technique that makes either style easier: a class or function receives its collaborators as constructor/function arguments (dependency injection) rather than reaching out and constructing or importing them directly. Frameworks like NestJS, Spring, and Angular build their whole architecture around this so that swapping a real collaborator for a fake one in a test is a one-line change at the injection point, with no monkey-patching or module-level mocking required.

```ts
// Constructor injection makes the swap trivial - no module mocking needed.
class OrderService {
  constructor(private gateway: PaymentGateway) {}
  async checkout(order: Order) {
    return this.gateway.charge(order.total, order.customerId);
  }
}

const fakeGateway: PaymentGateway = { charge: vi.fn().mockResolvedValue({ ok: true }) };
const service = new OrderService(fakeGateway); // test wiring, zero magic
```

**Tradeoff.** DI-based code is the easiest of all these styles to test, because nothing has to be intercepted after the fact — the test simply passes a different implementation in. The cost is architectural: it requires the whole codebase to be written around injectable dependencies from the start (constructors that take interfaces, a composition root that wires the real ones in production), which is a bigger upfront design commitment than reaching for `vi.mock` on an existing, already-written module. AstriX's services are plain exported functions that import their models directly at the top of the file, not classes built for constructor injection — which is exactly why its mocking mechanism has to be module-level interception instead (§3).

### (d) Property-based testing — a contrasting technique many unit-test suites skip entirely

Instead of hand-picking specific example inputs (`"abc"`, `""`, `null`), a property-based test states an invariant that should hold for *any* valid input, and a library (`fast-check` in the JS/TS world, the original `QuickCheck` in Haskell) generates hundreds of random inputs — including edge cases a human wouldn't think to write by hand — and shrinks any failing case down to the smallest input that still reproduces it.

```ts
import fc from "fast-check";

// Property: reversing a string twice always returns the original string,
// for EVERY possible string, not just the two or three examples a human picks.
test("double reverse is the identity function", () => {
  fc.assert(
    fc.property(fc.string(), (s) => reverse(reverse(s)) === s)
  );
});
```

**Tradeoff.** Property-based tests can find genuinely surprising edge cases (a Unicode combining character, an empty array, a negative zero) that example-based tests systematically miss, because the space of inputs a human enumerates by hand is always a tiny, biased sample of the real input space. The cost is that it requires the function under test to have a clean, statable invariant — easy for a pure `reverse()` or a parser, much harder for a service method whose "correctness" is really "did it call the database with the right filter object," which isn't a property so much as an interaction. AstriX's unit suite is entirely example-based; no `fast-check`-style generator appears anywhere in `backend/tests/`. That's a real, worth-naming gap for the deterministic pure-function layer (§3.3 below) rather than a criticism of the mockist layer, where "property" doesn't map cleanly onto "which mock got called."

---

## 2. AstriX's Choice

AstriX's backend unit tests are solitary/mockist-style (option (a) above): every Mongoose model a service, controller, or middleware touches is replaced with a `vi.mock(...)`-generated fake, so a unit test never opens a real database connection, never issues a real Mongo query, and can run in milliseconds regardless of how many hundred tests exist. The one deliberate carve-out is pure, deterministic logic — JWT signing/verification (`utils/jwt.ts`) and the `AppError` exception hierarchy (`utils/appError.ts`) are left completely real in unit tests, because mocking a function that already has no side effects and always returns the same output for the same input buys zero safety and only costs readability. `auth.service.test.ts`'s own header comment states this as a rule of thumb worth carrying to any codebase: *"only mock things that are slow, external, or non-deterministic ... not things that are already fast and pure."*

---

## 3. AstriX Implementation

### 3.1 Mocking shape one: a direct static call

The simplest shape: a service calls a model's static method directly and awaits the result — no chaining. `findUserByIdService` in `auth.service.ts` is exercised this way:

```ts
// backend/tests/unit/services/auth.service.test.ts:914-928
describe("findUserByIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("looks up a user by id while excluding the password field", async () => {
    const fakeUser = buildFakeUser();
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    const result = await findUserByIdService(String(fakeUser._id));

    expect(UserModel.findById).toHaveBeenCalledWith(String(fakeUser._id), {
      password: false,
    });
    expect(result).toBe(fakeUser);
  });
});
```

`vi.mock("../../../src/models/user.model")` at the top of the file (line 76) auto-mocks the entire module, turning every exported function — including `UserModel.findById` — into a `vi.fn()` that returns `undefined` until a test tells it what to return. `vi.mocked(UserModel.findById)` is purely a TypeScript narrowing helper: at runtime it's the exact same mock function, but the cast gives the compiler (and your editor's autocomplete) the mock's `.mockResolvedValue`/`.mockReturnValue`/`.toHaveBeenCalledWith` API instead of the real function's plain return-a-`Promise<User>` signature. The assertion on `toHaveBeenCalledWith` is the interaction check that makes this a *mockist* test, not just a stubbed-output test: it proves the service explicitly excludes the password field at the query layer, not just that it happens to return a user-shaped object.

### 3.2 Mocking shape two: a chained call

Many Mongoose calls in AstriX aren't a single awaited call — they're a method chain, e.g. `MemberModel.find({...}).populate("role")`, where `find()` returns a query builder object and `.populate()` is what actually resolves. Mocking this correctly means each link in the chain has to return an object shaped like "the next link," not a resolved value directly. `getWorkspaceByIdService` needs exactly this for its members lookup:

```ts
// backend/tests/unit/services/workspace.service.test.ts:201-223
it("returns the workspace merged with its members list", async () => {
  const fakeWorkspace = buildFakeWorkspace();
  // .toObject() is a real Mongoose document method - our fake needs one too,
  // since the service calls `workspace.toObject()`.
  (fakeWorkspace as any).toObject = vi
    .fn()
    .mockReturnValue({ ...fakeWorkspace });
  vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);

  // MemberModel.find({...}).populate("role") is a TWO-LINK chain.
  // find() must return an object with a .populate() method,
  // and .populate() is what actually resolves to the array.
  const fakeMembers = [buildFakeMember()];
  vi.mocked(MemberModel.find).mockReturnValue({
    populate: vi.fn().mockResolvedValue(fakeMembers),
  } as any);

  const result = await getWorkspaceByIdService(String(fakeWorkspace._id));

  expect(result.workspace.name).toBe(fakeWorkspace.name);
  expect((result.workspace as any).members).toEqual(fakeMembers);
});
```

The chain can nest further than two links. `getWorkspaceMembersService` needs `MemberModel.find({...}).populate(...).populate(...)` — a three-link chain where each `.populate()` call must itself return an object carrying the *next* method, until the final one resolves:

```ts
// backend/tests/unit/services/workspace.service.test.ts:235-247
// MemberModel.find({...}).populate(...).populate(...) - THREE-link chain
// (find -> populate -> populate). Each .populate() call must return
// something with the NEXT method, until the last one resolves.
const secondPopulate = vi.fn().mockResolvedValue(fakeMembers);
const firstPopulate = vi.fn().mockReturnValue({ populate: secondPopulate });
vi.mocked(MemberModel.find).mockReturnValue({
  populate: firstPopulate,
} as any);

// RoleModel.find({}, {...}).select(...).lean() - a different three-link chain
const leanMock = vi.fn().mockResolvedValue(fakeRoles);
const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
vi.mocked(RoleModel.find).mockReturnValue({ select: selectMock } as any);
```

The same shape shows up in `auth.service.ts` for transaction-scoped lookups, where every model call is chained with `.session(session)` instead of `.populate(...)`:

```ts
// backend/tests/unit/services/auth.service.test.ts:136-139
vi.mocked(UserModel.findOne).mockReturnValue({
  session: vi.fn().mockResolvedValue(buildFakeUser()),
} as any);
```

The rule that generalizes across all of these: **read the chain left to right in the real service code, and mock it right to left** — the innermost, last-called method is the one that actually needs `.mockResolvedValue(...)`; everything before it just needs to return an object exposing the next method name.

### 3.3 Mocking shape three: a `new Model()` constructor call

When a service creates a document — `const workspace = new WorkspaceModel({ name, ... })`, then `workspace.save()` — auto-mocking replaces the class with a mock constructor, and `mockImplementation` controls what `new WorkspaceModel(x)` returns:

```ts
// backend/tests/unit/services/workspace.service.test.ts:149-169
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

const saveMemberSpy = vi.fn().mockResolvedValue(undefined);
vi.mocked(MemberModel).mockImplementation(
  asConstructorMock(
    (data: any) => ({ ...data, save: saveMemberSpy }) as any
  )
);
```

The `asConstructorMock` wrapper exists because of a real JavaScript spec gotcha: an arrow function has no `[[Construct]]` internal slot, so calling `new someArrowFn()` throws `TypeError: ... is not a constructor` unconditionally — `vi.mocked(X).mockImplementation(fn)` just stores whatever `fn` you hand it and invokes it exactly as the real code invokes `X` (with `new`, if that's how the service calls it), and it does nothing to work around this. `asConstructorMock`, defined once in the shared fixtures file, wraps your arrow function in a plain `function` expression instead:

```ts
// backend/tests/setup/testFixtures.ts:37-41
export function asConstructorMock<T extends (...args: any[]) => any>(fn: T) {
  return function (this: any, ...args: Parameters<T>) {
    return fn(...args);
  };
}
```

A plain `function` expression *does* have `[[Construct]]`, and per the JS spec, when a constructor function explicitly `return`s an object, that returned object is used as the result of `new` instead of the newly-created `this` — which is exactly the mechanism every `asConstructorMock(...)` call above relies on to hand back a plain fake object with a `save: vi.fn()` on it. This file also introduces a fourth, more specific variant of the same shape: mocking a *method on the fake document instance itself* — `user.comparePassword(...)`, `user.omitPassword()` — rather than a static Model method. Because the whole `UserModel` module is auto-mocked, a plain object literal handed back from `UserModel.findById` doesn't inherit the real Mongoose schema's instance methods for free; the test has to attach them explicitly:

```ts
// backend/tests/unit/services/auth.service.test.ts:404-412
it("returns the sanitized (password-omitted) user on success", async () => {
  vi.mocked(AccountModel.findOne).mockResolvedValue(
    buildFakeAccount() as any
  );
  const fakeUser = buildFakeUser();
  (fakeUser as any).comparePassword = vi.fn().mockResolvedValue(true);
  const sanitizedUser = { ...fakeUser, password: undefined };
  (fakeUser as any).omitPassword = vi.fn().mockReturnValue(sanitizedUser);
  vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
```

`asConstructorMock` and the `buildFake*` factory functions it's usually paired with are the shared fixture toolkit for every unit test file in this suite — file 04 of this module, *Test Doubles, Fixtures, and Test Data*, is the canonical deep dive on that whole file (`backend/tests/setup/testFixtures.ts`); this chapter only needed the `[[Construct]]` mechanics to explain why constructor mocking looks the way it does.

### 3.4 The `createMockReqRes` pattern for controller unit tests

Controllers aren't called through a real HTTP server in a unit test — there's no `req`/`res` from an actual Express request. `backend/tests/setup/mockExpress.ts` builds minimal stand-ins:

```ts
// backend/tests/setup/mockExpress.ts:39-70
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

Every `res` method returns `res` itself specifically so that a real Express-style chain — `res.status(200).json({...})` — keeps working against the fake exactly as it would against the real thing; without that, `res.status(...).json(...)` would throw `.json is not a function` the instant the controller tried to chain. `auth.controller.test.ts` uses it like this, unit-testing the login controller with the service layer itself mocked out (`vi.mock("../../../src/services/auth.service")`):

```ts
// backend/tests/unit/controllers/auth.controller.test.ts:102-137
it("verifies credentials, creates a session, sets the refresh cookie, and returns the access token", async () => {
  const fakeUser = buildFakeUser();
  vi.mocked(authService.verifyUserService).mockResolvedValue(fakeUser as any);
  vi.mocked(authService.createSessionService).mockResolvedValue({
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    sessionId: "session-1",
  });

  const { req, res, next } = createMockReqRes({
    body: { email: fakeUser.email, password: "Hunter@22" },
    headers: { "user-agent": "test-browser" },
    ip: "1.2.3.4",
  });

  await loginController(req, res, next);

  // Confirm the session was created with data pulled from the REQUEST
  // (user-agent, ip) rather than hardcoded - this is exactly the kind of
  // wiring bug an E2E test might miss if it always uses the same headers.
  expect(authService.createSessionService).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: fakeUser._id,
      userAgent: "test-browser",
      ipAddress: "1.2.3.4",
    })
  );
  expect(res.cookie).toHaveBeenCalledOnce();
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      access_token: "fake-access-token",
      user: fakeUser,
    })
  );
});
```

This is a unit test for the *controller layer specifically*: `verifyUserService` and `createSessionService` are mocked (they're unit-tested on their own in `auth.service.test.ts`, §3.1–3.3), so the only thing this test can fail on is the controller's own logic — does it read `email`/`password` out of `req.body` correctly, does it forward `req.headers["user-agent"]` and `req.ip` into the session-creation call, does it set the cookie and shape the JSON response correctly. Note also what this file's own header comment says is deliberately real here: `utils/jwt.ts`'s `verifyRefreshToken` is left genuine in most of this file (only re-exported through a partial `vi.mock` factory that swaps in a fake just for that one function — see §4), while `config/app.config.ts` is entirely untouched, because `testEnv.setup.ts` already seeded safe fake env vars for it.

### 3.5 A deliberately-not-mocked pure function

Contrast the above with `utils/jwt.ts` and `utils/appError.ts`. Neither file's test imports `vi.mock` at all:

```ts
// backend/tests/unit/utils/jwt.test.ts:1-16
/**
 * UNIT TESTS: utils/jwt.ts
 * ---------------------------
 * These functions are almost pure: given the SAME secret and payload, they
 * produce deterministic, verifiable output. No database, no Express, no
 * mocking required - `tests/setup/testEnv.setup.ts` already gave us fixed
 * fake secrets to sign/verify against, so real jsonwebtoken code runs here.
 *
 * THE CLEVER TRICK FOR TESTING "TOKEN EXPIRED" WITHOUT ACTUALLY WAITING:
 * We don't want a test that calls `setTimeout` for 15 minutes to prove
 * expiry works. Instead, we hand-craft a token with an `exp` claim already
 * in the past using the real `jwt.sign` call directly (bypassing the
 * `expiresIn` option, which only accepts relative future durations) - the
 * library's own expiry check then fails immediately, exactly as it would
 * for a token that aged out naturally.
 */
```

```ts
// backend/tests/unit/utils/jwt.test.ts:125-146
it("fails verification with 'Token expired' for a token whose exp is in the past", () => {
  // Bypass the library's relative `expiresIn` option and hand-craft an
  // already-expired token by setting `exp` directly, in seconds since epoch.
  const expiredToken = jwt.sign(
    {
      userId: "u1",
      sessionId: "s1",
      exp: Math.floor(Date.now() / 1000) - 10, // 10 seconds in the past
      aud: ["user"],
    },
    accessTokenSignOptions.secret,
    { algorithm: "HS256" }
  );

  const result = verifyJwtToken(expiredToken, accessTokenSignOptions.secret);

  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.error).toBe("Token expired");
  }
});
```

This is real `jsonwebtoken` code, signing and verifying a real token with a real (test-only) secret, with zero test doubles anywhere in the file. `utils/appError.ts`'s test suite is the same idea applied to a class hierarchy instead of crypto — it just constructs real `AppError` subclasses and asserts on their real fields, no mocking possible or needed because there's no collaborator to fake in the first place:

```ts
// backend/tests/unit/utils/appError.test.ts:80-92
describe("UnauthorizedException", () => {
  it("defaults to 401 + ACCESS_UNAUTHORIZED", () => {
    const error = new UnauthorizedException();
    expect(error.statusCode).toBe(HTTPSTATUS.UNAUTHORIZED);
    expect(error.errorCode).toBe(ErrorCodeEnum.ACCESS_UNAUTHORIZED);
    expect(error.message).toBe("Unauthorized Access");
  });

  it("accepts a custom message and errorCode override", () => {
    const error = new UnauthorizedException("Nope", "AUTH_TOKEN_NOT_FOUND");
    expect(error.message).toBe("Nope");
    expect(error.errorCode).toBe("AUTH_TOKEN_NOT_FOUND");
  });
});
```

The `auth.service.test.ts` header comment names this directly as policy, not accident: `generateTokenPair`, `verifyRefreshToken`, and `calculateExpiryDate` are "deterministic pure functions once test env secrets are set... mocking them would just be extra work for no safety benefit." A mock of `generateTokenPair` that always returns `{ accessToken: "fake", refreshToken: "fake" }` would make every downstream assertion about token shape meaningless — and it would still pass if the real signing logic were completely broken, since the mock never calls it.

---

## 4. Request/Data Flow

Trace what actually happens, in order, when `npx vitest run tests/unit/services/auth.service.test.ts` executes a single test — say, `createSessionService`'s test at the top of the file.

**Step 1 — hoisting.** Before any of the file's own `import` statements are evaluated, Vitest's compiler hoists every top-level `vi.mock(...)` call to the very top of the module. This is why the file can write `vi.mock("../../../src/models/session.model")` on line 80 and then, further up visually (but earlier in evaluation order because of hoisting) or further down, `import SessionModel from "../../../src/models/session.model"` on line 52, and still have that import receive the mocked version rather than the real one. The comment in `workspace.service.test.ts` states this precisely: *"`vi.mock()` is HOISTED to the top of the file automatically by Vitest, so it runs before the imports above are even evaluated. This is why you can `vi.mock` a path and then still `import` the real path above — the import silently receives the mocked version instead of the real module."*

**Step 2 — the mock factory executes, once, before the test file's own code runs.** With no second argument, `vi.mock("../../../src/models/session.model")` uses Vitest's *automock*: it loads the real module once to learn its shape (every exported function, class, and static method), then replaces every function-shaped export with a `vi.fn()` that returns `undefined` by default. This happens once, at module-load time, for the whole file — not per-test.

**Step 3 — `beforeEach` resets state before every single test.** `createSessionService`'s `describe` block declares `beforeEach(() => vi.resetAllMocks())` (line 89). `vi.resetAllMocks()` clears both the call history (`toHaveBeenCalledWith` assertions from a previous test can't leak into this one) *and* any `mockResolvedValue`/`mockImplementation` configured in a previous test — the comment in `workspace.service.test.ts` calls this out as "the #1 cause of 'my test passes alone but fails when run with the others' confusion." Without it, a `mockResolvedValue(fakeUser)` set up in test #1 would silently still be active when test #2 runs, even though test #2 never configured it.

**Step 4 — the test configures the specific mock behavior it needs**, e.g. `vi.mocked(SessionModel).mockImplementation(asConstructorMock((data) => Object.assign(fakeSession, data)))` — this only affects the shared mock object for the remainder of *this* test, because the next `beforeEach` will reset it again.

**Step 5 — the function under test runs, and its calls to the mocked model resolve exactly as configured.** `createSessionService` executes `new SessionModel({...})`, which — because of `asConstructorMock` — returns the fake session object the test built, not a real Mongoose document; `fakeSession.save()` resolves because the test explicitly gave it `save: vi.fn().mockResolvedValue(undefined)`; nothing here ever opens a socket, and if the test forgot to configure a given call, that call would return `undefined` (an automock's default) or, for a chained call missing its next link, throw a `TypeError` for calling a method on `undefined` — usually the first sign a test is missing a mock setup line, not that the service itself is broken.

**Step 6 — assertions run against both the return value and the interaction history.** `expect(fakeSession.save).toHaveBeenCalledOnce()` is checking that the mock was actually invoked the right number of times — this is only possible because every mock function vitest hands back doubles as a spy recording its own call history automatically, with no separate spy-setup step required.

---

## 5. Design Decisions & Tradeoffs

**Why mockist unit tests specifically, given AstriX also has sociable integration tests.** AstriX doesn't pick one school and apply it everywhere — it deliberately runs both, as two structurally separate layers with two different jobs. The unit layer (this chapter) is solitary/mockist: fast, isolated, and precise about *which* function broke, because every collaborator is faked and can't itself be the source of a false failure. The integration layer (file 02) is sociable/classicist in the fullest sense: no mocks at all, a real `mongodb-memory-server` database, real Mongoose schema validation, real hashing. Running the mockist unit suite is what makes a 300+ test run finish in seconds rather than minutes — every one of those tests is pure JS execution plus a handful of resolved promises, with zero real I/O — and that speed is what makes a tight local red-green-refactor loop practical while writing a service. The tradeoff is named honestly in the integration test file's own header comment (already quoted in the master strategy file): *"Unit tests mock `user.comparePassword()` to return true/false on command — they can NEVER catch a bug where your bcrypt hashing or comparison logic is actually broken."* A unit test can only ever be as correct as the assumptions baked into its mocks; if `UserModel.findById` in production actually returns a Mongoose Document with methods and quirks your fake object doesn't replicate, the unit test has no way to notice.

**What's given up, specifically.** Because every Mongoose model is a `vi.fn()` in this layer, a unit test structurally cannot catch: a real schema validation failure (a required field silently missing), a real query that doesn't do what its filter object looks like it should do, an index or uniqueness constraint being violated, a real transaction actually committing or rolling back correctly against MongoDB's replica-set semantics, or a Mongoose middleware/hook (like `user.model.ts`'s password-hashing pre-save hook, tested directly in `user.model.test.ts` against a real in-memory database) actually firing. Every one of those gaps is exactly what integration tests exist to close — the split isn't an oversight, it's the pyramid-with-a-thick-integration-layer shape the master strategy file describes.

**Why the JWT/AppError carve-out doesn't weaken the mockist story.** Leaving pure functions real inside an otherwise-mockist suite isn't a compromise of the London-school approach — it's consistent with it. The London school's rationale for mocking is about isolating *non-deterministic, slow, or stateful* collaborators specifically so a test's outcome depends only on the function under test. A pure function that always returns the same output for the same input is already isolated by construction; mocking it wouldn't add isolation, it would just replace a real, fast, trustworthy computation with a hand-typed stand-in that has to be kept in sync by hand every time the real function's behavior changes.

---

## 6. Security Considerations

A unit test built entirely on mocked models is honest about what it can and cannot tell you about security, and the two categories are genuinely different in kind.

**What it *can* verify: pure control-flow and authorization-guard logic.** `auth.middleware.test.ts`'s seven-guard `authenticate` chain (missing token, unverifiable token, unknown user, deactivated user, missing session, revoked/expired session, session-owner mismatch) is entirely testable with mocked models, because every one of those checks is a branch of plain conditional logic evaluated against whatever the mock hands back — the guard-7 test is a genuine security-relevant assertion, and it doesn't need a real database to prove it:

```ts
// backend/tests/unit/middlewares/auth.middleware.test.ts:161-181
it("guard 7: calls next(error) when the session belongs to a DIFFERENT user than the token claims (session hijack / mismatch check)", async () => {
  // This is arguably the most security-critical guard in the file: it
  // stops a token for user A being paired with a real, valid, unexpired
  // session that actually belongs to user B.
  const tokenUser = buildFakeUser();
  const sessionOwner = buildFakeUser(); // a DIFFERENT user
  const fakeSession = buildFakeSession({
    userId: sessionOwner._id,
    isValid: true,
  });
  const { req, res, next } = buildAuthedReq(
    tokenUser._id,
    String(fakeSession._id)
  );
  vi.mocked(UserModel.findById).mockResolvedValue(tokenUser as any);
  vi.mocked(SessionModel.findById).mockResolvedValue(fakeSession as any);

  await authenticate(req, res, next);

  expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
});
```

This test proves the middleware's *own* comparison logic — "does `session.userId` equal the token's claimed `userId`" — correctly rejects a mismatch, entirely independent of whether `SessionModel.findById` in production is implemented correctly. That's genuinely valuable: it's the exact class of bug (an `if` condition inverted, an `&&` that should have been an `||`) that's easy to introduce in a refactor and easy to miss in code review, and this test would catch it in milliseconds without touching a database. `refreshAccessTokenService`'s stolen-refresh-token test (`auth.service.test.ts:832-857`) is the same category: it proves the *rotation-detection logic* correctly invalidates a session when a stale refresh token is replayed, using a real SHA-256 hash comparison against a mocked session record.

**What it *cannot* verify: anything about the real query or the real data.** A mocked `UserModel.findById` never runs a real Mongoose query, so a unit test has no way to notice if that query is actually missing a `.select("-password")`/`{ password: false }` projection in production and is quietly leaking a password hash over the wire — the unit test in §3.1 only proves the *service* passed the right projection argument *to the mock*, not that Mongoose actually honors it against a real document. Likewise, a unit test cannot verify that a real NoSQL-injection-style payload (`{ email: { $ne: null } }` submitted as a JSON body where a string was expected) is safely rejected or coerced by a real Mongoose query — that requires the payload to reach a real query executor, which by definition doesn't exist in this layer. Both of those checks belong to integration and e2e tests (files 02–03), which run the real model against a real (if disposable) database.

---

## 7. Best Practice Check

Heavy `vi.mock`-based model mocking, as AstriX practices it here, is not the unambiguous 2026 industry default it might have been five years ago. The broader shift — visible in Kent C. Dodds's "testing trophy" framing referenced in the master strategy file, and in how much of the Node ecosystem has moved toward tools like `testcontainers` and `mongodb-memory-server` itself — favors giving up some unit-test isolation in exchange for testing against real (if ephemeral) collaborators wherever that's affordable, precisely because a suite that's "green" against mocks but wrong about the real dependency's behavior is a false sense of safety. Judged against that trend in isolation, a codebase where *every* Mongoose model in *every* service test is mocked could look over-committed to the London school.

What keeps AstriX's version of this from being a real gap, rather than just a stylistic choice, is that it doesn't stop at the unit layer: the same services covered by mocked unit tests are covered again by real-database integration tests (file 02) and real-HTTP e2e tests (file 03) against the exact same code paths. The mocked layer isn't standing in as AstriX's *only* signal about correctness — it's the fast, cheap first line, backed by two slower, more expensive layers that exercise the real collaborators the unit layer fakes. That three-layer structure, enforced by a coverage gate that actually blocks a PR when it regresses (`check-backend`'s `npm run test:coverage` step in `pr-check.yml`, thresholded at 90% statements / 85% branches / 90% functions / 90% lines in `vitest.config.ts`), is a fairly disciplined 2026 setup: the industry critique of over-mocking is really a critique of mocking being the *only* layer of defense, and AstriX's mocked unit tests are explicitly not that.

Where AstriX's unit layer *would* age less well against 2026 practice is if it ever grew a service with genuinely complex query logic — deeply nested aggregation pipelines, for instance — purely mocked at the unit level with no property-based or generative coverage of edge-case inputs (§1(d)); that's a real, if currently mostly theoretical, gap in the pure-function layer specifically, since JWT/AppError testing today is entirely example-based.

---

## 8. Debug Drill

**Scenario.** You maintain a unit test that mocks `UserModel.findById` to resolve a plain fake object built with `buildFakeUser()`, e.g. `vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any)`. A teammate changes the real `user.model.ts` schema so that some downstream code — say, a new serialization step in a controller — now calls `user.toObject()` on whatever `UserModel.findById` returns, to strip Mongoose-internal fields before sending a response. In production, `findById` returns a genuine Mongoose Document, which always has a `.toObject()` method. Your unit test's fake object, built by `buildFakeUser()`, is a plain object literal — it has no `.toObject()` at all.

**Where do you look first, and why?**

1. **Run the specific failing test and read the actual error, not just "test failed."** The failure will be a `TypeError: user.toObject is not a function` (or `fakeUser.toObject is not a function`), thrown from inside the real controller/service code the test is exercising, not from a Vitest assertion. That distinction matters: this isn't "expected X, got Y," it's a genuine runtime crash inside the code under test, surfaced only because the fake stand-in is missing a method the real object always has.

2. **Recognize this as the same category of gap already named in §3.3** — an auto-mocked or hand-built fake document doesn't inherit the real schema's instance methods "for free." Exactly the way `comparePassword`/`omitPassword` had to be attached explicitly with `(fakeUser as any).comparePassword = vi.fn()...` wherever the service under test called them, `toObject` (or any other newly-introduced Mongoose Document method) now needs the same explicit treatment everywhere a test's fake user flows into code that calls it — which could be several files if `buildFakeUser()` is shared as broadly as it is.

3. **Fix at the shared fixture, not at every call site individually.** Because `buildFakeUser()` lives once in `testFixtures.ts` and is imported by every unit test file that needs a fake user, the sustainable fix is adding a default `toObject: function () { return this; }`-style method to the factory itself (mirroring how `getWorkspaceByIdService`'s test already does this per-object for `buildFakeWorkspace()`), rather than patching every individual test that happens to hit the new code path. That keeps future services free to call `.toObject()` on a fixture-built object without every single test author having to rediscover the same gap independently.

4. **Understand exactly why this took a teammate's schema change to surface, and why a green unit-test run didn't catch it the moment the change landed.** The unit test only calls `.toObject()` on the fake object if the code path it exercises actually reaches the new call site — a unit test whose specific branch of the controller doesn't happen to touch the new serialization step stays green, misleadingly, even though the *real* code would break the instant a genuinely different caller reached it in production with an object missing that shape. This is precisely the boundary named in §5 and §6: a mocked unit test can only be as faithful as the fake object it was handed, and nothing in the mocking mechanism itself forces that fake to track schema changes on the real model over time. The integration-test layer (file 02) does not have this blind spot at all — it runs the real `UserModel.findById` against a real, disposable MongoDB, so a genuine Mongoose Document (complete with `.toObject()`, `.populate()`, and every other real instance method) comes back automatically, and any code that calls a real Document method a fake object doesn't have would simply work there without anyone needing to remember to update a fixture by hand. That's the concrete, mechanical reason "add integration coverage" is the right response to this class of bug, not "write a more elaborate mock" — a more elaborate mock is still a hand-maintained approximation of the real schema, chasing it after every future schema change, while a real Document by construction cannot drift out of sync with itself.
