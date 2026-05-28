import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import DeleteAccountCard from "@/components/account/delete-account-card";
import { deleteAccountMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  deleteAccountMutationFn: vi.fn(),
}));

const openDialog = async () => {
  const user = userEvent.setup();
  renderWithProviders(<DeleteAccountCard />);
  await user.click(screen.getByRole("button", { name: /delete account/i }));
  return user;
};

describe("DeleteAccountCard", () => {
  it("does not call the API until the user confirms in the dialog", async () => {
    // #given the card, unopened
    // #when the user opens the delete dialog but does not confirm
    await openDialog();

    // #then the API has not been called
    expect(deleteAccountMutationFn).not.toHaveBeenCalled();
  });

  it("submits the entered password when confirming", async () => {
    // #given the delete dialog is open and the endpoint will succeed
    vi.mocked(deleteAccountMutationFn).mockResolvedValue({ message: "ok" });
    const user = await openDialog();

    // #when the user enters their password and confirms
    await user.type(screen.getByLabelText(/^password$/i), "MyPassw0rd!");
    const dialogButtons = screen.getAllByRole("button", {
      name: /delete account/i,
    });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    // #then the API is called with that password
    await waitFor(() =>
      expect(deleteAccountMutationFn).toHaveBeenCalledWith({
        password: "MyPassw0rd!",
      })
    );
  });

  it("surfaces the backend's block reason when deletion fails", async () => {
    // #given the endpoint will reject because the user still owns a workspace
    vi.mocked(deleteAccountMutationFn).mockRejectedValue(
      new Error("You still own a workspace. Transfer or delete it first.")
    );
    const user = await openDialog();

    // #when the user confirms deletion
    const dialogButtons = screen.getAllByRole("button", {
      name: /delete account/i,
    });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    // #then the backend's specific reason is shown, not a generic message
    await waitFor(() =>
      expect(screen.getByText(/you still own a workspace/i)).toBeInTheDocument()
    );
  });
});
