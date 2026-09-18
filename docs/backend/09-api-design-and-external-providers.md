# API Design & External Providers

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

Every backend eventually has to answer two separate design questions that get lumped together under "API design" even though they're not the same problem. The first is internal: how do *your own* HTTP endpoints get shaped — what URLs look like, which verbs mean what, how the shape of that surface gets documented for whoever calls it. The second is external: how does your service talk to *someone else's* API — a vendor's SDK, a raw HTTP client, an OAuth provider — without your business logic becoming permanently welded to that vendor's specific quirks. AstriX makes distinct, inspectable choices on both fronts, and neither choice is the only reasonable one, so this chapter surveys the landscape before showing what's actually here.

---

## 1. The Landscape

### 1.1 Shaping your own API surface

**(a) REST with resource-oriented URLs and standard HTTP verbs.** The mainstream default for the last decade-plus: a URL names a *resource* (a noun — `/workspaces`, `/workspaces/42`), and the HTTP verb on that URL names the *operation* (`GET` to read, `POST` to create, `PUT`/`PATCH` to update, `DELETE` to remove). Status codes carry outcome (`200`/`201` for success, `404` for a missing resource, `409` for a conflict). GitHub's REST API is the textbook public example — `GET /repos/:owner/:repo/issues`, `POST /repos/:owner/:repo/issues`, `PATCH /repos/:owner/:repo/issues/:number` all target the same noun, `issues`, varying only the verb.

```
GET    /workspaces/42/projects        # list
POST   /workspaces/42/projects        # create
GET    /workspaces/42/projects/7      # read one
PATCH  /workspaces/42/projects/7      # update
DELETE /workspaces/42/projects/7      # delete
```

**Tradeoffs:** predictable, cacheable (a `GET` is safe/idempotent by convention, so intermediaries and clients can cache it without asking your business logic), and the verb+status-code vocabulary is universally understood — a new engineer or a new client SDK doesn't need bespoke documentation to guess that `DELETE /projects/7` deletes project 7. The cost shows up for operations that don't map cleanly onto CRUD — "reset this workspace's invite code," "leave this workspace," "capture this payment" — where forcing a resource-oriented shape can feel contorted (is a password reset a `POST` to a `password-reset-tokens` resource, or just an action?).

**(b) RPC-style APIs, where the URL encodes an action rather than a resource.** Instead of `POST /workspaces`, an RPC-flavored API might expose `POST /workspace/create` — the verb is *in the path*, and the HTTP method itself (`POST` for almost everything) carries much less meaning. Stripe's API is mostly resource-oriented but leans RPC for exactly the non-CRUD case above — `POST /v1/charges/:id/capture`, `POST /v1/subscriptions/:id/cancel` — because "capture" and "cancel" aren't naturally expressible as a `PATCH` to a noun. gRPC (Google's RPC framework) commits to this shape entirely: every call is a named procedure (`CreateWorkspace`, `JoinWorkspace`), not a resource+verb pair.

```
POST /workspace/:id/reset-invite-code   # RPC-flavored: verb in the path
POST /workspaces/:id/invite-code        # resource-oriented equivalent: PUT/POST to a sub-resource
```

**Tradeoffs:** RPC-style URLs read naturally for actions that are genuinely actions, not disguised CRUD — nobody has to invent a fictitious "invite-code-reset" resource just to stay strictly RESTful. The cost is that it's easy for an entire API to drift RPC-shaped by convenience, one action-named route at a time, until the URL space stops being predictable from the resource model at all, and a client can no longer guess `DELETE /workspace/:id/leave` doesn't exist without checking — it's `POST /workspace/:id/leave`, because "leaving" isn't a deletion of the workspace.

**(c) GraphQL.** A single endpoint (conventionally `POST /graphql`) accepts a query describing exactly the shape of data the client wants, resolved by server-side resolver functions rather than a fixed set of URL+verb combinations. GitHub, Shopify, and countless internal APIs at companies with many different frontend clients (web, iOS, Android, each wanting a slightly different slice of the same data) use this to let each client ask for precisely what it needs in one round trip instead of over-fetching a fixed REST response shape or under-fetching and making N follow-up calls.

```graphql
# illustrative GraphQL query — not AstriX code
query {
  workspace(id: "42") {
    name
    projects(first: 5) { name, taskCount }
  }
}
```

**Tradeoffs:** solves over-fetching/under-fetching and gives clients real flexibility, at the cost of losing HTTP-level caching and status-code semantics almost entirely (everything is a `200` with a body that might contain an error), plus a genuinely different (and larger) server-side investment — a schema, resolvers, and usually a dedicated library (Apollo Server, GraphQL Yoga) — that's hard to justify for a single first-party web client with no competing consumers.

**(d) Code-first vs. spec-first OpenAPI generation.** Once you're documenting a REST (or REST-ish) API with the OpenAPI standard, there are two directions to generate that document from. *Code-first*: annotate route handlers with JSDoc comments (or decorators, in frameworks that support them) and generate the OpenAPI spec from the code at build/run time — `swagger-jsdoc` is exactly this for Express, NestJS's `@nestjs/swagger` decorators are the same idea for a decorator-based framework. The code is the source of truth; the spec is a derived artifact. *Spec-first*: write the OpenAPI YAML/JSON by hand (or in a design tool like Stoplight), then generate server stubs and/or client types *from* that spec (`openapi-generator`, `openapi-typescript`). The spec is the source of truth; the code (or at least its shape) is derived from it. Stripe's public API is a well-known spec-first example — their published OpenAPI document is what drives their official client SDKs across languages, and it's maintained as a first-class artifact independent of any one server implementation.

**Tradeoffs:** code-first is lower-friction for a small team building an API mainly for their own first-party client — there's one source of truth (the code), and the docs can't drift from behavior by definition, since they're generated from the same annotations a reviewer already sees in the diff. Its weakness is exactly that coupling: nothing stops a route from actually being un-annotated or annotated incorrectly, since nothing forces the spec and the implementation to agree beyond developer discipline. Spec-first pays more upfront cost (someone has to author and maintain a spec that isn't itself executable code) but is the stronger choice once external, contractual consumers depend on the API — a spec that's designed and reviewed *before* implementation lets client teams start building against mocked/generated types while the server is still being written, and makes a breaking change visible in a spec diff before it ships.

### 1.2 Talking to someone else's API

