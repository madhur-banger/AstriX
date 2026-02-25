/**
 * MODEL TESTS: workspace.model.ts
 * -----------------------------------
 * Real in-memory MongoDB, no mocks.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import WorkspaceModel from "../../../src/models/workspace.model";

describe("WorkspaceModel", () => {
  it("auto-generates an inviteCode via the schema default when none is given", async () => {
    const workspace = await WorkspaceModel.create({
      name: "Auto Invite Workspace",
      owner: new mongoose.Types.ObjectId(),
    });

    expect(workspace.inviteCode).toBeTruthy();
    expect(workspace.inviteCode).toHaveLength(8);
  });

  it("rejects a duplicate inviteCode (unique index)", async () => {
    const first = await WorkspaceModel.create({
      name: "First",
      owner: new mongoose.Types.ObjectId(),
    });

    await expect(
      WorkspaceModel.create({
        name: "Second",
        owner: new mongoose.Types.ObjectId(),
        inviteCode: first.inviteCode,
      })
    ).rejects.toThrow();
  });

  it("resetInviteCode() changes the inviteCode to a new value", async () => {
    const workspace = await WorkspaceModel.create({
      name: "Reset Test",
      owner: new mongoose.Types.ObjectId(),
    });
    const originalCode = workspace.inviteCode;

    (workspace as any).resetInviteCode();

    expect(workspace.inviteCode).not.toBe(originalCode);
    expect(workspace.inviteCode).toHaveLength(8);
  });
});
