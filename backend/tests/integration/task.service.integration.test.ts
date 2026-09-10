/**
 * INTEGRATION TESTS: task.service.ts
 * ---------------------------------------
 * Real Mongoose models against the in-memory MongoDB from
 * tests/setup/vitest.setup.ts - no model mocks. See
 * tests/integration/workspace.service.integration.test.ts for why this
 * layer exists alongside the mocked unit tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";

import {
  createTaskService,
  updateTaskService,
  getAllTasksService,
  getTaskByIdService,
  deleteTaskService,
} from "../../src/services/task.service";
import { deleteProjectService } from "../../src/services/project.service";

import UserModel from "../../src/models/user.model";
import WorkspaceModel from "../../src/models/workspace.model";
import ProjectModel from "../../src/models/project.model";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import TaskModel from "../../src/models/task.model";
import { Roles } from "../../src/enums/role.enum";
import { NotFoundException } from "../../src/utils/appError";

describe("task.service (integration - real in-memory MongoDB)", () => {
  let userId: string;
  let workspaceId: string;
  let projectId: string;

  beforeEach(async () => {
    const user = await UserModel.create({
      name: "Task Integration User",
      email: `task-integration-${Date.now()}@example.com`,
    });
    userId = user._id.toString();

    const workspace = await WorkspaceModel.create({
      name: "Task Integration Workspace",
      owner: user._id,
    });
    workspaceId = workspace._id.toString();

    const project = await ProjectModel.create({
      name: "Task Integration Project",
      workspace: workspace._id,
      createdBy: user._id,
    });
    projectId = project._id.toString();
  });

  it("creates a task with default status/priority and a generated taskCode", async () => {
    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "Persisted Task",
      priority: "" as any,
      status: "" as any,
    });

    const persisted = await TaskModel.findById(task._id);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("TODO");
    expect(persisted!.priority).toBe("MEDIUM");
    expect(persisted!.taskCode).toBeTruthy();
  });

  it("rejects creation when the project belongs to a different workspace", async () => {
    const otherWorkspace = await WorkspaceModel.create({
      name: "Other Workspace",
      owner: new mongoose.Types.ObjectId(userId),
    });

    await expect(
      createTaskService(otherWorkspace._id.toString(), projectId, userId, {
        title: "T",
        priority: "MEDIUM",
        status: "TODO",
      })
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects creation when assignedTo is not a member of the workspace", async () => {
    const outsider = await UserModel.create({
      name: "Outsider",
      email: `outsider-${Date.now()}@example.com`,
    });

    await expect(
      createTaskService(workspaceId, projectId, userId, {
        title: "T",
        priority: "MEDIUM",
        status: "TODO",
        assignedTo: outsider._id.toString(),
      })
    ).rejects.toThrow("Assigned user is not a member of this workspace");
  });

  it("creates the task when assignedTo IS a real member of the workspace", async () => {
    const role = await RoleModel.create({
      name: Roles.MEMBER,
      permissions: [],
    });
    const assignee = await UserModel.create({
      name: "Assignee",
      email: `assignee-${Date.now()}@example.com`,
    });
    await MemberModel.create({
      userId: assignee._id,
      workspaceId,
      role: role._id,
    });

    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "Assigned Task",
      priority: "MEDIUM",
      status: "TODO",
      assignedTo: assignee._id.toString(),
    });

    expect(String(task.assignedTo)).toBe(assignee._id.toString());
  });

  it("update persists changes and a re-fetch reflects them", async () => {
    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "Before Update",
      priority: "LOW",
      status: "TODO",
    });

    await updateTaskService(workspaceId, projectId, String(task._id), {
      title: "After Update",
      priority: "HIGH",
      status: "DONE",
    });

    const refetched = await TaskModel.findById(task._id);
    expect(refetched!.title).toBe("After Update");
    expect(refetched!.priority).toBe("HIGH");
    expect(refetched!.status).toBe("DONE");
  });

  it("getAllTasksService filters by status and keyword against real seeded data", async () => {
    await createTaskService(workspaceId, projectId, userId, {
      title: "Fix login bug",
      priority: "HIGH",
      status: "TODO",
    });
    await createTaskService(workspaceId, projectId, userId, {
      title: "Write docs",
      priority: "LOW",
      status: "DONE",
    });

    const result = await getAllTasksService(
      workspaceId,
      { status: ["TODO"], keyword: "login" },
      { pageSize: 10, pageNumber: 1 }
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Fix login bug");
  });

  it("getTaskByIdService scopes correctly to workspace+project", async () => {
    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "Scoped Task",
      priority: "MEDIUM",
      status: "TODO",
    });

    const found = await getTaskByIdService(
      workspaceId,
      projectId,
      String(task._id)
    );
    expect(String(found._id)).toBe(String(task._id));
  });

  it("delete removes the task from the real DB", async () => {
    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "To Delete",
      priority: "MEDIUM",
      status: "TODO",
    });

    await deleteTaskService(workspaceId, String(task._id));

    const afterDelete = await TaskModel.findById(task._id);
    expect(afterDelete).toBeNull();
  });

  it("deleting a project cascades and removes its tasks (cross-service regression check)", async () => {
    const { task } = await createTaskService(workspaceId, projectId, userId, {
      title: "Cascade Task",
      priority: "MEDIUM",
      status: "TODO",
    });

    await deleteProjectService(workspaceId, projectId);

    const afterDelete = await TaskModel.findById(task._id);
    expect(afterDelete).toBeNull();
  });
});
