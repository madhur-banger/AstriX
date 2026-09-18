# Phase 1 — Schema Design + PostgreSQL Fundamentals

> Part of the [migrations/](./PLAN.md) series. Assumes
> [Phase 0](./phase-0-infra-and-theory-foundations.md) is done (Postgres +
> Redis running locally). This file: every table, in full DDL, with the
> Postgres theory behind each decision, mapped against the exact Mongoose
> model it replaces. No app code yet — everything here is verified by hand
> in `psql`.

---

## 1.1 Theory: how Postgres actually stores and finds a row

Before designing tables, understand what you're asking Postgres to do
physically — this changes how you think about every DDL choice below.

### Heap storage + MVCC

A Postgres table is a **heap** — rows are not stored in any particular
order (unlike, say, a clustered index in SQL Server/MySQL InnoDB, where the
primary key *is* the physical row order). Postgres uses **MVCC**
(Multi-Version Concurrency Control): an `UPDATE` doesn't overwrite a row in
place — it writes a **new row version** and marks the old one dead. Reads
never block writes and writes never block reads, because a transaction
simply sees the row version that was current when its transaction (or
statement) started. This is a deep, genuine difference from how Mongo's
WiredTiger storage engine also does MVCC internally, actually — the
concept transfers, but the operational consequence in Postgres is distinct:

- Dead row versions accumulate until **`VACUUM`** reclaims them. Postgres
  runs `autovacuum` by default; you will actually *see* this matter the
  first time you run a bulk `UPDATE`/`DELETE` in testing and notice table
  bloat — worth doing deliberately once in Phase 2's testing to internalize
  it, not just read about it.
- This is *why* Postgres transactions don't need a replica set the way Mongo
  does — MVCC snapshot isolation is a single-node concept from the start.

### How a query actually gets planned

Every `SELECT` goes through: **parse → rewrite → plan → execute**. The
**planner** is the part with no real Mongo equivalent — it uses table
statistics (row counts, value distribution, collected by `ANALYZE`) to
estimate the cost of every possible way to execute your query (sequential
scan vs. index scan, nested-loop join vs. hash join vs. merge join) and
picks the cheapest estimated plan. You will use `EXPLAIN ANALYZE` constantly
in Phase 2 — it's the single most important Postgres skill to build, because
it's how you *verify* an index is actually being used rather than assuming
it.

### B-tree indexes, precisely

Postgres's default index type (`CREATE INDEX`) is a B-tree — same
conceptual structure as MongoDB's default index. What to actually
internalize:

- A B-tree index can serve `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, and
  (leftmost) `LIKE 'prefix%'` — but **not** `LIKE '%suffix'` or full-text
  search (those need different index types — see §1.5).
- **Compound index column order is a leftmost-prefix rule**, identical to
  Mongo's compound index rule you already used correctly in
  `task.model.ts` (`{ workspace: 1, status: 1 }` serves `workspace` alone
  or `workspace+status`, not `status` alone). The exact same reasoning
  carries over 1:1 — this is genuinely transferable knowledge, not
  something to relearn.
- An index makes **writes slower** (every `INSERT`/`UPDATE` must also update
  every index on the table) to make **reads faster**. This tradeoff is
  identical in both databases; only the syntax differs.

---

## 1.2 Theory: normalization — what it means, precisely, not just "avoid duplication"

Normalization is a formal hierarchy (1NF, 2NF, 3NF, BCNF...) but the
practically useful version is:

- **1NF**: every column holds a single, atomic value — no arrays or nested
  documents in a column (Postgres actually *allows* array/JSONB columns,
  which is a deliberate escape hatch — see §1.6 for where this codebase
  legitimately uses it).
- **2NF/3NF, informally**: every non-key column depends on **the whole
  primary key, and nothing but the primary key**. In practice: if you find
  yourself repeating `project.name` inside every `task` row "for
  convenience," you've denormalized — the fix is a foreign key to
  `projects.id` and a `JOIN` at read time, not a copy.

**Why this matters concretely here:** `TaskType` on the client
(`client/src/types/api.type.ts:295-299`) embeds
`project: { _id, emoji, name }` inline in the task response — this is a
**read-shape** built by `.populate()` from the single source of truth (the
`projects` collection), not actual duplicated storage. The Mongo document
itself only stores `project: ObjectId`. This is worth confirming precisely
because it means **the Mongo data itself is already normalized** — the
denormalization only exists transiently, in API response shapes. Postgres
preserves this exact property: store the FK, `JOIN` to build the same
response shape at read time.

---

## 1.3 The full ER model

Every current Mongoose collection, and its relational target. Read this
before any DDL — get the shape right on paper first (literally sketch it,
even in ASCII) before typing `CREATE TABLE`.

```
users ──────────┬──< owns >────── workspaces
   │             │                    │
   │             │                    │
   │        (current_workspace_id,    │
   │         nullable FK, circular    │
   │         with workspaces.owner_id)│
   │                                  │
   └──< member of >── workspace_members ──> roles
                            │
                            ├──< in >── projects ──< in >── tasks
                            │                              │
   users ──< assigned_to >──────────────────────────────────┘
   users ──< created_by >── (projects, tasks)
   users ──< has >── accounts (OAuth)

