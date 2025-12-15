import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { workspaceIdSchema } from "../validation/workspace.validation";
import { createProjectSchema, projectIdSchema, updateProjectSchema } from "../validation/project.validation";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { roleGuard } from "../utils/roleGuard";
import { Permissions } from "../enums/role.enum";
import { createProjectService, getProjectByIdAndWorkspaceIdService, getProjectsInWorkspaceService, updateProjectService } from "../services/project.service";
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

export const getAllProjectsInWorkspaceController = asyncHandler(
    async (req: Request, res: Response) => {
      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
      const userId = req.user?._id;
  
      const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
      roleGuard(role, [Permissions.VIEW_ONLY]);
  
      const pageSize = parseInt(req.query.pageSize as string) || 10;
      const pageNumber = parseInt(req.query.pageNumber as string) || 1;
  
      const { projects, totalCount, totalPages, skip } =
        await getProjectsInWorkspaceService(workspaceId, pageSize, pageNumber);
  
      return res.status(HTTPSTATUS.OK).json({
        message: "Project fetched successfully",
        projects,
        pagination: {
          totalCount,
          pageSize,
          pageNumber,
          totalPages,
          skip,
          limit: pageSize,
        },
      });
    }
  );
  
  export const getProjectByIdAndWorkspaceIdController = asyncHandler(
    async (req: Request, res: Response) => {
      const projectId = projectIdSchema.parse(req.params.id);
      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
  
      const userId = req.user?._id;
  
      const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
      roleGuard(role, [Permissions.VIEW_ONLY]);
  
      const { project } = await getProjectByIdAndWorkspaceIdService(
        workspaceId,
        projectId
      );
  
      return res.status(HTTPSTATUS.OK).json({
        message: "Project fetched successfully",
        project,
      });
    }
  );













  export const updateProjectController = asyncHandler(
    async (req: Request, res: Response) => {
      const userId = req.user?._id;
  
      const projectId = projectIdSchema.parse(req.params.id);
      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
  
      const body = updateProjectSchema.parse(req.body);
  
      const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
      roleGuard(role, [Permissions.EDIT_PROJECT]);
  
      const { project } = await updateProjectService(
        workspaceId,
        projectId,
        body
      );
  
      return res.status(HTTPSTATUS.OK).json({
        message: "Project updated successfully",
        project,
      });
    }
  );


  