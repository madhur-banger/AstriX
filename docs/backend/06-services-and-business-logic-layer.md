> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

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
  const membership = await Membership.findOne({ userId: req.user.id, workspaceId });
  if (!membership) return res.status(403).json({ error: "not a member" });

  const project = await Project.create({ name, workspace: workspaceId, createdBy: req.user.id });
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
  return Project.create({ name, workspace: workspaceId, createdBy: userId });
}
```

This is what AstriX does, and it's worth naming the tradeoff honestly rather than presenting it as strictly better than Transaction Script. The service function is testable in isolation — call it directly with plain arguments, no `req`/`res` mocking required — and framework-agnostic in principle (nothing about `projectService.create` knows it's being called from Express specifically). But a Service Layer doesn't, by itself, guarantee cohesion: nothing stops a `service/` folder from becoming a bag of loosely related functions that all happen to live in the same file because they touch the same Mongoose model, with no enforced relationship to each other beyond that. The organizing discipline is a team habit, not a structural guarantee — the same caveat file 01 of this curriculum raised about folder boundaries applies again here, one layer down.

### (c) Domain Model / DDD

Rather than pulling business logic into a *separate* layer of functions, this approach pushes it *onto* the objects the logic is actually about. Fowler's third pattern in the same chapter: "an object model of the domain that incorporates both behavior and data." In Eric Evans's *Domain-Driven Design* (2003), which develops this idea much further, these become rich aggregates and entities — a `Order` object doesn't just hold `items` and `total` as data; it has a `submit()` method that itself enforces "an order can't be submitted with zero items," an `applyDiscount()` method that enforces "a discount can't take the total below zero." Services, in this style, shrink down to thin orchestration — fetch the aggregate, call a method on it, save it — rather than containing the rule itself.

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
    return Project.create({ name: cmd.name, workspace: cmd.workspaceId, createdBy: cmd.userId });
  }
}

// dispatched via a mediator, not called directly:
await mediator.send(new CreateProjectCommand(userId, workspaceId, name));
```

CQRS scales well when a system's read and write patterns genuinely diverge — high-volume, differently-shaped reads against a system that writes comparatively rarely, or a system that already needs an audit trail of every state change. For a CRUD-shaped application where a project's write model and its read model are the same document, this is heavy machinery: a mediator, a command object per use case, a handler class per command, often a whole extra indirection layer just to reach the same Mongoose call a plain function would have made directly.

### The honest summary

| Pattern | Logic lives | Strongest guarantee | Steepest cost |
|---|---|---|---|
| Transaction Script | inline in the request handler | fastest to write, easiest to read top-to-bottom for a tiny app | logic duplicates across handlers; testing requires the HTTP layer |
| Service Layer | plain functions/classes between controller and data layer | testable in isolation, framework-agnostic | no enforced cohesion — can become a bag of unrelated functions |
| Domain Model / DDD | methods on rich entities/aggregates | invariants structurally impossible to violate | requires real OOP domain-modeling discipline; fights record-shaped ORMs |
| CQRS commands/queries | one command/query object + handler per use case | independently testable per use case, splits read/write concerns cleanly | heavy machinery for a CRUD-shaped app; extra indirection (mediator, handler classes) |

None of these four is the "advanced" one and none is the "beginner" one — each is a bet about what a specific team, at a specific system size, will spend the most time doing: writing new use cases fast, keeping cross-cutting rules consistent, protecting invariants at the object level, or scaling wildly divergent read/write traffic.

## 2. AstriX's Choice

AstriX uses a **Service Layer**: thin controllers that validate and authorize, then call into `services/*.service.ts`, which hold the actual business logic and Mongoose orchestration. The services are **plain exported functions, not classes** — no constructor injection, no interfaces, no dependency-injection container anywhere in the codebase. And, worth verifying rather than assuming: AstriX's Mongoose documents are close to **anemic data records**, not rich domain objects with behavior. A grep across all ten model files for `.methods.` — the only place Mongoose attaches instance behavior to a document — turns up exactly three:

```
backend/src/models/user.model.ts:62:userSchema.methods.omitPassword = function (): Omit<UserDocument, "password"> {
backend/src/models/user.model.ts:68:userSchema.methods.comparePassword = async function (value: string) {
backend/src/models/workspace.model.ts:35:workspaceSchema.methods.resetInviteCode = function () {
```

That's the entire inventory, across ten schemas covering users, accounts, sessions, workspaces, members, projects, tasks, roles, and two token models. All three are small, self-contained helpers — hash a password and compare it, strip a field before serializing, regenerate a random invite code — not business rules that enforce an invariant across the object's own state the way `Order.submit()` did in section 1(c) above. Nothing in the codebase looks like `project.archive()` deciding whether archiving is currently legal, or `task.reassign()` checking that the new assignee is actually a workspace member (that check, as section 6 below covers, lives in the *service* layer instead — `task.service.ts`, not `task.model.ts`). This confirms the claim rather than asserting it: AstriX's models are schema-plus-tiny-helper records, and the actual business logic — every conditional, every cross-collection check, every multi-step write — lives in the services examined next.

