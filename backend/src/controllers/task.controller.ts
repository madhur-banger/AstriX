import { Request, Response } from "express";
import { asyncHandler } from "../middlewares/asyncHandler.middleware";
import { createTasksSchema, taskIdSchema, updateTaskSchema } from "../validation/task.validation";
import { projectIdSchema } from "../validation/project.validation";
import { workspaceIdSchema } from "../validation/workspace.validation";
import { getMemberRoleInWorkspace } from "../services/member.service";
import { roleGuard } from "../utils/roleGuard";
import { createTaskService, deleteTaskService, getTaskByIdService, updateTaskService } from "../services/task.service";
import { HTTPSTATUS } from "../config/http.config";
import { Permissions } from "../enums/role.enum";


export const createTaskController = asyncHandler(
    async (req: Request, res: Response) => {
      const userId = req.user?._id;
  
      const body = createTasksSchema.parse(req.body);
      const projectId = projectIdSchema.parse(req.params.projectId);
      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
  
      const { role } = await getMemberRoleInWorkspace(userId, workspaceId);
      roleGuard(role, [Permissions.CREATE_TASK]);
  
      const { task } = await createTaskService(
        workspaceId,
        projectId,
        userId,
        body
      );
  
      return res.status(HTTPSTATUS.OK).json({
        message: "Task created successfully",
        task,
      });
    }
  );


