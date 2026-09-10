import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import UpdateProfileCard from "@/components/account/update-profile-card";
import { updateProfileMutationFn } from "@/lib/api";
import { useAuthContext } from "@/context/auth-provider";

vi.mock("@/lib/api", () => ({
  updateProfileMutationFn: vi.fn(),
}));

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: vi.fn(),
}));

describe("UpdateProfileCard", () => {
  it("pre-fills the form with the current user's name and email", () => {
    // #given a signed-in user
    vi.mocked(useAuthContext).mockReturnValue({
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    } as unknown as ReturnType<typeof useAuthContext>);

    // #when the card renders
    renderWithProviders(<UpdateProfileCard />);

    // #then the form shows their current name and (read-only) email
    expect(screen.getByLabelText(/^name$/i)).toHaveValue("Ada Lovelace");
    expect(screen.getByLabelText(/^email$/i)).toHaveValue("ada@example.com");
  });

  it("submits the updated name", async () => {
    // #given a signed-in user and a succeeding endpoint
    vi.mocked(useAuthContext).mockReturnValue({
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    } as unknown as ReturnType<typeof useAuthContext>);
    vi.mocked(updateProfileMutationFn).mockResolvedValue({
      message: "ok",
      user: { name: "Ada L." } as never,
    });
    const user = userEvent.setup();
    renderWithProviders(<UpdateProfileCard />);

    // #when the user changes their name and saves
    await user.clear(screen.getByLabelText(/^name$/i));
    await user.type(screen.getByLabelText(/^name$/i), "Ada L.");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    // #then the API is called with the new name
    await waitFor(() =>
      expect(updateProfileMutationFn).toHaveBeenCalledWith({ name: "Ada L." })
    );
  });
});
