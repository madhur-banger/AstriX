/**
 * END-TO-END (E2E) TESTS: project routes
 * --------------------------------------------
 * Real app wiring via buildRoutedApp (real `authenticate` + real
 * `errorHandler`), real routes, real in-memory DB.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import projectRoutes from "../../src/routes/project.route";
import WorkspaceModel from "../../src/models/workspace.model";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles, Permissions } from "../../src/enums/role.enum";
import { buildRoutedApp } from "../setup/buildTestApp";
import { createAuthenticatedUser } from "../setup/e2eAuth";

describe("Project routes (E2E via supertest + in-memory DB)", () => {
  let app: ReturnType<typeof buildRoutedApp>;
  let ownerRoleId: string;
  let memberRoleId: string;

  beforeEach(async () => {
    const ownerRole = await RoleModel.create({
      name: Roles.OWNER,
      permissions: Object.values(Permissions),
    });
    ownerRoleId = ownerRole._id.toString();

    // MEMBER lacks CREATE_PROJECT/EDIT_PROJECT/DELETE_PROJECT per the
    // hardcoded RolePermissions map - see task.routes.e2e.test.ts callout.
    const memberRole = await RoleModel.create({ name: Roles.MEMBER });
    memberRoleId = memberRole._id.toString();

    app = buildRoutedApp("/api/project", projectRoutes);
  });

  async function seedWorkspace(ownerId: string) {
    const workspace = await WorkspaceModel.create({
      name: "Project E2E Workspace",
      owner: ownerId,
    });
    await MemberModel.create({
      userId: ownerId,
      workspaceId: workspace._id,
      role: ownerRoleId,
    });
    return workspace._id.toString();
  }

  it("full lifecycle: create -> get -> update -> analytics -> delete", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const workspaceId = await seedWorkspace(user._id.toString());

    const createRes = await request(app)
      .post(`/api/project/workspace/${workspaceId}/create`)
      .set("Authorization", authHeader)
      .send({ name: "E2E Project", emoji: "🚀" });
    expect(createRes.status).toBe(201);
    const projectId = createRes.body.project._id;

    const getRes = await request(app)
      .get(`/api/project/${projectId}/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.project._id).toBe(projectId);

    const updateRes = await request(app)
      .put(`/api/project/${projectId}/workspace/${workspaceId}/update`)
      .set("Authorization", authHeader)
      .send({ name: "Renamed via E2E" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.project.name).toBe("Renamed via E2E");

    const analyticsRes = await request(app)
      .get(`/api/project/${projectId}/workspace/${workspaceId}/analytics`)
      .set("Authorization", authHeader);
    expect(analyticsRes.status).toBe(200);
    expect(analyticsRes.body.analytics).toEqual({
      totalTasks: 0,
      overdueTasks: 0,
      completedTasks: 0,
    });

    const deleteRes = await request(app)
      .delete(`/api/project/${projectId}/workspace/${workspaceId}/delete`)
      .set("Authorization", authHeader);
    expect(deleteRes.status).toBe(200);

    const getAfterDeleteRes = await request(app)
      .get(`/api/project/${projectId}/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/project/workspace/:workspaceId/all -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/project/workspace/ws-1/all");
    expect(res.status).toBe(401);
  });

  it("POST .../create -> 403 when the member lacks CREATE_PROJECT permission", async () => {
    const owner = await createAuthenticatedUser();
    const workspaceId = await seedWorkspace(owner.user._id.toString());

    const member = await createAuthenticatedUser();
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRoleId,
    });

    const res = await request(app)
      .post(`/api/project/workspace/${workspaceId}/create`)
      .set("Authorization", member.authHeader)
      .send({ name: "Should Fail" });

    expect(res.status).toBe(403);
  });

  it("GET /:id/workspace/:workspaceId -> 401/403-ish for a workspace the user never joined", async () => {
    const owner = await createAuthenticatedUser();
    const workspaceId = await seedWorkspace(owner.user._id.toString());

    const createRes = await request(app)
      .post(`/api/project/workspace/${workspaceId}/create`)
      .set("Authorization", owner.authHeader)
      .send({ name: "Private Project" });
    const projectId = createRes.body.project._id;

    const outsider = await createAuthenticatedUser();
    const res = await request(app)
      .get(`/api/project/${projectId}/workspace/${workspaceId}`)
      .set("Authorization", outsider.authHeader);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /:id/workspace/:workspaceId -> 404 when the project belongs to a different workspace", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const workspaceId = await seedWorkspace(user._id.toString());
    const otherWorkspaceId = await seedWorkspace(user._id.toString());

    const createRes = await request(app)
      .post(`/api/project/workspace/${workspaceId}/create`)
      .set("Authorization", authHeader)
      .send({ name: "Scoped Project" });
    const projectId = createRes.body.project._id;

    const res = await request(app)
      .get(`/api/project/${projectId}/workspace/${otherWorkspaceId}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });

  it("GET /api/project/workspace/:workspaceId/all -> 400 for a pageSize above the 100 cap", async () => {
    const { authHeader, user } = await createAuthenticatedUser();
    const workspaceId = await seedWorkspace(user._id.toString());

    const res = await request(app)
      .get(`/api/project/workspace/${workspaceId}/all`)
      .query({ pageSize: "999999" })
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
  });
});
