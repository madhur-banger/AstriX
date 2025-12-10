import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { createWorkspaceSchema } from "../validation/workspace.validation";
import { createWorkspaceService, getAllWorkspaceUserIsMemberService } from "../services/workspace.service";
import { HTTPSTATUS } from "../config/http.config";



export const createWorkspaceController = asyncHandler(
    async(req: Request, res: Response) => {
        const body = createWorkspaceSchema.parse(req.body);

        const userId = req.user?._id;
        const {workspace} = await createWorkspaceService(userId, body);

        return res.status(HTTPSTATUS.CREATED).json({
            message: "Workspace created successfully",
            workspace,
        });
    }
);


export const getAllWorkspaceUserIsMemberController = asyncHandler(
    async(req: Request, res: Response) => {
        const userId = req.user?._id;


        const {workspaces} = await getAllWorkspaceUserIsMemberService(userId);


        return res.status(HTTPSTATUS.OK).json({
            message: "User's workspaces fetched successfully",
            workspaces,
        })
    }
)
