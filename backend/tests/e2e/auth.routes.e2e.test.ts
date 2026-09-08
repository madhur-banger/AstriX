/**
 * END-TO-END (E2E) TESTS: auth routes
 * ----------------------------------------
 * Real Express app, real routes, real DB (in-memory), real rate limiter.
 * The ONLY thing mocked is `exchangeGoogleCodeForProfile` - a genuine
 * outbound network call to Google that we can't and shouldn't make in tests.
 *
 * RATE LIMITER CALLOUT:
 * `authLimiter` (on /register and /login) is configured with
 * `skipSuccessfulRequests: true`, which means only FAILED attempts count
 * toward the 5-per-15-minutes cap. Our happy-path tests succeed, so they
 * don't consume the limit. But the "wrong password" test below IS a failed
 * attempt and DOES count - if you add many more failing-login tests to this
 * file, you can trip the real limiter within a single test run. If that
 * happens, either bump `max` in a NODE_ENV==='test' branch in your real
 * route file, or isolate failing-auth-attempt tests into their own file so
 * they don't stack up against the same limiter instance across tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import authRoutes from "../../src/routes/auth.route";
import * as googleProvider from "../../src/providers/google.provider";
import UserModel from "../../src/models/user.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles } from "../../src/enums/role.enum";

vi.mock("../../src/providers/google.provider", async (importOriginal) => {
  // Partial mock: keep generateGoogleOAuthState/getGoogleAuthorizationUrl
  // real (they're pure, no network), only replace the network-calling one.
  const actual = await importOriginal<typeof googleProvider>();
  return {
    ...actual,
    exchangeGoogleCodeForProfile: vi.fn(),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);

  // Minimal error handler - replace with your real one if you want the
  // exact production error JSON shape asserted here too.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ message: err.message || "Internal error" });
  });

  return app;
}

describe("Auth routes (E2E via supertest + in-memory DB)", () => {
  let app: express.Express;

  beforeEach(async () => {
    await RoleModel.create({ name: Roles.OWNER, permissions: [] });
    app = buildApp();
    vi.clearAllMocks();
  });

  it("POST /api/auth/register -> 201 and creates a real, queryable user", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "e2e-register@example.com",
      name: "E2E Register",
      password: "Hunter@22",
    });

    console.log("REGISTER RESPONSE:", res.status, res.body);


    expect(res.status).toBe(201);
    expect(res.body.userId).toBeDefined();

    const persisted = await UserModel.findById(res.body.userId);
    expect(persisted).not.toBeNull();
    expect(persisted!.email).toBe("e2e-register@example.com");
  });

  it("POST /api/auth/register -> 400-level for a duplicate email", async () => {
    await request(app).post("/api/auth/register").send({
      email: "dup@example.com",
      name: "First",
      password: "pw123456",
    });

    const res = await request(app).post("/api/auth/register").send({
      email: "dup@example.com",
      name: "Second",
      password: "pw123456",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("full flow: register -> login -> access a protected route -> refresh -> logout", async () => {
    // 1. Register
    await request(app).post("/api/auth/register").send({
      email: "e2e-flow@example.com",
      name: "Flow User",
      password: "Correct@123",
    });

    // 2. Login
    const loginRes = await request(app).post("/api/auth/login").send({
      email: "e2e-flow@example.com",
      password: "Correct@123",
    });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.access_token).toBeDefined();
    // supertest exposes Set-Cookie headers - grab the refresh token cookie
    // to send back on the /refresh and /logout requests below.
    const setCookieHeader = loginRes.headers["set-cookie"];
    expect(setCookieHeader).toBeDefined();

    const accessToken = loginRes.body.access_token;

    // 3. Access a PROTECTED route (requires the `authenticate` middleware)
    //    using the real access token from login - proves the whole chain
    //    (login -> token -> authenticate middleware -> protected route) works.
    const sessionsRes = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(sessionsRes.status).toBe(200);
    expect(Array.isArray(sessionsRes.body.sessions)).toBe(true);
    expect(sessionsRes.body.sessions.length).toBeGreaterThanOrEqual(1);

    // 4. Refresh using the cookie captured from login
    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", setCookieHeader);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.access_token).toBeDefined();

    // 5. Logout
    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", setCookieHeader);
    expect(logoutRes.status).toBe(200);
  });

  it("GET /api/auth/sessions -> 401 with no Authorization header (protected route rejects unauthenticated access)", async () => {
    const res = await request(app).get("/api/auth/sessions");
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/sessions -> 401 with a garbage bearer token", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", "Bearer complete-nonsense");
    expect(res.status).toBe(401);
  });

  it("LOGIN with wrong password -> 401-ish and does NOT set a refresh cookie", async () => {
    await request(app).post("/api/auth/register").send({
      email: "e2e-wrongpass@example.com",
      name: "Wrong Pass",
      password: "the-real-one",
    });

    const res = await request(app).post("/api/auth/login").send({
      email: "e2e-wrongpass@example.com",
      password: "a-guess",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("GET /api/auth/google -> redirects to Google's OAuth URL and sets a state cookie", async () => {
    const res = await request(app).get("/api/auth/google");

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("accounts.google.com");
    expect(res.headers["set-cookie"]?.[0]).toContain("google_oauth_state");
  });

  it("GET /api/auth/google/callback -> full mocked OAuth flow redirects to the frontend with the new user's workspace", async () => {
    // First hit /google to get a real, valid state cookie the callback will check against.
    const googleStartRes = await request(app).get("/api/auth/google");
    const stateCookie = googleStartRes.headers["set-cookie"][0] as string;
    const stateValue = /google_oauth_state=([^;]+)/.exec(stateCookie)?.[1];

    vi.mocked(googleProvider.exchangeGoogleCodeForProfile).mockResolvedValue({
      provider: "GOOGLE",
      providerId: "e2e-google-sub",
      email: "e2e-oauth@example.com",
      name: "E2E OAuth User",
    });

    const callbackRes = await request(app)
      .get("/api/auth/google/callback")
      .set("Cookie", stateCookie)
      .query({ code: "fake-code-from-google", state: stateValue });


    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("/workspace/");

    // Confirm a real user was actually created via the mocked callback.
    const createdUser = await UserModel.findOne({ email: "e2e-oauth@example.com" });
    expect(createdUser).not.toBeNull();
  });

  it("GET /api/auth/google/callback -> 400-ish when code/state query params are missing", async () => {
    const res = await request(app).get("/api/auth/google/callback");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
