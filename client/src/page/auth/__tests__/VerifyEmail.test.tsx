import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import VerifyEmail from "@/page/auth/VerifyEmail";
import { verifyEmailMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  verifyEmailMutationFn: vi.fn(),
}));

describe("VerifyEmail", () => {
  it("shows a failure state when no token is present in the URL", async () => {
    // #given a verify-email URL with no token query param
    // #when the page renders
    renderWithProviders(<VerifyEmail />, { route: "/verify-email" });

    // #then a failure state is shown and the API is never called
    await waitFor(() =>
      expect(screen.getByText(/verification failed/i)).toBeInTheDocument()
    );
    expect(verifyEmailMutationFn).not.toHaveBeenCalled();
  });

  it("verifies the token found in the URL", async () => {
    // #given a verify-email URL with a token and a succeeding endpoint
    vi.mocked(verifyEmailMutationFn).mockResolvedValue({ message: "ok" });

    // #when the page renders
    renderWithProviders(<VerifyEmail />, {
      route: "/verify-email?token=abc123",
    });

    // #then the API is called with that token
    await waitFor(() =>
      expect(verifyEmailMutationFn).toHaveBeenCalledWith({ token: "abc123" })
    );
  });

  it("shows a success state once verification succeeds", async () => {
    // #given a verify-email URL with a token and a succeeding endpoint
    vi.mocked(verifyEmailMutationFn).mockResolvedValue({ message: "ok" });

    // #when the page renders
    renderWithProviders(<VerifyEmail />, {
      route: "/verify-email?token=abc123",
    });

    // #then a success state is shown
    await waitFor(() =>
      expect(screen.getByText(/email verified/i)).toBeInTheDocument()
    );
  });

  it("shows the backend's error message when verification fails", async () => {
    // #given a verify-email URL with a token that the backend rejects
    vi.mocked(verifyEmailMutationFn).mockRejectedValue(new Error("expired"));

    // #when the page renders
    renderWithProviders(<VerifyEmail />, {
      route: "/verify-email?token=expired-token",
    });

    // #then the backend's error message is shown
    await waitFor(() =>
      expect(screen.getByText("expired")).toBeInTheDocument()
    );
  });
});
