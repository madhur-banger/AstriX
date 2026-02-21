/**
 * UNIT TESTS: bcrypt.ts
 * ------------------------
 * Uses REAL bcrypt (not mocked) - hashing/comparing are fast enough at
 * these sizes, and this is the one file whose entire job is "does bcrypt
 * actually work the way we call it," which a mock can't verify.
 */

import { describe, it, expect } from "vitest";

import { hashValue, compareValue } from "../../../src/utils/bcrypt";

describe("hashValue", () => {
  it("produces a hash different from the plaintext input", async () => {
    const hash = await hashValue("Hunter@22");
    expect(hash).not.toBe("Hunter@22");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("produces a bcrypt-formatted hash (starts with $2)", async () => {
    const hash = await hashValue("Hunter@22");
    expect(hash).toMatch(/^\$2[aby]?\$\d{2}\$/);
  });

  it("produces different hashes for the same input across calls (random salt)", async () => {
    const hash1 = await hashValue("same-input");
    const hash2 = await hashValue("same-input");
    expect(hash1).not.toBe(hash2);
  });
});

describe("compareValue", () => {
  it("returns true for a matching plaintext/hash pair", async () => {
    const hash = await hashValue("correct-password");
    await expect(compareValue("correct-password", hash)).resolves.toBe(true);
  });

  it("returns false for a mismatching pair", async () => {
    const hash = await hashValue("correct-password");
    await expect(compareValue("wrong-password", hash)).resolves.toBe(false);
  });
});
