> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Validation Strategies

Every backend has a moment where it stops trusting the network and starts trusting its own code. Before that moment, a request body is just JSON someone typed into `curl` or a browser dev tools tab — it can contain anything: the wrong types, missing fields, a 40,000-character "name," a `role` field the client has no business setting. After that moment, the rest of the codebase — services, models, business logic — gets to assume the shape it expects is the shape it got. Input validation *is* that moment. It's the trust boundary between "the outside world" and "our system," and where you draw it, and how, shapes almost everything downstream: what a controller looks like, what a service function can assume about its arguments, and how much of your security posture rests on one gate versus many scattered checks.

This chapter is scoped narrowly on purpose. It does not cover what happens *after* a `ZodError` is thrown — the exact JSON shape returned to the client and the precedence order against Mongoose errors belongs to [`04-error-handling-patterns.md`](./04-error-handling-patterns.md)'s `errorHandler`. It does not cover what a controller does with *validated* data — handing it to a service function is [`06-services-and-business-logic-layer.md`](./06-services-and-business-logic-layer.md)'s territory. This file's job is the validation step itself: where it lives in the request pipeline, what library or technique enforces it, and what AstriX actually does — verified by reading every validation module and every controller that calls into one.

---

## 1. The Landscape

"Validate the input" is not one decision — it's at least two: **what** checks the shape (hand-written conditionals, or a schema library), and **where** in the request's journey that check runs (inside the handler, in front of it as middleware, or as a transformation step that produces a typed object before the handler ever sees raw JSON). Four approaches cover the vast majority of real backends.

### (a) Manual, inline checks — no schema library at all

The oldest and still most common starting point for small services: `if` statements against the raw body, right at the top of the handler.

```js
app.post("/users", (req, res) => {
  const { email, password } = req.body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password too short" });
  }
  // ... proceed
});
```

**Tradeoffs:** zero dependencies, and for two or three fields it's genuinely fine — there's no framework to learn and nothing to configure. It falls apart as soon as a request body grows past a handful of fields, or has any nesting, or needs cross-field rules ("confirmPassword must equal password"). Each new field is another `if` block that someone has to remember to write, and nothing enforces that the checks actually match the TypeScript type the rest of the code assumes — the check and the type drift independently, silently, and only a test (or a production bug) catches the gap.

### (b) A schema-validation library invoked directly inside the handler

Define the shape once, as a schema object, and call `.parse()`/`.validate()` on the raw input at the top of the route handler or controller. **Zod**, **Joi**, and **Yup** are the three real, widely-used libraries in this category for Node/TypeScript backends.

```ts
import { z } from "zod";

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

app.post("/users", (req, res) => {
  const body = createUserSchema.parse(req.body); // throws ZodError on failure
  // body is now typed as { email: string; password: string }
  // ...
});
```

Joi predates TypeScript-first tooling and is still extremely common in older Express codebases; it validates but doesn't generate a static type from the schema on its own. Yup grew up alongside Formik in the React ecosystem and is common when a team shares schemas between frontend form validation and a Node backend. Zod is the TypeScript-native entrant: schemas are also runtime-checkable TypeScript types via `z.infer<typeof schema>`, so the validated shape and the compile-time type are structurally the same object — they can't drift apart the way hand-written `if` checks and a hand-written `interface` can.

**Tradeoffs:** one call at the top of each handler gives you rich, composable validation (nested objects, arrays, unions, custom refinements) with a single source of truth for both the runtime check and the static type (for Zod specifically). The cost is that "did this endpoint validate its input" is a property of *that specific handler* — nothing forces every handler in the codebase to do it, and a reviewer has to check each one individually.

### (c) Validation as its own middleware layer

Instead of calling `.parse()` inside the handler, a generic `validate(schema)` middleware factory runs **before** the controller in the route's middleware chain. The controller function never touches `req.body` directly — by the time it runs, the framework guarantees the body already matches the schema.

```ts
const validate = (schema: z.ZodSchema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return next(result.error);
  req.body = result.data;
  next();
};

router.post("/users", validate(createUserSchema), (req, res) => {
  // req.body is guaranteed valid here - the controller trusts it unconditionally
});
```

