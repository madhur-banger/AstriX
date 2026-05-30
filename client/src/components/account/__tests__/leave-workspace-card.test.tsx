import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import LeaveWorkspaceCard from "@/components/account/leave-workspace-card";
import { leaveWorkspaceMutationFn } from "@/lib/api";
import { useAuthContext } from "@/context/auth-provider";

vi.mock("@/lib/api", () => ({
  leaveWorkspaceMutationFn: vi.fn(),
}));

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws1",
}));

const mockAuth = (isOwner: boolean) => {
  vi.mocked(useAuthContext).mockReturnValue({
    user: { _id: "u1" },
    workspace: { name: "Acme", owner: isOwner ? "u1" : "u-someone-else" },
  } as unknown as ReturnType<typeof useAuthContext>);
};

describe("LeaveWorkspaceCard", () => {
  it("disables the leave action for the workspace owner", () => {
    // #given the current user owns the workspace
    mockAuth(true);

    // #when the card renders
    renderWithProviders(<LeaveWorkspaceCard />);

    // #then the leave button is disabled
    expect(screen.getByRole("button", { name: /^leave$/i })).toBeDisabled();
  });

  it("leaves the workspace on confirm for a non-owner", async () => {
    // #given the current user does not own the workspace
    mockAuth(false);
    vi.mocked(leaveWorkspaceMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<LeaveWorkspaceCard />);

    // #when the user clicks leave and confirms the dialog
    await user.click(screen.getByRole("button", { name: /^leave$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^leave$/i }));

    // #then the API is called for the current workspace
    await waitFor(() =>
      expect(leaveWorkspaceMutationFn).toHaveBeenCalledWith("ws1")
    );
  });
});
