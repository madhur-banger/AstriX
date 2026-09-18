import { eq, and, desc, sql, inArray, SQL } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, users, projects, workspaceMembers } from "../db/schema";
import { BadRequestException, NotFoundException } from "../utils/appError";

// Ports task.service.ts's assertAssigneeIsWorkspaceMember. Mongo's
// `MemberModel.exists({ userId, workspaceId })` becomes a `LIMIT 1` select
// checked for a result, per Phase 2 §2.8 item 3.
const assertAssigneeIsWorkspaceMember = async (
  workspaceId: string,
  assignedTo: string
): Promise<void> => {
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, assignedTo),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!row) {
    throw new BadRequestException(
      "Assigned user is not a member of this workspace"
    );
  }
};

export const createTaskService = async (
  workspaceId: string,
  projectId: string,
  userId: string,
  body: {
    title: string;
    description?: string;
    priority?: "LOW" | "MEDIUM" | "HIGH";
    status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
    assignedTo?: string | null;
    dueDate?: string;
    taskCode: string; // application-generated, same as today (Phase 1 §1.4)
  }
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

  if (body.assignedTo) {
    await assertAssigneeIsWorkspaceMember(workspaceId, body.assignedTo);
  }

  const [task] = await db
    .insert(tasks)
    .values({
      title: body.title,
      description: body.description,
      priority: body.priority ?? "MEDIUM",
      status: body.status ?? "TODO",
      assignedTo: body.assignedTo,
      createdBy: userId,
      workspaceId,
      projectId,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      taskCode: body.taskCode,
    })
    .returning();

  return { task };
};

export const updateTaskService = async (
  workspaceId: string,
  projectId: string,
  taskId: string,
  body: {
    title: string;
    description?: string;
    priority: "LOW" | "MEDIUM" | "HIGH";
    status: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
    assignedTo?: string | null;
    dueDate?: string;
  }
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

  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task || task.projectId !== projectId) {
    throw new NotFoundException(
      "Task not found or does not belong to this project"
    );
  }

  if (body.assignedTo) {
    await assertAssigneeIsWorkspaceMember(workspaceId, body.assignedTo);
  }

  const [updatedTask] = await db
    .update(tasks)
    .set({
      title: body.title,
      description: body.description,
      priority: body.priority,
      status: body.status,
      assignedTo: body.assignedTo,
      dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();

  if (!updatedTask) {
    throw new BadRequestException("Failed to update task");
  }

  return { updatedTask };
};

// The core relational-thinking exercise (Phase 2 §2.6): Mongo's
// `.populate("assignedTo", ...).populate("project", ...)` is two extra
// round trips, stitched together in application memory. This is one query,
// with the join pushed down to Postgres.
export const getAllTasksService = async (
  workspaceId: string,
  filters: {
    projectId?: string;
    status?: string[];
    priority?: string[];
    assignedTo?: string[];
    keyword?: string;
    dueDate?: string;
  },
  pagination: { pageSize: number; pageNumber: number }
) => {
  const conditions: SQL[] = [eq(tasks.workspaceId, workspaceId)];
  if (filters.projectId) conditions.push(eq(tasks.projectId, filters.projectId));
  if (filters.status?.length)
    conditions.push(inArray(tasks.status, filters.status as (typeof tasks.status.enumValues)[number][]));
  if (filters.priority?.length)
    conditions.push(inArray(tasks.priority, filters.priority as (typeof tasks.priority.enumValues)[number][]));
  if (filters.assignedTo?.length)
    conditions.push(inArray(tasks.assignedTo, filters.assignedTo));
  if (filters.keyword) {
    // ILIKE, not $regex - Phase 2 §2.6's ReDoS-vs-pattern-matching note:
    // '%'/'_' are the only special characters, no full regex engine involved.
    conditions.push(sql`${tasks.title} ILIKE ${"%" + filters.keyword + "%"}`);
  }
  if (filters.dueDate) conditions.push(eq(tasks.dueDate, new Date(filters.dueDate)));

  const { pageSize, pageNumber } = pagination;
  const skip = (pageNumber - 1) * pageSize;

  const rows = await db
    .select({
      id: tasks.id,
      taskCode: tasks.taskCode,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      createdAt: tasks.createdAt,
      assignee: { id: users.id, name: users.name, profilePicture: users.profilePicture },
      project: { id: projects.id, emoji: projects.emoji, name: projects.name },
    })
    .from(tasks)
    // leftJoin, not innerJoin: assignedTo is nullable (Phase 2 §2.6) - an
    // innerJoin here would silently drop every unassigned task from the
    // result, unlike Mongo's .populate() which just leaves the field null.
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .limit(pageSize)
    .offset(skip);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(...conditions));

  return {
    tasks: rows,
    pagination: { pageSize, pageNumber, totalCount: count, totalPages: Math.ceil(count / pageSize), skip },
  };
};

export const getTaskByIdService = async (
  workspaceId: string,
  projectId: string,
  taskId: string
) => {
  const [row] = await db
    .select({
      id: tasks.id,
      taskCode: tasks.taskCode,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      assignee: { id: users.id, name: users.name, profilePicture: users.profilePicture },
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.projectId, projectId)
      )
    );

  if (!row) throw new NotFoundException("Task not found.");
  return row;
};

export const deleteTaskService = async (workspaceId: string, taskId: string) => {
  const [deleted] = await db
    .delete(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .returning();

  if (!deleted) {
    throw new NotFoundException(
      "Task not found or does not belong to the specified workspace"
    );
  }
};
