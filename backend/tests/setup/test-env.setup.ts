/**
 * Non-container env vars needed at import time by src/config/app.config.ts.
 * DATABASE_URL and REDIS_URL are already in process.env by the time this
 * runs - global-setup.ts (vitest.pg.config.ts's `globalSetup`) sets them
 * before any test file (and thus this setupFile) is loaded.
 */

process.env.NODE_ENV = "test";
process.env.PORT = "8001";
process.env.BASE_PATH = "/api";

process.env.JWT_ACCESS_TOKEN_SECRET = "test-pg-access-token-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = "test-pg-refresh-token-secret";
process.env.JWT_ACCESS_TOKEN_EXPIRES_IN = "15m";
process.env.JWT_REFRESH_TOKEN_EXPIRES_IN = "7d";

process.env.PASSWORD_RESET_TOKEN_EXPIRES_IN = "30m";
process.env.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN = "24h";

process.env.COOKIE_DOMAIN = "";

process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_CALLBACK_URL = "http://localhost:8001/api/auth/google/callback";
process.env.FRONTEND_GOOGLE_CALLBACK_URL = "http://localhost:5173/oauth/callback";

process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.FRONTEND_PASSWORD_RESET_URL = "http://localhost:5173/reset-password";
process.env.FRONTEND_EMAIL_VERIFICATION_URL = "http://localhost:5173/verify-email";

// RESEND_API_KEY deliberately left unset: sendPasswordResetEmail /
// sendVerificationEmail then just log-and-return (see
// src/providers/email.provider.ts) instead of making a real network call.
