> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Services and Business Logic Layer

> **Note on this revision:** AstriX's backend was migrated off MongoDB/Mongoose onto PostgreSQL (via Drizzle ORM) and Redis (via ioredis) — see `backend/migrations/PLAN.md` for the full six-phase history. That migration deleted every Mongoose model and every `mongoose.Types.ObjectId` comparison from this layer; every service function below is Drizzle against `backend/src/db/schema.ts`. Where it matters for understanding *why* something is shaped the way it is, this chapter notes the prior Mongo-era behavior explicitly as history — never as how the system behaves today.

## 1. The Landscape

Every backend has to answer a question that's easy to skip past without ever deciding on purpose: once a request has been authenticated and its shape validated, where does the actual *business rule* run? Not "where does the HTTP handling happen" and not "where does the database query happen" — those questions usually get answered on autopilot — but the code in between: "a project can't be created without a name," "an order can't ship without payment," "a member can't be assigned a task unless they belong to the workspace." That code has to live somewhere, and where a team puts it has consequences that compound for years: how easy the rule is to find on a second read, how easy it is to test without booting the whole HTTP stack, how easy it is to accidentally duplicate the same rule twice with a subtle discrepancy between the two copies.

There are four real, well-trodden answers to this question, and understanding all four is what makes an unfamiliar codebase legible on first contact — because whichever one a team picked, the shape of "where's the business logic" follows predictably once you know which pattern you're looking at.

### (a) Transaction Script

The most direct answer: don't build a separate layer at all. Each use case — "register a user," "place an order," "delete a project" — is one procedural function, and that function lives directly in (or is called immediately by) the HTTP request handler. Martin Fowler names and defines this pattern in *Patterns of Enterprise Application Architecture* (2002) as exactly this: "organizes business logic by procedures where each procedure handles a single request from the presentation." It's the default shape of a huge number of small Express apps, a lot of Rails controllers before a team consciously extracts service objects, and most quick prototypes and CRUD-generator scaffolds.

```ts
// illustrative, not AstriX — a Transaction Script for the same "create project" use case
app.post("/projects", async (req, res) => {
  const { name, workspaceId } = req.body;
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  const [membership] = await db.select().from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, req.user.id), eq(workspaceMembers.workspaceId, workspaceId)));
  if (!membership) return res.status(403).json({ error: "not a member" });

  const [project] = await db.insert(projects).values({ name, workspaceId, createdBy: req.user.id }).returning();
  return res.status(201).json({ project });
});
```

The whole use case — validation, authorization, persistence, response shaping — lives in one function, inline in the route. It's fast to write and, for a genuinely tiny app, easy to read top to bottom in one sitting. The cost shows up as the app grows: because there's no separate layer, testing this logic means either spinning up the whole HTTP server and firing a real request at it (Supertest-style), or extracting pieces of it ad hoc; and because there's no shared place for "check the user is a workspace member," that check tends to get copy-pasted, slightly differently, into every handler that needs it — which is exactly the kind of drift a later chapter in this curriculum (05, on validation) and this chapter's own section 6 will both come back to.

### (b) Service Layer

Fowler names this one too, in the same book: a layer of functions or classes that sits between the presentation layer (controllers) and the domain/data layer, defining "the boundary of the application, and its set of available operations, and coordinates the application's response." Controllers become thin — they parse the request, call one or two service functions, and shape the response — while the service functions hold the actual orchestration: validate business invariants, call other services if needed, and read/write through the data layer.

```ts
// illustrative — a Service Layer split of the same use case
// controller
app.post("/projects", async (req, res) => {
  const project = await projectService.create(req.user.id, req.body);
  return res.status(201).json({ project });
});

// service
export async function create(userId, { name, workspaceId }) {
  const membership = await membershipService.getRole(userId, workspaceId);
  roleGuard(membership.role, ["CREATE_PROJECT"]);
  return db.insert(projects).values({ name, workspaceId, createdBy: userId }).returning();
}
```

This is what AstriX does, and it's worth naming the tradeoff honestly rather than presenting it as strictly better than Transaction Script. The service function is testable in isolation — call it directly with plain arguments, no `req`/`res` mocking required — and framework-agnostic in principle (nothing about `projectService.create` knows it's being called from Express specifically). But a Service Layer doesn't, by itself, guarantee cohesion: nothing stops a `service/` folder from becoming a bag of loosely related functions that all happen to live in the same file because they touch the same table, with no enforced relationship to each other beyond that. The organizing discipline is a team habit, not a structural guarantee — the same caveat file 01 of this curriculum raised about folder boundaries applies again here, one layer down.

### (c) Domain Model / DDD

Rather than pulling business logic into a *separate* layer of functions, this approach pushes it *onto* the objects the logic is actually about. Fowler's third pattern in the same chapter: "an object model of the domain that incorporates both behavior and data." In Eric Evans's *Domain-Driven Design* (2003), which develops this idea much further, these become rich aggregates and entities — an `Order` object doesn't just hold `items` and `total` as data; it has a `submit()` method that itself enforces "an order can't be submitted with zero items," an `applyDiscount()` method that enforces "a discount can't take the total below zero." Services, in this style, shrink down to thin orchestration — fetch the aggregate, call a method on it, save it — rather than containing the rule itself.

