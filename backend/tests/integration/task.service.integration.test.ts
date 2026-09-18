/**
 * INTEGRATION TESTS: services/task.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks. Mirrors the
 * existing tests/integration/task.service.integration.test.ts (Mongo) so
 * the two suites can be compared feature-by-feature per Phase 5 §5.6's
 * parity checklist.
 */
import { describe, it, expect } from "vitest";
import {
  createTaskService,
  updateTaskService,
  getAllTasksService,
  getTaskByIdService,
  deleteTaskService,
} from "../../src/services/task.service";
import { deleteProjectService } from "../../src/services/project.service";
import { db } from "../../src/db/client";
import { tasks, workspaceMembers } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { NotFoundException, BadRequestException } from "../../src/utils/appError";
import { generateTaskCode } from "../../src/utils/uuid";
import {
  createTestUser,
  createTestWorkspace,
  createTestProject,
  getRoleIdByName,
} from "../setup/fixtures";

describe("task.service (integration - real Postgres via testcontainers)", () => {
  const seed = async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);
    const project = await createTestProject(user.id, workspace.id);
    return { user, workspace, project };
  };

  it("creates a task with default status/priority and the given taskCode", async () => {
    const { user, workspace, project } = await seed();

    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Persisted Task",
      taskCode: generateTaskCode(),
    });

    const [persisted] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(persisted).toBeDefined();
    expect(persisted.status).toBe("TODO");
    expect(persisted.priority).toBe("MEDIUM");
    expect(persisted.taskCode).toBeTruthy();
  });

  it("rejects creation when the project belongs to a different workspace", async () => {
    const { user, project } = await seed();
    const otherWorkspace = await createTestWorkspace(user.id, { name: "Other Workspace" });

    await expect(
      createTaskService(otherWorkspace.id, project.id, user.id, {
        title: "T",
        taskCode: generateTaskCode(),
      })
    ).rejects.toThrow(NotFoundException);
  });

  it("rejects creation when assignedTo is not a member of the workspace", async () => {
    const { user, workspace, project } = await seed();
    const outsider = await createTestUser();

    await expect(
      createTaskService(workspace.id, project.id, user.id, {
        title: "T",
        assignedTo: outsider.id,
        taskCode: generateTaskCode(),
      })
    ).rejects.toThrow("Assigned user is not a member of this workspace");
  });

  it("creates the task when assignedTo IS a real member of the workspace", async () => {
    const { user, workspace, project } = await seed();
    const assignee = await createTestUser();
    const memberRoleId = await getRoleIdByName("MEMBER");
    await db.insert(workspaceMembers).values({ userId: assignee.id, workspaceId: workspace.id, roleId: memberRoleId });

    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Assigned Task",
      assignedTo: assignee.id,
      taskCode: generateTaskCode(),
    });

    expect(task.assignedTo).toBe(assignee.id);
  });

  it("rejects an update when assignedTo is not a member of the workspace (update path enforces the same rule as create)", async () => {
    const { user, workspace, project } = await seed();
    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Needs reassignment",
      taskCode: generateTaskCode(),
    });
    const outsider = await createTestUser();

    await expect(
      updateTaskService(workspace.id, project.id, task.id, {
        title: "Needs reassignment",
        priority: "MEDIUM",
        status: "TODO",
        assignedTo: outsider.id,
      })
    ).rejects.toThrow(BadRequestException);

    const [refetched] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(refetched.assignedTo).toBeNull();
  });

  it("update persists changes and a re-fetch reflects them", async () => {
    const { user, workspace, project } = await seed();
    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Before Update",
      priority: "LOW",
      taskCode: generateTaskCode(),
    });

    await updateTaskService(workspace.id, project.id, task.id, {
      title: "After Update",
      priority: "HIGH",
      status: "DONE",
    });

    const [refetched] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(refetched.title).toBe("After Update");
    expect(refetched.priority).toBe("HIGH");
    expect(refetched.status).toBe("DONE");
  });

  it("getAllTasksService filters by status and keyword against real seeded rows", async () => {
    const { user, workspace, project } = await seed();
    await createTaskService(workspace.id, project.id, user.id, {
      title: "Fix login bug",
      status: "TODO",
      priority: "HIGH",
      taskCode: generateTaskCode(),
    });
    await createTaskService(workspace.id, project.id, user.id, {
      title: "Write docs",
      status: "DONE",
      priority: "LOW",
      taskCode: generateTaskCode(),
    });

    const result = await getAllTasksService(
      workspace.id,
      { status: ["TODO"], keyword: "login" },
      { pageSize: 10, pageNumber: 1 }
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("Fix login bug");
  });

  it("getAllTasksService leaves assignee null for an unassigned task instead of omitting it (leftJoin, not innerJoin)", async () => {
    const { user, workspace, project } = await seed();
    await createTaskService(workspace.id, project.id, user.id, {
      title: "Unassigned",
      taskCode: generateTaskCode(),
    });

    const result = await getAllTasksService(workspace.id, {}, { pageSize: 10, pageNumber: 1 });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].assignee).toBeNull();
  });

  it("getTaskByIdService scopes correctly to workspace+project", async () => {
    const { user, workspace, project } = await seed();
    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Scoped Task",
      taskCode: generateTaskCode(),
    });

    const found = await getTaskByIdService(workspace.id, project.id, task.id);
    expect(found.id).toBe(task.id);
  });

  it("delete removes the task from the real DB", async () => {
    const { user, workspace, project } = await seed();
    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "To Delete",
      taskCode: generateTaskCode(),
    });

    await deleteTaskService(workspace.id, task.id);

    const [afterDelete] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterDelete).toBeUndefined();
  });

  it("deleting a project cascades and removes its tasks via ON DELETE CASCADE (Phase 1 cascade proof, now automated)", async () => {
    const { user, workspace, project } = await seed();
    const { task } = await createTaskService(workspace.id, project.id, user.id, {
      title: "Cascade Task",
      taskCode: generateTaskCode(),
    });

    await deleteProjectService(workspace.id, project.id);

    const [afterDelete] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(afterDelete).toBeUndefined();
  });

  it("getAllTasksService.pagination math matches pageSize/pageNumber/totalPages/skip", async () => {
    const { user, workspace, project } = await seed();
    for (let i = 0; i < 5; i++) {
      await createTaskService(workspace.id, project.id, user.id, {
        title: `Task ${i}`,
        taskCode: generateTaskCode(),
      });
    }

    const result = await getAllTasksService(workspace.id, {}, { pageSize: 2, pageNumber: 2 });

    expect(result.tasks).toHaveLength(2);
    expect(result.pagination).toEqual({
      pageSize: 2,
      pageNumber: 2,
      totalCount: 5,
      totalPages: 3,
      skip: 2,
    });
  });
});
