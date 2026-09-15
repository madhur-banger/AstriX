# Phase 4 — NestJS + Clean/Onion Architecture

> Part of the [migrations/](./PLAN.md) series. Assumes Phases
> [2](./phase-2-orm-setup-and-service-migration.md) and
> [3](./phase-3-redis-migration-and-ttl-data.md) are done — plain-function
> Postgres and Redis services already exist and are verified. This file:
> the theory of clean/onion architecture, how NestJS's DI container
> implements it, and restructuring the existing `src/routes → controllers →
> services → models` layering into it, module by module.

This phase is architectural, not just a framework swap. The goal stated
upfront was to "deepen understanding of how production apps are graded" —
this is the phase that actually does that, because NestJS *forces* you to
make dependency direction explicit, where Express lets you get away with
services importing Mongoose models directly (which is exactly what every
current `services/*.ts` file does).

---

## 4.1 Theory: what "clean architecture" / "onion architecture" actually mean

Both names (Robert Martin's Clean Architecture, Jeffrey Palermo's Onion
Architecture — nearly identical in practice) describe the same core rule:

> **Dependencies point inward, toward the domain. The domain never depends
> on infrastructure.**

Picture it as concentric rings:

```
┌─────────────────────────────────────────────┐
│  Infrastructure (Postgres, Redis, Express)   │  outermost - can change freely
│  ┌─────────────────────────────────────────┐ │
│  │  Application (use cases / services)      │ │
│  │  ┌─────────────────────────────────────┐ │ │
│  │  │  Domain (entities, business rules)   │ │ │  innermost - stable, framework-free
│  │  └─────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**The rule that matters in practice:** the domain/application layers depend
on *interfaces* (e.g. `TaskRepository`), never on concrete infrastructure
(e.g. `DrizzleTaskRepository`, `TaskModel` from Mongoose). Infrastructure
implements those interfaces and is *injected* into the layers that need
them — this is **Dependency Inversion**, the "D" in SOLID, and it's the
actual mechanism that makes "swap Mongo for Postgres" a contained,
bounded change instead of a rewrite. Notice something important: **this
entire multi-phase migration would have been a smaller diff if this
codebase had been built with this boundary from day one** — every
`services/*.ts` file imports a Mongoose model directly
(`import TaskModel from "../models/task.model"`), meaning the "business
logic" (task filtering rules, assignment validation) and "which database"
are welded together. That coupling is *why* Phase 2 required touching every
service file. This phase's job is to make sure that never has to happen
again.

### Why this codebase's current layering is *not* clean architecture, precisely

`src/controllers → src/services → src/models` looks layered, and it is — but
layering alone isn't the same claim as clean architecture. The test:
**does the service layer depend on Mongoose (infrastructure), or on an
abstraction?** Today, directly on Mongoose — `task.service.ts` imports
`TaskModel` and calls `.find()`, `.aggregate()`, `.populate()` straight from
business logic. That's a **layered architecture**, not an **onion
architecture** — the inner layer (business rules: "a task can only be
assigned to a workspace member," `assertAssigneeIsWorkspaceMember`) is
directly coupled to the outer layer (Mongoose). Onion/clean architecture's
extra rule — dependencies point inward, never outward — is what NestJS's DI
container makes structurally easy to enforce and structurally *awkward* to
violate.

---

## 4.2 Theory: NestJS's DI container, precisely

NestJS's core primitive is the **Injectable** + **Module** pair, built on
TypeScript decorators and reflection metadata. The mental model, if you've
never used a DI container before:

- A **provider** (`@Injectable()`) is any class Nest can construct and hand
  to something else that needs it.
- A **module** (`@Module({...})`) declares which providers exist in its
  scope, which providers it exports for other modules to use, and which
  controllers live in it.
- **Constructor injection**: a class declares what it needs as constructor
  parameters, typed by interface or class; Nest's container resolves and
  instantiates the dependency graph at app startup, and hands each class its
  dependencies automatically — you never call `new TaskService(...)`
  yourself anywhere in application code.

```ts
// The abstraction the domain/application layer depends on:
export abstract class TaskRepository {
  abstract findById(id: string): Promise<Task | null>;
  abstract findAllForWorkspace(workspaceId: string, filters: TaskFilters): Promise<Task[]>;
  abstract create(data: CreateTaskData): Promise<Task>;
}

// The concrete Postgres implementation - infrastructure, outermost ring:
@Injectable()
export class DrizzleTaskRepository implements TaskRepository {
  async findById(id: string): Promise<Task | null> { /* Drizzle query from Phase 2 */ }
  // ...
}