```ts
// illustrative — the rule lives ON the entity, not in a separate function
class Order {
  private items: OrderLine[];
  private status: "draft" | "submitted";

  submit(): void {
    if (this.items.length === 0) {
      throw new Error("Cannot submit an order with no line items");
    }
    this.status = "submitted";
  }
}

// service becomes thin orchestration
async function submitOrder(orderId: string) {
  const order = await orderRepository.findById(orderId);
  order.submit(); // the invariant is enforced inside the object itself
  await orderRepository.save(order);
}
```

The payoff is real encapsulation: it's structurally impossible to construct an `Order` and leave it in a state that violates its own invariants, because the invariant-checking code is attached to the object, not scattered across every service function that happens to touch an order. The cost is equally real: this requires genuine object-oriented domain modeling discipline — someone has to decide what belongs on the entity versus what stays external, keep entities from becoming God objects, and resist the pull of just adding "one more field" without a matching behavior. It also tends to fight ORMs that model records as data containers (which is precisely AstriX's situation, examined in section 2 below) rather than rich objects, unless the team deliberately builds a mapping layer between the two.

### (d) CQRS-style command/query handlers

Command Query Responsibility Segregation takes yet another axis: instead of organizing by technical layer or by domain object, it organizes by *individual use case*, and it explicitly splits reads from writes. A "create a project" use case becomes a `CreateProjectCommand` (a plain data object describing the intent) plus a `CreateProjectCommandHandler` (a class or function that knows how to execute it) — each independently testable, often dispatched through a mediator so the caller never imports the handler directly. Reads get their own, separate `GetProjectQuery` / handler pair, frequently against a different, denormalized read model. This is common in .NET (MediatR is the standard library implementing exactly this shape) and in Java enterprise systems, and it's a natural fit for event-sourced architectures, where "what happened" (commands, recorded as events) and "what things look like now" (queries, against a projection) are already two different concerns by construction.

```ts
// illustrative — CQRS shape
class CreateProjectCommand {
  constructor(public userId: string, public workspaceId: string, public name: string) {}
}

class CreateProjectHandler {
  async handle(cmd: CreateProjectCommand) {
    // authorization + validation + persistence, scoped to exactly this one use case
    return db.insert(projects).values({ name: cmd.name, workspaceId: cmd.workspaceId, createdBy: cmd.userId }).returning();
  }
}

// dispatched via a mediator, not called directly:
await mediator.send(new CreateProjectCommand(userId, workspaceId, name));
```

CQRS scales well when a system's read and write patterns genuinely diverge — high-volume, differently-shaped reads against a system that writes comparatively rarely, or a system that already needs an audit trail of every state change. For a CRUD-shaped application where a project's write model and its read model are the same row, this is heavy machinery: a mediator, a command object per use case, a handler class per command, often a whole extra indirection layer just to reach the same query a plain function would have made directly.

### The honest summary

| Pattern | Logic lives | Strongest guarantee | Steepest cost |
|---|---|---|---|
| Transaction Script | inline in the request handler | fastest to write, easiest to read top-to-bottom for a tiny app | logic duplicates across handlers; testing requires the HTTP layer |
| Service Layer | plain functions/classes between controller and data layer | testable in isolation, framework-agnostic | no enforced cohesion — can become a bag of unrelated functions |
| Domain Model / DDD | methods on rich entities/aggregates | invariants structurally impossible to violate | requires real OOP domain-modeling discipline; fights record-shaped ORMs |
| CQRS commands/queries | one command/query object + handler per use case | independently testable per use case, splits read/write concerns cleanly | heavy machinery for a CRUD-shaped app; extra indirection (mediator, handler classes) |

None of these four is the "advanced" one and none is the "beginner" one — each is a bet about what a specific team, at a specific system size, will spend the most time doing: writing new use cases fast, keeping cross-cutting rules consistent, protecting invariants at the object level, or scaling wildly divergent read/write traffic.

## 2. AstriX's Choice

AstriX uses a **Service Layer**: thin controllers that validate and authorize, then call into `services/*.service.ts`, which hold the actual business logic and Drizzle query orchestration. The services are **plain exported functions, not classes** — no constructor injection, no interfaces, no dependency-injection container anywhere in the codebase. This isn't an accident inherited from the old Mongo app, and it isn't the default a fresh Postgres app happens to have landed on either — it's a choice the migration made deliberately, and then re-affirmed under real pressure to do otherwise. An earlier draft of the migration's Phase 4 built a full `domain/`/`application/`/`infrastructure/`/`presentation/` split — repository interfaces, a composition root, manual dependency injection, the classic hexagonal shape. It was cut. In the migration's own words (`backend/migrations/phase-4-clean-architecture-express.md` §4.5, revision note):

> "For a single-team, single-database CRUD app like this one, the interface indirection didn't pay for itself — every feature needed 5 files (entity, repository interface, repository implementation, service class, controller) to do what the Mongo app already does in 3 (model, service, controller), and the only real payoff (swap the database without touching business logic, or unit-test against a fake repository) isn't something this project has an actual near-term need for."

