/**
 * UNIT TESTS: project.service.ts
 * -------------------------------------
 * This is the biggest silent gap flagged in PLAN.md: project.service.ts's
 * own logic was previously only ever exercised as a `vi.mock` target inside
 * project.controller.test.ts - none of its query/aggregation/cascade logic
 * had ever run against a real assertion. This file closes that gap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

import {
  createProjectService,
  getProjectsInWorkspaceService,
  getProjectByIdAndWorkspaceIdService,
  getProjectAnalyticsService,
  updateProjectService,
  deleteProjectService,
} from "../../../src/services/project.service";

import ProjectModel from "../../../src/models/project.model";
import TaskModel from "../../../src/models/task.model";
import { asConstructorMock, buildFakeProject } from "../../setup/testFixtures";

vi.mock("../../../src/models/project.model");
vi.mock("../../../src/models/task.model");

describe("createProjectService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("includes emoji in the created document when provided", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let captured: any;
    vi.mocked(ProjectModel).mockImplementation(
      asConstructorMock((data: any) => {
        captured = { ...data, save };
        return captured;
      })
    );

    await createProjectService("user-1", "ws-1", {
      name: "New Project",
      emoji: "🚀",
    });

    expect(captured.emoji).toBe("🚀");
    expect(save).toHaveBeenCalledOnce();
  });

  it("omits the emoji field entirely when not provided (conditional spread)", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let captured: any;
    vi.mocked(ProjectModel).mockImplementation(
      asConstructorMock((data: any) => {
        captured = { ...data, save };
        return captured;
      })
    );

    await createProjectService("user-1", "ws-1", { name: "No Emoji" });

    expect(captured).not.toHaveProperty("emoji");
  });
});

describe("getProjectsInWorkspaceService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("computes totalPages from totalCount/pageSize and calls find with skip/limit", async () => {
    vi.mocked(ProjectModel.countDocuments).mockResolvedValue(25 as any);

    const sort = vi.fn().mockResolvedValue([]);
    const populate = vi.fn().mockReturnValue({ sort });
    const limit = vi.fn().mockReturnValue({ populate });
    const skip = vi.fn().mockReturnValue({ limit });
    vi.mocked(ProjectModel.find).mockReturnValue({ skip } as any);

    const result = await getProjectsInWorkspaceService("ws-1", 10, 3);

    expect(ProjectModel.find).toHaveBeenCalledWith({ workspace: "ws-1" });
    expect(skip).toHaveBeenCalledWith(20);
    expect(limit).toHaveBeenCalledWith(10);
    expect(result).toEqual({
      projects: [],
      totalCount: 25,
      totalPages: 3,
      skip: 20,
    });
  });
});

describe("getProjectByIdAndWorkspaceIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the project when scoped correctly", async () => {
    const fakeProject = buildFakeProject();
    vi.mocked(ProjectModel.findOne).mockReturnValue({
      select: vi.fn().mockResolvedValue(fakeProject),
    } as any);

    const result = await getProjectByIdAndWorkspaceIdService(
      "ws-1",
      String(fakeProject._id)
    );

    expect(ProjectModel.findOne).toHaveBeenCalledWith({
      _id: String(fakeProject._id),
      workspace: "ws-1",
    });
    expect(result).toEqual({ project: fakeProject });
  });

  it("throws NotFoundException when not found", async () => {
    vi.mocked(ProjectModel.findOne).mockReturnValue({
      select: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      getProjectByIdAndWorkspaceIdService("ws-1", "missing")
    ).rejects.toThrow(
      "Project not found or does not belong to the specified workspace"
    );
  });
});

describe("getProjectAnalyticsService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("throws NotFoundException when the project doesn't belong to the workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(null as any);

    await expect(
      getProjectAnalyticsService(
        "ws-1",
        new mongoose.Types.ObjectId().toString()
      )
    ).rejects.toThrow("Project not found or does not belong to this workspace");

    expect(TaskModel.aggregate).not.toHaveBeenCalled();
  });

  it("maps a fully-populated $facet result to totalTasks/overdueTasks/completedTasks", async () => {
    const projectId = new mongoose.Types.ObjectId().toString();
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );
    vi.mocked(TaskModel.aggregate).mockResolvedValue([
      {
        totalTasks: [{ count: 10 }],
        overdueTasks: [{ count: 2 }],
        completedTasks: [{ count: 5 }],
      },
    ] as any);

    const { analytics } = await getProjectAnalyticsService("ws-1", projectId);

    expect(analytics).toEqual({
      totalTasks: 10,
      overdueTasks: 2,
      completedTasks: 5,
    });
  });

  it("falls back to 0 for each facet when its array is empty (no matching tasks)", async () => {
    const projectId = new mongoose.Types.ObjectId().toString();
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );
    vi.mocked(TaskModel.aggregate).mockResolvedValue([
      { totalTasks: [], overdueTasks: [], completedTasks: [] },
    ] as any);

    const { analytics } = await getProjectAnalyticsService("ws-1", projectId);

    expect(analytics).toEqual({
      totalTasks: 0,
      overdueTasks: 0,
      completedTasks: 0,
    });
  });

  it("falls back to 0 for only the empty facets in a partial result", async () => {
    const projectId = new mongoose.Types.ObjectId().toString();
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );
    vi.mocked(TaskModel.aggregate).mockResolvedValue([
      {
        totalTasks: [{ count: 3 }],
        overdueTasks: [],
        completedTasks: [{ count: 1 }],
      },
    ] as any);

    const { analytics } = await getProjectAnalyticsService("ws-1", projectId);

    expect(analytics).toEqual({
      totalTasks: 3,
      overdueTasks: 0,
      completedTasks: 1,
    });
  });
});

describe("updateProjectService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("only updates fields that are actually provided (partial update semantics)", async () => {
    const fakeProject: any = buildFakeProject({
      name: "Original",
      description: "Original description",
      emoji: "📊",
    });
    fakeProject.save = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ProjectModel.findOne).mockResolvedValue(fakeProject);

    const { project } = await updateProjectService(
      "ws-1",
      String(fakeProject._id),
      { name: "Renamed" }
    );

    expect(project.name).toBe("Renamed");
    expect(project.description).toBe("Original description");
    expect(project.emoji).toBe("📊");
    expect(fakeProject.save).toHaveBeenCalledOnce();
  });

  it("throws NotFoundException when the project doesn't belong to the workspace", async () => {
    vi.mocked(ProjectModel.findOne).mockResolvedValue(null as any);

    await expect(
      updateProjectService("ws-1", "missing", { name: "X" })
    ).rejects.toThrow(
      "Project not found or does not belong to the specified workspace"
    );
  });
});

describe("deleteProjectService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deletes the project and cascades TaskModel.deleteMany for its tasks", async () => {
    const fakeProject: any = buildFakeProject();
    fakeProject.deleteOne = vi.fn().mockResolvedValue(undefined);
    vi.mocked(ProjectModel.findOne).mockResolvedValue(fakeProject);
    vi.mocked(TaskModel.deleteMany).mockResolvedValue({} as any);

    const result = await deleteProjectService("ws-1", String(fakeProject._id));

    expect(fakeProject.deleteOne).toHaveBeenCalledOnce();
    expect(TaskModel.deleteMany).toHaveBeenCalledWith({
      project: fakeProject._id,
    });
    expect(result).toBe(fakeProject);
  });

  it("throws NotFoundException when the project doesn't belong to the workspace, and never cascades", async () => {
    vi.mocked(ProjectModel.findOne).mockResolvedValue(null as any);

    await expect(deleteProjectService("ws-1", "missing")).rejects.toThrow(
      "Project not found or does not belong to the specified workspace"
    );

    expect(TaskModel.deleteMany).not.toHaveBeenCalled();
  });
});
