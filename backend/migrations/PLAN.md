# Migration Plan: MongoDB (Mongoose) → PostgreSQL + Redis

Index and execution order for this migration. Scope, confirmed with the
user: **database migration only, staying on Express** (Mongoose → Postgres
+ Redis) — the goal is a scalable, properly-indexed data layer, not a
framework or architecture change. The Postgres+Redis app keeps the exact
same `routes → controllers → services` shape the Mongo app already uses —
no repository interfaces, no dependency injection, no composition root.
Goal: deep, hands-on understanding of Postgres, Mongo (as a point of
comparison), and Redis — not just a working port, and not an architecture
rewrite along the way.

Each phase below is its own file: self-contained theory, full step-by-step
instructions, exact DDL/code for this codebase, and a concrete test to run
before moving to the next phase. Read them in order — later phases assume
earlier ones are done — but every phase leaves **both the old Mongo app and
the new stack in a working, independently-verifiable state** until the
final cutover phase.

---

## Phase index

| Phase | File | Covers |
|---|---|---|
| **0** | [phase-0-infra-and-theory-foundations.md](./phase-0-infra-and-theory-foundations.md) | Docker Compose for local Postgres + Redis. Foundational theory: the aggregate pattern vs. relational normalization vs. key-value, ACID precisely (and what Mongo's transactions vs. Postgres's actually guarantee differently), what "NoSQL" traded away. |
| **1** | [phase-1-schema-design-and-postgres-fundamentals.md](./phase-1-schema-design-and-postgres-fundamentals.md) | Postgres storage internals (heap, MVCC, the query planner), B-tree index theory, normalization precisely. Full ER diagram and complete DDL for every table, mapped 1:1 against every existing Mongoose model, with every `ON DELETE` decision justified. Verified entirely by hand in `psql` — no app code. |
| **2** | [phase-2-orm-setup-and-service-migration.md](./phase-2-orm-setup-and-service-migration.md) | Drizzle setup (and why Drizzle over Prisma for this goal). Connection pooling theory. Every service ported table-by-table. The two hardest rewrites done in depth: `.populate()` chains → SQL `JOIN`s, and the `$facet` aggregation → `FILTER`-based SQL. Hand-written Postgres transactions. |
| **3** | [phase-3-redis-migration-and-ttl-data.md](./phase-3-redis-migration-and-ttl-data.md) | Redis data-structure theory (String/Hash/Set/ZSet/List/Stream, O-complexity, when to use each). Precisely how Redis TTL differs from Mongo's TTL-index sweep. Sessions, password-reset/email-verification tokens ported. Rate limiting moved off `rate-limit-mongo` onto Redis. Cache-aside pattern, including the real hard part (invalidation). Independent of Phase 2 — can be done first if preferred. |
| **4** | [phase-4-clean-architecture-express.md](./phase-4-clean-architecture-express.md) | A second Express app (`pg-app.ts`/`index.pg.ts`, its own port) wiring Phase 2/3's Postgres/Redis services up to HTTP the same way the Mongo app already does it: `routes/pg → controllers/pg → services/pg` + `services/redis`, same function names, same Zod-validation-then-service-call shape, no new layers. Fills in the service functions Phase 2/3 never wrote (task update, full workspace/user/member coverage, the full auth flow). |
| **5** | [phase-5-testing-strategy.md](./phase-5-testing-strategy.md) | `testcontainers`-based integration tests for the Postgres and Redis service functions. E2E tests via `supertest` against the Postgres+Redis Express app. A parity checklist per feature to prove behavioral equivalence with the existing Mongo suite before cutover. |
| **6** | [phase-6-cutover-and-cleanup.md](./phase-6-cutover-and-cleanup.md) | The only phase that touches live traffic. Config changes, the actual cutover (swapping which app's routes are live), rollback plan, and final cleanup (deleting Mongoose/Mongo dependencies, and the now-redundant `controllers/pg`+`routes/pg`+`services/pg` split once there's only one app) only after the new stack has proven itself in production. The app stays Express throughout — no entrypoint or framework change. |

---

## How this differs from a typical migration guide

Every phase is anchored to **this specific codebase's real code** — exact
file:line references to `task.model.ts`, `auth.service.ts`'s transaction
blocks, the `$facet` aggregation in `project.service.ts`, the TTL indexes,
`rate-limit-mongo`'s comments about ECS task scaling — not generic
Mongo-to-Postgres advice. Every theory section explains *why*, not just
*how*, because the stated goal is depth (understanding Postgres, Mongo as a
contrast, Redis, and clean architecture properly), not just a working port.

---

## Suggested pacing (solo, learning-focused, not rushed)

| Phase | Focus | Rough time |
|---|---|---|
| 0 | Docker setup + database theory foundations | 1 day |
| 1 | Full schema design, DDL, verified by hand in `psql` | 2 days |
| 2 | Drizzle + service migration, including the two hard rewrites | 4-5 days |
| 3 | Redis — sessions, tokens, rate limiting, caching | 2 days |
| 4 | Wire Postgres/Redis services up to Express routes/controllers, filling in what Phase 2/3 left unfinished | 1-2 days |
| 5 | Testing strategy rebuild, parity proof | 3 days |
| 6 | Cutover + cleanup | 1-2 days |

**Total: ~2.5 weeks solo**, done deliberately — every phase has a concrete
test gate, don't skip one to save time; the tests are what make each phase
safe to stop after.

---

## Non-goals of this migration (explicitly out of scope for now)

- **No new product features.** `docs/ROADMAP.md`'s feature roadmap
  (comments, attachments, notifications, search, billing) is untouched by
  this migration — it happens afterward, on the new foundation, per Phase 6
  §6.7.
- **No NestJS adoption, and no clean/onion architecture layering.** The app
  stays Express end to end, with the same `routes → controllers → services`
  shape the Mongo app already uses. An earlier draft of Phase 4 introduced
  repository interfaces and a composition root for this; that was cut as
  unnecessary complexity for a single-team, single-database app — see
  Phase 4 §4.5 for what to introduce instead if a concrete need for it
  (swappable persistence, or unit tests against a fake) shows up later.
- **No infra/deployment changes beyond what's needed to run Postgres +
  Redis** — this plan assumes local Docker Compose throughout; deploying to
  AWS (RDS, ElastiCache, Terraform modules) is a follow-on task once the
  migration itself is proven locally, not covered phase-by-phase here.
