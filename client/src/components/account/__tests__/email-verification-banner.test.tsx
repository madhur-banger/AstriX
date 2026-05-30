import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import EmailVerificationBanner from "@/components/account/email-verification-banner";
import { resendVerificationEmailMutationFn } from "@/lib/api";
import { useAuthContext } from "@/context/auth-provider";

vi.mock("@/lib/api", () => ({
  resendVerificationEmailMutationFn: vi.fn(),
}));

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: vi.fn(),
}));

const mockAuthContext = (isEmailVerified: boolean) => {
  vi.mocked(useAuthContext).mockReturnValue({
    user: { isEmailVerified },
  } as unknown as ReturnType<typeof useAuthContext>);
};

describe("EmailVerificationBanner", () => {
  it("renders nothing when the user's email is already verified", () => {
    // #given a verified user
    mockAuthContext(true);

    // #when the banner renders
    renderWithProviders(<EmailVerificationBanner />);

    // #then no verification nudge is shown
    expect(screen.queryByText(/verify your email/i)).not.toBeInTheDocument();
  });

  it("shows a nudge when the user's email is not verified", () => {
    // #given an unverified user
    mockAuthContext(false);

    // #when the banner renders
    renderWithProviders(<EmailVerificationBanner />);

    // #then a verification nudge is shown
    expect(screen.getByText(/verify your email/i)).toBeInTheDocument();
  });

  it("resends the verification email on click", async () => {
    // #given an unverified user and a succeeding resend endpoint
    mockAuthContext(false);
    vi.mocked(resendVerificationEmailMutationFn).mockResolvedValue({
      message: "ok",
    });
    const user = userEvent.setup();
    renderWithProviders(<EmailVerificationBanner />);

    // #when the user clicks "Resend email"
    await user.click(screen.getByRole("button", { name: /resend email/i }));

    // #then the resend API is called
    await waitFor(() =>
      expect(resendVerificationEmailMutationFn).toHaveBeenCalled()
    );
  });

  it("can be dismissed", async () => {
    // #given an unverified user
    mockAuthContext(false);
    const user = userEvent.setup();
    renderWithProviders(<EmailVerificationBanner />);

    // #when the user dismisses the banner
    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    // #then the nudge is no longer shown
    expect(screen.queryByText(/verify your email/i)).not.toBeInTheDocument();
  });
});
