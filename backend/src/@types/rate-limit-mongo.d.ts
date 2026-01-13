// `rate-limit-mongo` ships no types. Declared here rather than pulled from
// DefinitelyTyped (no @types package exists) so the store options we
// actually pass are checked. Shape mirrors rate-limit-mongo@2.3.x's
// MongoStore constructor and its legacy (callback-style) store interface,
// which express-rate-limit still accepts as `LegacyStore`.
declare module "rate-limit-mongo" {
  import type { IncrementCallback } from "express-rate-limit";

  interface MongoStoreOptions {
    uri: string;
    collectionName?: string;
    user?: string;
    password?: string;
    authSource?: string;
    /** How long a hit counter lives before Mongo's TTL index removes it. */
    expireTimeMs?: number;
    resetExpireDateOnChange?: boolean;
    createTtlIndex?: boolean;
    errorHandler?: (error: Error) => void;
    connectionOptions?: Record<string, unknown>;
  }

  class MongoStore {
    constructor(options: MongoStoreOptions);
    incr(key: string, callback: IncrementCallback): void;
    decrement(key: string): void;
    resetKey(key: string): void;
  }

  export = MongoStore;
}
