# AstriX — Deep Application Architecture



---

## 1. What AstriX Is

AstriX is a **multi-tenant workspace/project-management SaaS** (Jira/Asana-style). The core domain hierarchy is:

```
User ──< Member >── Workspace ──< Project ──< Task
              │
              └── Role (OWNER / ADMIN / MEMBER, each with a Permission[] array)
```

- A **User** can belong to many **Workspaces** via a **Member** join-document that carries a **Role**.
- A **Workspace** owns many **Projects**.
- A **Project** owns many **Tasks**.
- Every write operation is authorized against the caller's **Role → Permissions** for that specific workspace — authorization is workspace-scoped, not global.

---

## 2. High-Level System Diagram

```
                         ┌─────────────────────────────┐
                         │        Browser (SPA)        │
                         │  React + Vite + TS client   │
                         └──────────────┬───────────────┘
                                        │ HTTPS
                     ┌──────────────────┼───────────────────┐
                     │                                       │
             ┌───────▼────────┐                    ┌─────────▼─────────┐
             │   CloudFront    │                    │  Application Load  │
             │   + S3 (static  │                    │  Balancer (ALB)    │
             │   frontend)     │                    │  :80 → :443        │
             └─────────────────┘                    └─────────┬──────────┘
                                                                │
                                                     ┌──────────▼──────────┐
                                                     │   ECS Fargate task   │
                                                     │  (Express + TS API)  │
                                                     └──────────┬──────────┘
                                                                │
                                          ┌─────────────────────┼─────────────────────┐
                                          │                                           │
                                ┌──────────▼──────────┐                    ┌───────────▼───────────┐
                                │   MongoDB (Atlas /   │                    │  SSM Parameter Store   │
                                │   external, not in   │                    │  (env vars / secrets,  │
                                │   this repo's infra) │                    │  KMS-encrypted)        │
                                └──────────────────────┘                    └────────────────────────┘
```

Frontend and backend are deliberately **not** served through the same edge: the frontend goes through CloudFront→S3, while the API is hit **directly** on the ALB. This is a documented, intentional decision (see `infra/environments/dev/bootstrap.tf`) made specifically to avoid cookie/CORS complications that arise when a CDN sits in front of a cookie-based auth API.

---

## 3. Repository Layout (top level)

```
AstriX/
├── backend/          Express + TypeScript REST API
├── client/            React + TypeScript + Vite SPA
├── infra/              Terraform IaC (AWS) + deploy scripts
├── .github/workflows/   5 CI/CD pipelines (build check, deploy x2, infra, rollback)
├── docs/                Architecture/Auth/Data/Environment docs 
├── README.md
└── TODO.md              Self-authored security TODO (see the Security Concerns and Roadmap documents)
```

Each of `backend/` and `client/` is its own independent Node project (own `package.json`, own `tsconfig.json`) — this is a **monorepo without workspace tooling** (no Turborepo/Nx/pnpm workspaces). That's worth knowing: there's no shared `types` package, so contract types (e.g. `Permissions`, `TaskStatusEnum`) are hand-duplicated between `backend/src/enums/role.enum.ts` and `client/src/constant/index.ts`. It works today because both are small enough to keep in sync manually, but it's the first thing that will bite you as the domain model grows (see the Security Concerns and Roadmap documents).

---

## 4. Backend Architecture Summary (see Doc 2 for full detail)

Layered, Express-idiomatic:

```
Route → (rate limiter / passport JWT middleware) → Controller → Service → Mongoose Model → MongoDB
                                                        │
                                                        ▼
                                              Zod validation schemas
                                                        │
                                                        ▼
                                              roleGuard() permission check
```

