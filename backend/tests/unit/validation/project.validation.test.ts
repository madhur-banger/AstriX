import { describe, it, expect } from "vitest";

import {
  emojiSchema,
  nameSchema,
  descriptionSchema,
  projectIdSchema,
  createProjectSchema,
  updateProjectSchema,
  paginationQuerySchema,
} from "../../../src/validation/project.validation";

const validUuid = "9f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

describe("emojiSchema", () => {
  it("accepts an emoji string", () => {
    const result = emojiSchema.safeParse("🚀");
    expect(result.success).toBe(true);
  });

  it("accepts undefined", () => {
    const result = emojiSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("nameSchema", () => {
  it("requires a non-empty value", () => {
    const result = nameSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });

  it("trims whitespace", () => {
    const result = nameSchema.safeParse("  Project Name  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Project Name");
  });

  it("accepts exactly 255 characters", () => {
    const result = nameSchema.safeParse("a".repeat(255));
    expect(result.success).toBe(true);
  });

  it("rejects more than 255 characters", () => {
    const result = nameSchema.safeParse("a".repeat(256));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
  });
});

describe("descriptionSchema", () => {
  it("is optional", () => {
    const result = descriptionSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it("accepts a normal string", () => {
    const result = descriptionSchema.safeParse("Some description");
    expect(result.success).toBe(true);
  });
});

describe("projectIdSchema", () => {
  it("accepts a valid UUID", () => {
    const result = projectIdSchema.safeParse(validUuid);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid string with the correct message", () => {
    const result = projectIdSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid project ID");
    }
  });
});

describe("createProjectSchema", () => {
  it("accepts a full valid object", () => {
    const result = createProjectSchema.safeParse({
      emoji: "🚀",
      name: "Testing Project",
      description: "Project description",
    });
    expect(result.success).toBe(true);
  });

  it("accepts missing optional fields since only name is required", () => {
    const result = createProjectSchema.safeParse({ name: "Testing Project" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = createProjectSchema.safeParse({ description: "no name here" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });
});

describe("updateProjectSchema", () => {
  it("accepts a full valid object", () => {
    const result = updateProjectSchema.safeParse({
      emoji: "🔥",
      name: "Updated Project",
      description: "Updated description",
    });
    expect(result.success).toBe(true);
  });

  it("accepts missing optional fields since only name is required", () => {
    const result = updateProjectSchema.safeParse({ name: "Updated Project" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = updateProjectSchema.safeParse({ emoji: "🔥" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });
});

describe("paginationQuerySchema", () => {
  it("defaults pageSize to 10 and pageNumber to 1 when omitted", () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ pageSize: 10, pageNumber: 1 });
  });

  it("coerces numeric strings from query params", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "20", pageNumber: "3" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ pageSize: 20, pageNumber: 3 });
  });

  it("rejects pageSize above 100", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "101" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "pageSize")).toBe(true);
    }
  });

  it("rejects pageSize below 1", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "pageSize")).toBe(true);
    }
  });

  it("rejects pageNumber below 1", () => {
    const result = paginationQuerySchema.safeParse({ pageNumber: "0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "pageNumber")).toBe(true);
    }
  });

  it("rejects a non-numeric pageSize", () => {
    const result = paginationQuerySchema.safeParse({ pageSize: "abc" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "pageSize")).toBe(true);
    }
  });
});
