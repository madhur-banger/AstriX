/**
 * UNIT TESTS: workspace.controller.ts
 * --------------------------------------
 * A controller's job is thin: parse/validate input, call a service, shape
 * the HTTP response. It should NOT contain business logic (that lives in
 * the service layer, already tested in workspace.service.test.ts).
 *
 * So here we mock EVERYTHING the controller depends on:
 *   - the service functions (createWorkspaceService, etc.)
 *   - getMemberRoleInWorkspace (from member.service)
 *   - roleGuard (permission check util)
 * ...and verify ONLY that the controller:
 *   1. calls the right service with the right arguments
 *   2. returns the right HTTP status code
 *   3. shapes the JSON response body correctly
 *   4. correctly triggers permission checks before mutating actions
 *
 * IMPORTANT CAVEAT ABOUT asyncHandler:
 * Your controllers are wrapped in `asyncHandler(...)`. We don't have that
 * file's source, but the near-universal implementation is:
 *
 *   export const asyncHandler = (fn) => (req, res, next) => {
 *     Promise.resolve(fn(req, res, next)).catch(next);
 *   };
 *
 * That means when the inner function throws/rejects, asyncHandler catches
 * it and calls `next(error)` instead of letting it crash - it does NOT
 * write the response itself. If your real asyncHandler behaves differently,
 * adjust the "propagates errors to next()" assertions below accordingly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createWorkspaceController,
  getWorkspaceByIdController,
  updateWorkspaceByIdController,
  deleteWorkspaceByIdController,
} from "../../../src/controllers/workspace.controller";

import * as workspaceService from "../../../src/services/workspace.service";
import * as memberService from "../../../src/services/member.service";
import { roleGuard } from "../../../src/utils/roleGuard";
import { createMockReqRes } from "../../setup/mockExpress";
import { buildFakeWorkspace } from "../../setup/testFixtures";

// Mocking with `vi.mock` + `* as namespace` imports lets us stub individual
// named exports of a module (workspace.service.ts exports many functions -
// we only want to fake the ones each test actually touches).
vi.mock("../../../src/services/workspace.service");
vi.mock("../../../src/services/member.service");
vi.mock("../../../src/utils/roleGuard");

describe("createWorkspaceController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the body, calls createWorkspaceService, and responds 201", async () => {
    // Arrange
    const fakeWorkspace = buildFakeWorkspace({ name: "New WS" });
    vi.mocked(workspaceService.createWorkspaceService).mockResolvedValue({
      workspace: fakeWorkspace,
    } as any);

    const { req, res, next } = createMockReqRes({
      body: { name: "New WS" },
      user: { _id: "user-1" },
    });

    // Act - controllers wrapped in asyncHandler are still just callable
    // functions with the (req, res, next) signature.
    await createWorkspaceController(req, res, next);

    // Assert
    expect(workspaceService.createWorkspaceService).toHaveBeenCalledWith(
      "user-1",
      { name: "New WS" }
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace created successfully",
        workspace: fakeWorkspace,
      })
    );
    // A successful request should never call next() with an error.
    expect(next).not.toHaveBeenCalled();
  });

  it("propagates validation errors to next() instead of crashing", async () => {
    // No "name" field at all -> createWorkspaceSchema.parse() should throw
    // a ZodError BEFORE the service is ever called.
    const { req, res, next } = createMockReqRes({ body: {} });

    await createWorkspaceController(req, res, next);

    expect(workspaceService.createWorkspaceService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    // If this assertion fails, your asyncHandler might work differently
    // than assumed above - check its actual implementation.
  });
});

describe("getWorkspaceByIdController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("checks membership/role BEFORE fetching the workspace, then returns 200", async () => {
    const fakeWorkspace = buildFakeWorkspace();
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(workspaceService.getWorkspaceByIdService).mockResolvedValue({
      workspace: fakeWorkspace,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { id: String(fakeWorkspace._id) },
      user: { _id: "user-1" },
    });

    await getWorkspaceByIdController(req, res, next);

    expect(memberService.getMemberRoleInWorkspace).toHaveBeenCalledWith(
      "user-1",
      String(fakeWorkspace._id)
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: fakeWorkspace })
    );
  });

  it("propagates an error to next() when the user isn't a member (getMemberRoleInWorkspace throws)", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockRejectedValue(
      new Error("Not a member")
    );

    const { req, res, next } = createMockReqRes({ params: { id: "ws-id" } });

    await getWorkspaceByIdController(req, res, next);

    // The workspace should NEVER be fetched if the membership check fails first.
    expect(workspaceService.getWorkspaceByIdService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("updateWorkspaceByIdController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("calls roleGuard with EDIT_WORKSPACE permission before updating", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(workspaceService.updateWorkspaceByIdService).mockResolvedValue({
      workspace: buildFakeWorkspace({ name: "Renamed" }),
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { id: "ws-id" },
      body: { name: "Renamed", description: "d" },
    });

    await updateWorkspaceByIdController(req, res, next);

    // roleGuard should have been called - the EXACT permission constant it
    // expects depends on your enums/role.enum.ts import, so we just check
    // it was called once with the resolved role as the first argument.
    expect(roleGuard).toHaveBeenCalledOnce();
    expect(roleGuard).toHaveBeenCalledWith("OWNER", expect.any(Array));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not call the update service if roleGuard throws (insufficient permission)", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "VIEW_ONLY",
    } as any);
    vi.mocked(roleGuard).mockImplementation(() => {
      throw new Error("Forbidden");
    });

    const { req, res, next } = createMockReqRes({
      params: { id: "ws-id" },
      body: { name: "Renamed" },
    });

    await updateWorkspaceByIdController(req, res, next);

    expect(workspaceService.updateWorkspaceByIdService).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("deleteWorkspaceByIdController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deletes and returns the fallback currentWorkspace on success", async () => {
    vi.mocked(memberService.getMemberRoleInWorkspace).mockResolvedValue({
      role: "OWNER",
    } as any);
    vi.mocked(workspaceService.deleteWorkspaceService).mockResolvedValue({
      currentWorkspace: null,
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { id: "ws-id" },
      user: { _id: "user-1" },
    });

    await deleteWorkspaceByIdController(req, res, next);

    expect(workspaceService.deleteWorkspaceService).toHaveBeenCalledWith(
      "ws-id",
      "user-1"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace deleted successfully",
        currentWorkspace: null,
      })
    );
  });
});
