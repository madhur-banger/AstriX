import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import SessionsCard from "@/components/account/sessions-card";
import {
  getSessionsQueryFn,
  logoutAllMutationFn,
  revokeSessionMutationFn,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getSessionsQueryFn: vi.fn(),
  revokeSessionMutationFn: vi.fn(),
  logoutAllMutationFn: vi.fn(),
}));

const sessions = [
  {
    id: "s1",
    userAgent: "Chrome on macOS",
    ipAddress: "127.0.0.1",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "s2",
    userAgent: "Safari on iOS",
    ipAddress: "127.0.0.2",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];

describe("SessionsCard", () => {
  it("lists every active session returned by the API", async () => {
    // #given the API returns two active sessions
    vi.mocked(getSessionsQueryFn).mockResolvedValue({
      message: "ok",
      sessions,
    });

    // #when the card renders
    renderWithProviders(<SessionsCard />);

    // #then both sessions are shown
    await waitFor(() =>
      expect(screen.getByText("Chrome on macOS")).toBeInTheDocument()
    );
    expect(screen.getByText("Safari on iOS")).toBeInTheDocument();
  });

  it("revokes the selected session on confirm", async () => {
    // #given a list of sessions and a succeeding revoke endpoint
    vi.mocked(getSessionsQueryFn).mockResolvedValue({
      message: "ok",
      sessions,
    });
    vi.mocked(revokeSessionMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<SessionsCard />);
    await waitFor(() =>
      expect(screen.getByText("Chrome on macOS")).toBeInTheDocument()
    );

    // #when the user revokes the first session and confirms the dialog
    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    await user.click(revokeButtons[0]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /revoke/i }));

    // #then the API is called with that session's id
    await waitFor(() =>
      expect(revokeSessionMutationFn).toHaveBeenCalledWith("s1")
    );
  });

  it("logs out of all other devices without a confirm dialog", async () => {
    // #given a list of sessions and a succeeding logout-all endpoint
    vi.mocked(getSessionsQueryFn).mockResolvedValue({
      message: "ok",
      sessions,
    });
    vi.mocked(logoutAllMutationFn).mockResolvedValue({ message: "ok" });
    const user = userEvent.setup();
    renderWithProviders(<SessionsCard />);
    await waitFor(() =>
      expect(screen.getByText("Chrome on macOS")).toBeInTheDocument()
    );

    // #when the user clicks "log out of other devices"
    await user.click(
      screen.getByRole("button", { name: /log out of other devices/i })
    );

    // #then the logout-all API is called
    await waitFor(() => expect(logoutAllMutationFn).toHaveBeenCalled());
  });
});