// The application-layer service - depends on the ABSTRACTION, never on Drizzle directly:
@Injectable()
export class TaskService {
  constructor(private readonly taskRepository: TaskRepository) {}

  async getTask(id: string): Promise<Task> {
    const task = await this.taskRepository.findById(id);
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }
}
```

The wiring — telling Nest "when something asks for `TaskRepository`, give it
a `DrizzleTaskRepository`" — happens once, in the module definition:

```ts
@Module({
  providers: [
    TaskService,
    { provide: TaskRepository, useClass: DrizzleTaskRepository },
  ],
  controllers: [TaskController],
  exports: [TaskService],
})
export class TaskModule {}
```

**This one line (`{ provide: TaskRepository, useClass: DrizzleTaskRepository }`)
is the entire point of this phase.** Swapping databases later (or, more
realistically, writing a test) means changing this one binding —
`{ provide: TaskRepository, useClass: InMemoryTaskRepository }` — and
nothing in `TaskService` or `TaskController` changes at all, because they
never knew which implementation they were talking to.

---

## 4.3 The layer-by-layer structure this app will use

Map each existing concept onto its clean-architecture ring:

| Ring | This app's folder | Contains | Depends on |
|---|---|---|---|
| **Domain** | `src/domain/<feature>/` | Plain TS types/entities (`Task`, `Project`), pure business-rule functions with no I/O (e.g. "is this status transition valid") | Nothing — zero imports from Nest, Drizzle, or Redis |
| **Application** | `src/application/<feature>/` | `*.service.ts` (use cases), repository **interfaces** (abstract classes) | Domain only |
| **Infrastructure** | `src/infrastructure/persistence/postgres/`, `src/infrastructure/persistence/redis/` | Repository **implementations** (Drizzle queries from Phase 2, Redis calls from Phase 3) | Application's interfaces (implements them), Drizzle/ioredis directly |
| **Interface/Presentation** | `src/presentation/<feature>/` | `*.controller.ts`, DTOs, request validation (Zod schemas — these stay, Nest has a `ZodValidationPipe` pattern, no need to switch to `class-validator`) | Application layer only |

This directly answers "feature-based clean architecture" — each feature
(`task`, `project`, `workspace`, `user`, `auth`) gets its own vertical slice
across all four rings, rather than the current horizontal-only split
(`controllers/`, `services/`, `models/` each containing every feature mixed
together).

```
src/
  domain/
    task/task.entity.ts
    task/task.rules.ts          # pure functions: canTransitionStatus(from, to), etc.
  application/
    task/task.service.ts        # use cases: createTask, getTask, listTasks
    task/task.repository.ts     # abstract class - the interface
  infrastructure/
    persistence/postgres/task.repository.impl.ts   # implements TaskRepository via Drizzle
    persistence/redis/session.repository.impl.ts   # implements SessionRepository via ioredis
  presentation/
    task/task.controller.ts
    task/dto/create-task.dto.ts
  task.module.ts                # wires the above four together for this feature