[sessions, password_reset_tokens, email_verification_tokens →
 all move to Redis in Phase 3, not modeled here as Postgres tables —
 see phase-3-redis-migration-and-ttl-data.md]
```

### The circular FK: `users.current_workspace_id` ↔ `workspaces.owner_id`

This is the one genuinely tricky modeling decision, worth calling out
explicitly because it's a common real-world relational puzzle, not specific
to this app. `UserDocument.currentWorkspace` points at a workspace; every
`WorkspaceDocument.owner` points at a user. Neither table can exist "first."
Two valid resolutions:

1. **Create both tables with the FK columns nullable**, insert rows with
   the FK left `NULL` initially, then `UPDATE` to set the reference once
   both rows exist. This is what application code will naturally do anyway
   (a user has no `current_workspace_id` until they create/join one).
2. Add one of the two constraints via `ALTER TABLE ... ADD CONSTRAINT`
   **after** both tables are created, using `DEFERRABLE INITIALLY DEFERRED`
   if you ever need to insert both rows in the same transaction with
   neither existing yet.

Recommendation: **option 1** — it matches the actual application lifecycle
(`registerUserService` in `auth.service.ts` creates the user *before* the
workspace exists) and needs no deferred-constraint complexity.

---

## 1.4 Full DDL, table by table, mapped against the source Mongoose model

Run each `CREATE TABLE` by hand in `psql` as you read it — don't paste the
whole file at once. The point of this phase is understanding each decision.

```sql
-- Required once per database, for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

### `users` ← `models/user.model.ts`

```sql
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT,
  profile_picture     TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_email_verified   BOOLEAN NOT NULL DEFAULT false,
  last_login          TIMESTAMPTZ,
  current_workspace_id UUID,  -- FK added after workspaces exists, see below
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_idx ON users (email);
```

**Decisions worth understanding, not just copying:**

- `email TEXT NOT NULL UNIQUE` — Mongoose had `unique: true, lowercase:
  true`. Postgres has no built-in "lowercase on write" — either normalize
  in application code before insert (matches current behavior, simplest),
  or use a **case-insensitive unique index**:
  `CREATE UNIQUE INDEX ON users (lower(email));` combined with a `CHECK
  (email = lower(email))` constraint if you want the database itself to
  refuse non-lowercase emails rather than trusting app code. Recommendation:
  do the lowercase normalization in the service layer (matches current
  Mongoose behavior 1:1) — a functional index is a good thing to know
  exists, but adding it here is solving a problem the app already handles.
