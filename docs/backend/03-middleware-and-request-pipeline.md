# Middleware & Request Pipeline

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

Every backend framework has to answer the same question before it can answer any other: when an HTTP request arrives, what sequence of code gets a chance to look at it, transform it, reject it, or hand it forward? That sequence — the request pipeline — is where security headers get attached, where auth gets checked, where bodies get parsed, and where a client that's calling too fast gets told to slow down, all before a single line of "real" business logic runs. This file is about that pipeline in AstriX: how it's assembled, in what order, and why. It does **not** cover what happens when something in the pipeline throws — that's the dedicated subject of [`04-error-handling-patterns.md`](./04-error-handling-patterns.md) — and it does not re-explain the internals of the `authenticate` JWT guard, which belongs to [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md). What's left, and what this file owns in full, is ordering, CORS, security headers, and rate limiting.

## 1. The Landscape

"Middleware" is the industry's general name for a unit of code that sits between a raw incoming request and the code that ultimately produces a response, given a chance to inspect or modify the request/response, and either continuing the chain or short-circuiting it. Nearly every mature backend ecosystem has converged on some version of this idea, but the *shape* of the chain differs in ways that matter once you start reasoning about ordering, error propagation, and "run code after the handler finishes" use cases like access logging with response status codes.

### (a) Linear, callback-based chain — Express

