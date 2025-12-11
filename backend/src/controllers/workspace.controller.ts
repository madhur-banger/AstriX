import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { createWorkspaceSchema, workspaceIdSchema } from "../validation/workspace.validation";
import { createWorkspaceService, getAllWorkspacesUserIsMemberService, getWorkspaceByIdService, getWorkspaceMembersService } from "../services/workspace.service";
import { HTTPSTATUS } from "../config/http.config";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { roleGuard } from "../utils/roleGuard";
import { Permissions } from "../enums/role.enum";



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

        const {workspaces} = await getAllWorkspacesUserIsMemberService(userId);

        return res.status(HTTPSTATUS.OK).json({
            message: "User's workspaces fetched successfully",
            workspaces,
        })
    }
)


export const getWorkspaceByIdController = asyncHandler(
    async (req: Request, res: Response) => {
        const workspaceId = workspaceIdSchema.parse(req.params.id);
        const userId = req.user?._id;

        await getMemberRoleInWorkspace(userId, workspaceId); 

        const { workspace } = await getWorkspaceByIdService(workspaceId);

        return res.status((HTTPSTATUS.OK)).json({
            message: "Workspace fetched successfully",
            workspace,
        });
    }
);


export const getWorkspaceMembersController = asyncHandler(
    async(req: Request, res: Response) => {
        const workspaceId = workspaceIdSchema.parse(req.params.id);
        const userId = req.user?._id;

        const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
        roleGuard(role, [Permissions.VIEW_ONLY]);

        const { members, roles } = await getWorkspaceMembersService(workspaceId);

        return res.status(HTTPSTATUS.OK).json({
            message: "Workspace members retrieved successfully",
            members, 
            roles
        })
    }
)
