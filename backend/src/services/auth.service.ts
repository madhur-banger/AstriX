// backend/src/services/auth.service.ts
// ============================================
// AUTHENTICATION SERVICE - Updated with Refresh Tokens
// ============================================

import mongoose from "mongoose";
import UserModel from "../models/user.model";
import AccountModel from "../models/account.model";
import WorkspaceModel from "../models/workspace.model";
import RoleModel from "../models/roles-permission.model";
import SessionModel from "../models/session.model";
import { Roles } from "../enums/role.enum";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "../utils/appError";
import MemberModel from "../models/member.model";
import { ProviderEnum } from "../enums/account-provider.enum";
import {
  generateTokenPair,
  verifyRefreshToken,
  refreshTokenSignOptions,
  calculateExpiryDate,
} from "../utils/jwt";
import { config } from "../config/app.config";

// ============================================
// TYPE DEFINITIONS
// ============================================

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
// SESSION MANAGEMENT
// ============================================

/**
 * Create a new session and generate token pair
 * Called during login (both email/password and OAuth)
 */
export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  // 1. Create session in database
  const session = await SessionModel.create({
    userId,
    userAgent,
    ipAddress,
    isValid: true,
    expiresAt: calculateExpiryDate(
      config.JWT.REFRESH_TOKEN_EXPIRES_IN
    ),
  });

  // 2. Generate token pair with session ID
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

/**
 * Refresh access token using refresh token
 */
export const refreshAccessTokenService = async (
  refreshToken: string
): Promise<{ accessToken: string; newRefreshToken?: string }> => {
  // 1. Verify refresh token
  const result = verifyRefreshToken(refreshToken);

  if (!result.valid) {
    throw new UnauthorizedException(result.error);
  }

  const { userId, sessionId } = result.payload;

  // 2. Check if session exists and is valid
  const session = await SessionModel.findById(sessionId);

  if (!session || !session.isValid) {
    throw new UnauthorizedException("Session expired or invalid");
  }

  // 3. Check if session has expired
  if (session.expiresAt < new Date()) {
    // Clean up expired session
    await SessionModel.findByIdAndDelete(sessionId);
    throw new UnauthorizedException("Session expired");
  }

  // 4. Generate new token pair
  const tokens = generateTokenPair(userId, sessionId);

  // 5. Optional: Implement refresh token rotation
  // Uncomment below if you want to rotate refresh tokens on each refresh
  // This provides extra security but can cause issues with concurrent requests
  /*
  session.expiresAt = calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN);
  await session.save();
  return { 
    accessToken: tokens.accessToken, 
    newRefreshToken: tokens.refreshToken 
  };
  */

  return { accessToken: tokens.accessToken };
};

/**
 * Invalidate a specific session (logout from one device)
 */
export const invalidateSessionService = async (
  sessionId: string
): Promise<void> => {
  await SessionModel.findByIdAndUpdate(sessionId, { isValid: false });
};

/**
 * Invalidate all sessions for a user (logout from all devices)
 */
export const invalidateAllSessionsService = async (
  userId: mongoose.Types.ObjectId | string
): Promise<void> => {
  await SessionModel.updateMany({ userId }, { isValid: false });
};

/**
 * Get all active sessions for a user (for "manage devices" feature)
 */
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
// OAUTH LOGIN/REGISTRATION
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
    console.log("Started Session...");

    let user = await UserModel.findOne({ email }).session(session);

    if (!user) {
      // Create a new user if it doesn't exist
      user = new UserModel({
        email,
        name: displayName,
        profilePicture: picture || null,
      });
      await user.save({ session });

      const account = new AccountModel({
        userId: user._id,
        provider: provider,
        providerId: providerId,
      });
      await account.save({ session });

      // 3. Create a new workspace for the new user
      const workspace = new WorkspaceModel({
        name: `My Workspace`,
        description: `Workspace created for ${user.name}`,
        owner: user._id,
      });
      await workspace.save({ session });

      const ownerRole = await RoleModel.findOne({
        name: Roles.OWNER,
      }).session(session);

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
    await session.commitTransaction();
    session.endSession();
    console.log("End Session...");

    return { user };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  } finally {
    session.endSession();
  }
};

// ============================================
// EMAIL/PASSWORD REGISTRATION
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

    const user = new UserModel({
      email,
      name,
      password,
    });
    await user.save({ session });

    const account = new AccountModel({
      userId: user._id,
      provider: ProviderEnum.EMAIL,
      providerId: email,
    });
    await account.save({ session });

    // 3. Create a new workspace for the new user
    const workspace = new WorkspaceModel({
      name: `My Workspace`,
      description: `Workspace created for ${user.name}`,
      owner: user._id,
    });
    await workspace.save({ session });

    const ownerRole = await RoleModel.findOne({
      name: Roles.OWNER,
    }).session(session);

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
    session.endSession();
    console.log("End Session...");

    return {
      userId: user._id,
      workspaceId: workspace._id,
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    throw error;
  }
};

// ============================================
// EMAIL/PASSWORD LOGIN VERIFICATION
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
// USER LOOKUP
// ============================================

export const findUserByIdService = async (userId: string) => {
  const user = await UserModel.findById(userId, {
    password: false,
  });
  return user || null;
};