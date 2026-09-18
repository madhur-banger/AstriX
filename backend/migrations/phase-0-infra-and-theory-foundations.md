# Phase 0 — Infrastructure Setup + Foundational Theory (Mongo vs. Postgres vs. Redis)

> Part of the [migrations/](./PLAN.md) series. Read [PLAN.md](./PLAN.md) first
> for the index and execution order. This file: get Postgres + Redis running
> locally, and build the mental model you'll need for every later phase —
> **before** writing any schema or service code.

Nothing in this phase touches `src/`. The live Mongo app is completely
unaffected. Goal: leave this phase with Docker-run Postgres + Redis, and a
real understanding of *why* a document database and a relational database
organize data so differently — not just "how to write the SQL."

---

## 0.1 Theory: what a database actually is, and the three models compared

A database's job is: **store data durably, let you query it efficiently, and
keep it correct under concurrent access.** MongoDB, PostgreSQL, and Redis all
do this, but they made different bets about what "efficient" and "correct"
mean, and those bets shape everything downstream.

### MongoDB's bet: the "aggregate" is the unit of storage

Mongo's core idea is the **aggregate pattern** (borrowed from Domain-Driven
Design): identify the cluster of data that's usually read and written
together, and store that cluster as one document, so a single disk read gets
you everything. In this codebase, `TaskDocument` is close to this ideal —
title, status, priority, dueDate are all read together whenever you view a
task. Where AstriX actually *diverges* from the aggregate pattern is
relationships that cross aggregates — `assignedTo`, `project`, `workspace`
are all **references to other aggregates**, not embedded data. This is
worth sitting with: **this codebase already gave up on Mongo's core selling
point** (avoiding joins by embedding) the moment `task.model.ts` stored
`project: ObjectId` instead of embedding project data inline. It kept
Mongo's flexibility (no enforced schema) without keeping Mongo's main
performance advantage (single-document reads). This is precisely the gap
Postgres closes.

### PostgreSQL's bet: normalize the data, let the relational algebra handle assembly

Postgres (and SQL databases generally) start from **relational theory**
(Codd, 1970): store each *fact* exactly once, in the table that owns it, and
describe how tables relate via foreign keys. Retrieval is not "fetch the
pre-assembled aggregate" — it's "describe the shape of data you want (a
query), let the **query planner** figure out the cheapest way to assemble it
from normalized pieces." This trades a small amount of read-time
computation (the join) for a large amount of write-time and
integrity-time correctness: a fact can never disagree with itself because
it's stored in exactly one place.

**Normalization, concretely, using this schema:** `ProjectType.createdBy` in
the client currently duplicates `{ _id, name, profilePicture }` inline
(`client/src/types/api.type.ts:207-211`) — a denormalized read shape,
built by `.populate()` at query time from the single source of truth (the
`users` collection). This is actually already the relational pattern in
spirit — Postgres just makes "join to fetch the current name/picture at
read time" the *only* way to do it, rather than an opt-in `.populate()` call
that's easy to forget (and when forgotten, silently returns a raw
ObjectId instead of an error).

### Redis's bet: give up durability and query flexibility for raw speed

Redis keeps almost everything in memory (RAM), with disk persistence as a
secondary, best-effort concern. It has no query language, no joins, no
schema — just data structures (string, hash, list, set, sorted set, stream)
addressed by a key you design yourself. The bet: for data where **you
already know the access pattern in advance** (get-session-by-id,
increment-a-counter, check-if-key-exists), skip the entire machinery of a
query planner and just do the O(1)/O(log N) operation directly. This is why
Redis is never "the database" for an app like this — it's a precision tool
for the slice of data (sessions, rate limits, caches) where the access
pattern is simple and fixed.

### Side-by-side

| | MongoDB | PostgreSQL | Redis |
|---|---|---|---|
| Unit of storage | Document (aggregate) | Row (normalized fact) | Key → data structure |
| Schema enforcement | App-layer only (Mongoose here) | DB-layer, always | None — you enforce shape in app code |
| Relationships | Manual reference + `.populate()`, or embedding | Foreign keys, joined by the planner | None native — build your own secondary index |
| Query engine | Pipeline of stages (aggregation framework) | Declarative SQL, cost-based planner | Command per data structure, no planner |
| Where CPU work happens | Partly app-side (Mongoose populate stitching) | DB-side (planner picks join strategy using statistics) | Neither — O(1)/O(log N) direct access |
| Consistency default | Per-document atomic; multi-document needs a transaction + **replica set** | Full ACID, single-instance, foundational | Best-effort; `MULTI`/`EXEC` is not true rollback-on-error |

---

## 0.2 Theory: ACID, and what each database actually guarantees

