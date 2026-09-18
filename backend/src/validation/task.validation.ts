import { z } from "zod";
import { TaskPriorityEnum, TaskStatusEnum, TaskPriorityEnumType, TaskStatusEnumType } from "../enums/task.enum";

export const titleSchema = z.string().trim().min(1).max(255);
export const descriptionSchema = z.string().trim().optional();

export const assignedToSchema = z
  .string()
  .trim()
  .uuid({ message: "Invalid assignedTo user ID" })
  .nullable()
  .optional();

export const prioritySchema = z.enum(
  Object.values(TaskPriorityEnum) as [TaskPriorityEnumType, ...TaskPriorityEnumType[]]
);

export const statusSchema = z.enum(
  Object.values(TaskStatusEnum) as [TaskStatusEnumType, ...TaskStatusEnumType[]]
);

export const dueDateSchema = z
  .string()
  .trim()
  .optional()
  .refine(
    (val) => {
      return !val || !isNaN(Date.parse(val));
    },
    {
      message: "Invalid date format. Please provide a valid date string.",
    }
  );

export const taskIdSchema = z.string().trim().uuid({ message: "Invalid task ID" });

export const createTaskSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  priority: prioritySchema,
  status: statusSchema,
  assignedTo: assignedToSchema,
  dueDate: dueDateSchema,
});

export const updateTaskSchema = z.object({
  title: titleSchema,
  description: descriptionSchema,
  priority: prioritySchema,
  status: statusSchema,
  assignedTo: assignedToSchema,
  dueDate: dueDateSchema,
});

export const paginationQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(10),
  pageNumber: z.coerce.number().int().min(1).optional().default(1),
});

const commaSeparatedEnum = (allowedValues: readonly string[]) =>
  z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined))
    .refine((arr) => !arr || arr.every((v) => allowedValues.includes(v)), {
      message: `Must be a comma-separated list of: ${allowedValues.join(", ")}`,
    });

export const taskFiltersQuerySchema = z.object({
  projectId: z.string().trim().uuid({ message: "Invalid projectId" }).optional(),
  status: commaSeparatedEnum(Object.values(TaskStatusEnum)),
  priority: commaSeparatedEnum(Object.values(TaskPriorityEnum)),
  assignedTo: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val.split(",") : undefined))
    .refine((arr) => !arr || arr.every((v) => z.string().uuid().safeParse(v).success), {
      message: "assignedTo must be a comma-separated list of valid ids",
    }),
  keyword: z.string().trim().max(100).optional(),
  dueDate: dueDateSchema,
});
