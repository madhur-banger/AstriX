# Phase 6 — Cutover and Cleanup

> **Revision note:** this file was written against an earlier draft of
> Phase 4 that introduced repository interfaces and a `composition-root.ts`.
> That design was cut in favor of keeping the app's existing plain
> `routes → controllers → services` shape (see
> [phase-4-clean-architecture-express.md](./phase-4-clean-architecture-express.md)
> §4.5). Every mention below of swapping `composition-root.ts` bindings,
> `DrizzleTaskRepository`, or repository interfaces describes a mechanism
> that doesn't exist in this codebase. The actual cutover mechanism is
> simpler, not more complex: point `index.ts` (or its replacement) at
> `routes/pg/*` instead of the current Mongo `routes/*`, retire the
> `controllers/pg`/`routes/pg`/`services/pg` naming split since there's only
> one app left, and delete the Mongo-specific code
> (`models/`, `services/*.ts` top-level, `controllers/*.ts` top-level,
> `routes/*.ts` top-level, Mongoose deps). The note above was scoped to keep
> this file honest about what Phase 4 actually produced.
>
> **Done.** The cutover happened in one pass rather than the gradual,
> feature-by-feature rollout §6.4/§6.5 describe (this app had no real
> production traffic yet to protect, so the staged-rollback machinery those
> sections assume didn't apply — everything is recoverable from git history
> regardless). What actually happened: every `*/pg/*.ts` and
> `services/redis/*.ts` file moved up to its canonical, un-suffixed location
> (`services/pg/task.service.ts` → `services/task.service.ts`, etc.);
> `pg-app.ts`/`index.pg.ts` were retired in favor of a `src/app.ts`
> (pure Express app assembly, no `listen()`) + `src/index.ts` (owns
> startup/shutdown) split, which is also what keeps the E2E test suite able
> to build a real app without booting a real server; every Mongo-only file
> was deleted (`models/`, the pre-`pg` `services/controllers/routes`,
> `middlewares/auth.middleware.ts`'s old Mongoose version, `utils/rate-limiter.ts`'s
> old Mongo-store version, `config/database.config.ts`, `seeders/role.seeder.ts`,
> the Mongoose-specific branches in `errorHandles.middleware.ts`); `mongoose`,
> `mongodb-memory-server`, `rate-limit-mongo`, and `@types/mongoose` were
> removed from `package.json`; and the Mongo-era test suite (`tests/unit`,
> `tests/integration`, `tests/e2e`, `tests/setup`) was replaced in place by
> the Phase 5 Postgres/Redis suite, now the only suite (`npm test`) — 255
> tests, 21 files, all passing. `tsc --noEmit`, `npm run build`, and
> `eslint .` are all clean with zero `mongoose`/Mongo-driver references left
> in `src/`. `docs/ROADMAP.md`'s stale Mongo-era architecture claims and
> future-roadmap recommendations (search, caching, migrations, backup/DR)
> were updated to their Postgres/Redis equivalents; a full pass over
> `docs/backend/*.md` (currently still describing the Mongo request/response
> shapes and Mongoose patterns in detail) is the one piece of §6.6 item 7
> not yet done — flagged as follow-up work, not blocking, since those are
> descriptive docs about an internal layer, not something a caller depends
> on.

> Part of the [migrations/](./PLAN.md) series. Assumes Phases 0-5 are done:
> Postgres schema verified, services ported, Redis pieces ported, the
> Postgres+Redis Express app wired up (Phase 4), and the new test suite
> proves behavioral parity with the old Mongo suite. This is the **only
> phase that touches what actually serves traffic.**

---

## 6.1 Why cutover is last, and why that ordering matters

Every phase through 5 left the original Express + Mongoose app completely
untouched and still serving all real requests. This is deliberate risk
management, not caution for its own sake: at every point up to now, if you
stopped or something didn't work, **nothing about the running app changed**.
Cutover is the one phase where that stops being true — so it's also the one
phase to do slowly, in small steps, each individually verifiable and
individually revertible.

---

## 6.2 Pre-cutover checklist

- [ ] Every feature module (`task`, `project`, `workspace`, `member`,
      `user`, `auth`) restructured per Phase 4, with repository interfaces
      enforced (the `grep -rn "drizzle\|ioredis" src/application/` check
      from Phase 4 §4.7 returns nothing).
- [ ] Every feature's parity checklist (Phase 5 §5.6) fully checked off.
- [ ] `npm test` green on **both** suites — the original Mongo one and the
      new Postgres/Redis one.
- [ ] The restructured app (built from `composition-root.ts`) has been run
      standalone on a separate port and manually smoke-tested end to end at
      least once, per Phase 4 §4.7.
- [ ] `docker-compose.yml` extended to include the app's real Postgres/Redis
      (not just the local dev containers from Phase 0) if deploying beyond
      local dev.

---

## 6.3 Config changes

`src/config/app.config.ts` — add `DATABASE_URL` and `REDIS_URL`
alongside (not replacing yet) `MONGO_URI`:

```ts
DATABASE_URL: getEnv("DATABASE_URL", ""),
REDIS_URL: getEnv("REDIS_URL", "redis://localhost:6379"),
```

Keep `MONGO_URI` defined until §6.6's final deletion step — removing it
early means losing the ability to roll back a controller swap by
re-pointing an import, which is the whole safety property this phase relies
on.