The plain version — routes → controllers → services, no new layers — is what's actually implemented, on both sides of the migration. And, worth verifying rather than assuming: Drizzle's table rows are plain, anemic data objects, not rich domain objects with behavior — there is no equivalent anywhere in `backend/src/db/schema.ts` of a Mongoose schema's `.methods.` (instance methods attached to a document). A `pgTable(...)` call is columns and constraints, full stop; nothing in this schema decides whether an operation is currently legal the way a domain method would. Every conditional, every cross-table check, every multi-step write lives in the services examined next — the exact same anemic-model-plus-service-layer shape the Mongo app had, ported unchanged in structure onto a different database.

## 3. AstriX Implementation

Two domains, chosen deliberately for contrast: **project**, whose service functions are all single-row, non-transactional writes, and **workspace**, whose creation and deletion paths wrap multiple tables in a real Postgres transaction. Reading both side by side is the fastest way to see what AstriX's service layer looks like when the unit of work is simple, and what it looks like when it isn't.

### 3.1 Project — controller

```ts
// backend/src/controllers/project.controller.ts:1-39 (imports elided from full file)
import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { workspaceIdSchema } from "../validation/workspace.validation";
import {
  createProjectSchema,
  paginationQuerySchema,
  projectIdSchema,
  updateProjectSchema,
} from "../validation/project.validation";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { roleGuard } from "../utils/roleGuard";
import { Permissions } from "../enums/role.enum";
import {
  createProjectService,
  deleteProjectService,
  getProjectAnalyticsService,
  getProjectByIdAndWorkspaceIdService,
  getProjectsInWorkspaceService,
  updateProjectService,
} from "../services/project.service";
import { HTTPSTATUS } from "../config/http.config";

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

export const updateProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const projectId = projectIdSchema.parse(req.params.id);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const body = updateProjectSchema.parse(req.body);

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.EDIT_PROJECT]);

    const { project } = await updateProjectService(workspaceId, projectId, body);

    return res.status(HTTPSTATUS.OK).json({
      message: "Project updated successfully",
      project,
    });
  }
);

export const deleteProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const projectId = projectIdSchema.parse(req.params.id);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.DELETE_PROJECT]);

    await deleteProjectService(workspaceId, projectId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Project deleted successfully",
    });
  }
);
```

Every one of the six project controllers (create, list-in-workspace, get-by-id, analytics, update, delete) follows the identical shape: parse input with Zod, resolve the caller's role in the workspace, call `roleGuard` with the exact permission this action requires, call exactly one service function, shape the response. None of them contains a business rule of its own — "can this role create a project," "does this project belong to this workspace" are decided inside `roleGuard` and inside the service, never inline in the controller body.

### 3.2 Project — service

```ts
// backend/src/services/project.service.ts:1-23, 115-157
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { projects, tasks, users } from "../db/schema";
import { NotFoundException } from "../utils/appError";

export const createProjectService = async (
  userId: string,
  workspaceId: string,
  body: { emoji?: string; name: string; description?: string }
) => {
  const [project] = await db
    .insert(projects)
    .values({
      ...(body.emoji ? { emoji: body.emoji } : {}),
      name: body.name,
      description: body.description,
      workspaceId,
      createdBy: userId,
    })
    .returning();

  return { project };
};

export const updateProjectService = async (
  workspaceId: string,
  projectId: string,
  body: { emoji?: string; name?: string; description?: string }
) => {
  const [project] = await db
    .update(projects)
    .set({
      ...(body.emoji ? { emoji: body.emoji } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.description ? { description: body.description } : {}),
    })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .returning();

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return { project };
};

// Dramatically simpler than the Mongo original: no manual
// TaskModel.deleteMany() step needed. ON DELETE CASCADE (see
// 07-database-schema-design.md §3.7) removes this project's tasks
// atomically as part of the same DELETE statement.
export const deleteProjectService = async (
  workspaceId: string,
  projectId: string
) => {
  const [project] = await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .returning();

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return project;
};
```

None of these functions opens a Drizzle transaction. Each one is a single logical unit of work against, at most, one table — `deleteProjectService` doesn't even need the old Mongo original's manual `TaskModel.deleteMany({ project: project._id })` cascade step, because `tasks.projectId` is declared `.references(() => projects.id, { onDelete: "cascade" })` in `db/schema.ts` (see [`07-database-schema-design.md`](./07-database-schema-design.md) §3.7): the single `db.delete(projects).where(...)` call above is genuinely the entire operation, with Postgres itself removing the project's tasks as an atomic side effect of that one statement, not a step the service has to remember to perform. Compare that against workspace creation next, where three separate tables get written, and any one of them failing halfway through would leave a genuinely broken workspace behind — a user with no workspace membership row, or a workspace with no owner-level member — a failure mode `ON DELETE CASCADE` alone can't paper over, because these are three separate `INSERT`s, not one delete cascading outward.

### 3.3 Workspace — controller