This is the dominant pattern in larger Express codebases and is essentially how `express-validator` (a popular dedicated library) is used out of the box — validation rules attached as middleware in the route definition, with a final `next()`-based check.

**Tradeoffs:** every route that mounts the middleware is *guaranteed* validated — you can audit trust boundaries by reading route files instead of every controller body, and validation logic is consistently structured across the whole codebase (DRY: the "run schema, format errors, short-circuit" plumbing is written once). The cost is a layer of indirection: to know what a specific endpoint actually requires, you now have to read two files — the route file (which schema is attached) and the controller (what it does with the result) — instead of one self-contained function.

### (d) Class-based DTOs with decorator-driven validation

Common in more heavily-typed, more opinionated frameworks — **NestJS** is the canonical example. The request body is deserialized into an instance of a TypeScript class, and validation rules are attached as decorators directly on that class's properties, using **`class-validator`** (rule decorators) alongside **`class-transformer`** (raw-JSON-to-class-instance transformation).

```ts
class CreateUserDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;
}

@Post("users")
createUser(@Body() dto: CreateUserDto) {
  // NestJS's global ValidationPipe already ran class-validator against `dto`
  // before this method body executes - an invalid request never reaches it.
}
```

**Tradeoffs:** this integrates tightly with the rest of a decorator-based framework — the same `CreateUserDto` class can drive OpenAPI/Swagger generation (via `@nestjs/swagger` decorators layered on the same class), dependency injection, and serialization, all from one annotated definition. The cost is commitment: this pattern is only natural inside a framework built around decorators and classes (NestJS, or similar). Retrofitting it onto a plain Express app means adopting `reflect-metadata`, decorators, and a DI container just to get validation — a much bigger structural change than dropping in Zod.

---

## 2. AstriX's Choice

AstriX uses **(b): Zod schemas, invoked directly and inline inside each controller** — never as separate middleware, never as decorator-annotated DTOs. Every domain that accepts external input (`auth`, `project`, `task`, `user`, `workspace`) has its own module under `backend/src/validation/` exporting a set of Zod schemas, and every controller that needs one imports it and calls `.parse()` on `req.body`, `req.params`, or `req.query` as the very first thing it does with that input — confirmed by grepping the whole `controllers/` tree for `.parse(`, which turns up 40+ call sites and zero uses of `.safeParse(` or any dedicated validation middleware anywhere in `backend/src`.

---

## 3. AstriX Implementation

### 3.1 Field-level building blocks, composed per domain

AstriX's validation modules don't validate the request body's shape as one monolithic blob written out by hand each time. They define small, reusable field-level schemas once, then compose them into the top-level `z.object()` schemas each controller calls. Here's the full `auth` module:

```ts
// backend/src/validation/auth.validation.ts:1-40
import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .email("Invalid email address")
  .min(1)
  .max(255);

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must contain at least one special character (!@#$%^&*)"
  );

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(50, "Name must be at most 50 characters");

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
```

`emailSchema` and `passwordSchema` aren't special to registration — `loginSchema` reuses both verbatim. This is the reuse pattern AstriX actually uses throughout: shared *field*-level schemas, assembled into different *object*-level schemas per endpoint. It's worth being precise here — this is not the same thing as deriving `updateXSchema` from `createXSchema` via Zod's `.pick()`/`.partial()`; AstriX doesn't do that anywhere in the codebase. `project.validation.ts` shows the same field-composition pattern for a different domain, and its comments document a real bug that composition fixed:

