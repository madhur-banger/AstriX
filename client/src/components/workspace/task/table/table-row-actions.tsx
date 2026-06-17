import { useState } from "react";
import { Row } from "@tanstack/react-table";
import { MoreHorizontal } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/reusable/confirm-dialog";
import EditTaskDialog from "../edit-task-dialog";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { deleteTaskMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/helper";
import { TaskType } from "@/types/api.type";

interface DataTableRowActionsProps {
  row: Row<TaskType>;
}

export function DataTableRowActions({ row }: DataTableRowActionsProps) {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const [openDeleteDialog, setOpenDialog] = useState(false);
  const [openEditDialog, setOpenEditDialog] = useState(false);

  const task = row.original;
  const taskId = task._id as string;
  const taskCode = task.taskCode;

  const { mutate, isPending } = useMutation({
    mutationFn: deleteTaskMutationFn,
  });

  const handleConfirm = () => {
    if (isPending) return;

    mutate(
      { workspaceId, taskId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({
            queryKey: ["all-tasks", workspaceId],
          });
          queryClient.invalidateQueries({
            queryKey: ["project-analytics", task.project?._id],
          });

          toast({
            title: "Success",
            description: data.message,
            variant: "success",
          });

          setOpenDialog(false);
        },
        onError: (error) => {
          toast({
            title: "Error",
            description: getErrorMessage(error),
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="flex h-8 w-8 p-0 data-[state=open]:bg-muted"
          >
            <MoreHorizontal />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[160px]">
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setOpenEditDialog(true)}
          >
            Edit Task
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="!text-destructive cursor-pointer"
            onClick={() => setOpenDialog(true)}
          >
            Delete Task
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditTaskDialog
        task={task}
        isOpen={openEditDialog}
        onClose={() => setOpenEditDialog(false)}
      />

      <ConfirmDialog
        isOpen={openDeleteDialog}
        isLoading={isPending}
        onClose={() => setOpenDialog(false)}
        onConfirm={handleConfirm}
        title="Delete Task"
        description={`Are you sure you want to delete ${taskCode}`}
        confirmText="Delete"
        cancelText="Cancel"
      />
    </>
  );
}