**(a) A raw SDK/client library provided by the vendor.** Most external services ship an official (or well-maintained community) npm package that wraps their HTTP API behind idiomatic method calls — `stripe.charges.create(...)`, `new Resend(apiKey)`, the AWS SDK's `S3Client`. You call methods, the library handles auth headers, retries (sometimes), serialization, and versioning of the underlying HTTP contract.

**(b) A hand-rolled HTTP adapter using a generic client like `axios`.** Instead of a vendor SDK, you write the HTTP calls yourself against a general-purpose client — construct the URL, set headers, `POST`/`GET`, parse the response. This is the only option when a vendor doesn't publish a Node SDK at all, and a deliberate choice even when they do, when a team wants to avoid an extra dependency or wants full visibility into exactly what's sent over the wire.

**(c) An internal adapter/port interface that wraps the vendor call so it could be swapped later.** A step further than (a) or (b) alone: define your *own* interface (`interface EmailSender { send(to, subject, html): Promise<void> }`) and have a vendor-specific implementation satisfy it, so calling code depends only on your interface, never on the vendor's types or client directly. This is the "ports and adapters" (hexagonal architecture) idea applied specifically to outbound integrations — swapping Resend for SES later would mean writing one new class/module that satisfies the same interface, with zero changes to any caller.

**(d) Resilience patterns layered on top of any of the above** — retries with backoff, circuit breakers, and timeouts, because a network call to a service you don't control *will* fail sometimes, and the question is only whether your code degrades gracefully or hangs/cascades when it does. Real, named libraries exist for each: `axios-retry` wraps an axios instance to automatically retry failed requests with configurable backoff; `opossum` implements the circuit-breaker pattern (Node's answer to the pattern Netflix's Hystrix popularized) — trip a breaker after N consecutive failures, fail fast without even attempting the call while it's open, then probe again after a cooldown; an explicit `timeout` option (on axios, or wrapped with `Promise.race` / `AbortController` for a raw `fetch`) bounds how long a single call is allowed to hang before the caller gives up on it.

**Does AstriX have any of (c) or (d)? Checked directly against the code, and the answer is no, plainly.** There is no `EmailSender`/`OAuthClient`-style interface anywhere in `backend/src/providers/` — both files export plain functions, not a class implementing a shared port. `axios-retry` and `opossum` are not in `backend/package.json`, and neither `google.provider.ts` nor `email.provider.ts` sets an explicit `timeout` on any outbound call, retries a failed call, or wraps a call in any breaker logic. These are named here specifically so their absence is legible as an absence, not a hidden assumption — see §6 and §7 for what that means in practice.

---

## 2. AstriX's Choice

AstriX's own API surface is **mostly REST, with a real, checkable minority of RPC-flavored action routes** — `POST /workspace/create/new`, `POST /workspace/:id/leave`, `POST /member/workspace/:inviteCode/join` sit alongside cleanly resource-oriented routes like `GET /workspace/:id`. Documentation is **code-first**, wired through `swagger-jsdoc` reading JSDoc annotations out of the route files, composed with hand-written OpenAPI component schemas from `backend/src/docs/schemas/`. For external providers, the two integrations are built differently on purpose, verified directly against `backend/package.json` and both provider files: **Google OAuth is a hand-rolled HTTP adapter using `axios`** — no `googleapis` SDK, no `passport` strategy anywhere in the dependency tree. **Resend, by contrast, is integrated through its own official `resend` npm SDK** (`new Resend(apiKey)`, `client.emails.send(...)`) — not a raw HTTP adapter. Two different providers, two different integration patterns, both real, neither a mistake — §5 explains why.

---

## 3. AstriX Implementation

### 3.1 The route surface, domain by domain — RPC-flavored vs. resource-oriented, in the same codebase

All six route files are short enough to read in full, and reading them side by side is the fastest way to see AstriX's REST/RPC split as it actually exists, rather than as a generalization.

```ts
// backend/src/routes/auth.route.ts:62-114
authRoutes.post("/register", authLimiter, registerUserController);
authRoutes.post("/login", authLimiter, loginController);
authRoutes.post("/refresh", refreshLimiter, refreshTokenController);

authRoutes.get("/google", oauthLimiter, (req: Request, res: Response) => {
  const state = generateGoogleOAuthState();

  res.cookie("google_oauth_state", state, {
    httpOnly: true,
    secure: config.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  res.redirect(getGoogleAuthorizationUrl(state));
});

authRoutes.get("/google/callback", oauthLimiter, googleCallbackController);

authRoutes.post(
  "/forgot-password",
  passwordResetLimiter,
  forgotPasswordController
);
authRoutes.post(
  "/reset-password",
  passwordResetLimiter,
  resetPasswordController
);

authRoutes.post(
  "/verify-email",
  emailVerificationLimiter,
  verifyEmailController
);
authRoutes.post(
  "/resend-verification",
  authenticate,
  emailVerificationLimiter,
  resendVerificationEmailController
);

authRoutes.post(
  "/change-password",
  authenticate,
  changePasswordLimiter,
  changePasswordController
);

authRoutes.post("/logout", logOutController);
authRoutes.post("/logout-all", authenticate, logOutAllController);
authRoutes.get("/sessions", authenticate, getSessionsController);
authRoutes.delete("/sessions/:id", authenticate, revokeSessionController);
```

The `/auth` domain is inherently action-shaped by nature — "login," "logout," "refresh" aren't nouns with a natural CRUD lifecycle — so every framework's auth routes end up looking RPC-ish; this isn't a deviation worth flagging on its own. `DELETE /sessions/:id`, though, is properly resource-oriented: a session is a real resource with an id, and deleting it (revoking it) uses the verb that means exactly that.

```ts
// backend/src/routes/project.route.ts:1-39
import { Router } from "express";
import {
  createProjectController,
  deleteProjectController,
  getAllProjectsInWorkspaceController,
  getProjectAnalyticsController,
  getProjectByIdAndWorkspaceIdController,
  updateProjectController,
} from "../controllers/project.controller";
const projectRoutes = Router();

projectRoutes.post("/workspace/:workspaceId/create", createProjectController);

projectRoutes.put(
  "/:id/workspace/:workspaceId/update",
  updateProjectController
);

projectRoutes.delete(
  "/:id/workspace/:workspaceId/delete",
  deleteProjectController
);

projectRoutes.get(
  "/workspace/:workspaceId/all",
  getAllProjectsInWorkspaceController
);

projectRoutes.get(
  "/:id/workspace/:workspaceId/analytics",
  getProjectAnalyticsController
);

projectRoutes.get(
  "/:id/workspace/:workspaceId",
  getProjectByIdAndWorkspaceIdController
);

export default projectRoutes;
```

