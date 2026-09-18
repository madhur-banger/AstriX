import { randomUUID } from "crypto";
import { redis } from "../../redis/client";

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // matches JWT_REFRESH_TOKEN_EXPIRES_IN default

export interface SessionRecord {
  sessionId: string;
  userId: string;
  userAgent: string;
  ipAddress: string;
  isValid: string;
  refreshTokenHash: string;
  createdAt: string;
}

export const createSession = async (params: {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
  refreshTokenHash: string;
}): Promise<string> => {
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
      createdAt: new Date().toISOString(),
    })
    .expire(key, SESSION_TTL_SECONDS)
    .sadd(`user:${params.userId}:sessions`, sessionId)
    .exec();

  return sessionId;
};

export const getSession = async (
  sessionId: string
): Promise<Record<string, string> | null> => {
  const data = await redis.hgetall(`session:${sessionId}`);
  return Object.keys(data).length === 0 ? null : data;
};

export const rotateSessionToken = async (
  sessionId: string,
  newRefreshTokenHash: string
): Promise<void> => {
  const key = `session:${sessionId}`;
  await redis.hset(key, { refreshTokenHash: newRefreshTokenHash });
  await redis.expire(key, SESSION_TTL_SECONDS);
};

export const invalidateSession = async (
  sessionId: string,
  userId: string
): Promise<void> => {
  await redis
    .multi()
    .del(`session:${sessionId}`)
    .srem(`user:${userId}:sessions`, sessionId)
    .exec();
};

export const listSessionsForUser = async (
  userId: string
): Promise<SessionRecord[]> => {
  const ids = await redis.smembers(`user:${userId}:sessions`);
  const pipeline = redis.pipeline();
  ids.forEach((id) => pipeline.hgetall(`session:${id}`));
  const results = await pipeline.exec();

  // The Set has no per-member TTL, so it can transiently hold a stale
  // session ID after that session's key has already expired (Phase 3 §3.6)
  // - filter those out rather than surfacing an empty record.
  return (results ?? [])
    .map(([, data], i) => ({
      sessionId: ids[i],
      ...(data as Record<string, string>),
    }))
    .filter((s): s is SessionRecord => Object.keys(s).length > 1);
};

// Ports auth.service.ts's invalidateAllSessionsService (Mongo's
// `SessionModel.updateMany({ userId }, { isValid: false })`) - Redis has no
// bulk update, so this fans out one invalidateSession per session instead.
export const invalidateAllSessionsForUser = async (userId: string): Promise<void> => {
  const sessions = await listSessionsForUser(userId);
  await Promise.all(sessions.map((s) => invalidateSession(s.sessionId, userId)));
};

// Ports auth.service.ts's changePasswordService's "invalidate every OTHER
// session" branch.
export const invalidateAllSessionsForUserExcept = async (
  userId: string,
  keepSessionId: string
): Promise<void> => {
  const sessions = await listSessionsForUser(userId);
  await Promise.all(
    sessions.filter((s) => s.sessionId !== keepSessionId).map((s) => invalidateSession(s.sessionId, userId))
  );
};
