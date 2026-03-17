/**
 * END-TO-END (E2E) TESTS: workspace routes
 * --------------------------------------------
 * Real Express app, real `authenticate` middleware (via `buildRoutedApp`),
 * real routes, real DB (in-memory), real `errorHandler` - exactly how
 * `src/index.ts` wires `${BASE_PATH}/workspace` behind `authenticate`.
 * Authenticated requests carry a REAL access token + SessionModel row
 * (see `createAuthenticatedUser` in tests/setup/e2eAuth.ts), so the whole
 * chain (JWT -> authenticate -> route -> zod -> roleGuard -> service -> DB)
 * is exercised, not a stubbed `req.user`.
 *
 * WHAT E2E TESTS ARE FOR (and NOT for):
 * They confirm the whole chain wires together correctly. They are NOT the
 * place to enumerate every business-logic edge case (that's what the
 * service unit/integration tests are for) - keep this file to "does the
 * happy path work end-to-end" and "does an obviously bad request get
 * rejected with the right status" per route.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import workspaceRoutes from "../../src/routes/workspace.routes";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles, Permissions } from "../../src/enums/role.enum";
import { buildRoutedApp } from "../setup/buildTestApp";
import { createAuthenticatedUser } from "../setup/e2eAuth";

describe("Workspace routes (E2E via supertest + in-memory DB)", () => {
  let app: ReturnType<typeof buildRoutedApp>;

  beforeEach(async () => {
    // Seed a role with EVERY permission so an OWNER clears every roleGuard
    // check across all the routes exercised below.
    await RoleModel.create({
      name: Roles.OWNER,
      permissions: Object.values(Permissions),
    });
    await RoleModel.create({
      name: Roles.MEMBER,
      permissions: [Permissions.VIEW_ONLY],
    });

    app = buildRoutedApp("/api/workspace", workspaceRoutes);
  });

  it("POST /api/workspace/create/new -> 201 with the created workspace", async () => {
    const { authHeader } = await createAuthenticatedUser();

    const res = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ name: "E2E Workspace", description: "made via supertest" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Workspace created successfully");
    expect(res.body.workspace.name).toBe("E2E Workspace");
  });

  it("POST /api/workspace/create/new -> 401 with no Authorization header", async () => {
    const res = await request(app)
      .post("/api/workspace/create/new")
      .send({ name: "No Auth" });

    expect(res.status).toBe(401);
  });

  it("POST /api/workspace/create/new -> 400 when name is missing", async () => {
    const { authHeader } = await createAuthenticatedUser();

    const res = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ description: "no name provided" });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("VALIDATION_ERROR");
  });

  it("full lifecycle: create -> get by id -> update -> delete", async () => {
    const { authHeader } = await createAuthenticatedUser();

    // 1. Create
    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ name: "Lifecycle Workspace" });
    expect(createRes.status).toBe(201);
    const workspaceId = createRes.body.workspace._id;

    // 2. Get by id - confirms the membership check (getMemberRoleInWorkspace)
    //    correctly recognizes the creator as a member.
    const getRes = await request(app)
      .get(`/api/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getRes.status).toBe(200);
    expect(getRes.body.workspace._id).toBe(workspaceId);

    // 3. Update - confirms the EDIT_WORKSPACE permission check passes for the owner.
    const updateRes = await request(app)
      .put(`/api/workspace/update/${workspaceId}`)
      .set("Authorization", authHeader)
      .send({ name: "Renamed via E2E" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.workspace.name).toBe("Renamed via E2E");

    // 4. Delete - confirms the DELETE_WORKSPACE permission check + ownership check pass.
    const deleteRes = await request(app)
      .delete(`/api/workspace/delete/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.message).toBe("Workspace deleted successfully");

    // 5. Confirm it's REALLY gone by trying to fetch it again -> 404.
    const getAfterDeleteRes = await request(app)
      .get(`/api/workspace/${workspaceId}`)
      .set("Authorization", authHeader);
    expect(getAfterDeleteRes.status).toBe(404);
  });

  it("GET /api/workspace/:id -> error status for a workspace the user never joined", async () => {
    const owner = await createAuthenticatedUser();
    const outsider = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Private Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(app)
      .get(`/api/workspace/${workspaceId}`)
      .set("Authorization", outsider.authHeader);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /api/workspace/members/:id -> 200 listing the owner as a member", async () => {
    const { authHeader, user } = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ name: "Members Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(app)
      .get(`/api/workspace/members/${workspaceId}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(
      res.body.members.some(
        (m: any) => String(m.userId?._id ?? m.userId) === String(user._id)
      )
    ).toBe(true);
  });

  it("GET /api/workspace/analytics/:id -> 200 with zeroed task counts for a fresh workspace", async () => {
    const { authHeader } = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ name: "Analytics Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(app)
      .get(`/api/workspace/analytics/${workspaceId}`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.analytics).toEqual({
      totalTasks: 0,
      overdueTasks: 0,
      completedTasks: 0,
    });
  });

  it("PUT /api/workspace/change/member/role/:id -> 200 and persists the new role for a member", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Role Change Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const memberRole = await RoleModel.findOne({ name: Roles.MEMBER });
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRole!._id,
    });

    const ownerRole = await RoleModel.findOne({ name: Roles.OWNER });
    const res = await request(app)
      .put(`/api/workspace/change/member/role/${workspaceId}`)
      .set("Authorization", owner.authHeader)
      .send({
        memberId: String(member.user._id),
        roleId: String(ownerRole!._id),
      });

    expect(res.status).toBe(200);
    expect(res.body.member.role._id ?? res.body.member.role).toBeTruthy();

    const persisted = await MemberModel.findOne({
      userId: member.user._id,
      workspaceId,
    });
    expect(String(persisted!.role)).toBe(String(ownerRole!._id));
  });

  it("PUT /api/workspace/change/member/role/:id -> 400 when targeting the workspace owner", async () => {
    const owner = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Owner Role Change Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const memberRole = await RoleModel.findOne({ name: Roles.MEMBER });
    const res = await request(app)
      .put(`/api/workspace/change/member/role/${workspaceId}`)
      .set("Authorization", owner.authHeader)
      .send({
        memberId: String(owner.user._id),
        roleId: String(memberRole!._id),
      });

    expect(res.status).toBe(400);
  });

  it("DELETE /api/workspace/:id/member/:memberId -> 200 and removes the member", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Remove Member Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const memberRole = await RoleModel.findOne({ name: Roles.MEMBER });
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRole!._id,
    });

    const res = await request(app)
      .delete(`/api/workspace/${workspaceId}/member/${member.user._id}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(200);

    const persisted = await MemberModel.findOne({
      userId: member.user._id,
      workspaceId,
    });
    expect(persisted).toBeNull();
  });

  it("DELETE /api/workspace/:id/member/:memberId -> 400 when targeting the workspace owner", async () => {
    const owner = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Cannot Remove Owner Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(app)
      .delete(`/api/workspace/${workspaceId}/member/${owner.user._id}`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(400);

    const stillThere = await MemberModel.findOne({
      userId: owner.user._id,
      workspaceId,
    });
    expect(stillThere).not.toBeNull();
  });

  it("DELETE /api/workspace/:id/member/:memberId -> 403/401-ish when a MEMBER (no REMOVE_MEMBER permission) tries to remove someone", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Permission Check Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const memberRole = await RoleModel.findOne({ name: Roles.MEMBER });
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRole!._id,
    });
    await MemberModel.create({
      userId: target.user._id,
      workspaceId,
      role: memberRole!._id,
    });

    const res = await request(app)
      .delete(`/api/workspace/${workspaceId}/member/${target.user._id}`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const stillThere = await MemberModel.findOne({
      userId: target.user._id,
      workspaceId,
    });
    expect(stillThere).not.toBeNull();
  });

  it("POST /api/workspace/:id/leave -> 200 and removes the caller's own membership", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Leave Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const memberRole = await RoleModel.findOne({ name: Roles.MEMBER });
    await MemberModel.create({
      userId: member.user._id,
      workspaceId,
      role: memberRole!._id,
    });

    const res = await request(app)
      .post(`/api/workspace/${workspaceId}/leave`)
      .set("Authorization", member.authHeader);

    expect(res.status).toBe(200);

    const persisted = await MemberModel.findOne({
      userId: member.user._id,
      workspaceId,
    });
    expect(persisted).toBeNull();
  });

  it("POST /api/workspace/:id/leave -> 400 when the workspace owner tries to leave", async () => {
    const owner = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", owner.authHeader)
      .send({ name: "Owner Cannot Leave Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(app)
      .post(`/api/workspace/${workspaceId}/leave`)
      .set("Authorization", owner.authHeader);

    expect(res.status).toBe(400);

    const stillThere = await MemberModel.findOne({
      userId: owner.user._id,
      workspaceId,
    });
    expect(stillThere).not.toBeNull();
  });

  it("POST /api/workspace/:id/invite/reset -> 200 and changes the invite code", async () => {
    const { authHeader } = await createAuthenticatedUser();

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .set("Authorization", authHeader)
      .send({ name: "Invite Reset Workspace" });
    const workspaceId = createRes.body.workspace._id;
    const originalInviteCode = createRes.body.workspace.inviteCode;

    const res = await request(app)
      .post(`/api/workspace/${workspaceId}/invite/reset`)
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.workspace.inviteCode).toBeTruthy();
    expect(res.body.workspace.inviteCode).not.toBe(originalInviteCode);
  });
});
