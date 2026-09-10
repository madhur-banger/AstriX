/**
 * INTEGRATION TESTS: workspace.service.ts
 * -------------------------------------------
 * Unlike the unit test file, we do NOT mock any Mongoose models here.
 * Every model import below is the REAL one from src/models. Because
 * tests/setup/vitest.setup.ts already connected mongoose to an in-memory
 * MongoDB before this file runs, every `.save()`, `.find()`, `.findById()`
 * etc. actually reads/writes real documents (that just happen to live in
 * RAM instead of on disk / in the cloud).
 *
 * WHY BOTHER, IF WE ALREADY HAVE UNIT TESTS?
 * Because unit tests can only ever be as correct as the mocks you wrote.
 * If you get a filter field name wrong (e.g. `{ workspace: id }` instead of
 * `{ workspaceId: id }`), a mocked test won't notice - YOU told the mock to
 * return data for that exact call, so it happily does. A REAL query with a
 * wrong field name just silently returns zero results, and only an
 * integration test against a real DB will expose that.
 *
 * ASSUMPTION CALLOUT:
 * We don't have the source for user.model.ts / member.model.ts /
 * roles-permission.model.ts / project.model.ts / task.model.ts in this
 * conversation, so the required fields used in `.create({...})` below are
 * a best guess based on how they're referenced in workspace.service.ts.
 * If Mongoose throws a "path `X` is required" validation error when you
 * run this, just add the missing field(s) to the relevant `buildFake*`
 * factory call - that error message tells you exactly what's missing.
 */

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

import {
  createWorkspaceService,
  getWorkspaceByIdService,
  updateWorkspaceByIdService,
  deleteWorkspaceService,
} from "../../src/services/workspace.service";

import UserModel from "../../src/models/user.model";
import RoleModel from "../../src/models/roles-permission.model";
import MemberModel from "../../src/models/member.model";
import WorkspaceModel from "../../src/models/workspace.model";
import { Roles } from "../../src/enums/role.enum";
import {
  NotFoundException,
  ForbiddenException,
} from "../../src/utils/appError";

describe("workspace.service (integration - real in-memory MongoDB)", () => {
  let userId: string;

  beforeEach(async () => {
    // Seed exactly what createWorkspaceService needs to find in a REAL DB:
    // an OWNER role document, and a real user document.
    // Adjust these fields if your real schemas require more (e.g. a
    // hashed password field, a required `provider` field, etc.)
    await RoleModel.create({ name: Roles.OWNER, permissions: [] });

    const user = await UserModel.create({
      name: "Integration Test User",
      email: `integration-${Date.now()}@example.com`,
      // If UserModel requires a password field, add one here, e.g.:
      // password: "hashed-value-irrelevant-for-this-test",
    });
    userId = user._id.toString();
  });

  it("persists a real workspace document and links it via a real member document", async () => {
    // Act
    const { workspace } = await createWorkspaceService(userId, {
      name: "Integration Workspace",
      description: "created for real via mongoose",
    });

    // Assert: re-read from the DB independently of the function under test,
    // to prove the write actually landed (not just that the in-memory
    // return value looked right).
    const persistedWorkspace = await WorkspaceModel.findById(workspace._id);
    expect(persistedWorkspace).not.toBeNull();
    expect(persistedWorkspace!.name).toBe("Integration Workspace");
    // inviteCode has a `default: generateInviteCode` in the schema - verify
    // the default actually fired, since defaults are a common source of
    // "works in mocked tests, mysteriously null in prod" bugs.
    expect(persistedWorkspace!.inviteCode).toBeTruthy();

    const member = await MemberModel.findOne({ workspaceId: workspace._id });
    expect(member).not.toBeNull();
    expect(member!.userId.toString()).toBe(userId);

    const updatedUser = await UserModel.findById(userId);
    expect(updatedUser!.currentWorkspace?.toString()).toBe(
      workspace._id.toString()
    );
  });

  it("throws NotFoundException for a well-formed but non-existent workspace id", async () => {
    const randomButValidId = new mongoose.Types.ObjectId().toString();

    await expect(getWorkspaceByIdService(randomButValidId)).rejects.toThrow(
      NotFoundException
    );
  });

  it("update then re-fetch reflects the new name in the real DB", async () => {
    const { workspace } = await createWorkspaceService(userId, {
      name: "Before Update",
    });

    await updateWorkspaceByIdService(workspace._id.toString(), "After Update");

    const refetched = await WorkspaceModel.findById(workspace._id);
    expect(refetched!.name).toBe("After Update");
  });

  it("deleting a workspace really removes its member documents (cascade check)", async () => {
    const { workspace } = await createWorkspaceService(userId, {
      name: "To Be Deleted",
    });

    // Sanity check: the member exists before we delete anything.
    const beforeDelete = await MemberModel.find({ workspaceId: workspace._id });
    expect(beforeDelete.length).toBe(1);

    await deleteWorkspaceService(workspace._id.toString(), userId);

    const afterDelete = await MemberModel.find({ workspaceId: workspace._id });
    expect(afterDelete.length).toBe(0);

    const workspaceStillExists = await WorkspaceModel.findById(workspace._id);
    expect(workspaceStillExists).toBeNull();
  });

  it("rejects deletion attempted by a user who is not the owner", async () => {
    const { workspace } = await createWorkspaceService(userId, {
      name: "Owned Workspace",
    });

    const otherUser = await UserModel.create({
      name: "Someone Else",
      email: `other-${Date.now()}@example.com`,
    });

    await expect(
      deleteWorkspaceService(workspace._id.toString(), otherUser._id.toString())
    ).rejects.toThrow(ForbiddenException);

    // Confirm the workspace was NOT deleted despite the failed attempt -
    // this is exactly the kind of guarantee a real transaction should provide,
    // and only an integration test can actually verify it held.
    const stillThere = await WorkspaceModel.findById(workspace._id);
    expect(stillThere).not.toBeNull();
  });
});
