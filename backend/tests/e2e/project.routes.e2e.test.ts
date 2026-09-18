/**
 * END-TO-END (E2E) TESTS: project routes
 * ----------------------------------------------------
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

describe("Project routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  const addMember = async (workspaceId: string, userId: string, role: "ADMIN" | "MEMBER" = "MEMBER") => {
    const roleId = await getRoleIdByName(role);
    await db.insert(workspaceMembers).values({ userId, workspaceId, roleId });
  };

  it("full lifecycle: create -> get -> update -> delete", async () => {
    const owner = await registerAndLogin(app);

    const createRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "E2E Project", emoji: "🚀" });
    expect(createRes.status).toBe(201);
    const projectId = createRes.body.project.id;

    const getRes = await request(app)
      .get(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.project.emoji).toBe("🚀");

    const updateRes = await request(app)
      .put(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}/update`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Renamed Project" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.project.name).toBe("Renamed Project");

    const deleteRes = await request(app)
      .delete(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}/delete`)
      .set("Authorization", owner.authHeader);
    expect(deleteRes.status).toBe(200);

    const getAfterDeleteRes = await request(app)
      .get(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/project/workspace/:workspaceId/all -> 401 with no Authorization header", async () => {
    const res = await request(app).get(`/api/project/workspace/some-ws/all`);
    expect(res.status).toBe(401);
  });

  it("GET /api/project/workspace/:workspaceId/all -> pagination reflects real seeded rows", async () => {
    const owner = await registerAndLogin(app);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
        .set("Authorization", owner.authHeader)
        .send({ name: `Project ${i}` });
    }

    const res = await request(app)
      .get(`/api/project/workspace/${owner.currentWorkspaceId}/all?pageSize=2&pageNumber=1`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(2);
    expect(res.body.pagination.totalCount).toBe(3);
    expect(res.body.pagination.totalPages).toBe(2);
  });

  it("DELETE .../delete -> 403 when the member lacks DELETE_PROJECT permission", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");

    const createRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Protected Project" });
    const projectId = createRes.body.project.id;

    const res = await request(app)
      .delete(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}/delete`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(403);
  });

  it("GET /api/project/:id/workspace/:workspaceId -> 404 for a project in the wrong workspace", async () => {
    const owner = await registerAndLogin(app);
    const otherOwner = await registerAndLogin(app);

    const createRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Scoped Project" });
    const projectId = createRes.body.project.id;

    const res = await request(app)
      .get(`/api/project/${projectId}/workspace/${otherOwner.currentWorkspaceId}`)
      .set("Authorization", otherOwner.authHeader);

    expect(res.status).toBe(404);
  });

  it("GET /api/project/:id/workspace/:workspaceId/analytics -> counts match hand-seeded tasks", async () => {
    const owner = await registerAndLogin(app);
    const createRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Analytics Project" });
    const projectId = createRes.body.project.id;

    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Overdue", priority: "HIGH", status: "TODO", dueDate: "2000-01-01T00:00:00.000Z" });
    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Done", priority: "LOW", status: "DONE" });
    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Future", priority: "LOW", status: "TODO", dueDate: "2999-01-01T00:00:00.000Z" });

    const res = await request(app)
      .get(`/api/project/${projectId}/workspace/${owner.currentWorkspaceId}/analytics`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.analytics).toEqual({ totalTasks: 3, overdueTasks: 1, completedTasks: 1 });
  });

  it("POST .../create -> 400 for a missing required name", async () => {
    const owner = await registerAndLogin(app);

    const res = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ description: "no name given" });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });
});
