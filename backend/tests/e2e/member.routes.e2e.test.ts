/**
 * END-TO-END (E2E) TESTS: member routes
 * ---------------------------------------------------
 * Real app wiring via buildApp(), real routes, real Postgres/Redis. See
 * tests/e2e/auth.routes.e2e.test.ts for the pattern this follows.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app";
import { registerAndLogin } from "../setup/e2eAuth";

describe("Member routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  it("POST /api/member/workspace/:inviteCode/join -> joins as MEMBER", async () => {
    const owner = await registerAndLogin(app);
    const joiner = await registerAndLogin(app);

    const workspaceRes = await request(app)
      .get(`/api/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    const inviteCode = workspaceRes.body.workspace.inviteCode;

    const joinRes = await request(app)
      .post(`/api/member/workspace/${inviteCode}/join`)
      .set("Authorization", joiner.authHeader);

    expect(joinRes.status).toBe(200);
    expect(joinRes.body.workspaceId).toBe(owner.currentWorkspaceId);
    expect(joinRes.body.role).toBe("MEMBER");

    const membersRes = await request(app)
      .get(`/api/workspace/members/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    const ids = membersRes.body.members.map((m: { user: { id: string } }) => m.user.id);
    expect(ids).toContain(joiner.userId);
  });

  it("POST /api/member/workspace/:inviteCode/join -> 404 for an invalid invite code", async () => {
    const joiner = await registerAndLogin(app);

    const res = await request(app)
      .post(`/api/member/workspace/not-a-real-code/join`)
      .set("Authorization", joiner.authHeader);

    expect(res.status).toBe(404);
  });

  it("POST /api/member/workspace/:inviteCode/join -> 400 when already a member", async () => {
    const owner = await registerAndLogin(app);
    const joiner = await registerAndLogin(app);

    const workspaceRes = await request(app)
      .get(`/api/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    const inviteCode = workspaceRes.body.workspace.inviteCode;

    await request(app).post(`/api/member/workspace/${inviteCode}/join`).set("Authorization", joiner.authHeader);
    const res = await request(app)
      .post(`/api/member/workspace/${inviteCode}/join`)
      .set("Authorization", joiner.authHeader);

    expect(res.status).toBe(400);
  });

  it("POST /api/member/workspace/:inviteCode/join -> 401 with no Authorization header", async () => {
    const res = await request(app).post(`/api/member/workspace/any-code/join`);
    expect(res.status).toBe(401);
  });
});
