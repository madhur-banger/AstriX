/**
 * END-TO-END (E2E) TESTS: workspace routes
 * ------------------------------------------------------
 * Real app wiring via buildApp(), real routes, real Postgres/Redis. See
 * tests/e2e/auth.routes.e2e.test.ts for the pattern this follows.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../../src/app";
import { registerAndLogin } from "../setup/e2eAuth";
import { db } from "../../src/db/client";
import { workspaceMembers } from "../../src/db/schema";
import { getRoleIdByName } from "../setup/fixtures";

describe("Workspace routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  const addMember = async (workspaceId: string, userId: string, role: "ADMIN" | "MEMBER" = "MEMBER") => {
    const roleId = await getRoleIdByName(role);
    await db.insert(workspaceMembers).values({ userId, workspaceId, roleId });
  };

  it("full lifecycle: create -> get -> update -> delete", async () => {
    const owner = await registerAndLogin(app);

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "E2E Workspace", description: "desc" });
    expect(createRes.status).toBe(201);
    const workspaceId = createRes.body.workspace.id;

    const getRes = await request(app)
      .get(`/api/workspace/${workspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.workspace.id).toBe(workspaceId);
    expect(getRes.body.workspace.members.length).toBeGreaterThan(0);

    const updateRes = await request(app)
      .put(`/api/workspace/update/${workspaceId}`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Renamed Workspace" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.workspace.name).toBe("Renamed Workspace");

    const deleteRes = await request(app)
      .delete(`/api/workspace/delete/${workspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(deleteRes.status).toBe(200);

    const getAfterDeleteRes = await request(app)
      .get(`/api/workspace/${workspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/workspace/all -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/workspace/all");
    expect(res.status).toBe(401);
  });

  it("GET /api/workspace/all -> only lists workspaces the caller is a member of", async () => {
    const owner = await registerAndLogin(app);
    const other = await registerAndLogin(app);

    const res = await request(app).get("/api/workspace/all").set("Authorization", owner.authHeader);
    expect(res.status).toBe(200);
    const ids = res.body.workspaces.map((w: { id: string }) => w.id);
    expect(ids).toContain(owner.currentWorkspaceId);
    expect(ids).not.toContain(other.currentWorkspaceId);
  });

  it("DELETE /api/workspace/delete/:id -> 403 when the caller isn't the owner", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");

    const res = await request(app)
      .delete(`/api/workspace/delete/${owner.currentWorkspaceId}`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(403);
  });

  it("PUT /api/workspace/update/:id -> 403 for a MEMBER role (lacks EDIT_WORKSPACE)", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");

    const res = await request(app)
      .put(`/api/workspace/update/${owner.currentWorkspaceId}`)
      .set("Authorization", member.authHeader)
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
  });

  it("GET /api/workspace/:id -> 401 UnauthorizedException when the caller is not a member at all", async () => {
    const owner = await registerAndLogin(app);
    const outsider = await registerAndLogin(app);

    const res = await request(app)
      .get(`/api/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", outsider.authHeader);

    expect(res.status).toBe(401);
  });

  it("DELETE /api/workspace/:id/member/:userId -> 400 when trying to remove the owner", async () => {
    const owner = await registerAndLogin(app);

    const res = await request(app)
      .delete(`/api/workspace/${owner.currentWorkspaceId}/member/${owner.userId}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(400);
  });

  it("POST /api/workspace/:id/leave -> lets a member remove themselves", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");

    const res = await request(app)
      .post(`/api/workspace/${owner.currentWorkspaceId}/leave`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", member.authHeader);
    expect(getRes.status).toBe(401);
  });

  it("POST /api/workspace/:id/invite/reset -> rotates the invite code", async () => {
    const owner = await registerAndLogin(app);

    const before = await request(app)
      .get(`/api/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);

    const res = await request(app)
      .post(`/api/workspace/${owner.currentWorkspaceId}/invite/reset`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.workspace.inviteCode).not.toBe(before.body.workspace.inviteCode);
  });

  it("GET /api/workspace/members/:id -> lists members with role populated", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");

    const res = await request(app)
      .get(`/api/workspace/members/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
    const memberRow = res.body.members.find((m: { user: { id: string } }) => m.user.id === member.userId);
    expect(memberRow.role.name).toBe("MEMBER");
  });

  it("GET /api/workspace/analytics/:id -> totalTasks/overdueTasks/completedTasks reflect real seeded tasks", async () => {
    const owner = await registerAndLogin(app);

    const projectRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Analytics Project" });
    const projectId = projectRes.body.project.id;

    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Overdue", priority: "HIGH", status: "TODO", dueDate: "2000-01-01T00:00:00.000Z" });

    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Done", priority: "LOW", status: "DONE" });

    const res = await request(app)
      .get(`/api/workspace/analytics/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.analytics).toEqual({ totalTasks: 2, overdueTasks: 1, completedTasks: 1 });
  });

  it("PUT /api/workspace/change/member/role/:id -> 400 when targeting the owner's role", async () => {
    const owner = await registerAndLogin(app);
    const adminRoleId = await getRoleIdByName("ADMIN");

    const res = await request(app)
      .put(`/api/workspace/change/member/role/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader)
      .send({ memberId: owner.userId, roleId: adminRoleId });

    expect(res.status).toBe(400);
  });
});