```ts
// backend/src/validation/project.validation.ts:1-31
import { z } from "zod";

export const emojiSchema = z.string().trim().optional();
export const nameSchema = z.string().trim().min(1).max(255);
export const descriptionSchema = z.string().trim().optional();

export const projectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, { message: "Invalid project ID" });

export const createProjectSchema = z.object({
  emoji: emojiSchema,
  name: nameSchema,
  description: descriptionSchema,
});

export const updateProjectSchema = z.object({
  emoji: emojiSchema,
  name: nameSchema,
  description: descriptionSchema,
});

// Query params bypassed Zod entirely before (hand-parsed via parseInt(...)
// || default in the controller) - unlike every request body in this
// codebase. This also caps pageSize, which was previously unbounded (a
// client could request pageSize=999999 and get the whole collection).
export const paginationQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  pageNumber: z.coerce.number().int().min(1).optional().default(1),
});
```

Two things worth noting honestly. First, `createProjectSchema` and `updateProjectSchema` are structurally *identical* — both require `name`, both accept optional `emoji`/`description`. There's no `.partial()` making `updateProjectSchema`'s fields optional for a "only send what changed" PATCH-style update; a client calling the update endpoint must resend `name` even if only `description` changed. Second, `paginationQuerySchema` uses `z.coerce.number()` rather than plain `z.number()` — `req.query` values arrive as strings (`?pageSize=20`, not `?pageSize=20` typed as a number), so `z.coerce` is doing real work here: converting the string to a number *before* the `.int().min(1).max(100)` checks run against it, and `.optional().default(10)` supplies a value when the query param is absent at all.

### 3.2 A param-only schema, reused across every controller that touches a workspace

`workspaceIdSchema` is the clearest example of a schema reused across domain boundaries — it's defined once in `workspace.validation.ts` and imported into `project.controller.ts`, `task.controller.ts`, and `workspace.controller.ts` itself, anywhere a route has a `:workspaceId` or `:id` path segment that's actually a workspace id:

```ts
// backend/src/validation/workspace.validation.ts:1-45
import { z } from "zod";

export const nameSchema = z
  .string()
  .trim()
  .min(1, { message: "Name is required" })
  .max(255);

export const descriptionSchema = z.string().trim().optional();

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const workspaceIdSchema = z
  .string()
  .trim()
  .regex(objectIdRegex, { message: "Invalid workspace ID" });

// Identifies the targeted USER, not the Member document that joins them to
// the workspace - every consumer resolves it as
// `MemberModel.findOne({ userId, workspaceId })`.
export const userIdSchema = z
  .string()
  .trim()
  .regex(objectIdRegex, { message: "Invalid user ID" });

export const changeRoleSchema = z.object({
  roleId: z
    .string()
    .trim()
    .regex(objectIdRegex, { message: "Invalid role ID" }),
  // The request-body key stays `memberId` because it's a published wire
  // contract the deployed client still sends. The value is a user id (see
  // userIdSchema above); everything downstream of this parse names it so.
  memberId: userIdSchema,
});

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
});

export const updateWorkspaceSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
});
```

`changeRoleSchema` is a good example of validation absorbing a real naming mismatch: the wire contract's `memberId` field actually carries a *user* id, not a member-document id, and the schema documents that explicitly (`memberId: userIdSchema`) rather than silently renaming it and breaking deployed clients.

Here's `workspaceIdSchema` in use across two different controllers, on both `req.params.workspaceId` and `req.params.id` depending on the route's own path convention:

```ts
// backend/src/controllers/project.controller.ts:23-32
export const createProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = createProjectSchema.parse(req.body);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const userId = req.user!._id.toString();
    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.CREATE_PROJECT]);

    const { project } = await createProjectService(userId, workspaceId, body);
```

```ts
// backend/src/controllers/workspace.controller.ts:108-119
export const changeWorkspaceMemberRoleController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    // `memberId` is the request-body key (see changeRoleSchema); the value
    // it carries is the targeted user's id.
    const { memberId: targetUserId, roleId } = changeRoleSchema.parse(req.body);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.CHANGE_MEMBER_ROLE]);
```

The pattern in both: `.parse()` runs first, before any authorization check (`getMemberRoleInWorkspace`, `roleGuard`) and before any service call. A malformed id or body never reaches the authorization logic at all.

### 3.3 Cross-field validation with `.refine()`

Zod's `.object()` alone can only validate fields independently. Rules that compare two fields to each other — "these two passwords must match" — need `.refine()`, a function attached after the object schema that receives the *entire* parsed object and returns `true`/`false`:

