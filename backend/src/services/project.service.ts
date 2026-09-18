import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { projects, tasks, users } from "../db/schema";
import { NotFoundException } from "../utils/appError";

export const createProjectService = async (
  userId: string,
  workspaceId: string,
  body: { emoji?: string; name: string; description?: string }
) => {
  const [project] = await db
    .insert(projects)
    .values({
      ...(body.emoji ? { emoji: body.emoji } : {}),
      name: body.name,
      description: body.description,
      workspaceId,
      createdBy: userId,
    })
    .returning();

  return { project };
};

export const getProjectsInWorkspaceService = async (
  workspaceId: string,
  pageSize: number,
  pageNumber: number
) => {
  const skip = (pageNumber - 1) * pageSize;

  const [projectRows, [{ count: totalCount }]] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        emoji: projects.emoji,
        createdAt: projects.createdAt,
        createdBy: { id: users.id, name: users.name, profilePicture: users.profilePicture },
      })
      .from(projects)
      .leftJoin(users, eq(projects.createdBy, users.id))
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(desc(projects.createdAt))
      .limit(pageSize)
      .offset(skip),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId)),
  ]);

  return {
    projects: projectRows,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
    skip,
  };
};

export const getProjectByIdAndWorkspaceIdService = async (
  workspaceId: string,
  projectId: string
) => {
  const [project] = await db
    .select({
      id: projects.id,
      emoji: projects.emoji,
      name: projects.name,
      description: projects.description,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return { project };
};

// The hardest single rewrite (Phase 2 §2.7). Mongo's $facet runs three
// independent sub-pipelines over one $match-filtered input in one pass -
// SQL's answer to "count under this condition and, separately, count under
// that condition, in the same query" is FILTER, not three separate queries.
export const getProjectAnalyticsService = async (
  workspaceId: string,
  projectId: string
) => {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project || project.workspaceId !== workspaceId) {
    throw new NotFoundException(
      "Project not found or does not belong to this workspace"
    );
  }

  const [row] = await db
    .select({
      totalTasks: sql<number>`count(*)::int`,
      overdueTasks: sql<number>`count(*) filter (where ${tasks.dueDate} < now() and ${tasks.status} != 'DONE')::int`,
      completedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));

  return { analytics: row };
};

export const updateProjectService = async (
  workspaceId: string,
  projectId: string,
  body: { emoji?: string; name?: string; description?: string }
) => {
  const [project] = await db
    .update(projects)
    .set({
      ...(body.emoji ? { emoji: body.emoji } : {}),
      ...(body.name ? { name: body.name } : {}),
      ...(body.description ? { description: body.description } : {}),
    })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .returning();

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return { project };
};

// Dramatically simpler than the Mongo original (Phase 2 §2.8 item 5): no
// manual TaskModel.deleteMany() step needed, ON DELETE CASCADE (Phase 1
// §1.4) removes this project's tasks atomically as part of the same
// statement.
export const deleteProjectService = async (
  workspaceId: string,
  projectId: string
) => {
  const [project] = await db
    .delete(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .returning();

  if (!project) {
    throw new NotFoundException(
      "Project not found or does not belong to the specified workspace"
    );
  }
  return project;
};
