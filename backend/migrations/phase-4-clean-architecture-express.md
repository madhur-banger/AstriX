# Phase 4 — Routes, Controllers, Services on Postgres + Redis (plain Express, no new layers)

> Part of the [migrations/](./PLAN.md) series. Assumes Phases
> [2](./phase-2-orm-setup-and-service-migration.md) and
> [3](./phase-3-redis-migration-and-ttl-data.md) are done — plain-function
> Postgres and Redis services already exist and are verified. This file:
> wiring those services up to HTTP, the same way the existing Mongo app
> already does it — `routes → controllers → services`, no new
> abstraction layer.

> **Revision note:** an earlier draft of this phase built a full
> domain/application/infrastructure/presentation clean-architecture split
> (repository interfaces, a composition root, manual dependency injection)
> for this app. That was cut. For a single-team, single-database CRUD app
> like this one, the interface indirection didn't pay for itself — every
> feature needed 5 files (entity, repository interface, repository
> implementation, service class, controller) to do what the Mongo app
> already does in 3 (model, service, controller), and the only real payoff
> (swap the database without touching business logic, or unit-test against
> a fake repository) isn't something this project has an actual near-term
> need for. See §4.5 below for what to reach for instead if that need shows
> up later. The plain version below is what's actually implemented.

---

## 4.1 The shape: identical to the Mongo app, different services underneath

```
src/
  controllers/pg/*.controller.ts   - same function names as controllers/*.ts,
                                      same asyncHandler wrapper, same shape
  routes/pg/*.route.ts             - same paths, same Router() calls
  validation/pg/*.validation.ts    - same Zod schema names, UUID instead of
                                      ObjectId regex
  services/pg/*.service.ts         - Phase 2's plain functions (extended in
                                      this phase to cover every feature)
  services/redis/*.service.ts      - Phase 3's plain functions
  middlewares/auth.pg.middleware.ts
  pg-app.ts, index.pg.ts           - a second Express app, its own port
```

No `domain/`, no `application/`, no `infrastructure/`, no `presentation/`,
no composition root, no repository interfaces. A controller imports a
service function directly and calls it — exactly what
`controllers/task.controller.ts` does today with `services/task.service.ts`.
The only structural difference from the Mongo app is a `pg/` subfolder
under `controllers/`, `routes/`, and `validation/` (mirroring the `pg/` and
`redis/` split Phase 2/3 already established under `services/`) so file
names don't collide with the Mongo app's, since both run in the same
process on different ports until Phase 6 cutover.

---

## 4.2 What Phase 2/3 left unfinished, and what this phase filled in

Phase 2/3 verified their services standalone (`scripts/verify-phase2-pg.ts`,
`scripts/verify-phase3-redis.ts`), not wired to any route — so several
functions the Mongo app actually needs were never written:

- **`services/pg/task.service.ts`**: added `updateTaskService` (Phase 2 had
  create/list/get/delete only).
- **`services/pg/workspace.service.ts`**: added
  `getAllWorkspacesUserIsMemberService`, `getWorkspaceByIdService`,
  `updateWorkspaceByIdService`, `resetWorkspaceInviteCodeService`,
  `removeMemberFromWorkspaceService` — Phase 2 only covered
  create/members/delete/analytics/change-role.
- **`services/pg/user.service.ts`**: added `updateProfileService`,
  `deleteAccountService` (with the same owned-workspace block and
  password-confirmation check as the Mongo original).
- **`services/pg/member.service.ts`**: new file — `getMemberRoleInWorkspace`,
  `joinWorkspaceByInviteService`. Phase 2 never touched workspace membership
  as its own feature.
- **`services/pg/auth.service.ts`**: new file — the full auth flow
  (register, login, OAuth login/link, refresh, logout, session listing,
  password reset, email verification, change password, session revocation),
  function-for-function against the Mongo original. Users/accounts/
  workspaces/roles live in Postgres; sessions and the single-use
  password-reset/email-verification tokens live in Redis via Phase 3's
  `services/redis/session.service.ts` and `token.service.ts`.
- **`services/redis/session.service.ts`**: added `createdAt` to the session
  hash (the Mongo session listing includes it; Phase 3's version didn't
  store it), plus `invalidateAllSessionsForUser` and
  `invalidateAllSessionsForUserExcept` — Redis has no bulk update, so these
  fan out one `invalidateSession` call per session instead of Mongo's
  `updateMany`.

Every one of these matches its Mongo counterpart's name, signature, and
return shape as closely as the storage engine allows. Where it can't match
exactly, the reason is a real one, not a style choice:

- `getUserByIdService` deliberately **excludes** `passwordHash` from its
  column selection (Postgres has no schema-level `select: false`, so this is
  explicit at the query instead of implicit in the model) and **throws**
  `NotFoundException` rather than returning null — same as the Mongo
  original's intent for a "safe profile" read. `verifyUserService`,
  `changePasswordService`, and `deleteAccountService` each do their own
  direct `db.select().from(users)...` instead, because they need the
  password hash.
- `invalidateSessionService` and `revokeSessionService` take a `userId`
  alongside `sessionId` where the Mongo versions only needed `sessionId` —
  Redis's session key layout (`session:{id}` plus a
  `user:{userId}:sessions` set) needs both to clean up correctly; Mongo's
  `findByIdAndUpdate` didn't need the owning user at all.

---

## 4.3 Auth: what changed under the hood, what didn't

- **JWT signing**: reuses `utils/jwt.ts`'s `signJwtToken`/`verifyJwtToken`
  and the existing `accessTokenSignOptions`/`refreshTokenSignOptions`
  directly, bypassing `generateTokenPair`/`verifyRefreshToken` (those are
  typed against `UserDocument["_id"]`, a Mongoose ObjectId — Postgres ids
  are plain UUID strings, and the underlying signing functions don't care
  either way).
- **Timing-safe login**: the dummy-bcrypt-hash comparison on a "no such
  account" login attempt (so response latency can't be used to enumerate
  registered emails) is preserved exactly.
- **Refresh-token rotation and reuse detection**: preserved exactly — a
  structurally valid refresh token whose hash no longer matches the
  session's current hash means the token was already spent, so the whole
  session is killed, not just the one request rejected.
- **Password reset / email verification tokens**: single-use via Redis
  `GETDEL` (Phase 3 §3.7) rather than Mongo's find-then-delete, which is
  actually a correctness improvement (closes the race window between
  checking a token and deleting it), not a compromise.
- **`req.pgUser`, not `req.user`**: `Express.Request.user` is globally typed
  as a Mongoose `UserDocument` (`src/@types/index.d.ts`), because the
  Mongo app's `authenticate` middleware assigns to it. Since both apps run
  in the same TypeScript program, this app's middleware
  (`middlewares/auth.pg.middleware.ts`) attaches to a separate
  `req.pgUser: { id, sessionId }` field instead
  (`src/@types/pg-request.d.ts`) rather than fighting that type. This is the
  one place this app's code can't be a literal copy-paste of the Mongo
  version — everything else about the middleware (extract bearer token,
  verify, check the user is active, check the session is valid) is the same
  shape as `middlewares/auth.middleware.ts`.

---

## 4.4 Test before considering this phase done

1. `tsc --noEmit` clean, `eslint` clean on everything under `services/pg`,
   `services/redis`, `controllers/pg`, `routes/pg`, `validation/pg`,
   `middlewares/auth.pg.middleware.ts`, `pg-app.ts`, `index.pg.ts`.
2. Existing Mongo test suite still green, untouched (`npm test`) — this
   phase never edits `controllers/`, `services/*.ts` (top-level),
   `routes/*.ts`, `validation/*.ts`, or `models/`.
3. Boot `npm run dev:pg` (a second Express app, `PG_APP_PORT`, default
   8001) side by side with the Mongo app on its own port, and exercise the
   golden path against real Postgres+Redis (`docker compose up`): register
   → login → get/update current user → create workspace-adjacent resources
   (project, task) → list/update/delete them → invite a second user via
   invite code → change/remove a member → refresh the access token →
   change password → log out → confirm the session is actually dead.

---

## 4.5 If you outgrow "plain" later

The reason to introduce repository interfaces isn't clean architecture for
its own sake — it's a specific, concrete need: swapping the database engine
without touching business logic, or unit-testing service logic against a
fake instead of a real database. If either of those becomes an actual
requirement (not a hypothetical one), that's the point to add an interface
in front of the specific service that needs it — not to re-layer the whole
app up front on the chance it might be useful.

---

## 4.6 What to read next

- [phase-5-testing-strategy.md](./phase-5-testing-strategy.md) — the
  `testcontainers`-based integration tests and `supertest` E2E tests still
  apply directly; its interface-based unit-testing section assumed the
  repository layer described above and should be read as testing the
  plain `services/pg`/`services/redis` functions directly instead (mock
  nothing, or use `testcontainers` for a real, disposable Postgres/Redis).
- [phase-6-cutover-and-cleanup.md](./phase-6-cutover-and-cleanup.md) — the
  final switch from the Express+Mongo app to the Express+Postgres+Redis app.
