> Part of the [AstriX engineering curriculum](../Architecture.md), under [Backend](./00-master-backend-architecture.md).

# Database Queries & Transactions

This file owns two things: how AstriX actually talks to PostgreSQL on a per-query basis (connection lifecycle, pool sizing, the query-builder boundary), and every place in the codebase where more than one write has to succeed or fail together as a single atomic unit. The *shape* of the data — which tables exist, how they reference each other, which columns are indexed for which query — belongs to [`07-database-schema-design.md`](./07-database-schema-design.md); this file assumes that shape exists and focuses on the mechanics of reading and writing it safely under concurrency and partial failure.

> **Note on this revision:** AstriX's backend was migrated off MongoDB/Mongoose onto PostgreSQL (via Drizzle ORM) and Redis (via `ioredis`) — see [`backend/migrations/PLAN.md`](../../backend/migrations/PLAN.md) for the full six-phase history. Everything below documents the Drizzle/Postgres mechanics as they exist today; the old Mongoose session/transaction API (`startSession`/`.session(...)`/`abortTransaction()`/`endSession()`) is gone from this codebase entirely, and shows up here only where it's useful contrast for *why* the current shape looks the way it does.

---

## 1. The Landscape

Before looking at AstriX, it's worth naming the actual menu of options for "how does application code talk to a database," because the choice shapes everything downstream — how much boilerplate you write, how much the database can enforce on your behalf, and how easy the code is to test or swap later.

### 1.1 Data-access approaches

**(a) Raw driver calls.** No abstraction layer at all — you call the database vendor's own client library directly. For Postgres in Node, that's `pg` (`node-postgres`):

```js
const pool = new Pool({ connectionString });
const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
```

Maximum control — you see exactly what goes over the wire, and there's no framework "magic" to work around when you need something unusual. The cost is that *everything* is boilerplate: no compile-time column-name checking (a typo'd column name is a runtime `42703` error, not a type error), and every query's result shape has to be hand-typed or cast, since `pg` returns `any`-shaped rows.

**(b) Query builder.** A library that constructs queries programmatically, with real type safety, without a full ORM's schema-validation/lifecycle-hook machinery sitting between your code and the returned rows. Knex is the long-standing example; Drizzle ORM (despite the name) is architecturally this category, not a full ORM — its query builder methods map close to 1:1 onto SQL clauses, and the types come directly from the schema definition, not from a separate declarative DSL a code generator has to run over.

```ts
// Drizzle
const user = await db.select().from(users).where(eq(users.email, email));
await db.insert(users).values({ email, name });
```

