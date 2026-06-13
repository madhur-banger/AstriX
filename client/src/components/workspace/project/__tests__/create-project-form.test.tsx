import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import CreateProjectForm from "@/components/workspace/project/create-project-form";
import { createProjectMutationFn } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  createProjectMutationFn: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom"
    );
  return { ...actual, useNavigate: () => navigateMock };
});

const renderForm = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/workspace/ws-1/projects"]}>
          <Routes>
            <Route
              path="/workspace/:workspaceId/projects"
              element={<CreateProjectForm onClose={vi.fn()} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  };
};

// Regression test for the "allprojects"/"allProjects" query-key typo
// (PLAN.md Critical #3): the invalidation key here MUST match the shape
// use-get-projects.tsx actually queries with - ["allProjects", workspaceId]
// - or the sidebar project list silently never refreshes after a create.
describe("CreateProjectForm - project list cache invalidation", () => {
  it("invalidates the exact query key the projects list is fetched with, after a successful create", async () => {
    // #given project creation succeeds
    vi.mocked(createProjectMutationFn).mockResolvedValue({
      message: "Project created successfully",
      project: { _id: "proj-1", name: "New Project", emoji: "📊" },
    } as Awaited<ReturnType<typeof createProjectMutationFn>>);
    const { queryClient } = renderForm();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // #when submitting the create-project form
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/project title/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    // #then the projects list is invalidated with the SAME key shape
    // use-get-projects.tsx's query is registered under - a case/spelling
    // mismatch here means the sidebar list never refreshes
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["allProjects", "ws-1"] })
      )
    );
  });
});
