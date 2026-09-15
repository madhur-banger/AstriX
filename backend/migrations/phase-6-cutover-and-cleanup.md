# Phase 6 — Cutover and Cleanup

> Part of the [migrations/](./PLAN.md) series. Assumes Phases 0-5 are done:
> Postgres schema verified, services ported, Redis pieces ported, NestJS
> clean-architecture restructuring complete, and the new test suite proves
> behavioral parity with the old Mongo/Express suite. This is the **only
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
- [ ] `npm test` green on **both** suites — the original Mongo/Express one
      and the new Postgres/Redis/Nest one.
- [ ] The Nest app has been run standalone (a different port than the
      Express app) and manually smoke-tested end to end at least once.
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

## 6.4 The actual cutover: one entrypoint change, not a thousand file edits

Because Phase 4 already did the real work — every controller depends on
`TaskService`/`AuthService`/etc., which depend on repository
**interfaces** — cutover is not "go edit every controller's imports."
It's: **change what `src/*.module.ts` binds those interfaces to.**

If you built the Nest app as a fully separate app (recommended path,
matches Phase 4 §4.7's "side by side, different port" verification step):

1. Point the deployed process at the Nest app's entrypoint instead of
   Express's `src/index.ts` (update `package.json`'s `start`/`dev` scripts,
   or the Docker `CMD`/ECS task definition, depending on where this
   actually runs).
2. Update the frontend's API base URL if the port/path differs (check
   `client/`'s API client config — likely unaffected if you kept the same
   `BASE_PATH`/port).
3. Deploy to a non-production environment first if one exists (per
   `docs/ROADMAP.md` §4, this repo currently has only `dev` — treat that
   `dev` environment itself as the safe first target, not production).

If instead you're flipping feature-by-feature within a still-Express app
(only relevant if you chose not to fully adopt Nest's HTTP layer, keeping
Nest for DI/services only) — swap one controller's service binding at a
time, smoke-test, move to the next. Either way, the granularity of "one
revertible step" is what to preserve, not the specific mechanics.

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
   `src/routes/*.ts`, `src/middlewares/*.ts` (the original Express layer),
   once the Nest app is confirmed to be the only thing serving traffic.
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
   Postgres+Redis+Nest stack — the existing docs describe the Mongo/Express
   version and will be actively wrong once this ships.
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
architecture enforced by a real DI container (Phase 4), and a testing
strategy that actually exploits that architecture instead of working around
its absence (Phase 5). This is a genuinely different skill profile than
"Express + Mongoose CRUD," and it's the profile the earlier conversation
identified as the higher-leverage move for growth versus building more
product features on the old stack.

`docs/ROADMAP.md`'s feature roadmap (comments, attachments, notifications,
search, billing) is unaffected in *scope* by this migration — it's affected
in *foundation*: every one of those features now gets modeled relationally
from day one (a `Comment` table with a real FK to `tasks`, not a Mongoose
schema bolted onto a document store that was already fighting its own
grain, per Phase 0 §0.1's observation about this app's data never really
being document-shaped in the first place).
