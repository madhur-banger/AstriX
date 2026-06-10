import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import InviteMember from "@/components/workspace/member/invite-member";
import { resetInviteCodeMutationFn } from "@/lib/api";
import { useAuthContext } from "@/context/auth-provider";

vi.mock("@/lib/api", () => ({
  resetInviteCodeMutationFn: vi.fn(),
}));

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws1",
}));

const mockAuth = (opts: { canReset: boolean; canAddMember: boolean }) => {
  vi.mocked(useAuthContext).mockReturnValue({
    workspace: { inviteCode: "abc123" },
    workspaceLoading: false,
    hasPermission: (permission: string) =>
      (opts.canAddMember && permission === "ADD_MEMBER") ||
      (opts.canReset && permission === "MANAGE_WORKSPACE_SETTINGS"),
  } as unknown as ReturnType<typeof useAuthContext>);
};

describe("InviteMember", () => {
  it("hides the regenerate action without MANAGE_WORKSPACE_SETTINGS", () => {
    // #given a caller who can view the invite link but not manage settings
    mockAuth({ canReset: false, canAddMember: true });

    // #when the card renders
    renderWithProviders(<InviteMember />);

    // #then no regenerate action is shown
    expect(
      screen.queryByRole("button", { name: /regenerate invite link/i })
    ).not.toBeInTheDocument();
  });

  it("regenerates the invite code on confirm", async () => {
    // #given a caller who can manage workspace settings
    mockAuth({ canReset: true, canAddMember: true });
    vi.mocked(resetInviteCodeMutationFn).mockResolvedValue({
      message: "ok",
      workspace: { inviteCode: "new-code" } as never,
    });
    const user = userEvent.setup();
    renderWithProviders(<InviteMember />);

    // #when the caller regenerates the link and confirms
    await user.click(
      screen.getByRole("button", { name: /regenerate invite link/i })
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: /regenerate/i })
    );

    // #then the API is called for the current workspace
    await waitFor(() =>
      expect(resetInviteCodeMutationFn).toHaveBeenCalledWith("ws1")
    );
  });
});