```ts
// backend/src/controllers/workspace.controller.ts:1-40, 128-170
import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import {
  changeRoleSchema,
  createWorkspaceSchema,
  userIdSchema,
  workspaceIdSchema,
  updateWorkspaceSchema,
} from "../validation/workspace.validation";
import { HTTPSTATUS } from "../config/http.config";
import {
  changeMemberRoleService,
  createWorkspaceService,
  deleteWorkspaceService,
  getAllWorkspacesUserIsMemberService,
  getWorkspaceAnalyticsService,
  getWorkspaceByIdService,
  getWorkspaceMembersService,
  removeMemberFromWorkspaceService,
  resetWorkspaceInviteCodeService,
  updateWorkspaceByIdService,
} from "../services/workspace.service";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { Permissions } from "../enums/role.enum";
import { roleGuard } from "../utils/roleGuard";

export const createWorkspaceController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = createWorkspaceSchema.parse(req.body);

    const userId = req.user!.id;
    const { workspace } = await createWorkspaceService(userId, body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "Workspace created successfully",
      workspace,
    });
  }
);

export const deleteWorkspaceByIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);

    const userId = req.user!.id;

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.DELETE_WORKSPACE]);

    const { currentWorkspaceId } = await deleteWorkspaceService(workspaceId, userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace deleted successfully",
      currentWorkspace: currentWorkspaceId,
    });
  }
);
```

Notice `createWorkspaceController` specifically: unlike every project controller, it calls no `getMemberRoleInWorkspace` and no `roleGuard` at all — there's no workspace yet for the caller to hold a role in, so the only authorization requirement is being an authenticated user at all, already enforced by the `authenticate` middleware mounted ahead of this whole router in `app.ts`. `getWorkspaceByIdController` and `leaveWorkspaceController` (not shown above, but present in the full file) similarly call `getMemberRoleInWorkspace` but skip `roleGuard` entirely — membership itself is the only bar, no specific permission required, which is exactly the distinction the inline comment on `leaveWorkspaceController` makes explicit: "leaving isn't gated by a specific permission the way removing someone ELSE is."

### 3.4 Workspace — service

```ts
// backend/src/services/workspace.service.ts:1-57, 129-188, 214-264, 282-315
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { users, workspaces, roles, workspaceMembers } from "../db/schema";
import { generateInviteCode } from "../utils/uuid";
import { BadRequestException, ForbiddenException, NotFoundException } from "../utils/appError";

// Creates the workspace, its owner's membership row, and points the user's
// currentWorkspaceId at it - one Postgres transaction, so a failure partway
// through (an owner role that doesn't exist, a workspace insert that
// violates a constraint) leaves NO partial workspace behind.
export const createWorkspaceService = async (
  userId: string,
  body: { name: string; description?: string }
) => {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundException("User not found");

    const [ownerRole] = await tx.select().from(roles).where(eq(roles.name, "OWNER"));
    if (!ownerRole) throw new NotFoundException("Owner role not found");

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: body.name,
        description: body.description,
        ownerId: user.id,
        inviteCode: generateInviteCode(),
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      userId: user.id,
      workspaceId: workspace.id,
      roleId: ownerRole.id,
    });

    await tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id));

    return { workspace };
  });
};

export const removeMemberFromWorkspaceService = async (
  workspaceId: string,
  targetUserId: string
) => {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundException("Workspace not found");

  if (workspace.ownerId === targetUserId) {
    throw new BadRequestException(
      "The workspace owner cannot be removed. Transfer ownership first."
    );
  }

  const { tasks } = await import("../db/schema");

  const [deleted] = await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, targetUserId), eq(workspaceMembers.workspaceId, workspaceId)))
    .returning();

  if (!deleted) {
    throw new NotFoundException("Member not found in this workspace");
  }

  // Unassign (don't delete) any tasks the removed member was assigned - the
  // tasks themselves are still valid workspace history.
  await db
    .update(tasks)
    .set({ assignedTo: null })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.assignedTo, targetUserId)));
  // ... reassigns the removed user's currentWorkspaceId if it pointed here (full body in source)
};

// Cascades of Postgres foreign keys (ON DELETE CASCADE on workspace_members,
// projects, and tasks - see 07-database-schema-design.md §6) replace the
// Mongo original's manual, ordered ProjectModel.deleteMany() /
// TaskModel.deleteMany() / MemberModel.deleteMany() calls. What ISN'T a pure
// cascade side effect - reassigning the deleting user's currentWorkspaceId
// to another membership if one exists - stays explicit, inside the same
// transaction as the delete itself.
export const deleteWorkspaceService = async (
  workspaceId: string,
  userId: string
) => {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new NotFoundException("Workspace not found");

    if (workspace.ownerId !== userId) {
      throw new ForbiddenException("You are not authorized to delete this workspace");
    }

    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
    // ON DELETE CASCADE already removed workspace_members/projects/tasks
    // rows for this workspace, and set users.current_workspace_id to NULL
    // for every user whose current workspace was this one.

    const [anotherMembership] = await tx
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    if (anotherMembership) {
      await tx.update(users).set({ currentWorkspaceId: anotherMembership.workspaceId }).where(eq(users.id, userId));
    }

    const [updatedUser] = await tx
      .select({ currentWorkspaceId: users.currentWorkspaceId })
      .from(users)
      .where(eq(users.id, userId));

    return { currentWorkspaceId: updatedUser?.currentWorkspaceId ?? null };
  });
};

export const changeMemberRoleService = async (
  workspaceId: string,
  targetUserId: string,
  roleId: string
) => {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundException("Workspace not found");

  if (workspace.ownerId === targetUserId) {
    throw new BadRequestException(
      "Cannot change the role of the workspace owner. Transfer ownership first."
    );
  }

  const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
  if (!role) throw new NotFoundException("Role not found");

  const [member] = await db
    .update(workspaceMembers)
    .set({ roleId })
    .where(and(eq(workspaceMembers.userId, targetUserId), eq(workspaceMembers.workspaceId, workspaceId)))
    .returning();

  if (!member) throw new NotFoundException("Member not found in the workspace");
  return { member };
};
```

