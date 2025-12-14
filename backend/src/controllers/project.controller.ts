import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { workspaceIdSchema } from "../validation/workspace.validation";
import { createProjectSchema } from "../validation/project.validation";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { roleGuard } from "../utils/roleGuard";
import { Permissions } from "../enums/role.enum";
import { createProjectService } from "../services/project.service";
import { HTTPSTATUS } from "../config/http.config";


export const createProjectController = asyncHandler(
    async (req: Request, res: Response) => {
        const body = createProjectSchema.parse(req.body);
        const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
    
        const userId = req.user?._id;
        const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
        roleGuard(role, [Permissions.CREATE_PROJECT]);

        const { project } = await createProjectService(userId, workspaceId, body);

        return res.status(HTTPSTATUS.CREATED).json({
        message: "Project created successfully",
        project,
        });
  }
);
//efoifvjmem
