import Redis from "ioredis";
import { getEnv } from "../utils/get-env";
import { logger } from "../utils/logger";

export const redis = new Redis(getEnv("REDIS_URL", "redis://localhost:6379"), {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  // Mirrors connectDatabase()'s error-handling posture in
  // config/database.config.ts - log loudly, don't let a transient Redis
  // blip crash the whole process for connections meant to be recoverable.
  logger.error({ err }, "Redis connection error");
});
