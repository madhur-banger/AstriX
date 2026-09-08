/**
 * TEST ENVIRONMENT VARIABLES
 * ----------------------------
 * WHY THIS FILE EXISTS:
 * `src/config/app.config.ts` almost certainly reads required environment
 * variables at import time (via `src/utils/get-env.ts`) and likely THROWS
 * if they're missing - that's the whole point of a strict env-var loader
 * (fail fast instead of silently running with `undefined` secrets).
 *
 * The moment ANY test file imports something that transitively imports
 * `app.config.ts` - which `jwt.ts`, `auth.service.ts`, and `auth.controller.ts`
 * all do - that import will crash unless the right env vars already exist
 * in `process.env`.
 *
 * So this file sets safe, fake, deterministic values for every env var your
 * config appears to need, and it's registered FIRST in vitest.config.ts's
 * `setupFiles` array (order matters - it must run before test files import
 * anything that reads `process.env`).
 *
 * IMPORTANT - VERIFY THESE VARIABLE NAMES:
 * I don't have your `src/utils/get-env.ts` or `src/config/app.config.ts`
 * source, so the exact `process.env.XXX` names below are a best guess based
 * on what fields `config.JWT.*`, `config.COOKIE.*`, etc. are used for in
 * `jwt.ts` and `auth.controller.ts`. If a test fails with something like
 * "Missing required environment variable: FOO", add `process.env.FOO = "..."`
 * below with a harmless fake value.
 */

// --- JWT ---
process.env.JWT_ACCESS_TOKEN_SECRET = "test-access-token-secret";
process.env.JWT_REFRESH_TOKEN_SECRET = "test-refresh-token-secret";
process.env.JWT_ACCESS_TOKEN_EXPIRES_IN = "15m";
process.env.JWT_REFRESH_TOKEN_EXPIRES_IN = "7d";

// --- Cookies ---
process.env.COOKIE_REFRESH_TOKEN_NAME = "refreshToken";
process.env.COOKIE_DOMAIN = "localhost";

// --- Google OAuth (fake values - no real network calls happen in tests
// because exchangeGoogleCodeForProfile is mocked wherever it's used) ---
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_CALLBACK_URL = "http://localhost:3000/api/auth/google/callback";
process.env.FRONTEND_GOOGLE_CALLBACK_URL = "http://localhost:3000/api/auth/google/callback";

// --- General ---
process.env.NODE_ENV = "test";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.PORT = "3000";

// If your real config also requires a MONGO_URI or DATABASE_URL at import
// time (separate from the in-memory server we connect to in
// vitest.setup.ts), set a harmless placeholder here too - the app config
// reading it doesn't mean your tests actually connect using it:
// process.env.MONGO_URI = "mongodb://localhost:27017/placeholder";
