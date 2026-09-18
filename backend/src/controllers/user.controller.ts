import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { HTTPSTATUS } from "../config/http.config";
import {
  getUserByIdService,
  updateProfileService,
  deleteAccountService,
} from "../services/user.service";
import {
  updateProfileSchema,
  deleteAccountSchema,
} from "../validation/user.validation";

export const getCurrentUserController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;

    const user = await getUserByIdService(userId);

    return res.status(HTTPSTATUS.OK).json({
      message: "User fetch successfully",
      user,
    });
  }
);

export const updateProfileController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const body = updateProfileSchema.parse(req.body);

    const { user } = await updateProfileService(userId, body);

    return res.status(HTTPSTATUS.OK).json({
      message: "Profile updated successfully",
      user,
    });
  }
);

export const deleteAccountController = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const { password } = deleteAccountSchema.parse(req.body);

    await deleteAccountService(userId, password);

    return res.status(HTTPSTATUS.OK).json({
      message: "Account deleted successfully",
    });
  }
);
