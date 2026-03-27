# Phase 5 — Testing Strategy: Mongo-Suite Parity, Postgres/Redis Integration, and DI-Driven Unit Testing

> Part of the [migrations/](./PLAN.md) series. Assumes
> [Phase 4](./phase-4-nestjs-clean-architecture.md) is done — the Nest app
> exists with repository interfaces cleanly separating application logic
> from Drizzle/ioredis. This file: how each of the current suite's three
> tiers (`tests/unit`, `tests/integration`, `tests/e2e`) maps to the new
> architecture, why DI fundamentally changes what a "unit test" even means
> here, and how to prove behavioral parity with the existing Mongo suite
> before cutover.

---

## 5.1 Theory: why DI changes what "unit test" means

The current suite's `tests/unit/` covers config, providers, middleware,
utils — genuinely framework-independent code. It does **not** unit-test
`services/*.ts` in isolation, because it structurally *can't*: every
service imports a concrete Mongoose model directly
(`import TaskModel from "../models/task.model"`), so "test the service"
necessarily means "run against a real (or `mongodb-memory-server`-simulated)
MongoDB" — that's why `tests/integration/task.service.integration.test.ts`
exists as an *integration* test, not a unit test. There is no way to test
`createTaskService`'s business logic (the assignee-must-be-a-member rule)
without also exercising real Mongoose queries, because the two are welded
together.

**This is the single most concrete payoff of Phase 4's repository interfaces
you'll feel directly in this phase**: once `TaskService` depends on
`TaskRepository` (an abstract class/interface) rather than Drizzle, you can
hand it a **fake, in-memory implementation** of that interface in a test —
no database, no Docker, no `mongodb-memory-server`-equivalent, sub-millisecond
test runs:

```ts
// tests/unit/application/task/task.service.test.ts
class FakeTaskRepository implements TaskRepository {
  private tasks = new Map<string, Task>();
  async findById(id: string) { return this.tasks.get(id) ?? null; }
  async create(data: Omit<Task, "id" | "taskCode">) {
    const task = { ...data, id: crypto.randomUUID(), taskCode: "T-1" };
    this.tasks.set(task.id, task);
    return task;
  }
  // ...
}

class FakeWorkspaceMemberRepository implements WorkspaceMemberRepository {
  constructor(private members: Set<string>) {}
  async isMember(_workspaceId: string, userId: string) { return this.members.has(userId); }
}

describe("TaskService.createTask", () => {
  it("rejects assigning a task to a non-member", async () => {
    const taskRepo = new FakeTaskRepository();
    const memberRepo = new FakeWorkspaceMemberRepository(new Set(["member-1"]));
    const service = new TaskService(taskRepo, memberRepo);

    await expect(
      service.createTask("ws-1", "proj-1", "creator-1", { title: "T", assignedTo: "not-a-member", priority: "LOW", status: "TODO" })
    ).rejects.toThrow("Assigned user is not a member of this workspace");
  });
});
```

