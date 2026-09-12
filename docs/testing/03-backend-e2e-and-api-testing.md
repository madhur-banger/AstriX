# Backend E2E and API Testing

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Testing](./00-master-testing-strategy.md).

Unit tests tell you a function does what its author intended in isolation. Integration tests tell you a service and a real database agree with each other. Neither tells you the thing a user actually experiences: that a specific HTTP request, carrying a specific header, hitting a specific route, wired through the specific middleware chain the production binary runs, comes back with the specific status code and body the client depends on. That's the gap end-to-end (E2E) API testing closes, and it's the subject of this file — `backend/tests/e2e/`, six files built around two small shared helpers that make the whole layer trustworthy rather than a rubber stamp.

---

## 1. The Landscape

Testing an HTTP API "end-to-end" means something different depending on which end you're willing to fake, and the industry has settled on a handful of genuinely different approaches rather than one canonical technique.

### (a) In-process HTTP testing via `supertest` (or Go's `httptest`, Python's `TestClient`)

The pattern this file is about: hand your framework's app object — not a running server bound to a real port — to a library that knows how to construct real, spec-shaped HTTP requests against it in-process. `supertest` wraps Node's own `http` module around whatever `express()` (or any `http.RequestListener`) you give it; it never binds a TCP port, but the request/response objects that flow through your middleware and route handlers are the real thing, not stand-ins.

```js
// illustrative supertest usage — not AstriX code
const request = require("supertest");
const app = require("./app");

it("returns the user", async () => {
  const res = await request(app).get("/users/1");
  expect(res.status).toBe(200);
});
```

The same idea recurs outside Node: Go's standard-library `net/http/httptest` package gives you `httptest.NewRecorder()` and `httptest.NewServer()` to drive a `http.Handler` without a real listener; Python's FastAPI/Starlette ship `TestClient` (built on `httpx`), which does the identical in-process trick against an ASGI app.

**Tradeoffs.** This is fast — no process spawn, no port binding, no network stack — and trivially parallelizable in CI, which is exactly why it's the default choice for "does my app's routing/middleware/handler chain actually work" tests. What it does *not* prove is that the real, deployed binary — built, containerized, started with real environment variables, sitting behind a real reverse proxy or load balancer — behaves the same way. A misconfigured `Dockerfile`, a missing environment variable in the deployed task definition, or a reverse-proxy header-stripping quirk are all invisible to an in-process test, because there's no process boundary, no network hop, and no proxy in the picture at all.

### (b) Out-of-process tools — Postman/Newman against a genuinely running server

Postman collections (run headlessly via `newman run collection.json`) issue real HTTP requests over a real socket to a server that's actually listening — typically a server started specifically for the test run, or a shared staging deployment. This is a categorically different test: it exercises whatever sits between the test runner and the app in the real deployment topology — a reverse proxy, TLS termination, a load balancer's health-check gating, DNS.

**Tradeoffs.** It catches classes of bug in-process testing structurally cannot: a server that fails to start with production-shaped config, a port or TLS misconfiguration, a proxy that drops a header the app depends on. The cost is real infrastructure — something has to actually be running, reachable, and torn down cleanly — and real wall-clock time, since every request is a genuine network round trip rather than an in-process function call. Newman/Postman also decouple the test definitions from the application's own source language, which is a plus for cross-team API contracts and a minus for keeping test and implementation code in the same review.

### (c) Playwright or Cypress used for API testing, not browser UI

Both tools are best known for driving a real browser, but both also expose a request client (Playwright's `request` fixture / `APIRequestContext`, Cypress's `cy.request()`) that issues plain HTTP requests directly from the test runner — no browser rendering involved at all, even though the tool is normally associated with one.

```js
// illustrative Playwright API-testing usage — not AstriX code
test("GET /users/1 returns the user", async ({ request }) => {
  const res = await request.get("/users/1");
  expect(res.status()).toBe(200);
});
```

