import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { AuthProvider, useAuthContext } from "@/context/auth-provider";

const mockUser = { _id: "u1", name: "Ada" };
const mockWorkspace = { _id: "w1", name: "Workspace" };

let mockIsFetching = false;

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "w1",
}));

vi.mock("@/hooks/api/use-auth", () => ({
  default: () => ({
    data: { user: mockUser },
    error: null,
    isLoading: false,
    get isFetching() {
      return mockIsFetching;
    },
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/api/use-get-workspace", () => ({
  default: () => ({
    data: { workspace: mockWorkspace },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// A stable reference, matching the real usePermissions hook's own useMemo —
// a naive mock returning a fresh `[]` literal each call would make
// hasPermission's useCallback recompute for the wrong reason.
const mockPermissions: never[] = [];
vi.mock("@/hooks/use-permissions", () => ({
  default: () => mockPermissions,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

describe("AuthProvider context value stability", () => {
  beforeEach(() => {
    mockIsFetching = false;
  });

  it("keeps the same context value reference across an unrelated re-render", () => {
    // #given a mounted AuthProvider with a stable user/workspace/permissions
    const { result, rerender } = renderHook(() => useAuthContext(), {
      wrapper: AuthProvider,
    });
    const firstValue = result.current;

    // #when a background react-query tick flips isFetching without
    // changing user/workspace/permissions data
    act(() => {
      mockIsFetching = true;
    });
    rerender();
    const secondValue = result.current;

    // #then hasPermission's closure stays referentially stable — before the
    // useCallback fix in auth-provider.tsx, a fresh closure was created on
    // every render, propagating as a needless identity change to every
    // context consumer (and anything downstream depending on hasPermission)
    expect(secondValue.hasPermission).toBe(firstValue.hasPermission);
  });
});
