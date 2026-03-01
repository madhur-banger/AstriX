/**
 * UNIT TESTS: errorHandles.middleware.ts
 * ------------------------------------------
 * This is the file both e2e suites previously bypassed with a hand-rolled
 * stand-in (see PLAN.md fix F3) - it needs its own direct unit test
 * regardless of that fix, since e2e coverage alone can't enumerate every
 * error-type branch cleanly.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { errorHandler } from "../../../src/middlewares/errorHandles.middleware";
import {
  NotFoundException,
  BadRequestException,
} from "../../../src/utils/appError";
import { HTTPSTATUS } from "../../../src/config/http.config";
import { createMockReqRes } from "../../setup/mockExpress";

describe("errorHandler", () => {
  it("returns 400 with a generic message for a SyntaxError (malformed JSON body)", () => {
    const { req, res, next } = createMockReqRes();
    const error = new SyntaxError("Unexpected token in JSON");

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith({
      message: "Invalid JSON format. Please check your request body.",
    });
  });

  it("returns 400 with field-level errors for a real ZodError", () => {
    const schema = z.object({ email: z.string().email() });
    const parseResult = schema.safeParse({ email: "not-an-email" });
    expect(parseResult.success).toBe(false);

    const { req, res, next } = createMockReqRes();
    // @ts-expect-error - narrowed above via the success check
    errorHandler(parseResult.error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith({
      message: "Validation failed",
      errors: expect.arrayContaining([
        expect.objectContaining({ field: "email" }),
      ]),
      errorCode: "VALIDATION_ERROR",
    });
  });

  it("returns the AppError's own statusCode/errorCode for an AppError subclass", () => {
    const { req, res, next } = createMockReqRes();
    const error = new NotFoundException("Widget not found");

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.NOT_FOUND);
    expect(res.json).toHaveBeenCalledWith({
      message: "Widget not found",
      errorCode: "RESOURCE_NOT_FOUND",
    });
  });

  it("returns a different AppError subclass's statusCode correctly (not hardcoded to one status)", () => {
    const { req, res, next } = createMockReqRes();
    const error = new BadRequestException("Bad input");

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.BAD_REQUEST);
  });

  it("returns 500 with a generic shape for an unknown/generic Error", () => {
    const { req, res, next } = createMockReqRes();
    const error = new Error("Something truly unexpected");

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.INTERNAL_SERVER_ERROR);
    expect(res.json).toHaveBeenCalledWith({
      message: "Internal Server Error",
      error: "Something truly unexpected",
    });
  });

  it("never leaks a stack trace into the JSON response body", () => {
    const { req, res, next } = createMockReqRes();
    const error = new Error("Sensitive internal detail");

    errorHandler(error, req, res, next);

    const [responseBody] = vi.mocked(res.json).mock.calls[0];
    expect(JSON.stringify(responseBody)).not.toContain(
      error.stack?.split("\n")[1]
    );
    expect(responseBody).not.toHaveProperty("stack");
  });

  it("returns 413 (not 500) for an oversized request body (express.json's PayloadTooLargeError)", () => {
    const { req, res, next } = createMockReqRes();
    const error = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      status: 413,
      expected: 2000000,
      length: 2000000,
      limit: 1048576,
    });

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.PAYLOAD_TOO_LARGE);
    expect(res.json).toHaveBeenCalledWith({
      message: "Request body is too large.",
    });
  });

  it("returns 400 (not 500) for a Mongoose CastError, without leaking the raw error message", () => {
    const { req, res, next } = createMockReqRes();
    const error = Object.assign(
      new Error(
        'Cast to ObjectId failed for value "not-a-real-id" (type string) at path "_id" for model "Workspace"'
      ),
      { name: "CastError" }
    );

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.BAD_REQUEST);
    const [responseBody] = vi.mocked(res.json).mock.calls[0];
    expect(responseBody.message).toBe("Invalid identifier");
    expect(JSON.stringify(responseBody)).not.toContain("not-a-real-id");
  });

  it("returns 400 with field-level errors for a Mongoose ValidationError", () => {
    const { req, res, next } = createMockReqRes();
    const error = Object.assign(new Error("Workspace validation failed"), {
      name: "ValidationError",
      errors: {
        name: { path: "name", message: "Path `name` is required." },
      },
    });

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.BAD_REQUEST);
    expect(res.json).toHaveBeenCalledWith({
      message: "Validation failed",
      errors: [{ field: "name", message: "Path `name` is required." }],
      errorCode: "VALIDATION_ERROR",
    });
  });

  it("returns 409 (not 500) for a Mongo duplicate-key error, without leaking the raw error message", () => {
    const { req, res, next } = createMockReqRes();
    const error = Object.assign(
      new Error(
        'E11000 duplicate key error collection: test.users index: email_1 dup key: { email: "someone@example.com" }'
      ),
      { code: 11000 }
    );

    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.CONFLICT);
    const [responseBody] = vi.mocked(res.json).mock.calls[0];
    expect(responseBody.message).toBe(
      "A resource with these details already exists"
    );
    expect(JSON.stringify(responseBody)).not.toContain("someone@example.com");
  });

  it("hides the raw error message for an unknown/generic Error when NODE_ENV=production", async () => {
    vi.resetModules();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const { errorHandler: prodErrorHandler } =
        await import("../../../src/middlewares/errorHandles.middleware");
      // This dynamic import also gets a FRESH logger instance (module
      // graph reset above), which - correctly - is NOT silent when
      // NODE_ENV=production. Spy it quiet so this test's log line doesn't
      // clutter CI output; the assertions below are what actually matter.
      const { logger: prodLogger } = await import("../../../src/utils/logger");
      vi.spyOn(prodLogger, "error").mockImplementation(() => undefined);

      const { req, res, next } = createMockReqRes();
      const error = new Error("Sensitive internal detail");

      prodErrorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(HTTPSTATUS.INTERNAL_SERVER_ERROR);
      expect(res.json).toHaveBeenCalledWith({
        message: "Internal Server Error",
        error: "Unknown error occurred",
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      vi.resetModules();
    }
  });
});
