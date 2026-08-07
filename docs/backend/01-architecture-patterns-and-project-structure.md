# Backend Architecture Patterns & Project Structure

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

## 1. The Landscape

Every backend eventually answers the same question, whether or not anyone in the room ever asks it out loud: **when a new piece of business logic needs a home, which folder does it go in, and why that one?** The answer a team lands on — usually early, usually by accident, rarely revisited — shapes everything downstream: how long it takes a new engineer to find the code for a bug report, how easy it is to delete a feature cleanly, how tempting it is to reach across a boundary that was never actually enforced, and how painful (or trivial) it eventually is to split a monolith into services. This is the folder-organization problem, and it has a handful of real, named, well-trodden answers. None of them is "correct" in the abstract — each is a bet about what kind of change your team will make most often, and about how big the system will get before someone has to reorganize it.

Below are four of the most common answers you'll actually meet in production codebases, roughly ordered from "simplest to explain to a junior engineer" to "most ceremony, strongest guarantees." AstriX uses the first one. Understanding the other three is what lets you open somebody else's backend — a Go service, a NestJS app, a DDD-flavored Java monolith — and know where to look before you've read a single file.

### (a) Layered / N-tier architecture

This is the pattern most engineers meet first, often without being told it has a name. The codebase is organized by **technical role**: every file that handles HTTP routing lives in one folder, every file that contains request-handling logic lives in another, every file that contains business rules lives in a third, every file that touches the database lives in a fourth. A request flows downward through the layers — route → controller → service → model — and each layer only knows about the layer directly below it.

A generic, idealized sketch (not AstriX's actual tree — just the shape of the pattern):

```
src/
├── routes/
│   ├── user.routes.ts
│   ├── order.routes.ts
│   └── product.routes.ts
├── controllers/
│   ├── user.controller.ts
│   ├── order.controller.ts
│   └── product.controller.ts
├── services/
│   ├── user.service.ts
│   ├── order.service.ts
│   └── product.service.ts
└── models/
    ├── user.model.ts
    ├── order.model.ts
    └── product.model.ts
```

Notice the axis of organization: it's the *tier* (routes, controllers, services, models), not the *domain* (user, order, product). Every domain gets one file per tier, and those files are physically far apart — `user.route.ts` and `user.service.ts` might be four directory levels apart in a listing, separated by every other domain's route and controller files.

This is the default in a huge fraction of production Express and Spring codebases, and it's close to what Go's community-standard project layout (the widely-referenced, if unofficial, `golang-standards/project-layout`) recommends for HTTP services, and what a default Spring Boot tutorial or Rails MVC app assumes without discussion. It's popular because it's the easiest pattern to explain in one sentence and the easiest to onboard a junior engineer into — "HTTP stuff goes in routes, request-shaping goes in controllers, business logic goes in services, database stuff goes in models" is a rule anyone can apply immediately, without first learning the codebase's domain vocabulary.

The tradeoff is the one this whole chapter is about: a **layered** structure organizes for "what kind of code is this," not "what feature does this belong to." That means touching one feature — even a small one — routinely means opening several folders at once, and nothing in the folder structure itself stops one domain's service from reaching directly into another domain's model. The isolation, if it exists at all, is a matter of team discipline, not something the compiler or the directory tree enforces.

### (b) Feature-based / vertical-slice architecture

Here the axis of organization flips: instead of grouping by technical role, you group by **feature or domain**. Everything needed to implement "projects" — its route, its controller, its service, its model, sometimes its own validation schema — lives together in one folder. A change to the project feature touches one folder, or close to it.

```
src/
├── features/
│   ├── users/
│   │   ├── user.routes.ts
│   │   ├── user.controller.ts
│   │   ├── user.service.ts
│   │   └── user.model.ts
│   ├── orders/
│   │   ├── order.routes.ts
│   │   ├── order.controller.ts
│   │   ├── order.service.ts
│   │   └── order.model.ts
│   └── products/
│       ├── product.routes.ts
│       ├── product.controller.ts
│       ├── product.service.ts
│       └── product.model.ts
└── shared/
    ├── middleware/
    └── utils/
```

NestJS is the clearest mainstream example of a framework that actively pushes teams toward this shape — its module system (`@Module()`, with each module declaring its own controllers and providers) is designed so that "the users module" is a real, importable, self-contained unit rather than a convention people have to remember to follow. You'll also see this pattern under the name "vertical slice architecture," a term popularized in the .NET community (associated with Jimmy Bogard's writing on the subject) for the same idea: slice the system by use case, not by technical layer.

