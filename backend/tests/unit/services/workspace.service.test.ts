/**
 * UNIT TESTS: workspace.service.ts
 * ------------------------------------
 * This is a UNIT test file: every Mongoose model (UserModel, RoleModel,
 * WorkspaceModel, MemberModel, TaskModel, ProjectModel) is FAKED. No real
 * database is touched here at all - that's what makes it "unit" instead of
 * "integration". We're testing ONLY the logic inside workspace.service.ts:
 * does it call the right things, in the right order, and handle errors
 * correctly?
 *
 * THREE DIFFERENT MOCKING SHAPES YOU NEED, because Mongoose models are used
 * in three different ways in this file, and each needs a different mock shape:
 *
 *   1. STATIC METHOD, returns a document directly:
 *        UserModel.findById(id)               -> await it directly
 *      Mock:  vi.mocked(UserModel.findById).mockResolvedValue(fakeUser)
 *
 *   2. STATIC METHOD, CHAINED, then awaited:
 *        WorkspaceModel.findById(id).session(session)
 *        MemberModel.find({...}).populate(...).exec()
 *      Mock: the first call must return an OBJECT with the next method in
 *      the chain, and THAT method must return a Promise (or another
 *      chainable object, if there are more links in the chain).
 *
 *   3. CONSTRUCTOR (used with `new`):
 *        new WorkspaceModel({ name, ... })   then   workspace.save()
 *      Mock: vi.mocked(WorkspaceModel).mockImplementation((data) => ({...}))
 *      because auto-mocking a class replaces it with a mock constructor,
 *      and mockImplementation controls what `new WorkspaceModel(x)` returns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

import {
  createWorkspaceService,
  getWorkspaceByIdService,
  getWorkspaceMembersService,
  getAllWorkspacesUserIsMemberService,
  getWorkspaceAnalyticsService,
  changeMemberRoleService,
  updateWorkspaceByIdService,
  deleteWorkspaceService,
  removeMemberFromWorkspaceService,
  resetWorkspaceInviteCodeService,
} from "../../../src/services/workspace.service";

import UserModel from "../../../src/models/user.model";
import RoleModel from "../../../src/models/roles-permission.model";
import WorkspaceModel from "../../../src/models/workspace.model";
import MemberModel from "../../../src/models/member.model";
import TaskModel from "../../../src/models/task.model";
import ProjectModel from "../../../src/models/project.model";

import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "../../../src/utils/appError";
import {
  buildFakeUser,
  buildFakeWorkspace,
  buildFakeRole,
  buildFakeMember,
  makeObjectId,
  asConstructorMock,
} from "../../setup/testFixtures";

// vi.mock() is HOISTED to the top of the file automatically by Vitest, so it
// runs before the imports above are even evaluated. This is why you can
// `vi.mock` a path and then still `import` the real path above - the import
// silently receives the mocked version instead of the real module.
vi.mock("../../../src/models/user.model");
vi.mock("../../../src/models/roles-permission.model");
vi.mock("../../../src/models/workspace.model");
vi.mock("../../../src/models/member.model");
vi.mock("../../../src/models/task.model");
vi.mock("../../../src/models/project.model");

describe("createWorkspaceService", () => {
  // This service uses a Mongoose TRANSACTION, same as deleteWorkspaceService
  // below - spy on just `mongoose.startSession` and hand back a fake session,
  // and every model call becomes a two-step `.session(session)` chain.
  let fakeSession: any;

  beforeEach(() => {
    // Wipes call history AND any mockResolvedValue/mockImplementation set up
    // in a PREVIOUS test, so tests never leak state into each other.
    // Forgetting this is the #1 cause of "my test passes alone but fails
    // when run with the others" confusion.
    vi.resetAllMocks();
    fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn().mockResolvedValue(undefined),
      abortTransaction: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(fakeSession);
  });

  it("throws NotFoundException and aborts the transaction when the user does not exist", async () => {
    // Arrange: UserModel.findById(...).session(...) resolves to null -> "no such user"
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    // Act + Assert combined: `.rejects.toThrow(...)` is the async-aware
    // version of `expect(() => fn()).toThrow()`. You MUST await this -
    // forgetting the `await` here makes the test always pass even if it's wrong,
    // because the assertion never gets a chance to run before the test ends.
    await expect(
      createWorkspaceService("any-user-id", { name: "Test" })
    ).rejects.toThrow(NotFoundException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.commitTransaction).not.toHaveBeenCalled();
  });

  it("throws NotFoundException and aborts the transaction when the OWNER role is missing from the DB", async () => {
    const fakeUser = buildFakeUser();
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeUser),
    } as any);
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      createWorkspaceService(String(fakeUser._id), { name: "Test" })
    ).rejects.toThrow(NotFoundException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("creates workspace + member + updates user.currentWorkspace, then commits", async () => {
    // Arrange
    const fakeUser = buildFakeUser();
    fakeUser.save = vi.fn().mockResolvedValue(undefined); // .save() is called on the user at the end
    const fakeRole = buildFakeRole({ name: "OWNER" });
    const newWorkspaceId = makeObjectId();

    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeUser),
    } as any);
    vi.mocked(RoleModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeRole),
    } as any);

    // WorkspaceModel and MemberModel are called with `new`, so we mock the
    // CONSTRUCTOR itself. Whatever object we return here is what
    // `const workspace = new WorkspaceModel({...})` becomes inside the service.
    const saveWorkspaceSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(WorkspaceModel).mockImplementation(
      asConstructorMock(
        (data: any) =>
          ({
            ...data,
            _id: newWorkspaceId,
            save: saveWorkspaceSpy,
          }) as any
      )
    );

    const saveMemberSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(MemberModel).mockImplementation(
      asConstructorMock(
        (data: any) => ({ ...data, save: saveMemberSpy }) as any
      )
    );

    // Act
    const result = await createWorkspaceService(String(fakeUser._id), {
      name: "Engineering",
      description: "core team",
    });

    // Assert - check BOTH the return value AND the side effects (calls made)
    expect(result.workspace.name).toBe("Engineering");
    expect(result.workspace._id).toBe(newWorkspaceId);
    expect(saveWorkspaceSpy).toHaveBeenCalledWith({ session: fakeSession });
    expect(saveMemberSpy).toHaveBeenCalledWith({ session: fakeSession });
    expect(fakeUser.save).toHaveBeenCalledWith({ session: fakeSession });
    // The service should have set the user's currentWorkspace to the NEW workspace's id
    expect(fakeUser.currentWorkspace).toBe(newWorkspaceId);
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.abortTransaction).not.toHaveBeenCalled();
  });
});

describe("getWorkspaceByIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(getWorkspaceByIdService("missing-id")).rejects.toThrow(
      NotFoundException
    );
  });

  it("returns the workspace merged with its members list", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    // .toObject() is a real Mongoose document method - our fake needs one too,
    // since the service calls `workspace.toObject()`.
    (fakeWorkspace as any).toObject = vi
      .fn()
      .mockReturnValue({ ...fakeWorkspace });
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);

    // MemberModel.find({...}).populate("role") is a TWO-LINK chain.
    // find() must return an object with a .populate() method,
    // and .populate() is what actually resolves to the array.
    const fakeMembers = [buildFakeMember()];
    vi.mocked(MemberModel.find).mockReturnValue({
      populate: vi.fn().mockResolvedValue(fakeMembers),
    } as any);

    const result = await getWorkspaceByIdService(String(fakeWorkspace._id));

    expect(result.workspace.name).toBe(fakeWorkspace.name);
    expect((result.workspace as any).members).toEqual(fakeMembers);
  });
});

describe("getWorkspaceMembersService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns members (populated) and all available roles", async () => {
    const fakeMembers = [buildFakeMember(), buildFakeMember()];
    const fakeRoles = [
      buildFakeRole({ name: "OWNER" }),
      buildFakeRole({ name: "MEMBER" }),
    ];

    // MemberModel.find({...}).populate(...).populate(...) - THREE-link chain
    // (find -> populate -> populate). Each .populate() call must return
    // something with the NEXT method, until the last one resolves.
    const secondPopulate = vi.fn().mockResolvedValue(fakeMembers);
    const firstPopulate = vi.fn().mockReturnValue({ populate: secondPopulate });
    vi.mocked(MemberModel.find).mockReturnValue({
      populate: firstPopulate,
    } as any);

    // RoleModel.find({}, {...}).select(...).lean() - a different three-link chain
    const leanMock = vi.fn().mockResolvedValue(fakeRoles);
    const selectMock = vi.fn().mockReturnValue({ lean: leanMock });
    vi.mocked(RoleModel.find).mockReturnValue({ select: selectMock } as any);

    const result = await getWorkspaceMembersService("some-workspace-id");

    expect(result.members).toEqual(fakeMembers);
    expect(result.roles).toEqual(fakeRoles);
  });
});

describe("getAllWorkspacesUserIsMemberService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("extracts the workspaceId (populated) out of each membership", async () => {
    const membership1 = buildFakeMember({ workspaceId: buildFakeWorkspace() });
    const membership2 = buildFakeMember({ workspaceId: buildFakeWorkspace() });

    // .find().populate().exec() - three-link chain, exec() resolves last
    const execMock = vi.fn().mockResolvedValue([membership1, membership2]);
    const populateMock = vi.fn().mockReturnValue({ exec: execMock });
    vi.mocked(MemberModel.find).mockReturnValue({
      populate: populateMock,
    } as any);

    const result = await getAllWorkspacesUserIsMemberService("user-id");

    expect(result.workspaces).toEqual([
      membership1.workspaceId,
      membership2.workspaceId,
    ]);
  });
});

describe("getWorkspaceAnalyticsService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns totalTasks, overdueTasks, and completedTasks counts", async () => {
    // countDocuments is called THREE separate times with different filters.
    // mockResolvedValueOnce lets you queue up DIFFERENT return values for
    // consecutive calls to the SAME mocked function, in call order.
    vi.mocked(TaskModel.countDocuments)
      .mockResolvedValueOnce(10) // totalTasks
      .mockResolvedValueOnce(3) // overdueTasks
      .mockResolvedValueOnce(5); // completedTasks

    const result = await getWorkspaceAnalyticsService("workspace-id");

    expect(result.analytics).toEqual({
      totalTasks: 10,
      overdueTasks: 3,
      completedTasks: 5,
    });
  });
});

describe("changeMemberRoleService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(
      changeMemberRoleService("ws-id", "member-id", "role-id")
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when attempting to change the workspace owner's role", async () => {
    const ownerId = makeObjectId();
    const fakeWorkspace = buildFakeWorkspace({ owner: ownerId });
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);

    await expect(
      changeMemberRoleService("ws-id", ownerId.toString(), "role-id")
    ).rejects.toThrow(BadRequestException);

    // Must fail BEFORE looking up the role/member - the owner can never
    // have their role changed this way, regardless of what role/member ids
    // are supplied.
    expect(RoleModel.findById).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the target role doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(RoleModel.findById).mockResolvedValue(null as any);

    await expect(
      changeMemberRoleService("ws-id", makeObjectId().toString(), "role-id")
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when the member isn't found in the workspace", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(RoleModel.findById).mockResolvedValue(buildFakeRole() as any);
    vi.mocked(MemberModel.findOne).mockResolvedValue(null as any);

    await expect(
      changeMemberRoleService("ws-id", makeObjectId().toString(), "role-id")
    ).rejects.toThrow(NotFoundException);
  });

  it("updates and saves the member's role on success", async () => {
    const fakeRole = buildFakeRole({ name: "ADMIN" });
    const fakeMember = buildFakeMember();
    fakeMember.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(RoleModel.findById).mockResolvedValue(fakeRole as any);
    vi.mocked(MemberModel.findOne).mockResolvedValue(fakeMember as any);

    const result = await changeMemberRoleService(
      "ws-id",
      makeObjectId().toString(),
      "role-id"
    );

    expect(fakeMember.role).toBe(fakeRole);
    expect(fakeMember.save).toHaveBeenCalledOnce();
    expect(result.member).toBe(fakeMember);
  });
});

describe("updateWorkspaceByIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(
      updateWorkspaceByIdService("ws-id", "New Name")
    ).rejects.toThrow(NotFoundException);
  });

  it("updates name and description and saves", async () => {
    const fakeWorkspace = buildFakeWorkspace({
      name: "Old Name",
      description: "Old desc",
    });
    fakeWorkspace.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);

    const result = await updateWorkspaceByIdService(
      "ws-id",
      "New Name",
      "New desc"
    );

    expect(result.workspace.name).toBe("New Name");
    expect(result.workspace.description).toBe("New desc");
    expect(fakeWorkspace.save).toHaveBeenCalledOnce();
  });

  it("KEEPS the old description when an empty string is passed (documents a real gotcha)", async () => {
    // The service does: `workspace.description = description || workspace.description`
    // `||` treats "" (empty string) as falsy, so passing an EXPLICIT empty
    // string to "clear" the description does NOT clear it - it silently keeps
    // the old value instead. This is a classic JS footgun (should probably be
    // `description !== undefined ? description : workspace.description`, or
    // use `??` instead of `||`). This test locks in the CURRENT behavior so
    // you notice immediately if/when you fix it.
    const fakeWorkspace = buildFakeWorkspace({
      name: "Name",
      description: "Keep me",
    });
    fakeWorkspace.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace as any);

    const result = await updateWorkspaceByIdService("ws-id", "Name", "");

    expect(result.workspace.description).toBe("Keep me"); // NOT ""
  });
});

describe("deleteWorkspaceService", () => {
  // This service uses a Mongoose TRANSACTION (session.startTransaction /
  // commitTransaction / abortTransaction). We don't want to mock the ENTIRE
  // mongoose module (that would break real ObjectId behavior used elsewhere),
  // so instead we spy on JUST `mongoose.startSession` and hand back a
  // fake session object with the four methods this service calls on it.
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

  it("throws NotFoundException and aborts the transaction when workspace doesn't exist", async () => {
    // Every model call in this service is chained with `.session(session)`,
    // so every mock needs to return `{ session: () => Promise<...> }`.
    vi.mocked(WorkspaceModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(deleteWorkspaceService("ws-id", "user-id")).rejects.toThrow(
      NotFoundException
    );

    // Crucial for transaction code: verify the ABORT path actually runs on
    // failure, not just that an error was thrown. A transaction left open
    // (never committed or aborted) can hold DB locks in real MongoDB.
    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.commitTransaction).not.toHaveBeenCalled();
    expect(fakeSession.endSession).toHaveBeenCalledOnce();
  });

  it("throws ForbiddenException (403 - authenticated, but not the owner) when the requester does not own the workspace", async () => {
    // Use a REAL ObjectId for `owner` (not vi.fn()) because the service calls
    // the genuine Mongoose `.equals()` method on it - mocking mongoose itself
    // would break that, so we let real ObjectId comparison logic run.
    const actualOwnerId = makeObjectId();
    const differentUserId = makeObjectId().toString();
    const fakeWorkspace = buildFakeWorkspace({ owner: actualOwnerId });

    vi.mocked(WorkspaceModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);

    await expect(
      deleteWorkspaceService("ws-id", differentUserId)
    ).rejects.toThrow(ForbiddenException);

    expect(fakeSession.abortTransaction).toHaveBeenCalledOnce();
  });

  it("deletes projects, tasks, members, and the workspace itself on success", async () => {
    const ownerId = makeObjectId();
    const fakeWorkspace = buildFakeWorkspace({ owner: ownerId });
    // deleteOne is a DOCUMENT method (called as `workspace.deleteOne(...)`),
    // not a static model method, so it lives directly on our fake object.
    (fakeWorkspace as any).deleteOne = vi.fn().mockResolvedValue(undefined);

    const fakeUser = buildFakeUser({ currentWorkspace: fakeWorkspace._id });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(WorkspaceModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeUser),
    } as any);
    vi.mocked(ProjectModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(TaskModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(MemberModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    // Because the deleted workspace WAS the user's currentWorkspace, the
    // service looks for ANOTHER membership to fall back to.
    const fallbackMembership = buildFakeMember({ workspaceId: makeObjectId() });
    vi.mocked(MemberModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(fallbackMembership),
    } as any);

    const result = await deleteWorkspaceService(
      fakeWorkspace._id.toString(),
      ownerId.toString()
    );

    expect(ProjectModel.deleteMany).toHaveBeenCalledWith({
      workspace: fakeWorkspace._id,
    });
    expect(TaskModel.deleteMany).toHaveBeenCalledWith({
      workspace: fakeWorkspace._id,
    });
    expect(MemberModel.deleteMany).toHaveBeenCalledWith({
      workspaceId: fakeWorkspace._id,
    });
    expect((fakeWorkspace as any).deleteOne).toHaveBeenCalledOnce();
    expect(fakeSession.commitTransaction).toHaveBeenCalledOnce();
    expect(fakeSession.abortTransaction).not.toHaveBeenCalled();
    // Should have fallen back to the OTHER membership's workspace
    expect(result.currentWorkspace).toBe(fallbackMembership.workspaceId);
  });

  it("sets currentWorkspace to null when no fallback membership exists", async () => {
    const ownerId = makeObjectId();
    const fakeWorkspace = buildFakeWorkspace({ owner: ownerId });
    (fakeWorkspace as any).deleteOne = vi.fn().mockResolvedValue(undefined);
    const fakeUser = buildFakeUser({ currentWorkspace: fakeWorkspace._id });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(WorkspaceModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeWorkspace),
    } as any);
    vi.mocked(UserModel.findById).mockReturnValue({
      session: vi.fn().mockResolvedValue(fakeUser),
    } as any);
    vi.mocked(ProjectModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(TaskModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(MemberModel.deleteMany).mockReturnValue({
      session: vi.fn().mockResolvedValue(undefined),
    } as any);
    // No other membership exists for this user - simulate that.
    vi.mocked(MemberModel.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as any);

    const result = await deleteWorkspaceService(
      fakeWorkspace._id.toString(),
      ownerId.toString()
    );

    expect(result.currentWorkspace).toBeNull();
  });
});

describe("removeMemberFromWorkspaceService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(
      removeMemberFromWorkspaceService("ws-id", makeObjectId().toString())
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when attempting to remove the workspace owner", async () => {
    const ownerId = makeObjectId();
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace({ owner: ownerId }) as any
    );

    await expect(
      removeMemberFromWorkspaceService("ws-id", ownerId.toString())
    ).rejects.toThrow(BadRequestException);

    // Must fail BEFORE touching the Member collection at all.
    expect(MemberModel.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the target isn't a member of the workspace", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace() as any
    );
    vi.mocked(MemberModel.findOneAndDelete).mockResolvedValue(null as any);

    await expect(
      removeMemberFromWorkspaceService("ws-id", makeObjectId().toString())
    ).rejects.toThrow(NotFoundException);
  });

  it("deletes the member, unassigns their tasks, and clears currentWorkspace if it pointed here", async () => {
    const workspaceId = makeObjectId();
    const targetUserId = makeObjectId();
    const anotherWorkspaceId = makeObjectId();

    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace({ _id: workspaceId }) as any
    );
    vi.mocked(MemberModel.findOneAndDelete).mockResolvedValue(
      buildFakeMember({ userId: targetUserId, workspaceId }) as any
    );
    vi.mocked(TaskModel.updateMany).mockResolvedValue({} as any);

    const fakeUser = buildFakeUser({ currentWorkspace: workspaceId });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    // The user has another membership elsewhere - currentWorkspace should
    // fall back to it rather than being left dangling on the removed one.
    vi.mocked(MemberModel.findOne).mockResolvedValue(
      buildFakeMember({ workspaceId: anotherWorkspaceId }) as any
    );

    await removeMemberFromWorkspaceService(
      workspaceId.toString(),
      targetUserId.toString()
    );

    expect(MemberModel.findOneAndDelete).toHaveBeenCalledWith({
      userId: targetUserId.toString(),
      workspaceId: workspaceId.toString(),
    });
    expect(TaskModel.updateMany).toHaveBeenCalledWith(
      {
        workspace: workspaceId.toString(),
        assignedTo: targetUserId.toString(),
      },
      { assignedTo: null }
    );
    expect(fakeUser.currentWorkspace).toBe(anotherWorkspaceId);
    expect(fakeUser.save).toHaveBeenCalledOnce();
  });

  it("sets currentWorkspace to null when the removed member has no other workspace", async () => {
    const workspaceId = makeObjectId();
    const targetUserId = makeObjectId();

    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace({ _id: workspaceId }) as any
    );
    vi.mocked(MemberModel.findOneAndDelete).mockResolvedValue(
      buildFakeMember({ userId: targetUserId, workspaceId }) as any
    );
    vi.mocked(TaskModel.updateMany).mockResolvedValue({} as any);

    const fakeUser = buildFakeUser({ currentWorkspace: workspaceId });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);
    vi.mocked(MemberModel.findOne).mockResolvedValue(null as any);

    await removeMemberFromWorkspaceService(
      workspaceId.toString(),
      targetUserId.toString()
    );

    expect(fakeUser.currentWorkspace).toBeNull();
    expect(fakeUser.save).toHaveBeenCalledOnce();
  });

  it("does not touch the removed user's currentWorkspace when it points elsewhere", async () => {
    const workspaceId = makeObjectId();
    const targetUserId = makeObjectId();
    const otherWorkspaceId = makeObjectId();

    vi.mocked(WorkspaceModel.findById).mockResolvedValue(
      buildFakeWorkspace({ _id: workspaceId }) as any
    );
    vi.mocked(MemberModel.findOneAndDelete).mockResolvedValue(
      buildFakeMember({ userId: targetUserId, workspaceId }) as any
    );
    vi.mocked(TaskModel.updateMany).mockResolvedValue({} as any);

    const fakeUser = buildFakeUser({ currentWorkspace: otherWorkspaceId });
    fakeUser.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(UserModel.findById).mockResolvedValue(fakeUser as any);

    await removeMemberFromWorkspaceService(
      workspaceId.toString(),
      targetUserId.toString()
    );

    expect(fakeUser.currentWorkspace).toBe(otherWorkspaceId);
    expect(fakeUser.save).not.toHaveBeenCalled();
  });
});

describe("resetWorkspaceInviteCodeService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the workspace doesn't exist", async () => {
    vi.mocked(WorkspaceModel.findById).mockResolvedValue(null as any);

    await expect(resetWorkspaceInviteCodeService("ws-id")).rejects.toThrow(
      NotFoundException
    );
  });

  it("calls resetInviteCode(), saves, and returns the updated workspace", async () => {
    const fakeWorkspace = buildFakeWorkspace() as any;
    fakeWorkspace.resetInviteCode = vi.fn(() => {
      fakeWorkspace.inviteCode = "NEW-CODE";
    });
    fakeWorkspace.save = vi.fn().mockResolvedValue(undefined);

    vi.mocked(WorkspaceModel.findById).mockResolvedValue(fakeWorkspace);

    const result = await resetWorkspaceInviteCodeService("ws-id");

    expect(fakeWorkspace.resetInviteCode).toHaveBeenCalledOnce();
    expect(fakeWorkspace.save).toHaveBeenCalledOnce();
    expect(result.workspace.inviteCode).toBe("NEW-CODE");
  });
});
