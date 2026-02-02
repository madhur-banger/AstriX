import { z } from "zod";

export const nameSchema = z
  .string()
  .trim()
  .min(1, { message: "Name is required" })
  .max(255);

export const descriptionSchema = z.string().trim().optional();

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const workspaceIdSchema = z
  .string()
  .trim()
  .regex(objectIdRegex, { message: "Invalid workspace ID" });

// Identifies the targeted USER, not the Member document that joins them to
// the workspace - every consumer resolves it as
// `MemberModel.findOne({ userId, workspaceId })`.
export const userIdSchema = z
  .string()
  .trim()
  .regex(objectIdRegex, { message: "Invalid user ID" });

export const changeRoleSchema = z.object({
  roleId: z
    .string()
    .trim()
    .regex(objectIdRegex, { message: "Invalid role ID" }),
  // The request-body key stays `memberId` because it's a published wire
  // contract the deployed client still sends. The value is a user id (see
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