## 3. AstriX Implementation

Two domains, chosen deliberately for contrast: **project**, whose service functions are all single-document, non-transactional writes, and **workspace**, whose creation and deletion paths wrap multiple documents in a real Mongoose transaction. Reading both side by side is the fastest way to see what AstriX's service layer looks like when the unit of work is simple, and what it looks like when it isn't.

### 3.1 Project — controller

```ts
// backend/src/controllers/project.controller.ts:1-155
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

export const getAllProjectsInWorkspaceController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const { pageSize, pageNumber } = paginationQuerySchema.parse(req.query);

    const { projects, totalCount, totalPages, skip } =
      await getProjectsInWorkspaceService(workspaceId, pageSize, pageNumber);

    return res.status(HTTPSTATUS.OK).json({
      message: "Project fetched successfully",
      projects,
      pagination: {
        totalCount,
        pageSize,
        pageNumber,
        totalPages,
        skip,
        limit: pageSize,
      },
    });
  }
);

export const getProjectByIdAndWorkspaceIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const projectId = projectIdSchema.parse(req.params.id);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const { project } = await getProjectByIdAndWorkspaceIdService(
      workspaceId,
      projectId
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Project fetched successfully",
      project,
    });
  }
);

export const getProjectAnalyticsController = asyncHandler(
  async (req: Request, res: Response) => {
    const projectId = projectIdSchema.parse(req.params.id);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const { analytics } = await getProjectAnalyticsService(
      workspaceId,
      projectId
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Project analytics retrieved successfully",
      analytics,
    });
  }
);

export const updateProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id.toString();

    const projectId = projectIdSchema.parse(req.params.id);
    const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);

    const body = updateProjectSchema.parse(req.body);

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.EDIT_PROJECT]);

    const { project } = await updateProjectService(
      workspaceId,
      projectId,
      body
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Project updated successfully",
      project,
    });
  }
);

export const deleteProjectController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id.toString();

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

Every one of these six controllers follows the identical shape: parse input with Zod, resolve the caller's role in the workspace, call `roleGuard` with the exact permission this action requires, call exactly one service function, shape the response. None of them contains a business rule of its own — "can this role create a project," "does this project belong to this workspace" are decided inside `roleGuard` and inside the service, never inline in the controller body.

### 3.2 Project — service

```ts
// backend/src/services/project.service.ts:1-189
import mongoose from "mongoose";
import ProjectModel from "../models/project.model";
import TaskModel from "../models/task.model";
import { NotFoundException } from "../utils/appError";
import { TaskStatusEnum } from "../enums/task.enum";

export const createProjectService = async (
  userId: string,
  workspaceId: string,
  body: {
    emoji?: string;
    name: string;
    description?: string;
  }
) => {
  const project = new ProjectModel({
    ...(body.emoji && { emoji: body.emoji }),
    name: body.name,
    description: body.description,
    workspace: workspaceId,
    createdBy: userId,
  });

  await project.save();

  return { project };
};

export const getProjectsInWorkspaceService = async (
  workspaceId: string,
  pageSize: number,
  pageNumber: number
) => {
  // Step 1: Find all projects in the workspace

  const totalCount = await ProjectModel.countDocuments({
    workspace: workspaceId,
  });

  const skip = (pageNumber - 1) * pageSize;

  const projects = await ProjectModel.find({
    workspace: workspaceId,
  })
    .skip(skip)
    .limit(pageSize)
    .populate("createdBy", "_id name profilePicture -password")
    .sort({ createdAt: -1 });

  const totalPages = Math.ceil(totalCount / pageSize);

  return { projects, totalCount, totalPages, skip };
};

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

export const getProjectAnalyticsService = async (
  workspaceId: string,
  projectId: string
) => {
  const project = await ProjectModel.findById(projectId);

  if (!project || project.workspace.toString() !== workspaceId.toString()) {
    throw new NotFoundException(
      "Project not found or does not belong to this workspace"
    );
  }

  const currentDate = new Date();

  //USING Mongoose aggregate
  const taskAnalytics = await TaskModel.aggregate([
    {
      $match: {
        project: new mongoose.Types.ObjectId(projectId),
      },
    },
    {
      $facet: {
        totalTasks: [{ $count: "count" }],
        overdueTasks: [
          {
            $match: {
              dueDate: { $lt: currentDate },
              status: {
                $ne: TaskStatusEnum.DONE,
              },
            },
          },
          {
            $count: "count",
          },
        ],
        completedTasks: [
          {
            $match: {
              status: TaskStatusEnum.DONE,
            },
          },
          { $count: "count" },
        ],
      },
    },
  ]);

  const _analytics = taskAnalytics[0];

  const analytics = {
    totalTasks: _analytics.totalTasks[0]?.count || 0,
    overdueTasks: _analytics.overdueTasks[0]?.count || 0,
    completedTasks: _analytics.completedTasks[0]?.count || 0,
  };

  return {
    analytics,
  };
};

