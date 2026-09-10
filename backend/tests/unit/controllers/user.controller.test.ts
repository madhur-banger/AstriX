/**
 * UNIT TESTS: user.controller.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getCurrentUserController,
  updateProfileController,
  deleteAccountController,
} from "../../../src/controllers/user.controller";
import * as userService from "../../../src/services/user.service";
import { createMockReqRes } from "../../setup/mockExpress";
import { buildFakeUser } from "../../setup/testFixtures";

vi.mock("../../../src/services/user.service");

describe("getCurrentUserController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fetches the current user by req.user._id and responds 200", async () => {
    const fakeUser = buildFakeUser();
    vi.mocked(userService.getCurrentUserService).mockResolvedValue({
      user: fakeUser,
    } as any);

    const { req, res, next } = createMockReqRes({
      user: { _id: String(fakeUser._id) },
    });

    await getCurrentUserController(req, res, next);

    expect(userService.getCurrentUserService).toHaveBeenCalledWith(
      String(fakeUser._id)
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "User fetch successfully",
        user: fakeUser,
      })
    );
  });

  it("propagates a not-found error to next()", async () => {
    vi.mocked(userService.getCurrentUserService).mockRejectedValue(
      new Error("User not found")
    );

    const { req, res, next } = createMockReqRes({ user: { _id: "missing" } });

    await getCurrentUserController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("updateProfileController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the body, calls the service, and responds 200 with the updated user", async () => {
    const fakeUser = buildFakeUser({ name: "New Name" });
    vi.mocked(userService.updateProfileService).mockResolvedValue({
      user: fakeUser,
    } as any);

    const { req, res, next } = createMockReqRes({
      user: { _id: "user-1" },
      body: { name: "New Name" },
    });

    await updateProfileController(req, res, next);

    expect(userService.updateProfileService).toHaveBeenCalledWith("user-1", {
      name: "New Name",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Profile updated successfully",
        user: fakeUser,
      })
    );
  });

  it("propagates a validation error (empty body) to next() without calling the service", async () => {
    const { req, res, next } = createMockReqRes({
      user: { _id: "user-1" },
      body: {},
    });

    await updateProfileController(req, res, next);

    expect(userService.updateProfileService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("deleteAccountController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the body, calls the service, and responds 200", async () => {
    vi.mocked(userService.deleteAccountService).mockResolvedValue(undefined);

    const { req, res, next } = createMockReqRes({
      user: { _id: "user-1" },
      body: { password: "Correct@123" },
    });

    await deleteAccountController(req, res, next);

    expect(userService.deleteAccountService).toHaveBeenCalledWith(
      "user-1",
      "Correct@123"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Account deleted successfully" })
    );
  });

  it("allows an omitted password (OAuth-only accounts) and passes undefined through", async () => {
    vi.mocked(userService.deleteAccountService).mockResolvedValue(undefined);

    const { req, res, next } = createMockReqRes({
      user: { _id: "user-1" },
      body: {},
    });

    await deleteAccountController(req, res, next);

    expect(userService.deleteAccountService).toHaveBeenCalledWith(
      "user-1",
      undefined
    );
  });

  it("propagates a service error (e.g. owns a workspace) to next()", async () => {
    vi.mocked(userService.deleteAccountService).mockRejectedValue(
      new Error("You must delete or transfer ownership...")
    );

    const { req, res, next } = createMockReqRes({
      user: { _id: "user-1" },
      body: {},
    });

    await deleteAccountController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
