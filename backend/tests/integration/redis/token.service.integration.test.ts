/**
 * INTEGRATION TESTS: services/redis/token.service.ts
 * -------------------------------------------------
 * Real Redis (testcontainers, see tests/setup/global-setup.ts) via the
 * real ioredis client (src/redis/client.ts) - no mocks.
 */
import { describe, it, expect } from "vitest";
import { storeToken, consumeToken } from "../../../src/services/redis/token.service";

describe("token.service.ts (integration - real Redis via testcontainers)", () => {
  it("round-trips a stored token through consumeToken with the same namespace+hash", async () => {
    await storeToken("pwreset", "hash-1", "user-1", 60);

    const userId = await consumeToken("pwreset", "hash-1");

    expect(userId).toBe("user-1");
  });

  it("is single-use: a second consumeToken call for the same token returns null", async () => {
    await storeToken("pwreset", "hash-2", "user-2", 60);

    const first = await consumeToken("pwreset", "hash-2");
    const second = await consumeToken("pwreset", "hash-2");

    expect(first).toBe("user-2");
    expect(second).toBeNull();
  });

  it("isolates namespaces: a token stored under pwreset is not consumable under emailverify with the same hash", async () => {
    await storeToken("pwreset", "shared-hash", "user-3", 60);

    const wrongNamespace = await consumeToken("emailverify", "shared-hash");

    expect(wrongNamespace).toBeNull();
  });

  it("expires the token before it can be consumed once its TTL elapses", async () => {
    await storeToken("pwreset", "hash-ttl", "user-4", 1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await consumeToken("pwreset", "hash-ttl");

    expect(result).toBeNull();
  }, 10000);

  it("under concurrent consumeToken calls, exactly one resolves the userId and the other resolves null", async () => {
    await storeToken("pwreset", "hash-race", "user-5", 60);

    const [first, second] = await Promise.all([
      consumeToken("pwreset", "hash-race"),
      consumeToken("pwreset", "hash-race"),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r === "user-5")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });
});
