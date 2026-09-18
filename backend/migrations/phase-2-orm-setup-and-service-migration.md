# Phase 2 — ORM Setup + Service-by-Service Migration

> Part of the [migrations/](./PLAN.md) series. Assumes
> [Phase 1](./phase-1-schema-design-and-postgres-fundamentals.md) is done —
> the schema exists in Postgres and you've verified it by hand in `psql`.
> This file: wire Drizzle into the app, port every service, and rewrite the
> two hardest Mongo-specific patterns (`.populate()` chains, the `$facet`
> aggregation) into SQL — with the theory for why each rewrite works the way
> it does.
>
> **Nothing here touches a live route.** Every new file lives in
> `src/services/pg/`, parallel to the existing `src/services/*.ts` (Mongo).
> The running app keeps using Mongo until the cutover phase.

---

## 2.1 Theory: what an ORM actually buys you (and what it hides)

An ORM/query builder sits between your code and raw SQL. Three flavors exist
in the Node ecosystem, worth understanding as a spectrum, not a binary:

- **Raw driver (`pg`)** — you write SQL strings, get rows back. Maximum
  control, zero type safety, easy to introduce SQL injection if you're not
  disciplined about parameterized queries.
- **Query builder (Drizzle, Knex)** — you build queries with a typed,
  chainable API that maps closely to SQL; the generated SQL is predictable
  and you can always see it. Type safety comes from your schema definition,
  not from guessing.
- **Full ORM (Prisma, TypeORM, Mongoose itself)** — a higher-level
  abstraction generates SQL for you from a more declarative description;
  often includes its own migration engine, and often makes complex queries
  (deep joins, window functions) harder to express than in raw SQL.

**This migration uses Drizzle**, deliberately, for the learning goal stated
upfront: Drizzle's design philosophy is "if you know SQL, you already know
Drizzle" — its query builder methods (`.select()`, `.from()`, `.where()`,
`.innerJoin()`) map almost 1:1 to SQL clauses, and `drizzle-kit`'s generated
migration files are plain, readable `.sql` files you're expected to read,
not a black box. Prisma is arguably the safer production/career default (more
common in job postings), but its schema DSL and generated client push you
*away* from thinking in SQL — precisely the opposite of what you're
optimizing for here.

---

## 2.2 Setup: install, configure, generate first migration

```bash
cd backend
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

`src/db/schema.ts` — the Drizzle equivalent of every `CREATE TABLE` from
Phase 1, but as TypeScript (this is what Drizzle uses both to generate SQL
migrations *and* to type every query result):

```ts
import {
  pgTable, uuid, text, boolean, timestamp, pgEnum, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const roleNameEnum = pgEnum("role_name", ["OWNER", "ADMIN", "MEMBER"]);
export const permissionEnum = pgEnum("permission", [
  "CREATE_WORKSPACE", "DELETE_WORKSPACE", "EDIT_WORKSPACE", "MANAGE_WORKSPACE_SETTINGS",
  "ADD_MEMBER", "CHANGE_MEMBER_ROLE", "REMOVE_MEMBER",
  "CREATE_PROJECT", "EDIT_PROJECT", "DELETE_PROJECT",
  "CREATE_TASK", "EDIT_TASK", "DELETE_TASK",
  "VIEW_ONLY",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE",
]);
export const taskPriorityEnum = pgEnum("task_priority", ["LOW", "MEDIUM", "HIGH"]);
export const oauthProviderEnum = pgEnum("oauth_provider", [
  "GOOGLE", "GITHUB", "FACEBOOK", "EMAIL",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  profilePicture: text("profile_picture"),
  isActive: boolean("is_active").notNull().default(true),
  isEmailVerified: boolean("is_email_verified").notNull().default(false),
  lastLogin: timestamp("last_login", { withTimezone: true }),
  currentWorkspaceId: uuid("current_workspace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
}));

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  inviteCode: text("invite_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: roleNameEnum("name").notNull(),
  permissions: permissionEnum("permissions").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userWorkspaceUnique: uniqueIndex("workspace_members_user_workspace_unique").on(t.userId, t.workspaceId),
  workspaceIdx: index("workspace_members_workspace_id_idx").on(t.workspaceId),
}));

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  emoji: text("emoji").notNull().default("📊"),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  workspaceIdx: index("projects_workspace_id_idx").on(t.workspaceId),
}));

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskCode: text("task_code").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  status: taskStatusEnum("status").notNull().default("TODO"),
  priority: taskPriorityEnum("priority").notNull().default("MEDIUM"),
  assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  dueDate: timestamp("due_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  workspaceProjectIdx: index("tasks_workspace_project_idx").on(t.workspaceId, t.projectId),
  workspaceStatusIdx: index("tasks_workspace_status_idx").on(t.workspaceId, t.status),
  assignedToIdx: index("tasks_assigned_to_idx").on(t.assignedTo),
}));

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: oauthProviderEnum("provider").notNull(),
  providerId: text("provider_id").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Relations - used by Drizzle's relational query API (db.query.tasks.findMany({ with: {...} }))
