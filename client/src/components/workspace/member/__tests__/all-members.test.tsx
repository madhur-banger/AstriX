import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import AllMembers from "@/components/workspace/member/all-members";
import {
  getMembersInWorkspaceQueryFn,
  removeWorkspaceMemberMutationFn,
} from "@/lib/api";
import { useAuthContext } from "@/context/auth-provider";

vi.mock("@/lib/api", () => ({
  getMembersInWorkspaceQueryFn: vi.fn(),
  changeWorkspaceMemberRoleMutationFn: vi.fn(),
  removeWorkspaceMemberMutationFn: vi.fn(),
}));

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws1",
}));

const owner = {
  _id: "m-owner",
  userId: {
    _id: "u-owner",
    name: "Owner Person",
    email: "owner@x.com",
    profilePicture: null,
  },
  workspaceId: "ws1",
  role: { _id: "r1", name: "OWNER" },
  joinedAt: "2026-01-01",
  createdAt: "2026-01-01",
};

const teammate = {
  _id: "m-teammate",
  userId: {
    _id: "u-teammate",
    name: "Grace Hopper",
    email: "grace@x.com",
    profilePicture: null,
  },
  workspaceId: "ws1",
  role: { _id: "r2", name: "MEMBER" },
  joinedAt: "2026-01-01",
  createdAt: "2026-01-01",
};

const mockAuth = (opts: { currentUserId: string; canRemove: boolean }) => {
  vi.mocked(useAuthContext).mockReturnValue({
    user: { _id: opts.currentUserId },
    workspace: { owner: "u-owner" },
    hasPermission: (permission: string) =>
      opts.canRemove && permission === "REMOVE_MEMBER",
  } as unknown as ReturnType<typeof useAuthContext>);
};

describe("AllMembers", () => {
  it("does not show a remove action for the workspace owner's row", async () => {
    // #given a caller with REMOVE_MEMBER permission
    mockAuth({ currentUserId: "u-admin", canRemove: true });
    vi.mocked(getMembersInWorkspaceQueryFn).mockResolvedValue({
      message: "ok",
      members: [owner, teammate],
      roles: [],
    });

    // #when the member list renders
    renderWithProviders(<AllMembers />);
    await waitFor(() =>
      expect(screen.getByText("Owner Person")).toBeInTheDocument()
    );

    // #then only the non-owner row has a remove action
    expect(
      screen.queryByRole("button", { name: /remove owner person/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove grace hopper/i })
    ).toBeInTheDocument();
  });

  it("does not show a remove action without the REMOVE_MEMBER permission", async () => {
    // #given a caller without REMOVE_MEMBER permission
    mockAuth({ currentUserId: "u-admin", canRemove: false });
    vi.mocked(getMembersInWorkspaceQueryFn).mockResolvedValue({
      message: "ok",
      members: [teammate],
      roles: [],
    });

    // #when the member list renders
    renderWithProviders(<AllMembers />);
    await waitFor(() =>
      expect(screen.getByText("Grace Hopper")).toBeInTheDocument()
    );

    // #then no remove action is shown for anyone
    expect(
      screen.queryByRole("button", { name: /remove grace hopper/i })
    ).not.toBeInTheDocument();
  });

  it("removes the selected member on confirm", async () => {
    // #given a caller with REMOVE_MEMBER permission and a succeeding endpoint
    mockAuth({ currentUserId: "u-admin", canRemove: true });
    vi.mocked(getMembersInWorkspaceQueryFn).mockResolvedValue({
      message: "ok",
      members: [owner, teammate],
      roles: [],
    });
    vi.mocked(removeWorkspaceMemberMutationFn).mockResolvedValue({
      message: "ok",
    });
    const user = userEvent.setup();
    renderWithProviders(<AllMembers />);
    await waitFor(() =>
      expect(screen.getByText("Grace Hopper")).toBeInTheDocument()
    );

    // #when the caller removes Grace and confirms the dialog
    await user.click(
      screen.getByRole("button", { name: /remove grace hopper/i })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /remove/i }));

    // #then the API is called with the workspace and member ids
    await waitFor(() =>
      expect(removeWorkspaceMemberMutationFn).toHaveBeenCalledWith({
        workspaceId: "ws1",
        memberId: "m-teammate",
      })
    );
  });
});