```ts
// backend/src/validation/auth.validation.ts:50-59
export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, "Reset token is required"),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
```

```ts
// backend/src/validation/auth.validation.ts:73-82
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: passwordSchema,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords do not match",
    path: ["confirmNewPassword"],
  });
```

The `path: ["confirmPassword"]` option is what makes the resulting Zod error attribute the failure to the `confirmPassword` field specifically, rather than to the object as a whole — it controls the `field` value the `errorHandler`'s Zod-formatting branch later reads (see [`04-error-handling-patterns.md`](./04-error-handling-patterns.md)).

`user.validation.ts` uses the same `.refine()` mechanism for a different kind of cross-field rule — not "two fields must match," but "at least one field must be present":

```ts
// backend/src/validation/user.validation.ts:1-17
import { z } from "zod";

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(50).optional(),
    profilePicture: z.string().trim().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field (name, profilePicture) must be provided",
  });

// `password` is optional here (validated at the SERVICE layer against
// whether the account actually has one - OAuth-only accounts don't) rather
// than being required at the schema level.
export const deleteAccountSchema = z.object({
  password: z.string().min(1).optional(),
});
```

This is genuinely a partial-update schema — both fields are `.optional()` — but note it's still hand-written that way rather than derived from a hypothetical `createProfileSchema` via `.partial()`; there's no full-profile-creation schema to derive it from in the first place, since a profile is created as a side effect of registration, not through this endpoint. `deleteAccountSchema`'s comment also documents a decision worth calling out: `password` is optional *at the schema level* on purpose, because whether it's actually required depends on data Zod can't see (does this specific account have a password at all, or is it OAuth-only) — that check is deferred to the service layer, which is the right layer for it since it needs a database read to answer.

### 3.4 `.transform()` for comma-separated query strings

`task.validation.ts` has the most structurally distinct schema in the codebase: a higher-order function that builds a schema accepting a comma-separated query string and turning it into an array, validating each element against an enum:

```ts
// backend/src/validation/task.validation.ts:1,60-97
import { z } from "zod";
import { TaskPriorityEnum, TaskStatusEnum } from "../enums/task.enum";

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

// Query params bypassed Zod entirely before (hand-parsed in the controller
// via parseInt(...) || default and ad-hoc .split(",")) - unlike every
// request body in this codebase. This also caps pageSize, which was
// previously unbounded.
export const paginationQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  pageNumber: z.coerce.number().int().min(1).optional().default(1),
});

const commaSeparatedEnum = (allowedValues: readonly string[]) =>
  z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined))
    .refine((arr) => !arr || arr.every((v) => allowedValues.includes(v)), {
      message: `Must be a comma-separated list of: ${allowedValues.join(", ")}`,
    });

export const taskFiltersQuerySchema = z.object({
  projectId: z
    .string()
    .trim()
    .regex(objectIdRegex, { message: "Invalid projectId" })
    .optional(),
  status: commaSeparatedEnum(Object.values(TaskStatusEnum)),
  priority: commaSeparatedEnum(Object.values(TaskPriorityEnum)),
  assignedTo: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined))
    .refine((arr) => !arr || arr.every((v) => objectIdRegex.test(v)), {
      message: "assignedTo must be a comma-separated list of valid ids",
    }),
  keyword: z.string().trim().max(100).optional(),
  dueDate: dueDateSchema,
});
```

`?status=TODO,IN_PROGRESS` arrives as the single string `"TODO,IN_PROGRESS"` — `.transform()` runs *after* the preceding checks pass, turning the validated string into an array, and the following `.refine()` then validates every element of that array against `TaskStatusEnum`'s actual values (`BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`). `commaSeparatedEnum` is called twice with two different enums (`TaskStatusEnum`, `TaskPriorityEnum`) — a small schema factory, not a single hard-coded schema, so the same split-then-validate logic isn't duplicated per filter field.

### 3.5 Controller invocation: multiple `.parse()` calls per handler

