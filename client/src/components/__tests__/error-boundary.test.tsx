import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "@/components/error-boundary";

const Bomb = () => {
  throw new Error("boom");
};

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    // #given a subtree that renders normally
    // #when it mounts inside the boundary
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );

    // #then the children are shown as normal
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows a fallback instead of crashing when a child throws", () => {
    // #given a subtree that throws during render
    // React logs the caught error to the console by default; silence it so
    // the test output isn't noisy for an error we're deliberately causing.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // #when it mounts inside the boundary
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    // #then a fallback UI is shown instead of the app crashing
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    spy.mockRestore();
  });
});
