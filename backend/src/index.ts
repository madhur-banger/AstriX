import "dotenv/config";
import crypto from "crypto";
import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pinoHttp from "pino-http";
import mongoose from "mongoose";
import { config } from "./config/app.config";
import { HTTPSTATUS } from "./config/http.config";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.config";
import connectDatabase from "./config/database.config";
import { logger } from "./utils/logger";
import { createRateLimiter } from "./utils/rate-limiter";

import { errorHandler } from "./middlewares/errorHandles.middleware";

import authRoutes from "./routes/auth.route";
import userRoutes from "./routes/user.route";
import workspaceRoutes from "./routes/workspace.routes";
import projectRoutes from "./routes/project.route";
import taskRoutes from "./routes/task.route";
import memberRoutes from "./routes/member.route";
import { authenticate } from "./middlewares/auth.middleware";

const app = express();

/**
 * We run behind CloudFront → ALB → Express
 * So we must trust the first proxy.
 */
app.set("trust proxy", 1);

const BASE_PATH = config.BASE_PATH;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Security headers (XSS protection, etc.)
app.use(helmet());

// ============================================
// REQUEST LOGGING (structured, with per-request correlation id)
// ============================================

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id = typeof existing === "string" ? existing : crypto.randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
  })
);

// ============================================
// BODY PARSING
// ============================================

// This API is JSON-only - no route reads a form-encoded body, so we don't
// mount express.urlencoded(). An explicit size limit replaces the implicit
// (and undocumented) 100kb default.
app.use(express.json({ limit: "1mb" }));

// ============================================
// COOKIE PARSER - CRITICAL FOR REFRESH TOKENS!
// ============================================

/**
 * This parses cookies from incoming requests
 * Without this, req.cookies will be undefined!
 *
 * The refresh token is sent as an httpOnly cookie,
 * so we MUST be able to read it.
 */
app.use(cookieParser());

// ============================================
// CORS CONFIGURATION
// ============================================

// FRONTEND_ORIGIN may be a single origin or a comma-separated list (e.g.
// staging + prod, or an apex domain + its "www" subdomain).
const allowedOrigins = config.FRONTEND_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true, // CRITICAL: Allows cookies to be sent cross-origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ============================================
// RATE LIMITING (general) - /auth/* has its own stricter, route-specific
// limiters (see auth.route.ts); this is the floor for everything else so
// no route is left completely unlimited.
// ============================================

const apiLimiter = createRateLimiter("api", {
  max: 300,
  // Health checks (e.g. an ALB target-group check) can legitimately fire
  // far more often than any real API consumer and shouldn't be limited.
  skip: (req) => req.path === "/health",
});

app.use(apiLimiter);

// ============================================
// API DOCUMENTATION
// ============================================

// Not mounted in production - it's a full route/schema map handed to
// anyone who requests it, and CloudFront proxies /api/* straight through
// to the public ALB with no auth in front of it.
if (config.NODE_ENV !== "production") {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// ============================================
// ROUTES
// ============================================

// Health check - reflects actual DB connectivity (readyState is an
// in-memory flag, no round-trip query needed) rather than always
// reporting OK, so an ALB target-group check can actually detect a task
// whose Mongo connection has dropped and stop routing traffic to it.
app.get("/health", (req: Request, res: Response) => {
  const isDbConnected = mongoose.connection.readyState === 1;

  res
    .status(isDbConnected ? HTTPSTATUS.OK : HTTPSTATUS.SERVICE_UNAVAILABLE)
    .json({
      status: isDbConnected ? "OK" : "DEGRADED",
      db: isDbConnected ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
    });
});

// Auth routes (mostly public)
app.use(`${BASE_PATH}/auth`, authRoutes);

// Protected routes (require JWT)
app.use(`${BASE_PATH}/user`, authenticate, userRoutes);
app.use(`${BASE_PATH}/workspace`, authenticate, workspaceRoutes);
app.use(`${BASE_PATH}/project`, authenticate, projectRoutes);
app.use(`${BASE_PATH}/task`, authenticate, taskRoutes);
app.use(`${BASE_PATH}/member`, authenticate, memberRoutes);

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Global error handler
app.use(errorHandler);

// ============================================
// MONGO CONNECTION LIFECYCLE
// ============================================

mongoose.connection.on("error", (error) => {
  logger.error({ err: error }, "MongoDB connection error");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

// ============================================
// START SERVER
// ============================================

const startServer = async () => {
  // Connect BEFORE binding to the port - a task should never report itself
  // as listening/ready if it can't reach its database. connectDatabase()
  // already process.exit(1)s on failure, so getting past this line means
  // the connection is good.
  await connectDatabase();

  const server = app.listen(config.PORT, () => {
    logger.info(
      `Server listening on port ${config.PORT} in ${config.NODE_ENV} environment`
    );
  });

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);

    // Stop accepting new connections and wait for in-flight requests to
    // finish before closing the DB connection and exiting - avoids
    // dropping requests mid-response when ECS replaces this task.
    server.close(async (closeError) => {
      if (closeError) {
        logger.error({ err: closeError }, "Error while closing HTTP server");
      }

      try {
        await mongoose.connection.close();
      } catch (dbCloseError) {
        logger.error(
          { err: dbCloseError },
          "Error while closing MongoDB connection"
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
