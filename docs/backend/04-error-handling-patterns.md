> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Error Handling Patterns

Every backend eventually has to answer the same question: when something goes wrong three function calls deep — a malformed request, a missing document, a permission check that fails, a bug nobody caught in review — how does that failure travel back up to an HTTP response, and who decides what that response looks like? Get this wrong and you end up with either a wall of duplicated `try/catch` blocks (every route re-inventing its own error shape) or, worse, a stack trace leaking straight into a client's browser console in production.

This chapter surveys the real, industry-recognized ways backends solve this problem, then goes line-by-line through AstriX's answer: a typed `AppError` exception hierarchy, a hand-rolled `asyncHandler` wrapper, and one centralized Express error-handling middleware with a fixed precedence chain. The [middleware pipeline chapter](./03-middleware-and-request-pipeline.md) covers where `asyncHandler` and `errorHandler` sit in the mount order; this chapter is the canonical source on how they actually work.

---

## 1. The Landscape

Before looking at AstriX, it's worth knowing that "how do I get an error from deep inside my business logic back to an HTTP response" has at least four genuinely different, widely-used answers. They aren't just stylistic variants of each other — they make different tradeoffs about who is *forced* to handle a failure, and when.

### (a) Thrown exceptions, caught by a centralized handler

The dominant pattern in Express (and most stateful, framework-driven backends: Rails, Django, Spring). Application code `throw`s when something goes wrong; a single piece of middleware, mounted last, catches everything that bubbles up and decides how to turn it into a response. In Express specifically, this is built on the framework's own `next(error)` convention: call `next` with an argument, and Express skips every remaining normal middleware and routes straight to the next *error-handling* middleware (the one with a 4-argument signature `(err, req, res, next)`).

```js
// route handler
app.get("/widgets/:id", async (req, res, next) => {
  try {
    const widget = await Widget.findById(req.params.id);
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
    const widget = await Widget.findById(req.params.id);
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

**Tradeoff:** this is the strongest guarantee of the four — you *cannot* accidentally forget to handle an error, because the success value is only reachable after the compiler has forced you to check the error branch. There's no equivalent of "a raw error silently reaching a generic 500 handler because nobody threw a typed exception," because there's no throwing at all in the happy-path plumbing. The cost is verbosity and a mismatch with idiomatic JS/TS: every call site that can fail needs an explicit branch, `async/await` and `Promise` rejection don't compose naturally with Result types without extra wrapping, and most of the Node/Express ecosystem (including Mongoose, which AstriX depends on directly) throws real exceptions, not Results — so adopting this pattern fully would mean wrapping every third-party call at the boundary.

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

It's a higher-order function: `asyncHandler(controller)` returns a *new* async function with the same signature, which awaits the real controller inside a `try/catch` and forwards anything it catches to `next`. Every controller export in the codebase is written as `asyncHandler(async (req, res) => { ... })` — the `throw` statements inside a controller or any service it calls never need their own `try/catch`, because this one wrapper guarantees the rejection reaches Express's error pipeline.

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

### 3.3 The centralized `errorHandler`, full precedence chain

This is the single Express error-handling middleware mounted last in `index.ts` (`app.use(errorHandler)` — see the [master architecture chapter](./00-master-backend-architecture.md#3-bootstrap-in-full-backendsrcindexts)). Its whole job is to look at whatever value was thrown or passed to `next(error)`, figure out what kind of error it is, and map it to exactly one HTTP response — checked in this exact order:

```ts
// backend/src/middlewares/errorHandles.middleware.ts:1-148
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

// A caught error is genuinely untyped (anything can be thrown), so these
// narrow from `unknown` via real type guards rather than asserting a shape.
// Each guard's return type is what lets the handler below use the narrowed
// error without a cast.
type MongooseValidationError = {
  name: "ValidationError";
  errors: Record<string, { path: string; message: string }>;
};

const hasProperty = <K extends string>(
  value: unknown,
  key: K
): value is Record<K, unknown> =>
  typeof value === "object" && value !== null && key in value;

const isMongooseCastError = (error: unknown): boolean =>
  hasProperty(error, "name") && error.name === "CastError";

