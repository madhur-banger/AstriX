import rateLimit, {
  type LegacyStore,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";
import MongoStore from "rate-limit-mongo";
import { config } from "../config/app.config";
import { logger } from "./logger";

// express-rate-limit's default store lives in the process's own memory. With
// N ECS tasks behind the ALB that makes every limit effectively N times
// looser than it reads (a 5-attempts-per-15-minutes login limit becomes
// 5 x N), and every deploy or task replacement resets all counters to zero.
// Backing the counters with Mongo - already a dependency, so no new
// infrastructure - makes them cluster-wide and survive task churn.
//
// One store instance is shared by every limiter, so there is exactly one
// extra Mongo connection per task rather than one per limiter. Each limiter
// namespaces its own keys (see `withKeyPrefix`), so sharing the collection
// does NOT merge their budgets.
const RATE_LIMIT_COLLECTION = "rateLimits";

// All limiters in this codebase use the same 15-minute window, which is what
// lets them share one store (the store's TTL is a per-instance setting).
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

let sharedStore: MongoStore | undefined;

const getSharedStore = (): MongoStore | undefined => {
  // No MONGO_URI means local dev or the test suite, neither of which has a
  // cluster to coordinate through. Fall back to express-rate-limit's own
  // in-memory store - still rate limited, just per-process.
  if (!config.MONGO_URI) {
    return undefined;
  }

  if (!sharedStore) {
    sharedStore = new MongoStore({
      uri: config.MONGO_URI,
      collectionName: RATE_LIMIT_COLLECTION,
      expireTimeMs: RATE_LIMIT_WINDOW_MS,
      errorHandler: (error) =>
        logger.error({ err: error }, "Rate limit store error"),
    });
  }

  return sharedStore;
};

// express-rate-limit passes the store nothing but the client key (the IP, by
// default), so two limiters sharing a collection would otherwise share a
// counter. Prefixing per limiter keeps each budget independent.
const withKeyPrefix = (store: MongoStore, prefix: string): LegacyStore => ({
  incr: (key, callback) => store.incr(`${prefix}:${key}`, callback),
  decrement: (key) => store.decrement(`${prefix}:${key}`),
  resetKey: (key) => store.resetKey(`${prefix}:${key}`),
});

/**
 * Builds a rate limiter whose counters are shared across every running
 * instance of the app.
 *
 * @param name - Namespace for this limiter's counters. Must be unique per
 *   limiter, or two limiters will spend each other's budget.
 */
export const createRateLimiter = (
  name: string,
  options: Partial<Options>
): RateLimitRequestHandler => {
  const store = getSharedStore();

  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    ...(store ? { store: withKeyPrefix(store, name) } : {}),
  });
};