**ACID** = Atomicity, Consistency, Isolation, Durability. This is the
contract a transaction makes with you. Understanding it precisely (not just
as a buzzword) is core to knowing when you need Postgres over Mongo, and
when Redis is safe to use at all.

- **Atomicity** — a transaction's writes all happen, or none do. Mongo gives
  you this via `session.startTransaction()`/`commitTransaction()` — but
  **only against a replica set**, even a single-node one (`rs0`) for local
  dev; a standalone `mongod` cannot open a transaction at all. Postgres
  gives you this via `BEGIN`/`COMMIT`/`ROLLBACK` on a **single, standalone
  instance**, no special topology required — this is foundational to how
  Postgres was designed, not a bolted-on feature.
- **Consistency** (the DB-theory sense, not the "eventually consistent"
  sense) — a transaction can only bring the database from one valid state to
  another valid state, where "valid" is defined by constraints. This is
  where Mongo and Postgres diverge hardest: Mongo's `startTransaction()`
  guarantees atomicity, but there is **no foreign key constraint** to
  violate — a transaction can commit a `Task` document whose `project`
  ObjectId points at nothing, and Mongo will not stop it. Postgres enforces
  consistency *as part of* the transaction — a `FOREIGN KEY` violation
  aborts the transaction automatically. **This is the single biggest
  reason this migration is worth doing for learning**: you'll feel the
  difference between "atomic" and "consistent" directly, because Postgres
  makes you declare what "valid" means and then enforces it, where Mongo
  left that entirely to application discipline (the try/catch blocks in
  `auth.service.ts`, `workspace.service.ts`, `user.service.ts` are all
  hand-rolled substitutes for constraints Postgres gives you for free).
- **Isolation** — concurrent transactions don't see each other's uncommitted
  work. Both databases support multiple isolation levels; Postgres's default
  is **Read Committed**, Mongo's default (for multi-document transactions)
  is **Snapshot Isolation**. You'll pick this explicitly in Phase 2 when you
  write your first `db.transaction()` in Drizzle — know that Postgres also
  offers `REPEATABLE READ` and `SERIALIZABLE` for cases where Read
  Committed's weaker guarantees (e.g. non-repeatable reads) could cause a
  bug — the workspace-member race condition noted in `member.model.ts`
  (`memberSchema.index({userId,workspaceId}, {unique:true})`, guarding
  against a check-then-insert race) is a textbook example where isolation
  level and/or a unique constraint (not just "wrap it in a transaction") is
  what actually prevents the bug.
- **Durability** — once committed, a write survives a crash. Postgres:
  yes, always, via write-ahead logging (WAL) — every change is written to an
  append-only log *before* being applied, so crash recovery replays the log.
  Redis: **configurable, and off by default in the sense that matters** —
  RDB snapshots (periodic full dumps) or AOF (append-only file, closer to
  Postgres's WAL but still not the default) are opt-in. This is *why*
  Redis is architecturally correct for sessions/tokens/caches (losing a
  session on a Redis restart is recoverable — the user just logs in again)
  and would be an *architecturally wrong* choice for `tasks`/`projects`
  (losing a task on a restart is unacceptable data loss).

---

## 0.3 Theory: what "NoSQL" actually gave up, precisely

It's worth being exact about this instead of treating "NoSQL vs SQL" as a
vibe. MongoDB's actual tradeoffs vs. Postgres:

1. **No enforced schema** → flexibility to evolve document shape without a
   migration, at the cost of the database never being able to guarantee a
   document has a given field, of a given type. In this codebase, this
   shows up as **all schema enforcement living in Mongoose**
   (`required: true`, `enum: [...]`) — a layer that can be bypassed (a
   script using the raw MongoDB driver, a manual `mongosh` edit, a future
   Mongoose version change) in ways a Postgres `NOT NULL`/`CHECK` constraint
   cannot.
2. **No foreign keys** → no join, so no join *cost* at write time, but also
   no integrity guarantee at write time. Every `ObjectId` reference in this
   codebase (`task.project`, `member.userId`, `account.userId`, ...) is
   trusted to point at something real purely because application code was
   careful. Postgres makes this the database's job.
3. **Horizontal scaling via sharding, without needing to think about joins
   across shards** — genuinely Mongo's strongest argument, and genuinely
   irrelevant to AstriX's current or foreseeable scale (one workspace-scoped
   PM tool, not a system ingesting billions of documents). This is the
   context in which "use Mongo" is a *good* engineering decision elsewhere,
   and why this migration is about *this app's* fit, not "Mongo is bad."
4. **Aggregation pipeline vs. SQL** — Mongo's pipeline
   (`$match → $group → $facet`, used in `project.service.ts:88-124`) is a
   sequence of explicit transformation *steps* you author. SQL is a
   declarative *description of the desired result*, and the planner (not
   you) decides the steps. This is a real difference in how you think, not
   just syntax — Phase 2 makes you rewrite that exact aggregation and feel
   the difference directly.