This is the clearest side-by-side contrast in the whole codebase. `POST /workspace/:workspaceId/create` is RPC-flavored twice over: the verb "create" is redundant in the path (the `POST` already means create) and the resource being created, `project`, isn't even the leading path segment — a strict REST equivalent would be `POST /workspaces/:workspaceId/projects`. Same for `PUT /:id/workspace/:workspaceId/update` and `GET /workspace/:workspaceId/all` — "update" and "all" are both verb-shaped words doing work the HTTP method or an empty path already does. But the last route, `GET /:id/workspace/:workspaceId`, is cleanly resource-oriented: a `GET` to an identified path with no verb word at all — "fetch the project with this id, scoped to this workspace." Both styles exist in the same six-route file.

```ts
// backend/src/routes/workspace.routes.ts:16-39
const workspaceRoutes = Router();

workspaceRoutes.post("/create/new", createWorkspaceController);
workspaceRoutes.put("/update/:id", updateWorkspaceByIdController);

workspaceRoutes.put(
  "/change/member/role/:id",
  changeWorkspaceMemberRoleController
);

workspaceRoutes.delete("/delete/:id", deleteWorkspaceByIdController);

workspaceRoutes.delete("/:id/member/:userId", removeWorkspaceMemberController);
workspaceRoutes.post("/:id/leave", leaveWorkspaceController);
workspaceRoutes.post("/:id/invite/reset", resetWorkspaceInviteCodeController);

workspaceRoutes.get("/all", getAllWorkspacesUserIsMemberController);

workspaceRoutes.get("/members/:id", getWorkspaceMembersController);
workspaceRoutes.get("/analytics/:id", getWorkspaceAnalyticsController);

workspaceRoutes.get("/:id", getWorkspaceByIdController);

export default workspaceRoutes;
```

`POST /create/new` is the most RPC-flavored route in the entire codebase — two consecutive verb-ish path segments, no resource noun visible until you already know it's mounted under `${BASE_PATH}/workspace`. `DELETE /:id/member/:userId`, by contrast, is textbook REST: `DELETE` to a specifically identified sub-resource (`member :userId` of workspace `:id`) with no verb word anywhere in the path. `POST /:id/leave` and `POST /:id/invite/reset` sit in between — genuinely action-like operations ("leave," "reset the invite code" aren't updates to a field, they're behaviors) expressed the RPC way rather than forced into an artificial sub-resource.

```ts
// backend/src/routes/member.route.ts:1-8
import { Router } from "express";
import { joinWorkspaceController } from "../controllers/member.controller";

const memberRoutes = Router();

memberRoutes.post("/workspace/:inviteCode/join", joinWorkspaceController);

export default memberRoutes;
```

```ts
// backend/src/routes/user.route.ts:1-22
import { Router } from "express";
import { createRateLimiter } from "../utils/rate-limiter";
import {
  getCurrentUserController,
  updateProfileController,
  deleteAccountController,
} from "../controllers/user.controller";

const userRoutes = Router();

// Destructive and irreversible - worth bounding even behind auth, same
// reasoning as changePasswordLimiter in auth.route.ts.
const deleteAccountLimiter = createRateLimiter("delete-account", {
  max: 5,
  message: { error: "Too many attempts. Please try again later." },
});

userRoutes.get("/current", getCurrentUserController);
userRoutes.patch("/current", updateProfileController);
userRoutes.delete("/current", deleteAccountLimiter, deleteAccountController);

export default userRoutes;
```

