/**
 * MODEL TESTS: user.model.ts
 * ------------------------------
 * Run against the real in-memory MongoDB (tests/setup/vitest.setup.ts) - no
 * model mocks. This exercises the schema's hooks/methods/constraints
 * directly, which no controller/service/e2e test happens to cover on its
 * own (e.g. "does the password hash change on an unrelated field update").
 */

import { describe, it, expect } from "vitest";

import UserModel from "../../../src/models/user.model";

describe("UserModel", () => {
  it("hashes the password on save via the pre-save hook", async () => {
    const user = await UserModel.create({
      name: "Hash Test",
      email: `hash-${Date.now()}@example.com`,
      password: "PlaintextPassword1!",
    });

    expect(user.password).not.toBe("PlaintextPassword1!");
    expect(user.password).toMatch(/^\$2[aby]?\$\d{2}\$/);
  });

  it("does NOT re-hash the password when saving an unrelated field", async () => {
    const user = await UserModel.create({
      name: "No Rehash",
      email: `norehash-${Date.now()}@example.com`,
      password: "PlaintextPassword1!",
    });
    const hashAfterCreate = user.password;

    user.name = "Renamed";
    await user.save();

    expect(user.password).toBe(hashAfterCreate);
  });

  it("comparePassword returns true for the correct plaintext and false for a wrong one", async () => {
    const user = await UserModel.create({
      name: "Compare Test",
      email: `compare-${Date.now()}@example.com`,
      password: "CorrectHorse1!",
    });

    await expect(user.comparePassword("CorrectHorse1!")).resolves.toBe(true);
    await expect(user.comparePassword("WrongGuess")).resolves.toBe(false);
  });

  it("omitPassword strips the password field from the returned object", async () => {
    const user = await UserModel.create({
      name: "Omit Test",
      email: `omit-${Date.now()}@example.com`,
      password: "SomePassword1!",
    });

    const result = user.omitPassword();
    expect(result).not.toHaveProperty("password");
  });

  it("rejects a duplicate email (unique index), including case-insensitivity via lowercase:true", async () => {
    const email = `dup-${Date.now()}@example.com`;
    await UserModel.create({ name: "First", email });

    await expect(
      UserModel.create({ name: "Second", email: email.toUpperCase() })
    ).rejects.toThrow();
  });
});
