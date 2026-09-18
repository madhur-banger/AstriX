import "dotenv/config";
import { sql } from "drizzle-orm";
import { buildApp } from "./app";
import { config } from "./config/app.config";
import { logger } from "./utils/logger";
import { db, pool } from "./db/client";
import { redis } from "./redis/client";

const app = buildApp();

const startServer = async () => {
  // Confirm Postgres is reachable BEFORE binding to the port - a task
  // should never report itself as listening/ready if it can't reach its
  // database. Redis errors are already handled non-fatally by
  // src/redis/client.ts's own "error" listener (recoverable transient
  // blips shouldn't crash the whole process), so only Postgres gates
  // startup here.
  try {
    await db.execute(sql`SELECT 1`);
    logger.info("Connected to Postgres");
  } catch (error) {
    logger.error({ err: error }, "Error connecting to Postgres");
    process.exit(1);
  }

  const server = app.listen(config.PORT, () => {
    logger.info(
      `Server listening on port ${config.PORT} in ${config.NODE_ENV} environment`
    );
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop accepting new connections and wait for in-flight requests to
    // finish before closing the DB/cache connections and exiting - avoids
    // dropping requests mid-response when ECS replaces this task.
    server.close(async (closeError) => {
      if (closeError) {
        logger.error({ err: closeError }, "Error while closing HTTP server");
      }

      try {
        await pool.end();
        redis.disconnect();
      } catch (closeConnError) {
        logger.error(
          { err: closeConnError },
          "Error while closing Postgres/Redis connections"
        );
      }

      logger.info("Shutdown complete");
      process.exit(closeError ? 1 : 0);
    });

    // Belt-and-suspenders: force-exit if graceful shutdown hangs (e.g. a
    // connection that never drains) rather than leaving the process stuck
    // past the orchestrator's grace period.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

startServer().catch((error) => {
  logger.error({ err: error }, "Fatal error during startup");
  process.exit(1);
});

export default app;
