/**
 * UNIT TESTS: member.controller.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { joinWorkspaceController } from "../../../src/controllers/member.controller";
import * as memberService from "../../../src/services/member.service";
import { createMockReqRes } from "../../setup/mockExpress";
import { makeObjectId } from "../../setup/testFixtures";

vi.mock("../../../src/services/member.service");

describe("joinWorkspaceController", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the invite code param, joins the workspace, and responds 200", async () => {
    const workspaceId = makeObjectId();
    vi.mocked(memberService.joinWorkspaceByInviteService).mockResolvedValue({
      workspaceId,
      role: "MEMBER",
    } as any);

    const { req, res, next } = createMockReqRes({
      params: { inviteCode: "INVITE123" },
      user: { _id: "user-1" },
    });

    await joinWorkspaceController(req, res, next);

    expect(memberService.joinWorkspaceByInviteService).toHaveBeenCalledWith(
      "user-1",
      "INVITE123"
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Successfully joined the workspace",
        workspaceId,
        role: "MEMBER",
      })
    );
  });

  it("propagates a bad-invite-code error to next() without a response", async () => {
    vi.mocked(memberService.joinWorkspaceByInviteService).mockRejectedValue(
      new Error("Invalid invite code or workspace not found")
    );

    const { req, res, next } = createMockReqRes({
      params: { inviteCode: "BOGUS" },
    });

    await joinWorkspaceController(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
