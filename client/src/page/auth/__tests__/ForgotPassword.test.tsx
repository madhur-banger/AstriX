import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import ForgotPassword from "@/page/auth/ForgotPassword";
import { forgotPasswordMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  forgotPasswordMutationFn: vi.fn(),
}));

const fillAndSubmit = async (email = "ada@example.com") => {
  const user = userEvent.setup();
  renderWithProviders(<ForgotPassword />);
  await user.type(screen.getByLabelText(/email/i), email);
  await user.click(screen.getByRole("button", { name: /send reset link/i }));
};

describe("ForgotPassword", () => {
  it("sends the entered email to the API", async () => {
    // #given the endpoint will succeed
    vi.mocked(forgotPasswordMutationFn).mockResolvedValue({ message: "ok" });

    // #when the user submits their email
    await fillAndSubmit("ada@example.com");

    // #then the API is called with that email
    await waitFor(() =>
      expect(forgotPasswordMutationFn).toHaveBeenCalledWith({
        email: "ada@example.com",
      })
    );
  });

  it("shows a generic confirmation message on success", async () => {
    // #given the endpoint will succeed
    vi.mocked(forgotPasswordMutationFn).mockResolvedValue({ message: "ok" });

    // #when the user submits their email
    await fillAndSubmit();

    // #then a non-leaking confirmation message is shown
    await waitFor(() =>
      expect(
        screen.getByText(/if an account exists for that email/i)
      ).toBeInTheDocument()
    );
  });

  it("does not leak account existence when the request fails", async () => {
    // #given the endpoint will fail
    vi.mocked(forgotPasswordMutationFn).mockRejectedValue(new Error("boom"));

    // #when the user submits their email
    await fillAndSubmit();
    await waitFor(() => expect(forgotPasswordMutationFn).toHaveBeenCalled());

    // #then the form still never confirms whether the account exists —
    // that's the backend's own non-leaking contract
    expect(
      screen.queryByText(/if an account exists for that email/i)
    ).not.toBeInTheDocument();
  });
});