```

---

## 4.4 Migrating one feature end-to-end: `task`

Do this one feature fully, as the template, before touching the rest —
exactly the same "do one thing end-to-end before repeating" discipline as
every earlier phase.

**Step 1 — Domain** (`src/domain/task/task.entity.ts`):

```ts
export interface Task {
  id: string;
  taskCode: string;
  title: string;
  description: string | null;
  projectId: string;
  workspaceId: string;
  status: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH";
  assignedTo: string | null;
  createdBy: string;
  dueDate: Date | null;
}
```

**Step 2 — Application** (`src/application/task/task.repository.ts` — the
interface only):

```ts
export abstract class TaskRepository {
  abstract findById(id: string): Promise<Task | null>;
  abstract findMany(workspaceId: string, filters: TaskFilters, pagination: Pagination): Promise<{ tasks: Task[]; totalCount: number }>;
  abstract create(data: Omit<Task, "id" | "taskCode">): Promise<Task>;
  abstract getAnalytics(projectId: string): Promise<{ totalTasks: number; overdueTasks: number; completedTasks: number }>;
}
```

`src/application/task/task.service.ts` (the use cases — this is where
`assertAssigneeIsWorkspaceMember`'s business rule from
`task.service.ts:16-30` belongs now, as **application logic that
orchestrates two repositories**, not baked into a single Mongoose call
chain):

```ts
@Injectable()
export class TaskService {
  constructor(
    private readonly taskRepository: TaskRepository,
    private readonly memberRepository: WorkspaceMemberRepository, // from the workspace feature
  ) {}

