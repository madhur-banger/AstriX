/**
 * Shared seed helpers for pg integration/e2e tests. Goes through the real
 * services (registerUserService, createWorkspaceService, ...) rather than
 * raw `db.insert(...)` calls wherever a service already does the job - the
 * same "exercise real code, not a shortcut around it" posture as the Mongo
 * suite's tests/setup/testFixtures.ts.
 */
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client";
import { roles, users } from "../../src/db/schema";
import { Roles } from "../../src/enums/role.enum";
import { hashValue } from "../../src/utils/bcrypt";
import { createWorkspaceService } from "../../src/services/workspace.service";
import { createProjectService } from "../../src/services/project.service";

export const createTestUser = async (
  overrides: Partial<{ name: string; email: string; password: string }> = {}
) => {
  const email = overrides.email ?? `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await hashValue(overrides.password ?? "Password1!");

  const [user] = await db
    .insert(users)
    .values({ name: overrides.name ?? "Test User", email, passwordHash })
    .returning();

  return user;
};

export const getRoleIdByName = async (name: keyof typeof Roles): Promise<string> => {
  const [role] = await db.select().from(roles).where(eq(roles.name, name));
  if (!role) throw new Error(`Role ${name} not seeded - check global-setup.ts`);
  return role.id;
};

export const createTestWorkspace = async (
  ownerId: string,
  overrides: Partial<{ name: string; description: string }> = {}
) => {
  const { workspace } = await createWorkspaceService(ownerId, {
    name: overrides.name ?? "Test Workspace",
    description: overrides.description,
  });
  return workspace;
};

export const createTestProject = async (
  userId: string,
  workspaceId: string,
  overrides: Partial<{ name: string; description: string; emoji: string }> = {}
) => {
  const { project } = await createProjectService(userId, workspaceId, {
    name: overrides.name ?? "Test Project",
    description: overrides.description,
    emoji: overrides.emoji,
  });
  return project;
};