A controller frequently calls `.parse()` more than once — once per input source (`params`, `query`, `body`) that endpoint actually receives, each against its own schema:

```ts
// backend/src/controllers/task.controller.ts:76-95
export const getAllTasksController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id.toString();

    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const filters = taskFiltersQuerySchema.parse(req.query);
    const pagination = paginationQuerySchema.parse(req.query);

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const result = await getAllTasksService(workspaceId, filters, pagination);

    return res.status(HTTPSTATUS.OK).json({
      message: "All tasks fetched successfully",
      ...result,
    });
  }
);
```

Note `req.query` is parsed twice here, against two separate schemas (`taskFiltersQuerySchema`, `paginationQuerySchema`) — both read from the same query-string object, each pulling out and validating only the keys it cares about; Zod's default object behavior (see §6) means each `.parse()` call silently ignores whatever keys belong to the *other* schema rather than rejecting the request for "unexpected" keys.

And the full register flow, showing the very first line of the handler doing the validation before anything else happens:

```ts
// backend/src/controllers/auth.controller.ts:60-70
export const registerUserController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = registerSchema.parse(req.body);
    const result = await registerUserService(body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "User created successfully",
      userId: result.userId,
    });
  }
);
```

```ts
// backend/src/controllers/auth.controller.ts:266-277
export const resetPasswordController = asyncHandler(
  async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body);

    await resetPasswordService(token, password);

    return res.status(HTTPSTATUS.OK).json({
      message:
        "Password reset successfully. Please log in with your new password.",
    });
  }
);
```

---

## 4. Request/Data Flow

Trace a real failure: a client calls `POST /api/auth/register` with `{ "name": "Al", "email": "not-an-email", "password": "short" }`.

