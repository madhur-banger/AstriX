/**
 * INTEGRATION TESTS: services/user.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  getUserByIdService,
  updateProfileService,
  deleteAccountService,
} from "../../src/services/user.service";
import { createAccountService } from "../../src/services/account.service";
import { db } from "../../src/db/client";
import { users, accounts, workspaceMembers, tasks } from "../../src/db/schema";
import { BadRequestException, NotFoundException, UnauthorizedException } from "../../src/utils/appError";
import { generateTaskCode } from "../../src/utils/uuid";
import { createTestUser, createTestWorkspace, createTestProject, getRoleIdByName } from "../setup/fixtures";

describe("user.service (integration - real Postgres via testcontainers)", () => {
  it("getUserByIdService excludes passwordHash from the returned shape", async () => {
    const user = await createTestUser();

    const result = await getUserByIdService(user.id);

    expect(result.id).toBe(user.id);
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("getUserByIdService 404s for a nonexistent id", async () => {
    await expect(getUserByIdService(crypto.randomUUID())).rejects.toThrow(NotFoundException);
  });

  it("updateProfileService applies a partial update, leaving profilePicture untouched, and excludes passwordHash", async () => {
    const user = await createTestUser({ name: "Original Name" });
    await db.update(users).set({ profilePicture: "https://example.com/pic.png" }).where(eq(users.id, user.id));

    const { user: updated } = await updateProfileService(user.id, { name: "New Name" });

    expect(updated.name).toBe("New Name");
    expect(updated.profilePicture).toBe("https://example.com/pic.png");
    expect(updated).not.toHaveProperty("passwordHash");
  });

  it("deleteAccountService throws UnauthorizedException on a wrong password", async () => {
    const user = await createTestUser({ password: "CorrectPass1!" });

    await expect(deleteAccountService(user.id, "WrongPass1!")).rejects.toThrow(UnauthorizedException);
  });

  it("deleteAccountService throws BadRequestException when no password is provided for a password-having account", async () => {
    const user = await createTestUser();

    await expect(deleteAccountService(user.id)).rejects.toThrow(BadRequestException);
  });

  it("deleteAccountService allows an OAuth-only account (no passwordHash) to delete with no password", async () => {
    const [oauthUser] = await db
      .insert(users)
      .values({ name: "OAuth User", email: `oauth-${Date.now()}@example.com` })
      .returning();

    await deleteAccountService(oauthUser.id);

    const [refetched] = await db.select().from(users).where(eq(users.id, oauthUser.id));
    expect(refetched).toBeUndefined();
  });

  it("deleteAccountService refuses when the user still owns a workspace", async () => {
    const user = await createTestUser();
    await createTestWorkspace(user.id);

    await expect(deleteAccountService(user.id)).rejects.toThrow(BadRequestException);
  });

  it("deleteAccountService unassigns (does not delete) tasks in workspaces the user is just a member of", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const project = await createTestProject(owner.id, workspace.id);
    const memberRoleId = await getRoleIdByName("MEMBER");
    const member = await createTestUser({ password: "Password1!" });
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

    await deleteAccountService(member.id, "Password1!");

    const [refetchedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(refetchedTask).toBeDefined();
    expect(refetchedTask.assignedTo).toBeNull();
  });

  it("deleteAccountService removes the users/accounts/workspace_members rows on success", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const memberRoleId = await getRoleIdByName("MEMBER");
    const member = await createTestUser({ password: "Password1!" });
    await db.insert(workspaceMembers).values({ userId: member.id, workspaceId: workspace.id, roleId: memberRoleId });
    await createAccountService({ userId: member.id, provider: "EMAIL", providerId: member.email });

    await deleteAccountService(member.id, "Password1!");

    const [refetchedUser] = await db.select().from(users).where(eq(users.id, member.id));
    expect(refetchedUser).toBeUndefined();

    const remainingAccounts = await db.select().from(accounts).where(eq(accounts.userId, member.id));
    expect(remainingAccounts).toHaveLength(0);

    const remainingMemberships = await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, member.id));
    expect(remainingMemberships).toHaveLength(0);
  });
});