  async createTask(workspaceId: string, projectId: string, userId: string, data: CreateTaskInput): Promise<Task> {
    if (data.assignedTo) {
      const isMember = await this.memberRepository.isMember(workspaceId, data.assignedTo);
      if (!isMember) throw new BadRequestException("Assigned user is not a member of this workspace");
    }
    return this.taskRepository.create({ ...data, workspaceId, projectId, createdBy: userId });
  }
}
```

Notice this service has **zero imports from Drizzle, `pg`, or any SQL** —
it only knows about `TaskRepository` and `WorkspaceMemberRepository` as
interfaces. This is the concrete, checkable test of whether you've actually
achieved the dependency-inversion rule from §4.1: **grep this file for
`drizzle` or `pg` — it must return nothing.**

**Step 3 — Infrastructure** (`src/infrastructure/persistence/postgres/task.repository.impl.ts`):

```ts
@Injectable()
export class DrizzleTaskRepository implements TaskRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<Task | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row ? this.toDomain(row) : null;
  }

  async getAnalytics(projectId: string) {
    // exact query from Phase 2 §2.7
  }

  private toDomain(row: typeof tasks.$inferSelect): Task {
    return { id: row.id, taskCode: row.taskCode, /* ...map snake_case DB row to domain Task */ };
  }
}
```

This file is almost entirely the Phase 2 service code, **relocated and
reshaped to implement an interface** rather than exported as loose
functions. `private toDomain(...)` matters: it's the mapping boundary
between the DB row shape and the domain entity shape — keeping them as
distinct types (even when they look identical today) is what lets the
domain layer stay untouched if the DB schema changes later (e.g. adding a
column Drizzle returns that the domain doesn't care about).

**Step 4 — Presentation** (`src/presentation/task/task.controller.ts`):

```ts
@Controller("workspaces/:workspaceId/projects/:projectId/tasks")
@UseGuards(AuthGuard, PermissionGuard)
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  @Post()
  @RequirePermission("CREATE_TASK")
  async create(@Param("workspaceId") workspaceId: string, @Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.taskService.createTask(workspaceId, projectId, user.id, dto);
  }
}
```

**`@RequirePermission("CREATE_TASK")` + `PermissionGuard`** is the NestJS
equivalent of this app's existing `middlewares/` RBAC check (the same
static `Permissions`/`RolePermissions` map from `utils/role-permission.ts`
— that map doesn't change, only *where* it's enforced does: a Nest `Guard`
is the idiomatic slot for "does this request have permission to reach the
handler," directly analogous to Express middleware but composable per-route
via decorators instead of `router.use()` chains).

**Step 5 — Wiring** (`src/task.module.ts`):

```ts
@Module({
  imports: [PersistenceModule], // exports DRIZZLE_CLIENT, REDIS_CLIENT
  controllers: [TaskController],
  providers: [
    TaskService,
    { provide: TaskRepository, useClass: DrizzleTaskRepository },
  ],
})
export class TaskModule {}
```

---

## 4.5 Where Redis-backed repositories fit the same pattern

Sessions (Phase 3) become `SessionRepository` (interface, in
`src/application/auth/`) implemented by `RedisSessionRepository`
(`src/infrastructure/persistence/redis/`) — **exactly the same shape** as
`TaskRepository`/`DrizzleTaskRepository`. This is the payoff of doing the
interface-first design correctly: `AuthService` depends on
`SessionRepository` as an abstraction and has no idea — and needs no idea —
that sessions live in Redis while tasks live in Postgres. Two entirely
different storage technologies, same architectural treatment, because the
application layer only ever sees interfaces.

---

## 4.6 Guards, Pipes, Interceptors — where the rest of the Express middleware chain goes

Quick map from what exists today to Nest's equivalents, since these are
genuinely different primitives, not just renamed:

| Current Express (`middlewares/`) | NestJS equivalent | Why the primitive differs |
|---|---|---|
| `authenticate.middleware.ts` (JWT check) | `AuthGuard` (`CanActivate`) | A Guard runs *before* the route handler and can short-circuit the request — same timing as Express middleware, but scoped per-route/controller via `@UseGuards()` instead of global `app.use()` or router-level mounting |
| RBAC permission check | `PermissionGuard` + a `@RequirePermission()` custom decorator reading route metadata | Nest's `Reflector` API lets a Guard read decorator metadata off the handler — this is how `@RequirePermission("CREATE_TASK")` becomes enforceable generically by one Guard, rather than every route hand-checking a permission string |
| Zod validation middleware | A `ZodValidationPipe` (community pattern, or write ~15 lines yourself) wrapping the existing Zod schemas from `validation/*.ts` — **those schemas do not need to be rewritten**, only the wrapper around them changes | A Pipe transforms/validates the request *into* the handler's parameters, run per-parameter (`@Body()`, `@Param()`) rather than as a separate middleware step |
| `errorHandler.middleware.ts` (centralized error → HTTP response mapping) | An `ExceptionFilter` (`@Catch()`) | Same job, different hook point — Nest intercepts thrown exceptions globally via a filter instead of Express's `(err, req, res, next)` 4-arg middleware convention |
| `rate-limiter.ts` (Phase 3, Redis-backed) | Applied as Express middleware still works unmodified (`app.use()`) since Nest runs on top of Express by default (`@nestjs/platform-express`) — no change needed here | Nest doesn't require you to reimplement every cross-cutting concern as a Guard/Pipe; middleware remains a valid, sometimes simpler choice for things with no per-route variation |

---

## 4.7 Test before considering this phase done

1. Repeat §4.4 for every remaining feature (`project`, `workspace`,
   `member`, `user`, `auth`) — same four-ring structure each time.
2. **Boundary-violation check**: `grep -rn "drizzle\|ioredis" src/application/`
   must return nothing. If it does, a repository interface was bypassed
   somewhere — find and fix before moving on. This single grep command is
   the cheapest, most direct test that clean architecture's core rule
   actually held.
3. Boot the Nest app (`nest start`), hit every route manually or via the
   existing Postman/Swagger definitions, confirm parity with the current
   Express app's behavior — this is not yet the cutover (Phase 6 is), this
   is standing the Nest app up **on a separate port**, side by side with the
   still-running Express+Mongo app, to verify it independently.

---

## 4.8 What to read next

- [phase-5-testing-strategy.md](./phase-5-testing-strategy.md) — how DI
  changes testing fundamentally (mock the repository interface instead of
  spinning up a real or in-memory database for unit tests), plus the
  integration/E2E strategy against real Postgres+Redis.
- [phase-6-cutover-and-cleanup.md](./phase-6-cutover-and-cleanup.md) — the
  final switch from the Express+Mongo app to the Nest+Postgres+Redis app.