- **57 backend source files**, ~3.7k LOC.
- Controllers are thin — they parse/validate input with Zod, call a service, shape the HTTP response. No business logic lives in controllers.
- Services own all business logic and all Mongoose queries. Nothing outside `services/` touches a Mongoose model directly except a couple of read-only lookups in controllers for `roleGuard` checks.
- Auth is **stateless JWT** (access token, 15 min) + **stateful refresh** (refresh token in an httpOnly cookie, backed by a `Session` document in Mongo so it can be revoked).

## 5. Frontend Architecture Summary (see Doc 3 for full detail)

- **119 source files**, ~11.1k LOC — the larger half of the codebase.
- React Router v6 with three route trees: `baseRoutePaths` (public), `authenticationRoutePaths` (guarded by `AuthRoute`, redirects logged-in users away), `protectedRoutePaths` (guarded by `ProtectedRoute`, redirects logged-out users to `/sign-in`).
- Server state lives in **TanStack Query**; the only client-only state is authentication (`Zustand`, deliberately **not persisted** — access token lives in memory only, see Doc 3 and the Security Concerns and Roadmap documents).
- UI is built on **shadcn/ui** primitives (Radix + Tailwind) — `components/ui/*` is essentially a vendored component library, not hand-rolled.
- Permission-aware rendering exists at three levels: route guard (`ProtectedRoute`), component guard (`<PermissionsGuard>`), and full-page HOC (`withPermission()`).

## 6. Infrastructure Summary (see Doc 4 for full detail)

Real, working Terraform against AWS — not a toy:

```
networking → security → iam → ecr ↘
                                    alb → acm → parameter_store → ecs
                                                                     ↘
                                                              cloudfront_s3
```

9 Terraform modules, one `dev` environment, S3+DynamoDB remote state, GitHub OIDC federation for CI/CD (no long-lived AWS keys in GitHub Secrets), and 5 GitHub Actions workflows covering PR checks, backend deploy, frontend deploy, infra apply, and a dedicated rollback workflow that can re-point ECS/CloudFront at an arbitrary prior commit SHA.

## 7. Request Lifecycle — Worked Example

To make the architecture concrete, here's exactly what happens when a logged-in user creates a task:

1. **Client**: `create-task-form.tsx` collects input via `react-hook-form` + a Zod resolver, calls a mutation from `hooks/api/*` which calls `lib/api.ts`'s `createTaskMutationFn`.
2. **Axios interceptor** (`lib/axios-client.ts`) attaches `Authorization: Bearer <accessToken>` from the in-memory Zustand store.
3. **Express**: request hits `POST /api/task/workspace/:workspaceId/project/:projectId/create`, passes through `passportAuthenticateJWT` (validates the access token, loads the user, checks the `Session` document is still valid).
4. **Controller** (`task.controller.ts`): parses body against `createTaskSchema` (Zod), pulls `userId` off `req.user`, calls `getMemberRoleInWorkspace()` then `roleGuard(role, [Permissions.CREATE_TASK])`.
5. **Service** (`task.service.ts`): verifies the project belongs to the workspace, verifies `assignedTo` (if present) is actually a member of the workspace, constructs and saves the `Task` document.
6. **Response**: controller returns `201` with the created task; TanStack Query's mutation `onSuccess` invalidates the relevant query keys, triggering a refetch that updates the task table.

This same pattern — validate → authorize → delegate to service → mutate → invalidate query cache — repeats consistently across workspace, project, member, and task operations. It's the strongest structural asset in the codebase: predictable, easy to extend, easy to onboard a second engineer to.

## 8. Where the Architecture Is Thin


- **No test suite anywhere** in the repo (backend or frontend) — the single biggest structural gap relative to the rest of the architecture's maturity.
- **No real-time layer** — everything is request/response; two users editing the same board don't see each other's changes without a manual refetch.
- **No shared-types package** between backend and frontend — enum/type duplication as noted above.

- **Single environment** (`infra/environments/dev` only) — no `staging`/`prod` environment folder yet, so there's no tested path for promoting a build beyond dev.

These are addressed in detail, with concrete next steps, in the Security Concerns and Roadmap documents.