The upside is contained blast radius: deleting the "orders" feature is close to deleting one folder, and a new engineer working on orders never has to learn what's in `users/` or `products/` to be productive. The downside is that cross-cutting concerns — auth checks, logging, a shared "who can see this resource" rule — don't have an obvious single home anymore. Either they get duplicated per feature (three slightly-different copies of "check the user is a workspace member"), or the team ends up building a `shared/` folder that slowly regrows into its own de facto layered structure. Feature-based also doesn't, by itself, stop one feature's service from importing another feature's model directly — it makes that reach *more visible* (you can see the cross-folder import) but doesn't prevent it.

### (c) Hexagonal / ports-and-adapters architecture

Hexagonal architecture — sometimes called "ports and adapters" — starts from a different question entirely: not "how do I group my files" but "how do I stop my business logic from knowing it's running inside Express, or talking to MongoDB, or being called over HTTP at all." The pattern was originally described by Alistair Cockburn in the early 2000s specifically to solve the problem of business logic becoming entangled with the technology used to expose or persist it.

The core idea: your domain logic defines **ports** — plain interfaces describing what it needs ("a way to save a user," "a way to send an email") — and the outside world provides **adapters** that implement those ports for a specific technology (an Express route is an adapter for "HTTP in," a Mongoose repository is an adapter for "persistence out"). The domain never imports Express or Mongoose directly; it only imports its own port interfaces.

```
src/
├── domain/
│   ├── user/
│   │   ├── user.entity.ts
│   │   ├── user.service.ts          # pure business logic
│   │   └── user.repository.port.ts  # interface only, no implementation
│   └── order/
│       └── ...
├── adapters/
│   ├── http/
│   │   └── user.controller.ts       # implements the "driving" side
│   └── persistence/
│       └── mongo-user.repository.ts # implements user.repository.port.ts
└── app/
    └── wiring.ts                    # composition root: wires adapters to ports
```

This pattern shows up a lot in DDD-flavored Node and Java backends, and in any codebase where a team has been burned by "we need to swap the database" or "we need to unit-test business logic without spinning up a real database" often enough to invest in the isolation up front. The payoff is real: the domain layer can be tested with zero infrastructure, and swapping MongoDB for Postgres, in theory, only touches the adapters folder. The cost is also real — it's the steepest learning curve of the four patterns here, it introduces interfaces and dependency-injection wiring that a small team may never actually need (because they're never actually going to swap the database), and it's easy to over-engineer: teams sometimes adopt hexagonal ceremony for a CRUD app that will never see a second adapter for any port, paying the abstraction tax without ever cashing in the benefit.

### (d) Clean Architecture / Onion Architecture

Clean Architecture (Robert C. Martin's formulation) and Onion Architecture (Jeffrey Palermo's earlier, closely related formulation) are close cousins of hexagonal, usually drawn as concentric circles rather than a hexagon. The organizing idea is **the dependency rule**: source code dependencies can only point inward. The innermost ring (entities — the core business objects and rules) knows about nothing else in the system. The next ring out (use cases / application logic) knows about entities but not about anything further out. The outer rings (interface adapters, then frameworks/drivers — your web framework, your ORM, your UI) know about the rings inside them, never the reverse.