export const updateProjectService = async (
  workspaceId: string,
  projectId: string,
  body: {
    emoji?: string;
    name: string;
    description?: string;
  }
) => {
  const { name, emoji, description } = body;

  const project = await ProjectModel.findOne({
    _id: projectId,
    workspace: workspaceId,
  });

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }

  if (emoji) project.emoji = emoji;
  if (name) project.name = name;
  if (description) project.description = description;

  await project.save();

  return { project };
};

export const deleteProjectService = async (
  workspaceId: string,
  projectId: string
) => {
  const project = await ProjectModel.findOne({
    _id: projectId,
    workspace: workspaceId,
  });

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }

  await project.deleteOne();

  await TaskModel.deleteMany({
    project: project._id,
  });

  return project;
};
```

None of these six functions opens a Mongoose session. Each one is a single logical unit of work against, at most, two collections (`deleteProjectService` deletes the project, then cascades to that project's tasks) — and none of them needs transactional atomicity strongly enough to pay for it: if the process crashed between `project.deleteOne()` and `TaskModel.deleteMany()`, the result is an orphaned batch of tasks pointing at a deleted project, a real but low-severity data-integrity risk, not a torn financial write. Compare that against workspace creation next, where three separate collections get written, and any one of them failing halfway through would leave a genuinely broken workspace behind — a user with no workspace membership record, or a workspace with no owner-role member.

### 3.3 Workspace — controller

```ts
// backend/src/controllers/workspace.controller.ts:1-229
import { Request, Response } from "express";

import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import {
  changeRoleSchema,
  createWorkspaceSchema,
  userIdSchema,
  workspaceIdSchema,
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
import { updateWorkspaceSchema } from "../validation/workspace.validation";

export const createWorkspaceController = asyncHandler(
  async (req: Request, res: Response) => {
    const body = createWorkspaceSchema.parse(req.body);

    const userId = req.user!._id.toString();
    const { workspace } = await createWorkspaceService(userId, body);

    return res.status(HTTPSTATUS.CREATED).json({
      message: "Workspace created successfully",
      workspace,
    });
  }
);

// Controller: Get all workspaces the user is part of

export const getAllWorkspacesUserIsMemberController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!._id.toString();

    const { workspaces } = await getAllWorkspacesUserIsMemberService(userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "User workspaces fetched successfully",
      workspaces,
    });
  }
);

export const getWorkspaceByIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const userId = req.user!._id.toString();

    await getMemberRoleInWorkspace(userId, workspaceId);

    const { workspace } = await getWorkspaceByIdService(workspaceId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace fetched successfully",
      workspace,
    });
  }
);

export const getWorkspaceMembersController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const { members, roles } = await getWorkspaceMembersService(workspaceId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace members retrieved successfully",
      members,
      roles,
    });
  }
);

export const getWorkspaceAnalyticsController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.VIEW_ONLY]);

    const { analytics } = await getWorkspaceAnalyticsService(workspaceId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace analytics retrieved successfully",
      analytics,
    });
  }
);

export const changeWorkspaceMemberRoleController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    // `memberId` is the request-body key (see changeRoleSchema); the value
    // it carries is the targeted user's id.
    const { memberId: targetUserId, roleId } = changeRoleSchema.parse(req.body);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.CHANGE_MEMBER_ROLE]);

    const { member } = await changeMemberRoleService(
      workspaceId,
      targetUserId,
      roleId
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Member Role changed successfully",
      member,
    });
  }
);

export const updateWorkspaceByIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const { name, description } = updateWorkspaceSchema.parse(req.body);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.EDIT_WORKSPACE]);

    const { workspace } = await updateWorkspaceByIdService(
      workspaceId,
      name,
      description
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace updated successfully",
      workspace,
    });
  }
);

export const deleteWorkspaceByIdController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.DELETE_WORKSPACE]);

    const { currentWorkspace } = await deleteWorkspaceService(
      workspaceId,
      userId
    );

    return res.status(HTTPSTATUS.OK).json({
      message: "Workspace deleted successfully",
      currentWorkspace,
    });
  }
);

export const removeWorkspaceMemberController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const targetUserId = userIdSchema.parse(req.params.userId);

    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.REMOVE_MEMBER]);

    await removeMemberFromWorkspaceService(workspaceId, targetUserId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Member removed successfully",
    });
  }
);

export const leaveWorkspaceController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const userId = req.user!._id.toString();

    // Confirms the caller is actually a member (and gets their role, unused
    // here) before letting them remove themselves - leaving isn't gated by
    // a specific permission the way removing someone ELSE is.
    await getMemberRoleInWorkspace(userId, workspaceId);

    await removeMemberFromWorkspaceService(workspaceId, userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Left the workspace successfully",
    });
  }
);

