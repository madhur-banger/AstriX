import { describe, it, expect, vi, afterEach } from "vitest";

describe("logger", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it("is silent in test (the default here), so the suite's expected error-path logs don't spam the runner", async () => {
    // #given
    vi.resetModules();
    process.env.NODE_ENV = "test";

    // #when
    const { logger } = await import("../../../src/utils/logger");

    // #then
    expect(logger.level).toBe("silent");
  });

  it("logs at info level in production", async () => {
    // #given
    vi.resetModules();
    process.env.NODE_ENV = "production";

    // #when
    const { logger } = await import("../../../src/utils/logger");

    // #then
    expect(logger.level).toBe("info");
  });
});
