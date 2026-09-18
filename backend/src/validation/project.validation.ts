import { z } from "zod";

export const emojiSchema = z.string().trim().optional();
export const nameSchema = z.string().trim().min(1).max(255);
export const descriptionSchema = z.string().trim().optional();

export const projectIdSchema = z.string().trim().uuid({ message: "Invalid project ID" });

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

export const paginationQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  pageNumber: z.coerce.number().int().min(1).optional().default(1),
});
