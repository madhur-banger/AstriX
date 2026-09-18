import { describe, it, expect } from "vitest";

import {
  nameSchema,
  descriptionSchema,
  workspaceIdSchema,
  userIdSchema,
  changeRoleSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../../../src/validation/workspace.validation";

const validUuid = "9f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const validUuid2 = "1a2b3c4d-5e6f-4a5b-8c6d-7e8f9a0b1c2e";

describe("nameSchema", () => {
  it("requires a non-empty value", () => {
    const result = nameSchema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === "Name is required")).toBe(
        true
      );
    }
  });

  it("trims whitespace", () => {
    const result = nameSchema.safeParse("  My Workspace  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("My Workspace");
  });
});

describe("descriptionSchema", () => {
  it("is optional", () => {
    const result = descriptionSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });
});

describe("workspaceIdSchema", () => {
  it("accepts a valid UUID", () => {
    const result = workspaceIdSchema.safeParse(validUuid);
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID with 'Invalid workspace ID'", () => {
    const result = workspaceIdSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid workspace ID");
    }
  });
});

describe("userIdSchema", () => {
  it("accepts a valid UUID", () => {
    const result = userIdSchema.safeParse(validUuid);
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID with 'Invalid user ID'", () => {
    const result = userIdSchema.safeParse("not-a-uuid");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid user ID");
    }
  });
});

describe("changeRoleSchema", () => {
  it("accepts valid roleId and memberId", () => {
    const result = changeRoleSchema.safeParse({ roleId: validUuid, memberId: validUuid2 });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid roleId", () => {
    const result = changeRoleSchema.safeParse({ roleId: "not-a-uuid", memberId: validUuid2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === "roleId" && issue.message === "Invalid role ID"
        )
      ).toBe(true);
    }
  });

  it("rejects an invalid memberId", () => {
    const result = changeRoleSchema.safeParse({ roleId: validUuid, memberId: "not-a-uuid" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === "memberId" && issue.message === "Invalid user ID"
        )
      ).toBe(true);
    }
  });
});

describe("createWorkspaceSchema", () => {
  it("accepts name and description", () => {
    const result = createWorkspaceSchema.safeParse({
      name: "Engineering",
      description: "Eng workspace",
    });
    expect(result.success).toBe(true);
  });

  it("accepts name without description", () => {
    const result = createWorkspaceSchema.safeParse({ name: "Engineering" });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = createWorkspaceSchema.safeParse({ description: "no name" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });
});

describe("updateWorkspaceSchema", () => {
  it("accepts name and description", () => {
    const result = updateWorkspaceSchema.safeParse({
      name: "Updated Workspace",
      description: "Updated description",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const result = updateWorkspaceSchema.safeParse({ description: "no name" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });
});
