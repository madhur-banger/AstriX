import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import ProtectedRoute from "@/routes/protected.route";

let mockAuthState: {
  data: { user: { _id: string } } | undefined;
  isLoading: boolean;
};

vi.mock("@/hooks/api/use-auth", () => ({
  default: () => mockAuthState,
}));

const renderProtectedRoute = () =>
  renderWithProviders(
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<div>Protected content</div>} />
      </Route>
      <Route path="/sign-in" element={<div>Sign in page</div>} />
    </Routes>,
    { route: "/" }
  );

describe("ProtectedRoute", () => {
  it("shows a loading skeleton while the auth check is in flight", () => {
    // #given the auth query hasn't resolved yet
    mockAuthState = { data: undefined, isLoading: true };

    // #when rendering a protected route
    renderProtectedRoute();

    // #then neither the protected content nor a redirect has happened yet
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign in page")).not.toBeInTheDocument();
  });

  it("renders the protected content for an authenticated user", () => {
    // #given a logged-in user
    mockAuthState = { data: { user: { _id: "u1" } }, isLoading: false };

    // #when rendering a protected route
    renderProtectedRoute();

    // #then the protected content renders
    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("redirects an unauthenticated user to sign-in", () => {
    // #given no logged-in user
    mockAuthState = { data: undefined, isLoading: false };

    // #when rendering a protected route
    renderProtectedRoute();

    // #then the user is redirected to sign-in instead of seeing the content
    expect(screen.getByText("Sign in page")).toBeInTheDocument();
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });
});