1. The request passes through `index.ts`'s middleware stack (`helmet`, `pinoHttp`, `express.json()`, `cookieParser`, `cors`, the rate limiter) and matches `app.use(`${BASE_PATH}/auth`, authRoutes)` — `authRoutes` has no blanket `authenticate` middleware, so an unauthenticated registration request reaches the route.
2. The route maps `POST /register` to `registerUserController`, which is wrapped in `asyncHandler` (`backend/src/middlewares/asyncHandler.middleware.ts:13-21`) — this wrapper is what makes the next step safe to write as a plain synchronous-looking `throw`.
3. Inside the controller, `registerSchema.parse(req.body)` runs (`backend/src/controllers/auth.controller.ts:62`). Zod checks every field: `email` fails `.email("Invalid email address")` because `"not-an-email"` has no `@`; `password` fails all four `.regex()` checks because `"short"` has no uppercase letter, no digit, and no special character (it does satisfy `.min(8)`... actually it doesn't, `"short"` is 5 characters, so it also fails `.min(8, "Password must be at least 8 characters")`). Zod does not stop at the first failing field — `.parse()` collects every issue across the whole object into one `ZodError`, so the client hears about the email problem and every failing password rule in a single response, not one-at-a-time.
4. `.parse()` **throws** that `ZodError` synchronously, inside the `async` controller function. Because the controller is `async`, that synchronous throw is automatically converted into a rejected Promise — which is exactly what `asyncHandler`'s `try { await controller(...) } catch (error) { next(error) }` is written to catch. `next(error)` hands the `ZodError` to Express's error-handling pipeline.
5. Express routes any error passed to `next()` to the first error-handling middleware in the stack, which — per `index.ts`'s mount order — is `errorHandler` (`backend/src/middlewares/errorHandles.middleware.ts`).
6. `errorHandler` checks its branches in order (`SyntaxError`, oversized-body, then `ZodError`) and hits `if (error instanceof ZodError) { return formatZodError(res, error); }`. The exact shape of that response — a 400 with a `{ message, errors: [{ field, message }], errorCode }` body — is `errorHandler`'s own contract; see [`04-error-handling-patterns.md`](./04-error-handling-patterns.md) for how it maps `error.issues` into that array and how it's ordered against Mongoose's own validation-error branches. This file's job stops at the throw — everything from step 6 onward is owned by that chapter.

The controller code between the `.parse()` line and the response — `registerUserService`, session creation, cookie-setting — never executes. Nothing downstream of `.parse()` ever sees `"not-an-email"` or `"short"`; the trust boundary held at the first line of the handler.

---

## 5. Design Decisions & Tradeoffs

**Why Zod, specifically, over Joi/Yup/class-validator.** Zod's headline advantage over Joi and Yup is that a schema *is* a TypeScript type generator, not just a runtime checker — `z.infer<typeof schema>` derives a static type from the schema definition itself, so the compile-time type and the runtime check can never silently drift apart the way a hand-maintained `interface CreateUserInput { ... }` sitting next to a hand-maintained Joi schema can. AstriX actually uses this: `RegisterInput` and `LoginInput` in `auth.validation.ts` (`z.infer<typeof registerSchema>`, `z.infer<typeof loginSchema>`) are both derived types, not hand-written interfaces. It's worth being honest that this is currently a narrow slice of the codebase — most other schemas (`createProjectSchema`, `createTaskSchema`, `createWorkspaceSchema`, and so on) are consumed directly as the return value of `.parse()` (which is already correctly typed by TypeScript's inference through the call, without needing an explicit `z.infer<>` alias) rather than having an explicitly named, exported `z.infer<>` type — the mechanism is used, but not woven all the way through every domain as a named, reusable type. class-validator was never a realistic option here without adopting NestJS itself (its decorator-based validation is designed to run inside NestJS's `ValidationPipe`, not as a standalone library bolted onto a plain Express app), so the real decision was Zod vs. Joi vs. Yup, and TypeScript-first inference is what tipped it.

**Why inline-in-controller instead of a dedicated validation middleware.** This is the more consequential architectural choice, and it's worth stating the actual cost, not just the benefit. The cost: nothing *structurally* guarantees a controller calls `.parse()` at all — it's a convention, enforced by consistency and code review, not by the framework. Compare this to option (c) from the Landscape: with a `validate(schema)` middleware mounted in the route definition, an unvalidated route is visible by scanning route files for a missing `validate(...)` call; with AstriX's inline approach, you have to open every controller function and check. The benefit AstriX is trading for that risk: a controller function is a **complete, self-contained description of what its endpoint requires** — reading `createProjectController` top to bottom tells you the exact body shape, the exact param shape, the authorization check, and the service call, all in one place, with no need to cross-reference a separate route file to find out which schema applies. For a codebase this size (six controller files, roughly 40 `.parse()` call sites total), that self-containment reads as a deliberate, defensible tradeoff rather than an oversight — but it is a real tradeoff, not a free win, and it scales worse than middleware-based validation as the number of routes grows, because the "did every route remember to validate" audit gets linearly more expensive to perform by hand.

**What AstriX gave up from the alternatives.** No shared "attach a schema in the route file" plumbing means each controller repeats the same three-line shape (`const body = xSchema.parse(req.body)`) rather than that logic living once in a middleware factory — a small amount of duplication traded for locality. No DTO/decorator layer means no automatic OpenAPI generation from the validation schemas themselves; AstriX's Swagger setup (`config/swagger.config.ts`, covered in [`09`](./09-api-design-and-external-providers.md)) is maintained as a separate artifact from the Zod schemas, not derived from them — a class-validator + `@nestjs/swagger` setup would keep those two in sync automatically.

---

## 6. Security Considerations

Input validation is the **primary trust boundary** for all user-controlled data in AstriX's architecture. There is no separate sanitization layer, no DTO-mapping step, and no dedicated validation middleware sitting in front of every route — the Zod `.parse()` call inside each controller *is* the entire boundary between "attacker-controlled JSON" and "data the rest of the system treats as safe to act on." That makes it worth being precise about exactly what that boundary does and doesn't guarantee.

**Unknown-key stripping (mass assignment).** Zod's `.object()` has three modes for keys not declared in the schema: strip them silently (the default), reject the whole object (`.strict()`), or pass them through untouched (`.passthrough()`). A grep across every file in `backend/src/validation/` and every `.ts` file in `backend/src` for `.passthrough(` returns zero matches — every schema in AstriX uses the default, strip-unknown-keys behavior. Concretely: if a client sends `{ "name": "Sprint 1", "description": "...", "role": "admin", "createdBy": "<someone-else's-id>" }` to the create-project endpoint, `createProjectSchema.parse(req.body)` returns only `{ name, emoji, description }` — `role` and `createdBy` are silently dropped before the controller ever sees them, regardless of whether the client included them. This is the single biggest reason AstriX doesn't need a separate anti-mass-assignment layer: the schema *is* the allowlist. It's also why the `...body` spread seen in `task.service.ts` (`TaskModel.findByIdAndUpdate(taskId, { ...body }, { new: true })`, where `body` is `updateTaskSchema.parse(req.body)`'s already-validated, already-stripped return value) is safe from a client injecting arbitrary extra fields into that Mongoose write — it's spreading Zod's output, not the raw request body.

**Every mutating route sweep — reported honestly.** Reading every controller file confirms Zod validation runs on every route that accepts a `req.body`, `req.params`, or `req.query` value derived from user input across `auth`, `user`, `project`, `task`, and `workspace` — with two genuine exceptions worth naming rather than glossing over:
- `googleCallbackController` (`backend/src/controllers/auth.controller.ts:101-137`) reads `req.query.code` and `req.query.state` with a manual `if (!code || !state) throw new BadRequestException(...)` check, not a Zod schema — this is OAuth-callback input coming from Google's redirect, a genuinely different source than a client-authored JSON body, but it is still externally-controlled input reaching the handler without going through the same schema-based gate as everything else. The `state` value is separately checked against a `google_oauth_state` cookie for CSRF protection (a concern owned by [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md)), which is the check that actually matters for that field — but the "no schema, hand-rolled `if`" pattern is exactly approach (a) from the Landscape section, coexisting with approach (b) everywhere else in the codebase.
- `joinWorkspaceController` (`backend/src/controllers/member.controller.ts:7-23`) validates its one input with `z.string().parse(req.params.inviteCode)` — a genuine Zod schema, so the input *is* validated, but it's an ad-hoc inline `z.string()` rather than a named schema exported from a `validation/*.ts` module the way every other controller does it. It's a minor deviation from the module-per-domain convention, not a missing validation gap.

Neither of these is a dramatic finding — the first still has a real check (just not Zod-shaped, and backstopped by the CSRF cookie check), and the second still validates (just not through the usual named-schema convention) — but a curriculum built on "read the actual code" should surface both rather than claiming perfect uniformity where the sweep didn't find it.

**What validation does not protect against.** A Zod schema checks shape, type, and the constraints written into it — it says nothing about *authorization*. `projectIdSchema.parse(req.params.id)` confirms the string looks like a MongoDB ObjectId; it says nothing about whether the caller is allowed to touch *that specific* project. That's why every controller above calls `getMemberRoleInWorkspace` and `roleGuard` **after** the `.parse()` calls, not instead of them — validation and authorization are two different gates, and AstriX runs them in that order (shape first, permission second) consistently. Similarly, `.regex(/^[0-9a-fA-F]{24}$/)` checks on id fields exist specifically so a malformed id fails fast with a clean 400 from Zod, rather than reaching Mongoose and surfacing as a `CastError` — both are caught by `errorHandler` eventually, but the Zod path is intentional and first in line.

---

## 7. Best Practice Check

As of 2026, Zod's position in the TypeScript backend ecosystem has shifted from "a good choice" to close to the mainstream default — its adoption curve, the amount of tooling built directly against `z.infer<>` (form libraries, API-schema generators, tRPC's entire type-safety model), and its now-stable v4 API make it a safe, unremarkable choice rather than a bet. AstriX picking Zod isn't a dated-but-reasonable decision the way an older codebase choosing Joi in 2018 would read today — it's squarely in line with where a new TypeScript backend would land if started today.

