/**
 * UNIT TESTS: task.controller.ts
 * -----------------------------------
 * Same pattern as project.controller.test.ts / workspace.controller.test.ts:
 * everything the controller depends on is mocked (task.service, member.service,
 * roleGuard) - we only verify parsing/permission-check/service-call/response-shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createTaskController,
  updateTaskController,
  getAllTasksController,
  getTaskByIdController,
  deleteTaskController,
} from "../../../src/controllers/task.controller";

import * as taskService from "../../../src/services/task.service";
import * as memberService from "../../../src/services/member.service";
import { roleGuard } from "../../../src/utils/roleGuard";
import { createMockReqRes } from "../../setup/mockExpress";
import { buildFakeTask } from "../../setup/testFixtures";

vi.mock("../../../src/services/task.service");
vi.mock("../../../src/services/member.service");
vi.mock("../../../src/utils/roleGuard");

describe("createTaskController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses body/params, checks CREATE_TASK permission, and responds 200 with the task", async () => {
    const fakeTask = buildFakeTask({ title: "New Task" });
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(taskService.createTaskService).mockResolvedValue({
      task: fakeTask,
    } as any);

    const { req, res, next } = createMockReqRes({
      body: { title: "New Task", priority: "MEDIUM", status: "TODO" },
      params: {
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await createTaskController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["CREATE_TASK"]);
    expect(taskService.createTaskService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2",
      "user-1",
      { title: "New Task", priority: "MEDIUM", status: "TODO" }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task created successfully",
        task: fakeTask,
      })
    );
  });

  it("propagates validation errors to next() without calling the service", async () => {
    const { req, res, next } = createMockReqRes({
      body: {},
      params: {
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await createTaskController(req, res, next);

    expect(taskService.createTaskService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not call the service if roleGuard throws", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      body: { title: "T", priority: "MEDIUM", status: "TODO" },
      params: {
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await createTaskController(req, res, next);

    expect(taskService.createTaskService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("updateTaskController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks EDIT_TASK permission and responds 200 with the updated task", async () => {
    const fakeTask = buildFakeTask({ title: "Updated" });
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(taskService.updateTaskService).mockResolvedValue({
      updatedTask: fakeTask,
    } as any);

    const { req, res, next } = createMockReqRes({
      body: { title: "Updated", priority: "LOW", status: "DONE" },
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await updateTaskController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["EDIT_TASK"]);
    expect(taskService.updateTaskService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2",
      "64f1a2b3c4d5e6f7a8b9c0d3",
      { title: "Updated", priority: "LOW", status: "DONE" }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task updated successfully",
        task: fakeTask,
      })
    );
  });

  it("does not call the service if roleGuard throws", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      body: { title: "T", priority: "LOW", status: "DONE" },
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await updateTaskController(req, res, next);

    expect(taskService.updateTaskService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("getAllTasksController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses comma-separated filters and pagination from the query string", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(taskService.getAllTasksService).mockResolvedValue({
      tasks: [],
      pagination: {
        pageSize: 5,
        pageNumber: 2,
        totalCount: 0,
        totalPages: 0,
        skip: 5,
      },
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
      query: {
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        status: "TODO,DONE",
        priority: "HIGH",
        assignedTo: "64f1a2b3c4d5e6f7a8b9c0d3,64f1a2b3c4d5e6f7a8b9c0d4",
        keyword: "urgent",
        dueDate: "2026-01-01",
        pageSize: "5",
        pageNumber: "2",
      },
    });

    await getAllTasksController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("MEMBER", ["VIEW_ONLY"]);
    expect(taskService.getAllTasksService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      {
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        status: ["TODO", "DONE"],
        priority: ["HIGH"],
        assignedTo: ["64f1a2b3c4d5e6f7a8b9c0d3", "64f1a2b3c4d5e6f7a8b9c0d4"],
        keyword: "urgent",
        dueDate: "2026-01-01",
      },
      { pageSize: 5, pageNumber: 2 }
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("defaults pagination and leaves filters undefined when the query string is empty", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(taskService.getAllTasksService).mockResolvedValue({
      tasks: [],
      pagination: {},
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await getAllTasksController(req, res, next);

    expect(taskService.getAllTasksService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      {
        projectId: undefined,
        status: undefined,
        priority: undefined,
        assignedTo: undefined,
        keyword: undefined,
        dueDate: undefined,
      },
      { pageSize: 10, pageNumber: 1 }
    );
  });

  it("propagates an error to next() when the user isn't a member", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockRejectedValue(
      new Error("Not a member")
    );

    const { req, res, next } = createMockReqRes({
      params: { workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1" },
    });

    await getAllTasksController(req, res, next);

    expect(taskService.getAllTasksService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("getTaskByIdController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks VIEW_ONLY permission and returns the task with 200", async () => {
    const fakeTask = buildFakeTask();
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(taskService.getTaskByIdService).mockResolvedValue(
      fakeTask as any
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await getTaskByIdController(req, res, next);

    expect(taskService.getTaskByIdService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d2",
      "64f1a2b3c4d5e6f7a8b9c0d3"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Task fetched successfully",
        task: fakeTask,
      })
    );
  });

  it("propagates a not-found error to next()", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "MEMBER",
    } as any);
    vi.mocked(taskService.getTaskByIdService).mockRejectedValue(
      new Error("Task not found.")
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        projectId: "64f1a2b3c4d5e6f7a8b9c0d2",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await getTaskByIdController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("deleteTaskController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks DELETE_TASK permission and responds 200 on success", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(taskService.deleteTaskService).mockResolvedValue(
      undefined as any
    );

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
      user: { _id: "user-1" },
    });

    await deleteTaskController(req, res, next);

    expect(roleGuard).toHaveBeenCalledWith("OWNER", ["DELETE_TASK"]);
    expect(taskService.deleteTaskService).toHaveBeenCalledWith(
      "64f1a2b3c4d5e6f7a8b9c0d1",
      "64f1a2b3c4d5e6f7a8b9c0d3"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Task deleted successfully" })
    );
  });

  it("does not call the service if roleGuard throws", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      params: {
        id: "64f1a2b3c4d5e6f7a8b9c0d3",
        workspaceId: "64f1a2b3c4d5e6f7a8b9c0d1",
      },
    });

    await deleteTaskController(req, res, next);

    expect(taskService.deleteTaskService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
