/**
 * MODEL TESTS: task.model.ts
 * ------------------------------
 * Real in-memory MongoDB, no mocks.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import TaskModel from "../../../src/models/task.model";

function ids() {
  return {
    project: new mongoose.Types.ObjectId(),
    workspace: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
  };
}

describe("TaskModel", () => {
  it("auto-generates a taskCode via the schema default", async () => {
    const task = await TaskModel.create({ title: "Task A", ...ids() });
    expect(task.taskCode).toMatch(/^task-[0-9a-f]{3}$/);
  });

  it("rejects a duplicate taskCode (unique index)", async () => {
    const first = await TaskModel.create({ title: "Task A", ...ids() });

    await expect(
      TaskModel.create({ title: "Task B", ...ids(), taskCode: first.taskCode })
    ).rejects.toThrow();
  });

  it("defaults status to TODO and priority to MEDIUM when omitted", async () => {
    const task = await TaskModel.create({ title: "Defaults", ...ids() });
    expect(task.status).toBe("TODO");
    expect(task.priority).toBe("MEDIUM");
  });

  it("rejects an invalid status enum value at the Mongoose validation layer", async () => {
    await expect(
      TaskModel.create({
        title: "Bad Status",
        ...ids(),
        status: "NOT_A_REAL_STATUS",
      })
    ).rejects.toThrow();
  });

  it("rejects an invalid priority enum value at the Mongoose validation layer", async () => {
    await expect(
      TaskModel.create({
        title: "Bad Priority",
        ...ids(),
        priority: "SUPER_URGENT",
      })
    ).rejects.toThrow();
  });
});
