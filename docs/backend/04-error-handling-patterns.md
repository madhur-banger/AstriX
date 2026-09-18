> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Error Handling Patterns

Every backend eventually has to answer the same question: when something goes wrong three function calls deep — a malformed request, a missing row, a permission check that fails, a bug nobody caught in review — how does that failure travel back up to an HTTP response, and who decides what that response looks like? Get this wrong and you end up with either a wall of duplicated `try/catch` blocks (every route re-inventing its own error shape) or, worse, a stack trace leaking straight into a client's browser console in production.

This chapter surveys the real, industry-recognized ways backends solve this problem, then goes line-by-line through AstriX's answer: a typed `AppError` exception hierarchy, a hand-rolled `asyncHandler` wrapper, and one centralized Express error-handling middleware with a fixed precedence chain. The [middleware pipeline chapter](./03-middleware-and-request-pipeline.md) covers where `asyncHandler` and `errorHandler` sit in the mount order; this chapter is the canonical source on how they actually work.

> **Note on this revision:** AstriX's backend was migrated off MongoDB/Mongoose onto PostgreSQL (via Drizzle ORM) and Redis (via ioredis) — see `backend/migrations/PLAN.md` for the full six-phase history. That migration deleted three branches from `errorHandler` that used to exist purely to translate Mongoose's own error shapes (`CastError`, schema `ValidationError`, duplicate-key `11000`) into clean HTTP responses. Those branches can never fire anymore, because nothing in this codebase throws a Mongoose error anymore — there is no Mongoose. This chapter documents the handler as it exists today, and calls out what got deleted and why, rather than silently pretending those branches never existed.

---

## 1. The Landscape

Before looking at AstriX, it's worth knowing that "how do I get an error from deep inside my business logic back to an HTTP response" has at least four genuinely different, widely-used answers. They aren't just stylistic variants of each other — they make different tradeoffs about who is *forced* to handle a failure, and when.

### (a) Thrown exceptions, caught by a centralized handler

The dominant pattern in Express (and most stateful, framework-driven backends: Rails, Django, Spring). Application code `throw`s when something goes wrong; a single piece of middleware, mounted last, catches everything that bubbles up and decides how to turn it into a response. In Express specifically, this is built on the framework's own `next(error)` convention: call `next` with an argument, and Express skips every remaining normal middleware and routes straight to the next *error-handling* middleware (the one with a 4-argument signature `(err, req, res, next)`).

```js
// route handler
app.get("/widgets/:id", async (req, res, next) => {
  try {
    const widget = await db.query.widgets.findFirst({ where: eq(widgets.id, req.params.id) });
    if (!widget) throw new NotFoundError("Widget not found");
    res.json(widget);
  } catch (err) {
    next(err); // hands off to the centralized handler
  }
});

// mounted once, last
app.use((err, req, res, next) => {
  const status = err.statusCode ?? 500;
  res.status(status).json({ message: err.message });
});
```

**Tradeoff:** this is ergonomic and familiar — most engineers already think in `try/throw/catch`, and the response-shaping logic lives in exactly one place instead of being copy-pasted into every route. The cost is that it relies entirely on developer discipline: nothing in the type system stops a route from forgetting to `catch`, or from throwing a raw, untyped `Error` that the centralized handler can't categorize and therefore has to treat as an opaque, generic failure. AstriX's approach — covered below — is a variant of this option.

### (b) Per-route try/catch, no central funnel

