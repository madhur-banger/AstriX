import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  users,
  workspaces,
  roles,
  workspaceMembers,
} from "../db/schema";
import { generateInviteCode } from "../utils/uuid";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../utils/appError";

// Ports workspace.service.ts's createWorkspaceService (find user -> find
// OWNER role -> create workspace -> create membership -> set user's
// currentWorkspace) into one Postgres transaction. See Phase 2 §2.5 for why
// `tx`, not `db`, must be threaded into every nested call here.
export const createWorkspaceService = async (
  userId: string,
  body: { name: string; description?: string }
) => {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundException("User not found");

    const [ownerRole] = await tx
      .select()
      .from(roles)
      .where(eq(roles.name, "OWNER"));
    if (!ownerRole) throw new NotFoundException("Owner role not found");

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: body.name,
        description: body.description,
        ownerId: user.id,
        inviteCode: generateInviteCode(),
      })
      .returning();

    await tx.insert(workspaceMembers).values({
      userId: user.id,
      workspaceId: workspace.id,
      roleId: ownerRole.id,
    });

    await tx
      .update(users)
      .set({ currentWorkspaceId: workspace.id })
      .where(eq(users.id, user.id));

    return { workspace };
  });
};

// Ports workspace.service.ts's getAllWorkspacesUserIsMemberService. The
// Mongo version populates workspaceId on each membership; this is the same
// join, pushed into one query instead of N+1 populate round trips.
export const getAllWorkspacesUserIsMemberService = async (userId: string) => {
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));

  return { workspaces: rows.map((r) => r.workspace) };
};

// Ports workspace.service.ts's getWorkspaceByIdService - fetches the
// workspace plus its members (each with role populated), merged into one
// response object exactly like the Mongo version's
// `{ ...workspace.toObject(), members }`.
export const getWorkspaceByIdService = async (workspaceId: string) => {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  const { members } = await getWorkspaceMembersService(workspaceId);

  return { workspace: { ...workspace, members } };
};

// Ports workspace.service.ts's updateWorkspaceByIdService.
export const updateWorkspaceByIdService = async (
  workspaceId: string,
  name: string,
  description?: string
) => {
  const [workspace] = await db
    .update(workspaces)
    .set({
      ...(name ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId))
    .returning();

  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  return { workspace };
};

// Ports workspace.service.ts's resetWorkspaceInviteCodeService.
export const resetWorkspaceInviteCodeService = async (workspaceId: string) => {
  const [workspace] = await db
    .update(workspaces)
    .set({ inviteCode: generateInviteCode(), updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId))
    .returning();

  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  return { workspace };
};

// Ports workspace.service.ts's removeMemberFromWorkspaceService - shared by
// an OWNER/ADMIN removing someone else and a member removing themselves
// (leave-workspace). The workspace owner can never be removed this way.
export const removeMemberFromWorkspaceService = async (
  workspaceId: string,
  targetUserId: string
) => {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundException("Workspace not found");

  if (workspace.ownerId === targetUserId) {
    throw new BadRequestException(
      "The workspace owner cannot be removed. Transfer ownership first."
    );
  }

  const { tasks } = await import("../db/schema");

  const [deleted] = await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, targetUserId),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .returning();

  if (!deleted) {
    throw new NotFoundException("Member not found in this workspace");
  }

  // Unassign (don't delete) any tasks the removed member was assigned -
  // the tasks themselves are still valid workspace history.
  await db
    .update(tasks)
    .set({ assignedTo: null })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.assignedTo, targetUserId)));

  const [user] = await db
    .select({ currentWorkspaceId: users.currentWorkspaceId })
    .from(users)
    .where(eq(users.id, targetUserId));

  if (user?.currentWorkspaceId === workspaceId) {
    const [anotherMembership] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, targetUserId))
      .limit(1);

    await db
      .update(users)
      .set({ currentWorkspaceId: anotherMembership?.workspaceId ?? null })
      .where(eq(users.id, targetUserId));
  }
};

// Ports workspace.service.ts's getWorkspaceMembersService - a genuine
// 3-table join (workspace_members -> users -> roles), replacing two
// separate `.populate()` calls with one query (Phase 2 §2.8 item 4).
export const getWorkspaceMembersService = async (workspaceId: string) => {
  const members = await db
    .select({
      id: workspaceMembers.id,
      joinedAt: workspaceMembers.joinedAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        profilePicture: users.profilePicture,
      },
      role: { id: roles.id, name: roles.name },
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .innerJoin(roles, eq(workspaceMembers.roleId, roles.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  return { members };
};

// Ports workspace.service.ts's deleteWorkspaceService. The Mongo version
// manually deletes projects/tasks/members inside a transaction before
// deleting the workspace itself (workspace.service.ts:311-333); here that
// collapses to one DELETE because ON DELETE CASCADE (Phase 1 §1.4) does it
// atomically. The one piece of logic that ISN'T a pure cascade side effect -
// reassigning the deleting user's currentWorkspace to another membership if
// one exists, rather than leaving it at Postgres's automatic NULL - is kept
// explicit here, same as the Mongo original.
export const deleteWorkspaceService = async (
  workspaceId: string,
  userId: string
) => {
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace) throw new NotFoundException("Workspace not found");

    if (workspace.ownerId !== userId) {
      throw new ForbiddenException(
        "You are not authorized to delete this workspace"
      );
    }

    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
    // ON DELETE CASCADE already removed workspace_members/projects/tasks
    // rows for this workspace, and set users.current_workspace_id to NULL
    // for every user whose current workspace was this one.

    const [anotherMembership] = await tx
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    if (anotherMembership) {
      await tx
        .update(users)
        .set({ currentWorkspaceId: anotherMembership.workspaceId })
        .where(eq(users.id, userId));
    }

    const [updatedUser] = await tx
      .select({ currentWorkspaceId: users.currentWorkspaceId })
      .from(users)
      .where(eq(users.id, userId));

    return { currentWorkspaceId: updatedUser?.currentWorkspaceId ?? null };
  });
};

export const getWorkspaceAnalyticsService = async (workspaceId: string) => {
  const { tasks } = await import("../db/schema");
  const { sql } = await import("drizzle-orm");

  const [row] = await db
    .select({
      totalTasks: sql<number>`count(*)::int`,
      overdueTasks: sql<number>`count(*) filter (where ${tasks.dueDate} < now() and ${tasks.status} != 'DONE')::int`,
      completedTasks: sql<number>`count(*) filter (where ${tasks.status} = 'DONE')::int`,
    })
    .from(tasks)
    .where(eq(tasks.workspaceId, workspaceId));

  return { analytics: row };
};

export const changeMemberRoleService = async (
  workspaceId: string,
  targetUserId: string,
  roleId: string
) => {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new NotFoundException("Workspace not found");

  if (workspace.ownerId === targetUserId) {
    throw new BadRequestException(
      "Cannot change the role of the workspace owner. Transfer ownership first."
    );
  }

  const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
  if (!role) throw new NotFoundException("Role not found");

  const [member] = await db
    .update(workspaceMembers)
    .set({ roleId })
    .where(
      and(
        eq(workspaceMembers.userId, targetUserId),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .returning();

  if (!member) throw new NotFoundException("Member not found in the workspace");
  return { member };
};
