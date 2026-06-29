import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import ResetPassword from "@/page/auth/ResetPassword";
import { resetPasswordMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  resetPasswordMutationFn: vi.fn(),
}));

describe("ResetPassword", () => {
  it("shows an invalid-link message when no token is present in the URL", () => {
    // #given a reset-password URL with no token query param
    // #when the page renders
    renderWithProviders(<ResetPassword />, { route: "/reset-password" });

    // #then an invalid-link message is shown instead of the form
    expect(screen.getByText(/missing or invalid/i)).toBeInTheDocument();
  });

  it("hides the reset form when no token is present in the URL", () => {
    // #given a reset-password URL with no token query param
    // #when the page renders
    renderWithProviders(<ResetPassword />, { route: "/reset-password" });

    // #then the password form is not rendered
    expect(
      screen.queryByRole("button", { name: /reset password/i })
    ).not.toBeInTheDocument();
  });

  it("rejects mismatched passwords without calling the API", async () => {
    // #given a valid reset link
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, {
      route: "/reset-password?token=abc123",
    });

    // #when the user enters two different passwords and submits
    await user.type(screen.getByLabelText(/^new password$/i), "Str0ng!Pass");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "Different1!"
    );
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    // #then a validation error is shown and the API is never called
    await waitFor(() =>
      expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument()
    );
    expect(resetPasswordMutationFn).not.toHaveBeenCalled();
  });

  it("submits the token and new password when they match", async () => {
    // #given a valid reset link and a succeeding endpoint
    vi.mocked(resetPasswordMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<ResetPassword />, {
      route: "/reset-password?token=abc123",
    });

    // #when the user enters matching passwords and submits
    await user.type(screen.getByLabelText(/^new password$/i), "Str0ng!Pass");
    await user.type(
      screen.getByLabelText(/confirm new password/i),
      "Str0ng!Pass"
    );
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    // #then the API is called with the token from the URL and the new password
    await waitFor(() =>
      expect(resetPasswordMutationFn).toHaveBeenCalledWith({
        token: "abc123",
        password: "Str0ng!Pass",
        confirmPassword: "Str0ng!Pass",
      })
    );
  });
});