---

## 0.4 Setup: Docker Compose for local Postgres + Redis

Add this file at the **repo root** (`/Users/madhur/Desktop/AstriX/docker-compose.yml`),
not inside `backend/` — infra config that could eventually cover the client
too shouldn't be nested inside one service's folder.

```yaml
services:
  postgres:
    image: postgres:16
    container_name: astrix-postgres
    environment:
      POSTGRES_USER: astrix
      POSTGRES_PASSWORD: astrix_dev_only
      POSTGRES_DB: astrix
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U astrix -d astrix"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7
    container_name: astrix-redis
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

**Why `postgres:16` specifically, and not `latest`:** pin a real version for
the same reason this repo already SHA-pins GitHub Actions (per root
`PLAN.md`) — reproducibility. `latest` silently changes underneath you.
Postgres 16 is current-stable as of this migration and has no feature gaps
relevant to this app.

**Why a named volume (`pgdata`) instead of a bind mount:** Docker-managed
volumes are the Postgres-recommended approach for data you want to persist
across container restarts without fighting host filesystem permission
quirks (a real, common Docker-on-macOS papercut with bind mounts and
Postgres's data directory permissions).

### Steps

```bash
docker compose up -d
docker compose ps            # both should show "healthy"
docker compose exec postgres psql -U astrix -d astrix -c "SELECT version();"
docker compose exec redis redis-cli PING
```

---

## 0.5 Actually done — status: ✅ complete

`docker-compose.yml` is committed at the repo root exactly as specified in
§0.4, unmodified. Executed on this machine (Docker Desktop 29.0.1, Compose
v2.40.3) — one real-world wrinkle worth recording: **Docker Desktop was not
running when `docker compose up -d` was first tried** and failed with
`Cannot connect to the Docker daemon`. This is a normal papercut, not a
config problem — Docker Desktop has to actually be launched (`open -a
Docker` on macOS) before `docker compose` can talk to its daemon over the
Unix socket. Worth knowing for next time, not something the compose file
can fix.

```
$ docker compose ps
NAME              IMAGE         SERVICE    STATUS
astrix-postgres   postgres:16   postgres   Up (healthy)
astrix-redis      redis:7       redis      Up (healthy)

$ docker compose exec postgres psql -U astrix -d astrix -c "SELECT version();"
PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on aarch64-unknown-linux-gnu, ...

$ docker compose exec redis redis-cli PING
PONG
```

Postgres 16.15 (the current patch release on the `postgres:16` tag as of
this run) — confirms the "pin the major version, not `latest`" reasoning in
§0.4: a fixed `16` tag still floats across patch releases (which is fine —
patch releases don't break anything relevant here) while never silently
jumping to Postgres 17.

### Persistence test — actually run, not just described

```
$ docker compose exec postgres psql -U astrix -d astrix -c \
    "CREATE TABLE persistence_check (id serial primary key, note text); \
     INSERT INTO persistence_check (note) VALUES ('phase-0 durability proof');"
CREATE TABLE
INSERT 0 1

$ docker compose down && docker compose up -d
 Container astrix-postgres  Removed   # container removed...
 Container astrix-postgres  Created   # ...and recreated from scratch
 Container astrix-postgres  Started

$ docker compose exec postgres psql -U astrix -d astrix -c "SELECT * FROM persistence_check;"
 id |           note
----+---------------------------
  1 | phase-0 durability proof
(1 row)
```

This is the concrete proof behind §0.2's durability claim: `docker compose
down` (without `-v`) destroys the *container* but not the named `pgdata`
volume, and the row survived a full container teardown/recreate — not a
mere process restart. The `persistence_check` table was dropped immediately
after, so the schema stays clean for Phase 1.

### Mongo app unaffected — actually verified

```
$ npm run dev   # in backend/
[INFO] ts-node-dev ver. 2.0.0 (using ts-node ver. 10.9.2, typescript ver. 5.9.3)
{"level":30,...,"msg":"Connected to Mongo Database"}
{"level":30,...,"msg":"Server listening on port 8000 in development environment"}
```

Booted clean against the existing `MONGO_URI`, with Postgres/Redis
containers running alongside it the whole time — confirms Phase 0 added new
infrastructure without touching anything `src/` depends on.

### Rollback

`docker compose down -v` (the `-v` also drops the named volume — fine here,
nothing real is stored yet, and the one throwaway table made during
verification has already been dropped). Nothing in `src/` was touched, so
there is nothing else to undo.

---

## 0.6 What to read next

Continue to
[phase-1-schema-design-and-postgres-fundamentals.md](./phase-1-schema-design-and-postgres-fundamentals.md)
for the full ER design, DDL, indexing theory, and normalization walkthrough
— table by table, mapped against every current Mongoose model.
