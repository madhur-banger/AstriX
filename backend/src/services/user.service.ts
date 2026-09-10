import mongoose from "mongoose";
import UserModel from "../models/user.model";
import AccountModel from "../models/account.model";
import MemberModel from "../models/member.model";
import SessionModel from "../models/session.model";
import TaskModel from "../models/task.model";
import WorkspaceModel from "../models/workspace.model";
import PasswordResetTokenModel from "../models/passwordResetToken.model";
import EmailVerificationTokenModel from "../models/emailVerificationToken.model";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../utils/appError";

export const getCurrentUserService = async (userId: string) => {
  const user = await UserModel.findById(userId)
    .populate("currentWorkspace")
    .select("-password");

  if (!user) {
    throw new BadRequestException("User not found");
  }

  return {
    user,
  };
};

// ============================================
// PROFILE UPDATE
// ============================================

export const updateProfileService = async (
  userId: string,
  body: { name?: string; profilePicture?: string | null }
) => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  if (body.name !== undefined) {
    user.name = body.name;
  }
  if (body.profilePicture !== undefined) {
    user.profilePicture = body.profilePicture;
  }

  await user.save();

  return { user: user.omitPassword() };
};

// ============================================
// ACCOUNT DELETION
// ============================================

export const deleteAccountService = async (
  userId: string,
  password?: string
): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  // Require re-confirming the password before a destructive, irreversible
  // action - guards against a stolen/leaked access token being enough on
  // its own to delete the account. OAuth-only accounts have no password to
  // confirm, so being authenticated is the only bar for those.
  if (user.password) {
    if (!password) {
      throw new BadRequestException(
        "Password confirmation is required to delete your account"
      );
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      throw new UnauthorizedException("Incorrect password");
    }
  }

  // Deliberately blocked, not cascaded: a workspace can have other members
  // who'd lose it with no warning if we silently deleted every workspace
  // this user owns. Make them delete/transfer those explicitly first,
  // using the existing (permission-checked, transactional) workspace
  // deletion flow.
  const ownedWorkspaces = await WorkspaceModel.find({ owner: userId }).select(
    "name"
  );
  if (ownedWorkspaces.length > 0) {
    throw new BadRequestException(
      `Delete or transfer ownership of ${ownedWorkspaces.length} workspace(s) you own before deleting your account: ${ownedWorkspaces
        .map((w) => w.name)
        .join(", ")}`
    );
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const memberships = await MemberModel.find({ userId }).session(session);
    const workspaceIds = memberships.map((m) => m.workspaceId);

    if (workspaceIds.length > 0) {
      // Unassign (don't delete) tasks in workspaces this user is just a
      // member of - the tasks themselves are still valid workspace history.
      await TaskModel.updateMany(
        { workspace: { $in: workspaceIds }, assignedTo: userId },
        { assignedTo: null }
      ).session(session);
    }

    await MemberModel.deleteMany({ userId }).session(session);
    await AccountModel.deleteMany({ userId }).session(session);
    await SessionModel.deleteMany({ userId }).session(session);
    await PasswordResetTokenModel.deleteMany({ userId }).session(session);
    await EmailVerificationTokenModel.deleteMany({ userId }).session(session);
    await UserModel.findByIdAndDelete(userId).session(session);

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};