You get composability, full type inference end to end (a `.select({...})` projection's TypeScript type is derived from the columns you actually listed), and full visibility into the generated SQL — at the cost of no lifecycle hooks and no schema-level validation; anything resembling "validate before this hits the database" has to happen in application code before the query runs.

**(c) Full ORM.** A layer that maps application objects to rows *and* owns schema definition, validation, and lifecycle hooks — Prisma, TypeORM, Sequelize for SQL; Mongoose was this category for MongoDB.

```ts
// Prisma, for comparison — not what AstriX uses
const user = await prisma.user.findUnique({ where: { email } });
```

The ORM enforces more at the application layer and can give you lifecycle hooks (pre-save hashing, for instance), at the cost of an abstraction layer with its own behavior to learn — Prisma's own query engine and migration model, for instance — and often a real performance/debuggability tax versus a query builder when a query gets complex enough that you need to see the actual generated SQL to reason about it.

**(d) Repository pattern.** Layered on top of any of the above: an explicit interface sits between services and the underlying data-access technology, so business logic depends on an abstraction (`UserRepository`) rather than directly on Drizzle or Prisma.

```ts
interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
}

class DrizzleUserRepository implements UserRepository {
  async findByEmail(email: string) {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user ?? null;
  }
}
```

The theoretical payoff is swappability — the database technology could change underneath the interface without touching business logic — and centralization of query logic that would otherwise be duplicated across services. The cost is a whole extra layer that needs its own tests and its own maintenance. **AstriX does not have this layer** — verified directly: every service under `backend/src/services/` imports `db` from `../db/client` and the relevant tables from `../db/schema` and queries them directly. There is no `repositories/` folder, no `IUserRepository` interface, nothing between a service function and Drizzle's query builder. This mirrors the choice already documented in [`01-architecture-patterns-and-project-structure.md`](./01-architecture-patterns-and-project-structure.md) — AstriX's earlier migration draft tried exactly this repository/ports-and-adapters shape for Phase 4 and walked it back as unjustified ceremony at this scale (see that file's §5).

### 1.2 Transaction models

Separately from "how do you issue a single query," there's "how do you guarantee multiple writes succeed or fail together." Three real approaches:

**No transactions at all — relying on single-statement atomicity.** A single SQL statement is always atomic in Postgres — an `UPDATE` that touches five columns on one row either applies all five or none, with no explicit transaction needed, and the same holds for a single `INSERT ... RETURNING` or `DELETE`. A huge fraction of real-world writes never need more than this guarantee:

```ts
await db.update(tasks).set({ status: "DONE", updatedAt: new Date() }).where(eq(tasks.id, taskId));
```

This is the cheapest option (no transaction-block overhead, no extra round trips for `BEGIN`/`COMMIT`) and it's sufficient whenever "atomic" only needs to mean "this one statement, all its rows, together."

**Application-level saga / compensating transactions.** Used when true ACID transactions aren't available or desirable across service or database boundaries — most commonly in a microservices architecture where each step lives in a different service with its own datastore, so no single database transaction could span all of them anyway. Each step defines an explicit "undo":

```js
// pseudocode - a booking saga across three independent services
async function bookTrip(order) {
  const flight = await flightsService.reserve(order.flight);
  try {
    const hotel = await hotelsService.reserve(order.hotel);
    try {
      await paymentsService.charge(order.card, order.total);
    } catch (err) {
      await hotelsService.cancel(hotel.id); // compensate step 2
      throw err;
    }
  } catch (err) {
    await flightsService.cancel(flight.id); // compensate step 1
    throw err;
  }
}
```

This buys cross-service atomicity-in-spirit without a distributed transaction coordinator, at the cost of every step needing a correct, tested "undo" — and a window where partial state is visible to the rest of the system before the compensation runs. AstriX is a single database behind a single service, so this pattern doesn't apply anywhere in the codebase — it's included here because it's the answer once a system genuinely does span multiple datastores, which AstriX's Postgres+Redis split technically already is in a narrow sense (see §3.2's note on why session cleanup can't be transactional).

**True multi-statement ACID transactions**, via Drizzle's `db.transaction(async (tx) => { ... })`. Postgres has supported multi-statement ACID transactions since long before this migration — `BEGIN`/`COMMIT`/`ROLLBACK` at the SQL level, with real snapshot isolation for reads inside the transaction. Drizzle wraps this in a callback API:

```ts
await db.transaction(async (tx) => {
  const [a] = await tx.insert(tableA).values({ ... }).returning();
  await tx.update(tableB).set({ ... }).where(eq(tableB.id, a.id));
  // no explicit commit call - resolving the callback commits;
  // throwing inside it rolls back automatically.
});
```

Drizzle's `db.transaction()` issues a real `BEGIN` before the callback runs, passes a `tx` object (itself a full query-builder client, scoped to that transaction) into the callback, and automatically issues `COMMIT` if the callback's promise resolves or `ROLLBACK` if it rejects — there's no separate `startTransaction()`/`commitTransaction()`/`abortTransaction()` call sequence to get right by hand, and no `finally` block needed to release anything, because the transaction's lifetime is exactly the callback's lifetime. **This is what AstriX uses, selectively**, for exactly the operations where single-statement atomicity isn't enough.

---

## 2. AstriX's Choice

AstriX uses **Drizzle ORM as a typed query builder** — table definitions and their columns/enums/indexes live in `backend/src/db/schema.ts` (owned in full by [`07-database-schema-design.md`](./07-database-schema-design.md)), and every service imports `db` and the tables it needs directly, with no repository layer in between. For the subset of operations that write across more than one table as a single logical unit — user registration, OAuth login-or-create, account deletion, workspace creation, and workspace deletion — AstriX reaches for a real Postgres transaction via `db.transaction(async (tx) => { ... })`. Every other write (a task update, a project creation, a role change) relies on Postgres's built-in single-statement atomicity and never opens a transaction at all.

---

## 3. AstriX Implementation

### 3.1 Connection setup and pool sizing

```ts
// backend/src/db/client.ts, in full
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { getEnv } from "../utils/get-env";

export const pool = new Pool({
  connectionString: getEnv("DATABASE_URL", ""),
  max: Number(getEnv("PG_MAX_POOL_SIZE", "15")),
  min: Number(getEnv("PG_MIN_POOL_SIZE", "2")),
});

export const db = drizzle(pool, { schema });
```

Two exports, not one — this is a genuine, deliberate change from a Mongoose-style single-connection-object setup, and it matters for shutdown (§3.5): `pool` is the raw `pg` connection pool, and `db` is the Drizzle query-builder instance wrapped around it. `pool` was kept as its own export specifically so `src/index.ts` can call `pool.end()` directly during graceful shutdown — Drizzle's `db` object doesn't itself expose a "close everything" method, since it's a thin query-building layer over whatever pool it was handed, not the connection owner.

`max`/`min` here are Postgres's `PG_MAX_POOL_SIZE`/`PG_MIN_POOL_SIZE` — the direct renaming of Mongoose's `maxPoolSize`/`minPoolSize` for the same reasoning (bound the pool explicitly so N horizontally-scaled ECS tasks × pool size doesn't exceed the database's actual connection ceiling; keep a small warm floor so a freshly started task doesn't pay full connection-handshake latency on its first requests). One thing worth being precise about, because it's a real, checkable detail of this exact file rather than a paraphrase: `client.ts` reads `PG_MAX_POOL_SIZE`/`PG_MIN_POOL_SIZE` directly via `getEnv(...)`, not through `config.app.config`'s already-parsed `config.PG_MAX_POOL_SIZE`/`config.PG_MIN_POOL_SIZE` — even though `app.config.ts` computes exactly those two fields (with the same default values, `"15"`/`"2"`) and documents the same ECS-connection-ceiling reasoning in its own comment. In practice the two reads agree, because both default to the same values and read the same env vars — but it means `config.PG_MAX_POOL_SIZE`/`config.PG_MIN_POOL_SIZE` are currently unused dead fields on the config object; nothing in `backend/src` imports them. A future engineer changing the pool size by editing `app.config.ts`'s default and not noticing `client.ts` never reads it would ship a no-op change — worth flagging as a small, real inconsistency rather than assuming the two are wired together just because they compute the same thing.

### 3.2 Every transaction in the codebase

A grep for `db.transaction(` across `backend/src` turns up exactly four real usages:

| # | Location | Protects |
|---|---|---|
| 1 | `backend/src/services/auth.service.ts:97-127` (`registerUserService`) | Creating the User row, an EMAIL `Account` row, the OWNER `Role` lookup, the Workspace, and the `workspace_members` row, plus setting the user's `currentWorkspaceId`, as one atomic unit |
| 2 | `backend/src/services/auth.service.ts:207-276` (`loginOrCreateAccountService`) | OAuth login-or-create: creating the User + Workspace + `workspace_members` row (new-user branch) and linking the OAuth `Account`, together |
| 3 | `backend/src/services/user.service.ts:114-122` (`deleteAccountService`) | Unassigning the user's tasks and deleting their `workspace_members`/`accounts`/`users` rows together |
| 4 | `backend/src/services/workspace.service.ts:24-56` (`createWorkspaceService`) | Creating the Workspace + `workspace_members` row and updating the user's `currentWorkspaceId`, together |

`deleteWorkspaceService` (`backend/src/services/workspace.service.ts:226-263`) also opens a transaction, worth listing as a fifth real usage even though its shape is different from the other four — it exists mainly to make the ownership check and the delete-plus-reassignment read-after-write consistent, since the actual multi-table cleanup (removing `workspace_members`, `projects`, and `tasks` rows for the deleted workspace) is now Postgres's `ON DELETE CASCADE` doing it automatically, not application code inside the transaction (§3.3 below covers exactly what changed here).

Every one of these follows the same shape: call `db.transaction(async (tx) => { ... })`, use `tx` — never the module-level `db` — for every read and write inside the callback, and either `return` a value (which becomes `db.transaction()`'s own resolved value) or `throw` (which Drizzle turns into an automatic `ROLLBACK`, with the original error re-thrown to the caller). Here is each one in full.

**User registration** — the most involved of the four, five statements across four tables written as one unit:

```ts
// backend/src/services/auth.service.ts:90-143 (registerUserService)
export const registerUserService = async (body: {
  email: string;
  name: string;
  password: string;
}) => {
  const { email, name, password } = body;

  const { userId, workspaceId } = await db.transaction(async (tx) => {
    const [existingUser] = await tx.select().from(users).where(eq(users.email, email));
    if (existingUser) {
      throw new BadRequestException("Email already exists");
    }

    const passwordHash = await hashValue(password);
    const [user] = await tx.insert(users).values({ email, name, passwordHash }).returning();

    await tx.insert(accounts).values({ userId: user.id, provider: "EMAIL", providerId: email });

    const [ownerRole] = await tx.select().from(roles).where(eq(roles.name, Roles.OWNER));
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: "My Workspace",
        description: `Workspace created for ${user.name}`,
        ownerId: user.id,
        inviteCode: generateInviteCode(),
      })
      .returning();

    await tx.insert(workspaceMembers).values({ userId: user.id, workspaceId: workspace.id, roleId: ownerRole.id });
    await tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id));

    return { userId: user.id, workspaceId: workspace.id };
  });

  // Best-effort, outside the transaction (it already committed - the
  // account exists regardless of what happens here). A hiccup creating the
  // verification token or sending the email must NOT turn into a
  // registration failure; the user can always request a new one later.
  try {
    await requestEmailVerificationService(userId);
  } catch (verificationError) {
    logger.error(
      { err: verificationError },
      "Failed to send verification email during registration"
    );
  }

  return { userId, workspaceId };
};
```

Note the shape difference from a hand-rolled session API: there is no `session.commitTransaction()` call anywhere in this function. The transaction commits *implicitly*, the instant the callback's returned promise resolves with `{ userId: user.id, workspaceId: workspace.id }` — Drizzle issues the `COMMIT` for you at that point. If any `throw` happens anywhere inside the callback (the duplicate-email check, a missing owner role, a Postgres constraint violation on any of the four writes), Drizzle catches the rejection, issues a `ROLLBACK`, and re-throws the original error out of `db.transaction(...)` itself — the calling code doesn't write its own `catch`/`rollback`/`finally` at all; the `try`/`catch` visible in this function is for the unrelated, deliberately-non-transactional email-verification step *after* the transaction has already committed.

**OAuth login-or-create** — the same shape, with a branch that skips most of the writes when the user already exists:

```ts
// backend/src/services/auth.service.ts:194-280 (loginOrCreateAccountService, excerpted)
export const loginOrCreateAccountService = async (data: {
  provider: "GOOGLE" | "GITHUB" | "FACEBOOK" | "EMAIL";
  displayName: string;
  providerId: string;
  picture?: string;
  email?: string;
  emailVerified?: boolean;
}) => {
  const { providerId, provider, displayName, email, picture, emailVerified } = data;

  const user = await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.provider, provider), eq(accounts.providerId, providerId)));

    if (account) {
      const [existingUser] = await tx.select().from(users).where(eq(users.id, account.userId));
      if (!existingUser) {
        throw new Error("Account exists but user not found");
      }
      return existingUser;
    }

    let user = email ? (await tx.select().from(users).where(eq(users.email, email)))[0] : undefined;

    if (user && !emailVerified) {
      throw new UnauthorizedException(
        "This email is already registered. Log in with your password, or verify this email with your provider first."
      );
    }

    if (!user) {
      // ...creates User + Workspace + workspace_members, same shape as
      // registerUserService above (see the real file for the full branch)
    }

    await tx.insert(accounts).values({ userId: user.id, provider, providerId });
    return user;
  });

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return { user: safeUser };
};
```

The transaction opens *before* it's known which branch will run — whether this call ends up writing to one table (linking a new OAuth `accounts` row to an existing user) or five (a brand-new user, workspace, membership, and account) isn't decided until the account/email lookups inside the callback resolve, so the transaction has to wrap the whole decision tree rather than being added after the fact to just the "new user" branch.

**Account deletion** — a pre-check runs *before* the transaction opens, then three tables are touched together:

```ts
// backend/src/services/user.service.ts:73-129 (deleteAccountService, in full)
export const deleteAccountService = async (
  userId: string,
  password?: string
): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundException("User not found");
  }

  if (user.passwordHash) {
    if (!password) {
      throw new BadRequestException(
        "Password confirmation is required to delete your account"
      );
    }
    const isMatch = await compareValue(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException("Incorrect password");
    }
  }

  // Deliberately blocked, not cascaded: a workspace can have other members
  // who'd lose it with no warning if we silently deleted every workspace
  // this user owns. Make them delete/transfer those explicitly first.
  const ownedWorkspaces = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId));

  if (ownedWorkspaces.length > 0) {
    throw new BadRequestException(
      `Delete or transfer ownership of ${ownedWorkspaces.length} workspace(s) you own before deleting your account: ${ownedWorkspaces
        .map((w) => w.name)
        .join(", ")}`
    );
  }

  await db.transaction(async (tx) => {
    // Unassign (don't delete) tasks in workspaces this user is just a
    // member of - the tasks themselves are still valid workspace history.
    await tx.update(tasks).set({ assignedTo: null }).where(eq(tasks.assignedTo, userId));

    await tx.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  // Sessions live in Redis, not Postgres, so this can't be part of the
  // transaction above - best-effort cleanup after the account row is gone.
  await invalidateAllSessionsForUser(userId);
};
```

The password check and the owned-workspaces guard both run against the plain `db` object, outside any transaction — they're pure reads with no write to roll back if they fail, so there's nothing to gain from wrapping them. Only the four actual mutations (unassign tasks, delete memberships, delete accounts, delete the user row) are inside `db.transaction(...)`. This is also the clearest example in the codebase of the Postgres/Redis split's one real transactional limitation: `invalidateAllSessionsForUser(userId)` touches Redis, and Redis isn't part of the Postgres transaction Drizzle manages — it's called *after* the transaction has already committed, as an explicit best-effort step, the same "can't fail the caller over this" posture `registerUserService` uses for its post-commit verification-email send. There is no cross-database transaction here, by construction: Postgres commits the account deletion, and only then does a separate, non-transactional call clean up the Redis-side session state.

**Workspace creation** — the smallest of the four, three statements across three tables:

```ts
// backend/src/services/workspace.service.ts:20-57 (createWorkspaceService, in full)
export const createWorkspaceService = async (
  userId: string,
  body: { name: string; description?: string }
) => {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundException("User not found");

    const [ownerRole] = await tx
      .select()
      .from(roles)
      .where(eq(roles.name, "OWNER"));
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

    await tx
      .update(users)
      .set({ currentWorkspaceId: workspace.id })
      .where(eq(users.id, user.id));

    return { workspace };
  });
};
```

`createWorkspaceService` itself `return`s the whole `db.transaction(...)` call directly — there's no separate variable-then-return step, because the transaction's own resolved value *is* the function's return value.

**Workspace deletion** — the clearest before/after contrast with the old model, because `ON DELETE CASCADE` (documented in full in [`07-database-schema-design.md` §6](./07-database-schema-design.md#6-design-decisions--tradeoffs)) now does most of the work that used to be explicit application code:

```ts
// backend/src/services/workspace.service.ts:222-264 (deleteWorkspaceService, in full)
export const deleteWorkspaceService = async (
  workspaceId: string,
  userId: string
) => {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new NotFoundException("Workspace not found");

    if (workspace.ownerId !== userId) {
      throw new ForbiddenException(
        "You are not authorized to delete this workspace"
      );
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
      await tx
        .update(users)
        .set({ currentWorkspaceId: anotherMembership.workspaceId })
        .where(eq(users.id, userId));
    }

    const [updatedUser] = await tx
      .select({ currentWorkspaceId: users.currentWorkspaceId })
      .from(users)
      .where(eq(users.id, userId));

    return { currentWorkspaceId: updatedUser?.currentWorkspaceId ?? null };
  });
};
```

The transaction here isn't protecting a manual multi-table cleanup the way it once did — deleting `projects`/`tasks`/`workspace_members` rows for the workspace is now a single database-level side effect of the one `DELETE FROM workspaces` statement, not four separate application-issued deletes that could partially fail. What the transaction *is* still protecting is read-after-write consistency across the remaining three statements: the workspace-ownership check, the cascade-triggered deletion, and the `currentWorkspaceId` reassignment all need to see a single consistent view of the data, and the reassignment specifically depends on the delete (and its cascade side effects) having already happened within the same transaction — reading `anotherMembership` outside the transaction could race against a concurrent membership change.

### 3.3 Everything else: single-statement writes, no transaction

For contrast, project and task creation — by far the most frequent writes in the app — never open a transaction at all, because each is a single `INSERT` into a single table:

```ts
// backend/src/services/project.service.ts:6-23
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
```

```ts
// backend/src/services/task.service.ts:31-77 (createTaskService, excerpted)
export const createTaskService = async (
  workspaceId: string,
  projectId: string,
  userId: string,
  body: { title: string; /* ... */ taskCode: string }
) => {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));

  if (!project || project.workspaceId !== workspaceId) {
    throw new NotFoundException(
      "Project not found or does not belong to this workspace"
    );
  }

  if (body.assignedTo) {
    await assertAssigneeIsWorkspaceMember(workspaceId, body.assignedTo);
  }

  const [task] = await db
    .insert(tasks)
    .values({ /* ... */ workspaceId, projectId, taskCode: body.taskCode })
    .returning();

  return { task };
};
```

Both do a *read* first (to validate the parent project exists and belongs to the right workspace) and then a single `.insert(...).returning()` — the read is not part of any atomicity guarantee, it's just a validation step, and the actual write is exactly one statement against one table.

### 3.4 Query mechanics: the combinators and raw `sql` this codebase actually uses

Every non-trivial query in `backend/src/services/` is built from a small, consistent vocabulary of Drizzle functions, and `getAllTasksService` (`backend/src/services/task.service.ts:143-205`) is the single best file to read for all of it in one place — it's the most filter-heavy list query in the codebase.

**`and()`/`eq()`/`inArray()` for multi-condition filtering.** `getAllTasksService` builds its `WHERE` clause incrementally, pushing a Drizzle `SQL` condition onto a `conditions` array for each filter that's actually present, then combining them all with `and(...conditions)` at the end:

```ts
// backend/src/services/task.service.ts:155-168
const conditions: SQL[] = [eq(tasks.workspaceId, workspaceId)];
if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
if (filters.status?.length)
  conditions.push(inArray(tasks.status, filters.status as (typeof tasks.status.enumValues)[number][]));
if (filters.priority?.length)
  conditions.push(inArray(tasks.priority, filters.priority as (typeof tasks.priority.enumValues)[number][]));
if (filters.assignedTo?.length)
  conditions.push(inArray(tasks.assignedTo, filters.assignedTo));
if (filters.keyword) {
  conditions.push(sql`${tasks.title} ILIKE ${"%" + filters.keyword + "%"}`);
}
if (filters.dueDate) conditions.push(eq(tasks.dueDate, new Date(filters.dueDate)));
```

`inArray(tasks.status, [...])` is what a Mongo-style `{ status: { $in: [...] } }` filter becomes in SQL — it compiles to `status = ANY($1)` (or an `IN (...)` list, depending on Drizzle's driver-specific choice), parameterized exactly like every other Drizzle-built condition, never string-concatenated. Building the `conditions` array incrementally like this — only pushing a condition when the corresponding filter is actually present — is what lets one query serve "list all tasks in this workspace" and "list tasks in this workspace filtered by status, priority, assignee, and keyword, all at once" without four different hand-written query variants.

**Raw `sql` template literals for what the query builder doesn't have a typed method for.** Two real cases in this codebase reach for `sql\`...\`` deliberately, both in `getAllTasksService`/`getProjectAnalyticsService`, rather than treating it as an escape hatch of last resort:

- **`ILIKE` for case-insensitive keyword search**: `sql\`${tasks.title} ILIKE ${"%" + filters.keyword + "%"}\`` (`task.service.ts:166`). Drizzle has no dedicated `.ilike()` helper in this codebase's version, so the raw SQL operator is used directly — but the interpolated values (`tasks.title`, the pattern string) are still passed through Drizzle's tagged-template mechanism, which parameterizes them exactly the way `eq()`/`inArray()` do; nothing here is string concatenation, and `'%'`/`'_'` are the only characters `ILIKE` treats specially — there's no regex engine involved, so there's no ReDoS surface the way an unbounded user-supplied `$regex` pattern would be in a document database.
- **`count(*) filter (where ...)` for multi-condition aggregates in one pass**: `getProjectAnalyticsService` (`backend/src/services/project.service.ts:88-113`) needs three different counts — total tasks, overdue tasks, completed tasks — computed from the same underlying row set, in one query rather than three separate ones:

```ts
// backend/src/services/project.service.ts:103-111
const [row] = await db
  .select({
    totalTasks: sql<number>`count(*)::int`,
    overdueTasks: sql<number>`count(*) filter (where ${tasks.dueDate} < now() and ${tasks.status} != 'DONE')::int`,
    completedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')::int`,
  })
  .from(tasks)
  .where(eq(tasks.projectId, projectId));
```

Postgres's `FILTER (WHERE ...)` clause is the SQL-native answer to "count rows matching condition A, and separately count rows matching condition B, from the same input, in one query" — a shape that in a document database without a native equivalent gets built out of a multi-stage aggregation pipeline running several conditional sub-counts as parallel branches over one filtered input. `getWorkspaceAnalyticsService` (`backend/src/services/workspace.service.ts:266-280`) uses the identical `FILTER` pattern at the workspace level instead of the project level — same shape, different `WHERE` scope.

**`.limit()`/`.offset()` for pagination**, paired with a second `count(*)` query for the total: `getAllTasksService` and `getProjectsInWorkspaceService` (`backend/src/services/project.service.ts:25-60`) both compute `skip = (pageNumber - 1) * pageSize` and pass it to `.offset(skip)` alongside `.limit(pageSize)` on the main `SELECT`, then run a second, separate `SELECT count(*)::int ... WHERE <same conditions>` to get the total row count for computing `totalPages`. `getProjectsInWorkspaceService` runs its two queries (`.limit()/.offset()`'d rows, and the `count(*)`) concurrently via `Promise.all([...])` rather than sequentially — since neither query depends on the other's result and both hit the same table, there's no reason to pay two round trips in series when one round trip's latency can cover both.

**`.leftJoin()` vs. `.innerJoin()` — a real correctness distinction, not a style choice.** This is the single most important query-mechanics lesson this codebase has to teach, and it's worth stating precisely because getting it wrong doesn't throw an error — it silently drops rows. `getAllTasksService` joins `tasks` to `users` (for the assignee) and to `projects` (for the parent project), and uses `leftJoin` for both:

```ts
// backend/src/services/task.service.ts:185-191
.from(tasks)
// leftJoin, not innerJoin: assignedTo is nullable - an innerJoin here
// would silently drop every unassigned task from the result.
.leftJoin(users, eq(tasks.assignedTo, users.id))
.leftJoin(projects, eq(tasks.projectId, projects.id))
```

`tasks.assignedTo` is a nullable foreign key (`uuid("assigned_to").references(() => users.id, { onDelete: "set null" })`, per `07-database-schema-design.md` §3.7) — an unassigned task is a completely valid, common row. An `INNER JOIN` only returns a row from the left table when a matching row exists on the right; for every task where `assigned_to IS NULL`, there is by definition no matching `users` row, so an `innerJoin(users, eq(tasks.assignedTo, users.id))` would silently exclude every unassigned task from the result set entirely — no error, no warning, just fewer rows than expected, and specifically the rows a real user (an unassigned-tasks board column, a "show me everything" filter) most needs to see. `leftJoin` returns the task row regardless, with every `users.*` projected column coming back `null` when there's no match — exactly the semantics an optional relationship needs.

Contrast this with `getWorkspaceMembersService` (`backend/src/services/workspace.service.ts:193-212`), which joins `workspace_members` to `users` and to `roles` using `innerJoin` for both — correctly, this time, because `workspace_members.userId` and `workspace_members.roleId` are both `NOT NULL` foreign keys (per the schema, every membership row is guaranteed to reference a real user and a real role), so an inner join can never silently drop a membership the way it would if either FK were nullable. The rule this codebase actually follows, checkable against both examples: **join type is a direct function of whether the foreign key being joined on is nullable — `leftJoin` for a nullable FK, `innerJoin` for a `NOT NULL` one** — never a default reached for out of habit. Getting this backwards in either direction is a real bug class: an `innerJoin` on a nullable column silently drops valid rows (as just shown), and a `leftJoin` on a genuinely mandatory relationship just adds unnecessary planner overhead without being wrong, which is a much smaller cost but still worth naming as the two failure directions of the same underlying choice.

### 3.5 Connection lifecycle: startup and graceful shutdown

`db.execute(sql\`SELECT 1\`)` is awaited in `src/index.ts` before the server ever calls `app.listen(...)` — this is `backend/src/index.ts`'s startup gate, already shown in full in [`00-master-backend-architecture.md` §3](./00-master-backend-architecture.md#3-bootstrap-in-full-backendsrcappts--backendsrcindexts). A failure there calls `process.exit(1)` before the process ever binds a port, so an ECS health check never sees this task report itself as listening while it can't reach Postgres. Redis is deliberately *not* part of that same startup gate — `redis/client.ts`'s own `"error"` listener logs a connection error non-fatally, on the theory that a transient Redis blip is recoverable mid-life and shouldn't crash process startup the way an unreachable primary datastore should.

Shutdown is the mirror image, and it's where `client.ts`'s separate `pool` export actually gets used:

```ts
// backend/src/index.ts (excerpted — full file in 00-master-backend-architecture.md §3)
import { db, pool } from "./db/client";
import { redis } from "./redis/client";
// ...
server.close(async (closeError) => {
  // ...
  await pool.end();
  redis.disconnect();
  // ...
});
```

`server.close()`'s callback runs only once every in-flight HTTP request has finished draining — so `pool.end()` (which waits for any query the pool is still mid-executing to finish, then closes every pooled connection) and `redis.disconnect()` only run after that drain completes, not concurrently with live requests. This ordering is what prevents a request that's mid-query when `SIGTERM` arrives from having its connection yanked out from under it. `db` itself is never explicitly closed — closing `pool` is sufficient, since `db` holds no connections of its own; it only ever borrows from `pool` for the duration of each query.

### 3.6 Test-database strategy: real containers, not mocks

The test suite doesn't mock Drizzle or stub out Postgres/Redis — it runs against real, ephemeral containers spun up once per test run via `testcontainers`:

```ts
// backend/tests/setup/global-setup.ts, in full
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, StartedTestContainer } from "testcontainers";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import path from "path";
import { RolePermissions } from "../../src/utils/role-permission";
import * as schema from "../../src/db/schema";

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;

const seedRoles = async (connectionString: string): Promise<void> => {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  for (const [name, permissions] of Object.entries(RolePermissions)) {
    await db
      .insert(schema.roles)
      .values({ name: name as keyof typeof RolePermissions, permissions })
      .onConflictDoNothing({ target: schema.roles.name });
  }

  await pool.end();
};

export default async function setup(): Promise<() => Promise<void>> {
  [postgresContainer, redisContainer] = await Promise.all([
    new PostgreSqlContainer("postgres:16").start(),
    new GenericContainer("redis:7").withExposedPorts(6379).start(),
  ]);

  const databaseUrl = postgresContainer.getConnectionUri();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  const migrationPool = new Pool({ connectionString: databaseUrl });
  const migrationDb = drizzle(migrationPool);
  await migrate(migrationDb, {
    migrationsFolder: path.resolve(__dirname, "../../src/db/migrations"),
  });
  await migrationPool.end();

  await seedRoles(databaseUrl);

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;

  return async () => {
    await Promise.all([postgresContainer.stop(), redisContainer.stop()]);
  };
}
```

Three things worth internalizing here. First, `migrate(migrationDb, { migrationsFolder: ... })` runs the **real, drizzle-kit-generated SQL migrations** (`backend/src/db/migrations/0000_whole_microchip.sql`, `0001_overrated_tomorrow_man.sql`, `0002_youthful_firestar.sql`) against the throwaway container — the test database's schema is produced by literally the same migration files that would run against a real environment, not a hand-maintained test-only schema that could drift from production DDL. Second, `seedRoles` inserts the fixed `OWNER`/`ADMIN`/`MEMBER` role set using `.onConflictDoNothing({ target: schema.roles.name })` — Drizzle's `INSERT ... ON CONFLICT DO NOTHING`, targeting the same `roles_name_idx` unique constraint documented in [`07-database-schema-design.md` §3.4](./07-database-schema-design.md#34-roles) — mirroring what `backend/src/db/seed-roles.ts` does against a real database. Third, and structurally: this is a Vitest `globalSetup` function, run once for the whole suite (not per test file), specifically because booting a fresh Postgres and Redis container is expensive enough that per-file setup would make the suite prohibitively slow — `process.env.DATABASE_URL`/`REDIS_URL` are set here, before any test file's imports run, which matters because `db/client.ts` and `redis/client.ts` both read those env vars and open their connections at import time.

This is a genuine, structural improvement over what a Mongoose-era test setup needed: there's no equivalent here of needing a *replica set* specifically to support multi-document transactions (a standalone MongoDB instance couldn't run those at all) — a single ordinary Postgres container supports `BEGIN`/`COMMIT`/`ROLLBACK` natively, with no special topology requirement, so `testcontainers`' plain `PostgreSqlContainer` is sufficient for every transactional test path in this codebase.

---

## 4. Request/Data Flow — tracing `createWorkspaceService`

Walking `createWorkspaceService` end to end, tying the trace back to the exact code in §3.2:

1. **`db.transaction(async (tx) => { ... })` is called and awaited.** Drizzle issues `BEGIN` against a connection checked out from `pool`, and the callback receives `tx` — a query-builder client scoped to that one open transaction. From this point, every read against `tx` sees a consistent snapshot within the transaction, and every write through `tx` is provisional until commit.
2. **`tx.select().from(users).where(eq(users.id, userId))`** — the calling user is looked up *inside* the transaction. If this comes back empty, `NotFoundException("User not found")` is thrown immediately — no writes have happened yet, so there's nothing for the automatic rollback to undo besides the transaction's own `BEGIN`.
3. **`tx.select().from(roles).where(eq(roles.name, "OWNER"))`** — a second read, still inside the same transaction, to find the role the new workspace's creator will be assigned. Missing this throws `NotFoundException("Owner role not found")` — again, before any write.
4. **Three sequential writes, all through `tx`**: `tx.insert(workspaces).values({...}).returning()` (get the new workspace's generated `id` back immediately, no separate re-fetch needed), `tx.insert(workspaceMembers).values({...})` (the OWNER membership row), and `tx.update(users).set({ currentWorkspaceId: workspace.id }).where(eq(users.id, user.id))`.
5. **The callback returns `{ workspace }`.** This is the point Drizzle commits — there is no explicit `await tx.commit()` call anywhere in this function; resolving the callback's promise *is* the commit signal. `db.transaction(...)`'s own returned promise resolves with whatever the callback returned, so `createWorkspaceService`'s `return db.transaction(...)` line passes `{ workspace }` straight through to its caller.
6. **If anything in steps 2-4 had thrown instead** — the two `NotFoundException`s already covered, or a Postgres-level failure like a constraint violation on the `workspaces.owner_id` foreign key — Drizzle's `db.transaction()` catches that rejection internally, issues `ROLLBACK` on the same connection, and re-throws the original error out of the `await db.transaction(...)` call. The caller (the workspace controller, then `asyncHandler`, then the global `errorHandler`, per [`04-error-handling-patterns.md`](./04-error-handling-patterns.md)) sees the real `NotFoundException` or Postgres error exactly as thrown — there's no separate `catch` block inside `createWorkspaceService` itself deciding when to roll back, because Drizzle's `db.transaction()` API makes "any throw rolls back, any resolve commits" the *only* behavior, not a convention every call site has to remember to implement correctly.
7. **Connection release is automatic.** Once `db.transaction()` either commits or rolls back, the underlying `pg` connection is returned to `pool` for reuse — there's no equivalent of a manual `session.endSession()` call to remember, and therefore no way to leak a transaction-scoped connection out of the pool by forgetting one, the specific bug class a hand-rolled session API can produce if a `finally` block is missing.

---

## 5. Design Decisions & Tradeoffs

**The criterion for "does this need a transaction" is observable directly from the five cases in §3.2: a transaction is used exactly when a single logical operation writes to more than one table, and a partial completion would leave referentially-inconsistent data behind.** Checking each one against that rule:

- `registerUserService` — a `users` row with no matching `accounts` row means the user can never log in with the credentials they just set; a `workspaces` row with no `workspace_members` row means nobody owns it. Four tables, genuinely coupled.
- `loginOrCreateAccountService` — same coupling as registration, on the "new user via OAuth" branch; the "existing user" branch still opens a transaction even though it ends up writing to only one table (a new `accounts` row), because which branch will run isn't known until the transaction is already open.
- `deleteAccountService` — deleting the `users` row but leaving orphaned `workspace_members`/`accounts` rows pointing at a now-nonexistent user would corrupt every one of those tables' referential assumptions (in practice, the `ON DELETE CASCADE` on both FKs would clean this up automatically on the `users` delete alone — the transaction here is about ordering the task-unassignment step correctly relative to the cascade, not about preventing orphaned rows that the schema already forbids).
- `createWorkspaceService`/`deleteWorkspaceService` — a `workspaces` row with no owning `workspace_members` row (create), or a stale `currentWorkspaceId` reference left unreconciled after a delete's cascade already fired (delete), are both broken-or-inconsistent states worth protecting against.

The rule holds without exception across every transactional case found. Conversely, `createProjectService` and `createTaskService` (§3.3) write to exactly one table each — Postgres's built-in per-statement atomicity is already the strongest guarantee that operation needs, so wrapping it in `db.transaction(...)` would only add a round trip for `BEGIN`/`COMMIT` for zero additional safety.

**`ON DELETE CASCADE` moved real logic out of the transaction, not just out of the codebase.** `deleteWorkspaceService`'s transaction body is dramatically smaller than what a from-scratch, no-FK-constraints version would need — deleting `projects`/`tasks`/`workspace_members` rows for the workspace used to require (in the pre-migration model this schema replaced) explicit, ordered `deleteMany` calls, each one more code that could be gotten wrong or forgotten on a new delete path. Here, one `DELETE FROM workspaces` statement triggers all of that as a database-level, atomic side effect — the transaction's job shrinks to exactly the part that genuinely isn't a pure cascade consequence: reassigning the deleting user's `currentWorkspaceId`. This is the concrete payoff of foreign keys with real `ON DELETE` behavior (fully argued in [`07-database-schema-design.md` §6](./07-database-schema-design.md#6-design-decisions--tradeoffs)) showing up specifically in the query-mechanics layer, not just the schema layer.

**Bounded connection pool over the driver default.** `pg`'s own default pool behavior (unbounded, or a very high implicit ceiling depending on version) is sized for "one process, one database, nothing else sharing the connection budget" — exactly wrong for a horizontally-scaled ECS service where every task independently opens its own pool against the same Postgres instance. Explicitly capping at `PG_MAX_POOL_SIZE=15` (with a floor of `PG_MIN_POOL_SIZE=2` warm connections) is a deliberate trade of per-task query concurrency for cluster-wide connection safety — see §7 for whether that specific number holds up as a 2026 best practice, and §3.1 for the real gap between where this value is *computed* (`app.config.ts`) and where it's actually *read* (`db/client.ts`, independently, via `getEnv`).

**No repository layer — what's given up.** Query logic that would live once behind a `WorkspaceRepository.findById()` in a repository-pattern codebase is instead duplicated per call site: `db.select().from(workspaces).where(eq(workspaces.id, workspaceId))` with a not-found check appears near-verbatim in `getWorkspaceByIdService`, `changeMemberRoleService`, `removeMemberFromWorkspaceService`, `resetWorkspaceInviteCodeService`, `updateWorkspaceByIdService`, and `deleteWorkspaceService` — six independent copies of the same lookup-and-guard. What's bought in exchange is the absence of an abstraction layer that would need its own tests and its own maintenance burden, for a benefit (swapping out Drizzle for a different query layer) that isn't actually on AstriX's roadmap — the same tradeoff already argued at the architecture level in [`01-architecture-patterns-and-project-structure.md` §5](./01-architecture-patterns-and-project-structure.md#5-design-decisions--tradeoffs). This is a reasonable trade for a single-database, single-team codebase at this size — the calculus would flip if the query-logic duplication above ever caused a real bug (two of the six copies drifting out of sync on what "not found" means, for instance).

---

## 6. Security Considerations

**`DATABASE_URL`/`REDIS_URL` and log exposure.** Neither connection string is ever logged directly anywhere in `backend/src` — `db/client.ts` and `redis/client.ts` both read their respective URL once, at import time, and pass it straight to the driver constructor (`new Pool({ connectionString: ... })`, `new Redis(...)`). The real exposure risk is indirect, the same shape [`04-error-handling-patterns.md` §6](./04-error-handling-patterns.md#6-security-considerations) already covers for the general case: `redis/client.ts`'s `"error"` listener logs `{ err }` on every Redis connection error, and the global `errorHandler` logs `{ err: error, path: req.path }` on every failed request. Whether a `pg` or `ioredis` connection-error object's `.message` embeds the connection string (with or without credentials) is a property of those drivers' own error formatting, not of this application's code — modern driver versions generally avoid echoing credentials in error messages, but that's an assumption resting on driver behavior, not something this codebase tests or asserts on its own.

**Transaction-failure reliability is now structural, not a convention every call site has to get right.** Every one of the five transactional functions in §3.2 relies on the exact same guarantee — `db.transaction()`'s callback contract, where any thrown error triggers `ROLLBACK` automatically. This is a meaningfully stronger property than a hand-rolled session API offers: there is no `catch` block anywhere in this codebase that could accidentally *not* call the rollback equivalent, because there's no separate rollback call for application code to remember at all. What's still worth naming honestly rather than assuming away: `db.transaction()`'s automatic rollback is itself a property of Drizzle's implementation atop `pg`, not something this codebase has its own test coverage independently verifying — a genuine network partition between the app and Postgres mid-transaction is handled by Postgres's own connection-loss semantics (an in-flight, un-committed transaction on a dropped connection is simply never committed, since `COMMIT` itself would fail on a dead connection), not by any explicit code path in this repository.

**Data-integrity gap in non-transactional multi-write flows.** Not every multi-step write in the codebase is wrapped in a transaction — only the five listed in §3.2 are. `removeMemberFromWorkspaceService` (`backend/src/services/workspace.service.ts:132-188`) is a concrete counter-example: it runs a `db.delete(workspaceMembers).where(...).returning()`, then a `db.update(tasks).set({ assignedTo: null }).where(...)` to unassign that member's tasks, then conditionally a `db.select()` + `db.update(users)` to fix up `currentWorkspaceId` — three independent, non-transactional statements against the plain `db` object, not `tx`. If the `tasks` update throws after the membership row has already been deleted, the membership is gone but their tasks stay assigned to a user who's no longer in the workspace — a real, currently-unprotected partial-completion state. This isn't a case where a rollback happens and this doc is claiming otherwise; the opposite is true: there genuinely is no rollback here, because there's no transaction in this function at all. It's flagged because it's the kind of case the criterion in §5 (multiple tables, one logical operation) would suggest belongs in a transaction, but doesn't currently have one — a real, verifiable gap, not a hypothetical.

**Resource exhaustion from unbounded `.select()` calls.** A grep across every service for `.select(` with no accompanying `.limit(...)` turns up several queries that return every matching row with no ceiling: `getWorkspaceMembersService`'s member list (`workspace.service.ts:193-212`), `getAllWorkspacesUserIsMemberService`'s membership list (`workspace.service.ts:62-70`), and `getUserSessionsService`'s active-session list (backed by Redis, not Postgres, but the same shape). In practice, most are bounded by realistic real-world cardinality today (a user's own workspace memberships, a small team's session count), but `getWorkspaceMembersService` — the full member list of a single workspace — has no enforced ceiling at all: a workspace that grows to thousands of members would return every one of them in a single unpaginated response, the same latent risk this codebase's Mongo-era predecessor had and never resolved. This is a genuine, currently-unmitigated risk rather than an active incident, since AstriX's actual usage pattern (small team workspaces) keeps the numbers low today — worth flagging plainly rather than assuming away as "fine because nobody's hit it yet."

---

## 7. Best Practice Check

**Connection pooling.** AstriX's explicit `PG_MAX_POOL_SIZE=15`/`PG_MIN_POOL_SIZE=2`, reasoned about directly against "N ECS tasks × pool size must stay under the database's total connection ceiling," is exactly the 2026 industry-standard shape for pooling in a containerized, horizontally-scaled Node service: never inherit the driver's unbounded default, size the pool as (total connection budget) ÷ (expected replica count), and keep a small warm floor to avoid cold-connection latency on scale-out. The one real, fixable gap here — distinct from the sizing choice itself, which is sound — is the dead-config issue named in §3.1/§5: `app.config.ts` computes `PG_MAX_POOL_SIZE`/`PG_MIN_POOL_SIZE` onto the shared `config` object, but `db/client.ts` never reads them, reaching for `getEnv(...)` directly instead. Worth fixing by having `client.ts` import and use `config.PG_MAX_POOL_SIZE`/`config.PG_MIN_POOL_SIZE` — today it's harmless only because both reads happen to use identical env var names and identical defaults.

**Transaction-usage discipline.** Using real transactions only for the five genuinely multi-table writes identified in §3.2, and leaving every single-statement write (the overwhelming majority of the app's write volume — project creation, task creation, task updates, role changes) on plain per-statement atomicity, is current (2026) best practice, not a dated compromise. Transactions carry real cost — an extra round trip for `BEGIN`/`COMMIT`, and (for a naive implementation) held row/table locks for the transaction's duration — so reaching for one only where atomicity genuinely spans statements, rather than wrapping every write "just in case," is the currently-recommended posture, and AstriX's actual usage matches it precisely. Drizzle's callback-based `db.transaction()` API is also itself a best-practice-aligned choice relative to a manual `BEGIN`/`COMMIT`/`ROLLBACK` sequence: it structurally eliminates the "forgot to roll back" and "forgot to release the connection" bug classes a hand-rolled session/transaction API is exposed to, by making commit-on-resolve/rollback-on-throw the only code path rather than a convention every call site has to independently implement correctly.

**Query-level performance.** Mixed, in the same direction as the schema-design chapter's own honest gaps. Indexing lines up well with actual query shapes — `tasks_workspace_project_idx` and `tasks_workspace_status_idx` back exactly the two filter combinations `getAllTasksService` runs (per [`07-database-schema-design.md` §3.7](./07-database-schema-design.md#37-tasks)), and every index in the schema traces to a real `WHERE`/`JOIN` clause rather than being added speculatively. What's unresolved, as named in §6, is pagination coverage: `getAllTasksService` and `getProjectsInWorkspaceService` do paginate properly (`.limit()`/`.offset()` plus a matched `count(*)` query), but `getWorkspaceMembersService` and `getAllWorkspacesUserIsMemberService` don't paginate at all — a gap this codebase inherited conceptually from its pre-migration predecessor rather than introducing fresh, and one that's cheap to close (the same `.limit()`/`.offset()` pattern already proven correct elsewhere in this file) whenever workspace member counts actually grow large enough to matter.

**Migration tooling.** `drizzle-kit generate` producing plain, readable `.sql` files (`backend/src/db/migrations/0000_whole_microchip.sql` through `0002_youthful_firestar.sql`, tracked via `backend/src/db/migrations/meta/_journal.json`) rather than an opaque, framework-internal migration format is a genuine 2026-best-practice choice for a small team: the actual DDL that will run against production is reviewable in a pull request diff exactly as written, and `backend/drizzle.config.ts` (`schema: "./src/db/schema.ts"`, `out: "./src/db/migrations"`, `dialect: "postgresql"`) is the entire configuration surface needed to regenerate one. This is a genuine, structural improvement over this codebase's pre-migration predecessor, which had no schema-versioning story at all.

---

## 8. Debug Drill

**Scenario 1 — a query joining two tables is returning fewer rows than expected, and nothing threw an error.**

1. **Check whether the join is an `innerJoin` where it should be a `leftJoin`.** This is the single most common cause in this codebase specifically, and it's a *correctness* bug, not a performance one: an `innerJoin` against a column that can be `NULL` (`tasks.assignedTo` is the real, checkable example) silently drops every row where that column is null, rather than erroring. §3.4 walks the exact `getAllTasksService`/`getWorkspaceMembersService` contrast that makes this concrete — the rule is "nullable FK → `leftJoin`, `NOT NULL` FK → `innerJoin`," always.
2. **Confirm the FK's `ON DELETE` behavior matches what you expect for that column.** A row that "should" be there but isn't might have been legitimately removed by a cascade — check whether the parent row was deleted, and whether the child's FK was declared `CASCADE` (row gone), `SET NULL` (row present, reference cleared — check for an unexpected `NULL`), or should have been `RESTRICT`/no-clause (the delete should never have succeeded at all; if it did, the FK is missing or misconfigured). Full inventory of every FK's `ON DELETE` choice and why is [`07-database-schema-design.md` §6](./07-database-schema-design.md#6-design-decisions--tradeoffs).
3. **Check the `WHERE` clause's condition list, not just the join.** `getAllTasksService` builds its `conditions` array incrementally from optional filters (`filters.status?.length`, `filters.keyword`, etc.) — a filter that's present but evaluates to an empty array/string can silently produce a `WHERE` clause that excludes everything, which reads identically to "the join is wrong" from the caller's side.
4. **Run `EXPLAIN ANALYZE` on the actual query, not a paraphrase of it.** Confirm which indexes the planner actually chose — a query that "should" use `tasks_workspace_status_idx` but instead does a full sequential scan isn't a correctness bug on its own, but it's often the fastest way to notice that the `WHERE` clause isn't shaped the way you assumed it was (a filter condition compiled into a `sql\`...\`` fragment slightly differently than intended, for instance).

**A related, equally common scenario: a write fails with a unique-constraint violation you didn't expect.** First check whether the constraint is compound (`workspace_members_user_workspace_unique`, on `(user_id, workspace_id)` together) rather than single-column — a compound unique constraint is violated by the *combination*, and Postgres's `23505` error payload includes the actual `Key (...)=(...) already exists` detail naming exactly which columns and values collided, which is faster to read than re-deriving it from the schema file. `joinWorkspaceByInviteService` (`backend/src/services/member.service.ts:31-63`) is the one place in this codebase that catches `23505` explicitly, re-throwing it as a clean `BadRequestException` — see [`04-error-handling-patterns.md` §3.3](./04-error-handling-patterns.md#33-the-centralized-errorhandler-full-precedence-chain--now-four-branches-shorter) for the full reasoning on why that's handled at the throw site rather than centrally.

**Scenario 2 — a multi-step operation partially completed instead of cleanly rolling back.**

1. **Find the function and check whether it actually calls `db.transaction(...)` at all.** The single most common cause of "partial completion" in this codebase isn't a broken transaction — it's the absence of one. Grep the function for `db.transaction(`; if it isn't there, every write inside it is independently committed the moment it runs, and there is nothing to roll back by design. `removeMemberFromWorkspaceService` (§6) is the real, currently-existing example of exactly this gap.
2. **If a transaction is present, check that every write in the function actually goes through `tx`, not the module-level `db`.** A single `.insert(...)`/`.update(...)`/`.delete(...)` accidentally called on `db` instead of the callback's `tx` parameter commits immediately, outside the transaction, regardless of whether the surrounding transaction later rolls back — this produces exactly the "partially completed" symptom even though `db.transaction(...)` is technically in use somewhere in the function. This is the direct Drizzle equivalent of the old session-API bug class where a `.save({ session })` call was missing its `session` argument.
3. **Confirm the throw actually happens inside the transaction callback, not after it.** A `try`/`catch` somewhere between a genuine failure and the transaction boundary could be swallowing the error and letting the callback resolve successfully anyway — `db.transaction()` only rolls back if the callback's promise *rejects*; a caught-and-ignored error inside the callback that doesn't re-throw commits whatever writes happened before it, silently.
4. **Verify no cross-datastore step was mistakenly assumed to be covered by the Postgres transaction.** `deleteAccountService`'s `invalidateAllSessionsForUser(userId)` (§3.2) runs deliberately *after* the transaction commits, because Redis session state was never part of the Postgres transaction to begin with — if a future change tried to call a Redis-touching function *inside* `db.transaction(async (tx) => {...})`, expecting it to roll back alongside the Postgres writes on failure, that expectation would be wrong: only statements issued through `tx` are transactional, and no Redis client here is transaction-aware at all.
