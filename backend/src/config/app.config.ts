import { getEnv } from "../utils/get-env";

type NodeEnv = "development" | "production" | "test";

const NODE_ENV = getEnv<NodeEnv>("NODE_ENV", "development");
const PORT = getEnv("PORT", "8000");
const BASE_PATH = getEnv("BASE_PATH", "/api");

// The Mongo driver's default maxPoolSize is 100 PER PROCESS. With several
// ECS tasks scaling out behind the ALB, that can exhaust a lower-tier Atlas
// cluster's total connection ceiling long before any single task is
// actually saturated - so bound it explicitly instead of inheriting the
// default. minPoolSize keeps a few connections warm so a freshly started
// task doesn't pay handshake latency on its first requests.
const DEFAULT_MONGO_MAX_POOL_SIZE = "15";
const DEFAULT_MONGO_MIN_POOL_SIZE = "2";

const appConfig = () => ({
  NODE_ENV,
  PORT,
  BASE_PATH,
  MONGO_URI: getEnv("MONGO_URI", ""),
  MONGO_MAX_POOL_SIZE: Number(
    getEnv("MONGO_MAX_POOL_SIZE", DEFAULT_MONGO_MAX_POOL_SIZE)
  ),
  MONGO_MIN_POOL_SIZE: Number(
    getEnv("MONGO_MIN_POOL_SIZE", DEFAULT_MONGO_MIN_POOL_SIZE)
  ),

  // The externally-reachable API base URL, shown as the "try it out" server
  // in /api/docs. Defaults to a local dev guess; set explicitly for any
  // hosted environment (behind the ALB/CloudFront, this is NOT the same as
  // the port Express binds to).
  API_PUBLIC_URL: getEnv(
    "API_PUBLIC_URL",
    `http://localhost:${PORT}${BASE_PATH}`
  ),

  // ============================================
  // JWT CONFIGURATION
  // ============================================
  JWT: {
    // Access Token: Short-lived, sent in Authorization header
    ACCESS_TOKEN_SECRET: getEnv("JWT_ACCESS_TOKEN_SECRET"),
    ACCESS_TOKEN_EXPIRES_IN: getEnv("JWT_ACCESS_TOKEN_EXPIRES_IN", "15m"),

    // Refresh Token: Long-lived, stored in httpOnly cookie
    REFRESH_TOKEN_SECRET: getEnv("JWT_REFRESH_TOKEN_SECRET"),
    REFRESH_TOKEN_EXPIRES_IN: getEnv("JWT_REFRESH_TOKEN_EXPIRES_IN", "7d"),
  },

  // Password reset token: short-lived, single-use, emailed as a link.
  PASSWORD_RESET_TOKEN_EXPIRES_IN: getEnv(
    "PASSWORD_RESET_TOKEN_EXPIRES_IN",
    "30m"
  ),

  // Email verification token: longer-lived than a password reset (lower
  // security stakes - verification is advisory only, never gates login).
  EMAIL_VERIFICATION_TOKEN_EXPIRES_IN: getEnv(
    "EMAIL_VERIFICATION_TOKEN_EXPIRES_IN",
    "24h"
  ),

  // ============================================
  // COOKIE CONFIGURATION
  // ============================================
  COOKIE: {
    REFRESH_TOKEN_NAME: "refresh_token",
    HTTP_ONLY: true,
    SECURE: NODE_ENV !== "development",
    SAME_SITE: "lax" as const,
    PATH: "/",
    // Genuinely optional: `getEnv`'s default mechanism treats an
    // explicit `undefined` default as "no default," which would make this
    // required. Read it directly instead so an unset COOKIE_DOMAIN falls
    // back to `undefined` (host-only cookie) rather than crashing at boot.
    DOMAIN: process.env.COOKIE_DOMAIN || undefined,
  },

  // Google OAuth
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET"),
  GOOGLE_CALLBACK_URL: getEnv("GOOGLE_CALLBACK_URL"),

  // Frontend
  // Must be a full origin (scheme + host + port), not a bare hostname - it's
  // compared against the browser's `Origin` header by the CORS middleware,
  // and a bare "localhost" never matches one. Defaults to the client/ Vite
  // dev server's origin.
  FRONTEND_ORIGIN: getEnv("FRONTEND_ORIGIN", "http://localhost:5173"),
  FRONTEND_GOOGLE_CALLBACK_URL: getEnv("FRONTEND_GOOGLE_CALLBACK_URL"),
  FRONTEND_PASSWORD_RESET_URL: getEnv(
    "FRONTEND_PASSWORD_RESET_URL",
    "http://localhost:5173/reset-password"
  ),
  FRONTEND_EMAIL_VERIFICATION_URL: getEnv(
    "FRONTEND_EMAIL_VERIFICATION_URL",
    "http://localhost:5173/verify-email"
  ),

  // ============================================
  // EMAIL (Resend) - genuinely optional. Left unset, sendPasswordResetEmail
  // logs the link instead of sending it, so local dev works without a
  // Resend account. Same `getEnv`-default-undefined caveat as COOKIE_DOMAIN
  // above applies here, hence the direct process.env read.
  // ============================================
  RESEND_API_KEY: process.env.RESEND_API_KEY || undefined,
  EMAIL_FROM: getEnv("EMAIL_FROM", "onboarding@resend.dev"),
});

export const config = appConfig();
