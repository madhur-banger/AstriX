import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Row } from "@tanstack/react-table";
import { render } from "@testing-library/react";
import { DataTableRowActions } from "@/components/workspace/task/table/table-row-actions";
import { deleteTaskMutationFn } from "@/lib/api";
import { TaskType } from "@/types/api.type";

vi.mock("@/lib/api", () => ({
  deleteTaskMutationFn: vi.fn(),
}));

vi.mock("@/hooks/use-workspace-id", () => ({
  default: () => "ws-1",
}));

// EditTaskDialog pulls in EditTaskForm and its own data dependencies -
// mocked here so this test stays focused on table-row-actions.tsx's own
// wiring (does it open the dialog with the right task?), not the form.
vi.mock("@/components/workspace/task/edit-task-dialog", () => ({
  default: ({
    task,
    isOpen,
  }: {
    task: TaskType;
    isOpen: boolean;
    onClose: () => void;
  }) => (isOpen ? <div>Editing {task.taskCode}</div> : null),
}));

const task: TaskType = {
  _id: "task-1",
  title: "Write tests",
  priority: "MEDIUM",
  status: "TODO",
  assignedTo: null,
  dueDate: "2024-01-01",
  taskCode: "TASK-1",
  project: { _id: "proj-1", emoji: "📋", name: "Project" },
};

const row = { original: task } as Row<TaskType>;

const renderRowActions = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <DataTableRowActions row={row} />
      </QueryClientProvider>
    ),
  };
};

const openMenu = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /open menu/i }));
  return user;
};

describe("DataTableRowActions (task edit/delete)", () => {
  beforeEach(() => {
    vi.mocked(deleteTaskMutationFn).mockReset();
  });

  it("opens the edit dialog for this task when 'Edit Task' is clicked", async () => {
    // #given the row menu is open
    renderRowActions();
    const user = await openMenu();

    // #when clicking "Edit Task"
    await user.click(screen.getByText("Edit Task"));

    // #then the edit dialog opens for THIS task
    expect(screen.getByText("Editing TASK-1")).toBeInTheDocument();
  });

  it("deletes the task and invalidates the task list when the delete confirm dialog is confirmed", async () => {
    // #given a delete call that succeeds, and the row menu is open
    vi.mocked(deleteTaskMutationFn).mockResolvedValue({
      message: "Task deleted",
    });
    const { queryClient } = renderRowActions();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /open menu/i }));
    await user.click(screen.getByText("Delete Task"));

    // #when confirming the delete
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    // #then the mutation fires with the right workspace/task ids
    await waitFor(() =>
      expect(deleteTaskMutationFn).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        taskId: "task-1",
      })
    );

    // #and the task list (and this task's project analytics) are invalidated
    // so the deleted task actually disappears from the UI
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["all-tasks", "ws-1"] })
    );
  });

  it("does not call the delete mutation just from opening the confirm dialog", async () => {
    // #given the row menu is open
    renderRowActions();
    const user = await openMenu();

    // #when opening (but not confirming) the delete dialog
    await user.click(screen.getByText("Delete Task"));

    // #then nothing has been deleted yet
    expect(deleteTaskMutationFn).not.toHaveBeenCalled();
  });
});