`user.route.ts` is the cleanest resource-oriented file in the codebase: `/current` is a pseudo-resource id (a common, widely-used REST convention — GitHub's own API has `GET /user` mean "the authenticated user," same idea), and all three CRUD-shaped verbs (`GET`, `PATCH`, `DELETE`) target that one path with no verb word in sight.

```ts
// backend/src/routes/task.route.ts:1-31
const taskRoutes = Router();

taskRoutes.post(
  "/project/:projectId/workspace/:workspaceId/create",
  createTaskController
);

taskRoutes.put(
  "/:id/project/:projectId/workspace/:workspaceId/update",
  updateTaskController
);

taskRoutes.get("/workspace/:workspaceId/all", getAllTasksController);

taskRoutes.delete("/:id/workspace/:workspaceId/delete", deleteTaskController);

taskRoutes.get(
  "/:id/project/:projectId/workspace/:workspaceId",
  getTaskByIdController
);

export default taskRoutes;
```

Same shape as `project.route.ts` — `create`/`update`/`all` are RPC-flavored, the final `GET` is resource-oriented. This is a consistent pattern across the codebase, not an inconsistency between files: **every write-side route that also needs to carry parent-resource ids in its path (`:workspaceId`, `:projectId`) picked the RPC-flavored shape, and every plain "fetch by id" route picked the resource-oriented shape.**

### 3.2 Swagger config wiring

```ts
// backend/src/config/swagger.config.ts:1-37
import swaggerJSDoc from "swagger-jsdoc";

import { config } from "./app.config";
import { authSchemas } from "../docs/schemas/auth.schemas";
import { projectSchemas } from "../docs/schemas/project.schemas";
import { taskSchemas } from "../docs/schemas/task.schemas";
import { userSchemas } from "../docs/schemas/user.schemas";

export const swaggerOptions: swaggerJSDoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Astrix : Project Management App",
      version: "1.0.0",
      description: "Project Management APIs with Auth implemented",
    },
    servers: [
      {
        url: config.API_PUBLIC_URL,
        description: `${config.NODE_ENV} server`,
      },
    ],

    components: {
      schemas: {
        ...authSchemas,
        ...projectSchemas,
        ...taskSchemas,
        ...userSchemas,
      },
    },
  },

  apis: ["./src/routes/**/*.ts"],
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);
```

Two things about this file matter more than they look at first glance. First, `components.schemas` is populated by spreading four plain TypeScript objects imported from `backend/src/docs/schemas/` — these are **hand-written OpenAPI schema fragments**, not generated from Zod or Drizzle, which means they can drift from the real request/response shapes if a validation schema or the database schema changes and nobody remembers to update the matching fragment. That drift isn't hypothetical — it's the actual, current state of this exact directory: `user.schemas.ts`'s own top comment still reads "Shapes derived from src/models/user.model.ts... keep them in step with those two files," and its `User` schema still documents a Mongo-shaped `_id` field and a `currentWorkspace` example formatted like a Mongo `ObjectId` (`"64f1a2b3c4d5e6f7a8b9c0d1"`), even though the real `users` table (per [`07-database-schema-design.md`](./07-database-schema-design.md)) has had a plain `id: uuid` primary key and a `currentWorkspaceId` column since the migration, with no `src/models/` directory left to derive anything from at all. This is a known, acknowledged gap, not something silently papered over here: `user.schemas.ts`, `project.schemas.ts`, and `task.schemas.ts` all carry the same Mongo-shaped `_id`/`ObjectId`-example staleness (checked directly against each file) — `auth.schemas.ts` is the one exception, since its two fragments (`RegisterUserInput`, `LoginUserInput`) are pure request-body shapes with no id field to have gone stale in the first place. Fixing the three stale files is explicitly out of this chapter's scope — they're hand-maintained OpenAPI fragments, not something a docs chapter can correct without editing application source, so the honest thing to do here is name the gap precisely rather than either fixing it in place or ignoring it. One representative fragment, exactly as it reads in the source today:

```ts
// backend/src/docs/schemas/user.schemas.ts:1-29
// Shapes derived from src/models/user.model.ts (responses) and
// src/validation/user.validation.ts (request bodies) - keep them in step
// with those two files. `password` is deliberately absent: every user-facing
// response goes through omitPassword().
export const userSchemas = {
  User: {
    type: "object",
    properties: {
      _id: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d1" },
      name: { type: "string", example: "John Doe" },
      email: { type: "string", format: "email", example: "john@example.com" },
      profilePicture: {
        type: "string",
        nullable: true,
        example: "https://cdn.example.com/avatars/john.png",
      },
      isActive: { type: "boolean", example: true },
      // Advisory only - an unverified email never blocks login.
      isEmailVerified: { type: "boolean", example: false },
      lastLogin: { type: "string", format: "date-time", nullable: true },
      currentWorkspace: {
        type: "string",
        nullable: true,
        example: "64f1a2b3c4d5e6f7a8b9c0d2",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  // ...UpdateProfileInput, DeleteAccountInput, Session omitted here — see the full file
};
```

Second, and more important: `apis: ["./src/routes/**/*.ts"]` tells `swagger-jsdoc` to scan every route file for JSDoc comment blocks tagged `@swagger` (or `@openapi`) and turn each one into a documented path. **A direct search of every file under `backend/src/routes/` for `@swagger` or `@openapi` returns zero matches.** None of the six route files shown in §3.1 carries any such annotation. This means the wiring is real and functional — `swaggerSpec` is a genuine, valid OpenAPI document, `/api/docs` genuinely serves it — but as of this reading, the generated spec's `paths` object is effectively empty; only `components.schemas` (the four hand-written fragments above) is actually populated. The schemas exist ahead of the path documentation that would reference them, not the other way around. This is a real, checkable state of the codebase, not a matter of interpretation, and it's exactly the kind of gap §6 and §7 return to rather than paper over.

### 3.3 The `/api/docs` mount, non-production only

Already shown in full in the master file ([`00-master-backend-architecture.md`](./00-master-backend-architecture.md)) — reused here with its citation because it's the exact gate that determines whether the schema-only spec above is even reachable:

```ts
// backend/src/app.ts (excerpt)
const apiLimiter = createRateLimiter("api", {
  max: 300,
  // Health checks (e.g. an ALB target-group check) can legitimately fire
  // far more often than any real API consumer and shouldn't be limited.
  skip: (req) => req.path === "/health",
});

app.use(apiLimiter);

// ============================================
// API DOCUMENTATION
// ============================================

// Not mounted in production - it's a full route/schema map handed to
// anyone who requests it, and CloudFront proxies /api/* straight through
// to the public ALB with no auth in front of it.
if (config.NODE_ENV !== "production") {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}
```

The `/health` endpoint referenced by the rate limiter's `skip` above actually round-trips to both backing stores, rather than reading an in-memory connection flag:

```ts
// backend/src/app.ts (excerpt)
app.get("/health", async (req: Request, res: Response) => {
  const [pgOk, redisOk] = await Promise.all([
    db.execute(sql`SELECT 1`).then(() => true).catch(() => false),
    redis.ping().then(() => true).catch(() => false),
  ]);

  const healthy = pgOk && redisOk;

  res.status(healthy ? HTTPSTATUS.OK : HTTPSTATUS.SERVICE_UNAVAILABLE).json({
    status: healthy ? "OK" : "DEGRADED",
    postgres: pgOk ? "connected" : "disconnected",
    redis: redisOk ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});
```

Both checks run concurrently via `Promise.all`, and each is wrapped in its own `.catch(() => false)` so a Postgres outage doesn't throw before the Redis check gets a chance to run (or vice versa) — the endpoint always returns a real status for both dependencies rather than failing closed on whichever one happens to be checked first. `src/index.ts` performs an additional, stricter check before ever binding to a port: a failed `SELECT 1` there calls `process.exit(1)`, so a task that can't reach Postgres never reports itself as listening in the first place. Redis connectivity is deliberately NOT part of that startup gate — `src/redis/client.ts`'s own `"error"` listener treats a transient Redis blip as recoverable rather than fatal, so only Postgres blocks startup.

`/health` is mounted unconditionally (any environment), with no `authenticate` middleware and exempted from the general rate limiter — it has to be reachable, cheaply, by an ALB target-group check regardless of environment or load. `/api/docs` is the opposite: gated entirely on `NODE_ENV !== "production"`, precisely because — even in its current schema-only state — it's still a live `swagger-ui-express` instance that would otherwise sit on a publicly reachable path in production with no auth in front of it.

### 3.4 The Resend email provider, in full

```ts
// backend/src/providers/email.provider.ts:1-87
import { Resend } from "resend";
import { config } from "../config/app.config";
import { logger } from "../utils/logger";

let resendClient: Resend | null = null;

// Lazy singleton so a missing RESEND_API_KEY doesn't crash the app at
// import time - only sendEmail's caller ever needs to know.
const getResendClient = (): Resend | null => {
  if (!config.RESEND_API_KEY) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(config.RESEND_API_KEY);
  }
  return resendClient;
};

const sendEmail = async (params: {
  to: string;
  subject: string;
  html: string;
  logContext: Record<string, unknown>;
}): Promise<void> => {
  const { to, subject, html, logContext } = params;
  const client = getResendClient();

  if (!client) {
    // Not configured - don't fail the caller over it (whatever token/state
    // the email was meant to communicate is already valid regardless),
    // just make the miss loud in logs so it's never a silent surprise in
    // an environment that should have sent it.
    logger.warn(
      { to, ...logContext },
      "RESEND_API_KEY not set - would have sent an email"
    );
    return;
  }

  const { error } = await client.emails.send({
    from: config.EMAIL_FROM,
    to,
    subject,
    html,
  });

  if (error) {
    logger.error(
      { to, err: error, ...logContext },
      "Resend failed to send email"
    );
  }
};

export const sendPasswordResetEmail = async (
  to: string,
  resetUrl: string
): Promise<void> => {
  await sendEmail({
    to,
    subject: "Reset your password",
    html: `
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}">Click here to reset your password</a></p>
      <p>If you didn't request this, you can safely ignore this email - your password won't change.</p>
      <p>This link will expire soon and can only be used once.</p>
    `,
    logContext: { type: "password-reset", resetUrl },
  });
};

export const sendVerificationEmail = async (
  to: string,
  verifyUrl: string
): Promise<void> => {
  await sendEmail({
    to,
    subject: "Verify your email address",
    html: `
      <p>Please confirm your email address to finish setting up your account.</p>
      <p><a href="${verifyUrl}">Click here to verify your email</a></p>
      <p>If you didn't create this account, you can safely ignore this email.</p>
    `,
    logContext: { type: "email-verification", verifyUrl },
  });
};
```

