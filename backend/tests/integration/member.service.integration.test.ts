/**
 * INTEGRATION TESTS: services/member.service.ts
 * -------------------------------------------------
 * Real Postgres (testcontainers, see tests/setup/global-setup.ts) via
 * the real Drizzle client (src/db/client.ts) - no mocks.
 */
import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  getMemberRoleInWorkspace,
  joinWorkspaceByInviteService,
} from "../../src/services/member.service";
import { db } from "../../src/db/client";
import { workspaceMembers } from "../../src/db/schema";
import { BadRequestException, NotFoundException, UnauthorizedException } from "../../src/utils/appError";
import { createTestUser, createTestWorkspace } from "../setup/fixtures";

describe("member.service (integration - real Postgres via testcontainers)", () => {
  it("getMemberRoleInWorkspace 404s for a nonexistent workspace", async () => {
    const user = await createTestUser();

    await expect(getMemberRoleInWorkspace(user.id, crypto.randomUUID())).rejects.toThrow(
      NotFoundException
    );
  });

  it("getMemberRoleInWorkspace throws UnauthorizedException for a real workspace the user isn't a member of", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const outsider = await createTestUser();

    await expect(getMemberRoleInWorkspace(outsider.id, workspace.id)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("getMemberRoleInWorkspace returns the caller's role", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);

    const { role } = await getMemberRoleInWorkspace(owner.id, workspace.id);

    expect(role).toBe("OWNER");
  });

  it("joinWorkspaceByInviteService 404s for an invalid invite code", async () => {
    const user = await createTestUser();

    await expect(joinWorkspaceByInviteService(user.id, "bogus-invite-code")).rejects.toThrow(
      NotFoundException
    );
  });

  it("joinWorkspaceByInviteService succeeds and creates a MEMBER row for a valid code", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const joiner = await createTestUser();

    const result = await joinWorkspaceByInviteService(joiner.id, workspace.inviteCode);

    expect(result.workspaceId).toBe(workspace.id);
    expect(result.role).toBe("MEMBER");

    const [membership] = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, joiner.id), eq(workspaceMembers.workspaceId, workspace.id)));
    expect(membership).toBeDefined();
  });

  it("joinWorkspaceByInviteService throws BadRequestException on a second join attempt by an already-a-member user", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const joiner = await createTestUser();
    await joinWorkspaceByInviteService(joiner.id, workspace.inviteCode);

    await expect(joinWorkspaceByInviteService(joiner.id, workspace.inviteCode)).rejects.toThrow(
      BadRequestException
    );
  });

  it("exercises the catch-23505 race-guard branch: exactly one of two concurrent joins fails with BadRequestException", async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner.id);
    const joiner = await createTestUser();

    const results = await Promise.allSettled([
      joinWorkspaceByInviteService(joiner.id, workspace.inviteCode),
      joinWorkspaceByInviteService(joiner.id, workspace.inviteCode),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

    const memberships = await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, joiner.id), eq(workspaceMembers.workspaceId, workspace.id)));
    expect(memberships).toHaveLength(1);
  });
});
