import { Router } from 'express';
import { createProjectController, 
        deleteProjectController, 
        getAllProjectsInWorkspaceController, 
        getProjectByIdAndWorkspaceIdController,
        updateProjectController
     } from '../controllers/project.controller';


const projectRoutes = Router();

projectRoutes.post("/workspace/:workspaceId/create", createProjectController);

projectRoutes.get(
    "/workspace/:workspaceId/all",
    getAllProjectsInWorkspaceController
    
);

projectRoutes.put(
    "/:id/workspace/:workspaceId/update",
    updateProjectController
);


projectRoutes.get(
    "/:id/workspace/:workspaceId",
    getProjectByIdAndWorkspaceIdController
);

projectRoutes.delete(
    "/:id/workspace/:workspaceId/delete",
    deleteProjectController
  );


export default projectRoutes;