Two design decisions are worth naming explicitly here, because they're the whole shape of the file: the **lazy-singleton client** (`getResendClient`) means an unset `RESEND_API_KEY` never crashes the process at boot — the `Resend` client is only constructed the first time an email actually needs sending, not at import time — and the **"no API key → warn and skip" fallback** means `sendEmail` always resolves successfully (never throws) when the key is simply absent. Both are deliberate; §4 traces exactly what that second one means for a caller.

### 3.5 The Google OAuth provider, in full

```ts
// backend/src/providers/google.provider.ts:1-89
import axios from "axios";
import crypto from "crypto";
import { config } from "../config/app.config";
import { UnauthorizedException } from "../utils/appError";

export interface OAuthProfile {
  provider: string;
  providerId: string;
  email: string;
  name: string;
  picture?: string;
  // Whether Google itself has confirmed the user controls this email
  // address. Used to gate auto-linking to a pre-existing account (see
  // loginOrCreateAccountService) - never trust an unverified email for
  // that decision.
  emailVerified: boolean;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

interface GoogleProfileResponse {
  sub: string;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
}

export const getGoogleAuthorizationUrl = (state: string): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("state", state);

  return url.toString();
};

export const exchangeGoogleCodeForProfile = async (
  code: string
): Promise<OAuthProfile> => {
  try {
    const tokenResponse = await axios.post<GoogleTokenResponse>(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const { access_token } = tokenResponse.data;

    const profileResponse = await axios.get<GoogleProfileResponse>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const googleProfile = profileResponse.data;

    return {
      provider: "GOOGLE",
      providerId: googleProfile.sub,
      email: googleProfile.email,
      name: googleProfile.name,
      picture: googleProfile.picture,
      // Conservative default: treat a missing field as NOT verified rather
      // than assuming Google confirmed it.
      emailVerified: googleProfile.email_verified === true,
    };
  } catch {
    throw new UnauthorizedException("Failed to authenticate with Google");
  }
};

export const generateGoogleOAuthState = (): string => {
  return crypto.randomBytes(32).toString("hex");
};
```

Reading this purely as "an integration with an external HTTP API" (the CSRF/`state`-cookie security mechanics of the surrounding flow are covered in full in [`02-authentication-and-authorization.md` §3.5–3.6](./02-authentication-and-authorization.md)): there are exactly two outbound calls. `getGoogleAuthorizationUrl` never makes a network call at all — it just builds a URL string the browser is redirected to, using Node's built-in `URL`/`URLSearchParams`, not axios. The two real HTTP calls both live inside `exchangeGoogleCodeForProfile`: a `POST` to Google's token endpoint trading the one-time authorization `code` for an `access_token`, then a `GET` to Google's OpenID Connect `userinfo` endpoint using that access token as a bearer credential to fetch the profile (`sub`, `email`, `name`, `picture`). Both calls target hardcoded string-literal URLs — `https://oauth2.googleapis.com/token` and `https://openidconnect.googleapis.com/v1/userinfo` are not built from any request input, which matters for §6's SSRF question. Every failure mode from either call — a bad code, a network error, an unexpected response shape, Google being down — is caught by one blanket `catch` and re-thrown as a single, generic `UnauthorizedException("Failed to authenticate with Google")`, discarding the original error entirely rather than passing it through.

---

## 4. Request/Data Flow

### 4.1 Password-reset request → token → Resend call, end to end

Tracing `requestPasswordResetService` all the way through to the actual Resend API call, because it's the one place in this codebase where an external-provider failure has a real, user-facing security/UX consequence — the answer isn't obvious from reading `email.provider.ts` alone.

