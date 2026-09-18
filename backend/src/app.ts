import crypto from "crypto";
import express, { Express, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { sql } from "drizzle-orm";
import { config } from "./config/app.config";
import { HTTPSTATUS } from "./config/http.config";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.config";
import { logger } from "./utils/logger";
import { registry, httpRequestDuration, httpRequestsInFlight } from "./utils/metrics";
import { createRateLimiter } from "./utils/rate-limiter";
import { db } from "./db/client";
import { redis } from "./redis/client";

import { errorHandler } from "./middlewares/errorHandles.middleware";

import authRoutes from "./routes/auth.route";
import userRoutes from "./routes/user.route";
import workspaceRoutes from "./routes/workspace.routes";
import projectRoutes from "./routes/project.route";
import taskRoutes from "./routes/task.route";
import memberRoutes from "./routes/member.route";
import { authenticate } from "./middlewares/auth.middleware";

// Pure Express app assembly - no `listen()`, no process lifecycle. Kept
// separate from src/index.ts (which owns startup/shutdown) so tests can
// build a real, fully-wired app without booting an actual HTTP server or
// tying the app's construction to a particular Postgres/Redis being
// reachable at import time.
export const buildApp = (): Express => {
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
  // METRICS (per-request duration + in-flight count)
  // ============================================

  app.use((req: Request, res: Response, next) => {
    httpRequestsInFlight.inc();
    const endTimer = httpRequestDuration.startTimer({ method: req.method });

    res.on("finish", () => {
      httpRequestsInFlight.dec();
      // baseUrl + route.path is the matched Express route pattern (e.g.
      // "/api/workspace/:id") rather than the literal URL, so per-endpoint
      // cardinality stays bounded instead of one label series per distinct
      // id, and routes with the same param pattern under different routers
      // (e.g. workspace "/:id" vs project "/:id") don't collide.
      const route = req.route ? `${req.baseUrl}${req.route.path}` : req.path;
      endTimer({ route, status_code: res.statusCode });
    });

    next();
  });

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
    max: config.API_RATE_LIMIT_MAX,
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

  // Health check - actually round-trips to Postgres and Redis rather than
  // always reporting OK, so an ALB target-group check can detect a task
  // whose database/cache connection has dropped and stop routing to it.
  app.get("/health", async (req: Request, res: Response) => {
    const [pgOk, redisOk] = await Promise.all([
      db
        .execute(sql`SELECT 1`)
        .then(() => true)
        .catch(() => false),
      redis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);

    const healthy = pgOk && redisOk;

    res.status(healthy ? HTTPSTATUS.OK : HTTPSTATUS.SERVICE_UNAVAILABLE).json({
      status: healthy ? "OK" : "DEGRADED",
      postgres: pgOk ? "connected" : "disconnected",
      redis: redisOk ? "connected" : "disconnected",
      timestamp: new Date().toISOString(),
    });
  });

  // Prometheus-format scrape target. Not mounted under BASE_PATH/authenticate
  // - a scraper has no JWT, so it's gated by METRICS_AUTH_TOKEN instead (see
  // app.config.ts) when that's set.
  app.get("/metrics", async (req: Request, res: Response) => {
    if (config.METRICS_AUTH_TOKEN) {
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (provided !== config.METRICS_AUTH_TOKEN) {
        return res.status(HTTPSTATUS.UNAUTHORIZED).end();
      }
    }

    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
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

  return app;
};
