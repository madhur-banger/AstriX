import crypto from "crypto";
import mongoose from "mongoose";
import UserModel from "../models/user.model";
import AccountModel from "../models/account.model";
import WorkspaceModel from "../models/workspace.model";
import RoleModel from "../models/roles-permission.model";
import SessionModel from "../models/session.model";
import MemberModel from "../models/member.model";
import PasswordResetTokenModel from "../models/passwordResetToken.model";
import EmailVerificationTokenModel from "../models/emailVerificationToken.model";
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
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../providers/email.provider";
import { logger } from "../utils/logger";
import { compareValue } from "../utils/bcrypt";

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

// A raw token (password reset link, email verification link, refresh token)
// only ever lives in the client's hands and this request's memory - only its
// hash is ever persisted.
const hashToken = (rawToken: string): string =>
  crypto.createHash("sha256").update(rawToken).digest("hex");

// ============================================
// SHARED: session + token creation
// used by both email/password login and OAuth
// ============================================

export const createSessionService = async ({
  userId,
  userAgent,
  ipAddress,
}: CreateSessionParams): Promise<TokenPairWithSession> => {
  // Constructed (not `.create()`d) so the session's _id - which the token
  // payload has to carry - is available BEFORE the insert, letting the
  // session and the hash of the refresh token it's bound to be written in a
  // single round trip.
  const session = new SessionModel({
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

  session.refreshTokenHash = hashToken(refreshToken);
  await session.save();

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

    // Best-effort, outside the transaction (it already committed - the
    // account exists regardless of what happens here). A hiccup creating
    // the verification token or sending the email must NOT turn into a
    // registration failure; the user can always request a new one later.
    try {
      await requestEmailVerificationService(user._id.toString());
    } catch (verificationError) {
      logger.error(
        { err: verificationError },
        "Failed to send verification email during registration"
      );
    }

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

// A precomputed bcrypt hash with no corresponding real password - compared
// against on the "no such account" branch below purely to burn the same
// ~bcrypt-cost-10 wall-clock time that a real wrong-password comparison
// would, so the two branches aren't distinguishable by response latency.
// Never rotate this per-request (that would defeat the point); it only
// needs to be *a* valid bcrypt hash, not a secret.
const DUMMY_PASSWORD_HASH =
  "$2b$10$uoY4NVy6Uns2Luc7jnt9P.hOJUVlz40gP0G0Aunbvk.3vZ3w642ei";

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
  // Same exception (401) and same message as the wrong-password branch
  // below. A 404 here would have made the login endpoint an email
  // enumeration oracle: identical text, different status code is still a
  // distinguishable response. Same discipline as
  // requestPasswordResetService, which is deliberately indistinguishable
  // for a known vs unknown email.
  //
  // Status code and message alone aren't enough, though: a real
  // comparePassword() call below runs a deliberately slow bcrypt compare,
  // so skipping straight to the throw here would still leak "no such
  // account" via response latency. Burn the same bcrypt cost against a
  // dummy hash first so both branches take statistically indistinguishable
  // time.
  if (!account) {
    await compareValue(password, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedException("Invalid email or password");
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
  // Whether the IdP itself confirmed the user controls this email. Only
  // gates auto-linking to a PRE-EXISTING account (see below) - a brand new
  // account is always fine to create regardless.
  emailVerified?: boolean;
}) => {
  const { providerId, provider, displayName, email, picture, emailVerified } =
    data;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const account = await AccountModel.findOne({
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

      if (user) {
        // Auto-linking a new OAuth identity to a PRE-EXISTING account by
        // email match. Without the IdP confirming it verified this email,
        // we can't tell "this is genuinely the same person" from "someone
        // registered an OAuth app / IdP account using someone else's
        // email" - refuse rather than risk linking (and thus granting
        // login access) to the wrong account.
        if (!emailVerified) {
          throw new UnauthorizedException(
            "This email is already registered. Log in with your password, or verify this email with your provider first."
          );
        }
      }

      if (!user) {
        user = new UserModel({
          email,
          name: displayName,
          profilePicture: picture || null,
          // A brand new account, not a link to an existing one - safe to
          // trust the IdP's verification status directly since there's no
          // pre-existing identity being taken over.
          isEmailVerified: !!emailVerified,
        });
        await user.save({ session });

        const workspace = new WorkspaceModel({
          name: "My Workspace",
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
): Promise<{ accessToken: string; refreshToken: string }> => {
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

  // Refresh tokens are single-use. A structurally valid token whose hash is
  // no longer the one this session is bound to has already been rotated
  // away - which means two parties hold tokens for this session, i.e. one
  // was stolen. Kill the session outright rather than just rejecting this
  // one request, so the thief and the victim both have to re-authenticate.
  //
  // `refreshTokenHash` is optional purely for backwards compatibility with
  // sessions issued before rotation existed - those are adopted on their
  // first refresh instead of being force-logged-out.
  if (
    session.refreshTokenHash &&
    session.refreshTokenHash !== hashToken(refreshToken)
  ) {
    await invalidateSessionService(sessionId);
    throw new UnauthorizedException(
      "Refresh token reuse detected. Please log in again."
    );
  }

  const tokens = generateTokenPair(userId, sessionId);

  // Rotate in place on the SAME session document: the session (and the entry
  // the user sees in their device list) is continuous across refreshes -
  // only the token bound to it changes.
  session.refreshTokenHash = hashToken(tokens.refreshToken);
  await session.save();

  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
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

// ============================================
// PASSWORD RESET
// ============================================

export const requestPasswordResetService = async (
  email: string
): Promise<void> => {
  const user = await UserModel.findOne({ email });

  // Deliberately the same outcome (no error, no distinguishing response)
  // whether or not the account exists - an unauthenticated "does this email
  // have an account" oracle is exactly what this endpoint must not become.
  if (!user) {
    return;
  }

  // Only the newest reset link should work - drop any previously issued,
  // still-valid ones for this user.
  await PasswordResetTokenModel.deleteMany({ userId: user._id });

  const rawToken = crypto.randomBytes(32).toString("hex");

  await PasswordResetTokenModel.create({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    expiresAt: calculateExpiryDate(config.PASSWORD_RESET_TOKEN_EXPIRES_IN),
  });

  const resetUrl = `${config.FRONTEND_PASSWORD_RESET_URL}?token=${rawToken}`;
  await sendPasswordResetEmail(user.email, resetUrl);
};

export const resetPasswordService = async (
  rawToken: string,
  newPassword: string
): Promise<void> => {
  const tokenHash = hashToken(rawToken);

  const resetToken = await PasswordResetTokenModel.findOne({ tokenHash });
  if (!resetToken) {
    throw new UnauthorizedException("Invalid or expired reset token");
  }

  if (resetToken.expiresAt < new Date()) {
    await PasswordResetTokenModel.findByIdAndDelete(resetToken._id);
    throw new UnauthorizedException("Invalid or expired reset token");
  }

  const user = await UserModel.findById(resetToken.userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  user.password = newPassword; // pre-save hook (user.model.ts) re-hashes it
  await user.save();

  // Single-use: this token (and any siblings from a repeated forgot-password
  // request) is now spent. A password change is also a standard trigger to
  // invalidate existing sessions - if the account was compromised, this
  // resets that too.
  await PasswordResetTokenModel.deleteMany({ userId: user._id });
  await invalidateAllSessionsService(user._id);
};

// ============================================
// EMAIL VERIFICATION (advisory only - never gates login)
// ============================================

export const requestEmailVerificationService = async (
  userId: string
): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  if (user.isEmailVerified) {
    throw new BadRequestException("Email is already verified");
  }

  // Only the newest verification link should work.
  await EmailVerificationTokenModel.deleteMany({ userId: user._id });

  const rawToken = crypto.randomBytes(32).toString("hex");

  await EmailVerificationTokenModel.create({
    userId: user._id,
    tokenHash: hashToken(rawToken),
    expiresAt: calculateExpiryDate(config.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN),
  });

  const verifyUrl = `${config.FRONTEND_EMAIL_VERIFICATION_URL}?token=${rawToken}`;
  await sendVerificationEmail(user.email, verifyUrl);
};

export const verifyEmailService = async (rawToken: string): Promise<void> => {
  const tokenHash = hashToken(rawToken);

  const verificationToken = await EmailVerificationTokenModel.findOne({
    tokenHash,
  });
  if (!verificationToken) {
    throw new UnauthorizedException("Invalid or expired verification token");
  }

  if (verificationToken.expiresAt < new Date()) {
    await EmailVerificationTokenModel.findByIdAndDelete(verificationToken._id);
    throw new UnauthorizedException("Invalid or expired verification token");
  }

  const user = await UserModel.findById(verificationToken.userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  user.isEmailVerified = true;
  await user.save();

  await EmailVerificationTokenModel.deleteMany({ userId: user._id });
};

// ============================================
// CHANGE PASSWORD (authenticated)
// ============================================

export const changePasswordService = async (
  userId: string,
  currentSessionId: string | undefined,
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new NotFoundException("User not found");
  }

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    throw new UnauthorizedException("Current password is incorrect");
  }

  user.password = newPassword; // pre-save hook (user.model.ts) re-hashes it
  await user.save();

  // Invalidate every OTHER session - the caller just proved who they are
  // (current password + an already-authenticated request), so their
  // current device shouldn't be logged out as a side effect of changing
  // their own password. Every other device should be, in case the
  // password change was prompted by a suspected compromise.
  if (currentSessionId) {
    await SessionModel.updateMany(
      { userId: user._id, _id: { $ne: currentSessionId } },
      { isValid: false }
    );
  } else {
    await invalidateAllSessionsService(user._id);
  }
};

// ============================================
// SESSION REVOCATION (single device)
// ============================================

export const revokeSessionService = async (
  userId: string,
  sessionId: string
): Promise<void> => {
  const session = await SessionModel.findById(sessionId);
  if (!session) {
    throw new NotFoundException("Session not found");
  }

  if (session.userId.toString() !== userId.toString()) {
    // Don't leak whether the session id exists at all to a caller who
    // doesn't own it - 404, not 403.
    throw new NotFoundException("Session not found");
  }

  await invalidateSessionService(sessionId);
};
