/**
 * UNIT TESTS: user.service.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

import {
  getCurrentUserService,
  updateProfileService,
  deleteAccountService,
} from "../../../src/services/user.service";
import UserModel from "../../../src/models/user.model";
import AccountModel from "../../../src/models/account.model";
import MemberModel from "../../../src/models/member.model";
import SessionModel from "../../../src/models/session.model";
import TaskModel from "../../../src/models/task.model";
import WorkspaceModel from "../../../src/models/workspace.model";
import PasswordResetTokenModel from "../../../src/models/passwordResetToken.model";
import EmailVerificationTokenModel from "../../../src/models/emailVerificationToken.model";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../../../src/utils/appError";
import { buildFakeUser, makeObjectId } from "../../setup/testFixtures";

vi.mock("../../../src/models/user.model");
vi.mock("../../../src/models/account.model");
vi.mock("../../../src/models/member.model");
vi.mock("../../../src/models/session.model");
vi.mock("../../../src/models/task.model");
vi.mock("../../../src/models/workspace.model");
vi.mock("../../../src/models/passwordResetToken.model");
vi.mock("../../../src/models/emailVerificationToken.model");

describe("getCurrentUserService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the user (currentWorkspace populated, password excluded)", async () => {
    const fakeUser = buildFakeUser();
    const select = vi.fn().mockResolvedValue(fakeUser);
    const populate = vi.fn().mockReturnValue({ select });
    vi.mocked(UserModel.findById).mockReturnValue({ populate } as any);

    const result = await getCurrentUserService(String(fakeUser._id));

    expect(UserModel.findById).toHaveBeenCalledWith(String(fakeUser._id));
    expect(populate).toHaveBeenCalledWith("currentWorkspace");
    expect(select).toHaveBeenCalledWith("-password");
    expect(result).toEqual({ user: fakeUser });
  });

  it("throws BadRequestException when the user doesn't exist", async () => {
    const select = vi.fn().mockResolvedValue(null);
    const populate = vi.fn().mockReturnValue({ select });
    vi.mocked(UserModel.findById).mockReturnValue({ populate } as any);

    await expect(getCurrentUserService("missing-user")).rejects.toThrow(
      "User not found"
    );
  });
});

describe("updateProfileService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the user doesn't exist", async () => {
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(
      updateProfileService("missing-id", { name: "New Name" })
    ).rejects.toThrow(NotFoundException);
  });

  it("updates only the fields provided", async () => {
    const fakeUser = buildFakeUser({ name: "Old Name", profilePicture: null });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    fakeUser.omitPassword = vi
      .fn()
      .mockReturnValue({ ...fakeUser, password: undefined });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await updateProfileService(String(fakeUser._id), { name: "New Name" });

    expect((fakeUser as any).name).toBe("New Name");
    expect((fakeUser as any).profilePicture).toBeNull(); // untouched
    expect(fakeUser.save).toHaveBeenCalledOnce();
  });

  it("updates profilePicture, including explicitly clearing it to null", async () => {
    const fakeUser = buildFakeUser({
      profilePicture: "https://example.com/old.jpg",
    });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    fakeUser.omitPassword = vi.fn().mockReturnValue(fakeUser);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await updateProfileService(String(fakeUser._id), { profilePicture: null });

    expect((fakeUser as any).profilePicture).toBeNull();
  });

  it("returns the user via omitPassword()", async () => {
    const fakeUser = buildFakeUser();
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    const omitted = { safe: true };
    fakeUser.omitPassword = vi.fn().mockReturnValue(omitted);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    const result = await updateProfileService(String(fakeUser._id), {
      name: "X",
    });

    expect(result.user).toBe(omitted);
  });
});

describe("deleteAccountService", () => {
  let fakeSession: any;

  beforeEach(() => {
    vi.resetAllMocks();
    fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(fakeSession);
  });

  it("throws NotFoundException when the user doesn't exist", async () => {
    vi.mocked(UserModel.findById).mockResolvedValue(null as any);

    await expect(deleteAccountService("missing-id")).rejects.toThrow(
      NotFoundException
    );
  });

  it("throws BadRequestException when the account has a password but none was provided", async () => {
    const fakeUser = buildFakeUser({ password: "hashed-value" });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await expect(deleteAccountService(String(fakeUser._id))).rejects.toThrow(
      BadRequestException
    );
  });

  it("throws UnauthorizedException when the provided password is wrong", async () => {
    const fakeUser = buildFakeUser({ password: "hashed-value" });
    fakeUser.comparePassword = vi.fn().mockResolvedValue(false);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await expect(
      deleteAccountService(String(fakeUser._id), "wrong-password")
    ).rejects.toThrow(UnauthorizedException);
  });

  // All the terminal deleteMany/findByIdAndDelete calls share the exact
  // same `.session(session)` chain shape - wire them all at once so each
  // test below only needs to override what it actually cares about.
  function mockDeletionChain() {
    vi.mocked(MemberModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    vi.mocked(AccountModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    vi.mocked(SessionModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    vi.mocked(PasswordResetTokenModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    vi.mocked(EmailVerificationTokenModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    vi.mocked(UserModel.findByIdAndDelete).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
  }

  it("skips the password check entirely for an OAuth-only account (no password set)", async () => {
    const fakeUser = buildFakeUser({ password: undefined });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(WorkspaceModel.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(MemberModel.find).mockReturnValue({
      session: vi.fn().mockResolvedValue([]),
    } as any);
    mockDeletionChain();

    await deleteAccountService(String(fakeUser._id)); // no password argument at all

    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
  });

  it("throws BadRequestException (and never starts a transaction) when the user owns any workspace", async () => {
    const fakeUser = buildFakeUser({ password: undefined });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(WorkspaceModel.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([{ name: "Owned Workspace" }]),
    } as any);

    await expect(deleteAccountService(String(fakeUser._id))).rejects.toThrow(
      BadRequestException
    );
    expect(mongoose.startSession).not.toHaveBeenCalled();
  });

  it("unassigns tasks, removes memberships, deletes all auth-adjacent records, and deletes the user on success", async () => {
    const userId = makeObjectId();
    const userIdString = userId.toString();
    const fakeUser = buildFakeUser({ _id: userId, password: "hashed-value" });
    fakeUser.comparePassword = vi.fn().mockResolvedValue(true);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(WorkspaceModel.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as any);

    const workspaceId1 = makeObjectId();
    const workspaceId2 = makeObjectId();
    vi.mocked(MemberModel.find).mockReturnValue({
      session: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: workspaceId1 },
          { workspaceId: workspaceId2 },
        ]),
    } as any);

    vi.mocked(TaskModel.updateMany).mockReturnValue({
      session: vi.fn().mockResolvedValue({}),
    } as any);
    mockDeletionChain();

    await deleteAccountService(userIdString, "correct-password");

    // The service consistently uses the STRING userId parameter throughout
    // its queries (mongoose casts it to ObjectId under the hood) - assert
    // against that same string, not a raw ObjectId instance.
    expect(TaskModel.updateMany).toHaveBeenCalledWith(
      {
        workspace: { $in: [workspaceId1, workspaceId2] },
        assignedTo: userIdString,
      },
      { assignedTo: null }
    );
    expect(MemberModel.deleteMany).toHaveBeenCalledWith({
      userId: userIdString,
    });
    expect(AccountModel.deleteMany).toHaveBeenCalledWith({
      userId: userIdString,
    });
    expect(SessionModel.deleteMany).toHaveBeenCalledWith({
      userId: userIdString,
    });
    expect(PasswordResetTokenModel.deleteMany).toHaveBeenCalledWith({
      userId: userIdString,
    });
    expect(EmailVerificationTokenModel.deleteMany).toHaveBeenCalledWith({
      userId: userIdString,
    });
    expect(UserModel.findByIdAndDelete).toHaveBeenCalledWith(userIdString);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.abortTransaction).not.toHaveBeenCalled();
  });

  it("skips the task-unassignment call entirely when the user has no memberships", async () => {
    const fakeUser = buildFakeUser({ password: undefined });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(WorkspaceModel.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(MemberModel.find).mockReturnValue({
      session: vi.fn().mockResolvedValue([]),
    } as any);
    mockDeletionChain();

    await deleteAccountService(String(fakeUser._id));

    expect(TaskModel.updateMany).not.toHaveBeenCalled();
  });

  it("aborts the transaction and re-throws when a deletion step fails", async () => {
    const fakeUser = buildFakeUser({ password: undefined });
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(WorkspaceModel.find).mockReturnValue({
      select: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(MemberModel.find).mockReturnValue({
      session: vi.fn().mockResolvedValue([]),
    } as any);
    vi.mocked(MemberModel.deleteMany).mockReturnValue({
      session: vi.fn().mockRejectedValue(new Error("unexpected DB error")),
    } as any);

    await expect(deleteAccountService(String(fakeUser._id))).rejects.toThrow(
      "unexpected DB error"
    );
    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.commitTransaction).not.toHaveBeenCalled();
  });
});
