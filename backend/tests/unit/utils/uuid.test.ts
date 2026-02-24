/**
 * UNIT TESTS: uuid.ts
 */

import { describe, it, expect } from "vitest";

import { generateInviteCode, generateTaskCode } from "../../../src/utils/uuid";

describe("generateInviteCode", () => {
  it("returns an 8-character lowercase hex-ish string with no dashes", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(8);
    expect(code).not.toContain("-");
    expect(code).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns a different value on each call", () => {
    const a = generateInviteCode();
    const b = generateInviteCode();
    expect(a).not.toBe(b);
  });
});

describe("generateTaskCode", () => {
  it("returns a 'task-' prefixed code with a 3-character suffix and no dashes in the uuid part", () => {
    const code = generateTaskCode();
    expect(code).toMatch(/^task-[0-9a-f]{3}$/);
  });

  it("returns a different value on each call", () => {
    const a = generateTaskCode();
    const b = generateTaskCode();
    expect(a).not.toBe(b);
  });
});
