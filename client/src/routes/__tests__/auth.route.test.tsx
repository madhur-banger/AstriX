import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "@/test/render";
import AuthRoute from "@/routes/auth.route";

let mockAuthState: {
  data: { user: { currentWorkspace: { _id: string } } } | undefined;
  isLoading: boolean;
};

vi.mock("@/hooks/api/use-auth", () => ({
  default: () => mockAuthState,
}));

const renderAuthRoute = (route = "/sign-in") =>
  renderWithProviders(
    <Routes>
      <Route element={<AuthRoute />}>
        <Route path="/sign-in" element={<div>Sign in form</div>} />
      </Route>
      <Route
        path="/workspace/:workspaceId"
        element={<div>Workspace shell</div>}
      />
    </Routes>,
    { route }
  );

describe("AuthRoute", () => {
  it("renders the auth form for an unauthenticated visitor", () => {
    // #given no logged-in user
    mockAuthState = { data: undefined, isLoading: false };

    // #when visiting the sign-in page
    renderAuthRoute();

    // #then the sign-in form renders, no redirect happens
    expect(screen.getByText("Sign in form")).toBeInTheDocument();
  });

  it("redirects an already-authenticated user to their workspace, using the id (not the workspace object)", () => {
    // #given a logged-in user whose currentWorkspace is a populated object
    mockAuthState = {
      data: { user: { currentWorkspace: { _id: "ws-1" } } },
      isLoading: false,
    };

    // #when visiting the sign-in page
    renderAuthRoute();

    // #then the user is redirected into their workspace shell, not shown the
    // auth form, and the target route resolves to the real workspace id
    // rather than "[object Object]"
    expect(screen.getByText("Workspace shell")).toBeInTheDocument();
    expect(screen.queryByText("Sign in form")).not.toBeInTheDocument();
  });

  it("does not show a loading skeleton while on an auth route, even mid-auth-check", () => {
    // #given the auth query is still in flight
    mockAuthState = { data: undefined, isLoading: true };

    // #when visiting the sign-in page
    renderAuthRoute();

    // #then the auth form is shown immediately rather than a loading state
    // (avoids a skeleton flash on every visit to sign-in/sign-up)
    expect(screen.getByText("Sign in form")).toBeInTheDocument();
  });
});
