/**
 * UNIT TESTS: get-env.ts
 * -------------------------
 * Manipulates process.env directly, saving/restoring the one key it
 * touches around each case so this doesn't pollute the values
 * tests/setup/testEnv.setup.ts seeded for every other test file.
 */

import { describe, it, expect, afterEach } from "vitest";

import { getEnv } from "../../../src/utils/get-env";

const TEST_KEY = "__GET_ENV_TEST_KEY__";

describe("getEnv", () => {
  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  it("returns the env var's value when it's set", () => {
    process.env[TEST_KEY] = "real-value";
    expect(getEnv(TEST_KEY)).toBe("real-value");
  });

  it("returns the default when the env var is unset and a default is given", () => {
    expect(getEnv(TEST_KEY, "fallback")).toBe("fallback");
  });

  it("throws when the env var is unset and no default is given", () => {
    expect(() => getEnv(TEST_KEY)).toThrow(
      `Environment variable ${TEST_KEY} is not set`
    );
  });

  it("prefers the real env var value over the default when both exist", () => {
    process.env[TEST_KEY] = "actual";
    expect(getEnv(TEST_KEY, "fallback")).toBe("actual");
  });
});
