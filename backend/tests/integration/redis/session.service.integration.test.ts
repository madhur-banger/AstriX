/**
 * INTEGRATION TESTS: services/redis/session.service.ts
 * -------------------------------------------------
 * Real Redis (testcontainers, see tests/setup/global-setup.ts) via the
 * real ioredis client (src/redis/client.ts) - no mocks. Phase 5 §5.4 calls
 * out two of these tests explicitly as turning a manual observation into a
 * regression test: TTL expiry with no residual read, and the stale
 * Set-member edge case in listSessionsForUser.
 */
import { describe, it, expect } from "vitest";
import {
  createSession,
  getSession,
  rotateSessionToken,
  invalidateSession,
  listSessionsForUser,
  invalidateAllSessionsForUser,
  invalidateAllSessionsForUserExcept,
} from "../../../src/services/redis/session.service";
import { redis } from "../../../src/redis/client";

describe("session.service.ts (integration - real Redis via testcontainers)", () => {
  it("createSession returns a retrievable session with the given fields", async () => {
    const sessionId = await createSession({
      userId: "user-1",
      userAgent: "test-agent",
      ipAddress: "127.0.0.1",
      refreshTokenHash: "hash-1",
    });

    expect(sessionId).toBeTruthy();
    const session = await getSession(sessionId);
    expect(session).toEqual({
      userId: "user-1",
      userAgent: "test-agent",
      ipAddress: "127.0.0.1",
      isValid: "1",
      refreshTokenHash: "hash-1",
      createdAt: expect.any(String),
    });
  });

  it("session expires exactly per TTL, no residual read after expiry", async () => {
    const sessionId = await createSession({
      userId: "user-2",
      refreshTokenHash: "hash-2",
    });
    await redis.expire(`session:${sessionId}`, 1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const session = await getSession(sessionId);

    expect(session).toBeNull();
  }, 10000);

  it("listSessionsForUser excludes a session invalidated mid-list - the stale Set-member edge case", async () => {
    const userId = "user-3";
    const validSessionId = await createSession({ userId, refreshTokenHash: "hash-valid" });
    const staleSessionId = await createSession({ userId, refreshTokenHash: "hash-stale" });

    await redis.del(`session:${staleSessionId}`);

    const sessions = await listSessionsForUser(userId);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(validSessionId);
  });

  it("rotateSessionToken changes refreshTokenHash and refreshes the TTL", async () => {
    const sessionId = await createSession({
      userId: "user-4",
      refreshTokenHash: "old-hash",
    });
    await redis.expire(`session:${sessionId}`, 1);

    await rotateSessionToken(sessionId, "new-hash");

    const session = await getSession(sessionId);
    expect(session?.refreshTokenHash).toBe("new-hash");
    const ttl = await redis.ttl(`session:${sessionId}`);
    expect(ttl).toBeGreaterThan(6 * 24 * 60 * 60);
  });

  it("invalidateSession removes both the session hash and the user's session-set membership", async () => {
    const userId = "user-5";
    const sessionId = await createSession({ userId, refreshTokenHash: "hash-5" });

    await invalidateSession(sessionId, userId);

    expect(await getSession(sessionId)).toBeNull();
    expect(await redis.sismember(`user:${userId}:sessions`, sessionId)).toBe(0);
  });

  it("invalidateAllSessionsForUser invalidates every session for that user but leaves another user's sessions untouched", async () => {
    const userId = "user-6";
    const otherUserId = "user-7";
    const sessionA = await createSession({ userId, refreshTokenHash: "hash-a" });
    const sessionB = await createSession({ userId, refreshTokenHash: "hash-b" });
    const otherSession = await createSession({ userId: otherUserId, refreshTokenHash: "hash-other" });

    await invalidateAllSessionsForUser(userId);

    expect(await getSession(sessionA)).toBeNull();
    expect(await getSession(sessionB)).toBeNull();
    expect(await getSession(otherSession)).not.toBeNull();
  });

  it("invalidateAllSessionsForUserExcept keeps exactly the excepted session valid", async () => {
    const userId = "user-8";
    const keptSession = await createSession({ userId, refreshTokenHash: "hash-keep" });
    const killedSessionA = await createSession({ userId, refreshTokenHash: "hash-kill-a" });
    const killedSessionB = await createSession({ userId, refreshTokenHash: "hash-kill-b" });

    await invalidateAllSessionsForUserExcept(userId, keptSession);

    expect(await getSession(keptSession)).not.toBeNull();
    expect(await getSession(killedSessionA)).toBeNull();
    expect(await getSession(killedSessionB)).toBeNull();
  });
});
