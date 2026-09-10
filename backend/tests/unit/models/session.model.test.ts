/**
 * MODEL TESTS: session.model.ts
 * ----------------------------------
 * TTL expiry itself isn't practically testable in a unit test without
 * waiting for (or mocking) MongoDB's background reaper, so this only
 * asserts the index CONFIGURATION is correct - that's the thing a silent
 * schema edit could actually break undetected.
 */

import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

import SessionModel from "../../../src/models/session.model";

describe("SessionModel", () => {
  it("declares a TTL index on expiresAt with expireAfterSeconds: 0", () => {
    const indexes = SessionModel.schema.indexes();
    const ttlIndex = indexes.find(([fields]) =>
      Object.prototype.hasOwnProperty.call(fields, "expiresAt")
    );

    expect(ttlIndex).toBeDefined();
    expect(ttlIndex![1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it("declares a compound index on {userId, isValid}", () => {
    const indexes = SessionModel.schema.indexes();
    const compoundIndex = indexes.find(
      ([fields]) =>
        Object.prototype.hasOwnProperty.call(fields, "userId") &&
        Object.prototype.hasOwnProperty.call(fields, "isValid")
    );

    expect(compoundIndex).toBeDefined();
    expect(compoundIndex![0]).toEqual({ userId: 1, isValid: 1 });
  });

  it("persists and defaults isValid to true", async () => {
    const session = await SessionModel.create({
      userId: new mongoose.Types.ObjectId(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    expect(session.isValid).toBe(true);
  });
});