const isMongooseValidationError = (
  error: unknown
): error is MongooseValidationError =>
  hasProperty(error, "name") &&
  error.name === "ValidationError" &&
  hasProperty(error, "errors") &&
  !!error.errors;

const isMongoDuplicateKeyError = (error: unknown): boolean =>
  hasProperty(error, "code") && error.code === 11000;

const formatMongooseValidationError = (
  res: Response,
  error: MongooseValidationError
) => {
  const errors = Object.values(error.errors).map((err) => ({
    field: err.path,
    message: err.message,
  }));

  return res.status(HTTPSTATUS.BAD_REQUEST).json({
    message: "Validation failed",
    errors,
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
  // req.log (attached by pino-http, wired in index.ts) carries this
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

  // A malformed id (not a valid ObjectId) reaching a Mongoose query - e.g.
  // GET /api/workspace/not-a-real-id. This is a client error (400), not a
  // server fault, and must not echo Mongoose's internal error message (it
  // includes the raw value/path/model name).
  if (isMongooseCastError(error)) {
    return res.status(HTTPSTATUS.BAD_REQUEST).json({
      message: "Invalid identifier",
      errorCode: ErrorCodeEnum.VALIDATION_ERROR,
    });
  }

  // Mongoose schema validation failures (distinct from Zod, which is
  // already handled above) - format the same way as formatZodError so
  // clients get one consistent validation-error shape either way.
  if (isMongooseValidationError(error)) {
    return formatMongooseValidationError(res, error);
  }

  // Unique-index violation, typically from a race condition slipping past
  // an earlier "does this already exist" check (e.g. duplicate email,
  // duplicate workspace membership). Don't echo the raw Mongo error, which
  // includes the offending field values.
  if (isMongoDuplicateKeyError(error)) {
    return res.status(HTTPSTATUS.CONFLICT).json({
      message: "A resource with these details already exists",
      errorCode: ErrorCodeEnum.VALIDATION_ERROR,
    });
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

The precedence chain, in the exact order the code checks it, is:

1. `SyntaxError` (malformed JSON body)
2. Body-parser payload-too-large (`error.type === "entity.too.large"` or `error.status === 413`)
3. `ZodError` (thrown by `.parse()` calls in controllers — see the [validation chapter](./05-validation-strategies.md))
4. Mongoose `CastError` (bad ObjectId), via the `isMongooseCastError` type guard
5. Mongoose `ValidationError` (schema validation failure), via `isMongooseValidationError`
6. Mongo duplicate-key error (`error.code === 11000`), via `isMongoDuplicateKeyError`
7. `AppError` (and every subclass of it — `instanceof` holds for subclasses too)
8. Generic fallback — anything that reached this line matched none of the above, and gets a `500`

Note that branches 4–6 are **not** `instanceof` checks — they can't be, because Mongoose doesn't export dedicated `CastError`/`ValidationError` classes that survive a clean `instanceof` check the way `ZodError` does; instead they're structural (duck-typed) checks via the `hasProperty` helper, narrowing from `unknown` to a locally-declared shape rather than asserting one with a cast. This distinction matters for the debug drill in §8.

### 3.4 Real throw sites

`AppError` subclasses are thrown from services (business-rule failures) and, less commonly, directly from controllers (request-shape failures caught before a service is even called). Two representative examples:

**A `NotFoundException` from a service**, when a lookup by ID comes back empty:

```ts
// backend/src/services/project.service.ts:55-71
export const getProjectByIdAndWorkspaceIdService = async (
  workspaceId: string,
  projectId: string
) => {
  const project = await ProjectModel.findOne({
    _id: projectId,
    workspace: workspaceId,
  }).select("_id emoji name description");

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
  // If the role doesn't exist or lacks required permissions, throw an exception

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

    const userId = req.user!._id.toString();
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

`roleGuard` throwing synchronously *inside* an `async` function still produces a rejected promise for that function as a whole — that rejection is exactly what `asyncHandler`'s `try/catch` is there to catch.

---

## 4. Request/Data Flow

### (a) A Zod validation failure

Request: `POST /api/project/workspace/:workspaceId/create` with a body missing a required field. Inside `createProjectController` (§3.4 above), `createProjectSchema.parse(req.body)` throws a `ZodError` synchronously. Because the controller is wrapped in `asyncHandler`, that throw is caught by `asyncHandler`'s `try/catch` and forwarded via `next(error)`. Express routes it directly to `errorHandler` (skipping every remaining normal middleware). Inside `errorHandler`, the error fails the `SyntaxError` check and the payload-too-large check, then hits `error instanceof ZodError` — true — and `formatZodError` runs, producing:

```json
{
  "message": "Validation failed",
  "errors": [{ "field": "name", "message": "Required" }],
  "errorCode": "VALIDATION_ERROR"
}
```
with HTTP status `400`.

### (b) A thrown `ForbiddenException` from a permission check

Same route, but the body is now valid and the ID checks pass — the request gets all the way to `roleGuard(role, [Permissions.CREATE_PROJECT])`, and the caller's role doesn't include that permission. `roleGuard` throws `new ForbiddenException(...)`. `asyncHandler` catches it, `next(error)` routes it to `errorHandler`. It fails `SyntaxError`, payload-too-large, `ZodError`, `isMongooseCastError`, `isMongooseValidationError`, and `isMongoDuplicateKeyError` in turn — none match — and finally hits `error instanceof AppError`, which is `true` (`ForbiddenException extends AppError`). The response is built directly from the exception's own fields:

```json
{
  "message": "You do not have the necessary permissions to perform this action",
  "errorCode": "ACCESS_UNAUTHORIZED"
}
```
with HTTP status `403` (`error.statusCode`, set by `ForbiddenException`'s constructor to `HTTPSTATUS.FORBIDDEN`).

### (c) A raw, unexpected exception (a bug)

Suppose a service has a real bug — say, a `TypeError` from calling a method on `undefined` because an upstream check was missed. This is a plain `Error` (or subclass thereof), not `AppError`, not `ZodError`, not anything Mongoose-shaped. It fails every single branch of the precedence chain in order — `SyntaxError`? no. Payload-too-large? no. `ZodError`? no. Mongoose `CastError`/`ValidationError`/duplicate-key? no, no, no. `AppError`? no — and falls all the way through to the final, unconditional branch:

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

---

## 5. Design Decisions & Tradeoffs

**Why one centralized handler instead of per-route try/catch.** With ~40+ controller functions across six route domains, per-route try/catch (landscape option (b)) would mean the same status-code mapping and the same generic-500 fallback duplicated in every one of them — and, as covered in §1(b), it's easy for one handler to simply not have a `catch` at all, especially for an `async` function where a missing `catch` doesn't fail loudly, it silently drops the response (or hangs the request) instead. Centralizing the mapping means every controller can just `throw` and trust that *something* downstream will turn it into a well-formed response, and that mapping logic only has one place to get right — and one place to test.

**Why a class hierarchy instead of plain objects with a `statusCode` property.** AstriX could have used plain objects (`{ message, statusCode, errorCode }`) thrown directly instead of `AppError` subclasses. The class hierarchy buys two things a plain object can't: first, `instanceof AppError` (and `instanceof ForbiddenException`, etc.) is a real, reliable runtime check — a plain object thrown from anywhere in the codebase has no guaranteed shape the handler can trust without also duck-typing it, the same way it has to for the *actual* untyped things (Mongoose errors) it doesn't control. Second, subclassing lets each exception type pin sensible defaults (a `NotFoundException` is always a 404 with `RESOURCE_NOT_FOUND` unless overridden) so call sites read as `throw new NotFoundException("Workspace not found")` — one line, intent-revealing — rather than `throw { statusCode: 404, errorCode: "RESOURCE_NOT_FOUND", message: "Workspace not found" }` repeated at every call site with room to typo a status code.

**Why `asyncHandler` as a hand-rolled wrapper, not `express-async-errors`.** The single most common answer to "how do I avoid writing `try { await ... } catch (e) { next(e) }` in every route" is the `express-async-errors` package, which monkey-patches Express's router at import time so that *every* route and middleware automatically forwards a rejected promise to `next()` — no per-route wrapper needed at all. AstriX deliberately does not use it. The tradeoff cuts both ways: `express-async-errors` eliminates the wrapper entirely (less boilerplate, impossible to forget on a new route), but it does so via global prototype patching of Express internals that isn't part of Express's own public API — behavior that depends on an unofficial patch continuing to track whatever Express's router internals look like release to release, and that's easy to overlook when reading a route file in isolation (nothing in the route's own code signals that async rejections are being caught — the safety net is invisible unless you already know the package is imported somewhere in the app's entry point). AstriX's `asyncHandler` is a few lines of plain, inspectable TypeScript with no monkey-patching, at the cost of needing `asyncHandler(...)` wrapped around every controller by hand — a convention that has to be remembered (and would fail closed, not open, if forgotten: an unwrapped async controller that throws produces a hung request or an unhandled rejection, not a clean error response) rather than a guarantee enforced automatically. Both remove the boilerplate `try/catch`; the disagreement is whether that safety net should be explicit-but-manual or implicit-but-automatic.

---

## 6. Security Considerations

**What actually leaks, by environment.** The only environment-gated behavior in the entire handler is the `error` field on the generic-500 fallback (§4(c)): production always returns the fixed string `"Unknown error occurred"`, while every other environment returns the real `error.message`. Every other branch — `AppError`, Zod, Mongoose `CastError`/`ValidationError`, duplicate-key — already returns a fixed, curated message regardless of `NODE_ENV`, so there's no environment-dependent leak surface there. Crucially, **no branch, in any environment, ever puts `error.stack` in the HTTP response body** — the stack trace exists only in the server-side log call at the top of the function, never in what's sent to a client. That's the right default: even in development, a stack trace can reveal absolute file paths, internal module structure, and dependency versions to anyone poking at a locally-exposed dev server.

**Why `CastError` and duplicate-key deliberately return a generic message.** The code comments on these two branches are explicit about *why*, and they're accurate about what's actually being suppressed. For `CastError`: *"This is a client error (400), not a server fault, and must not echo Mongoose's internal error message (it includes the raw value/path/model name)"* — a real, unhandled Mongoose `CastError` message looks like `Cast to ObjectId failed for value "not-a-real-id" (type string) at path "_id" for model "Workspace"`, which hands an attacker the exact Mongoose model name in play (confirming what resource a given ID belongs to) plus confirmation that the input reached a Mongo query as an `_id` lookup — useful reconnaissance for enumerating internal resource types. For the duplicate-key branch: *"Don't echo the raw Mongo error, which includes the offending field values"* — a real MongoServerError for a unique-index violation looks like `E11000 duplicate key error collection: astrix.users index: email_1 dup key: { email: "someone@example.com" }`, which leaks the database name, the collection name, the index name, and — most sensitively — the actual value that collided, which in the `email_1` case is literally a user's registered email address, letting an attacker use signup or invite flows as an email-existence oracle simply by reading raw Mongo errors. Both branches trade that away for a single generic, non-identifying message.

**Log-injection / PII-in-logs risk.** The very first line of `errorHandler` runs unconditionally, before any type check: `(req.log ?? logger).error({ err: error, path: req.path }, "Request failed")`. This logs the full error object — including whatever `message` string it carries, which can itself contain data derived from the request (a thrown `AppError`'s message is often built from request-supplied identifiers) — plus `req.path`, on *every* failed request. Two distinct questions worth separating: classic log-injection (an attacker forging fake extra log lines by embedding newlines/control characters into a string that gets logged) is not a practical risk here, because `pino` (see [`utils/logger.ts`](../backend/00-master-backend-architecture.md)) serializes every log call as one JSON object per line — a newline embedded in a string field is escaped as `\n` inside the JSON value by the serializer, not emitted as a literal line break, so a malicious `message` can't fabricate a second, fake structured log entry. PII exposure is a real, separate concern, though: `logger.ts` configures no `redact` paths (`pino({ level: ... })`, nothing else), so if a user-supplied value — an email in a validation message, a malformed field value in a Mongoose error object logged verbatim via `err: error` — ends up embedded in an error's `message` or in the logged error object's own properties, it lands in the centralized log stream (shipped to CloudWatch in the ECS deployment) exactly as-is, with no automatic scrubbing. This is a real gap worth flagging, not a hard exploit: it requires a code path where PII genuinely reaches `error.message`, but nothing currently prevents that from happening as new exception call sites are added.

---

## 7. Best Practice Check

**RFC 7807 adoption.** 2026 industry practice increasingly favors RFC 7807 Problem Details (or a close variant of it) for public/partner-facing APIs specifically because it gives every consumer, regardless of which backend they're talking to, one parsing strategy. AstriX's bespoke `{ message, errorCode?, errors? }` shape does not follow it — no `type`, `title`, or `instance` fields, and no `application/problem+json` content type. For a single first-party frontend client (which is AstriX's actual situation today), this is a reasonable, low-ceremony choice rather than a gap; it becomes a real gap the moment AstriX grows external API consumers who'd benefit from a standardized, tooling-recognized error shape.

**Structured error codes — used consistently?** AstriX already has the right idea with `errorCode`, which is exactly what 2026 best practice recommends for letting API clients branch on error *kind* programmatically instead of pattern-matching human-readable `message` strings. Checking the actual precedence chain in §3.3, though, coverage is **not** consistent: the `SyntaxError` branch and the payload-too-large branch return no `errorCode` field at all, and neither does the final generic-500 fallback — three of the eight branches omit it entirely. The Mongoose duplicate-key branch (a `409 Conflict`) also reuses `ErrorCodeEnum.VALIDATION_ERROR`, the same code used for genuine 400-level validation failures, even though a conflict isn't really a validation problem — a client trying to branch on `errorCode` alone can't distinguish "your input was malformed" from "this already exists." This is a real, fixable gap: a client that relies on `errorCode` being present has to fall back to inspecting `message` or the HTTP status for exactly the branches where it's missing.

**Never leaking stack traces or internal details in production.** AstriX matches this cleanly, as established in §6 — no branch ever returns `error.stack`, and the only environment-conditional field (the generic-500 fallback's `error` string) is hard-coded to a non-identifying value in production. This is the one piece of 2026 best practice AstriX has unambiguously right, with no caveats.

---

## 8. Debug Drill

**Scenario:** An endpoint you expect to return a specific validation error (say, a `400` with a field-level `errors` array) instead returns a generic `500 Internal Server Error`. This is a transferable debugging shape for *any* backend built on a centralized, type-checked precedence chain like this one — not specific to any one route.

Work the chain in this order:

1. **Confirm the error is actually reaching the handler at all.** Check the server-side log line — every request that reaches `errorHandler` produces exactly one `"Request failed"` log entry with the full error object, *before* any branch runs (§3.3, the very first statement in the function). If that log line is missing, the problem isn't in `errorHandler` — the request never got there (check whether the controller is actually wrapped in `asyncHandler`; an unwrapped async controller that throws never calls `next(error)` at all).

2. **Read the logged error's actual `name` and shape**, not just its message. The precedence chain's later branches (`isMongooseCastError`, `isMongooseValidationError`, `isMongoDuplicateKeyError`) are structural duck-type checks on `error.name` / `error.code`, not `instanceof` checks — because Mongoose doesn't export classes that survive a clean `instanceof` the way `ZodError` does. That means *any* thrown value with `.name === "CastError"`, from anywhere, matches `isMongooseCastError`, even if it didn't come from Mongoose at all. Conversely, if the actual error is missing the exact property the guard checks for (e.g., a `ValidationError`-shaped object whose `.errors` is `undefined` or empty), `isMongooseValidationError`'s `!!error.errors` check fails and it falls through to a later branch instead.

3. **Check the branch order itself for a shadowing match.** The chain is checked top to bottom, and the first match wins — an error that happens to satisfy an earlier, broader check (say, it has a `.type` or `.status` property that coincidentally matches the payload-too-large check) will never reach the branch you expected it to hit further down. When a new error type isn't being formatted the way you'd expect, this is the first thing to verify: log `Object.keys(error)`, `error.name`, and `error.constructor.name` for the raw caught value, then walk the precedence chain by hand against that shape, in order, exactly as the code checks it — not the order you assume it should check.

4. **Verify the throw site itself.** If none of the above explains it, the bug may be upstream: confirm the code path you expect to throw a typed exception (a `ZodError` from `.parse()`, an `AppError` subclass from a service) is actually the code path executing — a `try/catch` somewhere between the throw and `asyncHandler` could be swallowing the typed error and rethrowing a plain, untyped one instead, which is indistinguishable from a genuine bug once it reaches the generic-500 fallback.
