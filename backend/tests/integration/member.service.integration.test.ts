/**
 * INTEGRATION TESTS: member.service.ts
 * -------------------------------------------
 * Real Mongoose models against the in-memory MongoDB. No model mocks.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  getMemberRoleInWorkspace,
  joinWorkspaceByInviteService,
} from "../../src/services/member.service";

import UserModel from "../../src/models/user.model";
import WorkspaceModel from "../../src/models/workspace.model";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles } from "../../src/enums/role.enum";
import { BadRequestException } from "../../src/utils/appError";

describe("member.service (integration - real in-memory MongoDB)", () => {
  let userId: string;
  let workspaceId: string;
  let inviteCode: string;

  beforeEach(async () => {
    await RoleModel.create({ name: Roles.MEMBER, permissions: [] });

    const owner = await UserModel.create({
      name: "Workspace Owner",
      email: `owner-${Date.now()}@example.com`,
    });

    const workspace = await WorkspaceModel.create({
      name: "Member Integration Workspace",
      owner: owner._id,
    });
    workspaceId = workspace._id.toString();
    inviteCode = workspace.inviteCode;

    const joiner = await UserModel.create({
      name: "Joiner",
      email: `joiner-${Date.now()}@example.com`,
    });
    userId = joiner._id.toString();
  });

  it("persists a real MEMBER-role membership document when the invite code is valid", async () => {
    const result = await joinWorkspaceByInviteService(userId, inviteCode);

    expect(result.role).toBe("MEMBER");

    const persisted = await MemberModel.findOne({ userId, workspaceId });
    expect(persisted).not.toBeNull();
  });

  it("rejects a second join attempt with the same invite code (already a member)", async () => {
    await joinWorkspaceByInviteService(userId, inviteCode);

    await expect(
      joinWorkspaceByInviteService(userId, inviteCode)
    ).rejects.toThrow(BadRequestException);

    const memberships = await MemberModel.find({ userId, workspaceId });
    expect(memberships).toHaveLength(1);
  });

  it("rejects an invite code that doesn't match any workspace", async () => {
    await expect(
      joinWorkspaceByInviteService(userId, "totally-bogus-code")
    ).rejects.toThrow("Invalid invite code or workspace not found");
  });

  it("getMemberRoleInWorkspace round-trips the role name after a real join", async () => {
    await joinWorkspaceByInviteService(userId, inviteCode);

    const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
    expect(role).toBe("MEMBER");
  });
});