export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [tasks.assignedTo], references: [users.id] }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
  role: one(roles, { fields: [workspaceMembers.roleId], references: [roles.id] }),
}));
```

Note `passwordHash`/`ownerId`-style camelCase in TypeScript maps to
`password_hash`/`owner_id` snake_case in the actual SQL column names — this
is Drizzle's convention (you write idiomatic TS, it generates idiomatic
SQL), configured automatically by the explicit `text("password_hash")`
string argument to each column builder.

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

```bash
npx drizzle-kit generate   # writes src/db/migrations/0000_xxx.sql - READ IT
npx drizzle-kit migrate    # applies it to the Docker Postgres from Phase 0
```

**Test:** open the generated `.sql` file and confirm it matches the DDL you
hand-verified in Phase 1 — every `CREATE TYPE`, every FK's `ON DELETE`
clause, every index. If Drizzle generated something you didn't expect,
that's a schema-definition bug to fix now, not later.

---

## 2.3 `src/db/client.ts` — connection pooling, and the theory behind pool sizing

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_MAX_POOL_SIZE ?? 15),
  min: Number(process.env.PG_MIN_POOL_SIZE ?? 2),
});

export const db = drizzle(pool, { schema });
```

**Why pool sizing is a real decision, not boilerplate** — this app's own
`config/app.config.ts` already documents the exact same concern for Mongo
(`DEFAULT_MONGO_MAX_POOL_SIZE = "15"`, with a comment about ECS tasks
scaling out and exhausting Atlas's connection ceiling). The identical
reasoning applies to Postgres, arguably *more* sharply: **every Postgres
connection is a full OS process** (unlike Mongo/most databases, which use
lightweight threads per connection) — each one costs several MB of RAM on
the Postgres server itself, and Postgres's default `max_connections` is
typically 100. With N ECS tasks × `max: 15` each, you can exhaust the
server's connection ceiling fast. This is *why* production Postgres
deployments almost always sit behind **PgBouncer** or a managed pooler
(RDS Proxy, Supabase's pooler, Neon's pooler) — worth knowing exists now,
even though local Docker Postgres for this migration doesn't need it yet.

Add a throwaway diagnostic route (`GET /api/_internal/pg-check` running
`SELECT NOW()`) exactly as described in the original modular plan, confirm
it works, then move to porting real services. Delete the diagnostic route
at cutover.

---

## 2.4 Porting `users` + `roles` — straightforward CRUD, the baseline pattern

`src/services/pg/user.service.ts` (new file, parallel to the existing
Mongo `services/user.service.ts`):

```ts
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { NotFoundException } from "../../utils/appError";

export const getUserByIdService = async (userId: string) => {
  const [user] = await db
    .select({
      id: users.id, name: users.name, email: users.email,
      profilePicture: users.profilePicture, isActive: users.isActive,
      isEmailVerified: users.isEmailVerified, lastLogin: users.lastLogin,
      currentWorkspaceId: users.currentWorkspaceId,
      createdAt: users.createdAt, updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) throw new NotFoundException("User not found");
  return user;
};
```

Note `passwordHash` is **deliberately excluded** from the column list — this
is the Postgres/Drizzle equivalent of Mongoose's `select: true`/`select:
false` field option discussed in Phase 1 §1.4, just made explicit at every
call site instead of implicit in the schema.

Seed the fixed roles (replacing `seeders/role.seeder.ts`) — a one-off
script, not a service, since roles are fixed reference data:

```ts
// src/db/seed-roles.ts
import { db } from "./client";
import { roles } from "./schema";
import { RolePermissions } from "../utils/role-permission";

for (const [name, permissions] of Object.entries(RolePermissions)) {
  await db.insert(roles).values({ name: name as any, permissions }).onConflictDoNothing();
}
```

**Test (`scripts/verify-users-pg.ts`):** create a user via the new service,
fetch it back, assert the round-trip matches, confirm `passwordHash` is
never present in the returned object. Run `npm test` — the existing Mongo
Vitest suite must still be 100% green; nothing under `src/services/*.ts`
(non-`pg/`) was touched.

---

## 2.5 Porting `workspaces` — your first hand-written Postgres transaction

This ports `createWorkspaceService` (`workspace.service.ts:18-70`), which
today does: find user → find OWNER role → create workspace → create
membership → set user's `currentWorkspace`, all inside one Mongo
transaction.

```ts
// src/services/pg/workspace.service.ts
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client";
import { users, workspaces, roles, workspaceMembers } from "../../db/schema";
import { generateInviteCode } from "../../utils/uuid";
import { NotFoundException } from "../../utils/appError";

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
      .values({ name: body.name, description: body.description, ownerId: user.id, inviteCode: generateInviteCode() })
      .returning();

    await tx.insert(workspaceMembers).values({
      userId: user.id, workspaceId: workspace.id, roleId: ownerRole.id,
    });

    await tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id));

    return workspace;
  });
};
```

**What `db.transaction(async (tx) => {...})` is actually doing**: Drizzle
issues `BEGIN`, runs every query against `tx` (not `db`) on the **same
underlying connection** (critical — this is why you pass `tx`, not `db`,
into every nested call; using `db` inside a transaction callback would use a
*different* pooled connection, outside the transaction, silently breaking
atomicity), and issues `COMMIT` if the callback resolves or `ROLLBACK` if it
throws. Contrast with Mongo's version: no `session.startSession()` /
`.startTransaction()` / manual `try { ... commitTransaction() } catch {
abortTransaction() } finally { endSession() }` boilerplate — Drizzle's
callback-based API handles the try/catch/rollback for you, which is
strictly less error-prone (a forgotten `abortTransaction()` in a Mongo
catch block is a real, easy-to-introduce bug class; Drizzle's transaction
callback makes that mistake structurally impossible).

**Test:** port `scripts/verify-workspaces-pg.ts` from the original modular
plan — create a workspace, confirm the OWNER membership exists, attempt a
duplicate membership insert and confirm `23505`. Additionally: throw
deliberately after the `workspaces` insert but before the
`workspaceMembers` insert, confirm the workspace row does **not** persist —
proving rollback, not just the happy path.

---

## 2.6 Rewriting `.populate()` as SQL `JOIN`s — the core relational-thinking exercise

This is the single most important mechanical skill in this migration.
Ported from `task.service.ts:176-181`:

```ts
// Mongo original:
TaskModel.find(query)
  .skip(skip).limit(pageSize).sort({ createdAt: -1 })
  .populate("assignedTo", "_id name profilePicture -password")
  .populate("project", "_id emoji name")
```

Recall from Phase 0 §0.1: `.populate()` is **two additional round-trip
queries**, stitched together in application memory by Mongoose. The SQL
equivalent is **one query**, with the join pushed down to the database:

```ts
// src/services/pg/task.service.ts
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tasks, users, projects } from "../../db/schema";

export const getAllTasksService = async (
  workspaceId: string,
  filters: { projectId?: string; status?: string[]; priority?: string[]; assignedTo?: string[]; keyword?: string; dueDate?: string },
  pagination: { pageSize: number; pageNumber: number }
) => {
  const conditions = [eq(tasks.workspaceId, workspaceId)];
  if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
  if (filters.status?.length) conditions.push(sql`${tasks.status} = ANY(${filters.status})`);
  if (filters.keyword) conditions.push(sql`${tasks.title} ILIKE ${'%' + filters.keyword + '%'}`);
  // priority/assignedTo/dueDate filters follow the same pattern

  const skip = (pagination.pageNumber - 1) * pagination.pageSize;

  const rows = await db
    .select({
      id: tasks.id, taskCode: tasks.taskCode, title: tasks.title, status: tasks.status,
      priority: tasks.priority, dueDate: tasks.dueDate, createdAt: tasks.createdAt,
      assignee: { id: users.id, name: users.name, profilePicture: users.profilePicture },
      project: { id: projects.id, emoji: projects.emoji, name: projects.name },
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(pagination.pageSize)
    .offset(skip);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(tasks).where(and(...conditions));

  return { tasks: rows, pagination: { ...pagination, totalCount: count, totalPages: Math.ceil(count / pagination.pageSize), skip } };
};
```

**Why `leftJoin`, specifically, and not `innerJoin`:** `assignedTo` is
nullable (a task can be unassigned) and every task always has a `project`,
but using `leftJoin` for both is the safe default — an `innerJoin` on
`assignedTo` would **silently drop unassigned tasks from the result
entirely**, a real, easy-to-miss bug when porting from `.populate()` (which
never drops documents, it just leaves the populated field `null`). This is
worth testing explicitly — see §2.8.

**Why `ILIKE` replaces the Mongo `$regex` + `escapeRegExp`:** the current
code (`task.service.ts:10-12`) hand-escapes regex metacharacters to prevent
ReDoS from a crafted search keyword, because Mongo's `$regex` operator runs
a real regex engine. Postgres's `ILIKE` (case-insensitive `LIKE`) is
**pattern matching, not a full regex engine** — `%`/`_` are its only
special characters, so the ReDoS class of attack this code defends against
doesn't exist for `ILIKE` in the first place. You still must
escape literal `%`/`_` characters in user input (a keyword containing a
literal `%` shouldn't act as a wildcard), which is a *narrower*, easier
escaping requirement than full regex escaping — a good concrete example of
"the safe way to do something is different, not just relocated" when
porting between systems, and a case where Postgres's tool is actually
better-fit than Mongo's for this specific use.

**Test:** port `scripts/verify-tasks-pg.ts`. Seed: one task with
`assignedTo = null`, one with a real assignee, one in a different
workspace. Assert: the unassigned task appears with `assignee: null` (not
missing), the cross-workspace task never appears, filtering by `status`
returns the right subset, and `EXPLAIN ANALYZE` on the query shows the
`tasks_workspace_status_idx` (or relevant index) being used, not a
sequential scan.

---

## 2.7 Rewriting the `$facet` aggregation — pipeline thinking vs. set thinking

The hardest single rewrite in this migration, from `project.service.ts:88-124`:

```ts
// Mongo original
const taskAnalytics = await TaskModel.aggregate([
  { $match: { project: new mongoose.Types.ObjectId(projectId) } },
  { $facet: {
      totalTasks: [{ $count: "count" }],
      overdueTasks: [
        { $match: { dueDate: { $lt: currentDate }, status: { $ne: "DONE" } } },
        { $count: "count" },
      ],
      completedTasks: [{ $match: { status: "DONE" } }, { $count: "count" }],
  }},
]);
```

Mongo's `$facet` runs **three independent sub-pipelines over the same
`$match`-filtered input in one pass**, each producing its own result set —
that's *why* `$facet` exists: SQL's `WHERE` clause can only shape the rows
returned by the whole query, it has no native way to say "count under this
condition and, separately, count under that condition, in the same query."
SQL's answer to that exact problem is `FILTER`:

```ts
// src/services/pg/project.service.ts
import { eq, and, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tasks } from "../../db/schema";

export const getProjectAnalyticsService = async (projectId: string) => {
  const [row] = await db
    .select({
      totalTasks: sql<number>`count(*)::int`,
      overdueTasks: sql<number>`count(*) filter (where ${tasks.dueDate} < now() and ${tasks.status} != 'DONE')::int`,
      completedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));

  return { analytics: row };
};
```

**One query, one pass over the table, three conditional counts** — this is
actually a *more* direct expression of "three facts about the same
filtered set" than Mongo's three-sub-pipelines-in-a-facet, once you're
fluent in `FILTER`. Run the hand-written SQL version in `psql` first (as
PLAN.md's original modular Module 5 advised) against your Phase 1 seeded
data, eyeball the counts, *then* wire it into Drizzle — don't skip the
manual-SQL step, internalizing `FILTER` here is the actual point of this
section.

**Test:** seed a project with tasks in mixed states — some `DONE`, some
overdue-and-not-done, some future-due-and-not-done. Assert all three counts
match hand-computed expected values. This is also a good moment to run
`EXPLAIN ANALYZE` on the `FILTER` query and observe it's a **single
sequential/index scan with three aggregate accumulators** — genuinely
cheaper than three separate `COUNT(*) WHERE ...` queries would be.

---

## 2.8 Remaining services — same patterns, applied mechanically

Port these in order (dependency order, matching the ER diagram from
Phase 1):

1. **`accounts`** (`src/services/pg/account.service.ts`) — OAuth
   lookup/create, no new concepts beyond §2.4/§2.5.
2. **`projects`** — CRUD + `getProjectsInWorkspaceService`'s paginated list
   (same `leftJoin` pattern as §2.6 for `createdBy`).
3. **`tasks`** remainder — `createTaskService`, `updateTaskService`,
   `getTaskByIdService`, and `assertAssigneeIsWorkspaceMember`
   (`task.service.ts:16-30`) — this last one is a good small exercise:
   Mongo's `MemberModel.exists({ userId, workspaceId })` becomes
   `db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(...), eq(...))).limit(1)`,
   checking `.length > 0`. Or use `EXISTS` directly via
   `sql`exists(select 1 from ...)`` if you want the closer SQL-native
   translation — a good moment to compare both and read the `EXPLAIN`
   output for each.
4. **`workspace_members` list/read paths** — `getWorkspaceMembersService`
   (`workspace.service.ts:117-124`), the other `.populate("role")` /
   `.populate("userId")` call sites. Same `leftJoin` pattern as §2.6, now
   joining `workspace_members` → `users` → `roles` (a genuine 3-table join —
   good practice reading a slightly more complex `EXPLAIN ANALYZE` plan).
5. **`deleteWorkspaceService`** (`workspace.service.ts:289-344`) — this one
   gets **dramatically simpler** in Postgres. The Mongo version manually
   deletes projects, tasks, and members inside a transaction before deleting
   the workspace. In Postgres, this becomes:
   ```ts
   await db.transaction(async (tx) => {
     await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
     // that's it - ON DELETE CASCADE handles members/projects/tasks automatically
   });
   ```
   This single before/after comparison is worth sitting with — it's the
   clearest demonstration in the whole migration of what "the database
   enforces referential integrity" actually buys you operationally, not
   just theoretically.
6. **`deleteUserService`** (`user.service.ts:100-128`) — same simplification:
   `ON DELETE CASCADE` on `workspace_members`/`accounts` means you only need
   to explicitly handle the one case Postgres's declared FKs can't decide
   for you (transferring/blocking on owned workspaces, per the `RESTRICT`
   behavior from Phase 1 §1.4) — everything else collapses to `DELETE FROM
   users WHERE id = ...` and letting cascades do the rest.

For each: write the service in `src/services/pg/`, write a standalone
verify script, run it, confirm `npm test` (Mongo suite) stays green.

---

## 2.9 Actually done — status: ✅ complete, real code, verified against real Postgres

Everything in this phase was actually written and run, not just described.
Committed artifacts:

- `backend/src/db/schema.ts` — the Drizzle schema, matching §2.2 exactly.
- `backend/drizzle.config.ts`, `backend/src/db/client.ts` — pool config
  exactly per §2.2/§2.3 (`max: 15`/`min: 2`, same reasoning as Mongo's
  existing pool sizing).
- `backend/src/db/migrations/000{0,1,2}_*.sql` — three generated migrations
  (base schema, the deferred circular FK, a fix described below), applied
  with `drizzle-kit migrate` against the Phase 0 Postgres container.
- `backend/src/db/seed-roles.ts` — the roles seeder, replacing
  `seeders/role.seeder.ts`.
- `backend/src/services/pg/{user,workspace,task,project,account}.service.ts`
  — every service this phase specifies: CRUD baseline (§2.4), the
  transactional `createWorkspaceService` + simplified `deleteWorkspaceService`
  (§2.5, §2.8 item 5), the `.populate()`→`leftJoin` rewrite for tasks (§2.6),
  the `$facet`→`FILTER` rewrite for project analytics (§2.7), and the
  remaining mechanical ports from §2.8 (`assertAssigneeIsWorkspaceMember`,
  the 3-table `workspace_members`→`users`→`roles` join,
  `changeMemberRoleService`).
- `backend/scripts/verify-phase2-pg.ts`, `backend/scripts/explain-phase2-tasks.ts`
  — the actual verify scripts §2.4-§2.8 call for, run against real data (not
  mocked), reproduced below.
- `GET /api/_internal/pg-check` added to `src/index.ts`, gated to
  non-production — confirmed live and reachable alongside the untouched
  Mongo `/health` route.

### Two real bugs this phase's own execution caught

Neither was hypothetical — both broke a real command before being fixed:

1. **`roles.name` was missing its `UNIQUE` constraint in the Drizzle schema.**
   Phase 1's hand-written DDL declares `name role_name NOT NULL UNIQUE`
   (`phase-1-schema-design-and-postgres-fundamentals.md` §1.4), but this
   phase's original Drizzle `roles` table definition (§2.2, as first
   written) dropped it — a transcription gap between the two phases that
   `psql`'s `\d roles` immediately exposed once `seed-roles.ts`'s
   `.onConflictDoNothing()` had no constraint to target. Fixed by adding
   `uniqueIndex("roles_name_idx").on(t.name)` to `schema.ts` and generating
   `0002_youthful_firestar.sql` to apply it. This is the concrete version of
   §2.2's own advice: "if Drizzle generated something you didn't expect,
   that's a schema-definition bug to fix now, not later" — here it was the
   opposite direction (something *missing*), caught the same way, by
   actually running it rather than trusting the two docs agreed with each
   other.
2. **Circular-reference type inference (`users.currentWorkspaceId` ↔
   `workspaces.ownerId`) fails under `ts-node`'s real type-checker**, even
   though it type-checks fine under `tsx`'s type-stripping-only compiler:
   `TS7022`/`TS7024`, "implicitly has type 'any' because it does not have a
   type annotation and is referenced directly or indirectly in its own
   initializer." This is a known Drizzle gotcha with mutually-referencing
   tables, not a mistake specific to this schema — the fix is Drizzle's own
   documented workaround, annotating each circular thunk's return type
   explicitly: `.references((): AnyPgColumn => workspaces.id)` instead of
   `.references(() => workspaces.id)`. Worth keeping in mind for Phase 5's
   test suite too — if `vitest`/`ts-node` type-check test files strictly,
   this exact error will resurface anywhere a table pair references each
   other both ways.

### A real infra collision worth recording — port 5432 conflict

Connecting from the Node `pg` driver to `localhost:5432` (the address in
Phase 0's own `DATABASE_URL`) hit **a pre-existing native Homebrew Postgres
installation** already listening on `127.0.0.1:5432` on this machine, not
the Docker container — `docker compose exec` (used for all of Phase 0/1's
verification) bypasses host networking entirely, so this collision was
invisible until an actual host-side TCP client (the Node driver) tried to
connect. Symptom: `role "astrix" does not exist` — a real, misleading error
that took inspecting `lsof -iTCP:5432` to diagnose correctly (two processes
can each bind a *specific* address on the same port on macOS; the
most-specific bound socket wins routing, so the native install's
`127.0.0.1:5432` binding intercepted the connection ahead of Docker's
`0.0.0.0:5432` forward). Fixed by remapping the container's host port in
`docker-compose.yml` (`"55432:5432"` instead of `"5432:5432"`) and updating
`DATABASE_URL` accordingly — a one-line, environment-specific fix, not a
schema or code problem. Worth checking `lsof -iTCP:5432` on any machine
before assuming Phase 0's default port mapping is free.

### Verification — actually run, full output

```
--- 2.4 users: round-trip, passwordHash excluded ---
OK - user round-trip matches, passwordHash absent from result

--- 2.5 workspaces: transaction happy path ---
OK - workspace + OWNER membership created atomically

--- 2.5 workspaces: transaction rollback proof ---
OK - workspace count unchanged after rollback (1 before, 1 after)

--- 2.6 tasks: leftJoin, unassigned task keeps assignee:null ---
OK - unassigned task appears with assignee: null; assigned task's assignee is joined correctly

--- 2.6 tasks: assertAssigneeIsWorkspaceMember rejects a non-member ---
OK - assigning a task to a non-member is rejected

--- 2.6 tasks: cross-workspace task never appears ---
OK - cross-workspace task does not appear

--- 2.7 project analytics: FILTER-based counts ---
OK - analytics: { totalTasks: 5, overdueTasks: 1, completedTasks: 1 }

--- 2.8 workspace_members: 3-table join ---
OK - 3-table join returns 2 members with user + role attached

--- 2.8 changeMemberRoleService: rejects changing the owner's role ---
OK - owner role-change correctly rejected

--- 2.8 deleteProjectService: cascade deletes its tasks ---
OK - project delete cascaded to its tasks (0 remain)

--- 2.8 deleteWorkspaceService: cascade + currentWorkspace reassignment ---
OK - deleteWorkspaceService result: { currentWorkspaceId: null }

--- getTaskByIdService: 404 for wrong project/workspace ---
OK - unknown task id correctly 404s

All Phase 2 verifications passed.
```

Every claim this phase makes about behavior was checked directly, not just
read as plausible: the OWNER membership is created in the same transaction
as the workspace (§2.5), a deliberate throw before commit leaves **zero**
trace (real rollback, not just "the try/catch didn't crash"), an unassigned
task is present in results with `assignee: null` rather than silently
dropped (the exact `leftJoin`-vs-`innerJoin` bug class §2.6 warns about),
a task assigned to a non-member of the workspace is rejected, a task from
another workspace never leaks into this workspace's list, the `FILTER`
based analytics query's three counts match hand-computed values from
deliberately-seeded mixed-state tasks, and both cascade deletes (project→
tasks, workspace→members/projects/tasks) actually removed the child rows —
none of this required inspecting Postgres logs or trusting the code, the
assertions failed loudly on the first draft's real bugs (see above) and
passed clean once those were fixed.

### `EXPLAIN ANALYZE` at a realistic row count

Phase 1 §1.7 found that on a near-empty table, Postgres correctly prefers a
sequential scan over an index scan — the index existing doesn't guarantee
it's used. Re-running the same query shape here against 500 seeded tasks
(one workspace, mixed `TODO`/`DONE` status) confirms the other side of that
lesson: once there's enough data for the index to actually pay off, the
planner uses it without being told to:

```
Index Scan using tasks_workspace_status_idx on tasks
  (cost=0.15..8.17 rows=1 width=208) (actual time=0.019..0.077 rows=400 loops=1)
  Index Cond: ((workspace_id = '...'::uuid) AND (status = 'TODO'::task_status))
Planning Time: 0.115 ms
Execution Time: 0.103 ms
```

400 matching rows returned in 0.103ms via the compound index — this is
`getAllTasksService`'s actual filter shape, not a paraphrase of it.

### Mongo suite + build — confirmed unaffected

```
$ npm test
 Test Files  46 passed (46)
      Tests  561 passed | 1 skipped (562)

$ npm run build
tsc && cp ./package.json ./dist   # exit 0, no errors
```

Identical to the pre-migration baseline (root `PLAN.md`'s "561/562 tests
passing" figure) — confirms nothing under `src/services/*.ts` (non-`pg/`),
`src/models/*.ts`, or any live route was touched. The Postgres database was
left holding only its three seeded roles afterward; every user/workspace/
task/project row created during verification was explicitly deleted.

---

## 2.10 What to read next

- [phase-3-redis-migration-and-ttl-data.md](./phase-3-redis-migration-and-ttl-data.md)
  — sessions, password reset/email verification tokens, rate limiting, and
  caching, with Redis data-structure theory.
- [phase-4-clean-architecture-express.md](./phase-4-clean-architecture-express.md)
  — restructuring these `pg/`-prefixed services behind repository
  interfaces with a manual dependency-injection boundary (no framework),
  once both Postgres and Redis pieces exist.
