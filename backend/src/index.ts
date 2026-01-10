
import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser"; 
import helmet from "helmet";
import { config } from "./config/app.config";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.config";
import connectDatabase from "./config/database.config";

import { errorHandler } from "./middlewares/errorHandles.middleware";
import { BadRequestException } from "./utils/appError";
import { ErrorCodeEnum } from "./enums/error-code.enum";

import "./config/passport.config";
import passport from "passport";
import authRoutes from "./routes/auth.route";
import userRoutes from "./routes/user.route";
import workspaceRoutes from "./routes/workspace.routes";
import projectRoutes from "./routes/project.route";
import taskRoutes from "./routes/task.route";
import memberRoutes from "./routes/member.route";
import { passportAuthenticateJWT } from "./config/passport.config";

const app = express();
const BASE_PATH = config.BASE_PATH;

// ============================================
// SECURITY MIDDLEWARE
// ============================================

// Security headers (XSS protection, etc.)
app.use(helmet());

// ============================================
// BODY PARSING
// ============================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.use(
  cors({
    origin: config.FRONTEND_ORIGIN,
    credentials: true, // CRITICAL: Allows cookies to be sent cross-origin
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ============================================
// PASSPORT INITIALIZATION
// ============================================

app.use(passport.initialize());

// ============================================
// API DOCUMENTATION
// ============================================

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// ============================================
// ROUTES
// ============================================

// Health check
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Auth routes (mostly public)
app.use(`${BASE_PATH}/auth`, authRoutes);

// Protected routes (require JWT)
app.use(`${BASE_PATH}/user`, passportAuthenticateJWT, userRoutes);
app.use(`${BASE_PATH}/workspace`, passportAuthenticateJWT, workspaceRoutes);
app.use(`${BASE_PATH}/project`, passportAuthenticateJWT, projectRoutes);
app.use(`${BASE_PATH}/task`, passportAuthenticateJWT, taskRoutes);
app.use(`${BASE_PATH}/member`, passportAuthenticateJWT, memberRoutes);

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
// START SERVER
// ============================================

app.listen(config.PORT, async () => {
  console.log(
    `Server listening on port ${config.PORT} in ${config.NODE_ENV} environment`
  );
  await connectDatabase();
});

export default app;