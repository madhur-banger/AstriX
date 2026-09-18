/**
 * INTEGRATION TESTS: services/project.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createProjectService,
  getProjectsInWorkspaceService,
  getProjectByIdAndWorkspaceIdService,
  getProjectAnalyticsService,
  updateProjectService,
  deleteProjectService,
} from "../../src/services/project.service";
import { db } from "../../src/db/client";
import { tasks } from "../../src/db/schema";
import { NotFoundException } from "../../src/utils/appError";
import { generateTaskCode } from "../../src/utils/uuid";
import { createTestUser, createTestWorkspace, createTestProject } from "../setup/fixtures";

describe("project.service (integration - real Postgres via testcontainers)", () => {
  const seed = async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);
    return { user, workspace };
  };

  it("createProjectService defaults emoji when not given", async () => {
    const { user, workspace } = await seed();

    const { project } = await createProjectService(user.id, workspace.id, { name: "No Emoji" });

    expect(project.emoji).toBe("📊");
  });

  it("createProjectService keeps a given emoji", async () => {
    const { user, workspace } = await seed();

    const { project } = await createProjectService(user.id, workspace.id, { name: "Custom", emoji: "🚀" });

    expect(project.emoji).toBe("🚀");
  });

  it("getProjectsInWorkspaceService pagination math matches pageSize/pageNumber/totalCount/totalPages/skip", async () => {
    const { user, workspace } = await seed();
    for (let i = 0; i < 5; i++) {
      await createTestProject(user.id, workspace.id, { name: `Project ${i}` });
    }

    const result = await getProjectsInWorkspaceService(workspace.id, 2, 2);

    expect(result.projects).toHaveLength(2);
    expect(result.totalCount).toBe(5);
    expect(result.totalPages).toBe(3);
    expect(result.skip).toBe(2);
  });

  it("getProjectByIdAndWorkspaceIdService 404s when the project belongs to a different workspace", async () => {
    const { user, workspace } = await seed();
    const project = await createTestProject(user.id, workspace.id);
    const otherWorkspace = await createTestWorkspace(user.id, { name: "Other" });

    await expect(
      getProjectByIdAndWorkspaceIdService(otherWorkspace.id, project.id)
    ).rejects.toThrow(NotFoundException);
  });

  it("getProjectAnalyticsService counts via FILTER matching Phase 2 §2.7's hand-verified numbers", async () => {
    const { user, workspace } = await seed();
    const project = await createTestProject(user.id, workspace.id);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.insert(tasks).values([
      {
        taskCode: generateTaskCode(),
        title: "Overdue",
        projectId: project.id,
        workspaceId: workspace.id,
        status: "TODO",
        dueDate: yesterday,
        createdBy: user.id,
      },
      {
        taskCode: generateTaskCode(),
        title: "Done",
        projectId: project.id,
        workspaceId: workspace.id,
        status: "DONE",
        createdBy: user.id,
      },
      {
        taskCode: generateTaskCode(),
        title: "Future",
        projectId: project.id,
        workspaceId: workspace.id,
        status: "TODO",
        dueDate: tomorrow,
        createdBy: user.id,
      },
    ]);

    const { analytics } = await getProjectAnalyticsService(workspace.id, project.id);

    expect(analytics.totalTasks).toBe(3);
    expect(analytics.overdueTasks).toBe(1);
    expect(analytics.completedTasks).toBe(1);
  });

  it("updateProjectService applies a partial update, leaving other fields untouched", async () => {
    const { user, workspace } = await seed();
    const project = await createTestProject(user.id, workspace.id, {
      name: "Original",
      description: "Original description",
      emoji: "🎯",
    });

    const { project: updated } = await updateProjectService(workspace.id, project.id, { name: "Renamed" });

    expect(updated.name).toBe("Renamed");
    expect(updated.description).toBe("Original description");
    expect(updated.emoji).toBe("🎯");
  });

  it("updateProjectService 404s for the wrong workspace", async () => {
    const { user, workspace } = await seed();
    const project = await createTestProject(user.id, workspace.id);
    const otherWorkspace = await createTestWorkspace(user.id, { name: "Other" });

    await expect(
      updateProjectService(otherWorkspace.id, project.id, { name: "Renamed" })
    ).rejects.toThrow(NotFoundException);
  });

  it("deleteProjectService cascades to its tasks", async () => {
    const { user, workspace } = await seed();
    const project = await createTestProject(user.id, workspace.id);
    const [task] = await db
      .insert(tasks)
      .values({
        taskCode: generateTaskCode(),
        title: "Cascade Task",
        projectId: project.id,
        workspaceId: workspace.id,
        createdBy: user.id,
      })
      .returning();

    await deleteProjectService(workspace.id, project.id);

    const [refetched] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(refetched).toBeUndefined();
  });
});
