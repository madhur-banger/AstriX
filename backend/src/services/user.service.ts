import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { users, workspaces, workspaceMembers, accounts, tasks } from "../db/schema";
import { BadRequestException, NotFoundException, UnauthorizedException } from "../utils/appError";
import { compareValue } from "../utils/bcrypt";
import { invalidateAllSessionsForUser } from "./redis/session.service";

// passwordHash is deliberately excluded from the column list - the
// Postgres/Drizzle equivalent of Mongoose's `select: false`, just explicit
// at the call site instead of implicit in the schema (Phase 1 §1.4).
export const getUserByIdService = async (userId: string) => {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      profilePicture: users.profilePicture,
      isActive: users.isActive,
      isEmailVerified: users.isEmailVerified,
      lastLogin: users.lastLogin,
      currentWorkspaceId: users.currentWorkspaceId,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user) throw new NotFoundException("User not found");
  return user;
};

export const createUserService = async (data: {
  name?: string;
  email: string;
  passwordHash?: string;
  profilePicture?: string | null;
  isEmailVerified?: boolean;
}) => {
  const [user] = await db.insert(users).values(data).returning();
  return user;
};

// ============================================
// PROFILE UPDATE
// ============================================

export const updateProfileService = async (
  userId: string,
  body: { name?: string; profilePicture?: string | null }
) => {
  const [user] = await db
    .update(users)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.profilePicture !== undefined ? { profilePicture: body.profilePicture } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!user) {
    throw new NotFoundException("User not found");
  }

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return { user: safeUser };
};

// ============================================
// ACCOUNT DELETION
// ============================================

export const deleteAccountService = async (
  userId: string,
  password?: string
): Promise<void> => {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    throw new NotFoundException("User not found");
  }

  // Require re-confirming the password before a destructive, irreversible
  // action - guards against a stolen/leaked access token being enough on
  // its own to delete the account. OAuth-only accounts have no password to
  // confirm, so being authenticated is the only bar for those.
  if (user.passwordHash) {
    if (!password) {
      throw new BadRequestException(
        "Password confirmation is required to delete your account"
      );
    }
    const isMatch = await compareValue(password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException("Incorrect password");
    }
  }

  // Deliberately blocked, not cascaded: a workspace can have other members
  // who'd lose it with no warning if we silently deleted every workspace
  // this user owns. Make them delete/transfer those explicitly first.
  const ownedWorkspaces = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId));

  if (ownedWorkspaces.length > 0) {
    throw new BadRequestException(
      `Delete or transfer ownership of ${ownedWorkspaces.length} workspace(s) you own before deleting your account: ${ownedWorkspaces
        .map((w) => w.name)
        .join(", ")}`
    );
  }

  await db.transaction(async (tx) => {
    // Unassign (don't delete) tasks in workspaces this user is just a
    // member of - the tasks themselves are still valid workspace history.
    await tx.update(tasks).set({ assignedTo: null }).where(eq(tasks.assignedTo, userId));

    await tx.delete(workspaceMembers).where(eq(workspaceMembers.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  // Sessions live in Redis, not Postgres, so this can't be part of the
  // transaction above - best-effort cleanup after the account row is gone,
  // same "outside the transaction, can't fail the caller" posture as
  // registerUserService's verification-email send in auth.service.ts.
  await invalidateAllSessionsForUser(userId);
};
