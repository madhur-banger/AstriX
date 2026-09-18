import { z } from "zod";

export const nameSchema = z
  .string()
  .trim()
  .min(1, { message: "Name is required" })
  .max(255);

export const descriptionSchema = z.string().trim().optional();

export const workspaceIdSchema = z.string().trim().uuid({ message: "Invalid workspace ID" });

// Identifies the targeted USER, not the workspace_members row that joins
// them to the workspace.
export const userIdSchema = z.string().trim().uuid({ message: "Invalid user ID" });

export const changeRoleSchema = z.object({
  roleId: z.string().trim().uuid({ message: "Invalid role ID" }),
  // The request-body key stays `memberId` because it mirrors the Mongo
  // app's published wire contract. The value is a user id (see
  // userIdSchema above); everything downstream of this parse names it so.
  memberId: userIdSchema,
});

export const createWorkspaceSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
});

export const updateWorkspaceSchema = z.object({
  name: nameSchema,
  description: descriptionSchema,
});
