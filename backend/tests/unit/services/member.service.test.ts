/**
 * UNIT TESTS: member.service.ts
 * -----------------------------------
 * Mocks WorkspaceModel/MemberModel/RoleModel entirely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getMemberRoleInWorkspace,
  joinWorkspaceByInviteService,
} from "../../../src/services/member.service";

import WorkspaceModel from "../../../src/models/workspace.model";
import MemberModel from "../../../src/models/member.model";
import RoleModel from "../../../src/models/roles-permission.model";
import {
  asConstructorMock,
  buildFakeWorkspace,
  buildFakeRole,
} from "../../setup/testFixtures";

vi.mock("../../../src/models/workspace.model");
vi.mock("../../../src/models/member.model");
vi.mock("../../../src/models/roles-permission.model");

describe("getMemberRoleInWorkspace", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the member's role name when the workspace and membership both exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(MemberModel.findOne).mockReturnValue({
      populate: vi.fn().mockResolvedValue({ role: { name: "OWNER" } }),
    } as any);

    const result = await getMemberRoleInWorkspace("user-1", "ws-1");

    expect(result).toEqual({ role: "OWNER" });
  });

  it("throws NotFoundException when the workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(
      getMemberRoleInWorkspace("user-1", "missing-ws")
    ).rejects.toThrow("Workspace not found");

    expect(MemberModel.findOne).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedException when the user is not a member of the workspace", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(MemberModel.findOne).mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(getMemberRoleInWorkspace("user-1", "ws-1")).rejects.toThrow(
      "You are not a member of this workspace"
    );
  });
});

describe("joinWorkspaceByInviteService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a MEMBER-role membership when the invite code is valid and the user hasn't joined yet", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    const fakeRole = buildFakeRole({ name: "MEMBER" });

    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(MemberModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(RoleModel.findOne).mockResolvedValue(fakeRole as any);

    const memberSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: memberSave }) as any)
    );

    const result = await joinWorkspaceByInviteService("user-1", "INVITE123");

    expect(memberSave).toHaveBeenCalledOnce();
    expect(result).toEqual({
      workspaceId: fakeWorkspace._id,
      role: "MEMBER",
    });
  });

  it("throws NotFoundException for an invalid invite code", async () => {
    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      joinWorkspaceByInviteService("user-1", "BOGUS")
    ).rejects.toThrow("Invalid invite code or workspace not found");

    expect(MemberModel.findOne).not.toHaveBeenCalled();
  });

  it("throws BadRequestException when the user is already a member", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(MemberModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue({ _id: "existing-member" }),
    } as any);

    await expect(
      joinWorkspaceByInviteService("user-1", "INVITE123")
    ).rejects.toThrow("You are already a member of this workspace");

    expect(RoleModel.findOne).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the MEMBER role hasn't been seeded", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(MemberModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(RoleModel.findOne).mockResolvedValue(null as any);

    await expect(
      joinWorkspaceByInviteService("user-1", "INVITE123")
    ).rejects.toThrow("Role not found");
  });

  it("translates a duplicate-key error from a concurrent join (race past the pre-check) into the same BadRequestException", async () => {
    // Simulates two concurrent requests both passing the "existingMember"
    // check before either save() lands - the unique (userId, workspaceId)
    // index on MemberModel is what actually catches this, surfacing as a
    // Mongo duplicate-key error (code 11000) from save().
    const fakeWorkspace = buildFakeWorkspace();
    const fakeRole = buildFakeRole({ name: "MEMBER" });

    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(MemberModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(RoleModel.findOne).mockResolvedValue(fakeRole as any);

    const duplicateKeyError = Object.assign(
      new Error("E11000 duplicate key error"),
      {
        code: 11000,
      }
    );
    const memberSave = vi.fn().mockRejectedValue(duplicateKeyError);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: memberSave }) as any)
    );

    await expect(
      joinWorkspaceByInviteService("user-1", "INVITE123")
    ).rejects.toThrow("You are already a member of this workspace");
  });

  it("re-throws a non-duplicate-key error from save() unchanged", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    const fakeRole = buildFakeRole({ name: "MEMBER" });

    vi.mocked(WorkspaceModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(MemberModel.findOne).mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    } as any);
    vi.mocked(RoleModel.findOne).mockResolvedValue(fakeRole as any);

    const unrelatedError = new Error("connection reset");
    const memberSave = vi.fn().mockRejectedValue(unrelatedError);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: memberSave }) as any)
    );

    await expect(
      joinWorkspaceByInviteService("user-1", "INVITE123")
    ).rejects.toThrow("connection reset");
  });
});
