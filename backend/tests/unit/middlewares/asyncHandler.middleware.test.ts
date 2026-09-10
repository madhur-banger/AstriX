/**
 * UNIT TESTS: asyncHandler.middleware.ts
 */

import { describe, it, expect, vi } from "vitest";

import { asyncHandler } from "../../../src/middlewares/asyncHandler.middleware";
import { createMockReqRes } from "../../setup/mockExpress";

describe("asyncHandler", () => {
  it("calls the wrapped controller once and does not call next() on success", async () => {
    const controller = vi.fn().mockResolvedValue(undefined);
    const wrapped = asyncHandler(controller);
    const { req, res, next } = createMockReqRes();

    await wrapped(req, res, next);

    expect(controller).toHaveBeenCalledOnce();
    expect(controller).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next(error) when the wrapped controller rejects", async () => {
    const error = new Error("boom");
    const controller = vi.fn().mockRejectedValue(error);
    const wrapped = asyncHandler(controller);
    const { req, res, next } = createMockReqRes();

    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });

  it("calls next(error) when the wrapped controller throws synchronously inside the async function", async () => {
    const error = new Error("sync throw");
    const controller = vi.fn().mockImplementation(async () => {
      throw error;
    });
    const wrapped = asyncHandler(controller);
    const { req, res, next } = createMockReqRes();

    await wrapped(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