Express (and frameworks modeled after it, like Connect before it or Fastify's hook system in spirit) treats middleware as an ordered list of functions, each of which receives `(req, res, next)` and must either call `next()` to pass control to the next function in the list, or end the response itself (`res.send()`, `res.json()`, etc.). Order is simply *registration* order — whichever `app.use()` call happened first runs first. There's no implicit "wrapping": once a middleware calls `next()`, it has handed off control, and by default it doesn't get to inspect what happened downstream unless it explicitly hooks a response event.

```js
// generic Express middleware — illustrative, not AstriX code
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next(); // hand off; this middleware has no idea what happens next
});

app.use((req, res, next) => {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: "Unauthorized" }); // chain stops here
  }
  next();
});
```

This is the model AstriX uses, and it's simple to reason about precisely because it's linear: to know what a request has been through by the time it reaches your handler, you read the `app.use()` calls top to bottom.

### (b) The "onion" model — Koa

Koa (built by the original Express team as its spiritual successor) replaced the callback chain with `async`/`await` middleware that wraps the *next* layer rather than simply handing off to it. Each middleware calls `await next()`, and everything written after that `await` runs **after** every downstream middleware and the final handler have completed — hence "onion": a request passes inward through each layer, and the response passes back outward through the same layers in reverse.

```js
// generic Koa middleware — illustrative, not AstriX code
app.use(async (ctx, next) => {
  const start = Date.now();
  await next(); // control passes all the way in, then back out, before we resume here
  const ms = Date.now() - start;
  ctx.set("X-Response-Time", `${ms}ms`); // runs AFTER the handler produced a response
});
```

This is a materially different capability: a single middleware can both prepare state *before* the request is handled and observe/modify the response *after*, without needing a separate "after" hook. It also means an unhandled promise rejection anywhere downstream naturally propagates back up through every `await next()` in the chain, which is why Koa middleware can wrap everything in one `try/catch` and catch errors from arbitrarily deep in the chain — something Express 4's callback model can't do for free. That distinction is directly relevant to AstriX: Express 4 middleware and route handlers that are `async` functions do **not** have their rejected promises automatically caught and routed to error-handling middleware — a thrown error inside an `async` controller silently becomes an unhandled rejection unless something explicitly forwards it to `next(err)`. That's exactly the gap AstriX's `asyncHandler` wrapper exists to close; it sits on every controller and forwards caught rejections into the centralized error handler. The full mechanics of `asyncHandler` and the `AppError`/`errorHandler` pipeline are covered in [`04-error-handling-patterns.md`](./04-error-handling-patterns.md) — the point here is only that the *choice* of a linear (non-onion) chain is why that wrapper has to exist at all.

### (c) Interceptor / filter chains — Servlet Filters, Spring Interceptors, ASP.NET Core middleware

Outside the Node ecosystem, the same ordered-chain idea shows up under different names. Java's Servlet API has `Filter`, which wraps a request/response pair and calls `chain.doFilter(request, response)` to pass control onward — structurally almost identical to Express's `next()`, just with an explicit `FilterChain` object instead of an implicit list. Spring layers `HandlerInterceptor` on top of that, with distinct `preHandle`/`postHandle`/`afterCompletion` methods, which is effectively the onion model made explicit as separate lifecycle callbacks rather than a single function with code before and after an `await`. ASP.NET Core's middleware pipeline (`app.Use(async (context, next) => { ... await next(); ... })`) is, syntactically, almost a direct copy of Koa's model in C#. The throughline across all of these ecosystems is the same: ordered, composable units that see a request before the "real" handler and can see the response after — the specific syntax (callback vs. `async`/`await` vs. named lifecycle methods) is a language-idiom choice more than a conceptual one.

### (d) Declarative / decorator-based — NestJS guards, interceptors, pipes

NestJS (built on top of Express or Fastify) offers a different mental model on top of the same underlying engine: instead of an imperative list of `app.use()` calls, cross-cutting concerns are attached to controllers or routes as decorators — `@UseGuards(AuthGuard)`, `@UseInterceptors(LoggingInterceptor)`, `@UsePipes(ValidationPipe)`. The request still flows through an underlying Express/Fastify middleware chain at the HTTP layer, but authorization, transformation, and validation are expressed declaratively, attached to the specific class or method they protect, and resolved by Nest's dependency-injection container at startup rather than by reading a linear list of `app.use()` calls.

```ts
// generic NestJS controller — illustrative, not AstriX code
@Controller("orders")
@UseGuards(AuthGuard) // declarative: this guard applies to every route below
export class OrdersController {
  @Post()
  @UsePipes(new ValidationPipe())
  create(@Body() dto: CreateOrderDto) {
    /* ... */
  }
}
```

The tradeoff is discoverability versus locality: Express's linear chain means you have to read `index.ts` to know the full list of what runs on every request, but a route file is self-contained proof of what protects *that specific* route. NestJS's decorators put the protection information directly on the route, at the cost of needing to understand the framework's DI resolution order to know precisely *when* a given guard or interceptor actually runs relative to another.

### Rate limiting has its own landscape

Separately from the middleware-chain shape, *how* a rate limiter counts and enforces a budget is its own design space, with real algorithmic tradeoffs:

- **Fixed window**: count requests in discrete time buckets (e.g. "requests since the top of this 15-minute window"), reset the counter to zero at the boundary. Simple, cheap, but has a well-known edge-burst problem: a client can send its full quota in the last second of one window and its full quota again in the first second of the next, getting roughly 2x its nominal budget in a short burst around the boundary. `express-rate-limit` (what AstriX uses) implements this strategy.
- **Sliding window**: instead of a hard reset, weight the previous window's count by how much of it still overlaps the current moment (sliding window counter), or track exact timestamps of each request in the window (sliding window log). Smooths out the boundary-burst problem at the cost of more bookkeeping. Cloudflare's rate limiting and many API gateways implement sliding-window variants.
- **Token bucket**: a bucket holds a capped number of tokens, refilled at a steady rate; each request consumes a token, and requests are rejected only once the bucket is empty. This naturally allows short bursts (up to the bucket's capacity) while still enforcing a long-run average rate — it's the model nginx's `limit_req` module uses, and it's what most modern general-purpose limiting libraries (e.g. `rate-limiter-flexible` on Node, or AWS API Gateway's usage-plan throttling) default to or at least offer alongside fixed/sliding window.

Orthogonal to the algorithm is *where the counters live*. An **in-memory** store (the default for `express-rate-limit` if no store is configured) keeps counters in the Node process's own memory — trivial to set up, but only correct if there's exactly one process handling all traffic. The moment an app runs as multiple instances behind a load balancer, each instance has its own independent counter, and the *effective* limit becomes (configured limit) × (instance count) — plus every deploy or instance replacement silently resets every counter to zero. A **shared-store** backend — Redis (via `rate-limit-redis` or `rate-limiter-flexible`'s Redis adapter, the most common choice at scale because `INCR` is a single atomic Redis primitive built for exactly this), a relational database, or — as AstriX does — MongoDB (via `rate-limit-mongo`) — centralizes the counters so every instance is enforcing the same real budget. The tradeoff, covered in depth in §5 below, is added latency and load on whatever store is chosen, and (for a non-Redis store) giving up the purpose-built atomic increment semantics Redis offers natively.

## 2. AstriX's Choice

AstriX uses Express's linear, ordered middleware chain — no onion model, no decorator layer. Global, cross-cutting middleware (security headers, structured logging, body parsing, cookie parsing, CORS, and a baseline rate limiter) is registered exactly once in `backend/src/index.ts`, in a fixed order, and applies to every request that reaches the app. On top of that floor, route-specific middleware — the `authenticate` JWT guard and a set of purpose-built rate limiters — is layered on per-router or per-route, closest to the handlers it protects. Rate limiting itself is a **fixed-window, Mongo-backed shared counter**, built on `express-rate-limit` with a custom `rate-limit-mongo`-backed store, chosen specifically so the limit is enforced consistently across every running instance of the backend rather than per-process.

## 3. AstriX Implementation

### 3.1 The rate-limiter factory

Every limiter in the app — the global floor and every route-specific one — is built by a single factory function, so the Mongo-backed-vs-in-memory decision and the per-limiter key-namespacing logic exist in exactly one place:

```ts
// backend/src/utils/rate-limiter.ts:1-79
import rateLimit, {
  type LegacyStore,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import MongoStore from "rate-limit-mongo";
import { config } from "../config/app.config";
import { logger } from "./logger";

// express-rate-limit's default store lives in the process's own memory. With
// N ECS tasks behind the ALB that makes every limit effectively N times
// looser than it reads (a 5-attempts-per-15-minutes login limit becomes
// 5 x N), and every deploy or task replacement resets all counters to zero.
// Backing the counters with Mongo - already a dependency, so no new
// infrastructure - makes them cluster-wide and survive task churn.
//
// One store instance is shared by every limiter, so there is exactly one
// extra Mongo connection per task rather than one per limiter. Each limiter
// namespaces its own keys (see `withKeyPrefix`), so sharing the collection
// does NOT merge their budgets.
const RATE_LIMIT_COLLECTION = "rateLimits";

// All limiters in this codebase use the same 15-minute window, which is what
// lets them share one store (the store's TTL is a per-instance setting).
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

let sharedStore: MongoStore | undefined;

const getSharedStore = (): MongoStore | undefined => {
  // No MONGO_URI means local dev or the test suite, neither of which has a
  // cluster to coordinate through. Fall back to express-rate-limit's own
  // in-memory store - still rate limited, just per-process.
  if (!config.MONGO_URI) {
    return undefined;
  }

  if (!sharedStore) {
    sharedStore = new MongoStore({
      uri: config.MONGO_URI,
      collectionName: RATE_LIMIT_COLLECTION,
      expireTimeMs: RATE_LIMIT_WINDOW_MS,
      errorHandler: (error) =>
        logger.error({ err: error }, "Rate limit store error"),
    });
  }

  return sharedStore;
};

// express-rate-limit passes the store nothing but the client key (the IP, by
// default), so two limiters sharing a collection would otherwise share a
// counter. Prefixing per limiter keeps each budget independent.
const withKeyPrefix = (store: MongoStore, prefix: string): LegacyStore => ({
  incr: (key, callback) => store.incr(`${prefix}:${key}`, callback),
  decrement: (key) => store.decrement(`${prefix}:${key}`),
  resetKey: (key) => store.resetKey(`${prefix}:${key}`),
});

/**
 * Builds a rate limiter whose counters are shared across every running
 * instance of the app.
 *
 * @param name - Namespace for this limiter's counters. Must be unique per
 *   limiter, or two limiters will spend each other's budget.
 */
export const createRateLimiter = (
  name: string,
  options: Partial<Options>
): RateLimitRequestHandler => {
  const store = getSharedStore();

  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    ...(store ? { store: withKeyPrefix(store, name) } : {}),
  });
};
```

Two details worth internalizing: `expireTimeMs` on the `MongoStore` is a TTL — Mongo itself expires stale counter documents rather than the app having to clean them up — and `standardHeaders: true` / `legacyHeaders: false` means every limited response carries the modern `RateLimit-*` headers (limit, remaining, reset) rather than the deprecated `X-RateLimit-*` set, which is the current IETF-draft-aligned convention `express-rate-limit` ships.

### 3.2 The global floor: `apiLimiter`

Mounted once, before any router, so every route that doesn't have its own limiter still has *some* ceiling:

```ts
// backend/src/index.ts:101-114
// ============================================
// RATE LIMITING (general) - /auth/* has its own stricter, route-specific
// limiters (see auth.route.ts); this is the floor for everything else so
// no route is left completely unlimited.
// ============================================

const apiLimiter = createRateLimiter("api", {
  max: 300,
  // Health checks (e.g. an ALB target-group check) can legitimately fire
  // far more often than any real API consumer and shouldn't be limited.
  skip: (req) => req.path === "/health",
});

app.use(apiLimiter);
```

300 requests per 15-minute window, per client IP, namespaced under the `"api"` key prefix — completely independent of any per-route limiter's counter, even though they share the same Mongo collection and the same store instance.

### 3.3 Per-route limiters, layered on top: `auth.route.ts`

`/auth/*` is where the tightest limiters live, because it's the only surface an unauthenticated attacker can hit directly and repeatedly — login, password reset, and OAuth callback all cost real work (a bcrypt compare, an email send, or a round trip to Google) and are classic brute-force/credential-stuffing/abuse targets:

```ts
// backend/src/routes/auth.route.ts:1-38
import { Router, Request, Response } from "express";
import { config } from "../config/app.config";
import { createRateLimiter } from "../utils/rate-limiter";
import {
  loginController,
  logOutController,
  logOutAllController,
  registerUserController,
  refreshTokenController,
  getSessionsController,
  googleCallbackController,
  forgotPasswordController,
  resetPasswordController,
  verifyEmailController,
  resendVerificationEmailController,
  changePasswordController,
  revokeSessionController,
} from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
import {
  generateGoogleOAuthState,
  getGoogleAuthorizationUrl,
} from "../providers/google.provider";

const authRoutes = Router();

const authLimiter = createRateLimiter("auth", {
  max: 5,
  message: {
    error: "Too many login attempts. Please try again in 15 minutes.",
  },
  skipSuccessfulRequests: true,
});

const refreshLimiter = createRateLimiter("refresh", {
  max: 30,
  message: { error: "Too many refresh attempts. Please try again later." },
});
```

And its registration on the actual routes, shown alongside the global limiter for contrast — note that `authLimiter` is passed as route-specific middleware directly in the `Router.post()` call, not mounted with `app.use()`:

```ts
// backend/src/routes/auth.route.ts:75-77
authRoutes.post("/register", authLimiter, registerUserController);
authRoutes.post("/login", authLimiter, loginController);
authRoutes.post("/refresh", refreshLimiter, refreshTokenController);
```

`max: 5` on `authLimiter` versus `max: 300` on the global `apiLimiter` is a deliberate, large gap — 60x stricter — because these two limiters are answering different questions: `apiLimiter` asks "is this client doing something pathological across the whole API," while `authLimiter` asks "is this client trying to guess a password." `skipSuccessfulRequests: true` on `authLimiter` is equally deliberate: only requests that *don't* succeed count against the budget, so a legitimate user who logs in correctly five times in a row (new device, multiple tabs, etc.) never gets locked out — only five *failed* attempts do, which is exactly the credential-guessing pattern the limiter exists to slow down. The same pattern repeats for every other public or sensitive `/auth/*` endpoint, each with its own namespace and its own tuned `max` — `passwordResetLimiter` (max 5, because it triggers a real email send and can be used to probe which addresses have accounts), `oauthLimiter` (max 20, covering both the OAuth kickoff redirect and the callback, which hits Google's token endpoint and writes to the DB per call), `emailVerificationLimiter` (max 5, its own budget so it doesn't compete with password-reset's), and `changePasswordLimiter` (max 10, bounding an *authenticated* action against a compromised access token being used to lock a real user out).

### 3.4 CORS configuration

```ts
// backend/src/index.ts:82-99
// ============================================
// CORS CONFIGURATION
// ============================================

// FRONTEND_ORIGIN may be a single origin or a comma-separated list (e.g.
// staging + prod, or an apex domain + its "www" subdomain).
const allowedOrigins = config.FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // CRITICAL: Allows cookies to be sent cross-origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
```

`FRONTEND_ORIGIN` defaults to `http://localhost:5173` in `app.config.ts` if the environment variable is unset entirely, but if it's ever set to an **explicit empty string**, `getEnv` returns that empty string as-is (its default-substitution logic only triggers on `undefined`, not on `""`), and `"".split(",").map(trim).filter(Boolean)` collapses to an empty array. `allowedOrigins` is therefore *always* passed to the `cors` package as an array — never as the bare string `"*"` or `undefined` — which matters for exactly how misconfiguration fails; see §6.

### 3.5 The full ordered registration section, self-contained

`00-master-backend-architecture.md` reproduces the entire bootstrap file top to bottom; the excerpt that matters specifically for *pipeline ordering* — from app creation through the last piece of global middleware before routes are mounted — is this, read in sequence exactly as Express executes it:

```ts
// backend/src/index.ts:27-114
const app = express();

/**
 * We run behind CloudFront → ALB → Express
 * So we must trust the first proxy.
 */
app.set("trust proxy", 1);

const BASE_PATH = config.BASE_PATH;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Security headers (XSS protection, etc.)
app.use(helmet());

// ============================================
// REQUEST LOGGING (structured, with per-request correlation id)
// ============================================

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id = typeof existing === "string" ? existing : crypto.randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
  })
);

// ============================================
// BODY PARSING
// ============================================

// This API is JSON-only - no route reads a form-encoded body, so we don't
// mount express.urlencoded(). An explicit size limit replaces the implicit
// (and undocumented) 100kb default.
app.use(express.json({ limit: "1mb" }));

// ============================================
// COOKIE PARSER - CRITICAL FOR REFRESH TOKENS!
// ============================================

/**
 * This parses cookies from incoming requests
 * Without this, req.cookies will be undefined!
 *
 * The refresh token is sent as an httpOnly cookie,
 * so we MUST be able to read it.
 */
app.use(cookieParser());

// ============================================
// CORS CONFIGURATION
// ============================================

// FRONTEND_ORIGIN may be a single origin or a comma-separated list (e.g.
// staging + prod, or an apex domain + its "www" subdomain).
const allowedOrigins = config.FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // CRITICAL: Allows cookies to be sent cross-origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ============================================
// RATE LIMITING (general) - /auth/* has its own stricter, route-specific
// limiters (see auth.route.ts); this is the floor for everything else so
// no route is left completely unlimited.
// ============================================

const apiLimiter = createRateLimiter("api", {
  max: 300,
  // Health checks (e.g. an ALB target-group check) can legitimately fire
  // far more often than any real API consumer and shouldn't be limited.
  skip: (req) => req.path === "/health",
});

app.use(apiLimiter);
```

Then, after `/api/docs` (non-production only) and the `/health` route, every domain router is mounted — `authRoutes` bare, every other domain router with `authenticate` inline at the mount point:

```ts
// backend/src/index.ts:147-155
// Auth routes (mostly public)
app.use(`${BASE_PATH}/auth`, authRoutes);

// Protected routes (require JWT)
app.use(`${BASE_PATH}/user`, authenticate, userRoutes);
app.use(`${BASE_PATH}/workspace`, authenticate, workspaceRoutes);
app.use(`${BASE_PATH}/project`, authenticate, projectRoutes);
app.use(`${BASE_PATH}/task`, authenticate, taskRoutes);
app.use(`${BASE_PATH}/member`, authenticate, memberRoutes);
```

Route-specific rate limiters like `authLimiter` then apply *inside* `authRoutes` itself, on individual `Router.post()`/`.get()` calls — one more layer of middleware, mounted closer to the handler than anything in `index.ts`. After the routers, the pipeline ends in a 404 handler and `errorHandler` (mounted last, as required by Express — an error-handling middleware with four parameters is only ever called for errors forwarded via `next(err)`), both of which belong to [`04-error-handling-patterns.md`](./04-error-handling-patterns.md) rather than this file.

## 4. Request/Data Flow

**A request that exceeds the global limit.** A client hammering, say, `GET /api/workspace` past 300 requests in a 15-minute window sends request #301. It passes through `helmet()` (headers attached), `pinoHttp` (logged, request ID assigned), `express.json()` (body parsed if present), `cookieParser()` (cookies parsed), and `cors()` (origin checked, CORS headers attached) exactly as every other request does — none of those care about request volume. It then reaches `app.use(apiLimiter)`, mounted at `index.ts:114`, *before* any router. `apiLimiter` looks up the client's key (IP, by default, via `express-rate-limit`'s default key generator) in the Mongo-backed store under the `"api:"` prefix, sees the count already at 300 for this window, and — without calling `next()` — sends the response itself: HTTP 429, `RateLimit-*` headers reflecting the limit/remaining/reset state, and `express-rate-limit`'s own default rate-limit-exceeded body (the `apiLimiter` config doesn't override `message`, unlike every `/auth/*` limiter). The request never reaches `app.use(BASE_PATH/workspace, authenticate, workspaceRoutes)` — `authenticate` never runs, the controller never runs, Mongo is never queried for the actual workspace data.

**A request that exceeds a per-route limit.** Contrast that with a client hammering `POST /api/auth/login` specifically. Request #301-in-this-window (assuming the client hasn't also blown the global budget) sails past `apiLimiter` exactly as above — that counter increments too, since every request touches the global limiter regardless of which route it's headed for — and is routed by `app.use('${BASE_PATH}/auth', authRoutes)` into the `authRoutes` router. Express matches `POST /login` and runs that route's own middleware stack in registration order: `authLimiter` first, then `loginController`. `authLimiter` checks the `"auth:"`-prefixed counter (completely separate from `"api:"`), and if this client has already had 5 *failed* login attempts in the window (remember `skipSuccessfulRequests: true` — only non-2xx-3xx responses count), it short-circuits with the custom body configured on this specific limiter: `{ error: "Too many login attempts. Please try again in 15 minutes." }`, HTTP 429. `loginController` never runs, so no bcrypt comparison and no session/JWT issuance happens for this attempt. The key difference from the global case: this client could be nowhere near the 300-request global ceiling and still get blocked here, because `authLimiter`'s budget is deliberately far smaller and evaluated independently.

**A CORS preflight.** A browser sending a cross-origin request that isn't a "simple request" under the CORS spec — anything with an `Authorization` header, which AstriX's authenticated routes require — first sends an `OPTIONS` request with `Access-Control-Request-Method` and `Access-Control-Request-Headers`. That preflight enters the same pipeline: `helmet()`, `pinoHttp`, `express.json()` (a no-op on an OPTIONS request with no body), `cookieParser()`, and then `cors()`. The `cors` middleware itself recognizes the `OPTIONS` method as a preflight and — with its default `preflightContinue: false`, which AstriX doesn't override — handles it completely on its own: it computes whether the `Origin` header is present in `allowedOrigins`, attaches the appropriate `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, and (since `credentials: true`) `Access-Control-Allow-Credentials: true` headers, and responds immediately with its default success status (204), **without calling `next()`**. `apiLimiter`, the routers, `authenticate`, and every controller are entirely bypassed for a preflight — it never gets further than the `cors()` middleware. Only if the browser's actual follow-up request (the real `GET`/`POST`/etc.) is sent does it continue on into `apiLimiter` and beyond like any other request.

## 5. Design Decisions & Tradeoffs

**Why Mongo instead of Redis.** AstriX's backend runs as multiple ECS Fargate tasks behind an Application Load Balancer — there is no single process handling all traffic, so an in-memory rate-limit store (the `express-rate-limit` default) would give each task its own independent counter. A `max: 5` login limiter would, in practice, allow up to `5 × (number of running tasks)` attempts, and every deploy or task replacement — which happens routinely — would silently reset every counter back to zero, handing an attacker a fresh budget for free. A shared, cluster-wide store is not optional here; it's the only way the configured numbers mean what they say. Redis is the more conventional choice for this exact problem at scale, purpose-built with an atomic `INCR` primitive and native per-key TTL. AstriX chose MongoDB instead, specifically because it's already a hard dependency of the app — no new piece of infrastructure, no new connection pool to provision, monitor, and secure, no new failure mode to reason about in an incident. What's given up in that trade is real: every rate-limit check becomes a write against the same primary datastore that serves the actual product's reads and writes, and that's a high-write-frequency, low-value-per-write workload (a counter increment) competing for the same connection pool and write capacity as a user creating a task or a workspace being renamed. At AstriX's current traffic, that's a reasonable trade; it stops being one exactly at the point where rate-limiter writes become a measurable fraction of total Mongo load, which is the point a dedicated store (Redis, specifically) earns its keep.

**Why the counters share one store instance but are namespaced.** `getSharedStore()` memoizes a single `MongoStore`, reused by every `createRateLimiter()` call, rather than opening a fresh Mongo connection per limiter. That's a straightforward resource-efficiency choice — one extra connection per running task instead of one per limiter per task — made safe by `withKeyPrefix`, which means sharing the connection never risks two unrelated limiters accidentally spending from the same counter.

**Why global middleware is registered once in `index.ts` rather than per-router.** Helmet, structured logging, body parsing, cookie parsing, CORS, and the floor rate limiter apply identically to every request the app serves, regardless of which domain router eventually handles it. Registering each of those six pieces once, before any router is mounted, means there is exactly one place to look to know what every request goes through, and — more importantly — no way for a newly added router to accidentally skip one of them by omission. The alternative (each router individually importing and re-mounting `helmet()`, `cors()`, etc.) would work, but would make "is this route actually CORS-protected" a question that requires checking every router file individually rather than one glance at `index.ts`. Route-specific concerns (which endpoints need auth, which need a stricter rate limit) are the opposite case — they vary per route, so they're deliberately *not* forced into the same one-size-fits-all global layer, and instead sit closest to the specific route they modify.

## 6. Security Considerations

**What `helmet()`'s defaults actually protect against.** AstriX calls `helmet()` with no configuration, which (installed version `^8.1.0`, matching the `8.3.0` in `node_modules` at the time of writing — Helmet's defaults have been stable across the 8.x line) sets a specific, documented set of headers: a `Content-Security-Policy` defaulting to `default-src 'self'` plus per-directive defaults (`base-uri 'self'`, `font-src 'self' https: data:`, `form-action 'self'`, `frame-ancestors 'self'`, `object-src 'none'`, `script-src 'self'`, `upgrade-insecure-requests`, among others) — meaningful primarily for browser-rendered content, and largely inert for a pure JSON API that never serves HTML, though it costs nothing to have it set. `X-Content-Type-Options: nosniff` stops browsers from MIME-sniffing a response into a different content type than declared, closing off a class of content-type-confusion attacks. `X-Frame-Options: SAMEORIGIN` and `Cross-Origin-Opener-Policy: same-origin` mitigate clickjacking by preventing the API's responses from being framed by another origin. `Strict-Transport-Security: max-age=31536000; includeSubDomains` tells browsers to only ever reach this host over HTTPS for a year going forward. `X-DNS-Prefetch-Control: off` disables passive DNS prefetching. `X-Download-Options: noopen` and `X-Permitted-Cross-Domain-Policies: none` are legacy IE/Flash-era mitigations, essentially free to leave on. Helmet also removes the `X-Powered-By` header Express sets by default, and explicitly sets the legacy `X-XSS-Protection` header to `0` — deliberately *disabling* the old browser XSS auditor, which is current best practice, since that auditor was itself a source of exploitable behavior in older browsers and modern browsers no longer implement it. None of this is bespoke to AstriX; it's Helmet's stock configuration, which is precisely the point — the defaults are a reasonable, broadly-applicable baseline, and AstriX takes them as-is.

**CORS misconfiguration.** This is worth being precise about rather than assuming the "obvious" failure mode. If `FRONTEND_ORIGIN` is left completely unset, `app.config.ts`'s `getEnv("FRONTEND_ORIGIN", "http://localhost:5173")` supplies a safe default — CORS is never accidentally wide open just because the variable was forgotten. The genuinely risky misconfiguration is setting `FRONTEND_ORIGIN` to the literal string `*`, expecting classic "allow everything" CORS behavior. That is **not** what happens: because `index.ts` always calls `.split(",")` on `FRONTEND_ORIGIN` before handing it to `cors()`, the `origin` option passed to the `cors` package is always an *array* (`["*"]` in this case), never the bare string `"*"`. The `cors` package's own origin-matching logic (`backend/node_modules/cors/lib/index.js`) treats a bare string `"*"` specially as "allow any origin," but for an *array* input it does per-element string equality against the incoming `Origin` header — and `"*"` will never literally equal a real browser's `Origin` header value. The practical result of misconfiguring `FRONTEND_ORIGIN=*` is not an open CORS policy; it's a **fully broken one** that rejects every real browser origin, which is a safer failure mode than it might sound (fails closed, not open) but a confusing one to debug. The same fails-closed behavior applies if `FRONTEND_ORIGIN` is ever set to an empty string: `allowedOrigins` becomes `[]`, and an empty array matches nothing, so every cross-origin request is denied. Neither misconfiguration accidentally opens the API to arbitrary origins — but both would take down the real frontend, which is exactly the "intermittent/total CORS breakage" failure this file's debug drill below is built around.

**Rate limiting as brute-force defense.** `authLimiter`'s `max: 5` versus `apiLimiter`'s `max: 300` is the concrete expression of "the login endpoint is where an attacker gets the most value from automation" — a credential-stuffing script trying a breached password list against many accounts, or a brute-force script trying many passwords against one account, is throttled 60x harder than any other traffic on the API. `skipSuccessfulRequests: true` sharpens that further: the counter only advances on failure, so the limiter is measuring *wrong password attempts specifically*, not general login traffic.

**The 1mb body-size limit.** `express.json({ limit: "1mb" })` replaces Express's implicit, undocumented 100kb default with an explicit, intentional one. A body-size cap is a basic but real mitigation against a class of denial-of-service: without one, a client could send an arbitrarily large JSON payload and force the server to spend CPU and memory parsing it before any validation logic ever gets a chance to reject it. 1mb is generous relative to any legitimate payload this JSON-only API actually needs (no file uploads flow through this path), so the limit is there specifically as a backstop against abuse, not a constraint on real usage.

## 7. Best Practice Check

For the pipeline shape itself, AstriX is squarely current practice: a linear Express chain with global concerns mounted once and route-specific concerns layered closest to the route they protect is exactly how a well-organized Express 4/5 app is built in 2026, and nothing about that has meaningfully changed since Express's early years — the framework's execution model is what it is, and AstriX uses it idiomatically.

Rate limiting is the part with the more interesting gap. Fixed-window counting is the simplest correct algorithm for the problem, and it's what AstriX uses via `express-rate-limit`'s default strategy — that's a reasonable, well-tested choice, but it is the *oldest* of the three algorithms surveyed in §1, and it does carry the boundary-burst characteristic described there. A token-bucket or sliding-window approach would tolerate legitimate bursty traffic more gracefully without loosening the real abuse ceiling, and libraries like `rate-limiter-flexible` support those strategies as first-class options on Node today. More significant than the algorithm choice is the store: the current default assumption at real scale, in 2026, is a Redis-backed distributed limiter — not because Mongo-backed limiting is wrong, but because Redis is purpose-built for exactly this access pattern (atomic increment, native TTL, microsecond-scale latency, no interaction with the app's primary transactional workload). AstriX's Mongo-backed approach is a deliberate, honestly-reasoned tradeoff for its current scale (§5), not an oversight — but it is the one piece of this pipeline that a team would revisit first if login/API traffic grew by an order of magnitude, and it's fair to call it a dated-but-currently-reasonable choice rather than best-in-class.

## 8. Debug Drill

**Scenario:** A user reports that requests from the production frontend to the API fail with a CORS error — but only sometimes. Refreshing the page usually "fixes" it, and other users report no problem at all. Where do you look first, and why? This is a generic diagnostic path, applicable to any Express app fronted by `cors()`, not specific to any one finding in AstriX's history.

1. **Confirm it's actually CORS, not something else wearing a CORS-shaped mask.** Open the browser's network tab on a failing request. A *true* CORS rejection shows the actual request completing on the wire (you can see a response) while the browser console reports a CORS policy violation and JavaScript never receives the response body. If instead the request itself times out or returns a 5xx with no CORS headers at all, the proximate problem is upstream of CORS entirely (the app crashed, the load balancer has no healthy targets) and is masquerading as a CORS error only because the browser's generic "network error" and "blocked by CORS" messages look similar to an unfamiliar eye.
2. **Check whether the failures are correlated with which backend instance served the request.** If the API runs as multiple processes/instances (as AstriX does, on ECS Fargate) and `FRONTEND_ORIGIN` is read from that instance's own environment at startup, a rolling deploy where old and new task definitions briefly coexist — or a task that picked up a stale/incorrect env var — will have *some* instances serving the correct CORS headers and others not, and the load balancer round-robins between them. That produces exactly the "works, then doesn't, then does again on refresh" pattern the user is describing, because each refresh may hit a different instance. Check the deployed environment configuration for every currently-running instance, not just one.
3. **Check for a mismatch between the actual `Origin` header and what's configured**, byte for byte — protocol (`http` vs `https`), the presence or absence of a `www.` subdomain, and a trailing slash are all distinct origins to a browser and to `cors()`'s string-equality check, even though they "look the same" to a human skimming a config value. If the frontend is reachable at more than one hostname (an apex domain and a `www` alias, or a preview/staging domain sharing infrastructure), confirm every one of them is present in the comma-separated `FRONTEND_ORIGIN` list, exactly as the browser sends it.
4. **Only after ruling out both of the above, treat it as a real code-level CORS logic bug** — inspect the `cors()` configuration itself for anything that varies the computed `origin` per-request (a dynamic origin function with a bug, for instance) rather than the static array AstriX currently uses. An intermittent failure that survives steps 1–3 and is *not* explained by environment drift across instances is the point at which the middleware configuration itself, rather than its inputs, becomes the suspect.

The general lesson, transferable to any Express pipeline: CORS bugs that are *intermittent* are disproportionately likely to be an *environment/deployment* problem (different instances disagreeing on config) rather than a *logic* problem in the `cors()` call itself, precisely because a static, correctly-written CORS configuration produces the same answer for the same request every single time — intermittency is itself the strongest clue that something about the request's path through the system, not the CORS logic, is what's actually changing between attempts.
