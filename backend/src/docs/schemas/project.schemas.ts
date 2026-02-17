// Shapes derived from src/models/project.model.ts (responses) and
// src/validation/project.validation.ts (request bodies) - keep them in step
// with those two files.
export const projectSchemas = {
  Project: {
    type: "object",
    properties: {
      _id: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d1" },
      name: { type: "string", example: "Website Redesign" },
      description: {
        type: "string",
        nullable: true,
        example: "Q3 marketing site refresh",
      },
      emoji: { type: "string", example: "📊" },
      workspace: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d2" },
      createdBy: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d3" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  CreateProjectInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        example: "Website Redesign",
      },
      description: { type: "string", example: "Q3 marketing site refresh" },
      emoji: { type: "string", example: "📊" },
    },
  },

  UpdateProjectInput: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 255,
        example: "Website Redesign v2",
      },
      description: { type: "string", example: "Scope trimmed for Q4" },
      emoji: { type: "string", example: "🚀" },
    },
  },

  // Shared by every paginated list endpoint (projects and tasks alike) -
  // see paginationQuerySchema in the validation files.
  Pagination: {
    type: "object",
    properties: {
      pageSize: { type: "integer", minimum: 1, maximum: 100, example: 10 },
      pageNumber: { type: "integer", minimum: 1, example: 1 },
      totalCount: { type: "integer", example: 42 },
      totalPages: { type: "integer", example: 5 },
      skip: { type: "integer", example: 0 },
    },
  },
};