This was the *default* shape of an Express app before wrapper utilities (like AstriX's `asyncHandler`, or the popular `express-async-errors` package) became common, and it's still what you get in a minimal Express 4 app with no extra tooling. Every route handler is independently responsible for catching its own errors and writing its own response — there's no shared middleware doing the categorization.

```js
app.get("/widgets/:id", async (req, res) => {
  try {
    const widget = await db.query.widgets.findFirst({ where: eq(widgets.id, req.params.id) });
    if (!widget) {
      return res.status(404).json({ message: "Widget not found" });
    }
    res.json(widget);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Something went wrong" });
  }
});
```

**Tradeoff:** zero magic, zero indirection — you can read any single route file and know exactly what it returns on failure, with nothing happening "elsewhere." The cost is duplication at scale: every route re-implements the same status-code mapping and the same generic-500 fallback, and it's trivial for one handler to just... forget the `catch` entirely, especially with `async` handlers (an unhandled promise rejection inside an Express 4 route doesn't call your error middleware at all — it can crash the process or silently vanish, since Express 4's router has no idea how to await anything). This exact gap is precisely what `asyncHandler`-style wrappers exist to close, and it's why AstriX doesn't use this pattern.

### (c) Result/Either return types — no exceptions at all

Instead of throwing, a function *returns* a value that explicitly encodes success-or-failure, and the caller is forced by the type system to check which branch it got before it can use the value. This is the default in Rust (`Result<T, E>`, an enum with `Ok(T)` and `Err(E)` variants that the compiler will not let you silently ignore) and in Go (functions conventionally return `(value, error)` as a tuple, and idiomatic Go checks `if err != nil` immediately after every call). In TypeScript, this isn't built into the language, but it's a well-established pattern via libraries like `neverthrow` or `fp-ts`'s `Either`:

```ts
// TypeScript, using neverthrow-style Result
function findWidget(id: string): Result<Widget, NotFoundError> {
  const widget = db.widgets.get(id);
  return widget ? ok(widget) : err(new NotFoundError("Widget not found"));
}

const result = findWidget(req.params.id);
if (result.isErr()) {
  return res.status(404).json({ message: result.error.message });
}
res.json(result.value); // TypeScript knows result.value exists here
```

```go
// Go
widget, err := db.FindWidget(id)
if err != nil {
    http.Error(w, "widget not found", http.StatusNotFound)
    return
}
json.NewEncoder(w).Encode(widget)
```

**Tradeoff:** this is the strongest guarantee of the four — you *cannot* accidentally forget to handle an error, because the success value is only reachable after the compiler has forced you to check the error branch. There's no equivalent of "a raw error silently reaching a generic 500 handler because nobody threw a typed exception," because there's no throwing at all in the happy-path plumbing. The cost is verbosity and a mismatch with idiomatic JS/TS: every call site that can fail needs an explicit branch, `async/await` and `Promise` rejection don't compose naturally with Result types without extra wrapping, and most of the Node/Express ecosystem (including Drizzle and the `pg`/`ioredis` drivers underneath it, which AstriX depends on directly) throws real exceptions, not Results — so adopting this pattern fully would mean wrapping every third-party call at the boundary.

### (d) Domain-specific error middleware chains / standardized problem-detail shapes

Orthogonal to *how* an error is caught, this is about standardizing *what the HTTP response body looks like* once you've decided to send one. **RFC 7807 ("Problem Details for HTTP APIs")** is the most widely cited standard here: it specifies a fixed JSON shape — `type` (a URI identifying the error kind), `title` (a short human-readable summary), `status` (the HTTP status code, repeated in the body), `detail` (a human-readable explanation specific to this occurrence), and `instance` (a URI identifying this specific occurrence) — plus a registered `application/problem+json` media type.

```json
{
  "type": "https://api.example.com/errors/insufficient-funds",
  "title": "Insufficient Funds",
  "status": 403,
  "detail": "Your account balance of $30 is insufficient to cover the $50 charge.",
  "instance": "/transactions/12345"
}
```

**Tradeoff:** a standardized shape means any client built against RFC 7807 — including generic tooling and SDKs — can parse errors from *any* RFC-7807-compliant API the same way, without bespoke per-backend parsing logic. This matters most when the API has external consumers who don't control your codebase. The cost is that it's one more contract to hold constant across every error branch in your app (each `type`/`title` pair effectively becomes a mini public API), and it doesn't tell you anything about *how* the server produces that shape internally — RFC 7807 is compatible with any of options (a), (b), or (c) as the underlying catching mechanism. A bespoke shape like `{ message, errorCode }` is simpler to produce and consume for an API with one first-party client, at the cost of not being a recognized standard.

---

## 2. AstriX's Choice

AstriX uses **option (a)**: thrown exceptions from a typed `AppError` class hierarchy, wrapped at every controller by `asyncHandler` so nothing has to remember to `try/catch`, funneled into **one** centralized Express error-handling middleware (`errorHandler`) that applies a fixed precedence chain by error type. The response shape is bespoke — `{ message, errorCode?, errors? }` — not RFC 7807. There is no Result/Either type anywhere in the codebase; every service and controller signals failure the same way, by throwing.

This choice predates and survives the Postgres/Redis migration unchanged in shape — `asyncHandler`, `AppError`, and the overall precedence-chain design were never Mongo-specific ideas. What *did* change is the handler's contents: three branches that existed solely to interpret Mongoose's own untyped error objects are gone, because nothing in the codebase can produce them anymore (§3.3, §5).

---

## 3. AstriX Implementation

### 3.1 `asyncHandler` — the wrapper that makes option (a) actually safe

Every controller in AstriX is wrapped in this function. It exists specifically to close the gap described in landscape option (b): an `async` Express route handler that rejects has no built-in way to reach Express's error-handling middleware, because Express 4's router doesn't `await` anything. `asyncHandler` is the manual fix for that.

```ts
// backend/src/middlewares/asyncHandler.middleware.ts:1-21
import { NextFunction, Request, Response } from "express";

// Controllers resolve with whatever `res.json()`/`res.send()` returns
// (an Express `Response`), which this handler never reads - `unknown`
// documents that the resolved value is intentionally ignored, without
// the free pass on unsafe operations `any` would grant it.
type AsyncControllerType = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export const asyncHandler =
  (controller: AsyncControllerType): AsyncControllerType =>
  async (req, res, next) => {
    try {
      await controller(req, res, next);
    } catch (error) {
      next(error);
    }
  };
```

It's a higher-order function: `asyncHandler(controller)` returns a *new* async function with the same signature, which awaits the real controller inside a `try/catch` and forwards anything it catches to `next`. Every controller export in the codebase is written as `asyncHandler(async (req, res) => { ... })` — the `throw` statements inside a controller or any service it calls never need their own `try/catch`, because this one wrapper guarantees the rejection reaches Express's error pipeline. None of this changed in the migration — `asyncHandler` has no idea what database sits underneath the services it wraps.

### 3.2 The `AppError` hierarchy

```ts
// backend/src/utils/appError.ts:1-85
import { HTTPSTATUS, HttpStatusCodeType } from "../config/http.config";
import { ErrorCodeEnum, ErrorCodeEnumType } from "../enums/error-code.enum";

export class AppError extends Error {
  public statusCode: HttpStatusCodeType;
  public errorCode?: ErrorCodeEnumType;

  constructor(
    message: string,
    statusCode: HttpStatusCodeType = HTTPSTATUS.INTERNAL_SERVER_ERROR,
    errorCode?: ErrorCodeEnumType
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class HttpException extends AppError {
  constructor(
    message = "Http Exception Error",
    statusCode: HttpStatusCodeType,
    errorCode?: ErrorCodeEnumType
  ) {
    super(message, statusCode, errorCode);
  }
}

export class InternalServerException extends AppError {
  constructor(
    message = "Internal Server Error",
    errorCode?: ErrorCodeEnumType
  ) {
    super(
      message,
      HTTPSTATUS.INTERNAL_SERVER_ERROR,
      errorCode || ErrorCodeEnum.INTERNAL_SERVER_ERROR
    );
  }
}

export class NotFoundException extends AppError {
  constructor(message = "Resource not found", errorCode?: ErrorCodeEnumType) {
    super(
      message,
      HTTPSTATUS.NOT_FOUND,
      errorCode || ErrorCodeEnum.RESOURCE_NOT_FOUND
    );
  }
}

export class BadRequestException extends AppError {
  constructor(message = "Bad Request", errorCode?: ErrorCodeEnumType) {
    super(
      message,
      HTTPSTATUS.BAD_REQUEST,
      errorCode || ErrorCodeEnum.VALIDATION_ERROR
    );
  }
}

export class UnauthorizedException extends AppError {
  constructor(message = "Unauthorized Access", errorCode?: ErrorCodeEnumType) {
    super(
      message,
      HTTPSTATUS.UNAUTHORIZED,
      errorCode || ErrorCodeEnum.ACCESS_UNAUTHORIZED
    );
  }
}

// Distinct from UnauthorizedException (401 - "who are you"): this is for a
// caller who IS authenticated and known, but isn't allowed to perform the
// specific action (403 - "I know who you are, you can't do this").
export class ForbiddenException extends AppError {
  constructor(message = "Forbidden", errorCode?: ErrorCodeEnumType) {
    super(
      message,
      HTTPSTATUS.FORBIDDEN,
      errorCode || ErrorCodeEnum.ACCESS_UNAUTHORIZED
    );
  }
}
```

`AppError` extends the built-in `Error` (so `instanceof Error` still holds, and `.stack` is still populated via `Error.captureStackTrace`), and adds exactly two fields on top: `statusCode` and an optional `errorCode`. Every concrete exception — `HttpException`, `InternalServerException`, `NotFoundException`, `BadRequestException`, `UnauthorizedException`, `ForbiddenException` — is a thin subclass that pins a specific `statusCode` (imported from `HTTPSTATUS`, see [`config/http.config.ts`](../backend/00-master-backend-architecture.md)) and supplies a *default* `errorCode` from `ErrorCodeEnum` if the call site doesn't override it:

```ts
// backend/src/enums/error-code.enum.ts:1-22
export const ErrorCodeEnum = {
  AUTH_EMAIL_ALREADY_EXISTS: "AUTH_EMAIL_ALREADY_EXISTS",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  AUTH_USER_NOT_FOUND: "AUTH_USER_NOT_FOUND",

  AUTH_NOT_FOUND: "AUTH_NOT_FOUND",
  AUTH_TOO_MANY_ATTEMPTS: "AUTH_TOO_MANY_ATTEMPTS",
  AUTH_UNAUTHORIZED_ACCESS: "AUTH_UNAUTHORIZED_ACCESS",
  AUTH_TOKEN_NOT_FOUND: "AUTH_TOKEN_NOT_FOUND",

  // Access Control Errors
  ACCESS_UNAUTHORIZED: "ACCESS_UNAUTHORIZED",

  // Validation and Resource Errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RESOURCE_NOT_FOUND: "RESOURCE_NOT_FOUND",

  // System Errors
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
} as const;

export type ErrorCodeEnumType = keyof typeof ErrorCodeEnum;
```

`HttpException` is the one subclass that takes an arbitrary `statusCode` rather than pinning one — it exists as an escape hatch for a one-off status code that doesn't warrant its own named subclass. `HTTPSTATUS` itself is a plain frozen object of numeric status codes:

```ts
// backend/src/config/http.config.ts:1-30
const httpConfig = () =>
  ({
    // Success Response
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,

    // Clinet Error Response
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,

    // Server Error Response
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
  }) as const;

export const HTTPSTATUS = httpConfig();

export type HttpStatusCodeType = (typeof HTTPSTATUS)[keyof typeof HTTPSTATUS];
```

None of `appError.ts`, `error-code.enum.ts`, or `http.config.ts` changed at all during the Postgres/Redis migration — they're pure, storage-agnostic building blocks, which is exactly why they survived the cutover untouched while `errorHandler` itself didn't.

### 3.3 The centralized `errorHandler`, full precedence chain — now four branches shorter

This is the single Express error-handling middleware mounted last in `app.ts` (`app.use(errorHandler)` — see the [master architecture chapter](./00-master-backend-architecture.md#3-bootstrap-in-full-backendsrcappts--backendsrcindexts)). Its whole job is to look at whatever value was thrown or passed to `next(error)`, figure out what kind of error it is, and map it to exactly one HTTP response — checked in this exact order:

```ts
// backend/src/middlewares/errorHandles.middleware.ts:1-75
import { ErrorRequestHandler, Response } from "express";
import { HTTPSTATUS } from "../config/http.config";
import { AppError } from "../utils/appError";
import { z, ZodError } from "zod";
import { ErrorCodeEnum } from "../enums/error-code.enum";
import { config } from "../config/app.config";
import { logger } from "../utils/logger";

const formatZodError = (res: Response, error: z.ZodError) => {
  const errors = error?.issues?.map((err) => ({
    field: err.path.join("."),
    message: err.message,
  }));
  return res.status(HTTPSTATUS.BAD_REQUEST).json({
    message: "Validation failed",
    errors: errors,
    errorCode: ErrorCodeEnum.VALIDATION_ERROR,
  });
};

// `: any` on the return type is deliberate: Express types ErrorRequestHandler
// as returning void, but every branch below `return`s the Response object
// (the conventional way to guarantee a single terminal response per branch).
// `error` is likewise untyped by Express itself - anything can be thrown.
export const errorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  // Express only recognizes error-handling middleware by its 4-argument
  // arity - `next` must stay in the signature even though it's unused.
  _next
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above: Express types this handler as returning void, but every branch returns the Response object.
): any => {
  // req.log (attached by pino-http, wired in app.ts) carries this
  // request's correlation id automatically - fall back to the base logger
  // for any app assembly that doesn't mount pino-http (e.g. the lighter
  // test-only app builders under tests/setup/).
  (req.log ?? logger).error({ err: error, path: req.path }, "Request failed");

  if (error instanceof SyntaxError) {
    return res.status(HTTPSTATUS.BAD_REQUEST).json({
      message: "Invalid JSON format. Please check your request body.",
    });
  }

  // Thrown by express.json()'s underlying body-parser when a request body
  // exceeds the configured size limit - without this branch it falls
  // through to the generic 500 handler below, which is wrong (this is a
  // client error) and doesn't set the correct 413 status.
  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(HTTPSTATUS.PAYLOAD_TOO_LARGE).json({
      message: "Request body is too large.",
    });
  }

  if (error instanceof ZodError) {
    return formatZodError(res, error);
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      message: error.message,
      errorCode: error.errorCode,
    });
  }

  return res.status(HTTPSTATUS.INTERNAL_SERVER_ERROR).json({
    message: "Internal Server Error",
    error:
      config.NODE_ENV === "production"
        ? "Unknown error occurred"
        : error?.message || "Unknow error occurred",
  });
};
```

The precedence chain, in the exact order the code checks it, is now:

1. `SyntaxError` (malformed JSON body)
2. Body-parser payload-too-large (`error.type === "entity.too.large"` or `error.status === 413`)
3. `ZodError` (thrown by `.parse()` calls in controllers — see the [validation chapter](./05-validation-strategies.md))
4. `AppError` (and every subclass of it — `instanceof` holds for subclasses too)
5. Generic fallback — anything that reached this line matched none of the above, and gets a `500`

### Why this got simpler, not just different

Before the Postgres cutover, this handler had **three additional branches** sitting between the `ZodError` check and the `AppError` check, each a structural (duck-typed) check rather than an `instanceof` check, because Mongoose never exported dedicated error classes that survive a clean `instanceof`:

- **`isMongooseCastError`** — caught a malformed ObjectId reaching a Mongoose query (e.g. `GET /api/workspace/not-a-real-id`) and mapped it to a clean `400` instead of leaking Mongoose's own error message (which embedded the raw value, the field path, and the Mongoose model name).
- **`isMongooseValidationError`** — caught Mongoose's own schema-level validation failures (distinct from Zod) and formatted them the same way `formatZodError` formats a `ZodError`, so clients got one consistent validation-error shape either way.
- **`isMongoDuplicateKeyError`** (`error.code === 11000`) — caught a unique-index violation (typically a race condition slipping past an earlier "does this already exist" check) and returned a generic `409` instead of echoing Mongo's raw error string, which included the database name, collection name, index name, and the actual colliding value.

All three are **gone**, not merely renamed or ported — deleted outright during Phase 6's cutover, along with the `hasProperty`/`isMongooseCastError`/`isMongooseValidationError`/`isMongoDuplicateKeyError` helper functions and the `MongooseValidationError` type guard that backed them. They are not replaced by Postgres/Drizzle equivalents, because **they don't need to be**: nothing in this codebase can throw a Mongoose `CastError`, a Mongoose schema `ValidationError`, or a Mongo `11000` duplicate-key error anymore, because Mongoose itself was removed from the dependency tree in the same cutover (`backend/migrations/phase-6-cutover-and-cleanup.md` §6.6). A branch that can structurally never match is dead code, and dead code in a security-relevant precedence chain is worse than no code at all — it's a false signal to a future reader that the app still needs to defend against a failure mode it can no longer produce. Deleting them, rather than leaving them in as inert insurance, is itself the correct call.

The two analogous failure modes under Postgres/Drizzle are handled differently, by design, not by omission:

- **A malformed UUID reaching a query.** Every id-shaped field in AstriX's Zod schemas (`taskIdSchema`, `projectIdSchema`, `workspaceIdSchema`, `sessionIdSchema`, and so on — see [`05-validation-strategies.md`](./05-validation-strategies.md)) validates with `.uuid()` *before* the id ever reaches a Drizzle query. A malformed id is rejected by branch 3 (`ZodError`) with a clean, field-level `400` — it never gets the chance to reach the database and produce a driver-level type error in the first place. This is actually a stronger guarantee than the old `isMongooseCastError` branch offered: that branch existed because a bad ObjectId could and did reach Mongoose (validation and the query were two separate, occasionally-desynced layers); under Postgres, the same class of malformed-id error is caught earlier, by the same trust boundary that catches every other shape problem.
- **A unique-constraint violation slipping past an application-level check.** Postgres reports this as error code `23505` (`unique_violation`), a `pg` driver error with a numeric SQLSTATE code, not a `.code === 11000` Mongo-shaped object. AstriX doesn't handle this generically in `errorHandler` — instead, the one place it currently matters (`joinWorkspaceByInviteService` in `backend/src/services/member.service.ts`, guarding the unique `(workspaceId, userId)` index on `workspace_members` against a concurrent double-join) catches it locally, right where the race actually happens, and re-throws a `BadRequestException("You are already a member of this workspace")`:

```ts
// backend/src/services/member.service.ts:51-60
try {
  await db.insert(workspaceMembers).values({ userId, workspaceId: workspace.id, roleId: role.id });
} catch (error) {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "23505") {
    // unique_violation - lost the race against a concurrent join.
    throw new BadRequestException("You are already a member of this workspace");
  }
  throw error;
}
```

Handling `23505` at the throw site rather than generically in `errorHandler` is a deliberate, narrower design than the old Mongo branch: a raw `23505` could originate from *any* unique constraint in the schema (`users_email_idx`, `roles_name_idx`, the `workspace_members` composite index), each of which needs a different, specific user-facing message ("email already exists" vs. "already a member" vs. something else entirely) — collapsing all of them into one generic `errorHandler` branch, the way the old Mongo `11000` branch did, would mean losing that per-constraint context. AstriX doesn't have enough of these races to justify a shared `errorHandler` branch yet (this is currently the only one), so the pragmatic choice was catching it locally, once, where the specific message is known. If a second or third genuine race condition shows up, that's the point to reconsider centralizing this — not before.

### 3.4 Real throw sites

`AppError` subclasses are thrown from services (business-rule failures) and, less commonly, directly from controllers (request-shape failures caught before a service is even called). Two representative examples:

**A `NotFoundException` from a service**, when a lookup by id comes back empty:

```ts
// backend/src/services/project.service.ts:62-82
export const getProjectByIdAndWorkspaceIdService = async (
  workspaceId: string,
  projectId: string
) => {
  const [project] = await db
    .select({
      id: projects.id,
      emoji: projects.emoji,
      name: projects.name,
      description: projects.description,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return { project };
};
```

**A `ForbiddenException` from a permission check**, via the shared `roleGuard` helper:

```ts
// backend/src/utils/roleGuard.ts:1-20
import { PermissionType } from "../enums/role.enum";
import { ForbiddenException } from "./appError";
import { RolePermissions } from "./role-permission";

export const roleGuard = (
  role: keyof typeof RolePermissions,
  requiredPermissions: PermissionType[]
) => {
  const permissions = RolePermissions[role];

  const hasPermission = requiredPermissions.every((permission) =>
    permissions.includes(permission)
  );

  if (!hasPermission) {
    throw new ForbiddenException(
      "You do not have the necessary permissions to perform this action"
    );
  }
};
```

called synchronously inside a controller, right after resolving the caller's role for the target workspace:

```ts
// backend/src/controllers/project.controller.ts:23-39
export const createProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = createProjectSchema.parse(req.body);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const userId = req.user!.id;
    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.CREATE_PROJECT]);

    const { project } = await createProjectService(userId, workspaceId, body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "Project created successfully",
      project,
    });
  }
);
```

`roleGuard` throwing synchronously *inside* an `async` function still produces a rejected promise for that function as a whole — that rejection is exactly what `asyncHandler`'s `try/catch` is there to catch. Note `req.user!.id` here: the id is a plain UUID string returned by the auth middleware after verifying a JWT and checking the corresponding Redis session (see [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md)), not a Mongoose document with an `_id` `ObjectId` needing `.toString()` — a small but real cleanup the migration produced everywhere `req.user!._id.toString()` used to appear.

---

## 4. Request/Data Flow

### (a) A Zod validation failure

Request: `POST /api/workspace/:workspaceId/project/create` with a body missing a required field. Inside `createProjectController` (§3.4 above), `createProjectSchema.parse(req.body)` throws a `ZodError` synchronously. Because the controller is wrapped in `asyncHandler`, that throw is caught by `asyncHandler`'s `try/catch` and forwarded via `next(error)`. Express routes it directly to `errorHandler` (skipping every remaining normal middleware). Inside `errorHandler`, the error fails the `SyntaxError` check and the payload-too-large check, then hits `error instanceof ZodError` — true — and `formatZodError` runs, producing:

```json
{
  "message": "Validation failed",
  "errors": [{ "field": "name", "message": "Required" }],
  "errorCode": "VALIDATION_ERROR"
}
```
with HTTP status `400`.

### (b) A thrown `ForbiddenException` from a permission check

Same route, but the body is now valid and the id checks pass — the request gets all the way to `roleGuard(role, [Permissions.CREATE_PROJECT])`, and the caller's role doesn't include that permission. `roleGuard` throws `new ForbiddenException(...)`. `asyncHandler` catches it, `next(error)` routes it to `errorHandler`. It fails `SyntaxError`, payload-too-large, and `ZodError` in turn — none match — and hits `error instanceof AppError`, which is `true` (`ForbiddenException extends AppError`). The response is built directly from the exception's own fields:

```json
{
  "message": "You do not have the necessary permissions to perform this action",
  "errorCode": "ACCESS_UNAUTHORIZED"
}
```
with HTTP status `403` (`error.statusCode`, set by `ForbiddenException`'s constructor to `HTTPSTATUS.FORBIDDEN`). This trace is one branch shorter than it was before the migration — there's no longer a detour through three Mongoose-shaped checks that were guaranteed not to match.

### (c) A raw, unexpected exception (a bug)

Suppose a service has a real bug — say, a `TypeError` from calling a method on `undefined` because an upstream check was missed. This is a plain `Error` (or subclass thereof), not `AppError`, not `ZodError`. It fails every single branch of the precedence chain in order — `SyntaxError`? no. Payload-too-large? no. `ZodError`? no. `AppError`? no — and falls all the way through to the final, unconditional branch:

```ts
return res.status(HTTPSTATUS.INTERNAL_SERVER_ERROR).json({
  message: "Internal Server Error",
  error:
    config.NODE_ENV === "production"
      ? "Unknown error occurred"
      : error?.message || "Unknow error occurred",
});
```

The status is always `500`. The top-level `message` is always the literal string `"Internal Server Error"`, in every environment. The *only* thing that changes between `NODE_ENV=production` and any other environment is the nested `error` field: in production it's hard-coded to `"Unknown error occurred"`, revealing nothing about the actual failure; outside production it's `error.message` (the real `TypeError` message, e.g. `"Cannot read properties of undefined (reading 'id')"`), falling back to the literal (typo included in the source) `"Unknow error occurred"` if the caught value has no `message` at all — which can happen if something threw a plain string or a non-Error object. Note that **no branch of this handler, in any environment, ever includes `error.stack` in the response body** — the stack trace is written only to the server-side log line at the very top of the function (`(req.log ?? logger).error({ err: error, path: req.path }, "Request failed")`), never to the client.

A raw `pg` driver error (a connection failure, a constraint violation nobody caught locally, a syntax error in a hand-written `sql\`...\`` fragment) that isn't caught and re-thrown as an `AppError` also lands here — it isn't `AppError`, isn't `ZodError`, and there's no longer a duck-typed branch trying to guess whether it's "database-shaped" the way the old Mongoose branches did. It becomes a generic `500`, exactly like any other unexpected bug, with the real driver error visible outside production and hidden in production — which is the correct, conservative default for an error type nobody has written specific handling for yet.

---

## 5. Design Decisions & Tradeoffs

**Why one centralized handler instead of per-route try/catch.** With ~40+ controller functions across six route domains, per-route try/catch (landscape option (b)) would mean the same status-code mapping and the same generic-500 fallback duplicated in every one of them — and, as covered in §1(b), it's easy for one handler to simply not have a `catch` at all, especially for an `async` function where a missing `catch` doesn't fail loudly, it silently drops the response (or hangs the request) instead. Centralizing the mapping means every controller can just `throw` and trust that *something* downstream will turn it into a well-formed response, and that mapping logic only has one place to get right — and one place to test. This reasoning never depended on which database sat behind the services, which is why the migration didn't touch it.

**Why a class hierarchy instead of plain objects with a `statusCode` property.** AstriX could have used plain objects (`{ message, statusCode, errorCode }`) thrown directly instead of `AppError` subclasses. The class hierarchy buys two things a plain object can't: first, `instanceof AppError` (and `instanceof ForbiddenException`, etc.) is a real, reliable runtime check — a plain object thrown from anywhere in the codebase has no guaranteed shape the handler can trust without also duck-typing it. Second, subclassing lets each exception type pin sensible defaults (a `NotFoundException` is always a 404 with `RESOURCE_NOT_FOUND` unless overridden) so call sites read as `throw new NotFoundException("Workspace not found")` — one line, intent-revealing — rather than `throw { statusCode: 404, errorCode: "RESOURCE_NOT_FOUND", message: "Workspace not found" }` repeated at every call site with room to typo a status code.

**Why `asyncHandler` as a hand-rolled wrapper, not `express-async-errors`.** The single most common answer to "how do I avoid writing `try { await ... } catch (e) { next(e) }` in every route" is the `express-async-errors` package, which monkey-patches Express's router at import time so that *every* route and middleware automatically forwards a rejected promise to `next()` — no per-route wrapper needed at all. AstriX deliberately does not use it. The tradeoff cuts both ways: `express-async-errors` eliminates the wrapper entirely (less boilerplate, impossible to forget on a new route), but it does so via global prototype patching of Express internals that isn't part of Express's own public API. AstriX's `asyncHandler` is a few lines of plain, inspectable TypeScript with no monkey-patching, at the cost of needing `asyncHandler(...)` wrapped around every controller by hand — a convention that has to be remembered (and would fail closed, not open, if forgotten: an unwrapped async controller that throws produces a hung request or an unhandled rejection, not a clean error response) rather than a guarantee enforced automatically.

**Why delete the Mongoose branches instead of keeping them as harmless dead code.** It would have been "safe," in the narrow sense of never breaking anything, to leave `isMongooseCastError`/`isMongooseValidationError`/`isMongoDuplicateKeyError` in place after the cutover — they'd simply never match, forever. AstriX's Phase 6 cleanup deleted them anyway, and that's the right call for a security-relevant precedence chain specifically: every branch in `errorHandler` is read, by a future engineer debugging a misclassified error, as "this is a real failure mode this app can hit." A branch that's actually unreachable is worse than merely useless — it's actively misleading documentation-by-code, and a future engineer following the debug drill in §8 could waste real time investigating whether a Mongoose-shaped error is somehow reaching a Postgres app before realizing the branch is vestigial. Deleting dead branches when the thing that made them reachable is gone is the honest version of "the code is the documentation."

---

## 6. Security Considerations

**What actually leaks, by environment.** The only environment-gated behavior in the entire handler is the `error` field on the generic-500 fallback (§4(c)): production always returns the fixed string `"Unknown error occurred"`, while every other environment returns the real `error.message`. Every other branch — `ZodError`, `AppError` — already returns a fixed, curated message regardless of `NODE_ENV`, so there's no environment-dependent leak surface there. Crucially, **no branch, in any environment, ever puts `error.stack` in the HTTP response body** — the stack trace exists only in the server-side log call at the top of the function, never in what's sent to a client. That's the right default: even in development, a stack trace can reveal absolute file paths, internal module structure, and dependency versions to anyone poking at a locally-exposed dev server.

**What the deleted branches used to protect against, and what protects against it now.** The old `CastError` branch existed because *"this is a client error (400), not a server fault, and must not echo Mongoose's internal error message (it includes the raw value/path/model name)"* — a real Mongoose `CastError` looked like `Cast to ObjectId failed for value "not-a-real-id" (type string) at path "_id" for model "Workspace"`, handing an attacker the exact model name in play. Under Postgres, the equivalent protection is earlier and stronger, not merely relocated: every id-shaped Zod schema validates `.uuid()` *before* the value ever reaches a query, so a malformed id is rejected by the `ZodError` branch with a clean, generic `400` — it never reaches the database layer at all, so there's no driver-level error message to accidentally leak in the first place. The old duplicate-key branch's protection (*"don't echo the raw Mongo error, which includes the offending field values"* — a real `E11000` message leaked the database name, collection name, index name, and the colliding value itself, letting signup/invite flows become an email-existence oracle) is now the responsibility of whichever service catches `23505` locally (§3.3) — `joinWorkspaceByInviteService`'s catch block returns a fixed, generic message with no echoed field values, preserving the same security property at the throw site instead of in the central handler.

**Log-injection / PII-in-logs risk.** The very first line of `errorHandler` runs unconditionally, before any type check: `(req.log ?? logger).error({ err: error, path: req.path }, "Request failed")`. This logs the full error object — including whatever `message` string it carries, which can itself contain data derived from the request (a thrown `AppError`'s message is often built from request-supplied identifiers) — plus `req.path`, on *every* failed request. Classic log-injection (an attacker forging fake extra log lines by embedding newlines/control characters into a logged string) is not a practical risk here, because `pino` (see [`utils/logger.ts`](../backend/00-master-backend-architecture.md)) serializes every log call as one JSON object per line — a newline embedded in a string field is escaped as `\n` inside the JSON value, not emitted as a literal line break. PII exposure is a real, separate concern: `logger.ts` configures no `redact` paths, so if a user-supplied value ends up embedded in an error's `message` or in the logged error object's own properties (a raw Postgres driver error can include bound parameter context depending on the error type), it lands in the centralized log stream exactly as-is, with no automatic scrubbing. This gap predates and survives the migration unchanged — it was never specific to Mongoose.

---

## 7. Best Practice Check

**RFC 7807 adoption.** 2026 industry practice increasingly favors RFC 7807 Problem Details (or a close variant of it) for public/partner-facing APIs specifically because it gives every consumer, regardless of which backend they're talking to, one parsing strategy. AstriX's bespoke `{ message, errorCode?, errors? }` shape does not follow it — no `type`, `title`, or `instance` fields, and no `application/problem+json` content type. For a single first-party frontend client (which is AstriX's actual situation today), this is a reasonable, low-ceremony choice rather than a gap; it becomes a real gap the moment AstriX grows external API consumers who'd benefit from a standardized, tooling-recognized error shape.

**Structured error codes — used consistently?** AstriX already has the right idea with `errorCode`, which is exactly what 2026 best practice recommends for letting API clients branch on error *kind* programmatically instead of pattern-matching human-readable `message` strings. Checking the actual precedence chain in §3.3, coverage is **not** fully consistent: the `SyntaxError` branch and the payload-too-large branch return no `errorCode` field at all, and neither does the final generic-500 fallback — two of the five branches omit it entirely. This is a smaller gap than it was before the migration (there's no longer a duplicate-key branch reusing `VALIDATION_ERROR` for what's really a conflict), but it's still a real, fixable one: a client that relies on `errorCode` being present has to fall back to inspecting `message` or the HTTP status for exactly the branches where it's missing.

**Never leaking stack traces or internal details in production.** AstriX matches this cleanly, as established in §6 — no branch ever returns `error.stack`, and the only environment-conditional field (the generic-500 fallback's `error` string) is hard-coded to a non-identifying value in production. This is the one piece of 2026 best practice AstriX has unambiguously right, with no caveats, and the migration didn't touch it either way.

**Removing dead branches once their trigger condition is structurally impossible.** This is worth calling out as its own best-practice item, separate from the general "keep it simple" instinct: a precedence chain like this one is read as a specification of the failure modes the system defends against, and Phase 6's decision to delete the Mongoose branches rather than leave them as inert insurance is the right call specifically *because* this is security- and debugging-relevant code, not because deleting code is inherently virtuous. A stale defensive branch here isn't neutral — it actively misdirects the next engineer running the debug drill in §8.

---

## 8. Debug Drill

**Scenario:** An endpoint you expect to return a specific validation error (say, a `400` with a field-level `errors` array) instead returns a generic `500 Internal Server Error`. This is a transferable debugging shape for *any* backend built on a centralized, type-checked precedence chain like this one — not specific to any one route.

Work the chain in this order:

1. **Confirm the error is actually reaching the handler at all.** Check the server-side log line — every request that reaches `errorHandler` produces exactly one `"Request failed"` log entry with the full error object, *before* any branch runs (§3.3, the very first statement in the function). If that log line is missing, the problem isn't in `errorHandler` — the request never got there (check whether the controller is actually wrapped in `asyncHandler`; an unwrapped async controller that throws never calls `next(error)` at all).

2. **Read the logged error's actual `name`, `constructor.name`, and shape**, not just its message. The chain today has exactly two type checks after the two structural ones (`SyntaxError`, payload-too-large): `instanceof ZodError` and `instanceof AppError`. Both are real `instanceof` checks — there is no longer a duck-typed guard anywhere in this handler, which means a shape mismatch (an error that merely *looks* like one of these but isn't a real subclass) can no longer accidentally match a branch it shouldn't. If an error isn't being classified as expected, check first whether it's actually the class you think it is, or a plain `Error`/driver error that only resembles one.

3. **Check the branch order itself for a shadowing match.** The chain is checked top to bottom, and the first match wins — an error that happens to satisfy an earlier, broader check (say, it has a `.type` or `.status` property that coincidentally matches the payload-too-large check) will never reach the branch you expected it to hit further down. When a new error type isn't being formatted the way you'd expect, log `error.name`, `error.constructor.name`, and `Object.keys(error)` for the raw caught value, then walk the precedence chain by hand against that shape, in order.

4. **Verify the throw site itself.** If none of the above explains it, the bug may be upstream: confirm the code path you expect to throw a typed exception (a `ZodError` from `.parse()`, an `AppError` subclass from a service) is actually the code path executing — a `try/catch` somewhere between the throw and `asyncHandler` could be swallowing the typed error and rethrowing a plain, untyped one instead, which is indistinguishable from a genuine bug once it reaches the generic-500 fallback. If the unexpected `500` comes from a raw Postgres error (a `pg` driver exception with a `code` like `23505`, `23503` for a foreign-key violation, or `42P01` for an undefined table), that's a signal the throw site needs to catch that specific error and re-throw it as an `AppError` subclass the way `joinWorkspaceByInviteService` does for `23505` (§3.3) — not a signal that `errorHandler` needs a new generic branch, unless the same raw code is genuinely showing up from more than one uncoordinated call site.