```
src/
├── entities/            # innermost: pure business objects, no framework imports
│   └── user.entity.ts
├── use-cases/           # application-specific business rules
│   └── register-user.usecase.ts
├── interface-adapters/  # controllers, presenters, gateways
│   └── user.controller.ts
└── frameworks/          # outermost: Express, Mongoose, config
    └── express-server.ts
```

In practice this looks and behaves a lot like hexagonal — the folder tree is different, but the enforcement mechanism is the same idea (an import-direction rule) applied more granularly, with more named rings. You'll see it most often in codebases where the team has explicitly read Uncle Bob's book or blog post and adopted its vocabulary, often in larger Java/C# enterprise systems, and increasingly in TypeScript backends that want strict testability guarantees without going all the way to a full hexagonal port/adapter split. The tradeoffs mirror hexagonal's: strong isolation from any specific framework or database, at the cost of more files, more indirection, and a real onboarding cost for engineers who haven't seen the pattern before — a small team shipping a straightforward CRUD product often finds the ceremony costs more than the isolation is worth.

### The honest summary

| Pattern | Organizes by | Strongest guarantee | Steepest cost |
|---|---|---|---|
| Layered / N-tier | technical role | simple, predictable, fast to onboard | touching one feature means opening N folders; no folder boundary stops cross-domain reach |
| Feature-based / vertical-slice | domain/feature | contained blast radius per feature | cross-cutting logic has no obvious home; can duplicate per feature |
| Hexagonal / ports-and-adapters | dependency direction (domain vs. infrastructure) | domain logic is framework- and DB-agnostic, trivially unit-testable | steep learning curve, real ceremony, easy to over-build for a small team |
| Clean / Onion | dependency direction (concentric rings) | same as hexagonal, more explicit rings | same as hexagonal — more files, more indirection |

None of these is free. A team's job is picking the one whose cost matches the problem they actually have, not the one that sounds most sophisticated in a design doc.

## 2. AstriX's Choice

AstriX is **layered / N-tier**, organized by technical role, not by domain. There is one `routes/` folder holding every domain's route file, one `controllers/` folder holding every domain's controller, one `services/` folder holding every domain's business logic, and one `models/` folder holding every Mongoose schema — with no per-domain subfolder inside any of them, and no ports/adapters or entities/use-cases split anywhere in the tree.

## 3. AstriX Implementation

Here is the actual top-level listing of `backend/src/`, produced by `find backend/src -maxdepth 1 | sort`:

```
backend/src
backend/src/@types
backend/src/config
backend/src/controllers
backend/src/docs
backend/src/enums
backend/src/index.ts
backend/src/middlewares
backend/src/models
backend/src/providers
backend/src/routes
backend/src/seeders
backend/src/services
backend/src/utils
backend/src/validation
```

Fifteen entries at the top level, and — this is the whole chapter in one sentence — not one of them is named after a domain. There's no `projects/`, no `tasks/`, no `workspaces/`. Instead there's `routes/`, `controllers/`, `services/`, `models/`, `validation/`, each holding one file per domain side by side. To see what that means in practice, follow "the project feature" through all five of them — the same code a request actually runs through, pasted in full, not summarized.

**The route** — `projectRoutes` is one of six sibling files in `routes/`, indistinguishable in the directory listing from `task.route.ts` or `workspace.routes.ts` sitting right next to it:

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

Nothing in this file contains any business logic at all — it's purely a table mapping HTTP verb + path to a controller function imported from an entirely different top-level folder.

**The controller** — one folder over, `project.controller.ts` sits alphabetically between `member.controller.ts` and `task.controller.ts` in `controllers/`, with no folder boundary separating it from either:

```ts
// backend/src/controllers/project.controller.ts:1-39
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
```

Already, in the first exported function of the controller, there are imports from four different sibling top-level folders: `middlewares/`, `validation/`, `services/`, `utils/`, `enums/`, `config/` — six, actually, counting each. A single "create a project" request handler is, by construction, a fan-out across the entire top-level tree.

**The service** — `services/project.service.ts`, holding the actual business logic and Mongoose orchestration:

