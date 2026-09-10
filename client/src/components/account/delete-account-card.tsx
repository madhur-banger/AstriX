import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteAccountMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";
import { useStoreBase } from "@/store/store";
import { Loader } from "lucide-react";

const DeleteAccountCard = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [password, setPassword] = useState("");

  const { mutate, isPending } = useMutation({
    mutationFn: deleteAccountMutationFn,
  });

  const handleClose = () => {
    if (isPending) return;
    setIsOpen(false);
    setPassword("");
  };

  const handleDelete = () => {
    if (isPending) return;
    mutate(
      { password: password || undefined },
      {
        onSuccess: () => {
          queryClient.clear();
          useStoreBase.getState().clearAuth();
          toast({
            title: "Account deleted",
            description: "Your account has been permanently deleted.",
          });
          navigate("/sign-in", { replace: true });
        },
        onError: (error) => {
          // Surfaces the backend's real reason verbatim — e.g. "you still
          // own a workspace" — rather than a generic failure message, since
          // that's actionable info the user needs to proceed.
          toast({
            title: "Couldn't delete account",
            description: getErrorMessage(error),
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <div className="w-full h-auto max-w-full">
      <div className="h-full">
        <div className="mb-5 border-b">
          <h1 className="text-[17px] tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1.5 text-center sm:text-left">
            Danger zone
          </h1>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border border-destructive/50 p-4">
          <div>
            <p className="text-sm font-medium">Delete account</p>
            <p className="text-sm text-muted-foreground">
              Permanently delete your account. You must leave or transfer every
              workspace you own first.
            </p>
          </div>
          <Button
            variant="destructive"
            className="shrink-0"
            onClick={() => setIsOpen(true)}
          >
            Delete account
          </Button>
        </div>
      </div>

      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete account</DialogTitle>
            <DialogDescription>
              This action is permanent and cannot be undone. Enter your password
              to confirm — leave it blank if you signed up with Google.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-account-password">Password</Label>
            <Input
              id="delete-account-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending && <Loader className="animate-spin mr-2 h-4 w-4" />}
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DeleteAccountCard;
