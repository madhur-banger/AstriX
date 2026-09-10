import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("app.config COOKIE.SECURE", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it("is false in development, so local HTTP dev can set/read the refresh-token cookie", async () => {
    // #given
    process.env.NODE_ENV = "development";

    // #when
    const { config } = await import("../../../src/config/app.config");

    // #then
    expect(config.COOKIE.SECURE).toBe(false);
  });

  it("is true in production, so the refresh-token cookie is never sent over plain HTTP", async () => {
    // #given
    process.env.NODE_ENV = "production";

    // #when
    const { config } = await import("../../../src/config/app.config");

    // #then
    expect(config.COOKIE.SECURE).toBe(true);
  });

  it("is true in test (any non-development environment), matching production behavior", async () => {
    // #given
    process.env.NODE_ENV = "test";

    // #when
    const { config } = await import("../../../src/config/app.config");

    // #then
    expect(config.COOKIE.SECURE).toBe(true);
  });
});

describe("app.config COOKIE.DOMAIN", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalCookieDomain === undefined) {
      delete process.env.COOKIE_DOMAIN;
    } else {
      process.env.COOKIE_DOMAIN = originalCookieDomain;
    }
    vi.resetModules();
  });

  it("is undefined (host-only cookie) when COOKIE_DOMAIN is unset, instead of crashing at import time", async () => {
    // #given
    process.env.NODE_ENV = "development";
    delete process.env.COOKIE_DOMAIN;

    // #when
    const { config } = await import("../../../src/config/app.config");

    // #then
    expect(config.COOKIE.DOMAIN).toBeUndefined();
  });

  it("reflects COOKIE_DOMAIN when it is set", async () => {
    // #given
    process.env.NODE_ENV = "development";
    process.env.COOKIE_DOMAIN = ".example.com";

    // #when
    const { config } = await import("../../../src/config/app.config");

    // #then
    expect(config.COOKIE.DOMAIN).toBe(".example.com");
  });
});