export const resetWorkspaceInviteCodeController = asyncHandler(
  async (req: Request, res: Response) => {
    const workspaceId = workspaceIdSchema.parse(req.params.id);
    const userId = req.user!._id.toString();

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    roleGuard(role, [Permissions.MANAGE_WORKSPACE_SETTINGS]);

    const { workspace } = await resetWorkspaceInviteCodeService(workspaceId);

    return res.status(HTTPSTATUS.OK).json({
      message: "Invite code reset successfully",
      workspace,
    });
  }
);
```

Notice `createWorkspaceController` specifically: unlike every project controller, it calls no `getMemberRoleInWorkspace` and no `roleGuard` at all — there's no workspace yet for the caller to hold a role in, so the only authorization requirement is being an authenticated user at all, already enforced by the `authenticate` middleware mounted ahead of this whole router in `index.ts`. `getWorkspaceByIdController` and `leaveWorkspaceController` similarly call `getMemberRoleInWorkspace` but skip `roleGuard` entirely — membership itself is the only bar, no specific permission required, which is exactly the distinction the inline comment on `leaveWorkspaceController` makes explicit: "leaving isn't gated by a specific permission the way removing someone ELSE is."

### 3.4 Workspace — service

```ts
// backend/src/services/workspace.service.ts:1-348
import mongoose from "mongoose";
import { Roles } from "../enums/role.enum";
import MemberModel from "../models/member.model";
import RoleModel from "../models/roles-permission.model";
import UserModel from "../models/user.model";
import WorkspaceModel from "../models/workspace.model";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../utils/appError";
import TaskModel from "../models/task.model";
import { TaskStatusEnum } from "../enums/task.enum";
import ProjectModel from "../models/project.model";

