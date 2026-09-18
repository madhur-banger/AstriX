# Phase 3 — Redis: Sessions, Tokens, Rate Limiting, Caching

> Part of the [migrations/](./PLAN.md) series. **Independent of Phase 2** —
> this phase has no dependency on the Postgres service ports, so you can do
> it before, after, or interleaved with Phase 2 if you'd rather learn Redis
> first. This file: full Redis data-structure theory, then every TTL-based
> Mongo collection ported, then the two "Redis done right" bonus wins
> (rate limiting, caching) this app's `PLAN.md`/`ROADMAP.md` already flagged
> as real gaps.

---

## 3.1 Theory: Redis's actual data model, precisely

Redis is not "a key-value cache" in the reductive sense — it's a **data
structure server**. Every key maps to one of a fixed set of structures, each
with its own O-complexity guarantees you're expected to know before
choosing one:

| Structure | Shape | Core ops | O-complexity | When to reach for it |
|---|---|---|---|---|
| **String** | one value (text, number, or binary) | `GET`/`SET`/`INCR`/`SETEX` | O(1) | A single value with a single TTL — a token, a cached JSON blob |
| **Hash** | field → value map, like one flat JS object | `HSET`/`HGET`/`HGETALL`/`HDEL` | O(1) per field | A record with several fields you sometimes update independently — a session (`userId`, `isValid`, `refreshTokenHash` as separate hash fields) |
| **Set** | unordered unique values | `SADD`/`SREM`/`SMEMBERS`/`SISMEMBER` | O(1) add/remove/check | "All session IDs for user X" — membership testing, no duplicates, no order needed |
| **Sorted Set (ZSet)** | unique values each with a numeric score, kept in score order | `ZADD`/`ZRANGE`/`ZRANGEBYSCORE` | O(log N) insert | Leaderboards, or **anything ordered by time you need range queries over** — not used in this migration, but the natural next tool if a "recent activity feed" (ROADMAP.md's `Activity` model) ever needs a fast recency-ordered read path |
| **List** | ordered, allows duplicates | `LPUSH`/`RPOP`/`LRANGE` | O(1) push/pop at ends | Simple queues — not used here; the app's actual job-queue need (ROADMAP.md Phase 2) is better served by SQS, which has proper visibility timeouts/DLQs that a Redis list doesn't give you for free |
| **Stream** | append-only log with consumer groups | `XADD`/`XREAD` | O(1) append | Kafka-lite; well beyond this app's scale, mentioned only so you know it exists |

**The one property every structure shares, and the one that matters most for
this phase:** any key (of any structure type) can have a **TTL**
(`EXPIRE key seconds`, or set atomically at creation via `SETEX`/`SET ...
EX`). This is the single feature that makes Redis the architecturally
correct replacement for every Mongo TTL-index collection in this app.

## 3.2 Theory: how Redis TTL actually differs from Mongo's TTL index

This is worth being precise about, because it's not just "Redis is faster" —
the *mechanism* is different in a way that removes a real class of bug.

- **Mongo's TTL index** marks a `Date` field for background expiry, but the
  actual deletion happens via a **background thread that sweeps roughly
  every 60 seconds**. A document can be logically expired but still
  physically present (and returned by a plain `findOne`) for up to a minute.
  This is exactly why `auth.service.ts:350` has to defensively re-check
  `if (session.expiresAt < new Date())` in application code — the TTL index
  alone isn't a strong enough guarantee to trust blindly.
- **Redis expiry is enforced two ways, both immediate from the client's
  perspective:** *lazy* expiry (a key past its TTL is treated as
  nonexistent the instant any command touches it, even before the
  background sweep runs) and *active* expiry (a background cycle that
  proactively deletes expired keys to reclaim memory, independent of
  whether anything reads them). The practical consequence: **a `GET` on an
  expired key always returns nil, with zero possibility of the stale value
  leaking through** — no defensive re-check needed in application code. You
  get to delete the entire category of bug the Mongo comment above is
  guarding against.

---

## 3.3 Setup: `ioredis` client

```bash
npm install ioredis
```

`src/redis/client.ts`:

```ts
import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  // Mirrors this app's existing connectDatabase() error-handling posture
  // in config/database.config.ts - log loudly, don't let a transient Redis
  // blip crash the whole process for connections that are meant to be
  // recoverable/ephemeral.
  console.error("Redis connection error:", err);
});
```

**Why `ioredis` over the `redis` (node-redis) package:** better
TypeScript-first ergonomics, built-in Cluster/Sentinel client support
(irrelevant at this app's scale today, but idiomatic to know), and it's the
more common choice in production Node backends you'll encounter
professionally.

**Test:** `redis.ping()` resolves to `"PONG"` from a throwaway script.
Nothing in `src/services/*` references this yet.

---

## 3.4 Key-naming convention — design this on paper before writing code

Redis has **no schema**, which means key naming *is* your schema. Get this
wrong and you'll be renaming keys in production later. Convention used
throughout this phase: `<entity>:<id>` for a single record,
`<entity>:<parent-id>:<relation>` for a derived index:

```
session:<sessionId>              -> Hash  { userId, userAgent, ipAddress, isValid, refreshTokenHash, expiresAt }
user:<userId>:sessions           -> Set   { sessionId, sessionId, ... }
pwreset:<tokenHash>               -> String userId
emailverify:<tokenHash>           -> String userId
ratelimit:<limiterName>:<ip>      -> String (counter, via INCR)
cache:workspace-members:<wsId>    -> String (JSON, cache-aside)
```

---

## 3.5 Porting sessions (`models/session.model.ts` → Redis Hash + Set index)

The Mongo model stores `userId, userAgent, ipAddress, isValid,
refreshTokenHash, expiresAt` per session, with a TTL index on `expiresAt`
and a compound index `{ userId: 1, isValid: 1 }` for listing a user's
sessions.

```ts
// src/services/redis/session.service.ts
import { randomUUID } from "crypto";
import { redis } from "../../redis/client";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // matches JWT_REFRESH_TOKEN_EXPIRES_IN default

export const createSession = async (params: {
  userId: string; userAgent?: string; ipAddress?: string; refreshTokenHash: string;
}) => {
  const sessionId = randomUUID();
  const key = `session:${sessionId}`;

  await redis
    .multi()
    .hset(key, {
      userId: params.userId,
      userAgent: params.userAgent ?? "",
      ipAddress: params.ipAddress ?? "",
      isValid: "1",
      refreshTokenHash: params.refreshTokenHash,
    })
    .expire(key, SESSION_TTL_SECONDS)
    .sadd(`user:${params.userId}:sessions`, sessionId)
    .exec();

  return sessionId;
};

export const getSession = async (sessionId: string) => {
  const data = await redis.hgetall(`session:${sessionId}`);
  return Object.keys(data).length === 0 ? null : data; // hgetall returns {} for a missing/expired key
};

export const rotateSessionToken = async (sessionId: string, newRefreshTokenHash: string) => {
  const key = `session:${sessionId}`;
  await redis.hset(key, { refreshTokenHash: newRefreshTokenHash });
  await redis.expire(key, SESSION_TTL_SECONDS); // refresh TTL on rotation, matching current sliding-expiry behavior
};

export const invalidateSession = async (sessionId: string, userId: string) => {
  await redis.multi().del(`session:${sessionId}`).srem(`user:${userId}:sessions`, sessionId).exec();
};

export const listSessionsForUser = async (userId: string) => {
  const ids = await redis.smembers(`user:${userId}:sessions`);
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(`session:${id}`));
  const results = await pipeline.exec();
  // Filter out any set members whose session key already expired - the Set
  // itself has no TTL per-member, so it can transiently hold stale IDs
  // until the next invalidateSession call cleans them up. This asymmetry
  // (the index doesn't expire in lockstep with the thing it indexes) is
  // the single sharpest lesson in this whole phase - see §3.6.
  return (results ?? [])
    .map(([, data], i) => ({ sessionId: ids[i], ...(data as Record<string, string>) }))
    .filter((s) => Object.keys(s).length > 1);
};
```

**Why `redis.multi()` (a pipeline of commands sent atomically) for
`createSession`:** you're writing to two different keys (the session hash
and the user's session-set) that must stay in sync. `MULTI`/`EXEC` batches
commands so they execute back-to-back with no other client's commands
interleaved between them — this is **not** the same guarantee as a
Postgres transaction (no rollback if one command in the batch fails after
others succeeded — see §3.6), but it does guarantee atomicity of
*execution ordering*, which is what matters here.

**Test (`scripts/verify-sessions-redis.ts`):** create a session, confirm
`TTL session:<id>` is close to `SESSION_TTL_SECONDS`, fetch it, rotate its
token and confirm the hash field changed, invalidate it and confirm a
subsequent `getSession` returns `null`, confirm
`listSessionsForUser` reflects create/invalidate correctly. Also
run the "no defensive check needed" proof from §3.2 directly: create a
session with a manually shortened TTL (`redis.expire(key, 2)`), wait 3
seconds, confirm `getSession` returns `null` with zero extra application
logic.

---

## 3.6 Theory: the real tradeoff you just accepted — secondary indexes are your job now

The `user:<userId>:sessions` Set in §3.5 is the concrete lesson PLAN.md's
original file only stated abstractly. Restate it precisely now that you've
built it: **Postgres/Mongo give you "query by any field" for free (an index
on any column, or a collection scan as a fallback). Redis gives you O(1)
lookup by the *exact key you designed for* and nothing else** — "list all
sessions for user X" was a free `find({ userId, isValid: true })` in Mongo,
and required you to hand-build and hand-maintain a parallel Set structure in
Redis, kept in sync on every create/delete by your own application code, not
the database.

This has a sharp edge worth internalizing: if `invalidateSession` above
ever fails to run (a crash between the `session:*` key's natural TTL expiry
and the `SREM` call, or a code path that deletes a session key directly
without also calling `srem`), the Set can hold a **stale session ID
pointing at nothing**. `listSessionsForUser`'s filter step (dropping empty
`hgetall` results) is a defensive patch for exactly this — the honest
takeaway is: **Redis secondary indexes need their own maintenance
discipline; they are not self-healing the way a relational index is.**

---

## 3.7 Porting password-reset and email-verification tokens

Both `models/passwordResetToken.model.ts` and
`models/emailVerificationToken.model.ts` are identical in shape (hash + TTL,
single-use, looked up by hash) — this collapses to a single, reusable Redis
service instead of two near-duplicate Mongo models:

```ts
// src/services/redis/token.service.ts
import { redis } from "../../redis/client";

export const storeToken = async (namespace: "pwreset" | "emailverify", tokenHash: string, userId: string, ttlSeconds: number) => {
  await redis.set(`${namespace}:${tokenHash}`, userId, "EX", ttlSeconds);
};

export const consumeToken = async (namespace: "pwreset" | "emailverify", tokenHash: string): Promise<string | null> => {
  // GETDEL: atomic fetch-and-delete in one round trip - the Redis-native
  // way to express "single use" (the Mongo version does this as two
  // separate calls: findOne, then a later explicit delete once the reset
  // actually succeeds - GETDEL collapses that into one atomic primitive
  // Mongo has no equivalent for).
  return redis.getdel(`${namespace}:${tokenHash}`);
};
```

**Why this single service replaces two Mongo models cleanly:** the two
Mongo collections only ever differed by TTL duration
(`PASSWORD_RESET_TOKEN_EXPIRES_IN` vs. `EMAIL_VERIFICATION_TOKEN_EXPIRES_IN`,
both in `config/app.config.ts`) and by which `sendXEmail` function used
them — never by structure. Redis's schemaless key-namespace approach makes
that shared structure explicit instead of duplicating a whole Mongoose
schema+model file for a difference that was really just "which prefix and
which TTL."

**Test:** store a token, consume it, confirm a second `consumeToken` call
for the same hash returns `null` (proving single-use via `GETDEL`'s
atomicity — two concurrent consume attempts can't both succeed, unlike a
naive `GET` + `DEL` which has a race window between the two calls).

---

## 3.8 Rate limiting — the clean Redis win, replacing `rate-limit-mongo`

`src/utils/rate-limiter.ts` today stores rate-limit counters *in MongoDB*
via `rate-limit-mongo`, with an explicit comment acknowledging the tradeoff
(shared store across ECS tasks, at the cost of a Mongo write per
rate-limited request). This is the single clearest "wrong tool, working
around it" example in the current codebase — a rate-limit counter is
exactly Redis's design center: a single key, incremented atomically, with a
TTL.

```ts
// src/utils/rate-limiter.ts (Redis version)
import rateLimit, { type Options, type RateLimitRequestHandler } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../redis/client";

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export const createRateLimiter = (name: string, options: Partial<Options>): RateLimitRequestHandler =>
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    store: new RedisStore({
      // rate-limit-redis expects a command function, not the client directly
      sendCommand: (...args: string[]) => redis.call(...args) as Promise<any>,
      prefix: `ratelimit:${name}:`,
    }),
  });
```

**Why this is strictly better, not just "moved":** the Mongo version's
`incr` (via `rate-limit-mongo`'s legacy-store callback interface) is a
`findOneAndUpdate` with an upsert — a full document read-modify-write
against a general-purpose document store. Redis's `INCR` is a **single
atomic primitive purpose-built for exactly this operation**, O(1), no
document versioning/locking overhead. You also get to delete the entire
`withKeyPrefix`/shared-collection-namespacing dance in the current file —
`rate-limit-redis`'s `prefix` option does that natively.

**Test:** hit a rate-limited route (e.g. login) past its limit locally,
confirm `429`s start, confirm `redis-cli GET ratelimit:<name>:<ip>` shows
the counter, confirm it resets after the window via `TTL`.

---

## 3.9 Cache-aside — the one new capability this app doesn't have today

Pick **one** genuinely low-churn, read-heavy query to practice on — don't
cache everything. Good candidate: `getWorkspaceMembersService`
(`workspace.service.ts:117-124`), read on every sidebar render, changes
only when someone joins/leaves/changes role.

```ts
// src/services/redis/cache.ts
import { redis } from "../../redis/client";

export const cacheAside = async <T>(key: string, ttlSeconds: number, fetch: () => Promise<T>): Promise<T> => {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as T;

  const fresh = await fetch();
  await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
  return fresh;
};

export const invalidateCache = (key: string) => redis.del(key);
```

Usage:

```ts
const members = await cacheAside(
  `cache:workspace-members:${workspaceId}`,
  60,
  () => getWorkspaceMembersFromPostgres(workspaceId)
);
```

**Call `invalidateCache` from every mutation that changes membership** (add
member, remove member, change role) — this is **the actually hard half of
caching**, and worth naming precisely: a cache with a TTL alone is
eventually-correct (wrong for up to `ttlSeconds`); a cache invalidated on
every write is correct immediately, at the cost of you having to find and
update every write path that could stale it. Prefer explicit invalidation
over a longer TTL for anything where "wrong for up to a minute" is a real
user-visible bug (this one arguably is — someone removed from a workspace
shouldn't still see it for 60 seconds).

**Test:** fetch workspace members (cache miss, hits Postgres — confirm via
a log or a temporary counter), fetch again (cache hit — confirm Postgres
is *not* queried the second time), add a member, fetch again (confirm the
new member appears immediately — proving invalidation fired, not just TTL
expiry).

---

## 3.10 Actually done — status: ✅ complete, verified against real Docker Redis

Committed artifacts, all real code:

- `backend/src/redis/client.ts` — the `ioredis` client, exactly per §3.3.
- `backend/src/services/redis/session.service.ts` — `createSession`,
  `getSession`, `rotateSessionToken`, `invalidateSession`,
  `listSessionsForUser`, matching §3.5 exactly.
- `backend/src/services/redis/token.service.ts` — the shared
  `storeToken`/`consumeToken` pair replacing both
  `passwordResetToken.model.ts` and `emailVerificationToken.model.ts`, per
  §3.7.
- `backend/src/services/redis/cache.ts` — `cacheAside`/`invalidateCache`,
  per §3.9.
- `backend/src/utils/rate-limiter.redis.ts` — the Redis-backed rate
  limiter from §3.8, deliberately kept as a **parallel** file rather than
  editing the live `rate-limiter.ts` in place: consistent with Phase 2's
  "nothing here touches a live route" discipline, since `rate-limiter.ts`
  is actually mounted in `src/index.ts`/`auth.route.ts` today. It gets
  swapped in at Phase 6 cutover, same as every `pg/` service.
- `backend/scripts/verify-phase3-redis.ts`,
  `backend/scripts/verify-phase3-ratelimit.ts` — real verify scripts, run
  against the actual Phase 0 Docker Redis container, output below.

### A second port collision — the same lesson as Phase 2, on Redis this time

Before any of this could be tested, `REDIS_URL=redis://localhost:6379`
(Phase 0's default) hit the same problem Phase 2 found on Postgres:
`lsof -iTCP:6379` showed **a native Homebrew Redis already listening on
`127.0.0.1:6379`** on this machine, alongside Docker's forwarded port.
Fixed the same way — remapped the container's host port in
`docker-compose.yml` (`"63790:6379"`) and set `REDIS_URL` accordingly in
`.env`. Worth generalizing the lesson from Phase 2 now that it's happened
twice: **check `lsof -iTCP:<port>` for every port Phase 0's compose file
claims, on any new machine**, before assuming the defaults are free — this
machine happened to have both a native Postgres and a native Redis
pre-installed, and both silently intercepted the standard port.

### Verification — actually run, full output

```
--- 3.3 ioredis client: ping ---
OK - PONG

--- 3.5 sessions: create, TTL, fetch ---
OK - session created, TTL=604800s, fetched matches

--- 3.5 sessions: rotate token ---
OK - refreshTokenHash updated after rotation

--- 3.5 sessions: listSessionsForUser reflects create/invalidate ---
OK - invalidated session gone from both the hash and the Set index

--- 3.2/3.5 no-defensive-check proof: expired key returns nil immediately ---
OK - session read as null the moment its TTL passed, no defensive check needed

--- 3.6 stale Set member: listSessionsForUser filters it out ---
OK - stale Set member (session2, key already expired) correctly filtered, not surfaced as a broken record

--- 3.7 tokens: store, consume once, second consume fails ---
OK - token consumed once via GETDEL, second consume correctly returns null

--- 3.9 cache-aside: miss then hit, then invalidate ---
OK - cache-aside: 1 fetch on miss, 0 fetches on hit, 1 more fetch after invalidation (total 2)

All Phase 3 verifications passed.
```

Every non-obvious claim §3.2-§3.9 make was checked directly against a real
Redis instance, not asserted from theory: `TTL session:<id>` reads
`604800` (exactly 7 days, matching `SESSION_TTL_SECONDS`) immediately after
creation; a session read 2.5 seconds after its TTL was manually shortened
to 2 seconds returns `null` with **zero** defensive re-check in the calling
code — the concrete proof of §3.2's "delete the entire category of bug"
claim; the stale-Set-member scenario §3.6 warns about was deliberately
constructed (let a session's key expire without ever calling
`invalidateSession`/`srem` on it) and `listSessionsForUser` correctly
filtered it out rather than returning a broken half-empty record; and the
password-reset token's second `consumeToken` call correctly returned
`null`, proving `GETDEL`'s single-use guarantee rather than just trusting
it.

### Rate limiter — a real Express app, real 429s

```
Statuses for 5 requests against max:3 -> [ 200, 200, 200, 429, 429 ]
OK - 429s start exactly after the configured max
OK - counter key 'ratelimit:verify-test:127.0.0.1' exists, TTL=900s (window is 900s)

All Phase 3 rate-limit verifications passed.
```

Booted an actual throwaway Express app with `rate-limiter.redis.ts`'s
`createRateLimiter` mounted on a real route, hit it 5 times with `max: 3`,
and got exactly the boundary §3.8 predicts: the 4th and 5th requests are
`429`, not the 3rd or the 6th. Confirmed the counter key lives under the
`ratelimit:verify-test:` prefix (proving `rate-limit-redis`'s `prefix`
option correctly replaces the current `withKeyPrefix` hand-rolled
namespacing in `rate-limiter.ts`) with a TTL matching the 15-minute window.

### Mongo suite + build + Redis cleanliness — confirmed unaffected

```
$ npm test
 Test Files  46 passed (46)
      Tests  561 passed | 1 skipped (562)

$ npm run build
tsc && cp ./package.json ./dist   # exit 0, no errors

$ docker compose exec redis redis-cli KEYS '*'
(empty)
```

Identical baseline to Phase 0/1/2 — confirms nothing under the live Mongo
code path (including the still-live `rate-limiter.ts`) was touched, and
every key created during verification was cleaned up, leaving Redis empty.

---

## 3.11 What to read next

- [phase-4-clean-architecture-express.md](./phase-4-clean-architecture-express.md)
  — now that both Postgres services (Phase 2) and Redis services (this
  phase) exist as plain functions, restructure them behind repository
  interfaces with manual dependency injection (no framework) — the
  clean/onion-architecture layer you asked for.
- [phase-5-testing-strategy.md](./phase-5-testing-strategy.md) — how to test
  all of this, Mongo-suite-parity included, with the interface-driven
  testing patterns Phase 4's repositories enable.