```ts
// backend/src/services/project.service.ts:1-27
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
```

**The validation schema** — `validation/project.validation.ts`, the Zod definitions the controller called `.parse()` against above:

```ts
// backend/src/validation/project.validation.ts:1-16
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
```

**The model** — `models/project.model.ts`, the Mongoose schema `ProjectModel` (imported by the service above) is actually defined against:

```ts
// backend/src/models/project.model.ts:1-47
import mongoose, { Document, Schema } from "mongoose";

export interface ProjectDocument extends Document {
  name: string;
  description: string | null; // Optional description for the project
  emoji: string;
  workspace: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<ProjectDocument>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    emoji: {
      type: String,
      required: false,
      trim: true,
      default: "📊",
    },
    description: { type: String, required: false },
    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// getProjectsInWorkspaceService lists/paginates by workspace on every call.
projectSchema.index({ workspace: 1 });

const ProjectModel = mongoose.model<ProjectDocument>("Project", projectSchema);
export default ProjectModel;
```

Five files, five different top-level folders, to fully account for "how does creating a project work." That's not a criticism dressed up as description — it's the literal, observable shape of a layered structure, and it's worth sitting with before section 5 discusses whether it's the right call for AstriX specifically.

## 4. Request/Data Flow

Trace an actual `POST /api/project/workspace/:workspaceId/create` request through the five files pasted above, in the order execution actually visits them:

1. **`backend/src/index.ts:227`** mounts the project router behind `authenticate`: `app.use(`${BASE_PATH}/project`, authenticate, projectRoutes);`. Before any project-specific code runs at all, the request passes through `middlewares/auth.middleware.ts` — a sixth folder, outside the five already listed — which verifies the bearer JWT, loads the `User` and `Session` documents, and attaches `req.user` and `req.session`. (Full trace of `authenticate` itself belongs to [02-authentication-and-authorization.md](./02-authentication-and-authorization.md); it's noted here only because it's a mandatory hop before the project code below ever executes.)

2. **`routes/project.route.ts:12`** matches `POST /workspace/:workspaceId/create` and calls `createProjectController` — imported from `../controllers/project.controller`, i.e. the route file itself contains zero logic, only a lookup table pointing into a different folder.

3. **`controllers/project.controller.ts:23-39`**, `createProjectController`, runs next, wrapped by `asyncHandler` (`middlewares/asyncHandler.middleware.ts:13-21` — a seventh folder), which exists purely so a thrown exception inside the async controller body is forwarded to `next(error)` instead of becoming an unhandled promise rejection. Inside the controller:
   - Line 25: `createProjectSchema.parse(req.body)` — validates the request body against the Zod schema pasted in section 3 above, from `validation/project.validation.ts`.
   - Line 26: `workspaceIdSchema.parse(req.params.workspaceId)` — a *different* domain's validation schema (`validation/workspace.validation.ts`), imported because a project always lives inside a workspace and the workspace ID needs its own shape check.
   - Line 29: `getMemberRoleInWorkspace(userId, workspaceId)` — this is not a project function at all. It's imported from `services/member.service.ts`, an entirely different domain's service file, and it's the mechanism by which the project controller finds out what role the requesting user holds in this workspace.
   - Line 30: `roleGuard(role, [Permissions.CREATE_PROJECT])` — from `utils/roleGuard.ts`, throws `ForbiddenException` if the role's permission set (defined in `utils/role-permission.ts`) doesn't include `CREATE_PROJECT`.
   - Line 32: `createProjectService(userId, workspaceId, body)` — finally, the actual project-domain service function is called.

4. **`services/project.service.ts:7-27`**, `createProjectService`, constructs a `new ProjectModel({...})` — the model imported from `models/project.model.ts`, an eighth folder relative to where this trace started — and calls `project.save()`, which is the point the request first actually touches MongoDB.

