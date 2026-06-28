import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import SignIn from "@/page/auth/Sign-in";
import { loginMutationFn } from "@/lib/api";

const navigateMock = vi.fn();

vi.mock("@/lib/api", () => ({
  loginMutationFn: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigateMock };
});

const loginResponse = {
  message: "ok",
  access_token: "token-123",
  user: {
    _id: "u1",
    name: "Ada Lovelace",
    email: "ada@x.com",
    profilePicture: null,
    currentWorkspace: {
      _id: "ws-123",
      name: "Analytical Engines",
      owner: "u1",
      inviteCode: "invite-1",
    },
  },
} as unknown as Awaited<ReturnType<typeof loginMutationFn>>;

const submitLogin = async () => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), "ada@x.com");
  await user.type(screen.getByLabelText(/password/i), "Str0ng!Pass");
  await user.click(screen.getByRole("button", { name: /^login$/i }));
};

describe("SignIn", () => {
  it("navigates to the current workspace id, not the workspace object", async () => {
    // #given a successful login for a user whose currentWorkspace is an object
    vi.mocked(loginMutationFn).mockResolvedValue(loginResponse);
    renderWithProviders(<SignIn />, { route: "/sign-in" });

    // #when the user signs in
    await submitLogin();

    // #then navigation targets the workspace id
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/workspace/ws-123")
    );
  });

  it("never navigates to a stringified workspace object", async () => {
    // #given a successful login
    vi.mocked(loginMutationFn).mockResolvedValue(loginResponse);
    renderWithProviders(<SignIn />, { route: "/sign-in" });

    // #when the user signs in
    await submitLogin();

    // #then the destination contains no "[object Object]" segment
    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(navigateMock.mock.calls[0][0]).not.toContain("[object Object]");
  });

  it("honours a safe same-origin returnUrl", async () => {
    // #given a sign-in link carrying a relative returnUrl
    vi.mocked(loginMutationFn).mockResolvedValue(loginResponse);
    renderWithProviders(<SignIn />, {
      route: `/sign-in?returnUrl=${encodeURIComponent(
        "/invite/workspace/abc/join"
      )}`,
    });

    // #when the user signs in
    await submitLogin();

    // #then the user lands on the requested relative path
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/invite/workspace/abc/join")
    );
  });

  it("ignores a protocol-relative returnUrl pointing off-origin", async () => {
    // #given a sign-in link carrying "//evil.com" as the returnUrl
    vi.mocked(loginMutationFn).mockResolvedValue(loginResponse);
    renderWithProviders(<SignIn />, {
      route: `/sign-in?returnUrl=${encodeURIComponent("//evil.com/steal")}`,
    });

    // #when the user signs in
    await submitLogin();

    // #then it falls back to the workspace redirect
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/workspace/ws-123")
    );
  });

  it("ignores an absolute returnUrl pointing off-origin", async () => {
    // #given a sign-in link carrying an absolute URL as the returnUrl
    vi.mocked(loginMutationFn).mockResolvedValue(loginResponse);
    renderWithProviders(<SignIn />, {
      route: `/sign-in?returnUrl=${encodeURIComponent("https://evil.com")}`,
    });

    // #when the user signs in
    await submitLogin();

    // #then it falls back to the workspace redirect
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/workspace/ws-123")
    );
  });
});
