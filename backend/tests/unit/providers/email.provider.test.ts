/**
 * UNIT TESTS: email.provider.ts
 * -----------------------------------
 * `config.RESEND_API_KEY` is read once, at module-load time, into the
 * exported `config` object - so testing both "configured" and "not
 * configured" requires a fresh module graph per test: `vi.resetModules()`
 * + a dynamic `await import(...)` for both `email.provider.ts` itself and
 * (transitively) `app.config.ts`, exactly like `app.config.test.ts`'s
 * COOKIE.SECURE tests. `resend` is mocked with `vi.doMock` (not the
 * hoisted `vi.mock`) since it needs to vary per test and pair with the
 * dynamic import.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

describe("sendPasswordResetEmail", () => {
  const originalApiKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    vi.doUnmock("resend");
    vi.resetModules();
  });

  it("logs a warning and resolves without throwing when RESEND_API_KEY is unset", async () => {
    // #given
    vi.resetModules();
    delete process.env.RESEND_API_KEY;

    const { logger } = await import("../../../src/utils/logger");
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => undefined);

    const { sendPasswordResetEmail } =
      await import("../../../src/providers/email.provider");

    // #when
    const result = sendPasswordResetEmail(
      "user@example.com",
      "https://example.com/reset-password?token=abc123"
    );

    // #then
    await expect(result).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com" }),
      expect.any(String)
    );
    warnSpy.mockRestore();
  });

  it("sends via Resend with the right recipient/subject/link when RESEND_API_KEY is configured", async () => {
    // #given
    vi.resetModules();
    process.env.RESEND_API_KEY = "test-resend-key";

    const sendMock = vi
      .fn()
      .mockResolvedValue({ data: { id: "email-1" }, error: null });
    vi.doMock("resend", () => ({
      // `new Resend(key)` requires a real constructible function - an arrow
      // function has no [[Construct]] slot and throws "is not a constructor".
      Resend: vi.fn().mockImplementation(function (this: any) {
        this.emails = { send: sendMock };
      }),
    }));

    const { sendPasswordResetEmail } =
      await import("../../../src/providers/email.provider");

    // #when
    await sendPasswordResetEmail(
      "user@example.com",
      "https://example.com/reset-password?token=abc123"
    );

    // #then
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Reset your password",
        html: expect.stringContaining(
          "https://example.com/reset-password?token=abc123"
        ),
      })
    );
  });

  it("logs but does not throw when Resend itself returns an error", async () => {
    // #given
    vi.resetModules();
    process.env.RESEND_API_KEY = "test-resend-key";

    const sendMock = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: "bounced" } });
    vi.doMock("resend", () => ({
      // `new Resend(key)` requires a real constructible function - an arrow
      // function has no [[Construct]] slot and throws "is not a constructor".
      Resend: vi.fn().mockImplementation(function (this: any) {
        this.emails = { send: sendMock };
      }),
    }));

    const { logger } = await import("../../../src/utils/logger");
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => undefined);

    const { sendPasswordResetEmail } =
      await import("../../../src/providers/email.provider");

    // #when
    const result = sendPasswordResetEmail(
      "user@example.com",
      "https://example.com/reset-password?token=abc123"
    );

    // #then
    await expect(result).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("sendVerificationEmail", () => {
  // The "not configured" / "Resend error" branches are shared internal
  // logic (sendEmail()) already fully covered above via sendPasswordResetEmail -
  // this only needs to confirm THIS function's distinct subject/content.
  const originalApiKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalApiKey;
    }
    vi.doUnmock("resend");
    vi.resetModules();
  });

  it("sends via Resend with the right recipient/subject/link when RESEND_API_KEY is configured", async () => {
    // #given
    vi.resetModules();
    process.env.RESEND_API_KEY = "test-resend-key";

    const sendMock = vi
      .fn()
      .mockResolvedValue({ data: { id: "email-1" }, error: null });
    vi.doMock("resend", () => ({
      Resend: vi.fn().mockImplementation(function (this: any) {
        this.emails = { send: sendMock };
      }),
    }));

    const { sendVerificationEmail } =
      await import("../../../src/providers/email.provider");

    // #when
    await sendVerificationEmail(
      "user@example.com",
      "https://example.com/verify-email?token=abc123"
    );

    // #then
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Verify your email address",
        html: expect.stringContaining(
          "https://example.com/verify-email?token=abc123"
        ),
      })
    );
  });
});