**Tradeoffs.** Using a browser-automation tool purely for its HTTP client is attractive mainly when a team already has Playwright/Cypress infrastructure for UI tests and wants API assertions in the same suite, same reporter, same CI job — it avoids a second test runner and a second set of conventions. Against a real, listening server (the tools generally expect one, the way Postman does), it shares (b)'s tradeoffs: real infrastructure, real network calls, slower than in-process testing. Reaching for a browser-automation framework purely for its HTTP client, with no UI tests in the same suite, is usually a sign a lighter tool (`supertest`, `httpx`) would have done the same job with less machinery.

### (d) Contract testing (e.g. Pact)

A different question entirely: not "does this API work," but "do a consumer and a provider agree on the shape of a request/response, without either one running the other's full stack." A consumer team writes expectations against a mock provider (generating a "pact" — a recorded contract); the provider team then replays that contract against their *real* implementation in an automated verification step. Neither side needs the other's service running to test against it.

```js
// illustrative Pact consumer test — not AstriX code
provider
  .given("user 1 exists")
  .uponReceiving("a request for user 1")
  .withRequest({ method: "GET", path: "/users/1" })
  .willRespondWith({ status: 200, body: { id: 1, name: "Ada" } });
```

**Tradeoffs.** Contract testing solves a problem that only exists once there are two independently deployable services that need to agree on an interface without a human manually keeping both sides' assumptions in sync — a genuinely microservices-shaped problem. It buys fast, decoupled verification of API compatibility across a service boundary, at the cost of separate tooling (a Pact Broker or equivalent), a consumer-driven workflow discipline both teams have to adopt, and coverage that's explicitly scoped to *interface shape*, not full business-logic correctness. AstriX is a single deployable backend monolith talking to one frontend it also owns — there is no second team's service whose contract needs independent verification, so this approach solves a problem AstriX doesn't structurally have. It's included here because it's a real, commonly-cited fourth category, not because it's a gap in AstriX's suite.

---

## 2. AstriX's Choice

AstriX's E2E layer is category (a): `supertest` driving a real Express `app` object, in-process, against `mongodb-memory-server` — no real network, no real listening port. What separates it from a minimal or lazy version of the same idea is what the app object is actually built from. Every e2e suite builds its app through a shared helper, `buildRoutedApp`, which mounts the router under test behind the exact same `authenticate` middleware and `errorHandler` that `src/index.ts` wires every protected router through in production — not a lighter, test-only stand-in. And every authenticated request in these suites carries a token produced by `createAuthenticatedUser`, a helper that creates a genuinely valid JWT plus a matching `SessionModel` row via the real token-issuance utilities, rather than reaching into `req.user` and setting it by hand.

---

## 3. AstriX Implementation

### 3.1 The shared app builder, in full

```ts
// backend/tests/setup/buildTestApp.ts:1-42
/**
 * SHARED E2E APP BUILDER
 * ------------------------
 * Mounts a single router behind the REAL `authenticate` middleware and the
 * REAL `errorHandler` - the same two pieces every protected router in
 * src/index.ts is wired through. Using this (instead of each e2e file
 * hand-rolling its own minimal error handler / fake `req.user` stub) means
 * e2e tests actually exercise production auth/error wiring, not a stand-in.
 */

import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authenticate } from "../../src/middlewares/auth.middleware";
import { errorHandler } from "../../src/middlewares/errorHandles.middleware";

export function buildRoutedApp(
  mountPath: string,
  router: Router,
  options: { authenticated?: boolean } = {}
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  if (options.authenticated === false) {
    app.use(mountPath, router);
  } else {
    app.use(mountPath, authenticate, router);
  }

  app.use((req, res) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
    });
  });

  app.use(errorHandler);

  return app;
}
```

Every parameter earns its place. `mountPath` and `router` let one function serve every domain (`workspace`, `project`, `task`, `member`) instead of four copy-pasted app builders. `options.authenticated` exists for the one case that genuinely needs an app with *no* auth guard at all — not "auth that always passes," but a route wired exactly the way an unauthenticated endpoint is wired in `index.ts`. The 404 handler and `errorHandler` at the bottom aren't incidental scaffolding; the 404 branch matches the shape `index.ts` itself falls through to for an unmatched route, and mounting `errorHandler` last, after every router, is required by Express — a four-argument middleware is only ever invoked for an error forwarded via `next(err)`, and it has to be the final piece in the chain to catch errors from everything registered before it.

