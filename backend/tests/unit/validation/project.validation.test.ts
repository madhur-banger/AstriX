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

describe("emojiSchema", () => {
  it("accepts an emoji string", () => {
    expect(emojiSchema.parse("👍")).toBe("👍");
  });

  it("trims leading and trailing whitespace", () => {
    expect(emojiSchema.parse("  👍  ")).toBe("👍");
  });

  it("accepts undefined", () => {
    expect(emojiSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty string", () => {
    expect(emojiSchema.parse("")).toBe("");
  });

  it("trims whitespace-only input into an empty string", () => {
    expect(emojiSchema.parse("   ")).toBe("");
  });

  it("rejects a number", () => {
    expect(() => emojiSchema.parse(123)).toThrow();
  });

  it("rejects an object", () => {
    expect(() => emojiSchema.parse({ emoji: "👍" })).toThrow();
  });

  it("rejects null", () => {
    expect(() => emojiSchema.parse(null)).toThrow();
  });
});

describe("nameSchema", () => {
  it("accepts a normal non-empty string", () => {
    expect(nameSchema.parse("Engineering Team")).toBe("Engineering Team");
  });

  it("trims leading and trailing whitespace", () => {
    expect(nameSchema.parse("   Padded Name   ")).toBe("Padded Name");
  });

  it("rejects an empty string", () => {
    expect(() => nameSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only input", () => {
    expect(() => nameSchema.parse("   ")).toThrow();
  });

  it("accepts exactly one character", () => {
    expect(nameSchema.parse("A")).toBe("A");
  });

  it("accepts exactly 255 characters", () => {
    const value = "a".repeat(255);

    expect(nameSchema.parse(value)).toBe(value);
  });

  it("rejects more than 255 characters", () => {
    expect(() => nameSchema.parse("a".repeat(256))).toThrow();
  });

  it("rejects a number", () => {
    expect(() => nameSchema.parse(123)).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => nameSchema.parse(undefined)).toThrow();
  });

  it("rejects null", () => {
    expect(() => nameSchema.parse(null)).toThrow();
  });
});

describe("descriptionSchema", () => {
  it("accepts a normal string", () => {
    expect(descriptionSchema.parse("Some description")).toBe(
      "Some description"
    );
  });

  it("trims leading and trailing whitespace", () => {
    expect(descriptionSchema.parse("  padded  ")).toBe("padded");
  });

  it("accepts undefined", () => {
    expect(descriptionSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty string", () => {
    expect(descriptionSchema.parse("")).toBe("");
  });

  it("trims whitespace-only input into an empty string", () => {
    expect(descriptionSchema.parse("   ")).toBe("");
  });

  it("rejects a number", () => {
    expect(() => descriptionSchema.parse(123)).toThrow();
  });

  it("rejects null", () => {
    expect(() => descriptionSchema.parse(null)).toThrow();
  });
});

describe("projectIdSchema", () => {
  it("accepts a normal project id", () => {
    const id = "64f1a2b3c4d5e6f7a8b9c0d1";

    expect(projectIdSchema.parse(id)).toBe(id);
  });

  it("trims leading and trailing whitespace", () => {
    expect(projectIdSchema.parse("  64f1a2b3c4d5e6f7a8b9c0d1  ")).toBe(
      "64f1a2b3c4d5e6f7a8b9c0d1"
    );
  });

  it("rejects an empty string", () => {
    expect(() => projectIdSchema.parse("")).toThrow();
  });

  it("rejects whitespace-only input", () => {
    expect(() => projectIdSchema.parse("   ")).toThrow();
  });

  it("rejects a non-empty string that is not a MongoDB ObjectId", () => {
    // A malformed id reaching Mongoose triggers a CastError; validation should
    // catch this up front instead of letting a bad-shaped string reach a query.
    expect(() =>
      projectIdSchema.parse("definitely-not-a-mongodb-object-id")
    ).toThrow();
  });

  it("rejects a single character", () => {
    expect(() => projectIdSchema.parse("a")).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => projectIdSchema.parse(undefined)).toThrow();
  });

  it("rejects a number", () => {
    expect(() => projectIdSchema.parse(123)).toThrow();
  });

  it("rejects null", () => {
    expect(() => projectIdSchema.parse(null)).toThrow();
  });
});

describe("createProjectSchema", () => {
  it("accepts name, description, and emoji", () => {
    const result = createProjectSchema.parse({
      name: "Testing Project",
      description: "Project description",
      emoji: "👍",
    });

    expect(result).toEqual({
      name: "Testing Project",
      description: "Project description",
      emoji: "👍",
    });
  });

  it("accepts only name", () => {
    const result = createProjectSchema.parse({
      name: "Testing Project",
    });

    expect(result.name).toBe("Testing Project");
    expect(result.description).toBeUndefined();
    expect(result.emoji).toBeUndefined();
  });

  it("accepts name and description without emoji", () => {
    const result = createProjectSchema.parse({
      name: "Backend Project",
      description: "API work",
    });

    expect(result.name).toBe("Backend Project");
    expect(result.description).toBe("API work");
    expect(result.emoji).toBeUndefined();
  });

  it("accepts name and emoji without description", () => {
    const result = createProjectSchema.parse({
      name: "Frontend Project",
      emoji: "🚀",
    });

    expect(result.name).toBe("Frontend Project");
    expect(result.emoji).toBe("🚀");
    expect(result.description).toBeUndefined();
  });

  it("trims all string fields", () => {
    const result = createProjectSchema.parse({
      name: "   Project Name   ",
      description: "   Project Description   ",
      emoji: "   🚀   ",
    });

    expect(result).toEqual({
      name: "Project Name",
      description: "Project Description",
      emoji: "🚀",
    });
  });

  it("rejects missing name", () => {
    expect(() =>
      createProjectSchema.parse({
        description: "Description only",
        emoji: "👍",
      })
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      createProjectSchema.parse({
        name: "",
      })
    ).toThrow();
  });

  it("rejects a whitespace-only name", () => {
    expect(() =>
      createProjectSchema.parse({
        name: "   ",
      })
    ).toThrow();
  });

  it("rejects a name longer than 255 characters", () => {
    expect(() =>
      createProjectSchema.parse({
        name: "a".repeat(256),
      })
    ).toThrow();
  });

  it("rejects a non-string name", () => {
    expect(() =>
      createProjectSchema.parse({
        name: 123,
      })
    ).toThrow();
  });

  it("rejects a non-string emoji", () => {
    expect(() =>
      createProjectSchema.parse({
        name: "Project",
        emoji: 123,
      })
    ).toThrow();
  });

  it("rejects a non-string description", () => {
    expect(() =>
      createProjectSchema.parse({
        name: "Project",
        description: 123,
      })
    ).toThrow();
  });
});

describe("updateProjectSchema", () => {
  it("accepts name, description, and emoji", () => {
    const result = updateProjectSchema.parse({
      name: "Updated Project",
      description: "Updated description",
      emoji: "🚀",
    });

    expect(result).toEqual({
      name: "Updated Project",
      description: "Updated description",
      emoji: "🚀",
    });
  });

  it("accepts name without description and emoji", () => {
    const result = updateProjectSchema.parse({
      name: "Updated Project",
    });

    expect(result.name).toBe("Updated Project");
    expect(result.description).toBeUndefined();
    expect(result.emoji).toBeUndefined();
  });

  it("trims all string fields", () => {
    const result = updateProjectSchema.parse({
      name: "   Updated Project   ",
      description: "   Updated description   ",
      emoji: "   🔥   ",
    });

    expect(result).toEqual({
      name: "Updated Project",
      description: "Updated description",
      emoji: "🔥",
    });
  });

  it("rejects an empty object", () => {
    expect(() => updateProjectSchema.parse({})).toThrow();
  });

  it("rejects description-only input because name is required", () => {
    expect(() =>
      updateProjectSchema.parse({
        description: "Only updating description",
      })
    ).toThrow();
  });

  it("rejects emoji-only input because name is required", () => {
    expect(() =>
      updateProjectSchema.parse({
        emoji: "🚀",
      })
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      updateProjectSchema.parse({
        name: "",
      })
    ).toThrow();
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      updateProjectSchema.parse({
        name: "   ",
      })
    ).toThrow();
  });

  it("rejects a name longer than 255 characters", () => {
    expect(() =>
      updateProjectSchema.parse({
        name: "a".repeat(256),
      })
    ).toThrow();
  });

  it("rejects a non-string emoji", () => {
    expect(() =>
      updateProjectSchema.parse({
        name: "Project",
        emoji: {},
      })
    ).toThrow();
  });

  it("rejects a non-string description", () => {
    expect(() =>
      updateProjectSchema.parse({
        name: "Project",
        description: [],
      })
    ).toThrow();
  });
});

describe("paginationQuerySchema", () => {
  it("defaults to pageSize 10 and pageNumber 1 when both are absent", () => {
    expect(paginationQuerySchema.parse({})).toEqual({
      pageSize: 10,
      pageNumber: 1,
    });
  });

  it("coerces string query values into numbers", () => {
    expect(
      paginationQuerySchema.parse({ pageSize: "25", pageNumber: "3" })
    ).toEqual({
      pageSize: 25,
      pageNumber: 3,
    });
  });

  it("rejects a pageSize above the 100 cap (previously unbounded)", () => {
    expect(() => paginationQuerySchema.parse({ pageSize: "999999" })).toThrow();
  });

  it("rejects a non-numeric pageSize instead of silently defaulting", () => {
    expect(() => paginationQuerySchema.parse({ pageSize: "abc" })).toThrow();
  });
});
