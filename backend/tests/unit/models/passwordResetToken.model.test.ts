/**
 * MODEL TESTS: passwordResetToken.model.ts
 * ----------------------------------------
 * Same rationale as session.model.test.ts: TTL expiry itself isn't
 * practically testable without waiting for (or mocking) MongoDB's
 * background reaper, so this only asserts the index CONFIGURATION - the
 * thing a silent schema edit could actually break undetected.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import PasswordResetTokenModel from "../../../src/models/passwordResetToken.model";

describe("PasswordResetTokenModel", () => {
  it("declares a TTL index on expiresAt with expireAfterSeconds: 0", () => {
    const indexes = PasswordResetTokenModel.schema.indexes();
    const ttlIndex = indexes.find(([fields]) =>
      Object.prototype.hasOwnProperty.call(fields, "expiresAt")
    );

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex![1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it("requires tokenHash to be unique", () => {
    const uniqueField = PasswordResetTokenModel.schema.path("tokenHash") as any;
    expect(uniqueField.options.unique).toBe(true);
  });

  it("persists a document with the expected fields", async () => {
    const userId = new mongoose.Types.ObjectId();

    const token = await PasswordResetTokenModel.create({
      userId,
      tokenHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    expect(token.userId.equals(userId)).toBe(true);
    expect(token.tokenHash).toBe("a".repeat(64));
  });
});