Two of these ten workspace-service functions — `createWorkspaceService` and `deleteWorkspaceService` — open a real `db.transaction(async (tx) => { ... })` and thread `tx`, not the module-level `db`, through every write inside the callback; the rest are plain sequential `await db...` calls with no transaction at all, identical in shape to the project service's non-transactional functions. `changeMemberRoleService`, `getWorkspaceByIdService`, `resetWorkspaceInviteCodeService`, and the others (in the full file) read as a straight line of Drizzle calls with an early-return `NotFoundException`/`BadRequestException`/`ForbiddenException` guard in front of each one — the same pattern seen in `project.service.ts`, just against different tables. The transaction only appears where multiple tables genuinely have to succeed or fail together — `getProjectAnalyticsService`/`getWorkspaceAnalyticsService` and the rest of the query-and-transaction mechanics in full (the `FILTER`-based analytics rewrite, connection pooling, every other `db.transaction()` call site in the codebase) are [`08-database-queries-and-transactions.md`](./08-database-queries-and-transactions.md)'s canonical scope; this file uses `createWorkspaceService` and `deleteWorkspaceService` only as the two worked examples needed to show what a service function looks like when it can't get away with a bare sequence of awaits.

Two other real transactions worth naming, both in `backend/src/services/auth.service.ts` and `user.service.ts`, since they're the clearest evidence that "wrap it in `db.transaction()`" is a repeated, load-bearing pattern rather than a one-off:

- **`registerUserService`** (`auth.service.ts:90-143`) wraps the entire signup write — insert the user row, insert the `EMAIL`-provider `accounts` row, look up the `OWNER` role, insert the new workspace, insert the owner's `workspace_members` row, and point `users.currentWorkspaceId` at the new workspace — in one `db.transaction(async (tx) => { ... })`. If the owner-role lookup fails partway through, none of the prior inserts in that block are visible outside the transaction; the (best-effort, deliberately non-transactional) email-verification-token send happens *after* the transaction has already committed, specifically so a flaky email provider can never roll back a successful registration.
- **`deleteAccountService`** (`user.service.ts:73-129`) wraps unassigning the departing user's tasks (`tx.update(tasks).set({ assignedTo: null })`), deleting their `workspace_members` rows, deleting their `accounts` rows, and deleting the `users` row itself in one transaction — all four have to happen together, or none of them should, since a partial run would leave orphaned membership/account rows pointing at a user id that no longer exists. The Redis session cleanup that follows (`invalidateAllSessionsForUser`) is deliberately outside the transaction, for the same reason the verification-email send in `registerUserService` is: Redis isn't part of the Postgres transaction boundary at all, and a best-effort cleanup after a committed write must never be allowed to un-commit that write if it fails.

## 4. Request/Data Flow

**Project creation — `POST /api/project/workspace/:workspaceId/create`, no transaction:**

1. `app.ts` mounts `projectRoutes` behind `authenticate`; by the time `createProjectController` runs, `req.user` is already populated as `{ id, sessionId }`. (Full auth trace: [02-authentication-and-authorization.md](./02-authentication-and-authorization.md).)
2. Inside `createProjectController`: `createProjectSchema.parse(req.body)` and `workspaceIdSchema.parse(req.params.workspaceId)` validate shape — the *how* of that validation, and why it lives in the controller rather than a dedicated middleware, is [05-validation-strategies.md](./05-validation-strategies.md)'s job, not this file's; here it's enough to note that by the time `getMemberRoleInWorkspace` runs, both inputs are already known to be well-formed.
3. `getMemberRoleInWorkspace(userId, workspaceId)` (from `services/member.service.ts`) does an `innerJoin` between `workspace_members` and `roles` to resolve the caller's role name for this workspace; `roleGuard(role, [Permissions.CREATE_PROJECT])` throws `ForbiddenException` if that role's permission set doesn't include `CREATE_PROJECT`. This is the permission check — it runs and completes *before* the service is ever called.
4. `createProjectService(userId, workspaceId, body)` runs: a single `db.insert(projects).values({...}).returning()` — no transaction, because nothing else has to succeed alongside it, and Drizzle's `.returning()` gets the freshly-inserted row back in the same round trip.
5. The service returns `{ project }`; the controller wraps it in the JSON response with `HTTPSTATUS.CREATED`. Any exception thrown anywhere in steps 2–4 — a Zod `ZodError`, the `ForbiddenException` from `roleGuard`, a raw Postgres constraint violation from the `insert` — is caught by `asyncHandler` and forwarded to the centralized `errorHandler` (full mechanics: [04-error-handling-patterns.md](./04-error-handling-patterns.md)).

