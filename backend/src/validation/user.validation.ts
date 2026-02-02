import { z } from "zod";

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(2).max(50).optional(),
    profilePicture: z.string().trim().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field (name, profilePicture) must be provided",
  });

// `password` is optional here (validated at the SERVICE layer against
// whether the account actually has one - OAuth-only accounts don't) rather
// than being required at the schema level.
export const deleteAccountSchema = z.object({
  password: z.string().min(1).optional(),
});
