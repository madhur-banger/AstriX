import { Router } from "express";
import { createWorkspaceController, getAllWorkspaceUserIsMemberController, getWorkspaceAnalyticsController, getWorkspaceByIdController, getWorkspaceMembersController } from "../controllers/workspace.controller";

const workspaceRoutes = Router();   


workspaceRoutes.post("/create/new", createWorkspaceController);
workspaceRoutes.get("/all", getAllWorkspaceUserIsMemberController);

workspaceRoutes.get("/:id", getWorkspaceByIdController);

workspaceRoutes.get("/members/:id", getWorkspaceMembersController);

workspaceRoutes.get("/analytics/:id", getWorkspaceAnalyticsController);



export default workspaceRoutes;