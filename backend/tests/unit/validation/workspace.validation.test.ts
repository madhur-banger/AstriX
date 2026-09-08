/**
 * UNIT TESTS: workspace.validation.ts
 * -------------------------------------
 * These are the EASIEST tests in the whole project, and deliberately the
 * first ones you should get comfortable with, because zod schemas are
 * "pure functions": same input always produces the same output, no
 * database, no network, no mocking required at all.
 *
 * The whole point of a validation schema is to draw a line between
 * "acceptable input" and "garbage input" - so for EVERY schema we test
 * BOTH sides of that line. A test file that only checks valid input tells
 * you nothing about whether your validation actually validates anything.
 */

import { describe, it, expect } from "vitest";
import {
  nameSchema,
  descriptionSchema,
  workspaceIdSchema,
  changeRoleSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../../../src/validation/workspace.validation";

describe("nameSchema", () => {
  it("accepts a normal non-empty string", () => {
    // Arrange - nothing to set up, input is inline
    // Act
    const result = nameSchema.parse("Engineering Team");
    // Assert
    expect(result).toBe("Engineering Team");
  });

  it("trims leading/trailing whitespace because the schema calls .trim()", () => {
    const result = nameSchema.parse("   Padded Name   ");
    expect(result).toBe("Padded Name");
  });

  it("rejects an empty string (violates .min(1))", () => {
    // .parse() THROWS a ZodError when validation fails - it does not return
    // undefined or null. So to test the failure case, we wrap the call in
    // a function and assert that calling it throws.
    expect(() => nameSchema.parse("")).toThrow();
  });

  it("rejects a string of only whitespace, because .trim() runs BEFORE .min(1)", () => {
    // This is a subtle but important zod behavior: `.trim()` transforms the
    // value first, so "   " becomes "" before the .min(1) check runs.
    // If this test fails, it means the schema's method order changed.
    expect(() => nameSchema.parse("   ")).toThrow();
  });

  it("rejects a string longer than 255 characters (violates .max(255))", () => {
    const tooLong = "a".repeat(256);
    expect(() => nameSchema.parse(tooLong)).toThrow();
  });

  it("accepts a string of exactly 255 characters (boundary case)", () => {
    // Testing the EXACT boundary (255, not 254 or 256) catches off-by-one
    // errors, which are one of the most common real-world bugs.
    const exactly255 = "a".repeat(255);
    expect(() => nameSchema.parse(exactly255)).not.toThrow();
  });
});

describe("descriptionSchema", () => {
  it("accepts a normal string", () => {
    expect(descriptionSchema.parse("Some description")).toBe("Some description");
  });

  it("accepts undefined, because the schema is .optional()", () => {
    expect(descriptionSchema.parse(undefined)).toBeUndefined();
  });

  it("trims whitespace like nameSchema does", () => {
    expect(descriptionSchema.parse("  padded  ")).toBe("padded");
  });
});

describe("workspaceIdSchema", () => {
  it("accepts a non-empty string id", () => {
    expect(workspaceIdSchema.parse("64f1a2b3c4d5e6f7a8b9c0d1")).toBe(
      "64f1a2b3c4d5e6f7a8b9c0d1"
    );
  });

  it("rejects an empty string", () => {
    expect(() => workspaceIdSchema.parse("")).toThrow();
  });

  // NOTE: this schema does NOT check that the string is a valid MongoDB
  // ObjectId format (24 hex chars) - it only checks "is it a non-empty
  // string". That means garbage like "not-a-real-id" currently PASSES this
  // schema and would only fail later when Mongoose tries to cast it.
  // This test documents that current (possibly surprising) behavior.
  it("currently accepts strings that are NOT valid ObjectId format (documents existing gap)", () => {
    expect(() => workspaceIdSchema.parse("definitely-not-an-object-id")).not.toThrow();
  });
});

describe("changeRoleSchema", () => {
  it("accepts a valid roleId + memberId pair", () => {
    const input = { roleId: "role-123", memberId: "member-456" };
    const result = changeRoleSchema.parse(input);
    expect(result).toEqual(input);
  });

  it("rejects a payload missing roleId", () => {
    expect(() => changeRoleSchema.parse({ memberId: "member-456" })).toThrow();
  });

  it("rejects a payload missing memberId", () => {
    expect(() => changeRoleSchema.parse({ roleId: "role-123" })).toThrow();
  });

  it("rejects extra unexpected fields being silently required as empty strings", () => {
    // .object() by default in zod STRIPS unknown keys rather than rejecting them
    // (unless .strict() was used). This test documents that current behavior -
    // if you later add .strict() to the schema, this test should start failing,
    // which is a good signal to come update it deliberately.
    const result = changeRoleSchema.parse({
      roleId: "r1",
      memberId: "m1",
      hacker: "ignored",
    } as any);
    expect(result).toEqual({ roleId: "r1", memberId: "m1" });
  });
});

describe("createWorkspaceSchema", () => {
  it("accepts name + description", () => {
    const result = createWorkspaceSchema.parse({
      name: "New Workspace",
      description: "desc",
    });
    expect(result).toEqual({ name: "New Workspace", description: "desc" });
  });

  it("accepts name without description, since description is optional", () => {
    const result = createWorkspaceSchema.parse({ name: "New Workspace" });
    expect(result.name).toBe("New Workspace");
    expect(result.description).toBeUndefined();
  });

  it("rejects a payload with no name at all", () => {
    expect(() => createWorkspaceSchema.parse({ description: "only desc" })).toThrow();
  });
});

describe("updateWorkspaceSchema", () => {
  it("is structurally identical to createWorkspaceSchema (name required, description optional)", () => {
    expect(() => updateWorkspaceSchema.parse({ name: "Renamed" })).not.toThrow();
    expect(() => updateWorkspaceSchema.parse({})).toThrow();
  });
});
