import { getEnv } from "../utils/get-env";

type NodeEnv = "development" | "production" | "test";

const NODE_ENV = getEnv<NodeEnv>("NODE_ENV", "development");

const appConfig = () => ({
  NODE_ENV: getEnv("NODE_ENV", "development"),
  PORT: getEnv("PORT", "8000"),
  BASE_PATH: getEnv("BASE_PATH", "/api"),
  MONGO_URI: getEnv("MONGO_URI", ""),

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

  // ============================================
  // COOKIE CONFIGURATION
  // ============================================
  COOKIE: {
    REFRESH_TOKEN_NAME: "refresh_token",
    HTTP_ONLY: true,
    SECURE: NODE_ENV === "development",
    SAME_SITE: "lax" as const,
    PATH: "/",
    DOMAIN: getEnv("COOKIE_DOMAIN", undefined),
  },

  // Google OAuth
  GOOGLE_CLIENT_ID: getEnv("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: getEnv("GOOGLE_CLIENT_SECRET"),
  GOOGLE_CALLBACK_URL: getEnv("GOOGLE_CALLBACK_URL"),

  // Frontend
  FRONTEND_ORIGIN: getEnv("FRONTEND_ORIGIN", "localhost"),
  FRONTEND_GOOGLE_CALLBACK_URL: getEnv("FRONTEND_GOOGLE_CALLBACK_URL"),
});

export const config = appConfig();