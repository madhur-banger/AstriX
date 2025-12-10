import { Router } from "express";
import { createWorkspaceController, getAllWorkspaceUserIsMemberController } from "../controllers/workspace.controller";

const workspaceRoutes = Router();   


workspaceRoutes.post("/create/new", createWorkspaceController);
workspaceRoutes.get("/all", getAllWorkspaceUserIsMemberController);


export default workspaceRoutes;