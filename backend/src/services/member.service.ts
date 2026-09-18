import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { workspaceMembers, workspaces, roles } from "../db/schema";
import { Roles } from "../enums/role.enum";
import { BadRequestException, NotFoundException, UnauthorizedException } from "../utils/appError";

// Ports member.service.ts's getMemberRoleInWorkspace.
export const getMemberRoleInWorkspace = async (userId: string, workspaceId: string) => {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) {
    throw new NotFoundException("Workspace not found");
  }

  const [member] = await db
    .select({ roleName: roles.name })
    .from(workspaceMembers)
    .innerJoin(roles, eq(workspaceMembers.roleId, roles.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)));

  if (!member) {
    throw new UnauthorizedException("You are not a member of this workspace");
  }

  return { role: member.roleName };
};

// Ports member.service.ts's joinWorkspaceByInviteService. The unique
// (workspaceId, userId) index on workspace_members (Phase 1 §1.4) is the
// real guard against the race between the pre-check and the insert, same
// as the Mongo original's reliance on its own unique index.
export const joinWorkspaceByInviteService = async (userId: string, inviteCode: string) => {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.inviteCode, inviteCode));
  if (!workspace) {
    throw new NotFoundException("Invalid invite code or workspace not found");
  }

  const [existingMember] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspace.id)));

  if (existingMember) {
    throw new BadRequestException("You are already a member of this workspace");
  }

  const [role] = await db.select().from(roles).where(eq(roles.name, Roles.MEMBER));
  if (!role) {
    throw new NotFoundException("Role not found");
  }

  try {
    await db.insert(workspaceMembers).values({ userId, workspaceId: workspace.id, roleId: role.id });
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "23505") {
      // unique_violation - lost the race against a concurrent join.
      throw new BadRequestException("You are already a member of this workspace");
    }
    throw error;
  }

  return { workspaceId: workspace.id, role: role.name };
};
