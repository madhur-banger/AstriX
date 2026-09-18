import { describe, it, expect } from "vitest";

import {
  updateProfileSchema,
  deleteAccountSchema,
} from "../../../src/validation/user.validation";

describe("updateProfileSchema", () => {
  it("rejects an empty object (at least one field required)", () => {
    const result = updateProfileSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "At least one field (name, profilePicture) must be provided"
      );
    }
  });

  it("accepts only name", () => {
    const result = updateProfileSchema.safeParse({ name: "Jane Doe" });
    expect(result.success).toBe(true);
  });

  it("accepts only profilePicture", () => {
    const result = updateProfileSchema.safeParse({
      profilePicture: "https://example.com/avatar.png",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid non-URL profilePicture", () => {
    const result = updateProfileSchema.safeParse({ profilePicture: "not-a-url" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "profilePicture")).toBe(true);
    }
  });

  it("accepts an explicit null profilePicture", () => {
    const result = updateProfileSchema.safeParse({ profilePicture: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.profilePicture).toBeNull();
  });

  it("rejects a name shorter than 2 characters", () => {
    const result = updateProfileSchema.safeParse({ name: "A" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });

  it("rejects a name longer than 50 characters", () => {
    const result = updateProfileSchema.safeParse({ name: "a".repeat(51) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });
});

describe("deleteAccountSchema", () => {
  it("accepts an empty object since password is optional", () => {
    const result = deleteAccountSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects an empty string password", () => {
    const result = deleteAccountSchema.safeParse({ password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "password")).toBe(true);
    }
  });

  it("accepts a real password string", () => {
    const result = deleteAccountSchema.safeParse({ password: "correct-horse" });
    expect(result.success).toBe(true);
  });
});
