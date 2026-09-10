/**
 * END-TO-END (E2E) TESTS: task routes
 * ----------------------------------------
 * Real app wiring via buildRoutedApp (real `authenticate` + real
 * `errorHandler`), real routes, real in-memory DB. See
 * tests/e2e/workspace.routes.e2e.test.ts for the pattern this follows.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import taskRoutes from "../../src/routes/task.route";
import WorkspaceModel from "../../src/models/workspace.model";
import ProjectModel from "../../src/models/project.model";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles, Permissions } from "../../src/enums/role.enum";
import { buildRoutedApp } from "../setup/buildTestApp";
import { createAuthenticatedUser } from "../setup/e2eAuth";

describe("Task routes (E2E via supertest + in-memory DB)", () => {
  let app: ReturnType<typeof buildRoutedApp>;
  let ownerRoleId: string;
  let memberRoleId: string;

  beforeEach(async () => {
    const ownerRole = await RoleModel.create({
      name: Roles.OWNER,
      permissions: Object.values(Permissions),
    });
    ownerRoleId = ownerRole._id.toString();

    // NOTE: roleGuard() checks the hardcoded `RolePermissions[roleName]` map
    // (src/utils/role-permission.ts), NOT the `permissions` array stored on
    // this RoleModel document - so what's seeded here is irrelevant to
    // authorization, only the `name` is. Per that map, MEMBER has
    // VIEW_ONLY/CREATE_TASK/EDIT_TASK but NOT DELETE_TASK, which is what the
    // "insufficient permission" case below relies on.
    const memberRole = await RoleModel.create({ name: Roles.MEMBER });
    memberRoleId = memberRole._id.toString();

    app = buildRoutedApp("/api/task", taskRoutes);
  });

  async function seedWorkspaceAndProject(ownerId: string) {
    const workspace = await WorkspaceModel.create({
      name: "Task E2E Workspace",
      owner: ownerId,
    });
    await MemberModel.create({
      userId: ownerId,
      workspaceId: workspace._id,
      role: ownerRoleId,
    });
    const project = await ProjectModel.create({
      name: "Task E2E Project",
      workspace: workspace._id,
      createdBy: ownerId,
    });
    return {
      workspaceId: workspace._id.toString(),
      projectId: project._id.toString(),
    };
  }

  it("full lifecycle: create -> get -> update -> delete", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const { workspaceId, projectId } = await seedWorkspaceAndProject(
      user._id.toString()
    );

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${workspaceId}/create`)
      .set("Authorization", authHeader)
      .send({ title: "E2E Task", priority: "MEDIUM", status: "TODO" });
    expect(createRes.status).toBe(200);
    const taskId = createRes.body.task._id;

    const getRes = await request(app)
      .get(`/api/task/${taskId}/project/${projectId}/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.task._id).toBe(taskId);

    const updateRes = await request(app)
      .put(
        `/api/task/${taskId}/project/${projectId}/workspace/${workspaceId}/update`
      )
      .set("Authorization", authHeader)
      .send({ title: "Renamed via E2E", priority: "HIGH", status: "DONE" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.task.title).toBe("Renamed via E2E");

    const deleteRes = await request(app)
      .delete(`/api/task/${taskId}/workspace/${workspaceId}/delete`)
      .set("Authorization", authHeader);
    expect(deleteRes.status).toBe(200);

    const getAfterDeleteRes = await request(app)
      .get(`/api/task/${taskId}/project/${projectId}/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/task/workspace/:workspaceId/all -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/task/workspace/ws-1/all");
    expect(res.status).toBe(401);
  });

  it("DELETE .../delete -> 403 when the member lacks DELETE_TASK permission", async () => {
    const owner = await createAuthenticatedUser();
    const { workspaceId, projectId } = await seedWorkspaceAndProject(
      owner.user._id.toString()
    );

    const member = await createAuthenticatedUser();
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRoleId,
    });

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${workspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ title: "Protected Task", priority: "MEDIUM", status: "TODO" });
    const taskId = createRes.body.task._id;

    const res = await request(app)
      .delete(`/api/task/${taskId}/workspace/${workspaceId}/delete`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(403);
  });

  it("POST .../create -> 400 for an invalid status enum value", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const { workspaceId, projectId } = await seedWorkspaceAndProject(
      user._id.toString()
    );

    const res = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${workspaceId}/create`)
      .set("Authorization", authHeader)
      .send({
        title: "Bad Status",
        priority: "MEDIUM",
        status: "NOT_A_STATUS",
      });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("GET .../:id -> 404 for a task in the wrong project", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const { workspaceId, projectId } = await seedWorkspaceAndProject(
      user._id.toString()
    );

    const otherProject = await ProjectModel.create({
      name: "Other Project",
      workspace: workspaceId,
      createdBy: user._id,
    });

    const createRes = await request(app)
      .post(`/api/task/project/${projectId}/workspace/${workspaceId}/create`)
      .set("Authorization", authHeader)
      .send({ title: "Scoped Task", priority: "MEDIUM", status: "TODO" });
    const taskId = createRes.body.task._id;

    const res = await request(app)
      .get(
        `/api/task/${taskId}/project/${otherProject._id}/workspace/${workspaceId}`
      )
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });
});