---

## 6.4 The actual cutover: a binding change, not a thousand file edits

Because Phase 4 already did the real work — every controller depends on
`TaskService`/`AuthService`/etc., which depend on repository
**interfaces** — cutover is not "go edit every controller's imports."
It's: **change what `composition-root.ts` constructs those interfaces
with.** The app stays Express throughout; no entrypoint, port, or frontend
API base URL changes.

1. In `composition-root.ts`, swap each Mongoose-backed dependency for its
   Drizzle/ioredis-backed counterpart (`new DrizzleTaskRepository(db)`
   instead of whatever wired the Mongoose model in) — one feature at a
   time, matching Phase 4's per-feature order, each swap independently
   smoke-tested before moving to the next.
2. Point `src/index.ts`'s startup at the Postgres/Redis connections
   (`config/database.config.ts`'s new `DATABASE_URL`/`REDIS_URL` wiring
   from §6.3) instead of `MONGO_URI`, once every feature's binding has been
   swapped.
3. Deploy to a non-production environment first if one exists (per
   `docs/ROADMAP.md` §4, this repo currently has only `dev` — treat that
   `dev` environment itself as the safe first target, not production).

The granularity of "one revertible step per feature" is what to preserve —
swap one repository binding, smoke-test, move to the next, rather than
flipping every feature's data source at once.

---

## 6.5 Rollback plan

Because `MONGO_URI` and the old `src/services/*.ts` (pre-`pg/`,
pre-Phase-4-restructure) files still exist until §6.6, rollback at any point
before that step is: **redeploy the previous Express+Mongo build.** This is
why §6.6 (deletion) is its own explicit, later step — don't delete the old
code path in the same change that flips traffic to the new one.

---

## 6.6 Final cleanup — only after the new stack has run real traffic successfully

Do this in a **separate commit/PR** from the cutover itself, after enough
time has passed to be confident (define "enough" concretely — e.g. one full
week of the new stack serving `dev` traffic with no incidents, or whatever
bar matches this app's actual risk tolerance):

1. Remove `mongoose`, `mongodb-memory-server`, `rate-limit-mongo`, and their
   `@types/*` packages from `backend/package.json`.
2. Delete `src/models/*.ts` (every Mongoose schema).
3. Delete the pre-Phase-4 `src/services/*.ts`, `src/controllers/*.ts`,
   `src/routes/*.ts` (the original Mongoose-coupled layer), once every
   feature's `composition-root.ts` binding is confirmed pointed at
   Postgres/Redis.
4. Delete `config/database.config.ts`'s Mongo connection logic (or the
   whole file if nothing else used it).
5. Remove `MONGO_URI` from `config/app.config.ts` and from every
   environment's actual secret/config store (SSM Parameter Store, per
   `docs/infra/` — this repo already has that infra, just update the
   values).
6. Remove the Phase 2 diagnostic route (`GET /api/_internal/pg-check`) if
   it's still present.
7. Update `docs/backend/*.md` (per this repo's own `docs/` convention of
   verified-against-real-code architecture docs) to describe the new
   Postgres+Redis stack — the existing docs describe the Mongo version and
   will be actively wrong once this ships.
8. Update root `PLAN.md` and `docs/ROADMAP.md` if either references the old
   stack in ways that are now stale (e.g. `ROADMAP.md`'s Phase 1 table
   currently lists `Mongoose` under "API" — that becomes inaccurate).

### Test before calling this phase — and the whole migration — done

- `npm run build` succeeds with **zero** `mongoose` or Mongo-driver imports
  anywhere in `src/`.
- `npm test` green, coverage gate (90/85/90/90 or whatever this repo's
  current bar is) passes on the new suite alone.
- Full manual walkthrough one more time: register → verify email → create
  workspace → invite/accept member → create project → create task → assign
  → comment on nothing (no comments feature yet, this is just confirming
  the full existing surface) → logout → login → refresh → logout-all.
- `docker compose ps` (or the real deployed infra) shows Postgres and Redis
  as the only stateful dependencies — no MongoDB connection anywhere.

---

## 6.7 What you now have, and what to do with it

At this point you have hands-on, tested, production-shaped experience with:
relational schema design and normalization tradeoffs (Phase 1), an ORM used
close to raw SQL (Phase 2), Redis data structures and the tradeoffs of
hand-built secondary indexes (Phase 3), dependency inversion and clean
architecture enforced by convention and a composition root (Phase 4), and a
testing strategy that actually exploits that architecture instead of
working around its absence (Phase 5). This is a genuinely different skill
profile than "Express + Mongoose CRUD," built entirely on Postgres, Redis,
and plain TypeScript — no new HTTP framework adopted. Because every service
already depends on interfaces rather than concrete Drizzle/ioredis classes,
adopting NestJS later (a separately-scoped initiative, not part of this
migration) is a binding-mechanics change, not a rewrite — see Phase 4 §4.6.

`docs/ROADMAP.md`'s feature roadmap (comments, attachments, notifications,
search, billing) is unaffected in *scope* by this migration — it's affected
in *foundation*: every one of those features now gets modeled relationally
from day one (a `Comment` table with a real FK to `tasks`, not a Mongoose
schema bolted onto a document store that was already fighting its own
grain, per Phase 0 §0.1's observation about this app's data never really
being document-shaped in the first place).
