/**
 * END-TO-END (E2E) TESTS: user routes
 * -------------------------------------------------
 * Real app wiring via buildApp(), real routes, real Postgres/Redis. See
 * tests/e2e/auth.routes.e2e.test.ts for the pattern this follows.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app";
import { registerAndLogin } from "../setup/e2eAuth";

describe("User routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  it("GET /api/user/current -> returns the authenticated user, excluding passwordHash", async () => {
    const user = await registerAndLogin(app);

    const res = await request(app).get("/api/user/current").set("Authorization", user.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user).not.toHaveProperty("passwordHash");
  });

  it("GET /api/user/current -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/user/current");
    expect(res.status).toBe(401);
  });

  it("PATCH /api/user/current -> partial update leaves other fields untouched", async () => {
    const user = await registerAndLogin(app);

    const res = await request(app)
      .patch("/api/user/current")
      .set("Authorization", user.authHeader)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Updated Name");
    expect(res.body.user.email).toBe(user.email);
  });

  it("PATCH /api/user/current -> 400 for an empty body (at-least-one-field refine)", async () => {
    const user = await registerAndLogin(app);

    const res = await request(app).patch("/api/user/current").set("Authorization", user.authHeader).send({});

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("DELETE /api/user/current -> 400 while the user still owns a workspace", async () => {
    const user = await registerAndLogin(app);

    const res = await request(app)
      .delete("/api/user/current")
      .set("Authorization", user.authHeader)
      .send({ password: user.password });

    expect(res.status).toBe(400);
  });

  it("DELETE /api/user/current -> 401 for the wrong password", async () => {
    const user = await registerAndLogin(app);
    await request(app)
      .delete(`/api/workspace/delete/${user.currentWorkspaceId}`)
      .set("Authorization", user.authHeader);

    const res = await request(app)
      .delete("/api/user/current")
      .set("Authorization", user.authHeader)
      .send({ password: "WrongPassword1!" });

    expect(res.status).toBe(401);
  });

  it("DELETE /api/user/current -> succeeds once the user no longer owns any workspace", async () => {
    const user = await registerAndLogin(app);
    await request(app)
      .delete(`/api/workspace/delete/${user.currentWorkspaceId}`)
      .set("Authorization", user.authHeader);

    const res = await request(app)
      .delete("/api/user/current")
      .set("Authorization", user.authHeader)
      .send({ password: user.password });

    expect(res.status).toBe(200);

    const afterRes = await request(app).get("/api/user/current").set("Authorization", user.authHeader);
    expect(afterRes.status).toBe(401);
  });
});
