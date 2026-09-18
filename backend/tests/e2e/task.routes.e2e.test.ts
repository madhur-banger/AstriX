/**
 * END-TO-END (E2E) TESTS: task routes
 * -------------------------------------------------
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

describe("Task routes (E2E via supertest + real Postgres/Redis)", () => {
  const app = buildApp();

  const addMember = async (workspaceId: string, userId: string, role: "ADMIN" | "MEMBER" = "MEMBER") => {
    const roleId = await getRoleIdByName(role);
    await db.insert(workspaceMembers).values({ userId, workspaceId, roleId });
  };

  const createProject = async (owner: Awaited<ReturnType<typeof registerAndLogin>>) => {
    const res = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Task E2E Project" });
    return res.body.project.id as string;
  };

  it("full lifecycle: create -> get -> update -> delete", async () => {
    const owner = await registerAndLogin(app);
    const projectId = await createProject(owner);

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "E2E Task", priority: "MEDIUM", status: "TODO" });
    expect(createRes.status).toBe(200);
    const taskId = createRes.body.task.id;

    const getRes = await request(app)
      .get(`/api/task/${taskId}/project/${projectId}/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.task.id).toBe(taskId);

    const updateRes = await request(app)
      .put(`/api/task/${taskId}/project/${projectId}/workspace/${owner.currentWorkspaceId}/update`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Renamed via E2E", priority: "HIGH", status: "DONE" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.task.title).toBe("Renamed via E2E");

    const deleteRes = await request(app)
      .delete(`/api/task/${taskId}/workspace/${owner.currentWorkspaceId}/delete`)
      .set("Authorization", owner.authHeader);
    expect(deleteRes.status).toBe(200);

    const getAfterDeleteRes = await request(app)
      .get(`/api/task/${taskId}/project/${projectId}/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/task/workspace/:workspaceId/all -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/task/workspace/some-ws/all");
    expect(res.status).toBe(401);
  });

  it("DELETE .../delete -> 403 when the member lacks DELETE_TASK permission", async () => {
    const owner = await registerAndLogin(app);
    const member = await registerAndLogin(app);
    await addMember(owner.currentWorkspaceId, member.userId, "MEMBER");
    const projectId = await createProject(owner);

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Protected Task", priority: "MEDIUM", status: "TODO" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .delete(`/api/task/${taskId}/workspace/${owner.currentWorkspaceId}/delete`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(403);
  });

  it("POST .../create -> 400 for an invalid status enum value", async () => {
    const owner = await registerAndLogin(app);
    const projectId = await createProject(owner);

    const res = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Bad Status", priority: "MEDIUM", status: "NOT_A_STATUS" });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("POST .../create -> 400 when assignedTo is not a workspace member", async () => {
    const owner = await registerAndLogin(app);
    const outsider = await registerAndLogin(app);
    const projectId = await createProject(owner);

    const res = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "T", priority: "MEDIUM", status: "TODO", assignedTo: outsider.userId });

    expect(res.status).toBe(400);
  });

  it("GET .../:id -> 404 for a task in the wrong project", async () => {
    const owner = await registerAndLogin(app);
    const projectId = await createProject(owner);

    const otherProjectRes = await request(app)
      .post(`/api/project/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Other Project" });
    const otherProjectId = otherProjectRes.body.project.id;

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Scoped Task", priority: "MEDIUM", status: "TODO" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .get(`/api/task/${taskId}/project/${otherProjectId}/workspace/${owner.currentWorkspaceId}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(404);
  });

  it("GET /api/task/workspace/:workspaceId/all -> filters by status and comma-separated priority", async () => {
    const owner = await registerAndLogin(app);
    const projectId = await createProject(owner);

    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Fix login bug", priority: "HIGH", status: "TODO" });
    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Write docs", priority: "LOW", status: "DONE" });

    const res = await request(app)
      .get(`/api/task/workspace/${owner.currentWorkspaceId}/all?status=TODO&priority=HIGH,MEDIUM`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].title).toBe("Fix login bug");
  });

  it("GET /api/task/workspace/:workspaceId/all -> an unassigned task has assignee: null, not omitted", async () => {
    const owner = await registerAndLogin(app);
    const projectId = await createProject(owner);

    await request(app)
      .post(`/api/task/project/${projectId}/workspace/${owner.currentWorkspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Unassigned", priority: "MEDIUM", status: "TODO" });

    const res = await request(app)
      .get(`/api/task/workspace/${owner.currentWorkspaceId}/all`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0]).toHaveProperty("assignee", null);
  });
});
