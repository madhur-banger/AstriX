import { redis } from "../../redis/client";

export const cacheAside = async <T>(
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>
): Promise<T> => {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached) as T;

  const fresh = await fetch();
  await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
  return fresh;
};

export const invalidateCache = (key: string): Promise<number> => redis.del(key);
