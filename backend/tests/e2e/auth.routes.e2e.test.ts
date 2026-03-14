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
import * as emailProvider from "../../src/providers/email.provider";
import UserModel from "../../src/models/user.model";
import RoleModel from "../../src/models/roles-permission.model";
import SessionModel from "../../src/models/session.model";
import PasswordResetTokenModel from "../../src/models/passwordResetToken.model";
import { Roles } from "../../src/enums/role.enum";
import { errorHandler } from "../../src/middlewares/errorHandles.middleware";
import { createAuthenticatedUser } from "../setup/e2eAuth";

vi.mock("../../src/providers/google.provider", async (importOriginal) => {
  // Partial mock: keep generateGoogleOAuthState/getGoogleAuthorizationUrl
  // real (they're pure, no network), only replace the network-calling one.
  const actual = await importOriginal<typeof googleProvider>();
  return {
    ...actual,
    exchangeGoogleCodeForProfile: vi.fn(),
  };
});

// Real outbound email. sendPasswordResetEmail already no-ops safely when
// RESEND_API_KEY is unset (it is, in test env - see testEnv.setup.ts), but
// we mock it anyway so tests can capture the reset URL/token it was called
// with - that's the only place the raw (unhashed) token ever exists.
vi.mock("../../src/providers/email.provider");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);

  // Real production error handler, so the exact error JSON shape (including
  // ZodError field-level formatting and AppError errorCode) is asserted here.
  app.use(errorHandler);

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
    // Regression check for the inverted COOKIE.SECURE bug: NODE_ENV is "test"
    // here (not "development"), so the refresh-token cookie must be Secure.
    expect(setCookieHeader.join(";")).toMatch(/refresh_token=.*Secure/i);

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
      emailVerified: true,
    });

    const callbackRes = await request(app)
      .get("/api/auth/google/callback")
      .set("Cookie", stateCookie)
      .query({ code: "fake-code-from-google", state: stateValue });

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("/workspace/");

    // Confirm a real user was actually created via the mocked callback.
    const createdUser = await UserModel.findOne({
      email: "e2e-oauth@example.com",
    });
    expect(createdUser).not.toBeNull();
  });

  it("GET /api/auth/google/callback -> 400-ish when code/state query params are missing", async () => {
    const res = await request(app).get("/api/auth/google/callback");
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // RATE LIMITER CALLOUT (same concern as the authLimiter note above):
  // `passwordResetLimiter` (max 5 / 15min) is shared across BOTH
  // /forgot-password and /reset-password, and its in-memory count persists
  // for the lifetime of this test FILE (the limiter is created once at
  // auth.route.ts module load, not per-test). The three tests below make
  // exactly 5 combined requests to these two routes - if you add another
  // test that hits either route, either trim an existing call or isolate
  // it into its own file.
  describe("password reset", () => {
    it("POST /api/auth/forgot-password -> 200 with the identical message whether or not the email has an account", async () => {
      await UserModel.create({
        email: "e2e-forgot@example.com",
        name: "Forgot Password User",
        password: "Correct@123",
      });

      const knownRes = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "e2e-forgot@example.com" });
      const unknownRes = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "no-such-account@example.com" });

      expect(knownRes.status).toBe(200);
      expect(unknownRes.status).toBe(200);
      expect(knownRes.body.message).toBe(unknownRes.body.message);

      // Only the REAL account should have actually gotten a token issued.
      expect(emailProvider.sendPasswordResetEmail).toHaveBeenCalledOnce();
    });

    it("full flow: forgot-password -> reset-password -> old password rejected, new one works, other sessions revoked", async () => {
      // Register through the real endpoint (not UserModel.create directly) -
      // login goes through AccountModel (provider EMAIL), which only
      // registerUserService sets up correctly. This call succeeds, so it's
      // exempt from authLimiter's skipSuccessfulRequests budget.
      const registerRes = await request(app).post("/api/auth/register").send({
        email: "e2e-reset-flow@example.com",
        name: "Reset Flow User",
        password: "OldPassword@123",
      });
      const userId = registerRes.body.userId;

      // A session that should get invalidated once the password is reset.
      const preResetSession = await SessionModel.create({
        userId,
        isValid: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const forgotRes = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "e2e-reset-flow@example.com" });
      expect(forgotRes.status).toBe(200);

      const [, resetUrl] = vi.mocked(emailProvider.sendPasswordResetEmail).mock
        .calls[0];
      const token = new URL(resetUrl).searchParams.get("token");
      expect(token).toBeTruthy();

      const resetRes = await request(app)
        .post("/api/auth/reset-password")
        .send({
          token,
          password: "NewPassword@123",
          confirmPassword: "NewPassword@123",
        });
      expect(resetRes.status).toBe(200);

      // Old password no longer works. Checked directly against the model
      // rather than via POST /login - authLimiter (shared across this whole
      // file, see the RATE LIMITER CALLOUT above) only allows 5 FAILED
      // login/register attempts per run, and several unrelated setup calls
      // earlier in this file already consume most of that budget.
      const userAfterReset = await UserModel.findById(userId);
      expect(await userAfterReset!.comparePassword("OldPassword@123")).toBe(
        false
      );

      // The token is single-use - the DB record backing it is gone.
      const remainingTokens = await PasswordResetTokenModel.find({
        userId: userId,
      });
      expect(remainingTokens).toHaveLength(0);

      // The pre-reset session was revoked (password reset invalidates all
      // sessions, matching "logout everywhere" semantics elsewhere). Check
      // BEFORE logging in again below - a fresh login creates its own new
      // valid session, which would otherwise mask this.
      const sessionAfterReset = await SessionModel.findById(
        preResetSession._id
      );
      expect(sessionAfterReset!.isValid).toBe(false);

      // New password works (this call succeeds, so it's exempt from
      // authLimiter's skipSuccessfulRequests budget).
      const newLoginRes = await request(app).post("/api/auth/login").send({
        email: "e2e-reset-flow@example.com",
        password: "NewPassword@123",
      });
      expect(newLoginRes.status).toBe(200);
    });

    it("POST /api/auth/reset-password -> 401 for a garbage/unknown token", async () => {
      const res = await request(app).post("/api/auth/reset-password").send({
        token: "not-a-real-token",
        password: "SomePassword@123",
        confirmPassword: "SomePassword@123",
      });

      expect(res.status).toBe(401);
    });
  });

  // RATE LIMITER CALLOUT: emailVerificationLimiter (max 5/15min) is shared
  // across BOTH /verify-email and /resend-verification, same persist-for-
  // the-whole-file caveat as passwordResetLimiter above. The four tests
  // below make exactly 5 combined requests to these two routes.
  describe("email verification (advisory only - never blocks login)", () => {
    it("full flow: register -> verify-email using the emailed token -> isEmailVerified becomes true", async () => {
      const registerRes = await request(app).post("/api/auth/register").send({
        email: "e2e-verify-flow@example.com",
        name: "Verify Flow User",
        password: "Correct@123",
      });
      const userId = registerRes.body.userId;

      const userBeforeVerify = await UserModel.findById(userId);
      expect(userBeforeVerify!.isEmailVerified).toBe(false);

      // Registration itself issues the verification email (best-effort,
      // post-commit) - capture the token from that call.
      const [, verifyUrl] = vi.mocked(emailProvider.sendVerificationEmail).mock
        .calls[0];
      const token = new URL(verifyUrl).searchParams.get("token");
      expect(token).toBeTruthy();

      const verifyRes = await request(app)
        .post("/api/auth/verify-email")
        .send({ token });
      expect(verifyRes.status).toBe(200);

      const userAfterVerify = await UserModel.findById(userId);
      expect(userAfterVerify!.isEmailVerified).toBe(true);
    });

    it("POST /api/auth/verify-email -> 401 for a garbage/unknown token", async () => {
      const res = await request(app)
        .post("/api/auth/verify-email")
        .send({ token: "not-a-real-token" });

      expect(res.status).toBe(401);
    });

    it("POST /api/auth/resend-verification -> 200 and the new token actually verifies the account", async () => {
      const { authHeader, user } = await createAuthenticatedUser();

      const resendRes = await request(app)
        .post("/api/auth/resend-verification")
        .set("Authorization", authHeader);
      expect(resendRes.status).toBe(200);

      const [, verifyUrl] = vi.mocked(emailProvider.sendVerificationEmail).mock
        .calls[0];
      const token = new URL(verifyUrl).searchParams.get("token");

      const verifyRes = await request(app)
        .post("/api/auth/verify-email")
        .send({ token });
      expect(verifyRes.status).toBe(200);

      const userAfterVerify = await UserModel.findById(user._id);
      expect(userAfterVerify!.isEmailVerified).toBe(true);
    });

    it("POST /api/auth/resend-verification -> 400 when the email is already verified", async () => {
      const { authHeader, user } = await createAuthenticatedUser();
      await UserModel.findByIdAndUpdate(user._id, { isEmailVerified: true });

      const res = await request(app)
        .post("/api/auth/resend-verification")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
    });
  });

  describe("change password (authenticated)", () => {
    it("full flow: change-password -> old password rejected, new password works, OTHER sessions revoked but the current one survives", async () => {
      const registerRes = await request(app).post("/api/auth/register").send({
        email: "e2e-change-pw@example.com",
        name: "Change Password User",
        password: "OldPassword@123",
      });
      const userId = registerRes.body.userId;

      const loginRes = await request(app).post("/api/auth/login").send({
        email: "e2e-change-pw@example.com",
        password: "OldPassword@123",
      });
      const accessToken = loginRes.body.access_token;

      // A second, unrelated session for the same user - should get
      // revoked as a side effect of the password change below.
      const otherSession = await SessionModel.create({
        userId,
        isValid: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const changeRes = await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          currentPassword: "OldPassword@123",
          newPassword: "NewPassword@456",
          confirmNewPassword: "NewPassword@456",
        });
      expect(changeRes.status).toBe(200);

      // Old password no longer works (checked directly against the model -
      // see the password-reset flow test above for why: authLimiter's
      // shared failed-attempt budget for this file is nearly exhausted).
      const userAfterChange = await UserModel.findById(userId);
      expect(await userAfterChange!.comparePassword("OldPassword@123")).toBe(
        false
      );

      // The OTHER session was revoked...
      const otherSessionAfter = await SessionModel.findById(otherSession._id);
      expect(otherSessionAfter!.isValid).toBe(false);

      // ...but the CURRENT session (the one that made this request) survives.
      const currentSessionStatus = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(currentSessionStatus.status).toBe(200);

      // New password works (this call succeeds, so it's exempt from
      // authLimiter's skipSuccessfulRequests budget).
      const newLoginRes = await request(app).post("/api/auth/login").send({
        email: "e2e-change-pw@example.com",
        password: "NewPassword@456",
      });
      expect(newLoginRes.status).toBe(200);
    });

    it("POST /api/auth/change-password -> 401 when currentPassword is wrong", async () => {
      await request(app).post("/api/auth/register").send({
        email: "e2e-change-pw-wrong@example.com",
        name: "Wrong Current Password User",
        password: "ActualPassword@123",
      });
      const loginRes = await request(app).post("/api/auth/login").send({
        email: "e2e-change-pw-wrong@example.com",
        password: "ActualPassword@123",
      });
      const accessToken = loginRes.body.access_token;

      const res = await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          currentPassword: "TotallyWrong@1",
          newPassword: "NewPassword@456",
          confirmNewPassword: "NewPassword@456",
        });

      expect(res.status).toBe(401);
    });
  });

  describe("session revocation (single device)", () => {
    it("DELETE /api/auth/sessions/:id -> 200 and revokes only that session", async () => {
      const { authHeader, user } = await createAuthenticatedUser();
      const otherSession = await SessionModel.create({
        userId: user._id,
        isValid: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const res = await request(app)
        .delete(`/api/auth/sessions/${otherSession._id}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);

      const revoked = await SessionModel.findById(otherSession._id);
      expect(revoked!.isValid).toBe(false);
    });

    it("DELETE /api/auth/sessions/:id -> 404 when the session belongs to someone else", async () => {
      const owner = await createAuthenticatedUser();
      const attacker = await createAuthenticatedUser();

      const res = await request(app)
        .delete(`/api/auth/sessions/${owner.session._id}`)
        .set("Authorization", attacker.authHeader);

      expect(res.status).toBe(404);

      const stillValid = await SessionModel.findById(owner.session._id);
      expect(stillValid!.isValid).toBe(true);
    });

    it("DELETE /api/auth/sessions/:id -> 404 for an unknown session id", async () => {
      const { authHeader } = await createAuthenticatedUser();
      const fakeId = "64f1a2b3c4d5e6f7a8b9c0d1";

      const res = await request(app)
        .delete(`/api/auth/sessions/${fakeId}`)
        .set("Authorization", authHeader);

      expect(res.status).toBe(404);
    });
  });
});