//********************************
// CREATE NEW WORKSPACE
//**************** **************/
export const createWorkspaceService = async (
  userId: string,
  body: {
    name: string;
    description?: string | undefined;
  }
) => {
  const { name, description } = body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await UserModel.findById(userId).session(session);
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const ownerRole = await RoleModel.findOne({ name: Roles.OWNER }).session(
      session
    );
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const workspace = new WorkspaceModel({
      name: name,
      description: description,
      owner: user._id,
    });
    await workspace.save({ session });

    const member = new MemberModel({
      userId: user._id,
      workspaceId: workspace._id,
      role: ownerRole._id,
      joinedAt: new Date(),
    });
    await member.save({ session });

    user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      workspace,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

//********************************
// GET WORKSPACES USER IS A MEMBER
//**************** **************/
export const getAllWorkspacesUserIsMemberService = async (userId: string) => {
  const memberships = await MemberModel.find({ userId })
    .populate("workspaceId")
    .exec();

  // Extract workspace details from memberships
  const workspaces = memberships.map((membership) => membership.workspaceId);

  return { workspaces };
};

export const getWorkspaceByIdService = async (workspaceId: string) => {
  const workspace = await WorkspaceModel.findById(workspaceId);

  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  const members = await MemberModel.find({
    workspaceId,
  }).populate("role");

  const workspaceWithMembers = {
    ...workspace.toObject(),
    members,
  };

  return {
    workspace: workspaceWithMembers,
  };
};

//********************************
// GET ALL MEMEBERS IN WORKSPACE
//**************** **************/

export const getWorkspaceMembersService = async (workspaceId: string) => {
  // Fetch all members of the workspace

  const members = await MemberModel.find({
    workspaceId,
  })
    .populate("userId", "name email profilePicture -password")
    .populate("role", "name");

  const roles = await RoleModel.find({}, { name: 1, _id: 1 })
    .select("-permission")
    .lean();

  return { members, roles };
};

export const getWorkspaceAnalyticsService = async (workspaceId: string) => {
  const currentDate = new Date();

  const totalTasks = await TaskModel.countDocuments({
    workspace: workspaceId,
  });

  const overdueTasks = await TaskModel.countDocuments({
    workspace: workspaceId,
    dueDate: { $lt: currentDate },
    status: { $ne: TaskStatusEnum.DONE },
  });

  const completedTasks = await TaskModel.countDocuments({
    workspace: workspaceId,
    status: TaskStatusEnum.DONE,
  });

  const analytics = {
    totalTasks,
    overdueTasks,
    completedTasks,
  };

  return { analytics };
};

export const changeMemberRoleService = async (
  workspaceId: string,
  targetUserId: string,
  roleId: string
) => {
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  if (workspace.owner.equals(new mongoose.Types.ObjectId(targetUserId))) {
    throw new BadRequestException(
      "Cannot change the role of the workspace owner. Transfer ownership first."
    );
  }

  const role = await RoleModel.findById(roleId);
  if (!role) {
    throw new NotFoundException("Role not found");
  }

  const member = await MemberModel.findOne({
    userId: targetUserId,
    workspaceId: workspaceId,
  });

  if (!member) {
    throw new NotFoundException("Member not found in the workspace");
  }

  member.role = role;
  await member.save();

  return {
    member,
  };
};

//********************************
// REMOVE MEMBER / LEAVE WORKSPACE
// Shared by both: an OWNER/ADMIN removing someone else (gated by the
// REMOVE_MEMBER permission at the controller) and a member removing
// themselves (leave-workspace, gated only by membership). Either way the
// workspace owner can never be removed this way - that would leave the
// workspace with nobody holding owner-level permissions. Ownership must be
// transferred (not currently supported) before the owner can leave.
//**************** **************/
export const removeMemberFromWorkspaceService = async (
  workspaceId: string,
  targetUserId: string
) => {
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  if (workspace.owner.equals(new mongoose.Types.ObjectId(targetUserId))) {
    throw new BadRequestException(
      "The workspace owner cannot be removed. Transfer ownership first."
    );
  }

  const member = await MemberModel.findOneAndDelete({
    userId: targetUserId,
    workspaceId,
  });

  if (!member) {
    throw new NotFoundException("Member not found in this workspace");
  }

  // Unassign (don't delete) any tasks the removed member was assigned -
  // the tasks themselves are still valid workspace history.
  await TaskModel.updateMany(
    { workspace: workspaceId, assignedTo: targetUserId },
    { assignedTo: null }
  );

  const user = await UserModel.findById(targetUserId);
  if (user?.currentWorkspace?.equals(workspaceId)) {
    const anotherMembership = await MemberModel.findOne({
      userId: targetUserId,
    });
    user.currentWorkspace = anotherMembership
      ? (anotherMembership.workspaceId as mongoose.Types.ObjectId)
      : null;
    await user.save();
  }
};

//********************************
// RESET WORKSPACE INVITE CODE
//**************** **************/
export const resetWorkspaceInviteCodeService = async (workspaceId: string) => {
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  workspace.resetInviteCode();
  await workspace.save();

  return { workspace };
};

//********************************
// UPDATE WORKSPACE
//**************** **************/
export const updateWorkspaceByIdService = async (
  workspaceId: string,
  name: string,
  description?: string
) => {
  const workspace = await WorkspaceModel.findById(workspaceId);
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  // Update the workspace details
  workspace.name = name || workspace.name;
  workspace.description = description || workspace.description;
  await workspace.save();

  return {
    workspace,
  };
};

export const deleteWorkspaceService = async (
  workspaceId: string,
  userId: string
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const workspace =
      await WorkspaceModel.findById(workspaceId).session(session);
    if (!workspace) {
      throw new NotFoundException("Workspace not found");
    }

    // Check if the user owns the workspace
    if (!workspace.owner.equals(new mongoose.Types.ObjectId(userId))) {
      throw new ForbiddenException(
        "You are not authorized to delete this workspace"
      );
    }

    const user = await UserModel.findById(userId).session(session);
    if (!user) {
      throw new NotFoundException("User not found");
    }

    await ProjectModel.deleteMany({ workspace: workspace._id }).session(
      session
    );
    await TaskModel.deleteMany({ workspace: workspace._id }).session(session);

    await MemberModel.deleteMany({
      workspaceId: workspace._id,
    }).session(session);

    // Update the user's currentWorkspace if it matches the deleted workspace
    if (user?.currentWorkspace?.equals(workspaceId)) {
      const memberWorkspace = await MemberModel.findOne({ userId }).session(
        session
      );
      // Update the user's currentWorkspace
      user.currentWorkspace = memberWorkspace
        ? memberWorkspace.workspaceId
        : null;

      await user.save({ session });
    }

    await workspace.deleteOne({ session });

    await session.commitTransaction();

    session.endSession();

    return {
      currentWorkspace: user.currentWorkspace,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};
```

Two of these ten functions — `createWorkspaceService` and `deleteWorkspaceService` — open a `mongoose.startSession()` and thread it through every write with `.session(session)`; the rest are plain sequential awaits with no session at all, identical in shape to the project service's non-transactional functions. `changeMemberRoleService`, `getWorkspaceByIdService`, `resetWorkspaceInviteCodeService`, and the others read as a straight line of Mongoose calls with an early-return `NotFoundException`/`BadRequestException` guard in front of each one — the same pattern seen in `project.service.ts`, just against a different model. The transaction only appears where multiple collections genuinely have to succeed or fail together. `08-database-queries-and-transactions.md` is the canonical source for Mongoose's session/transaction API mechanics in full and for AstriX's complete catalog of every transactional service; this file uses `createWorkspaceService` only as the one worked example needed to show what a service function looks like when it can't get away with a bare sequence of awaits.

## 4. Request/Data Flow

**Project creation — `POST /api/project/workspace/:workspaceId/create`, no transaction:**

1. `index.ts` mounts `projectRoutes` behind `authenticate`; by the time `createProjectController` runs, `req.user` is already populated. (Full auth trace: [02-authentication-and-authorization.md](./02-authentication-and-authorization.md).)
2. Inside `createProjectController`: `createProjectSchema.parse(req.body)` and `workspaceIdSchema.parse(req.params.workspaceId)` validate shape — the *how* of that validation, and why it lives in the controller rather than a dedicated middleware, is [05-validation-strategies.md](./05-validation-strategies.md)'s job, not this file's; here it's enough to note that by the time line 236 runs (`getMemberRoleInWorkspace`), both inputs are already known to be well-formed.
3. `getMemberRoleInWorkspace(userId, workspaceId)` (from `services/member.service.ts`) looks up the caller's `Member` document for this workspace and returns their role name; `roleGuard(role, [Permissions.CREATE_PROJECT])` throws `ForbiddenException` if that role's permission set doesn't include `CREATE_PROJECT`. This is the permission check — it runs and completes *before* the service is ever called.
4. `createProjectService(userId, workspaceId, body)` runs: constructs a `new ProjectModel({...})` and calls `project.save()` — the single Mongoose write, no session, no transaction, because nothing else has to succeed alongside it.
5. The service returns `{ project }`; the controller wraps it in the JSON response with `HTTPSTATUS.CREATED`. Any exception thrown anywhere in steps 2–4 — a Zod `ZodError`, the `ForbiddenException` from `roleGuard`, a Mongoose validation error from `project.save()` — is caught by `asyncHandler` and forwarded to the centralized `errorHandler` (full mechanics: [04-error-handling-patterns.md](./04-error-handling-patterns.md)).

**Workspace creation — `POST /api/workspace/create`, inside a transaction:**

1. Same entry: `authenticate` has already run; `createWorkspaceController` parses the body with `createWorkspaceSchema` and calls `createWorkspaceService(userId, body)` directly — no `getMemberRoleInWorkspace`/`roleGuard` pair here, because there is no workspace yet for a role to exist in. Being an authenticated user is the entire authorization requirement for this one action.
2. Inside `createWorkspaceService` (`backend/src/services/workspace.service.ts:28-29`): `const session = await mongoose.startSession(); session.startTransaction();` — the transaction begins here, before any write happens, wrapping everything that follows in a `try`.
3. Three sequential writes happen against three different collections, every one of them passed the same `session`: `workspace.save({ session })` creates the `Workspace` document; `member.save({ session })` creates the owner's `Member` document, linking that user to the new workspace with the `OWNER` role; `user.save({ session })` updates the calling user's `currentWorkspace` pointer to the new workspace's id. If any one of these three throws — a duplicate invite-code collision on the unique index, a missing `ownerRole` lookup, anything — none of the prior writes in this transaction are visible outside it.
4. `await session.commitTransaction(); session.endSession();` — the transaction commits, and all three writes become atomically visible together, only once every one of them has succeeded.
5. The `catch` block is the abort path: `await session.abortTransaction(); session.endSession(); throw error;` — any failure anywhere in the `try` rolls back every write made under this session, and the original error is re-thrown so `asyncHandler` still forwards it to `errorHandler` exactly as it would for the non-transactional project path. From the controller's perspective, `createWorkspaceService` either fully succeeds or fully fails — there's no visible intermediate state where a workspace exists but its owner's membership doesn't.

The controller-level shape is identical between the two traces — parse, (maybe authorize), call one service function, shape the response, let `asyncHandler` catch anything that throws. The only structural difference is what happens *inside* the service: a bare sequence of awaits for project creation, a session-wrapped try/catch/finally-adjacent block for workspace creation. That's a deliberate point: the transaction is an implementation detail of the service function, invisible to (and not the concern of) the controller calling it.

## 5. Design Decisions & Tradeoffs

**Why a service layer at all, instead of Transaction Script directly in the controllers?** The clearest evidence is `getMemberRoleInWorkspace` itself: it's called, verbatim, from `project.controller.ts`, `task.controller.ts`, and `workspace.controller.ts` — three different domains' controllers, all resolving the same underlying question ("what role does this user hold in this workspace") through one shared function. Under a Transaction Script approach, either every one of those ~15 call sites re-implements that lookup inline, or the team reaches for some other shared-function mechanism anyway — at which point they've reinvented a service layer without naming it one. AstriX's actual shape avoids that: the lookup exists exactly once, in `member.service.ts`, and every controller that needs it imports the same function. The second, quieter benefit shows up in the test suite: `tests/unit/services/project.service.test.ts` calls `createProjectService` directly with plain arguments and asserts on its return value, with no `req`/`res` object, no HTTP layer, and no Express app booted at all. A Transaction Script equivalent would need Supertest firing a real request at a real route just to exercise the same logic.

**Why plain functions instead of classes with dependency injection?** Nothing in `services/*.service.ts` is a class; every export is a standalone `async` function that imports the Mongoose models it needs directly at the top of the file (`import ProjectModel from "../models/project.model"`, and so on) rather than receiving them as constructor arguments. What's gained is genuine: there's no DI container to configure, no interface to define and keep in sync with its one real implementation, no wiring code anywhere in the app — a new service function is just a new exported `async function`, full stop. What's given up is real too, but it's worth being precise about exactly what's lost, because the honest answer is narrower than "you can't test this without a real database." AstriX's own unit tests prove the opposite: `tests/unit/services/project.service.test.ts` calls `vi.mock("../../../src/models/project.model")` to replace the entire `ProjectModel` import with a mock, at the module level, before the service under test is ever imported — Vitest (like Jest) hoists that mock so every `import ProjectModel from "../models/project.model"` anywhere in the module graph, including inside `project.service.ts` itself, resolves to the fake. That's a real substitute for constructor injection, just implemented at the bundler/test-runner level instead of the language level — no fake needs to be threaded through a constructor because the module resolution itself is being swapped. What's genuinely lost is *type-level* substitutability: there's no `interface ProjectRepository` a reviewer can read to see the full contract a fake has to satisfy, and swapping `ProjectModel` for something that isn't Mongoose (a different ODM, a repository facade) would mean touching every service file that imports it directly, not reconfiguring one wiring point. For a single-ODM, single-database application with no near-term plan to swap Mongoose for anything else, that's a cost AstriX isn't currently paying for in practice — but it is the honest cost the DI-less choice carries, distinct from testability, which module-level mocking already covers.

**Why no repository/DAO layer between services and Mongoose models?** Every service function calls `ProjectModel.find(...)`, `WorkspaceModel.findById(...)`, and so on directly — Mongoose *is* the data-access layer here; there's no additional abstraction (`ProjectRepository.findById(...)`) sitting between the two. This is a genuine coupling: a service function and its query logic are inseparable, and changing from Mongoose to a raw MongoDB driver call, or to a different persistence technology entirely, would mean editing every service file rather than one repository implementation. But making a reflexive "should have used a repository pattern" call here would be wrong for this specific codebase. A repository layer earns its cost by buying one of two things: swappable persistence (not a live concern — MongoDB via Mongoose is the whole stack, with no stated plan to change it) or a seam for injecting fakes in tests (already covered, as shown above, by module-level mocking that requires no repository interface to exist). Neither payoff is currently being cashed in at AstriX's size, which means the repository layer would be pure ceremony today — a defensible judgment call at six domains and one deployable, not an oversight, and one worth revisiting only if either of those two justifications becomes real (a second persistence backend, or a testing pain point module mocking genuinely can't solve).

## 6. Security Considerations

The concrete question worth asking about any service layer is a trust-boundary one: when a service function runs, does it re-verify that the caller was actually allowed to do this, or does it simply trust that whoever called it already checked? AstriX's answer, checked directly rather than assumed, is that **services trust their caller completely**. Grepping every file in `services/` for `roleGuard` or `getMemberRoleInWorkspace` turns up exactly one hit — the definition of `getMemberRoleInWorkspace` itself, inside `member.service.ts` — and zero calls to either from within any service function. Grepping the same two symbols across `controllers/` shows the opposite: `roleGuard` is called from `task.controller.ts`, `workspace.controller.ts`, and `project.controller.ts`, and nowhere else. The permission check is real, and it runs on every route that needs one — but it lives entirely in the controller layer, never inside the service it calls.

That means the honest answer to "could a service function be called from a second, hypothetical route that forgot the permission check, and would the service itself stop it" is **no, it would not**. `createProjectService(userId, workspaceId, body)` will happily construct and save a `Project` document for any `workspaceId` it's given — it has no way to know whether the caller already confirmed that `userId` holds `CREATE_PROJECT` permission in that workspace, because it never asks. If a future engineer added a second route — an internal admin endpoint, a bulk-import script, a webhook handler — and wired it directly to `createProjectService` without first calling `getMemberRoleInWorkspace` and `roleGuard` the way every existing controller does, nothing downstream would catch the omission. This is the same structural gap file 01 of this curriculum already surfaced from the folder-organization angle (the authorization check is re-implemented per controller with no compiler-enforced guarantee it's present); from the service-layer angle, the sharper version of that same observation is that the service functions are not a backstop for a forgotten authorization check — they are pure orchestration that assumes it already happened.

The second, narrower question — whether any service accepts raw, unvalidated data from somewhere other than a controller, where the Zod validation boundary might be bypassed — has a clean answer in this codebase: no service file imports and calls another service file's exports (`grep -rn "from \"\.\./services/" backend/src/services/*.ts` returns nothing). The one apparent exception is intra-file, not cross-boundary: `registerUserService` calls `requestEmailVerificationService`, but both are defined in the same file, `auth.service.ts`, and the value passed — `user._id.toString()`, a MongoDB ObjectId minted moments earlier by the service's own `user.save()` call — was never raw client input to begin with; it never needed Zod validation because it isn't user-supplied. There is, in short, exactly one trust boundary in this codebase, and it sits between the controller and the service, not between services themselves. That makes the controller layer a genuinely load-bearing security boundary, not a formality — every route file's author is implicitly responsible for calling `roleGuard` correctly, because nothing further down the call stack will catch it if they don't.

## 7. Best Practice Check

As of 2026, a Service Layer over a thin-controller boundary remains a thoroughly standard, defensible choice for a CRUD-shaped Node/TypeScript API — this isn't a dated pattern being carried forward out of habit; it's still what a majority of production Express, Fastify, and NestJS-service-layer codebases at AstriX's scale actually do, and the reasoning in section 5 (isolatable testing, one shared home for cross-domain logic like `getMemberRoleInWorkspace`) holds up as well in 2026 as it did when Fowler first named the pattern. Where the industry conversation has moved is narrower and more specific than "should you use a service layer": it's about *when* richer domain modeling (option (c) from section 1) starts paying for itself. That inflection point isn't about codebase size in the abstract — it's about whether the same business rule starts getting enforced, independently, in more than one service function, which is exactly the kind of drift a service layer with anemic models is structurally exposed to (nothing stops two services from each reimplementing "can this workspace be deleted" slightly differently).

Does AstriX show early signs of needing that yet? Weakly, and worth naming plainly rather than either dismissing or overstating it. The clearest candidate is the "owner can't be removed/changed/left-without-transfer" rule, which appears as its own explicit guard in three separate places in `workspace.service.ts`: `changeMemberRoleService` (`workspace.owner.equals(...)` → `BadRequestException`), `removeMemberFromWorkspaceService` (the identical check, same exception type, same message pattern), and implicitly in `deleteWorkspaceService`'s ownership check (`ForbiddenException` if the caller isn't the owner — a related but distinct rule). Today these three checks are consistent with each other and simple enough that duplication hasn't yet caused drift — but this is precisely the shape of rule that a `Workspace.assertCanRemoveMember(targetUserId)` domain method, per section 1(c), would collapse into one place instead of three, catching a future edit that updates one copy and not the others before it ships. That's a real, concrete "starting to pay for domain modeling" signal, not a hypothetical one — but at three call sites, still consistent, in a six-domain application, it's a note for the future, not a present-tense gap. Everything else in the service layer — the single-collection CRUD in `project.service.ts`, the straightforward count-based analytics in both `project.service.ts` and `workspace.service.ts` — is squarely inside what a plain Service Layer handles well, with no visible strain.

## 8. Debug Drill

**Scenario:** two different service functions are each supposed to enforce the same business rule — say, "only the workspace owner can do X" — but a bug report claims the rule behaves differently depending on which action the user takes: it correctly blocks one action for a non-owner, but incorrectly allows (or incorrectly blocks) another. No stack trace, just a behavioral inconsistency between two code paths that are supposed to agree. Where do you look first, and why — as a transferable exercise for any service-layer backend, not sourced from any specific incident in this one?

1. **Find every place the rule is actually implemented, not just the two the bug report names.** In a service layer built from plain functions rather than domain methods, the same conceptual rule can easily exist as N separate, textually-similar-but-not-identical `if` blocks — exactly the pattern section 7 flagged for AstriX's owner-protection checks. Grep across `services/*.service.ts` for the entity field the rule hinges on (`.owner.equals(`, in AstriX's case) rather than trusting that the bug report's two named functions are the only two places the rule lives. The bug is as likely to be a *third*, unmentioned copy of the rule as it is to be either of the two the report calls out.
2. **Diff the guard conditions, not just their error messages.** Two copies of "is this user the owner" can look identical at a glance — same `NotFoundException`/`BadRequestException` shape, same rough wording — while differing in something that matters: one compares `workspace.owner.equals(new mongoose.Types.ObjectId(targetUserId))`, the other compares raw strings without the `ObjectId` wrap; one checks the rule before a database lookup that could itself throw for an unrelated reason, the other checks it after. A type mismatch (string vs. `ObjectId` comparison) or an ordering difference is the single most common way "the same rule" silently diverges between two hand-written copies.
3. **Check whether the two service functions are even receiving the same shape of data from their respective controllers.** Because there's no shared DTO layer forcing every caller of "the owner-check" to pass identical argument shapes, it's entirely possible one controller resolves `targetUserId` from `req.params.userId` while another resolves an equivalent value from a request-body field with a different name (compare `removeWorkspaceMemberController`'s `userIdSchema.parse(req.params.userId)` against `changeWorkspaceMemberRoleController`'s `changeRoleSchema.parse(req.body)` in this file's section 3.3 — same underlying concept, two different sources). A rule that's correctly implemented can still misbehave if the value reaching it was extracted from the wrong place one layer up.
4. **Only once the duplication and the data source are both confirmed identical (or the actual discrepancy between them is found) does a genuine logic bug in one specific copy become the remaining explanation.** Resist fixing the visibly "wrong" copy in isolation — if the root cause is that the rule exists in two or three places at all, the durable fix is consolidating them (a shared assertion function, or, if the pattern keeps recurring, migrating that specific rule onto the entity itself as a domain method per section 1(c)), not just correcting the one instance the bug report happened to name. Patching the symptom leaves the next copy free to drift again the same way.

The transferable lesson: in a service layer built from plain, independent functions rather than shared domain methods, "the same rule behaves differently in two places" is rarely a logic bug in one function — it's usually evidence that the rule was never actually shared code to begin with, just two authors independently agreeing, for a while, on what the rule should say.
