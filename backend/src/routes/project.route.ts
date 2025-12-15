import { Router } from 'express';
import { createProjectController, 
        getAllProjectsInWorkspaceController, 
        getProjectByIdAndWorkspaceIdController
     } from '../controllers/project.controller';


const projectRoutes = Router();

projectRoutes.post("/workspace/:workspaceId/create", createProjectController);

projectRoutes.get(
    "/workspace/:workspaceId/all",
    getAllProjectsInWorkspaceController
  );

  projectRoutes.get(
    "/:id/workspace/:workspaceId",
    getProjectByIdAndWorkspaceIdController
  );


  export default projectRoutes;