**Workspace creation — `POST /api/workspace/create`, inside a transaction:**

1. Same entry: `authenticate` has already run; `createWorkspaceController` parses the body with `createWorkspaceSchema` and calls `createWorkspaceService(userId, body)` directly — no `getMemberRoleInWorkspace`/`roleGuard` pair here, because there is no workspace yet for a role to exist in. Being an authenticated user is the entire authorization requirement for this one action.
2. Inside `createWorkspaceService` (`backend/src/services/workspace.service.ts:24`): `return db.transaction(async (tx) => { ... })` — the transaction begins here, before any write happens, and every statement inside the callback runs against `tx`, not the module-level `db`.
3. Three sequential writes happen against three different tables, every one of them issued through the same `tx`: `tx.insert(workspaces).values({...}).returning()` creates the workspace row; `tx.insert(workspaceMembers).values({...})` creates the owner's membership row, linking that user to the new workspace with the `OWNER` role; `tx.update(users).set({ currentWorkspaceId: workspace.id })` updates the calling user's current-workspace pointer. If any one of these throws — a unique-constraint collision on `roles_name_idx`, a missing `ownerRole` lookup, anything — none of the prior writes in this transaction are visible outside it, because Drizzle's `db.transaction()` callback rolls back automatically on a thrown error and does not need an explicit `catch`/`abortTransaction` call the way a manually-managed session would.
4. The callback's return value (`{ workspace }`) only resolves once the underlying transaction has actually committed — Drizzle commits automatically when the callback's promise resolves without throwing, again with no explicit `commitTransaction()` call needed at the site above. From the controller's perspective, `createWorkspaceService` either fully succeeds or fully fails — there's no visible intermediate state where a workspace exists but its owner's membership doesn't.

The controller-level shape is identical between the two traces — parse, (maybe authorize), call one service function, shape the response, let `asyncHandler` catch anything that throws. The only structural difference is what happens *inside* the service: a bare sequence of awaits for project creation, a `db.transaction(async (tx) => {...})` callback for workspace creation. That's a deliberate point: the transaction is an implementation detail of the service function, invisible to (and not the concern of) the controller calling it.

## 5. Design Decisions & Tradeoffs

**Why a service layer at all, instead of Transaction Script directly in the controllers?** The clearest evidence is `getMemberRoleInWorkspace` itself: it's called, verbatim, from `project.controller.ts`, `task.controller.ts`, and `workspace.controller.ts` — three different domains' controllers, all resolving the same underlying question ("what role does this user hold in this workspace") through one shared function. Under a Transaction Script approach, either every one of those ~15 call sites re-implements that lookup inline, or the team reaches for some other shared-function mechanism anyway — at which point they've reinvented a service layer without naming it one. AstriX's actual shape avoids that: the lookup exists exactly once, in `member.service.ts`, and every controller that needs it imports the same function. The second, quieter benefit shows up in the test suite: the Phase 5 test suite calls service functions like `createProjectService` directly with plain arguments and asserts on the return value, with no `req`/`res` object, no HTTP layer, and no Express app booted at all (see [`08-database-queries-and-transactions.md`](./08-database-queries-and-transactions.md) for the `testcontainers`-based test infrastructure that makes this practical against a real, disposable Postgres instance). A Transaction Script equivalent would need Supertest firing a real request at a real route just to exercise the same logic.

**Why plain functions instead of classes with dependency injection?** Nothing in `services/*.service.ts` is a class; every export is a standalone `async` function that imports the Drizzle tables it needs directly at the top of the file (`import { projects, tasks, users } from "../db/schema"`, and so on) rather than receiving them as constructor arguments. This is exactly the shape the migration's Phase 4 §4.5 chose after explicitly building and then rejecting the alternative: an earlier draft introduced repository interfaces (`ProjectRepository`, `DrizzleProjectRepository`), a `composition-root.ts` wiring concrete implementations to interfaces, and service *classes* receiving those interfaces via constructor injection — the textbook hexagonal/ports-and-adapters shape from §1(c) applied to this app. It was cut because, at AstriX's actual size, every feature needed five files to do what the plain version does in three, and the one real payoff that would justify the extra ceremony — swapping the database engine without touching business logic, or unit-testing service logic against a fake repository instead of a real database — wasn't a need this project actually had. What's gained by staying plain is genuine: there's no DI container to configure, no interface to define and keep in sync with its one real implementation, no wiring code anywhere in the app — a new service function is just a new exported `async function`, full stop. What's given up is real too: there's no `interface ProjectService` a reviewer can read to see the full contract a fake would have to satisfy, and swapping Drizzle for a different query layer would mean touching every service file that imports `db`/`schema` directly, not reconfiguring one wiring point. Phase 4 §4.5 names exactly the two conditions under which that tradeoff should be revisited — a genuine need to swap the database engine, or a genuine need to unit-test against a fake instead of `testcontainers`' real, disposable database — neither of which has materialized, which is why the plain version is still what's implemented, not merely what shipped first.

