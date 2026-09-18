import { redis } from "../../redis/client";

export type TokenNamespace = "pwreset" | "emailverify";

export const storeToken = async (
  namespace: TokenNamespace,
  tokenHash: string,
  userId: string,
  ttlSeconds: number
): Promise<void> => {
  await redis.set(`${namespace}:${tokenHash}`, userId, "EX", ttlSeconds);
};

// GETDEL: atomic fetch-and-delete in one round trip - the Redis-native way
// to express "single use." A naive GET + DEL has a race window between the
// two calls where two concurrent consume attempts could both succeed;
// GETDEL closes it (Phase 3 §3.7).
export const consumeToken = async (
  namespace: TokenNamespace,
  tokenHash: string
): Promise<string | null> => {
  return redis.getdel(`${namespace}:${tokenHash}`);
};