5. Control returns up the call stack unchanged: service returns `{ project }` to the controller (line 32), the controller shapes the HTTP response (`res.status(HTTPSTATUS.CREATED).json({...})`, lines 34-37), and if anything anywhere in that chain had thrown, `asyncHandler` would have forwarded it to the centralized `errorHandler` mounted in `index.ts` (full mechanics in [04-error-handling-patterns.md](./04-error-handling-patterns.md)) instead of any layer needing its own try/catch.

Count the distinct top-level folders a single `POST` request to create a project actually executes code from, start to finish: `middlewares/` (twice — `auth.middleware.ts` and `asyncHandler.middleware.ts`), `routes/`, `controllers/`, `validation/` (twice — project's own schema and workspace's), `services/` (twice — project's own service and member's), `utils/` (`roleGuard.ts`), `enums/` (`Permissions`), `config/` (`HTTPSTATUS`), and `models/`. That's eight distinct top-level folders for what is, conceptually, one simple write. This is not a flaw unique to AstriX's implementation — it is the structural signature of layered architecture, visible in this trace precisely because the trace was written down instead of taken on faith.

## 5. Design Decisions & Tradeoffs

Layered is a defensible choice for AstriX at its actual size. The domain count is small and stable — projects, tasks, workspaces, members, users, auth — a handful, not dozens, and nothing in the codebase or its infra setup (a single Express container, one Mongo connection, no service mesh, no per-domain deploy pipeline) suggests any near-term plan to extract individual domains into separate services. Layered architecture's core weakness — that it gets harder to navigate as the *number of domains* grows, because each folder accumulates one more file per domain and the "which five files do I need for feature X" search gets noisier — simply hasn't had room to bite yet at six domains. A team of AstriX's size benefits far more from the layered pattern's actual strength: total predictability. Any engineer, on day one, without knowing anything about "projects" or "tasks" as concepts, knows that request-shaping logic is in `controllers/`, business rules are in `services/`, and persistence is in `models/`. That predictability is worth something real, and it's not free in a feature-based layout, where a newcomer has to first learn *which* feature folder to look in before they can apply any rule at all.

What AstriX gave up by not choosing feature-based is worth stating plainly rather than hand-waving: **nothing in the folder structure stops one domain's service from importing another domain's model directly**, and this isn't hypothetical — it's the observable state of the actual codebase. A grep across `backend/src/services/*.service.ts` for model imports shows it happening routinely:

```
backend/src/services/task.service.ts:3:import ProjectModel from "../models/project.model";
backend/src/services/workspace.service.ts:12:import TaskModel from "../models/task.model";
backend/src/services/workspace.service.ts:14:import ProjectModel from "../models/project.model";
backend/src/services/user.service.ts:6:import TaskModel from "../models/task.model";
backend/src/services/user.service.ts:7:import WorkspaceModel from "../models/workspace.model";
```

`task.service.ts` reaches directly into `ProjectModel`; `workspace.service.ts` reaches into both `TaskModel` and `ProjectModel`; `user.service.ts` reaches into `TaskModel` and `WorkspaceModel`. None of this goes through the task domain's or project domain's own service layer first — it's a direct Mongoose query against another domain's schema, from inside a service file that, by its filename, belongs to a different domain entirely. In a feature-based layout this same cross-domain dependency would still be *possible* (nothing about feature folders makes an import illegal at the language level), but it would at minimum be more visible — a `../orders/order.model` import sitting inside `features/users/user.service.ts` reads, on sight, as a cross-boundary reach in a way that `../models/order.model` sitting inside `services/user.service.ts` does not, because in the layered tree *every* model import looks identical regardless of which domain it crosses into. The boundary AstriX is missing isn't enforced by either pattern automatically — but layered makes the violation genuinely harder to spot by eye, which is the real cost being paid here, distinct from (and more concrete than) the more commonly cited "you have to open five folders" complaint.

