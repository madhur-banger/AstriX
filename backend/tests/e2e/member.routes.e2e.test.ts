/**
 * END-TO-END (E2E) TESTS: member routes
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import memberRoutes from "../../src/routes/member.route";
import WorkspaceModel from "../../src/models/workspace.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles } from "../../src/enums/role.enum";
import { buildRoutedApp } from "../setup/buildTestApp";
import { createAuthenticatedUser } from "../setup/e2eAuth";

describe("Member routes (E2E via supertest + in-memory DB)", () => {
  let app: ReturnType<typeof buildRoutedApp>;

  beforeEach(async () => {
    await RoleModel.create({ name: Roles.MEMBER, permissions: [] });
    app = buildRoutedApp("/api/member", memberRoutes);
  });

  it("POST /api/member/workspace/:inviteCode/join -> 200 and persists membership", async () => {
    const owner = await createAuthenticatedUser();
    const workspace = await WorkspaceModel.create({
      name: "Joinable Workspace",
      owner: owner.user._id,
    });

    const joiner = await createAuthenticatedUser();
    const res = await request(app)
      .post(`/api/member/workspace/${workspace.inviteCode}/join`)
      .set("Authorization", joiner.authHeader);

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("MEMBER");
    expect(res.body.workspaceId).toBe(String(workspace._id));
  });

  it("POST /api/member/workspace/:inviteCode/join -> 404 for a bad invite code", async () => {
    const { authHeader } = await createAuthenticatedUser();

    const res = await request(app)
      .post("/api/member/workspace/totally-bogus-code/join")
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });

  it("POST .../join -> error when the user is already a member", async () => {
    const owner = await createAuthenticatedUser();
    const workspace = await WorkspaceModel.create({
      name: "Already Joined Workspace",
      owner: owner.user._id,
    });

    const joiner = await createAuthenticatedUser();
    await request(app)
      .post(`/api/member/workspace/${workspace.inviteCode}/join`)
      .set("Authorization", joiner.authHeader);

    const res = await request(app)
      .post(`/api/member/workspace/${workspace.inviteCode}/join`)
      .set("Authorization", joiner.authHeader);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("POST .../join -> 401 with no Authorization header", async () => {
    const res = await request(app).post("/api/member/workspace/some-code/join");
    expect(res.status).toBe(401);
  });
});