**Why no repository/DAO layer between services and Drizzle?** Every service function calls `db.select().from(projects)...`, `db.insert(workspaceMembers).values(...)`, and so on directly — Drizzle *is* the data-access layer here; there's no additional abstraction (`ProjectRepository.findById(...)`) sitting between the two, for the identical reason given in the paragraph above: it's the same repository-layer question Phase 4 §4.5 already answered, not a second, independent design decision. This is a genuine coupling: a service function and its query logic are inseparable, and changing from Drizzle to a raw `pg` driver call, or to a different ORM entirely, would mean editing every service file rather than one repository implementation. Making a reflexive "should have used a repository pattern" call here would still be wrong for this specific codebase, for the same reason it was wrong for the class-based-services question: a repository layer earns its cost by buying swappable persistence or a fake-injection seam for tests, and Phase 5's `testcontainers` strategy already buys the second of those against a real, disposable Postgres — no fake repository required.

## 6. Security Considerations

The concrete question worth asking about any service layer is a trust-boundary one: when a service function runs, does it re-verify that the caller was actually allowed to do this, or does it simply trust that whoever called it already checked? AstriX's answer, checked directly rather than assumed, is that **services trust their caller completely**. Grepping every file in `services/` for `roleGuard` or `getMemberRoleInWorkspace` turns up exactly one hit — the definition of `getMemberRoleInWorkspace` itself, inside `member.service.ts` — and zero calls to either from within any other service function. Grepping the same two symbols across `controllers/` shows the opposite: `roleGuard` is called from `task.controller.ts`, `workspace.controller.ts`, and `project.controller.ts`, and nowhere else. The permission check is real, and it runs on every route that needs one — but it lives entirely in the controller layer, never inside the service it calls.

That means the honest answer to "could a service function be called from a second, hypothetical route that forgot the permission check, and would the service itself stop it" is **no, it would not**. `createProjectService(userId, workspaceId, body)` will happily insert a `projects` row for any `workspaceId` it's given — it has no way to know whether the caller already confirmed that `userId` holds `CREATE_PROJECT` permission in that workspace, because it never asks. If a future engineer added a second route — an internal admin endpoint, a bulk-import script, a webhook handler — and wired it directly to `createProjectService` without first calling `getMemberRoleInWorkspace` and `roleGuard` the way every existing controller does, nothing downstream would catch the omission. This is the same structural gap file 01 of this curriculum already surfaced from the folder-organization angle (the authorization check is re-implemented per controller with no compiler-enforced guarantee it's present); from the service-layer angle, the sharper version of that same observation is that the service functions are not a backstop for a forgotten authorization check — they are pure orchestration that assumes it already happened. This property is unchanged by the migration: it was exactly as true of the Mongo-era `services/*.ts` files, because the boundary being described is about which layer calls `roleGuard`, not about which database sits underneath.

The second, narrower question — whether any service accepts raw, unvalidated data from somewhere other than a controller, where the Zod validation boundary might be bypassed — has a clean answer in this codebase: no service file imports and calls another service file's exports as a general pattern (`grep -rn "from \"\.\./services/" backend/src/services/*.ts` turns up only `member.service.ts`, `redis/session.service.ts`, `redis/token.service.ts`, and `account.service.ts` being imported by `auth.service.ts`/`user.service.ts` — a small, named set of cross-file calls, not an open pattern). None of it is a validation-bypass risk: `registerUserService` calls `findAccountByProviderService`/`requestEmailVerificationService` with values it already owns (`user.id`, minted moments earlier by the service's own `insert(users)` call, or an email address already read back from the database) — never raw, unvalidated client input reaching a second service through a side door. There is, in short, exactly one trust boundary in this codebase, and it sits between the controller and the service, not between services themselves. That makes the controller layer a genuinely load-bearing security boundary, not a formality — every route file's author is implicitly responsible for calling `roleGuard` correctly, because nothing further down the call stack will catch it if they don't.

## 7. Best Practice Check

As of 2026, a Service Layer over a thin-controller boundary remains a thoroughly standard, defensible choice for a CRUD-shaped Node/TypeScript API — this isn't a dated pattern being carried forward out of habit; it's still what a majority of production Express, Fastify, and NestJS-service-layer codebases at AstriX's scale actually do, and the reasoning in section 5 (isolatable testing, one shared home for cross-domain logic like `getMemberRoleInWorkspace`) holds up as well in 2026 as it did when Fowler first named the pattern. Where the industry conversation has moved is narrower and more specific than "should you use a service layer": it's about *when* richer domain modeling (option (c) from section 1) starts paying for itself. That inflection point isn't about codebase size in the abstract — it's about whether the same business rule starts getting enforced, independently, in more than one service function, which is exactly the kind of drift a service layer with anemic models is structurally exposed to (nothing stops two services from each reimplementing "can this workspace be deleted" slightly differently).

