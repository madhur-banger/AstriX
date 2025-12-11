import { Router } from "express";
import { createWorkspaceController, getAllWorkspaceUserIsMemberController, getWorkspaceByIdController } from "../controllers/workspace.controller";

const workspaceRoutes = Router();   


workspaceRoutes.post("/create/new", createWorkspaceController);
workspaceRoutes.get("/all", getAllWorkspaceUserIsMemberController);

workspaceRoutes.get("/:id", getWorkspaceByIdController);



export default workspaceRoutes;