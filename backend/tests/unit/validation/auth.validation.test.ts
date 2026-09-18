import { describe, it, expect } from "vitest";

import {
  emailSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
  sessionIdSchema,
} from "../../../src/validation/auth.validation";

const validPassword = "Hunter@22";
const validUuid = "9f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const mongoObjectId = "64f1a2b3c4d5e6f7a8b9c0d1";

describe("emailSchema", () => {
  it("accepts a valid email", () => {
    const result = emailSchema.safeParse("user@example.com");
    expect(result.success).toBe(true);
  });

  it("trims whitespace", () => {
    const result = emailSchema.safeParse("  user@example.com  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("user@example.com");
  });

  it("rejects an invalid email format", () => {
    const result = emailSchema.safeParse("not-an-email");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual([]);
  });

  it("rejects an empty string", () => {
    const result = emailSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects more than 255 characters", () => {
    const longEmail = `${"a".repeat(250)}@b.com`;
    const result = emailSchema.safeParse(longEmail);
    expect(result.success).toBe(false);
  });
});

describe("password rules (via registerSchema/loginSchema)", () => {
  const base = { name: "New User", email: "user@example.com" };

  it("accepts a password meeting all complexity rules", () => {
    const result = registerSchema.safeParse({ ...base, password: validPassword });
    expect(result.success).toBe(true);
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = registerSchema.safeParse({ ...base, password: "Ab1@" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "password")).toBe(true);
    }
  });

  it("rejects a password missing an uppercase letter", () => {
    const result = registerSchema.safeParse({ ...base, password: "hunter@22" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === "password" &&
            issue.message.includes("uppercase")
        )
      ).toBe(true);
    }
  });

  it("rejects a password missing a lowercase letter", () => {
    const result = registerSchema.safeParse({ ...base, password: "HUNTER@22" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === "password" &&
            issue.message.includes("lowercase")
        )
      ).toBe(true);
    }
  });

  it("rejects a password missing a digit", () => {
    const result = registerSchema.safeParse({ ...base, password: "Hunter@AB" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === "password" && issue.message.includes("number")
        )
      ).toBe(true);
    }
  });

  it("rejects a password missing a special character", () => {
    const result = registerSchema.safeParse({ ...base, password: "Hunter22" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path[0] === "password" &&
            issue.message.includes("special character")
        )
      ).toBe(true);
    }
  });
});

describe("nameSchema (via registerSchema)", () => {
  const base = { email: "user@example.com", password: validPassword };

  it("rejects a name shorter than 2 characters", () => {
    const result = registerSchema.safeParse({ ...base, name: "A" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });

  it("rejects a name longer than 50 characters", () => {
    const result = registerSchema.safeParse({ ...base, name: "a".repeat(51) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "name")).toBe(true);
    }
  });

  it("trims the name", () => {
    const result = registerSchema.safeParse({ ...base, name: "  Padded Name  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Padded Name");
  });
});

describe("registerSchema", () => {
  const valid = { name: "New User", email: "user@example.com", password: validPassword };

  it("accepts a fully valid object", () => {
    const result = registerSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a missing password", () => {
    const { password: _password, ...rest } = valid;
    const result = registerSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "password")).toBe(true);
    }
  });

  it("rejects an invalid email", () => {
    const result = registerSchema.safeParse({ ...valid, email: "nope" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "email")).toBe(true);
    }
  });
});

describe("loginSchema", () => {
  it("accepts a valid email/password pair", () => {
    const result = loginSchema.safeParse({ email: "user@example.com", password: validPassword });
    expect(result.success).toBe(true);
  });

  it("rejects a missing email", () => {
    const result = loginSchema.safeParse({ password: validPassword });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "email")).toBe(true);
    }
  });
});

describe("forgotPasswordSchema", () => {
  it("accepts a valid email", () => {
    const result = forgotPasswordSchema.safeParse({ email: "user@example.com" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = forgotPasswordSchema.safeParse({ email: "nope" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "email")).toBe(true);
    }
  });
});

describe("resetPasswordSchema", () => {
  const base = { token: "reset-token-123", password: validPassword };

  it("accepts when password and confirmPassword match", () => {
    const result = resetPasswordSchema.safeParse({ ...base, confirmPassword: validPassword });
    expect(result.success).toBe(true);
  });

  it("rejects when password and confirmPassword don't match, error path is confirmPassword", () => {
    const result = resetPasswordSchema.safeParse({ ...base, confirmPassword: "Different@22" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["confirmPassword"]);
      expect(result.error.issues[0].message).toBe("Passwords do not match");
    }
  });
});

describe("verifyEmailSchema", () => {
  it("accepts a non-empty token", () => {
    const result = verifyEmailSchema.safeParse({ token: "verify-token" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty token", () => {
    const result = verifyEmailSchema.safeParse({ token: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "token")).toBe(true);
    }
  });

  it("rejects a missing token", () => {
    const result = verifyEmailSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "token")).toBe(true);
    }
  });
});

describe("changePasswordSchema", () => {
  const base = { currentPassword: "OldPass@1", newPassword: validPassword };

  it("accepts when newPassword and confirmNewPassword match", () => {
    const result = changePasswordSchema.safeParse({
      ...base,
      confirmNewPassword: validPassword,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when newPassword and confirmNewPassword don't match, error path is confirmNewPassword", () => {
    const result = changePasswordSchema.safeParse({
      ...base,
      confirmNewPassword: "Different@22",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["confirmNewPassword"]);
      expect(result.error.issues[0].message).toBe("Passwords do not match");
    }
  });
});

describe("sessionIdSchema", () => {
  it("accepts a valid UUID", () => {
    const result = sessionIdSchema.safeParse(validUuid);
    expect(result.success).toBe(true);
  });

  it("rejects a Mongo-style ObjectId string (deliberate break from the Mongo-era schema)", () => {
    const result = sessionIdSchema.safeParse(mongoObjectId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Invalid session ID");
    }
  });
});
