import "dotenv/config";
import assert from "node:assert/strict";
import express from "express";
import { createRateLimiter } from "../src/utils/rate-limiter";
import { redis } from "../src/redis/client";

async function main() {
  const app = express();
  const limiter = createRateLimiter("verify-test", { max: 3, windowMs: 15 * 60 * 1000 });
  app.get("/limited", limiter, (req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/limited`);
    statuses.push(res.status);
  }
  console.log("Statuses for 5 requests against max:3 ->", statuses);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429], "first 3 should succeed, remaining 2 should be rate-limited");
  console.log("OK - 429s start exactly after the configured max");

  const keys = await redis.keys("ratelimit:verify-test:*");
  assert.equal(keys.length, 1, "exactly one counter key should exist for this single client IP");
  const counterKey = keys[0];
  const ttl = await redis.ttl(counterKey);
  console.log(`OK - counter key '${counterKey}' exists, TTL=${ttl}s (window is 900s)`);
  assert.ok(ttl > 0 && ttl <= 900);

  await redis.del(counterKey);
  server.close();
  console.log("\nAll Phase 3 rate-limit verifications passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nVERIFICATION FAILED:", err);
  process.exit(1);
});
