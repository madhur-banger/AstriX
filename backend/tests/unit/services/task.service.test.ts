/**
 * UNIT TESTS: task.service.ts
 * -------------------------------
 * Mocks TaskModel/ProjectModel/MemberModel entirely - see
 * tests/unit/services/workspace.service.test.ts for the chain-mocking
 * conventions reused here (constructor mocks via `asConstructorMock`,
 * multi-link query chains built one `.mockReturnValue`/`.mockResolvedValue`
 * at a time).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createTaskService,
  updateTaskService,
  getAllTasksService,
  getTaskByIdService,
  deleteTaskService,
} from "../../../src/services/task.service";

import TaskModel from "../../../src/models/task.model";
import ProjectModel from "../../../src/models/project.model";
import MemberModel from "../../../src/models/member.model";
import {
  asConstructorMock,
  buildFakeProject,
  makeObjectId,
} from "../../setup/testFixtures";

vi.mock("../../../src/models/task.model");
vi.mock("../../../src/models/project.model");
vi.mock("../../../src/models/member.model");

describe("createTaskService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a task scoped to the given project/workspace and returns it", async () => {
    const workspaceId = String(makeObjectId());
    const projectId = String(makeObjectId());
    const userId = String(makeObjectId());
    const fakeProject = buildFakeProject({ workspace: workspaceId });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);

    const taskSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(TaskModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: taskSave }) as any)
    );

    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "New Task",
      priority: "HIGH",
      status: "TODO",
    });

    expect(taskSave).toHaveBeenCalledOnce();
    expect(task).toMatchObject({
      title: "New Task",
      priority: "HIGH",
      status: "TODO",
      createdBy: userId,
      workspace: workspaceId,
      project: projectId,
    });
  });

  it("throws NotFoundException when the project doesn't exist", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(null as any);

    await expect(
      createTaskService("ws-1", "missing-project", "user-1", {
        title: "T",
        priority: "MEDIUM",
        status: "TODO",
      })
    ).rejects.toThrow("Project not found or does not belong to this workspace");

    expect(TaskModel).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the project belongs to a different workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "other-ws" }) as any
    );

    await expect(
      createTaskService("ws-1", "project-1", "user-1", {
        title: "T",
        priority: "MEDIUM",
        status: "TODO",
      })
    ).rejects.toThrow("Project not found or does not belong to this workspace");
  });

  it("throws when assignedTo is not a member of the workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );
    vi.mocked(MemberModel.exists).mockResolvedValue(null as any);

    await expect(
      createTaskService("ws-1", "project-1", "user-1", {
        title: "T",
        priority: "MEDIUM",
        status: "TODO",
        assignedTo: "not-a-member",
      })
    ).rejects.toThrow("Assigned user is not a member of this workspace");

    expect(MemberModel.exists).toHaveBeenCalledWith({
      userId: "not-a-member",
      workspaceId: "ws-1",
    });
    expect(TaskModel).not.toHaveBeenCalled();
  });

  it("creates the task when assignedTo IS a valid member of the workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );
    vi.mocked(MemberModel.exists).mockResolvedValue({ _id: "member-1" } as any);

    const taskSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(TaskModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: taskSave }) as any)
    );

    const { task } = await createTaskService("ws-1", "project-1", "user-1", {
      title: "T",
      priority: "MEDIUM",
      status: "TODO",
      assignedTo: "member-user-id",
    });

    expect(task.assignedTo).toBe("member-user-id");
  });

  it("falls back to MEDIUM priority and TODO status when given falsy values", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(
      buildFakeProject({ workspace: "ws-1" }) as any
    );

    const taskSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(TaskModel).mockImplementation(
      asConstructorMock((data: any) => ({ ...data, save: taskSave }) as any)
    );

    const { task } = await createTaskService("ws-1", "project-1", "user-1", {
      title: "T",
      priority: "" as any,
      status: "" as any,
    });

    expect(task.priority).toBe("MEDIUM");
    expect(task.status).toBe("TODO");
  });
});

describe("updateTaskService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("updates and returns the task when project/task scoping is valid", async () => {
    const fakeProject = buildFakeProject({ workspace: "ws-1" });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);
    vi.mocked(TaskModel.findById).mockResolvedValue({
      project: fakeProject._id,
    } as any);
    const updatedTask = { title: "Updated" };
    vi.mocked(TaskModel.findByIdAndUpdate).mockResolvedValue(
      updatedTask as any
    );

    const result = await updateTaskService(
      "ws-1",
      String(fakeProject._id),
      "task-1",
      { title: "Updated", priority: "LOW", status: "DONE" }
    );

    expect(TaskModel.findByIdAndUpdate).toHaveBeenCalledWith(
      "task-1",
      { title: "Updated", priority: "LOW", status: "DONE" },
      { new: true }
    );
    expect(result).toEqual({ updatedTask });
  });

  it("throws NotFoundException when the project doesn't belong to the workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(null as any);

    await expect(
      updateTaskService("ws-1", "project-1", "task-1", {
        title: "T",
        priority: "LOW",
        status: "TODO",
      })
    ).rejects.toThrow("Project not found or does not belong to this workspace");
  });

  it("throws NotFoundException when the task doesn't belong to the project", async () => {
    const fakeProject = buildFakeProject({ workspace: "ws-1" });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);
    vi.mocked(TaskModel.findById).mockResolvedValue({
      project: "some-other-project",
    } as any);

    await expect(
      updateTaskService("ws-1", String(fakeProject._id), "task-1", {
        title: "T",
        priority: "LOW",
        status: "TODO",
      })
    ).rejects.toThrow("Task not found or does not belong to this project");
  });

  it("throws BadRequestException when findByIdAndUpdate returns null", async () => {
    const fakeProject = buildFakeProject({ workspace: "ws-1" });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);
    vi.mocked(TaskModel.findById).mockResolvedValue({
      project: fakeProject._id,
    } as any);
    vi.mocked(TaskModel.findByIdAndUpdate).mockResolvedValue(null as any);

    await expect(
      updateTaskService("ws-1", String(fakeProject._id), "task-1", {
        title: "T",
        priority: "LOW",
        status: "TODO",
      })
    ).rejects.toThrow("Failed to update task");
  });
});

function mockFindChain(resolvedValue: any) {
  const populate2 = vi.fn().mockResolvedValue(resolvedValue);
  const populate1 = vi.fn().mockReturnValue({ populate: populate2 });
  const sort = vi.fn().mockReturnValue({ populate: populate1 });
  const limit = vi.fn().mockReturnValue({ sort });
  const skip = vi.fn().mockReturnValue({ limit });
  return { skip };
}

describe("getAllTasksService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("builds a workspace-only query and computes pagination when no filters are given", async () => {
    const { skip } = mockFindChain([]);
    vi.mocked(TaskModel.find).mockReturnValue({ skip } as any);
    vi.mocked(TaskModel.countDocuments).mockResolvedValue(0 as any);

    const result = await getAllTasksService(
      "ws-1",
      {},
      { pageSize: 10, pageNumber: 1 }
    );

    expect(TaskModel.find).toHaveBeenCalledWith({ workspace: "ws-1" });
    expect(result.pagination).toEqual({
      pageSize: 10,
      pageNumber: 1,
      totalCount: 0,
      totalPages: 0,
      skip: 0,
    });
  });

  it("adds $in filters for status/priority/assignedTo and a keyword regex on title", async () => {
    const { skip } = mockFindChain([]);
    vi.mocked(TaskModel.find).mockReturnValue({ skip } as any);
    vi.mocked(TaskModel.countDocuments).mockResolvedValue(0 as any);

    await getAllTasksService(
      "ws-1",
      {
        projectId: "project-1",
        status: ["TODO", "DONE"],
        priority: ["HIGH"],
        assignedTo: ["user-1"],
        keyword: "urgent",
        dueDate: "2026-01-01",
      },
      { pageSize: 10, pageNumber: 1 }
    );

    expect(TaskModel.find).toHaveBeenCalledWith({
      workspace: "ws-1",
      project: "project-1",
      status: { $in: ["TODO", "DONE"] },
      priority: { $in: ["HIGH"] },
      assignedTo: { $in: ["user-1"] },
      title: { $regex: "urgent", $options: "i" },
      dueDate: { $eq: new Date("2026-01-01") },
    });
  });

  it("escapes regex metacharacters in the keyword before building $regex (ReDoS/regex-injection guard)", async () => {
    const { skip } = mockFindChain([]);
    vi.mocked(TaskModel.find).mockReturnValue({ skip } as any);
    vi.mocked(TaskModel.countDocuments).mockResolvedValue(0 as any);

    // A classic catastrophic-backtracking pattern - if this reached Mongo
    // unescaped, it would be interpreted as regex rather than matched
    // literally.
    await getAllTasksService(
      "ws-1",
      { keyword: "(a+)+$" },
      { pageSize: 10, pageNumber: 1 }
    );

    expect(TaskModel.find).toHaveBeenCalledWith({
      workspace: "ws-1",
      title: { $regex: "\\(a\\+\\)\\+\\$", $options: "i" },
    });
  });

  it("computes skip/totalPages correctly for a later page", async () => {
    const { skip } = mockFindChain([]);
    vi.mocked(TaskModel.find).mockReturnValue({ skip } as any);
    vi.mocked(TaskModel.countDocuments).mockResolvedValue(25 as any);

    const result = await getAllTasksService(
      "ws-1",
      {},
      { pageSize: 10, pageNumber: 3 }
    );

    expect(skip).toHaveBeenCalledWith(20);
    expect(result.pagination).toEqual({
      pageSize: 10,
      pageNumber: 3,
      totalCount: 25,
      totalPages: 3,
      skip: 20,
    });
  });
});

describe("getTaskByIdService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the task when scoped correctly", async () => {
    const fakeProject = buildFakeProject({ workspace: "ws-1" });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);
    const fakeTask = { _id: "task-1", title: "T" };
    vi.mocked(TaskModel.findOne).mockReturnValue({
      populate: vi.fn().mockResolvedValue(fakeTask),
    } as any);

    const result = await getTaskByIdService(
      "ws-1",
      String(fakeProject._id),
      "task-1"
    );

    expect(TaskModel.findOne).toHaveBeenCalledWith({
      _id: "task-1",
      workspace: "ws-1",
      project: String(fakeProject._id),
    });
    expect(result).toEqual(fakeTask);
  });

  it("throws NotFoundException when the project doesn't belong to the workspace", async () => {
    vi.mocked(ProjectModel.findById).mockResolvedValue(null as any);

    await expect(
      getTaskByIdService("ws-1", "project-1", "task-1")
    ).rejects.toThrow("Project not found or does not belong to this workspace");
  });

  it("throws NotFoundException when the task doesn't exist", async () => {
    const fakeProject = buildFakeProject({ workspace: "ws-1" });
    vi.mocked(ProjectModel.findById).mockResolvedValue(fakeProject as any);
    vi.mocked(TaskModel.findOne).mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    } as any);

    await expect(
      getTaskByIdService("ws-1", String(fakeProject._id), "task-1")
    ).rejects.toThrow("Task not found.");
  });
});

describe("deleteTaskService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deletes the task when found in the workspace", async () => {
    vi.mocked(TaskModel.findOneAndDelete).mockResolvedValue({
      _id: "task-1",
    } as any);

    await expect(deleteTaskService("ws-1", "task-1")).resolves.toBeUndefined();

    expect(TaskModel.findOneAndDelete).toHaveBeenCalledWith({
      _id: "task-1",
      workspace: "ws-1",
    });
  });

  it("throws NotFoundException when the task doesn't belong to the workspace", async () => {
    vi.mocked(TaskModel.findOneAndDelete).mockResolvedValue(null as any);

    await expect(deleteTaskService("ws-1", "task-1")).rejects.toThrow(
      "Task not found or does not belong to the specified workspace"
    );
  });
});
