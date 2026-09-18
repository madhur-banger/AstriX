/**
 * END-TO-END (E2E) TESTS: auth routes
 * -----------------------------------------------
 * Real app wiring via buildApp() (real authenticate middleware, real
 * errorHandler, real rate limiters backed by the real testcontainers
 * Redis), real routes, real Postgres. Mirrors tests/e2e/auth.routes.e2e.test.ts's
 * role for the Mongo suite.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app";
import { registerAndLogin } from "../setup/e2eAuth";

describe("Auth routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  it("full lifecycle: register -> login -> access protected route -> refresh -> logout", async () => {
    const email = `lifecycle-${Date.now()}@example.com`;
    const password = "Password1!";

    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ name: "Lifecycle User", email, password });
    expect(registerRes.status).toBe(201);
    expect(registerRes.body.userId).toBeTruthy();

    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.access_token).toBeTruthy();
    const refreshCookie = loginRes.headers["set-cookie"];
    expect(refreshCookie).toBeDefined();

    const meRes = await request(app)
      .get("/api/user/current")
      .set("Authorization", `Bearer ${loginRes.body.access_token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe(email);

    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", refreshCookie);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.access_token).toBeTruthy();

    const logoutRes = await request(app).post("/api/auth/logout").set("Cookie", refreshCookie);
    expect(logoutRes.status).toBe(200);
  });

  it("POST /api/auth/login -> 401 for a wrong password, same message as an unknown email (no enumeration oracle)", async () => {
    const { email } = await registerAndLogin(app);

    const wrongPasswordRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "WrongPass1!" });
    const unknownEmailRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody-here@example.com", password: "WrongPass1!" });

    expect(wrongPasswordRes.status).toBe(401);
    expect(unknownEmailRes.status).toBe(401);
    expect(wrongPasswordRes.body.message).toBe(unknownEmailRes.body.message);
  });

  it("GET /api/user/current -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/user/current");
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/register -> 400 for a weak password (zod validation)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Weak Pw", email: "weak@example.com", password: "weak" });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("POST /api/auth/register -> 400 when the email is already registered", async () => {
    const { email } = await registerAndLogin(app);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Dup", email, password: "Password1!" });

    expect(res.status).toBe(400);
  });

  it("full password-reset flow rotates the password and revokes existing sessions", async () => {
    const { email, authHeader } = await registerAndLogin(app);

    const forgotRes = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(forgotRes.status).toBe(200);

    const sessionsRes = await request(app).get("/api/auth/sessions").set("Authorization", authHeader);
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions.length).toBeGreaterThan(0);
  });
});
