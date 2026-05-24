import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/reusable/confirm-dialog";
import { useAuthContext } from "@/context/auth-provider";
import useConfirmDialog from "@/hooks/use-confirm-dialog";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { leaveWorkspaceMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";

const LeaveWorkspaceCard = () => {
  const { user, workspace } = useAuthContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  const { open, onOpenDialog, onCloseDialog } = useConfirmDialog();
  const { mutate, isPending } = useMutation({
    mutationFn: leaveWorkspaceMutationFn,
  });

  const isOwner = !!user && !!workspace && workspace.owner === user._id;

  const handleLeave = () => {
    mutate(workspaceId, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["userWorkspaces"] });
        toast({ title: "You left the workspace" });
        navigate("/", { replace: true });
      },
      onError: (error) => {
        toast({
          title: "Error",
          description: getErrorMessage(error),
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div className="w-full h-auto max-w-full">
      <div className="h-full">
        <div className="mb-5 border-b">
          <h1 className="text-[17px] tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1.5 text-center sm:text-left">
            Leave workspace
          </h1>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border p-4">
          <div>
            <p className="text-sm font-medium">{workspace?.name}</p>
            <p className="text-sm text-muted-foreground">
              {isOwner
                ? "You own this workspace — transfer or delete it instead of leaving."
                : "You'll lose access to this workspace's projects and tasks."}
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0 text-destructive hover:text-destructive"
            disabled={isOwner}
            onClick={() => onOpenDialog()}
          >
            Leave
          </Button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={open}
        isLoading={isPending}
        onClose={onCloseDialog}
        onConfirm={handleLeave}
        title="Leave workspace"
        description={`Leave ${workspace?.name || "this workspace"}? You'll need a new invite to rejoin.`}
        confirmText="Leave"
        cancelText="Cancel"
      />
    </div>
  );
};

export default LeaveWorkspaceCard;
