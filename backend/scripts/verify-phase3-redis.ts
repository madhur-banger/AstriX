import "dotenv/config";
import assert from "node:assert/strict";
import { redis } from "../src/redis/client";
import {
  createSession,
  getSession,
  rotateSessionToken,
  invalidateSession,
  listSessionsForUser,
} from "../src/services/redis/session.service";
import { storeToken, consumeToken } from "../src/services/redis/token.service";
import { cacheAside, invalidateCache } from "../src/services/redis/cache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("--- 3.3 ioredis client: ping ---");
  const pong = await redis.ping();
  assert.equal(pong, "PONG");
  console.log("OK -", pong);

  console.log("\n--- 3.5 sessions: create, TTL, fetch ---");
  const userId = "verify-user-1";
  const sessionId = await createSession({
    userId,
    userAgent: "vitest-agent",
    ipAddress: "127.0.0.1",
    refreshTokenHash: "hash-v1",
  });
  const ttl = await redis.ttl(`session:${sessionId}`);
  assert.ok(ttl > 7 * 24 * 60 * 60 - 10 && ttl <= 7 * 24 * 60 * 60, `TTL should be close to 7 days, got ${ttl}`);
  const fetched = await getSession(sessionId);
  assert.equal(fetched?.userId, userId);
  assert.equal(fetched?.refreshTokenHash, "hash-v1");
  console.log(`OK - session created, TTL=${ttl}s, fetched matches`);

  console.log("\n--- 3.5 sessions: rotate token ---");
  await rotateSessionToken(sessionId, "hash-v2");
  const afterRotate = await getSession(sessionId);
  assert.equal(afterRotate?.refreshTokenHash, "hash-v2");
  console.log("OK - refreshTokenHash updated after rotation");

  console.log("\n--- 3.5 sessions: listSessionsForUser reflects create/invalidate ---");
  const sessionId2 = await createSession({ userId, refreshTokenHash: "hash-2nd" });
  let sessions = await listSessionsForUser(userId);
  assert.equal(sessions.length, 2);
  await invalidateSession(sessionId, userId);
  sessions = await listSessionsForUser(userId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId2);
  const afterInvalidate = await getSession(sessionId);
  assert.equal(afterInvalidate, null);
  console.log("OK - invalidated session gone from both the hash and the Set index");

  console.log("\n--- 3.2/3.5 no-defensive-check proof: expired key returns nil immediately ---");
  await redis.expire(`session:${sessionId2}`, 2);
  await sleep(2500);
  const expiredFetch = await getSession(sessionId2);
  assert.equal(expiredFetch, null, "expired session must read as null with zero app-level re-check");
  console.log("OK - session read as null the moment its TTL passed, no defensive check needed");

  console.log("\n--- 3.6 stale Set member: listSessionsForUser filters it out ---");
  // Deliberately create the asymmetry the doc describes: the key expires,
  // but nothing ever called srem, so the Set member is now stale.
  const staleSessions = await listSessionsForUser(userId);
  assert.equal(staleSessions.length, 0, "stale set member for the now-expired session2 must be filtered out");
  console.log("OK - stale Set member (session2, key already expired) correctly filtered, not surfaced as a broken record");

  console.log("\n--- 3.7 tokens: store, consume once, second consume fails ---");
  await storeToken("pwreset", "tokenhash-abc", "verify-user-1", 60);
  const consumed = await consumeToken("pwreset", "tokenhash-abc");
  assert.equal(consumed, "verify-user-1");
  const secondConsume = await consumeToken("pwreset", "tokenhash-abc");
  assert.equal(secondConsume, null, "a second consume of the same token hash must fail - GETDEL is single-use");
  console.log("OK - token consumed once via GETDEL, second consume correctly returns null");

  console.log("\n--- 3.9 cache-aside: miss then hit, then invalidate ---");
  let fetchCount = 0;
  const fetchFromSource = async () => {
    fetchCount++;
    return { members: ["alice", "bob"] };
  };
  const first = await cacheAside("cache:verify:members", 60, fetchFromSource);
  assert.equal(fetchCount, 1);
  const second = await cacheAside("cache:verify:members", 60, fetchFromSource);
  assert.equal(fetchCount, 1, "second call must be a cache hit - fetch must not run again");
  assert.deepEqual(second, first);
  await invalidateCache("cache:verify:members");
  await cacheAside("cache:verify:members", 60, fetchFromSource);
  assert.equal(fetchCount, 2, "after invalidation, fetch must run again");
  console.log(`OK - cache-aside: 1 fetch on miss, 0 fetches on hit, 1 more fetch after invalidation (total ${fetchCount})`);

  console.log("\n--- cleanup ---");
  await redis.del(`user:${userId}:sessions`);
  console.log("OK - verification keys cleaned up");

  console.log("\nAll Phase 3 verifications passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nVERIFICATION FAILED:", err);
  process.exit(1);
});
