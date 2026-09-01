# Caching Strategies and Invalidation

Caching is the cheapest performance win available in most systems — and the fastest way to serve wrong data if the invalidation strategy is an afterthought. This file covers the three standard cache-population patterns, TTL design, the thundering-herd failure mode, and why cache invalidation earned its reputation as one of the genuinely hard problems in computer science.

## Cache-Aside (Lazy Loading)

The application owns the cache explicitly: check the cache first, fall through to the source of truth on a miss, then populate the cache for next time.

1. Read request arrives.
2. Check cache. Hit → return cached value, done.
3. Miss → read from the database.
4. Write the result into the cache.
5. Return the value.

```js
async function getWorkspace(id) {
  const cached = await redis.get(`workspace:${id}`);
  if (cached) return JSON.parse(cached);

  const workspace = await db.workspaces.findById(id);
  await redis.set(`workspace:${id}`, JSON.stringify(workspace), "EX", 300);
  return workspace;
}
```

This is the most common pattern because it's the least invasive — the cache is optional infrastructure that can fail or be flushed entirely without breaking correctness, only latency. The cost: the first reader after any miss (a cold cache, an eviction, an expiry) pays the full read latency, and the cache can briefly hold stale data if the underlying row changes without an explicit invalidation.

## Write-Through

Every write goes through the cache, which writes to the database synchronously before returning.

1. Write request arrives.
2. Write to cache.
3. Cache writes through to the database, in the same request.
4. Acknowledge success only after the database write confirms.

```js
async function updateWorkspace(id, data) {
  await db.workspaces.updateOne({ _id: id }, data);
  await redis.set(`workspace:${id}`, JSON.stringify({ ...data, _id: id }), "EX", 300);
}
```

Cache and database stay consistent because every write updates both before the caller gets a response — there's no window where the cache is silently stale from a write that already succeeded. The cost is write latency: every write pays for two round trips (cache + database) instead of one, and rarely-read data still gets cached, wasting cache memory on entries that may never be read back.

## Write-Behind (Write-Back)

Writes land in the cache immediately and are acknowledged right away; the write to the database is deferred and batched, flushed asynchronously.

1. Write request arrives.
2. Write to cache, acknowledge immediately.
3. A background process later flushes the change to the database (batched, on an interval, or on eviction).

This gives the lowest write latency of the three, and batching database writes can meaningfully reduce database load under high write volume. The cost is real: a cache-node crash before the flush loses data that was already acknowledged as written, and this pattern needs enough operational maturity (durable write-ahead buffering, careful flush ordering) that most teams reach for it only when write-through's latency is a proven bottleneck, not by default.

## TTL Design Tradeoffs

A short TTL keeps the cache closer to the source of truth but increases database load (more misses) and re-fetch latency. A long TTL reduces database load and improves hit rate but tolerates staler data for longer. There's no universally correct number — it's a function of how expensive a miss is (a cheap key lookup vs. an aggregation query) and how tolerant the data is of staleness (a user's display name can be minutes stale; an account's ban status generally shouldn't be).

## Thundering Herd

When a hot key expires, every concurrent request for that key misses simultaneously and stampedes the database at once — potentially hundreds of identical queries fired in the same instant for data that's about to be re-cached as a single value anyway. Two real fixes:

- **Request coalescing** — the first request to miss takes a lock (or registers an in-flight promise) for that key; concurrent requests for the same key wait on that same in-flight fetch instead of issuing their own, then all read the one result once it lands.
- **Jittered TTLs** — instead of every instance of a key expiring at exactly the same wall-clock moment (common when many keys were populated in a burst, e.g. after a cache flush or a deploy), add randomness to the expiry: `TTL = baseTTL + random(0, baseTTL * 0.1)`. This spreads expirations out over time instead of letting them cluster and all miss together.

```js
const jitter = Math.floor(baseTTL * 0.1 * Math.random());
await redis.set(key, value, "EX", baseTTL + jitter);
```

## Cache Invalidation Is One of the Two Hard Problems in CS

The aphorism ("there are only two hard things in computer science: cache invalidation and naming things") holds up because invalidation isn't one problem, it's a coordination problem across every code path that could change the underlying data. TTL alone is a blunt instrument: it bounds staleness but never eliminates it, and "bounded staleness" is not the same guarantee as "correct."

Concretely: suppose a workspace's member list is cached under `members:{workspaceId}` with a 5-minute TTL for a UI that shows "who's in this workspace." An admin adds a new member. If invalidation relies purely on the TTL, every other member's view of the roster is wrong — missing the new person entirely — for up to 5 minutes, with no way for anyone to know it's stale. The correct fix is **explicit invalidation on the write path**: the moment the add-member write commits, the same request handler deletes (or overwrites) `members:{workspaceId}` before returning.

```js
async function addMember(workspaceId, userId) {
  await db.members.insertOne({ workspaceId, userId });
  await redis.del(`members:${workspaceId}`); // invalidate immediately, don't wait on TTL
}
```

The gotcha that actually bites people in production: this only works if *every* write path that touches the underlying data remembers to invalidate the same key — a bulk import script, an admin panel, a background job that also mutates membership, all have to know about and hit the same cache key. Miss one write path and you've reintroduced silent staleness that a TTL-only design would at least have bounded. This is why cache invalidation logic belongs as close as possible to the single source-of-truth write function, not duplicated at every call site that happens to mutate the data.
