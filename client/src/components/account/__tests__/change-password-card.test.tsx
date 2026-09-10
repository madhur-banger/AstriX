import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import ChangePasswordCard from "@/components/account/change-password-card";
import { changePasswordMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  changePasswordMutationFn: vi.fn(),
}));

describe("ChangePasswordCard", () => {
  it("rejects mismatched new passwords without calling the API", async () => {
    // #given the change-password form
    const user = userEvent.setup();
    renderWithProviders(<ChangePasswordCard />);

    // #when the user enters a new password and a non-matching confirmation
    await user.type(screen.getByLabelText(/current password/i), "OldPass1!");
    await user.type(screen.getByLabelText(/^new password$/i), "NewPass1!");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "Mismatch1!"
    );
    await user.click(screen.getByRole("button", { name: /change password/i }));

    // #then a validation error is shown and the API is never called
    await waitFor(() =>
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument()
    );
    expect(changePasswordMutationFn).not.toHaveBeenCalled();
  });

  it("submits current and new password when they match", async () => {
    // #given the endpoint will succeed
    vi.mocked(changePasswordMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<ChangePasswordCard />);

    // #when the user fills in matching new passwords and submits
    await user.type(screen.getByLabelText(/current password/i), "OldPass1!");
    await user.type(screen.getByLabelText(/^new password$/i), "NewPass1!");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "NewPass1!"
    );
    await user.click(screen.getByRole("button", { name: /change password/i }));

    // #then the API is called with the entered values
    await waitFor(() =>
      expect(changePasswordMutationFn).toHaveBeenCalledWith({
        currentPassword: "OldPass1!",
        newPassword: "NewPass1!",
        confirmNewPassword: "NewPass1!",
      })
    );
  });

  it("resets the form after a successful change", async () => {
    // #given the endpoint will succeed
    vi.mocked(changePasswordMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<ChangePasswordCard />);

    // #when the user submits a valid password change
    await user.type(screen.getByLabelText(/current password/i), "OldPass1!");
    await user.type(screen.getByLabelText(/^new password$/i), "NewPass1!");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "NewPass1!"
    );
    await user.click(screen.getByRole("button", { name: /change password/i }));

    // #then the form fields are cleared
    await waitFor(() =>
      expect(screen.getByLabelText(/current password/i)).toHaveValue("")
    );
  });
});
