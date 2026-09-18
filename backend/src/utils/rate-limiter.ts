// Redis-backed rate limiter (backend/migrations/phase-3-redis-migration-and-ttl-data.md
// §3.8) - counters are shared across every running instance of the app and
// survive process restarts, unlike express-rate-limit's default in-memory
// store.
import rateLimit, {
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { redis } from "../redis/client";

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export const createRateLimiter = (
  name: string,
  options: Partial<Options>
): RateLimitRequestHandler =>
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    store: new RedisStore({
      sendCommand: (...args: string[]) =>
        redis.call(...(args as [string, ...string[]])) as Promise<
          string | number | Array<string>
        >,
      prefix: `ratelimit:${name}:`,
    }),
  });
