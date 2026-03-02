import { describe, it, expect } from "vitest";

import {
  emailSchema,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../../../src/validation/auth.validation";

const validPassword = "Hunter@22";

describe("emailSchema", () => {
  it("accepts a valid email", () => {
    expect(emailSchema.parse("user@example.com")).toBe("user@example.com");
  });

  it("trims whitespace", () => {
    expect(emailSchema.parse("  user@example.com  ")).toBe("user@example.com");
  });

  it("rejects an invalid email format", () => {
    expect(() => emailSchema.parse("not-an-email")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => emailSchema.parse("")).toThrow();
  });

  it("rejects more than 255 characters", () => {
    const longEmail = `${"a".repeat(250)}@b.com`;
    expect(() => emailSchema.parse(longEmail)).toThrow();
  });
});

describe("registerSchema (password + name rules)", () => {
  const base = { name: "New User", email: "user@example.com" };

  it("accepts a password with upper/lower/number/special char, min 8 chars", () => {
    expect(registerSchema.parse({ ...base, password: validPassword })).toEqual({
      ...base,
      password: validPassword,
    });
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(() => registerSchema.parse({ ...base, password: "Ab1@" })).toThrow();
  });

  it("rejects a password missing an uppercase letter", () => {
    expect(() =>
      registerSchema.parse({ ...base, password: "hunter@22" })
    ).toThrow();
  });

  it("rejects a password missing a lowercase letter", () => {
    expect(() =>
      registerSchema.parse({ ...base, password: "HUNTER@22" })
    ).toThrow();
  });

  it("rejects a password missing a number", () => {
    expect(() =>
      registerSchema.parse({ ...base, password: "Hunter@AB" })
    ).toThrow();
  });

  it("rejects a password missing a special character", () => {
    expect(() =>
      registerSchema.parse({ ...base, password: "Hunter22" })
    ).toThrow();
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(() =>
      registerSchema.parse({ ...base, name: "A", password: validPassword })
    ).toThrow();
  });

  it("rejects a name longer than 50 characters", () => {
    expect(() =>
      registerSchema.parse({
        ...base,
        name: "a".repeat(51),
        password: validPassword,
      })
    ).toThrow();
  });

  it("trims the name", () => {
    const result = registerSchema.parse({
      ...base,
      name: "  Padded Name  ",
      password: validPassword,
    });
    expect(result.name).toBe("Padded Name");
  });
});

describe("loginSchema", () => {
  it("accepts a valid email/password pair", () => {
    const result = loginSchema.parse({
      email: "user@example.com",
      password: validPassword,
    });
    expect(result.email).toBe("user@example.com");
  });

  it("rejects a missing password", () => {
    expect(() => loginSchema.parse({ email: "user@example.com" })).toThrow();
  });

  it("enforces the same password complexity rules as registerSchema", () => {
    expect(() =>
      loginSchema.parse({ email: "user@example.com", password: "short" })
    ).toThrow();
  });
});

describe("forgotPasswordSchema", () => {
  it("accepts a valid email", () => {
    expect(
      forgotPasswordSchema.parse({ email: "user@example.com" }).email
    ).toBe("user@example.com");
  });

  it("rejects an invalid email", () => {
    expect(() => forgotPasswordSchema.parse({ email: "nope" })).toThrow();
  });
});

describe("resetPasswordSchema", () => {
  const base = { token: "reset-token-123", password: validPassword };

  it("accepts when password and confirmPassword match", () => {
    const result = resetPasswordSchema.parse({
      ...base,
      confirmPassword: validPassword,
    });
    expect(result.password).toBe(validPassword);
  });

  it("rejects when password and confirmPassword don't match", () => {
    expect(() =>
      resetPasswordSchema.parse({
        ...base,
        confirmPassword: "Different@22",
      })
    ).toThrow();
  });

  it("reports the mismatch error on the confirmPassword field", () => {
    const result = resetPasswordSchema.safeParse({
      ...base,
      confirmPassword: "Different@22",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["confirmPassword"]);
      expect(result.error.issues[0].message).toBe("Passwords do not match");
    }
  });

  it("rejects a missing/empty token", () => {
    expect(() =>
      resetPasswordSchema.parse({
        token: "",
        password: validPassword,
        confirmPassword: validPassword,
      })
    ).toThrow();
  });
});
