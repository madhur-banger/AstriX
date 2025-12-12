import { Router } from "express";
import { changeWorkspaceMemberRoleController, createWorkspaceController, deleteWorkspaceByIdController, getAllWorkspaceUserIsMemberController, getWorkspaceAnalyticsController, getWorkspaceByIdController, getWorkspaceMembersController, updateWorkspaceByIdController } from "../controllers/workspace.controller";

const workspaceRoutes = Router();   


workspaceRoutes.post("/create/new", createWorkspaceController);
workspaceRoutes.get("/all", getAllWorkspaceUserIsMemberController);

workspaceRoutes.get("/:id", getWorkspaceByIdController);
workspaceRoutes.put("/update/:id", updateWorkspaceByIdController);

workspaceRoutes.put(
    "/change/member/role/:id",
    changeWorkspaceMemberRoleController
  );

workspaceRoutes.get("/members/:id", getWorkspaceMembersController);

workspaceRoutes.get("/analytics/:id", getWorkspaceAnalyticsController);
workspaceRoutes.delete("/delete/:id", deleteWorkspaceByIdController);



export default workspaceRoutes;