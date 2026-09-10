// Shapes derived from src/models/user.model.ts (responses) and
// src/validation/user.validation.ts (request bodies) - keep them in step
// with those two files. `password` is deliberately absent: every user-facing
// response goes through omitPassword().
export const userSchemas = {
  User: {
    type: "object",
    properties: {
      _id: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d1" },
      name: { type: "string", example: "John Doe" },
      email: { type: "string", format: "email", example: "john@example.com" },
      profilePicture: {
        type: "string",
        nullable: true,
        example: "https://cdn.example.com/avatars/john.png",
      },
      isActive: { type: "boolean", example: true },
      // Advisory only - an unverified email never blocks login.
      isEmailVerified: { type: "boolean", example: false },
      lastLogin: { type: "string", format: "date-time", nullable: true },
      currentWorkspace: {
        type: "string",
        nullable: true,
        example: "64f1a2b3c4d5e6f7a8b9c0d2",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },

  UpdateProfileInput: {
    type: "object",
    description: "At least one field must be provided.",
    minProperties: 1,
    properties: {
      name: {
        type: "string",
        minLength: 2,
        maxLength: 50,
        example: "John Doe",
      },
      profilePicture: {
        type: "string",
        format: "uri",
        nullable: true,
        example: "https://cdn.example.com/avatars/john.png",
      },
    },
  },

  DeleteAccountInput: {
    type: "object",
    // Optional at the schema level on purpose: the service requires it only
    // for accounts that actually have a password (OAuth-only accounts don't).
    properties: {
      password: { type: "string", minLength: 1, example: "test1234" },
    },
  },

  Session: {
    type: "object",
    properties: {
      id: { type: "string", example: "64f1a2b3c4d5e6f7a8b9c0d1" },
      userAgent: { type: "string", nullable: true, example: "Mozilla/5.0" },
      ipAddress: { type: "string", nullable: true, example: "203.0.113.10" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
};
