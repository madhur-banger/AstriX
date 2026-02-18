import { TaskPriorityEnum, TaskStatusEnum } from "../../enums/task.enum";

const statusValues = Object.values(TaskStatusEnum);
const priorityValues = Object.values(TaskPriorityEnum);

// Shapes derived from src/models/task.model.ts (responses) and
// src/validation/task.validation.ts (request bodies) - keep them in step
// with those two files. The status/priority enums are read straight off
// src/enums/task.enum.ts so the docs can't drift from the real values.
export const taskSchemas = {
  Task: {
    type: "object",
    properties: {
      _id: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d1" },
      taskCode: { type: "string", example: "task-a1b2c3" },
      title: { type: "string", example: "Ship the pricing page" },
      description: {
        type: "string",
        nullable: true,
        example: "Blocked on final copy",
      },
      project: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d2" },
      workspace: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d3" },
      status: { type: "string", enum: statusValues, example: statusValues[1] },
      priority: {
        type: "string",
        enum: priorityValues,
        example: priorityValues[1],
      },
      assignedTo: {
        type: "string",
        nullable: true,
        example: "64f1a2b3c4d5e6f7a8b9c0d4",
      },
      createdBy: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d5" },
      dueDate: { type: "string", format: "date-time", nullable: true },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  CreateTaskInput: {
    type: "object",
    required: ["title", "priority", "status"],
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        example: "Ship the pricing page",
      },
      description: { type: "string", example: "Blocked on final copy" },
      priority: { type: "string", enum: priorityValues },
      status: { type: "string", enum: statusValues },
      // Must be a user who is already a member of the workspace - the
      // service rejects anyone else with a 400.
      assignedTo: {
        type: "string",
        nullable: true,
        example: "64f1a2b3c4d5e6f7a8b9c0d4",
      },
      dueDate: { type: "string", format: "date-time" },
    },
  },

  UpdateTaskInput: {
    type: "object",
    required: ["title", "priority", "status"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 255 },
      description: { type: "string" },
      priority: { type: "string", enum: priorityValues },
      status: { type: "string", enum: statusValues },
      assignedTo: { type: "string", nullable: true },
      dueDate: { type: "string", format: "date-time" },
    },
  },
};