The upside AstriX gets in return is real too: it never had to design a cross-cutting concern's home. `authenticate` lives in one place and is applied at the router-mount level in `index.ts`, not duplicated per feature; `roleGuard` and the `RolePermissions` table live in one place and are called identically by every controller that needs an authorization check. A feature-based rewrite of AstriX would have had to make an explicit decision about where that logic lives — a `shared/` folder, a dedicated auth module every feature imports, or (worse) a slightly different copy of the permission check per feature — and that decision has its own failure modes, discussed further in [02-authentication-and-authorization.md](./02-authentication-and-authorization.md).

## 6. Security Considerations

Project-structure choice is not itself an authentication mechanism, but it materially changes how easy a security review is to conduct, and how easy it is to get right by accident versus by design. In AstriX's layered structure, "everything that touches auth" is not one folder — it's scattered across at least four: `middlewares/auth.middleware.ts` (the JWT/session guard applied at router-mount time), `services/auth.service.ts` (login, registration, token issuance, session creation), `providers/google.provider.ts` (the OAuth adapter), and `utils/jwt.ts` plus `utils/roleGuard.ts` (token verification and permission checks respectively). A reviewer trying to answer "show me the complete auth surface of this application" cannot get that answer from `ls backend/src/` — none of those five files are adjacent, and nothing about the top-level tree signals that they're related at all. They have to already know the domain well enough to know which files, across which folders, to go collect.

That has two concrete consequences worth naming rather than leaving implicit. First, it raises the floor for how much codebase familiarity a security review requires — a reviewer new to AstriX has to build a mental map of "where auth lives" before they can audit it, a step a feature-based or hexagonal layout would largely hand them for free (in hexagonal specifically, the auth "port" would be one interface with a small, enumerable set of implementations). Second, and more concretely dangerous, is what section 4's trace already demonstrated in miniature: the actual authorization check for a request — `getMemberRoleInWorkspace` plus `roleGuard(role, [Permissions.X])` — is not centralized behind a single middleware in AstriX. It's called explicitly, inline, inside every individual controller function that needs it (visible in every one of `createProjectController`, `getAllProjectsInWorkspaceController`, `updateProjectController`, and `deleteProjectController` in the pasted code above — each repeats the same two-line pattern with a different `Permissions` value). That pattern works today because every existing controller remembered to include it. But nothing in the layered structure *enforces* that a new route added six months from now, in a hurry, by an engineer unfamiliar with the convention, includes the same two lines — there's no folder boundary, no shared base controller, and no compiler error that fires if one route file's author simply forgets. A feature-based or hexagonal structure doesn't automatically fix this either (the same forgetting is possible in either), but it does make "the authorization seam" a more singular, auditable thing to point at and say "this is the one place that decides who can do what" — in AstriX today, that decision is re-made, correctly so far, in each of ~20 individual controller functions across `controllers/*.controller.ts`.

## 7. Best Practice Check

As of 2026, the industry conversation around this exact tradeoff has largely converged on a middle position rather than a strict pick-one-of-four answer: many teams now favor what's commonly called a **"modular monolith"** — feature-based folders internally (so a feature's code lives together and its blast radius is contained), while still shipping as one deployable, one database connection pool, one process. The appeal is pragmatic: it gives most of feature-based's readability and contained-blast-radius benefits without paying hexagonal's or Clean Architecture's ceremony cost, and — critically — it keeps a real option open to split a feature module out into its own service later, *if* the system ever grows to the point where that's actually justified, without having pre-paid for microservice-grade isolation on day one when nobody yet knows which seams will actually need to become network boundaries.