```ts
// backend/src/services/auth.service.ts:357-377
export const requestPasswordResetService = async (email: string): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.email, email));

  // Deliberately the same outcome (no error, no distinguishing response)
  // whether or not the account exists - an unauthenticated "does this email
  // have an account" oracle is exactly what this endpoint must not become.
  if (!user) {
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  await storeToken(
    "pwreset",
    hashToken(rawToken),
    user.id,
    ttlSecondsUntil(config.PASSWORD_RESET_TOKEN_EXPIRES_IN)
  );

  const resetUrl = `${config.FRONTEND_PASSWORD_RESET_URL}?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, resetUrl);
};
```

`storeToken("pwreset", hashToken(rawToken), user.id, ttlSecondsUntil(...))` is `services/redis/token.service.ts`'s single-use-token store — a Redis `SET` with an expiry equal to the token's own lifetime, keyed by the token's hash. This is a direct, deliberate simplification over what a Postgres-table-backed reset token would need: there's no separate "delete any previously issued token for this user first" step the way a `PasswordResetTokenModel.deleteMany({ userId })`-style table-backed version would need, because a *new* call to `requestPasswordResetService` simply writes a new Redis key under a new token's hash — the old token isn't explicitly revoked, but Redis's own TTL expires it on the same schedule it always would have, and `resetPasswordService`'s `consumeToken(...)` call makes any token single-use via an atomic get-and-delete regardless of how many were ever issued. Full Redis TTL/token-store mechanics are [`03-middleware-and-request-pipeline.md`](./03-middleware-and-request-pipeline.md)'s territory, not re-derived here.

```ts
// backend/src/controllers/auth.controller.ts:238-253
export const forgotPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { email } = forgotPasswordSchema.parse(req.body);

    await requestPasswordResetService(email);

    // Always the same response, whether or not the email belongs to an
    // account - requestPasswordResetService already no-ops for an unknown
    // email, so this line is reached (and this exact message returned)
    // either way.
    return res.status(HTTPSTATUS.OK).json({
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });
  }
);
```

The full call chain for an existing account: `POST /auth/forgot-password` → `forgotPasswordController` parses the body with Zod → `requestPasswordResetService` looks the user up, generates a fresh 32-byte random token, stores only its SHA-256 hash in Redis under a TTL equal to the token's own lifetime (never the raw token — the same discipline covered for refresh tokens in [file 02](./02-authentication-and-authorization.md#33-the-session-model)), builds a reset URL embedding the *raw* token, and calls `sendPasswordResetEmail(user.email, resetUrl)` — which is `email.provider.ts`'s `sendEmail` under the hood, `await`ed all the way up. As §4.1's code above already shows, there's no separate "delete any previously issued token" step here — a Postgres-table-backed version of this would need one, but a fresh `storeToken(...)` call simply writes a new Redis key under the new token's own hash, and Redis's TTL retires whatever was issued before on its own schedule.

**Now the concrete question: what happens if Resend is unreachable, or `RESEND_API_KEY` is unset or invalid — does the password-reset request still return success even though no email was sent?**

Tracing the actual branches in `sendEmail` (§3.4) against this call chain, the answer is: **yes, in the case that matters most, and the code is explicit about it.**

- **`RESEND_API_KEY` unset.** `getResendClient()` returns `null`. `sendEmail` hits its `if (!client)` branch, logs `logger.warn(...)`, and `return`s — normally, with no thrown error. That `return` propagates straight back up through `sendPasswordResetEmail` → `requestPasswordResetService` → `forgotPasswordController`, which reaches its `return res.status(HTTPSTATUS.OK).json(...)` line exactly as if the email had actually gone out. **The user is told a reset link was sent. No email was sent. Nothing in the response tells them that.**
- **`RESEND_API_KEY` set but invalid, or Resend rejects the request (bad key, account suspended, domain not verified, rate-limited).** `client.emails.send(...)` is Resend's own SDK call, and per the code's own handling, its failure mode is a *returned* `{ error }` field on the resolved response — not a thrown exception. The `if (error)` branch logs `logger.error(...)` and the function still falls through to its implicit `return`, exactly like the unset-key branch. **Same outcome: 200 success to the user, no email actually delivered, the only trace of the failure is a server-side log line.**
- **Resend is genuinely unreachable (a lower-level network failure before any HTTP response comes back at all).** This is the one branch this code does *not* explicitly handle: `sendEmail` never wraps `client.emails.send(...)` in a `try`/`catch`. If the SDK call were to reject its promise outright (rather than resolving with an `{ error }` field, which per the two bullets above is how Resend's SDK represents an API-level failure), that rejection would propagate uncaught through every `await` in the chain above, into `asyncHandler`'s `catch`, into `errorHandler`, and the response would become a generic `500` instead of a `200` — a different, more honest failure mode, but also a worse one from a security-oracle-hardening perspective, since a `500` distinguishable from a `200` is exactly the kind of signal `requestPasswordResetService`'s comment about "no distinguishing response" was written to avoid. Whether a true network-level failure surfaces as a promise rejection or as Resend's own `{ error }` result is a property of the `resend` package's internals, not something this file's code decides — not verifiable by reading AstriX's source alone, so it's stated here as an open question rather than a claim.

The practical, verifiable-from-this-code answer: **an unset or rejected API key silently and successfully "succeeds" from the caller's perspective every time**, which means a real user relying on password-reset for account recovery gets a "check your email" message with no email ever arriving, and the only signal anything went wrong lives in a server log they'll never see. This is revisited as a security concern, not just a bug, in §6.

### 4.2 The Google OAuth round trip — the external-call angle

Briefly, since the CSRF/`state`/session mechanics are [file 02](./02-authentication-and-authorization.md)'s territory, here's the same flow from a pure "what HTTP calls happen, in what order" view: `GET /auth/google` builds a redirect URL to Google's own consent screen (no outbound call from AstriX's server at all — `getGoogleAuthorizationUrl` just assembles a string) and 302s the browser there directly. The browser interacts with Google, not AstriX, for the consent step. Google then redirects the browser back to `GOOGLE_CALLBACK_URL` with a one-time `code`. Only at that point does AstriX's server make its first outbound call to Google: `googleCallbackController` (shown in full, including its CSRF `state` check, in [file 02 §3.6](./02-authentication-and-authorization.md#36-csrf-state-handling-for-the-oauth-callback)) hands that `code` to `exchangeGoogleCodeForProfile`, which — as traced in §3.5 above — makes exactly two sequential axios calls (token exchange, then userinfo fetch) before returning a normalized `OAuthProfile`. Any failure in either call collapses to the same generic `UnauthorizedException`, so from the outside, "Google is down," "the code was already used," and "the code was forged" are all indistinguishable to the caller — a real, if minor, debuggability cost of the blanket `catch` noted in §3.5.

---

## 5. Design Decisions & Tradeoffs

**Why manual `axios` calls instead of `googleapis` or a `passport` strategy for Google.** `googleapis` is Google's own, very large, all-Google-APIs client library — using it just for an OAuth login exchange (two endpoints, no other Google API ever called) pulls in a dependency scoped for a much bigger job than AstriX has for it. `passport-google-oauth20` is scoped correctly for the job, but assumes ownership of session/serialization concerns (`passport`'s `done()` callback, its own session middleware conventions) that don't map cleanly onto AstriX's already-hand-rolled JWT + rotating-refresh-token session model (file 02) — adopting it would mean reconciling two different "who owns the session" mental models rather than one. The tradeoff, paid deliberately: AstriX's ~90-line `google.provider.ts` re-implements, by hand, everything those libraries would otherwise absorb — there's no built-in retry/backoff around Google's endpoints (see §7), no `id_token` signature verification as a defense-in-depth alternative to the userinfo round trip, and no ready-made path to add a second OAuth provider (GitHub, Microsoft) without writing another near-duplicate provider file. What's gained is total visibility into exactly what's sent to and received from Google, one fewer third-party dependency to track for vulnerabilities, and freedom from a library whose default assumptions about session ownership would otherwise have to be worked around.

**Why Resend over alternatives like AWS SES or SendGrid.** Nothing in `email.provider.ts`, `app.config.ts`, or their surrounding comments states an explicit reason Resend was picked over another transactional-email provider — this isn't documented in code, so it's worth saying plainly rather than inventing a rationale that isn't there. Reasoning generically about the tradeoff instead: Resend's whole pitch is a minimal, developer-experience-first API and SDK (`new Resend(key)`, `client.emails.send({...})` — exactly the four-line call in `email.provider.ts`) aimed at teams that want to be sending mail in minutes without touching AWS IAM policies, SES sandbox-mode verification requests, or SNS bounce/complaint webhook wiring. SES, by contrast, integrates more deeply with an AWS-centric infrastructure (IAM roles instead of a separate API key, typically markedly lower per-email cost at real scale, native CloudWatch metrics) at the cost of a steeper initial setup — sandbox mode requiring per-recipient verification until a production access request is approved, and bounce/complaint handling that's a first-class but separate piece of AWS plumbing (SNS topics, not just an SDK call) rather than built into the send call itself. For a project at AstriX's current scale, prioritizing "email sending works in minutes, revisit cost later" over "cheapest per-email cost, pay the AWS setup tax upfront" is a defensible generic tradeoff — but it's exactly that: a plausible generic reason, not a documented one, and the two should not be conflated when reading this codebase.

**Why the vendor SDK for Resend but not for Google.** This isn't an inconsistency — it follows directly from what each vendor actually publishes and what AstriX actually needs from it. Resend's own SDK is a thin, minimal wrapper around one HTTP call (`emails.send`) with no heavyweight dependency baggage and no assumption about how the rest of the app is structured — adopting it costs almost nothing and buys request/response typing for free. Google's send-a-login-request use case, as covered above, doesn't have an equivalently minimal official SDK scoped to just OAuth login — the closest official option (`googleapis`) is scoped for the entire Google API surface, and the closest scoped option (`passport-google-oauth20`) brings session-ownership assumptions that fight AstriX's existing session design. Two different vendors, two different "does adopting the official option actually pay for itself" answers.

**Why Swagger is dev/staging-only rather than always mounted.** Directly stated in the code's own comment (§3.3): `/api/docs` is "a full route/schema map handed to anyone who requests it, and CloudFront proxies `/api/*` straight through to the public ALB with no auth in front of it." Even setting aside today's schema-only state (§3.2), mounting an interactive, unauthenticated API explorer on a production path that's publicly reachable through the CDN is a real information-disclosure and probing surface for no operational benefit — nobody needs `/api/docs` to keep production traffic flowing, unlike `/health`, which every environment genuinely needs for load-balancer checks. Gating on `NODE_ENV` keeps the tool available exactly where it's useful (a developer's local box, a staging environment engineers actually poke at) and absent exactly where its cost (surface area, zero benefit) outweighs its value.

---

## 6. Security Considerations

**Silently no-op'd password-reset emails are an account-recovery availability concern, not just a bug.** §4.1 traced this precisely: an unset or invalid `RESEND_API_KEY` in production doesn't produce an error anywhere a user or an on-call engineer would immediately see — it produces a normal `200` response telling the user a reset link is on its way, permanently, until someone happens to read the `logger.warn`/`logger.error` lines this produces. A user genuinely locked out of their account, relying on password reset as their only path back in, would have no way to know the feature is silently broken for them specifically versus everyone. This is deliberately framed as a UX-integrity/availability issue rather than a classic "vulnerability," because nothing here leaks data or grants unauthorized access — but "the account-recovery mechanism silently doesn't work" is squarely a security-adjacent concern for exactly the population (locked-out users) that most needs it to work.

**SSRF surface: checked directly, and there isn't one.** Neither provider adapter accepts a URL, hostname, or anything resembling one from request/user input and fetches it server-side. `google.provider.ts` targets two hardcoded string-literal URLs (`https://oauth2.googleapis.com/token`, `https://openidconnect.googleapis.com/v1/userinfo`) — the only request-derived values that flow into those calls are `code` (in the POST body, not the URL) and the bearer `access_token` (in a header). `email.provider.ts` never constructs or fetches a URL at all; `resetUrl`/`verifyUrl` are built from server-side `config.FRONTEND_*` values plus a server-generated token and only ever end up embedded as `<a href>` text inside an email body — nothing server-side ever fetches them. There is no user-suppliable "webhook URL," "callback URL," or "avatar URL" field anywhere in either provider that gets dereferenced by the server.

**What's exposed in Swagger if left mounted in production — checked against the actual generated spec, not assumed.** As established in §3.2, zero routes currently carry `@swagger`/`@openapi` JSDoc annotations, so the spec `/api/docs` would serve today has no documented paths at all — its only populated content is `components.schemas`: `User`, `Session`, `Project`, `Task`, and their request-input counterparts. None of these schema fragments include a `password` field — `user.schemas.ts`'s own top comment states this is deliberate, matching `omitPassword()`'s use throughout the service layer. So the concrete exposure, as things stand, is limited to field-name/type shape disclosure (useful reconnaissance for an attacker, but not a secret leak) rather than a documented map of every internal or sensitive endpoint — because no endpoints are documented in the spec at all yet. This is worth flagging both ways: it's a smaller current exposure than "the whole API surface is mapped," but it also means the `swagger-jsdoc` investment isn't yet delivering the endpoint-level documentation it's wired up to produce — see §7.

**Outbound API key/secret handling in logs — asymmetric between the two providers, by construction.** `google.provider.ts` wraps both outbound calls in one `try`/`catch` that discards the original error entirely and throws a fresh, generic `UnauthorizedException("Failed to authenticate with Google")` (§3.5) — so whatever an axios error object might have carried (potentially including request config, which for the token-exchange call includes `client_secret` in its POST body) never reaches `errorHandler`'s logging call or any other log line; it's discarded in the `catch` before anything downstream ever sees it. `email.provider.ts` takes a different path: a Resend API-level failure is logged directly (`logger.error({ to, err: error, ...logContext }, "Resend failed to send email")`), but `err: error` here is Resend's own returned error object from `client.emails.send`, not a raw HTTP client error — it does not include the request itself (the API key is sent as a bearer credential by the SDK, not echoed back in its own error shape). Cross-checked against [`04-error-handling-patterns.md`](./04-error-handling-patterns.md)'s coverage of `errorHandler`'s production behavior: any error that *does* reach that shared middleware uncaught falls through to its final, catch-all branch —

```ts
// backend/src/middlewares/errorHandles.middleware.ts:67-72
return res.status(HTTPSTATUS.INTERNAL_SERVER_ERROR).json({
  message: "Internal Server Error",
  error:
    config.NODE_ENV === "production"
      ? "Unknown error occurred"
      : error?.message || "Unknow error occurred",
});
```

— which replaces the real error's `message` with the fixed string `"Unknown error occurred"` in production, before anything is returned to a client. So even in the one untraced edge case from §4.1 (a raw network-level exception from the Resend SDK reaching `errorHandler` uncaught), the client-facing response wouldn't echo secret-bearing detail; whether the *server-side log line* for that same error could ever contain more than Resend's own SDK chooses to put in its thrown error object isn't verifiable from AstriX's code alone.

---

## 7. Best Practice Check

**REST conventions.** Resource-oriented URLs with standard verbs remain the clear 2026 default for a first-party API with one primary client, and AstriX's `GET`-by-id routes, `DELETE /workspace/:id/member/:userId`, and the `/user/current` pseudo-resource all match that standard cleanly. The RPC-flavored routes documented in §3.1 (`/create/new`, `/:id/create`, `/join`, `/leave`, `/update/:id`) are a real, plainly-named style deviation from strict REST — but it's worth being precise about how much this actually matters: action-shaped operations that don't map onto plain CRUD are exactly where even strongly RESTful public APIs (Stripe's `/capture`, `/cancel` endpoints, cited in §1.1) commonly lean RPC on purpose, because forcing every operation into a resource+verb shape produces its own awkwardness. AstriX's version of this is more pervasive than Stripe's — the verb shows up even for plain create/update/list, not just genuinely action-like operations like "leave" or "reset invite code" — which is a consistency/predictability style note worth raising with the team, but not a functional defect; every route still works correctly and consistently within its own convention.

**OpenAPI generation.** Code-first via `swagger-jsdoc` remains a reasonable, low-friction choice for a team this size building primarily for its own first-party client — that judgment doesn't change based on what's actually annotated today. What *is* a real, current gap, verified directly rather than assumed: the wiring exists and works, but zero routes are actually annotated, so the tooling isn't yet delivering the endpoint documentation it's built to produce. Spec-first tooling (hand-written OpenAPI, generated stubs/types) becomes the stronger choice specifically once external or contractual API consumers exist and need a stable, reviewable contract independent of any one implementation — not yet AstriX's situation, based on everything read for this chapter.

**External-provider integration resilience.** Retries with backoff, circuit breakers, and explicit timeouts on outbound calls to services you don't control are fairly standard practice for a production backend in 2026 — not exotic hardening, closer to a baseline expectation once real users depend on a feature that calls out to a third party. **AstriX currently has none of these**, checked directly against both provider files and `package.json` in §1.2: no `timeout` option on any axios call, no `axios-retry`, no `opossum` or equivalent circuit breaker, and no retry logic of any kind around either the Google calls or the Resend SDK call. Naming this plainly, as this curriculum's own rule requires: it's a real, worth-knowing gap in both provider files, not evidence of anything broken today — both integrations work under normal conditions, and the gap only shows up as degraded behavior (a hanging request, a single transient failure treated as permanent) under exactly the kind of external-service flakiness that timeouts/retries/breakers exist to smooth over.

---

## 8. Debug Drill

**Scenario:** support reports that password-reset emails aren't arriving for some users, but other users report they work fine. Nothing in the error tracker shows an exception, and the affected users insist they're using the correct, existing email address. Where do you look first, and why — as a transferable exercise for any REST + external-provider backend, not just this one?

1. **Confirm the request is actually reaching the provider call, not failing earlier.** Before suspecting Resend at all, check whether `requestPasswordResetService`'s early `if (!user) return;` branch (§4.1) could be the real cause — a user typing an email with different casing or a typo than what's stored, or an account created via Google OAuth whose local `User` record has a different canonical email than the one they're typing into the reset form. This produces the exact same "silently nothing happens" symptom as a provider failure, from a completely different, non-provider cause — ruling this out first prevents chasing a Resend problem that isn't there.
2. **Read the server logs for the specific request, not just the error tracker.** As established in §4.1, neither the "API key unset" branch nor the "Resend returned an error" branch throws — they only log (`logger.warn`/`logger.error` in `email.provider.ts`), which is exactly why an error tracker built around thrown exceptions would show nothing here. Search structured logs for the `type: "password-reset"` context tag (present on both the warn and error log calls) scoped to the affected user's email or the approximate timestamp of their report — this either confirms the send was attempted and failed at the provider, or reveals it wasn't attempted at all.
3. **If the logs show `"RESEND_API_KEY not set"`,** the fix is entirely environmental/config, not code — check whether the affected report correlates with a specific deployment environment (a staging box missing the key entirely) rather than "some users" in the way it was first framed; a config gap usually looks like "nobody in this environment gets email," which can be misreported as "some users" if only a few people happened to test in that environment.
4. **If the logs show `"Resend failed to send email"` with an actual error payload,** that payload is the fastest path to the real cause — a provider-side rejection (invalid/revoked key, account suspended, domain verification lapsed for the `EMAIL_FROM` address, a per-recipient bounce/suppression on Resend's side, or a rate limit) reads very differently from a per-recipient delivery problem (the affected users' own mail provider spam-filtering mail from a domain with a misconfigured or missing DKIM/SPF/DMARC record for `EMAIL_FROM`) — the second explanation fits "works for some users, not others" much better than the first, since spam filtering is frequently per-recipient-mail-provider, not global.
5. **If nothing in AstriX's own logs shows a failure at all,** the investigation moves outside this codebase entirely: Resend's own dashboard/delivery logs for the send attempt (delivered, bounced, marked spam, suppressed) are the actual source of truth for what happened after the API call succeeded on AstriX's end — a `200`-equivalent response from `client.emails.send` only means Resend *accepted* the send request, not that the recipient's inbox ever received it.

The transferable lesson: whenever an external-provider integration "fails silently" from the calling application's perspective — which §4.1 showed is exactly how this specific code is built to behave on more than one failure branch — the debugging sequence has to widen outward in a specific order: first rule out that the request reached the provider call at all (an early return, a validation rejection), then check what the calling application itself logged about the attempt, and only then look at the provider's own delivery-level tooling, which is often the only place a "provider accepted it, but delivery still failed downstream" story becomes visible at all.
