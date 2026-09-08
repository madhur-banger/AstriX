import mongoose from "mongoose";
import UserModel from "../models/user.model";
import AccountModel from "../models/account.model";
import WorkspaceModel from "../models/workspace.model";
import RoleModel from "../models/roles-permission.model";
import SessionModel from "../models/session.model";
import MemberModel from "../models/member.model";
import { Roles } from "../enums/role.enum";
import { ProviderEnum } from "../enums/account-provider.enum";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../utils/appError";
import {
  generateTokenPair,
  verifyRefreshToken,
  calculateExpiryDate,
} from "../utils/jwt";
import { config } from "../config/app.config";

interface CreateSessionParams {
  userId: mongoose.Types.ObjectId;
  userAgent?: string;
  ipAddress?: string;
}

interface TokenPairWithSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

// ============================================
// SHARED: session + token creation
// used by both email/password login and OAuth
// ============================================

export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  const session = await SessionModel.create({
    userId,
    userAgent,
    ipAddress,
    isValid: true,
    expiresAt: calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN),
  });

  const { accessToken, refreshToken } = generateTokenPair(
    userId,
    session._id.toString()
  );

  return {
    accessToken,
    refreshToken,
    sessionId: session._id.toString(),
  };
};

// ============================================
// REGISTER (email/password)
// ============================================

export const registerUserService = async (body: {
  email: string;
  name: string;
  password: string;
}) => {
  const { email, name, password } = body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const existingUser = await UserModel.findOne({ email }).session(session);
    if (existingUser) {
      throw new BadRequestException("Email already exists");
    }

    const user = new UserModel({ email, name, password });
    await user.save({ session });

    const account = new AccountModel({
      userId: user._id,
      provider: ProviderEnum.EMAIL,
      providerId: email,
    });
    await account.save({ session });

    const workspace = new WorkspaceModel({
      name: "My Workspace",
      description: `Workspace created for ${user.name}`,
      owner: user._id,
    });
    await workspace.save({ session });

    const ownerRole = await RoleModel.findOne({ name: Roles.OWNER }).session(
      session
    );
    if (!ownerRole) {
      throw new NotFoundException("Owner role not found");
    }

    const member = new MemberModel({
      userId: user._id,
      workspaceId: workspace._id,
      role: ownerRole._id,
      joinedAt: new Date(),
    });
    await member.save({ session });

    user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
    await user.save({ session });

    await session.commitTransaction();

    return {
      userId: user._id,
      workspaceId: workspace._id,
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ============================================
// LOGIN (email/password)
// ============================================

export const verifyUserService = async ({
  email,
  password,
  provider = ProviderEnum.EMAIL,
}: {
  email: string;
  password: string;
  provider?: string;
}) => {
  const account = await AccountModel.findOne({ provider, providerId: email });
  if (!account) {
    throw new NotFoundException("Invalid email or password");
  }

  const user = await UserModel.findById(account.userId);
  if (!user) {
    throw new NotFoundException("User not found for the given account");
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    throw new UnauthorizedException("Invalid email or password");
  }

  return user.omitPassword();
};

// ============================================
// OAUTH (Google login / registration)
// ============================================

export const loginOrCreateAccountService = async (data: {
  provider: string;
  displayName: string;
  providerId: string;
  picture?: string;
  email?: string;
}) => {
  const { providerId, provider, displayName, email, picture } = data;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();


    let account = await AccountModel.findOne({
      provider,
      providerId,
    }).session(session);

    let user;

    if (account) {
      user = await UserModel.findById(account.userId).session(session);
      if (!user) {
        throw new Error("Account exists but user not found");
      }
    } else {
      user = await UserModel.findOne({ email }).session(session);

      if (!user) {
        user = new UserModel({
          email,
          name: displayName,
          profilePicture: picture || null,
        });
        await user.save({ session });

        const workspace = new WorkspaceModel({
          name: "My Workspace",
          description: `Workspace created for ${user.name}`,
          owner: user._id,
        });
        await workspace.save({ session });

        const ownerRole = await RoleModel.findOne({ name: Roles.OWNER }).session(
          session
        );
        if (!ownerRole) {
          throw new NotFoundException("Owner role not found");
        }

        const member = new MemberModel({
          userId: user._id,
          workspaceId: workspace._id,
          role: ownerRole._id,
          joinedAt: new Date(),
        });
        await member.save({ session });

        user.currentWorkspace = workspace._id as mongoose.Types.ObjectId;
        await user.save({ session });
      }
      // If user exists (email match), we don't create new workspace
      
      // NOW: Create the OAuth account link
      const newAccount = new AccountModel({
        userId: user._id,
        provider,
        providerId,
      });
      await newAccount.save({ session });
    }

    await session.commitTransaction();
    return { user };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// ============================================
// REFRESH TOKEN
// ============================================

export const refreshAccessTokenService = async (
  refreshToken: string
): Promise<{ accessToken: string; newRefreshToken?: string }> => {
  const result = verifyRefreshToken(refreshToken);
  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }

  const { userId, sessionId } = result.payload;

  const session = await SessionModel.findById(sessionId);
  if (!session || !session.isValid) {
    throw new UnauthorizedException("Session expired or invalid");
  }

  if (session.expiresAt < new Date()) {
    await SessionModel.findByIdAndDelete(sessionId);
    throw new UnauthorizedException("Session expired");
  }

  const tokens = generateTokenPair(userId, sessionId);
  return { accessToken: tokens.accessToken };
};

// ============================================
// LOGOUT (single session / all sessions)
// ============================================

export const invalidateSessionService = async (
  sessionId: string
): Promise<void> => {
  await SessionModel.findByIdAndUpdate(sessionId, { isValid: false });
};

export const invalidateAllSessionsService = async (
  userId: mongoose.Types.ObjectId | string
): Promise<void> => {
  await SessionModel.updateMany({ userId }, { isValid: false });
};

// ============================================
// SESSION LISTING (manage devices)
// ============================================

export const getUserSessionsService = async (
  userId: mongoose.Types.ObjectId | string
) => {
  return SessionModel.find({
    userId,
    isValid: true,
    expiresAt: { $gt: new Date() },
  }).select("userAgent ipAddress createdAt");
};

// ============================================
// USER LOOKUP
// ============================================

export const findUserByIdService = async (userId: string) => {
  return UserModel.findById(userId, { password: false });
};