**This test runs in microseconds, needs no Docker, no network, no cleanup
between runs** — and it tests the *actual business rule*
(`assertAssigneeIsWorkspaceMember`'s logic), completely decoupled from
whether that rule is eventually backed by Postgres, Mongo, or an in-memory
Map. This is the concrete, checkable definition of "testable architecture"
that clean/onion architecture is optimizing for — not an abstract virtue,
a directly measurable one (test runtime, and the fact that this test file
imports zero database drivers).

---

## 5.2 The new three-tier structure, mapped from the old one

| Tier | Old (`tests/`) | New | What changed and why |
|---|---|---|---|
| **Unit** | Config/providers/middleware/utils only — services excluded (see §5.1) | Same, **plus** every `application/*/task.service.ts` use case, tested against fake repositories per §5.1 | Services are now unit-testable for the first time in this codebase's history |
| **Integration** | `mongodb-memory-server`-backed, exercises real Mongoose queries end-to-end per service | Real Postgres (via `testcontainers`) exercising real Drizzle repository implementations; real Redis (via `testcontainers` or a Docker Compose test instance) exercising real ioredis repository implementations | Tests the repository *implementations* — the part unit tests deliberately fake out |
| **E2E** | `supertest` against the running Express app + real routes | `supertest` (or Nest's own `@nestjs/testing` `TestingModule` + `app.getHttpServer()`) against the running Nest app + real routes, backed by the same `testcontainers` Postgres/Redis as integration tests | Same intent, same tool family (supertest), different app under test |

---

## 5.3 Integration tests: `testcontainers` setup

```bash
npm install -D @testcontainers/postgresql testcontainers
```

```ts
// tests/integration/setup/postgres-container.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let container: StartedPostgreSqlContainer;

export const setupTestPostgres = async () => {
  container = await new PostgreSqlContainer("postgres:16").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  return { db, pool };
};

export const teardownTestPostgres = async () => {
  await container.stop();
};
```

**Why `testcontainers` over `mongodb-memory-server`'s Postgres-world
equivalent (there isn't a perfect one) or a shared Docker Compose test DB:**
`testcontainers` spins up a **real, throwaway Postgres in an actual Docker
container per test run** (or per suite, depending on lifecycle hooks),
guaranteeing byte-for-byte identical behavior to production Postgres —
`mongodb-memory-server` works because MongoDB ships an embeddable binary;
Postgres doesn't have a first-class equivalent, so a real containerized
instance is the correct, idiomatic choice in the Node/Postgres ecosystem,
not a downgrade from the Mongo approach.

```ts
// tests/integration/task.repository.integration.test.ts
describe("DrizzleTaskRepository", () => {
  let db: DrizzleDb;
  beforeAll(async () => ({ db } = await setupTestPostgres()));
  afterAll(() => teardownTestPostgres());
  afterEach(async () => db.delete(tasks)); // truncate between tests, matching mongodb-memory-server's per-test cleanup convention

  it("creates and retrieves a task with correct defaults", async () => {
    const repo = new DrizzleTaskRepository(db);
    const created = await repo.create({ title: "T", workspaceId: wsId, projectId: projId, createdBy: userId, priority: "LOW", status: "TODO", description: null, assignedTo: null, dueDate: null });
    const fetched = await repo.findById(created.id);
    expect(fetched?.status).toBe("TODO");
  });

  it("getAnalytics correctly counts overdue vs completed via FILTER", async () => {
    // seed 3 tasks with different due dates/statuses, exactly per Phase 2 §2.7's test description
    const analytics = await repo.getAnalytics(projId);
    expect(analytics).toEqual({ totalTasks: 3, overdueTasks: 1, completedTasks: 1 });
  });
});
```

This is where Phase 2's hand-verified `psql` queries (the `EXPLAIN ANALYZE`
checks, the cascade-delete proofs) graduate into permanent, CI-enforced
regression tests — everything you verified manually in Phase 1/2 should
have a corresponding automated test here by the end of this phase.

---

## 5.4 Integration tests for Redis repositories — same pattern, `testcontainers` Redis module

```ts
import { GenericContainer, StartedTestContainer } from "testcontainers";

let container: StartedTestContainer;
export const setupTestRedis = async () => {
  container = await new GenericContainer("redis:7").withExposedPorts(6379).start();
  return new Redis(`redis://${container.getHost()}:${container.getMappedPort(6379)}`);
};
```

```ts
describe("RedisSessionRepository", () => {
  it("session expires exactly per TTL, no residual read after expiry", async () => {
    const repo = new RedisSessionRepository(redis);
    const sessionId = await repo.create({ userId: "u1", refreshTokenHash: "h1" }, /* ttlSeconds */ 1);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await repo.findById(sessionId)).toBeNull();
  });

  it("listSessionsForUser excludes a session invalidated mid-list", async () => {
    // directly tests the stale-Set-member edge case named in Phase 3 §3.6
  });
});
```

**Deliberately write the second test above** — it's the automated,
permanent version of the manual "prove Redis secondary indexes need their
own maintenance discipline" lesson from Phase 3. Turning a manual
observation into a regression test is the actual habit this whole phase is
building.

---

## 5.5 E2E tests: proving the full stack, Nest-native

```ts
// tests/e2e/task.routes.e2e.test.ts
describe("POST /workspaces/:id/projects/:id/tasks (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const { db } = await setupTestPostgres();
    const redis = await setupTestRedis();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DRIZZLE_CLIENT).useValue(db)
      .overrideProvider(REDIS_CLIENT).useValue(redis)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  it("rejects task creation for a non-member assignee with 400", async () => {
    const token = await loginAndGetToken(app, /* seeded test user */);
    await request(app.getHttpServer())
      .post(`/workspaces/${wsId}/projects/${projId}/tasks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "T", assignedTo: "not-a-member-id", priority: "LOW", status: "TODO" })
      .expect(400);
  });
});
```

`.overrideProvider(...).useValue(...)` is Nest's `@nestjs/testing` module
doing, at the *application/DI* level, exactly what §5.1's `FakeTaskRepository`
did at the *unit* level — swap what a token resolves to. This is worth
noticing explicitly: **the same dependency-inversion mechanism that made
unit testing possible (§5.1) is what makes E2E test setup clean here too** —
one architectural decision (Phase 4) pays off at every test tier, not just
one.

---

## 5.6 Proving parity with the existing Mongo suite before cutover

Before Phase 6, for every existing `tests/integration/*.integration.test.ts`
and `tests/e2e/*.e2e.test.ts` file, its Postgres/Redis+Nest counterpart
should assert **the same observable behavior**, not necessarily the same
test code. Build a simple checklist per feature:

```markdown
## Parity checklist: task feature
- [ ] create task — happy path returns 201 + correct shape
- [ ] create task — assignee not a workspace member returns 400 (Phase 2 §2.6's leftJoin-vs-innerJoin bug class lives here — test it explicitly)
- [ ] list tasks — pagination math matches (pageSize/pageNumber/totalPages/skip)
- [ ] list tasks — filters (status/priority/assignedTo/keyword/dueDate) each independently verified
- [ ] list tasks — unassigned task appears with assignee: null, not omitted (Phase 2 §2.6)
- [ ] get task by id — 404 when task belongs to a different workspace/project
- [ ] task analytics — totalTasks/overdueTasks/completedTasks match hand-computed values (Phase 2 §2.7)
- [ ] delete cascade — deleting a project deletes its tasks (Phase 1 §1.6, now automated)
```

Do this per feature (`user`, `auth`, `workspace`, `member`, `project`,
`task`) — it's the single artifact that lets you say "behaviorally
equivalent" with evidence, not just "I ported the code and it compiles."

---

## 5.7 Coverage gate

The current CI enforces 90/85/90/90 coverage
(`docs/testing/00-master-testing-strategy.md`, referenced from
`docs/ROADMAP.md`). Keep the same gate on the new suite — don't loosen it
"because it's a migration." If anything, the DI-enabled unit tests from
§5.1 should make hitting that bar *easier* for the application layer than
it was for the old Mongo-coupled services, since business-rule branches
(the assignee-membership check, status-transition rules if added later) no
longer require spinning up a database to exercise every branch.

---

## 5.8 What to read next

- [phase-6-cutover-and-cleanup.md](./phase-6-cutover-and-cleanup.md) — the
  final switch, config changes, and what gets deleted once the new stack is
  proven equivalent.