Does AstriX show early signs of needing that yet? Weakly, and worth naming plainly rather than either dismissing or overstating it. The clearest candidate is the "owner can't be removed/changed/left-without-transfer" rule, which appears as its own explicit guard in three separate places in `workspace.service.ts`: `changeMemberRoleService` (`workspace.ownerId === targetUserId` → `BadRequestException`), `removeMemberFromWorkspaceService` (the identical string-equality check, same exception type, nearly the same message), and implicitly in `deleteWorkspaceService`'s ownership check (`ForbiddenException` if the caller isn't the owner — a related but distinct rule). Today these three checks are consistent with each other and simple enough that duplication hasn't yet caused drift — but this is precisely the shape of rule that a `Workspace.assertCanRemoveMember(targetUserId)` domain method, per section 1(c), would collapse into one place instead of three, catching a future edit that updates one copy and not the others before it ships. That's a real, concrete "starting to pay for domain modeling" signal, not a hypothetical one — but at three call sites, still consistent, in a six-domain application, it's a note for the future, not a present-tense gap. Everything else in the service layer — the single-table CRUD in `project.service.ts`, the `FILTER`-based analytics in both `project.service.ts` and `workspace.service.ts` (full mechanics in [`08-database-queries-and-transactions.md`](./08-database-queries-and-transactions.md)) — is squarely inside what a plain Service Layer handles well, with no visible strain.

Worth flagging separately, since it's specific to the plain-functions choice rather than the service-layer choice in general: `removeMemberFromWorkspaceService` and `getWorkspaceAnalyticsService` both reach for a dynamic `const { tasks } = await import("../db/schema")` inside the function body rather than a top-level `import { tasks } from "../db/schema"` alongside the file's other schema imports. Nothing about this is a correctness problem — Node resolves and caches the module identically either way — but it reads as an artifact of incremental porting during the migration rather than a deliberate pattern, and it's the kind of small inconsistency worth cleaning up the next time either function is touched for an unrelated reason, precisely because "plain functions, no DI" already relies on straightforward, consistent imports as its main readability argument (section 5) — a dynamic import in the middle of an otherwise-static-import file undercuts that argument slightly every time a reader has to notice it's equivalent rather than assume it's there for a reason.

## 8. Debug Drill

**Scenario:** two different service functions are each supposed to enforce the same business rule — say, "only the workspace owner can do X" — but a bug report claims the rule behaves differently depending on which action the user takes: it correctly blocks one action for a non-owner, but incorrectly allows (or incorrectly blocks) another. No stack trace, just a behavioral inconsistency between two code paths that are supposed to agree. Where do you look first, and why — as a transferable exercise for any service-layer backend, not sourced from any specific incident in this one?

1. **Find every place the rule is actually implemented, not just the two the bug report names.** In a service layer built from plain functions rather than domain methods, the same conceptual rule can easily exist as N separate, textually-similar-but-not-identical `if` blocks — exactly the pattern section 7 flagged for AstriX's owner-protection checks. Grep across `services/*.service.ts` for the entity field the rule hinges on (`.ownerId ===`, in AstriX's case) rather than trusting that the bug report's two named functions are the only two places the rule lives. The bug is as likely to be a *third*, unmentioned copy of the rule as it is to be either of the two the report calls out.
2. **Diff the guard conditions, not just their error messages.** Two copies of "is this user the owner" can look identical at a glance — same `NotFoundException`/`BadRequestException` shape, same rough wording — while differing in something that matters: one compares `workspace.ownerId === targetUserId` as a plain string comparison (both are UUID strings returned from Drizzle — there's no `mongoose.Types.ObjectId`-style wrapping to get wrong the way the Mongo-era version of this same check had to guard against), the other checks the rule before a database lookup that could itself throw for an unrelated reason, or against a value that was never normalized (trimmed, lower-cased) the same way on both sides. A type mismatch or an ordering difference is the single most common way "the same rule" silently diverges between two hand-written copies — under Postgres specifically, watch for a comparison against a raw `req.params` string that was never validated as a UUID by the corresponding Zod schema, since that's the one class of bug the old Mongo-era `ObjectId`-wrapping ritual accidentally caught by throwing a `CastError`, and the current plain-string-equality version won't.
3. **Check whether the two service functions are even receiving the same shape of data from their respective controllers.** Because there's no shared DTO layer forcing every caller of "the owner-check" to pass identical argument shapes, it's entirely possible one controller resolves `targetUserId` from `req.params.userId` while another resolves an equivalent value from a request-body field with a different name (compare `removeWorkspaceMemberController`'s `userIdSchema.parse(req.params.userId)` against `changeWorkspaceMemberRoleController`'s `changeRoleSchema.parse(req.body)` in this file's section 3.3 — same underlying concept, two different sources). A rule that's correctly implemented can still misbehave if the value reaching it was extracted from the wrong place one layer up.
4. **Only once the duplication and the data source are both confirmed identical (or the actual discrepancy between them is found) does a genuine logic bug in one specific copy become the remaining explanation.** Resist fixing the visibly "wrong" copy in isolation — if the root cause is that the rule exists in two or three places at all, the durable fix is consolidating them (a shared assertion function, or, if the pattern keeps recurring, migrating that specific rule onto its own small module rather than a domain method, since AstriX's tables have no attached behavior to hang one on per section 2), not just correcting the one instance the bug report happened to name. Patching the symptom leaves the next copy free to drift again the same way.

The transferable lesson: in a service layer built from plain, independent functions rather than shared domain methods, "the same rule behaves differently in two places" is rarely a logic bug in one function — it's usually evidence that the rule was never actually shared code to begin with, just two authors independently agreeing, for a while, on what the rule should say.
