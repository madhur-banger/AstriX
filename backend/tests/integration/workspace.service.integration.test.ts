/**
 * INTEGRATION TESTS: services/workspace.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks. Mirrors
 * tests/integration/workspace.service.integration.test.ts (Mongo) so the
 * two suites can be compared feature-by-feature per Phase 5 §5.6's parity
 * checklist.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  createWorkspaceService,
  getAllWorkspacesUserIsMemberService,
  getWorkspaceByIdService,
  updateWorkspaceByIdService,
  resetWorkspaceInviteCodeService,
  removeMemberFromWorkspaceService,
  getWorkspaceMembersService,
  deleteWorkspaceService,
  getWorkspaceAnalyticsService,
  changeMemberRoleService,
} from "../../src/services/workspace.service";
import { db } from "../../src/db/client";
import { users, workspaceMembers, projects, tasks } from "../../src/db/schema";
import { BadRequestException, ForbiddenException, NotFoundException } from "../../src/utils/appError";
import { generateTaskCode } from "../../src/utils/uuid";
import { createTestUser, createTestWorkspace, createTestProject, getRoleIdByName } from "../setup/fixtures";

describe("workspace.service (integration - real Postgres via testcontainers)", () => {
  it("creates the OWNER membership for the creator and sets currentWorkspaceId", async () => {
    const user = await createTestUser();

    const { workspace } = await createWorkspaceService(user.id, { name: "Acme" });

    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(membership.userId).toBe(user.id);

    const ownerRoleId = await getRoleIdByName("OWNER");
    expect(membership.roleId).toBe(ownerRoleId);

    const [refetchedUser] = await db.select().from(users).where(eq(users.id, user.id));
    expect(refetchedUser.currentWorkspaceId).toBe(workspace.id);
  });

  it("getAllWorkspacesUserIsMemberService only returns workspaces the user is a member of", async () => {
    const user = await createTestUser();
    const myWorkspace = await createTestWorkspace(user.id);
    const otherOwner = await createTestUser();
    await createTestWorkspace(otherOwner.id, { name: "Not Mine" });

    const { workspaces } = await getAllWorkspacesUserIsMemberService(user.id);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe(myWorkspace.id);
  });

  it("getWorkspaceByIdService 404s for a nonexistent id", async () => {
    await expect(getWorkspaceByIdService(crypto.randomUUID())).rejects.toThrow(NotFoundException);
  });

  it("getWorkspaceByIdService includes members", async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);

    const { workspace: found } = await getWorkspaceByIdService(workspace.id);

    expect(found.members).toHaveLength(1);
    expect(found.members[0].user.id).toBe(user.id);
  });

  it("updateWorkspaceByIdService persists name/description changes", async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);

    const { workspace: updated } = await updateWorkspaceByIdService(
      workspace.id,
      "Renamed",
      "New description"
    );

    expect(updated.name).toBe("Renamed");
    expect(updated.description).toBe("New description");
  });

  it("resetWorkspaceInviteCodeService changes the invite code", async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);

    const { workspace: updated } = await resetWorkspaceInviteCodeService(workspace.id);

    expect(updated.inviteCode).not.toBe(workspace.inviteCode);
  });

  it("removeMemberFromWorkspaceService refuses to remove the owner", async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);

    await expect(removeMemberFromWorkspaceService(workspace.id, user.id)).rejects.toThrow(
      BadRequestException
    );
  });

  it("removeMemberFromWorkspaceService unassigns the removed member's tasks", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const project = await createTestProject(owner.id, workspace.id);
    const memberRoleId = await getRoleIdByName("MEMBER");
    const member = await createTestUser();
    await db.insert(workspaceMembers).values({ userId: member.id, workspaceId: workspace.id, roleId: memberRoleId });
    const [task] = await db
      .insert(tasks)
      .values({
        taskCode: generateTaskCode(),
        title: "Assigned to member",
        projectId: project.id,
        workspaceId: workspace.id,
        assignedTo: member.id,
        createdBy: owner.id,
      })
      .returning();

    await removeMemberFromWorkspaceService(workspace.id, member.id);

    const [refetchedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(refetchedTask.assignedTo).toBeNull();

    const remainingMembers = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(remainingMembers.find((m) => m.userId === member.id)).toBeUndefined();
  });

  it("getWorkspaceMembersService returns members with role populated", async () => {
    const user = await createTestUser();
    const workspace = await createTestWorkspace(user.id);

    const { members } = await getWorkspaceMembersService(workspace.id);

    expect(members).toHaveLength(1);
    expect(members[0].role.name).toBe("OWNER");
  });

  it("deleteWorkspaceService throws ForbiddenException when the caller isn't the owner", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const outsider = await createTestUser();

    await expect(deleteWorkspaceService(workspace.id, outsider.id)).rejects.toThrow(ForbiddenException);
  });

  it("deleteWorkspaceService cascades to members/projects/tasks and reassigns currentWorkspaceId", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const project = await createTestProject(owner.id, workspace.id);
    await db.insert(tasks).values({
      taskCode: generateTaskCode(),
      title: "Doomed task",
      projectId: project.id,
      workspaceId: workspace.id,
      createdBy: owner.id,
    });
    const otherWorkspace = await createTestWorkspace(owner.id, { name: "Fallback" });

    const result = await deleteWorkspaceService(workspace.id, owner.id);

    const remainingMembers = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspace.id));
    expect(remainingMembers).toHaveLength(0);

    const remainingProjects = await db.select().from(projects).where(eq(projects.workspaceId, workspace.id));
    expect(remainingProjects).toHaveLength(0);

    const remainingTasks = await db.select().from(tasks).where(eq(tasks.workspaceId, workspace.id));
    expect(remainingTasks).toHaveLength(0);

    expect(result.currentWorkspaceId).toBe(otherWorkspace.id);

    const [refetchedUser] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(refetchedUser.currentWorkspaceId).toBe(otherWorkspace.id);
  });

  it("deleteWorkspaceService nulls currentWorkspaceId when no other membership exists", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);

    const result = await deleteWorkspaceService(workspace.id, owner.id);

    expect(result.currentWorkspaceId).toBeNull();
  });

  it("changeMemberRoleService refuses to change the owner's role", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const adminRoleId = await getRoleIdByName("ADMIN");

    await expect(changeMemberRoleService(workspace.id, owner.id, adminRoleId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("changeMemberRoleService updates a non-owner member's role", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const memberRoleId = await getRoleIdByName("MEMBER");
    const member = await createTestUser();
    await db.insert(workspaceMembers).values({ userId: member.id, workspaceId: workspace.id, roleId: memberRoleId });
    const adminRoleId = await getRoleIdByName("ADMIN");

    const { member: updated } = await changeMemberRoleService(workspace.id, member.id, adminRoleId);

    expect(updated.roleId).toBe(adminRoleId);
  });

  it("getWorkspaceAnalyticsService counts totalTasks/overdueTasks/completedTasks correctly", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const project = await createTestProject(owner.id, workspace.id);

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
        createdBy: owner.id,
      },
      {
        taskCode: generateTaskCode(),
        title: "Completed",
        projectId: project.id,
        workspaceId: workspace.id,
        status: "DONE",
        createdBy: owner.id,
      },
      {
        taskCode: generateTaskCode(),
        title: "Future",
        projectId: project.id,
        workspaceId: workspace.id,
        status: "TODO",
        dueDate: tomorrow,
        createdBy: owner.id,
      },
    ]);

    const { analytics } = await getWorkspaceAnalyticsService(workspace.id);

    expect(analytics.totalTasks).toBe(3);
    expect(analytics.overdueTasks).toBe(1);
    expect(analytics.completedTasks).toBe(1);
  });
});
