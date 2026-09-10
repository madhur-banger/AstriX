import { z } from "zod";

export const emojiSchema = z.string().trim().optional();
export const nameSchema = z.string().trim().min(1).max(255);
export const descriptionSchema = z.string().trim().optional();

export const projectIdSchema = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, { message: "Invalid project ID" });

export const createProjectSchema = z.object({
  emoji: emojiSchema,
  name: nameSchema,
  description: descriptionSchema,
});

export const updateProjectSchema = z.object({
  emoji: emojiSchema,
  name: nameSchema,
  description: descriptionSchema,
});

// Query params bypassed Zod entirely before (hand-parsed via parseInt(...)
// || default in the controller) - unlike every request body in this
// codebase. This also caps pageSize, which was previously unbounded (a
// client could request pageSize=999999 and get the whole collection).
export const paginationQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  pageNumber: z.coerce.number().int().min(1).optional().default(1),
});