Where does AstriX's pure-layered choice sit against that? For a system with AstriX's current domain count — six domains, one team, one deployable, no stated plan to split services — pure layered is still a reasonable, common choice, not a dated one; plenty of production Express/Mongoose backends this size are organized exactly this way in 2026, and the "modular monolith" trend is a recommendation for systems anticipating growth, not a verdict that layered is wrong at small scale. The honest gap to flag is forward-looking, not present-tense: if AstriX's domain count grew significantly — the file list in [00-master-backend-architecture.md](./00-master-backend-architecture.md)'s status table already enumerates roughly ten domains' worth of models and growing — the search cost of "which five files implement feature X" climbs roughly linearly with domain count, and the cross-domain-import risk demonstrated in section 5 gets more expensive to audit, not less. Fifteen or more domains sharing one flat `services/` folder, with no subfolder and no import-direction rule stopping any file from reaching into any other, is the point at which most teams making this tradeoff start feeling real pain and start migrating toward feature folders — an explicit modular-monolith reorganization, not a full hexagonal rewrite, would be the proportionate next step, and it's cheap to do incrementally (one domain's five files moved into one feature folder at a time) precisely because none of AstriX's current code depends on any dependency-injection wiring that a move like that would disturb.

## 8. Debug Drill

**Scenario:** A bug report comes in — "project creation is failing" — no stack trace, no request ID, just that one sentence. Where do you start looking, and how does the answer change depending on whether the backend in front of you is organized like AstriX (layered) or like a feature-based alternative? Work through this as a transferable exercise, using AstriX as the concrete example, not a specific incident.

**In a layered codebase (AstriX's actual shape):**

1. **Start at the boundary, not the domain.** Your first move isn't "open the projects folder" — there isn't one. It's `routes/project.route.ts`, to confirm the route exists and is wired to the controller function you expect (`POST /workspace/:workspaceId/create` → `createProjectController`, per section 3 above). This step is fast in a layered codebase specifically because routing is centralized and small — one file, one domain, easy to scan end to end.
2. **Follow the import, not the folder, into `controllers/project.controller.ts`.** Read `createProjectController` top to bottom exactly as pasted in section 3: request-body validation (`createProjectSchema.parse`), workspace-ID validation, the `getMemberRoleInWorkspace` + `roleGuard` authorization check, then the call into `createProjectService`. In a layered structure, this is the step where you're most likely to get pulled sideways into a *different* folder than the one the bug report is nominally about — "project creation is failing" might actually be a `member.service.ts` problem (the role lookup) or a `roleGuard`/`role-permission.ts` problem (the permission check), not a `project.service.ts` problem at all. That sideways pull is the direct, lived consequence of section 4's trace: a single project request already touches eight top-level folders, so "failing in project creation" is genuinely ambiguous about which of those eight is actually at fault until you've read the controller.
3. **Only once the controller confirms which call is throwing do you go to that layer's service and, if needed, its model** — `services/project.service.ts` for the Mongoose `.save()` call itself (a schema validation error, a duplicate-key error, a missing required `workspace` reference), or `models/project.model.ts` if the failure is a schema-level constraint (e.g. the `required: true` on `workspace` or `createdBy`). Your first three moves in a layered codebase are therefore: **route file → controller file (reading every call it makes, not just the "project" ones) → whichever service the controller's trace actually points to** — and that third destination is discovered by reading, not assumed from the bug report's wording.

**In a feature-based codebase, for contrast:** your first move is different in kind, not just in file path — you'd open one folder, `features/projects/`, and every file relevant to project creation (route, controller, service, model) would already be sitting next to each other. You'd still have to read through the same logical chain — validation, authorization, service call, persistence — but you wouldn't have to leave the folder to do it, *unless* the bug turns out to be a cross-cutting concern like auth, in which case you'd still have to jump out to wherever that feature's codebase decided cross-cutting logic lives (a `shared/` folder, or a dedicated auth module). The debugging *logic* — validate inputs, check authorization, check the actual write — is identical either way; what changes is purely how many directory boundaries you cross to assemble the full picture, and in AstriX's case, section 4 already showed that number concretely: eight.

The transferable lesson: in any layered backend, "where do I start" is answered by the request's entry point (the route), not by the feature's name — because the feature's name doesn't map to a folder. Read the controller in full before assuming which downstream layer is at fault; the controller is where the layered structure's scattered pieces (validation, authorization, business logic) are stitched back together into one linear read, and it's the cheapest single file to read for a first diagnosis regardless of which of the eight folders the actual bug turns out to live in.