The inline-vs-middleware question is a genuinely live debate, and AstriX's choice is defensible but not the only reasonable answer. The DRY/consistency argument for middleware-based validation is real: a `validate(schema)` factory means the "run the schema, format the error, short-circuit the request" plumbing is written exactly once, route files become an audit-friendly index of what's validated, and it's structurally impossible to add a new mutating route and forget validation, because the route simply doesn't work without a `validate(...)` call wired in. The counter-argument AstriX is implicitly making — "everything this endpoint needs is visible in one function" — is also real and increasingly common in codebases that prioritize local reasoning over DRY: it optimizes for a single engineer reading one file top-to-bottom over a large team auditing route tables. Neither is objectively "more 2026" than the other; they're optimizing for different failure modes (a forgotten `validate()` call vs. a `.parse()` a future editor deletes without noticing while refactoring a controller). Given AstriX's current size — six controller files, no framework enforcing either pattern — inline is a reasonable fit; it would be worth revisiting toward middleware-based validation if the controller count or team size grew enough that a manual "did every route validate" audit stopped being practical.

One place AstriX is behind current practice: `createProjectSchema`/`updateProjectSchema` and `createTaskSchema`/`updateTaskSchema` are hand-duplicated pairs rather than one being derived from the other via `.partial()` or `.pick()`. A 2026-idiomatic Zod codebase would more often write `const updateProjectSchema = createProjectSchema.partial()` (making every field independently optional for a real partial-update semantic) rather than maintaining two structurally-identical `z.object()` literals that both require `name` — this is a small maintainability gap, not a correctness bug, since both schemas currently do validate correctly for what each endpoint actually expects.

