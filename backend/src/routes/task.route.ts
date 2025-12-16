import { Router } from "express";
import { createTaskController, deleteTaskController, getAllTasksController, getTaskByIdController, updateTaskController } from "../controllers/task.controller";

const taskRoutes = Router();


taskRoutes.post(
    "/project/:projectId/workspace/:workspaceId/create",
    createTaskController
  );

taskRoutes.put(
    "/:id/project/:projectId/workspace/:workspaceId/update",
    updateTaskController
  );

taskRoutes.get("/workspace/:workspaceId/all", getAllTasksController);


taskRoutes.delete("/:id/workspace/:workspaceId/delete", deleteTaskController);


taskRoutes.get(
    "/:id/project/:projectId/workspace/:workspaceId",
    getTaskByIdController
  );

export default taskRoutes;