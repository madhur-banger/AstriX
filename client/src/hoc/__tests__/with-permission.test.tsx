import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import withPermission from "@/hoc/with-permission";
import { Permissions } from "@/constant";

const navigateMock = vi.fn();

let mockAuthContext: {
  user: { _id: string } | undefined;
  hasPermission: (permission: string) => boolean;
  isLoading: boolean;
};

vi.mock("@/context/auth-provider", () => ({
  useAuthContext: () => mockAuthContext,
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws-1",
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

const Inner = () => <div>Inner content</div>;
const Guarded = withPermission(Inner, Permissions.EDIT_TASK);

describe("withPermission", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("renders the wrapped component when the user has the required permission", () => {
    // #given a user who has EDIT_TASK
    mockAuthContext = {
      user: { _id: "u1" },
      hasPermission: (p) => p === Permissions.EDIT_TASK,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then the wrapped component renders and no redirect happens
    expect(screen.getByText("Inner content")).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("blocks the wrapped component and redirects to the workspace when the permission is missing", () => {
    // #given a logged-in user who lacks EDIT_TASK
    mockAuthContext = {
      user: { _id: "u1" },
      hasPermission: () => false,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then the wrapped component never renders, and the user is redirected
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
    expect(navigateMock).toHaveBeenCalledWith("/workspace/ws-1");
  });

  it("blocks the wrapped component when there is no user at all", () => {
    // #given no logged-in user
    mockAuthContext = {
      user: undefined,
      hasPermission: () => true,
      isLoading: false,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then it never renders the protected content
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
  });

  it("shows a loading state instead of the wrapped component while auth is resolving", () => {
    // #given auth is still loading
    mockAuthContext = {
      user: undefined,
      hasPermission: () => false,
      isLoading: true,
    };

    // #when rendering the guarded component
    render(<Guarded />);

    // #then a loading indicator shows, not the protected content
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Inner content")).not.toBeInTheDocument();
  });
});