### 3.2 The real-token auth helper, in full

```ts
// backend/tests/setup/e2eAuth.ts:1-45
/**
 * E2E AUTH HELPER
 * -----------------
 * Every e2e suite that hits a route mounted behind the real `authenticate`
 * middleware (see src/index.ts - user/workspace/project/task/member routers
 * are all mounted as `authenticate, someRoutes`) needs a REAL, verifiable
 * access token plus a matching SessionModel row (authenticate looks the
 * session up by id and checks isValid/expiresAt/userId match).
 *
 * This mirrors exactly what `createSessionService` + `generateTokenPair` do
 * in production, so e2e tests exercise the real auth wiring end-to-end
 * instead of stubbing `req.user` by hand.
 */

import UserModel from "../../src/models/user.model";
import SessionModel from "../../src/models/session.model";
import { generateTokenPair, calculateExpiryDate } from "../../src/utils/jwt";
import { config } from "../../src/config/app.config";

export async function createAuthenticatedUser(
  overrides: Partial<{ name: string; email: string }> = {}
) {
  const user = await UserModel.create({
    name: overrides.name ?? "E2E Test User",
    email:
      overrides.email ??
      `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  });

  const session = await SessionModel.create({
    userId: user._id,
    userAgent: "vitest-e2e-agent",
    ipAddress: "127.0.0.1",
    expiresAt: calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN),
  });

  const { accessToken } = generateTokenPair(user._id, session._id.toString());

  return {
    user,
    session,
    accessToken,
    authHeader: `Bearer ${accessToken}`,
  };
}
```

Three real Mongo/JWT operations happen here, in the same order production does them at login: a real `UserModel` document is inserted, a real `SessionModel` document is inserted (with a genuine `expiresAt`, computed the same way `createSessionService` computes it), and `generateTokenPair` — the exact function `backend/src/utils/jwt.ts` exports and `createSessionService` calls in production — signs a real, verifiable access token naming that session's actual `_id`. Nothing about the token or the session row is synthetic; the only thing this helper skips relative to a real login is the password/OAuth exchange that decides *which* user gets a session, which is deliberately out of scope for tests whose job is to exercise routes, not re-prove login itself (that's `auth.routes.e2e.test.ts`'s job, covered next).

### 3.3 Representative test cases

**A successful authenticated request**, from the workspace lifecycle test — this single call proves the full chain works, not just that a route function returns 200 when called directly:

```ts
// backend/tests/e2e/workspace.routes.e2e.test.ts:48-59
it("POST /api/workspace/create/new -> 201 with the created workspace", async () => {
  const { authHeader } = await createAuthenticatedUser();

  const res = await request(app)
    .post("/api/workspace/create/new")
    .set("Authorization", authHeader)
    .send({ name: "E2E Workspace", description: "made via supertest" });

  expect(res.status).toBe(201);
  expect(res.body.message).toBe("Workspace created successfully");
  expect(res.body.workspace.name).toBe("E2E Workspace");
});
```

**An unauthenticated request rejected with 401** — no `Authorization` header at all, asserted against the real `authenticate` middleware's own rejection path, not a mocked one:

```ts
// backend/tests/e2e/workspace.routes.e2e.test.ts:61-67
it("POST /api/workspace/create/new -> 401 with no Authorization header", async () => {
  const res = await request(app)
    .post("/api/workspace/create/new")
    .send({ name: "No Auth" });

  expect(res.status).toBe(401);
});
```

**A validation failure**, asserted down to the exact error shape the real `errorHandler` produces for a Zod validation error — this is only meaningful *because* the real `errorHandler` is mounted, not a test-only one that might format errors differently:

```ts
// backend/tests/e2e/workspace.routes.e2e.test.ts:69-79
it("POST /api/workspace/create/new -> 400 when name is missing", async () => {
  const { authHeader } = await createAuthenticatedUser();

  const res = await request(app)
    .post("/api/workspace/create/new")
    .set("Authorization", authHeader)
    .send({ description: "no name provided" });

  expect(res.status).toBe(400);
  expect(res.body.errorCode).toBe("VALIDATION_ERROR");
});
```

`auth.routes.e2e.test.ts` is the largest file (541 lines) and covers ground the other three files don't need to, because it's testing the routes that *produce* the tokens the rest of the suite consumes. It builds its own app (`buildApp()` at the top of the file, not `buildRoutedApp`) since `/auth` isn't mounted behind `authenticate` itself in `index.ts` — individual sessions/change-password routes within it are protected per-route instead — but it mounts the identical real `errorHandler`:

```ts
// backend/tests/e2e/auth.routes.e2e.test.ts:52-63
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);

  // Real production error handler, so the exact error JSON shape (including
  // ZodError field-level formatting and AppError errorCode) is asserted here.
  app.use(errorHandler);

  return app;
}
```

Its most valuable single test is the multi-step flow that proves the token this whole layer depends on is real, not a fixture that only happens to satisfy `authenticate`'s shape:

```ts
// backend/tests/e2e/auth.routes.e2e.test.ts:105-153 (excerpt)
it("full flow: register -> login -> access a protected route -> refresh -> logout", async () => {
  // 1. Register
  await request(app).post("/api/auth/register").send({
    email: "e2e-flow@example.com",
    name: "Flow User",
    password: "Correct@123",
  });

  // 2. Login
  const loginRes = await request(app).post("/api/auth/login").send({
    email: "e2e-flow@example.com",
    password: "Correct@123",
  });

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.access_token).toBeDefined();
  const setCookieHeader = loginRes.headers["set-cookie"];
  expect(setCookieHeader).toBeDefined();
  expect(setCookieHeader.join(";")).toMatch(/refresh_token=.*Secure/i);

  const accessToken = loginRes.body.access_token;

  // 3. Access a PROTECTED route (requires the `authenticate` middleware)
  //    using the real access token from login - proves the whole chain
  //    (login -> token -> authenticate middleware -> protected route) works.
  const sessionsRes = await request(app)
    .get("/api/auth/sessions")
    .set("Authorization", `Bearer ${accessToken}`);
  expect(sessionsRes.status).toBe(200);
  expect(Array.isArray(sessionsRes.body.sessions)).toBe(true);
  expect(sessionsRes.body.sessions.length).toBeGreaterThanOrEqual(1);
```

The inline comment on step 3 states the point of the whole layer in one line: this is the test that proves login's token is actually accepted downstream, not two separately-passing tests that never prove they compose.

---

## 4. Request/Data Flow

Trace one representative case precisely — `workspace.routes.e2e.test.ts`'s `"POST /api/workspace/create/new -> 201..."` test from §3.3 — start to finish, through every layer it touches.

1. **`beforeEach` builds the app.** `app = buildRoutedApp("/api/workspace", workspaceRoutes)` (`backend/tests/e2e/workspace.routes.e2e.test.ts:45`) runs before every test in the file. Inside `buildRoutedApp` (`backend/tests/setup/buildTestApp.ts:16-41`), a fresh Express app is constructed from scratch — `express.json()` and `cookieParser()` mounted first, then, since `options.authenticated` wasn't passed as `false`, the real `authenticate` middleware mounted directly in front of `workspaceRoutes` at `/api/workspace`, followed by the 404 fallback and the real `errorHandler`. This app object is rebuilt fresh for every single test (a new `beforeEach` call, not a shared module-level app), so no state leaks between tests via the Express instance itself.

2. **`createAuthenticatedUser()` mints real credentials.** Before the request is even issued, the test calls `createAuthenticatedUser()` (`backend/tests/setup/e2eAuth.ts:20-45`). This inserts a real `UserModel` document into the shared in-memory MongoDB — the same `MongoMemoryReplSet` instance every e2e, integration, and some unit tests in the suite share, booted once in `backend/tests/setup/vitest.setup.ts`'s `beforeAll` (documented in file 02's dive on integration testing). It then inserts a real `SessionModel` document, computing `expiresAt` via the actual `calculateExpiryDate` utility against the actual `config.JWT.REFRESH_TOKEN_EXPIRES_IN` value — which resolves to `"7d"` because `testEnv.setup.ts` (`backend/tests/setup/testEnv.setup.ts:32-33`) populated `process.env.JWT_REFRESH_TOKEN_EXPIRES_IN` before any of this code ran. Finally it calls the real `generateTokenPair(user._id, session._id.toString())` from `backend/src/utils/jwt.ts` — the exact function production's `createSessionService` calls — which signs a genuinely valid HS256 JWT against `config.JWT.ACCESS_TOKEN_SECRET` (also a `testEnv.setup.ts`-supplied value), embedding that real session's `_id` as `sessionId` in the payload.

3. **The test issues the request.** `request(app).post("/api/workspace/create/new").set("Authorization", authHeader).send({...})` — `supertest` constructs a real, spec-shaped HTTP request in-process against the `app` object built in step 1, with the `Authorization: Bearer <accessToken>` header set to the token minted in step 2.

4. **The request flows through the real middleware chain.** `express.json()` parses the body; `cookieParser()` runs (a no-op here, no cookies sent); the router match at `/api/workspace` triggers, and because this app was NOT built with `authenticated: false`, the real `authenticate` middleware (`backend/src/middlewares/auth.middleware.ts:10-57`) runs next, exactly as it would for this same route mounted in `src/index.ts:147-155` in production. It extracts the bearer token, verifies its signature against `verifyAccessTokenAndGetPayload`, looks up `UserModel.findById(payload.userId)` — finding the real user inserted in step 2 — checks `isActive`, looks up `SessionModel.findById(payload.sessionId)` — finding the real session inserted in step 2 — and checks `isValid`, `expiresAt`, and that the session's `userId` matches the user's. All five checks pass against real, freshly-inserted rows, so `req.user` and `req.session` are populated and `next()` is called.

5. **The real route handler runs against the real (in-memory) database.** `workspaceRoutes`' handler for `POST /create/new` runs unmodified — the same controller, the same service layer, the same Mongoose calls that run in production, just pointed at `mongodb-memory-server` instead of a real MongoDB cluster. A `Workspace` document is genuinely inserted.

6. **The response is asserted.** `res.status` is `201`, and `res.body.workspace.name` reflects what was actually persisted — not a return value from a mock, a real document read back from the real (in-memory) collection the controller wrote to.

Contrast this with what the unauthenticated variant in the same file (`"POST /api/workspace/create/new -> 401 with no Authorization header"`) exercises: steps 1–2 are identical (the app is still built the same way), but no `createAuthenticatedUser()` call happens and no `Authorization` header is set, so at step 4 `authenticate`'s very first check — `extractBearerToken(authHeader)` returning `null` — throws immediately, `next(error)` forwards it, and the real `errorHandler` (mounted at the bottom of `buildRoutedApp`) converts the thrown `UnauthorizedException` into the `401` response the test asserts. The route handler in step 5 never runs at all.

---

## 5. Design Decisions & Tradeoffs

**Why real middleware and real tokens instead of stubbing `req.user`.** `buildTestApp.ts`'s own header comment states the reasoning plainly: using the shared helper "instead of each e2e file hand-rolling its own minimal error handler / fake `req.user` stub" means "e2e tests actually exercise production auth/error wiring, not a stand-in." It's worth spelling out *why* that distinction is load-bearing rather than a style preference. A test that manually sets `req.user = fakeUser` before a handler runs can pass even if `authenticate` itself is completely broken — a JWT verification bug, a session-expiry check that accidentally always passes, a `session.userId` comparison with a sign error — because that middleware never runs at all in such a test. The one layer specifically responsible for deciding who's allowed to make a request would be silently excluded from the suite meant to catch exactly that class of bug. `workspace.routes.e2e.test.ts`'s own header comment makes the same point from the other direction: "so the whole chain (JWT -> authenticate -> route -> zod -> roleGuard -> service -> DB) is exercised, not a stubbed `req.user`." Every layer named in that chain is a place a bug could hide from a suite that fakes any one of them away.

**What's given up.** These are still in-process tests. There is no real TCP socket, no TLS handshake, no reverse proxy, and — per `buildRoutedApp`'s minimal app construction — not even the full `index.ts` bootstrap (`helmet()`, `pinoHttp`, CORS, the global `apiLimiter`, all documented in the middleware-pipeline chapter, are absent from the e2e app; only `auth.routes.e2e.test.ts`'s hand-built `buildApp()` and the route-local rate limiters inside `auth.route.ts` itself are exercised). "Does the app work when driven in-process, through its real routing and auth logic" is a meaningfully different and narrower question than "does the actually deployed system work" — the latter needs something further up the testing pyramid that checks the real built artifact, in its real container, behind its real load balancer, which AstriX does not currently have. This is the same honest gap the frontend module's own testing dive names for browser-level E2E coverage (no Playwright/Cypress anywhere in the repo, per file 00's tech-stack table) — the backend's version of that gap is the absence of a separate deployed-environment smoke-test layer sitting above this in-process suite. Neither gap is invented or assumed further than what's stated here; both are the natural ceiling of "real code, in-process" testing.

---

## 6. Security Considerations

This layer is specifically well positioned to catch real authorization and authentication bugs, precisely *because* it's the one layer in the whole suite that routes every authenticated request through the actual `authenticate` middleware and the actual `errorHandler`, rather than a mock of either. Concretely, from what the auth e2e file exercises:

**A broken JWT verification path would be caught, not silently skipped.** The "garbage bearer token" case sends a syntactically-present but cryptographically invalid token straight through the real verification call:

```ts
// backend/tests/e2e/auth.routes.e2e.test.ts:160-165
it("GET /api/auth/sessions -> 401 with a garbage bearer token", async () => {
  const res = await request(app)
    .get("/api/auth/sessions")
    .set("Authorization", "Bearer complete-nonsense");
  expect(res.status).toBe(401);
});
```

If `verifyAccessTokenAndGetPayload` (or the `jsonwebtoken` call underneath it) ever regressed to accepting an unsigned or malformed token, this is the test that would fail — and it would fail precisely because the real function ran, not a mock configured to always reject.

**A session-expiry check that stopped actually blocking expired sessions would surface here, not in a unit test that already assumes the check works.** No single test in the files read explicitly constructs an already-expired `SessionModel` row and asserts `401` against it — every existing case revolves around missing/garbage tokens and revoked (`isValid: false`) sessions, e.g. the reuse-adjacent case where a session is explicitly invalidated:

```ts
// backend/tests/e2e/auth.routes.e2e.test.ts:498-514
it("DELETE /api/auth/sessions/:id -> 200 and revokes only that session", async () => {
  const { authHeader, user } = await createAuthenticatedUser();
  const otherSession = await SessionModel.create({
    userId: user._id,
    isValid: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const res = await request(app)
    .delete(`/api/auth/sessions/${otherSession._id}`)
    .set("Authorization", authHeader);

  expect(res.status).toBe(200);

  const revoked = await SessionModel.findById(otherSession._id);
  expect(revoked!.isValid).toBe(false);
});
```

This is a real, present gap worth naming plainly rather than glossing over: nothing in the four files read constructs a session with `expiresAt` in the past and asserts the real `authenticate` middleware's `session.expiresAt <= new Date()` branch (`backend/src/middlewares/auth.middleware.ts:43-45`) actually rejects it. The mechanism to write that test already exists — `createAuthenticatedUser`'s `SessionModel.create` call could take an `expiresAt` override the same way `e2eAuth.ts` already computes one — but the test itself isn't there today. §8's debug drill below is built directly around this exact gap.

**An error-handler branch that leaked internal detail would show up as a body-content mismatch, not a passing test.** Because `auth.routes.e2e.test.ts` mounts the real `errorHandler`, tests that assert on `res.body.errorCode` (the workspace validation test in §3.3) or on exact status codes for malformed input are implicitly also asserting that `errorHandler`'s branches (`backend/src/middlewares/errorHandles.middleware.ts:70-148`) format errors the way they're documented to — a Zod validation failure becomes `{ message: "Validation failed", errors: [...], errorCode: "VALIDATION_ERROR" }`, not a raw stack trace or an internal Mongoose error string. If a future change to `errorHandler` accidentally started echoing `error.message` for an `AppError` branch that's supposed to stay generic, or dropped the `NODE_ENV === "production"` guard on the final catch-all branch (`errorHandles.middleware.ts:141-147`) that decides whether raw error text ever reaches a client, an e2e test asserting on the exact response body — not just the status code — is what would catch it. A test that only checks `res.status` and ignores the body would miss exactly this class of information-disclosure regression.

**A discipline this test suite depends on: the fake secrets never overlapping with real ones.** `createAuthenticatedUser` constructs real, cryptographically valid JWTs — but "valid" only relative to the secrets `testEnv.setup.ts` injects into `process.env` before any test runs: `JWT_ACCESS_TOKEN_SECRET = "test-access-token-secret"` and `JWT_REFRESH_TOKEN_SECRET = "test-refresh-token-secret"` (`backend/tests/setup/testEnv.setup.ts:30-31`). These are hardcoded, publicly-visible-in-source values. That's completely safe under one condition, stated nowhere in code but load-bearing for the whole suite: no deployed environment's real `JWT_ACCESS_TOKEN_SECRET`/`JWT_REFRESH_TOKEN_SECRET` is ever set to these same strings. If that condition ever broke — a copy-pasted `.env` file, a misconfigured SSM parameter — a token minted by this test helper would be a genuinely valid, production-accepted credential. The test suite has no mechanism that enforces this separation; it's a discipline the team maintains by never letting test-env values and real deployment secrets share a source of truth, not something the code itself verifies.

---

## 7. Best Practice Check

In-process HTTP testing via `supertest` against the real app object remains a squarely current, widely recommended pattern going into 2026 — it's the approach Express's own testing guidance points to, Fastify's documentation demonstrates the equivalent with its own `.inject()` method, and NestJS's testing utilities wrap the identical idea (`Test.createTestingModule` producing a real Nest application instance, then driven with `supertest` exactly as AstriX does). Nothing about AstriX's choice of tool or technique here is dated.

Where AstriX is disciplined, specifically relative to how this pattern is *commonly* implemented elsewhere: routing every e2e request through the real `authenticate` middleware and the real `errorHandler`, rather than the much more common shortcut of a test-only Express app with auth stubbed out for convenience. That shortcut is genuinely common in the wild — it's faster to write and doesn't require a helper like `createAuthenticatedUser` to exist at all — and it's exactly the corner AstriX's shared helpers are built to avoid cutting, for the reasons laid out in §5 and §6.

Where a more complete testing pyramid would add something AstriX doesn't have: a thin layer of genuinely out-of-process smoke tests — category (b) or (c) from §1 — run against a real deployed (or at least really-listening) instance of the built artifact, confirming the container starts, the health check passes, and a handful of critical endpoints respond correctly through the real network path. That's a different, complementary layer to this one, not a replacement for it — the in-process suite would stay exactly as valuable for what it already does well (fast, deterministic, full coverage of routing/auth/business logic) even if such a layer existed alongside it. AstriX doesn't have that layer today; per §5, that's the same honest gap already named for the frontend's browser-level E2E coverage, mirrored on the backend side as the absence of a deployed-environment smoke-test layer.

---

## 8. Debug Drill

**Scenario:** You add a new e2e test asserting that `GET /api/auth/sessions` returns `401` for an expired session — constructing a session with `expiresAt` set a few minutes in the past via `SessionModel.create`, then hitting the route with a token naming that session. The test passes. As a sanity check, you deliberately comment out the `expiresAt` check inside `authenticate`:

```ts
// backend/src/middlewares/auth.middleware.ts:43-45
// if (session.expiresAt <= new Date()) {
//   throw new UnauthorizedException("Session has expired");
// }
```

The test *still passes* — a 401 comes back either way. Where do you look first, and how do you tell whether this is a false-positive assertion (the test would pass no matter what the middleware does) versus the middleware being correctly bypassed by something else in test setup that isn't the check you're trying to isolate?

1. **Don't trust the single assertion — read exactly what else could produce a 401 on this same route.** `authenticate` has five sequential checks that each independently `throw new UnauthorizedException(...)` (`backend/src/middlewares/auth.middleware.ts:10-57`): missing token, invalid/expired JWT signature, user not found, user not active, session not found, session not valid, session expired, session/user mismatch. A `401` alone doesn't tell you *which* branch fired — the status code is identical across all of them. If your test only asserts `res.status === 401` (as several existing tests in `auth.routes.e2e.test.ts` do, e.g. the "garbage bearer token" case in §6), commenting out the `expiresAt` branch specifically proves nothing about whether that specific branch is the one that was ever being exercised.

2. **Check what `SessionModel.create` actually persisted.** If your test constructed the session with `isValid` left at its schema default — `true` per `backend/src/models/session.model.ts:256-259` — but the `expiresAt` value you passed was computed incorrectly (a sign error, a unit confusion between seconds and milliseconds, a `Date` constructed relative to the wrong "now"), the session might be landing in the database still *unexpired* by the time the request runs, and the `401` might instead be coming from a completely different check further down — or the request might even be a `200` you failed to notice because you asserted `toBeGreaterThanOrEqual(400)` instead of the exact code. Read the actual `expiresAt` value being inserted, not just the code that computes it, ideally by logging or asserting on the persisted document directly (as the existing `"DELETE /api/auth/sessions/:id -> 200 and revokes only that session"` test does — reading the row back with `SessionModel.findById` after the request, rather than trusting the response alone).

3. **Check the Mongo TTL index isn't quietly deleting the row before your request runs.** `Session.expiresAt` carries `index: { expireAfterSeconds: 0 }` — a genuine TTL index that MongoDB's background process sweeps on its own, "best effort, generally within 60 seconds" per Mongo's own documentation. Against `mongodb-memory-server`, TTL monitor behavior can differ from a full deployment; if the row you inserted with a past `expiresAt` gets deleted by the TTL sweep before your `supertest` request reaches `SessionModel.findById(payload.sessionId)` inside `authenticate`, the request would 401 on the *session not found* branch — several lines above the `expiresAt` check you're actually trying to isolate — regardless of whether that check itself works. This would make the test look green even with the real check fully broken, for a reason that has nothing to do with either.

4. **Isolate the branch by asserting on more than the status code.** The fix that actually disambiguates is asserting on `res.body` content that differs per branch, not just the shared `401` status — `UnauthorizedException`'s message ("Session has expired" specifically, versus "Session not found" or "Token expired") flows through to the JSON body via the `AppError` branch of `errorHandler` (`backend/src/middlewares/errorHandles.middleware.ts:134-139`, which echoes `error.message`). A test asserting `res.body.message` (or a distinguishing `errorCode`, where one exists) for the exact string this specific branch throws is a true positive for that branch and cannot be satisfied by a different `UnauthorizedException` thrown earlier in the same function — commenting out only the `expiresAt` check would then make *that specific* assertion fail while a differently-worded rejection from an earlier branch would not.

5. **Re-run with the check commented out and watch which assertion actually breaks.** Once the test asserts message/errorCode rather than just status, re-run it against the mutated middleware from the scenario. If it still passes, the test genuinely isn't exercising that branch — go back to steps 2–3 and find out which earlier check is actually firing. If it now correctly fails, you've confirmed the original (status-only) version really was a false positive, and you've also confirmed the fixed version is now doing its job — which is the general lesson worth carrying forward: a security-relevant assertion that can be satisfied by more than one code path isn't proving the thing its test name claims to prove, and the fastest way to find out is deliberately breaking the one behavior you think it's testing and confirming the test actually notices.
