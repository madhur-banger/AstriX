/**
 * INTEGRATION TESTS: services/redis/cache.ts
 * -------------------------------------------------
 * Real Redis (testcontainers, see tests/setup/global-setup.ts) via the
 * real ioredis client (src/redis/client.ts) - no mocks.
 */
import { describe, it, expect, vi } from "vitest";
import { cacheAside, invalidateCache } from "../../../src/services/redis/cache";
import { redis } from "../../../src/redis/client";

describe("cache.ts (integration - real Redis via testcontainers)", () => {
  it("calls fetch and caches the result on a cold cache", async () => {
    const fetchFn = vi.fn().mockResolvedValue("fresh-value");

    const result = await cacheAside("cold-key", 60, fetchFn);

    expect(result).toBe("fresh-value");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not call fetch again on a warm cache within the TTL", async () => {
    const fetchFn = vi.fn().mockResolvedValue("fresh-value");

    await cacheAside("warm-key", 60, fetchFn);
    const second = await cacheAside("warm-key", 60, fetchFn);

    expect(second).toBe("fresh-value");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("round-trips a non-trivial object through JSON stringify/parse", async () => {
    const value = {
      id: 42,
      nested: { flag: true, tags: ["a", "b", "c"] },
      list: [1, 2, { deep: "value" }],
    };
    const fetchFn = vi.fn().mockResolvedValue(value);

    const first = await cacheAside("object-key", 60, fetchFn);
    const second = await cacheAside("object-key", 60, fetchFn);

    expect(first).toEqual(value);
    expect(second).toEqual(value);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("expires the entry after its TTL, returning a fresh value on the next call", async () => {
    const staleFetch = vi.fn().mockResolvedValue("stale-value");
    const freshFetch = vi.fn().mockResolvedValue("new-value");

    await cacheAside("expiring-key", 1, staleFetch);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await cacheAside("expiring-key", 1, freshFetch);

    expect(result).toBe("new-value");
    expect(freshFetch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("invalidateCache deletes the key", async () => {
    await cacheAside("to-invalidate", 60, vi.fn().mockResolvedValue("value"));

    await invalidateCache("to-invalidate");

    expect(await redis.get("to-invalidate")).toBeNull();
  });
});
