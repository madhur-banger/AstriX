/**
 * INTEGRATION TESTS: project.service.ts
 * ---------------------------------------
 * Complements the mocked unit tests with the REAL Mongo aggregation
 * pipeline (`$facet`) behind getProjectAnalyticsService - a mocked
 * `TaskModel.aggregate` return value only proves the service maps whatever
 * shape you hand it correctly, not that the actual pipeline produces that
 * shape against real data.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  createProjectService,
  getProjectAnalyticsService,
  deleteProjectService,
} from "../../src/services/project.service";

import UserModel from "../../src/models/user.model";
import WorkspaceModel from "../../src/models/workspace.model";
import ProjectModel from "../../src/models/project.model";
import TaskModel from "../../src/models/task.model";
import { TaskStatusEnum } from "../../src/enums/task.enum";

describe("project.service (integration - real in-memory MongoDB)", () => {
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    const user = await UserModel.create({
      name: "Project Integration User",
      email: `project-integration-${Date.now()}@example.com`,
    });
    userId = user._id.toString();

    const workspace = await WorkspaceModel.create({
      name: "Project Integration Workspace",
      owner: user._id,
    });
    workspaceId = workspace._id.toString();
  });

  it("analytics aggregation returns correct counts against real seeded tasks", async () => {
    const { project } = await createProjectService(userId, workspaceId, {
      name: "Analytics Project",
    });
    const projectId = project._id.toString();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await TaskModel.create([
      {
        title: "Overdue, not done",
        project: project._id,
        workspace: workspaceId,
        status: TaskStatusEnum.TODO,
        dueDate: yesterday,
        createdBy: userId,
      },
      {
        title: "Overdue but done (should NOT count as overdue)",
        project: project._id,
        workspace: workspaceId,
        status: TaskStatusEnum.DONE,
        dueDate: yesterday,
        createdBy: userId,
      },
      {
        title: "Due in the future",
        project: project._id,
        workspace: workspaceId,
        status: TaskStatusEnum.IN_PROGRESS,
        dueDate: tomorrow,
        createdBy: userId,
      },
    ]);

    const { analytics } = await getProjectAnalyticsService(
      workspaceId,
      projectId
    );

    expect(analytics).toEqual({
      totalTasks: 3,
      overdueTasks: 1,
      completedTasks: 1,
    });
  });

  it("deleting a project really removes its tasks (cascade check)", async () => {
    const { project } = await createProjectService(userId, workspaceId, {
      name: "Cascade Project",
    });

    await TaskModel.create({
      title: "Will be cascade-deleted",
      project: project._id,
      workspace: workspaceId,
      createdBy: userId,
    });

    const beforeDelete = await TaskModel.find({ project: project._id });
    expect(beforeDelete).toHaveLength(1);

    await deleteProjectService(workspaceId, project._id.toString());

    const afterDelete = await TaskModel.find({ project: project._id });
    expect(afterDelete).toHaveLength(0);

    const projectStillExists = await ProjectModel.findById(project._id);
    expect(projectStillExists).toBeNull();
  });
});