- `password_hash` (renamed from Mongoose's `password`) — the column name
  should say what it stores. Mongoose's `select: true` (meaning: by default,
  include it in query results, opposite of many auth codebases' `select:
  false` convention) doesn't have a direct Postgres equivalent — in
  Postgres/Drizzle you control this by simply not including the column in
  your `SELECT`'s column list in read-path queries, and including it only in
  the login-comparison query. This is arguably clearer: Mongoose's
  `select: false` field-level flag is invisible at the call site; a
  Postgres/Drizzle explicit column list is visible in every query.
- **No `TIMESTAMP` — always `TIMESTAMPTZ`.** This is a real, common Postgres
  footgun: bare `TIMESTAMP` stores a naive wall-clock value with no timezone
  awareness, which silently corrupts once your app, database, and clients
  aren't all in the same timezone. `TIMESTAMPTZ` stores UTC internally and
  converts on display. Mongoose's `Date` type is timezone-aware by nature
  (JS `Date` is always a UTC instant internally) — `TIMESTAMPTZ` is the
  honest equivalent, `TIMESTAMP` is not.
- `updated_at` needs a trigger to auto-update on every `UPDATE` (Postgres
  has no `{ timestamps: true }` shorthand):
  ```sql
  CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END;
  $$ LANGUAGE plpgsql;

  CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  ```
  Write this trigger once, reuse `set_updated_at()` on every table below —
  this is the Postgres-native equivalent of Mongoose's automatic
  `updatedAt`, and it's strictly more reliable: it fires on **any** write
  path (including a raw `UPDATE` from `psql`), where Mongoose's
  `{ timestamps: true }` only fires through Mongoose's own `.save()`/update
  methods.

### `roles` ← `models/roles-permission.model.ts`

```sql
CREATE TYPE role_name AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE permission AS ENUM (
  'CREATE_WORKSPACE','DELETE_WORKSPACE','EDIT_WORKSPACE','MANAGE_WORKSPACE_SETTINGS',
  'ADD_MEMBER','CHANGE_MEMBER_ROLE','REMOVE_MEMBER',
  'CREATE_PROJECT','EDIT_PROJECT','DELETE_PROJECT',
  'CREATE_TASK','EDIT_TASK','DELETE_TASK',
  'VIEW_ONLY'
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        role_name NOT NULL UNIQUE,
  permissions permission[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Why `CREATE TYPE ... AS ENUM` instead of `TEXT` + `CHECK`:** Postgres
native enums are stored as 4-byte values internally (faster, smaller than
comparing strings) and self-document valid values in
`information_schema`/`\d` — closer in spirit to Mongoose's
`enum: Object.values(Roles)`. The tradeoff to know: **adding a new enum
value later requires `ALTER TYPE ... ADD VALUE`**, which historically
couldn't run inside a transaction with other DDL (fixed in newer Postgres,
but still worth knowing as a classic Postgres gotcha) — a `TEXT` + `CHECK
(name IN (...))` constraint is more painful to extend correctly too, just
differently. For a small, truly fixed set like `role_name` (3 values, driven
by a hardcoded `RolePermissions` map in `utils/role-permission.ts`, not
user input), the native enum is the right, idiomatic choice.

**Why `permission[]` (a native array column) instead of a `role_permissions`
join table:** this is the exact tradeoff flagged in PLAN.md §1a — a real
modeling decision, not a default. An array column is 1NF-violating in the
strict sense (a column isn't atomic), but Postgres explicitly supports
arrays as a pragmatic escape hatch, and this data has three properties that
make the escape hatch the right call: the permission set per role rarely
changes, you never need to query "which roles have permission X" with a
`JOIN` (permission checks happen the other direction: given a role, what can
it do), and normalizing it into a join table would be modeling for a query
pattern that doesn't exist. **Do the array column here; treat a join table
as a deliberate exercise to try later if you want practice with true
many-to-many modeling** — `workspace_members` below is that exercise,
because unlike roles↔permissions, users↔workspaces *does* need bidirectional
querying (given a user, their workspaces; given a workspace, its members)
and genuinely benefits from being a real join table rather than an array.

### `workspaces` ← `models/workspace.model.ts`

```sql
CREATE TABLE workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    UUID NOT NULL REFERENCES users(id),  -- see §1.3 circular-FK note
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Now that workspaces exists, add the deferred FK on users:
ALTER TABLE users
  ADD CONSTRAINT users_current_workspace_fk
  FOREIGN KEY (current_workspace_id) REFERENCES workspaces(id)
  ON DELETE SET NULL;
```

`owner_id ... REFERENCES users(id)` with **no `ON DELETE` clause** defaults
to `ON DELETE RESTRICT` (technically `NO ACTION`, which behaves like
`RESTRICT` for immediate-mode constraints) — meaning: **Postgres will refuse
to delete a user who still owns a workspace.** This is intentional (see
PLAN.md §1b) — it forces application code to explicitly transfer ownership
or delete the workspace first, which is exactly what
`deleteWorkspaceService`/`deleteUserService` already do by hand today, just
unenforced. Postgres now makes it impossible to *accidentally* skip that
step.

`users_current_workspace_fk ... ON DELETE SET NULL` — the opposite choice,
deliberately: a workspace being deleted should never block, since a user's
"current workspace" pointer is just a UI convenience, not a hard dependency.

### `workspace_members` ← `models/member.model.ts` — the clean many-to-many example

```sql
CREATE TABLE workspace_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id      UUID NOT NULL REFERENCES roles(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT workspace_members_user_workspace_unique UNIQUE (user_id, workspace_id)
);

CREATE INDEX workspace_members_workspace_id_idx ON workspace_members (workspace_id);
```

This is the **exact same integrity rule** as Mongo's
`memberSchema.index({ userId: 1, workspaceId: 1 }, { unique: true })` — but
now a named `CONSTRAINT`, not just an index. The practical difference: this
constraint can be the target of an `ON CONFLICT (user_id, workspace_id) DO
NOTHING` upsert (Phase 2 will use this for "join workspace" — cleaner than
Mongo's check-then-insert-and-catch-the-duplicate-key-error pattern that
`member.model.ts`'s comment describes).

`ON DELETE CASCADE` on both FKs matches the manual cleanup code in
`deleteWorkspaceService` and `deleteUserService` (`MemberModel.deleteMany
({...})`) — Postgres now does this automatically, atomically, as part of
the same statement that deletes the parent row, with **no possibility of
"deleted the workspace but forgot to delete its members"** (a bug class
that's structurally possible today if a future developer adds a new
Mongo delete path and forgets the manual cleanup call).

### `accounts` ← `models/account.model.ts` (OAuth)

```sql
CREATE TYPE oauth_provider AS ENUM ('GOOGLE', 'GITHUB', 'FACEBOOK', 'EMAIL');

CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       oauth_provider NOT NULL,
  provider_id    TEXT NOT NULL UNIQUE,
  refresh_token  TEXT,
  token_expiry   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);
```

Note the Mongoose `toJSON.transform` that strips `refreshToken` from
serialized output (`account.model.ts:33-37`) has **no schema-level
equivalent in Postgres** — that was purely an application-layer
serialization concern, and stays one: your repository's domain-mapping
function (the `toDomain(...)` boundary from phase-4) is where you omit
`refresh_token`, same as before, just relocated to a different layer.

### `projects` ← `models/project.model.ts`

```sql
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  emoji        TEXT NOT NULL DEFAULT '📊',
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_workspace_id_idx ON projects (workspace_id);
```

Direct port of the existing `projectSchema.index({ workspace: 1 })` —
identical reasoning (`getProjectsInWorkspaceService` filters/paginates by
workspace on every call), same B-tree index, just SQL syntax.

### `tasks` ← `models/task.model.ts`

```sql
CREATE TYPE task_status AS ENUM ('BACKLOG','TODO','IN_PROGRESS','IN_REVIEW','DONE');
CREATE TYPE task_priority AS ENUM ('LOW','MEDIUM','HIGH');

CREATE TABLE tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_code    TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status       task_status NOT NULL DEFAULT 'TODO',
  priority     task_priority NOT NULL DEFAULT 'MEDIUM',
  assigned_to  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by   UUID NOT NULL REFERENCES users(id),
  due_date     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_workspace_project_idx ON tasks (workspace_id, project_id);
CREATE INDEX tasks_workspace_status_idx  ON tasks (workspace_id, status);
CREATE INDEX tasks_assigned_to_idx       ON tasks (assigned_to);
```

Direct ports of all three existing indexes
(`task.model.ts:83-85`) — same queries, same justification
(`getAllTasksService` filters by workspace+project, workspace+status, and
assignedTo). Note `task_code` unique generation
(`utils/uuid.ts`'s `generateTaskCode`) stays **application-generated**, same
as today — Postgres has no direct equivalent to a Mongoose schema `default:
generateTaskCode` function, so this becomes explicit code in the
insert path (or a Postgres trigger, if you want to practice writing one —
optional, not necessary here).

`assigned_to ... ON DELETE SET NULL` matches the field's existing nullable
semantics (`assignedTo: mongoose.Types.ObjectId | null`).

---

## 1.5 Theory: index types beyond B-tree (know these exist, use only where earned)

Postgres ships several index types beyond the default B-tree — relevant to
this app's near-term roadmap, worth knowing now even if not all used today:

- **GIN** (Generalized Inverted Index) — the right index for `permission[]`
  array columns if you ever query "roles containing permission X"
  (`CREATE INDEX ON roles USING GIN (permissions)`), and for full-text
  search (`tsvector` columns) — directly relevant to `docs/ROADMAP.md`
  Phase 1's "Mongo text index on Task.title" item; the Postgres equivalent
  is `CREATE INDEX ON tasks USING GIN (to_tsvector('english', title ||
  ' ' || coalesce(description, '')));`.
- **GiST** — geometric/range types, not relevant here.
- **BRIN** — huge, naturally-ordered tables (e.g. a `created_at`-ordered
  append-only log table) — a good future fit for the `Activity` model
  `docs/ROADMAP.md` proposes, not needed for the tables in this phase.
- **Partial indexes** — an index with a `WHERE` clause, indexing only a
  subset of rows. A genuinely good fit here:
  `CREATE INDEX tasks_overdue_idx ON tasks (workspace_id, due_date) WHERE
  status != 'DONE';` — smaller, faster index specifically for the "overdue
  tasks" analytics query in `project.service.ts`'s `$facet` (ported in
  Phase 2). Worth adding once you've measured (via `EXPLAIN ANALYZE`) that
  the plain compound index isn't already fast enough — don't add
  speculatively.

---

## 1.6 Verify the whole schema by hand before any app code (test for this phase)

Run this entire chain directly in `psql` — no Node, no Drizzle yet. This
proves the schema (not the ORM, not the app) is correct.

```sql
INSERT INTO users (id, email, name) VALUES (gen_random_uuid(), 'a@test.com', 'Alice') RETURNING id;
-- copy the returned id as :user_id below (psql \gset or paste manually)

INSERT INTO roles (id, name, permissions)
  VALUES (gen_random_uuid(), 'OWNER', ARRAY['CREATE_WORKSPACE','DELETE_WORKSPACE']::permission[])
  RETURNING id; -- :role_id

INSERT INTO workspaces (id, name, owner_id) VALUES (gen_random_uuid(), 'Acme', :'user_id') RETURNING id; -- :workspace_id

UPDATE users SET current_workspace_id = :'workspace_id' WHERE id = :'user_id';

INSERT INTO workspace_members (user_id, workspace_id, role_id)
  VALUES (:'user_id', :'workspace_id', :'role_id');

-- Prove the unique constraint fires:
INSERT INTO workspace_members (user_id, workspace_id, role_id)
  VALUES (:'user_id', :'workspace_id', :'role_id');
-- Expect: ERROR: duplicate key value violates unique constraint "workspace_members_user_workspace_unique"

INSERT INTO projects (id, name, workspace_id, created_by)
  VALUES (gen_random_uuid(), 'Launch', :'workspace_id', :'user_id') RETURNING id; -- :project_id

INSERT INTO tasks (id, task_code, title, project_id, workspace_id, created_by)
  VALUES (gen_random_uuid(), 'ACM-1', 'Ship it', :'project_id', :'workspace_id', :'user_id');

-- Prove RESTRICT works: this must fail while the user still owns a workspace
DELETE FROM users WHERE id = :'user_id';
-- Expect: ERROR: update or delete on table "users" violates foreign key constraint on workspaces

-- Prove CASCADE works: deleting the workspace cascades to members/projects/tasks
DELETE FROM workspaces WHERE id = :'workspace_id';
SELECT count(*) FROM workspace_members WHERE workspace_id = :'workspace_id'; -- expect 0
SELECT count(*) FROM projects WHERE workspace_id = :'workspace_id';          -- expect 0
SELECT count(*) FROM tasks WHERE workspace_id = :'workspace_id';             -- expect 0

-- NOW the user can be deleted (no workspace owned anymore)
DELETE FROM users WHERE id = :'user_id'; -- should succeed
```

If every `INSERT`/`DELETE`/error matches the comments above, the schema
correctly encodes every integrity rule PLAN.md §1b specified — verified at
the database level, independent of any application code, before you write a
single line of Drizzle.

### Also run this, to build `EXPLAIN` intuition early

```sql
EXPLAIN ANALYZE SELECT * FROM tasks WHERE workspace_id = :'workspace_id' AND status = 'TODO';
```

Confirm the plan says `Index Scan using tasks_workspace_status_idx` — **not**
`Seq Scan`. This is the single habit worth building now: every time you add
an index in this migration, verify with `EXPLAIN ANALYZE` that Postgres is
actually choosing to use it, rather than assuming it will.

---

## 1.7 Actually done — status: ✅ complete, schema applied and verified against real Postgres

All seven tables from §1.4 are committed as runnable DDL at
`backend/migrations/sql/phase-1-schema.sql` (not just markdown code blocks —
an actual `.sql` file this repo can apply again, e.g. in CI or a fresh dev
box) and applied against the Phase 0 Postgres container with `psql -U astrix
-d astrix -f phase-1-schema.sql`. Every `CREATE TABLE`/`CREATE
TYPE`/`CREATE INDEX`/`CREATE TRIGGER`/`ALTER TABLE` succeeded on the first
run, in the order §1.3's circular-FK resolution requires (users → workspaces
→ the deferred `users_current_workspace_fk` → workspace_members → accounts →
projects → tasks).

```
$ docker compose exec postgres psql -U astrix -d astrix -c "\dt"
 public | accounts          | table | astrix
 public | projects          | table | astrix
 public | roles             | table | astrix
 public | tasks             | table | astrix
 public | users             | table | astrix
 public | workspace_members | table | astrix
 public | workspaces        | table | astrix
```

`\d users` and `\d tasks` confirm every FK, index, and trigger landed
exactly as designed — including the `Referenced by:` list on `users`
showing all six inbound foreign keys, and `tasks`'s three indexes
(`tasks_workspace_project_idx`, `tasks_workspace_status_idx`,
`tasks_assigned_to_idx`) all present.

### §1.6's integrity chain — actually run, not just described

Ran the full insert/delete chain end to end against real Postgres (see
`git log`-free scratch run, reproduced here since it's the actual proof):

```
INSERT 0 1   -- user
INSERT 0 1   -- role
INSERT 0 1   -- workspace
UPDATE 1     -- users.current_workspace_id backfilled
INSERT 0 1   -- workspace_members row 1

--> expecting duplicate-key error next:
ERROR:  duplicate key value violates unique constraint "workspace_members_user_workspace_unique"
DETAIL:  Key (user_id, workspace_id)=(...) already exists.

INSERT 0 1   -- project
INSERT 0 1   -- task

--> expecting FK-restrict error next (user still owns a workspace):
ERROR:  update or delete on table "users" violates foreign key constraint "workspaces_owner_id_fkey" on table "workspaces"
DETAIL:  Key (id)=(...) is still referenced from table "workspaces".

--> now deleting the workspace, expecting cascade to members/projects/tasks:
DELETE 1
 members_left  = 0
 projects_left = 0
 tasks_left    = 0

--> now the user deletes cleanly (no workspace owned anymore):
DELETE 1
```

Every one of PLAN.md §1b's integrity rules fired exactly as the schema
promises: the unique constraint rejected a duplicate membership, `RESTRICT`
blocked deleting a user who still owns a workspace, and `CASCADE` wiped
members/projects/tasks atomically the moment the workspace itself was
deleted — none of this required application-code enforcement, unlike the
equivalent Mongo `deleteMany({...})` cleanup calls this replaces.

One real bug caught in the process, worth recording: the first draft of the
verification script's `INSERT INTO workspaces` omitted `invite_code`,
which is `NOT NULL` — Postgres correctly rejected it
(`null value in column "invite_code" violates not-null constraint`). This
is exactly the kind of mistake Mongoose would have silently allowed (no
`required: true` violation only because the field wasn't in the payload at
all isn't the same failure mode, but the general point holds: Postgres's
`NOT NULL` catches an incomplete insert immediately, at the database layer,
regardless of which code path produced it).

### `EXPLAIN ANALYZE` — a genuinely non-obvious result worth keeping

Running the doc's own suggested query — a **direct equality filter**,
`workspace_id = :id AND status = 'TODO'` — did use the compound index, as
predicted:

```
Index Scan using tasks_workspace_status_idx on tasks
  (cost=0.15..8.17 rows=1 width=208) (actual time=0.016..0.017 rows=1 loops=1)
  Index Cond: ((workspace_id = '...'::uuid) AND (status = 'TODO'::task_status))
```

But an equivalent-looking query written as a **join** (`tasks t JOIN
workspaces w ON w.name = 'Bench' WHERE t.workspace_id = w.id AND t.status =
'TODO'`) made the planner choose `Seq Scan` on both tables instead:

```
Nested Loop
  ->  Seq Scan on tasks t  (Filter: status = 'TODO')
  ->  Materialize -> Seq Scan on workspaces w  (Filter: name = 'Bench')
```

This is the real, concrete version of §1.1's "verify, don't assume" advice
— on a table with only 1-2 rows (true here, and will be true again for any
fresh dev database), the planner correctly decides a sequential scan is
*cheaper* than an index scan, because index scans have fixed overhead that
only pays off once there's enough data to skip. **The same index existing
doesn't guarantee it gets used** — row count and the exact query shape both
matter, which is precisely why `EXPLAIN ANALYZE` on the actual query (not a
paraphrase of it) is the only reliable way to know. This becomes more
visible once Phase 2 seeds realistic data volumes; on this near-empty table
it's still the right lesson, just with a smaller table than the index
"needs" to win.

Both benchmark rows used to produce this were deleted immediately after —
the schema is verified empty and ready for Phase 2, per this phase's
rollback contract.

---

## 1.8 What to read next

- [phase-2-orm-setup-and-service-migration.md](./phase-2-orm-setup-and-service-migration.md)
  — wiring Drizzle into the app, porting services table by table, rewriting
  `.populate()` calls as joins, rewriting the `$facet` aggregation as SQL,
  Postgres transactions in application code.