---

## 8. Debug Drill

**Scenario:** A client reports that a field they included in a request body "doesn't seem to save" — the request returns 200/201 with no error, but the field is missing (or unchanged) in the resource that comes back. This is a generic, transferable failure mode for any Zod-validated backend, not specific to any one AstriX endpoint — walk through it the way you'd debug it in an unfamiliar codebase.

1. **Check the field name for a typo or a stale wire contract first.** Compare the exact key the client is sending against the schema's declared keys. Zod's default behavior (§6) silently strips unrecognized keys rather than erroring — a client sending `discription` instead of `description`, or an old field name after a rename, produces a *successful* response with that field simply absent from the parsed output, and no error anywhere in the chain tells you why. This is the single most common cause of "the field seems to silently not save," and it's invisible unless you know to check for it, because nothing failed loudly.
2. **Find the schema and read exactly what it declares and requires.** Locate the `validation/*.ts` module for that domain and find the specific `z.object()` the endpoint calls `.parse()` against. Confirm the field is actually declared there — and check whether it's required or `.optional()`. A field silently absent from the schema entirely behaves identically to a typo from the client's perspective: accepted, ignored, stripped.
3. **Trace what the controller does with the parsed result, not the raw body.** Find the `.parse()` call site in the controller and follow its return value forward. Is the whole parsed object passed to the service (`{ ...body }`), or are individual fields destructured and passed positionally (as `updateProjectService` does — `const { name, emoji, description } = body`)? A service function that destructures specific fields will silently drop any field the schema *did* validate but the service function forgot to pass through — this is a bug downstream of validation, not in it, and the way to rule it in or out is checking whether the field survives the controller→service handoff at all.
4. **Only after 1–3, suspect the schema's own constraints.** Check `.trim()`, `.min()`/`.max()`, `.optional()` vs. required, and any `.refine()`/`.transform()` attached to that field — a value that technically satisfies the client's intent but fails a constraint (e.g. a `.trim()`'d empty string failing `.min(1)`) throws a `ZodError`, which is loud and would show up as a 400, not a silent no-op — so this step explains a *rejected* request, not a silently-ignored field, and is where you look once you've confirmed the request is actually failing rather than silently succeeding.

The general lesson: a silently-missing field almost always means it never made it *into* the parsed object in the first place (Zod stripped it, or it was never declared) rather than a validation rule silently discarding a value it received — Zod either keeps a field or throws, it does not "validate and then drop" a value that made it through a schema's checks.
