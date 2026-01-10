import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { logoutMutationFn } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { Loader } from "lucide-react";
import { useStore } from "@/store/store";

const LogoutDialog = (props: {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
  const { isOpen, setIsOpen } = props;
  const navigate = useNavigate();

  // Use clearAuth instead of clearAccessToken (clears both token and user)
  const { clearAuth } = useStore();

  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: logoutMutationFn,
    onSuccess: () => {
      // 1. Clear ALL React Query caches (not just authUser)
      queryClient.clear();

      // 2. Clear Zustand auth state (token + user)
      clearAuth();

      // 3. Show success toast
      toast({
        title: "Logged out",
        description: "You have been logged out successfully.",
      });

      // 4. Close dialog and redirect to sign-in
      setIsOpen(false);
      navigate("/sign-in", { replace: true });
    },
    onError: (error) => {
      // Even if backend fails, still clear local state
      // User should be able to "logout" locally
      console.error("Logout error:", error);

      queryClient.clear();
      clearAuth();

      toast({
        title: "Logged out",
        description: "You have been logged out.",
      });

      setIsOpen(false);
      navigate("/sign-in", { replace: true });
    },
  });

  const handleLogout = useCallback(() => {
    if (isPending) return;
    mutate();
  }, [isPending, mutate]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you sure you want to log out?</DialogTitle>
          <DialogDescription>
            This will end your current session and you will need to log in
            again to access your account.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            type="button"
            onClick={() => setIsOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            onClick={handleLogout}
            disabled={isPending}
          >
            {isPending && <Loader className="animate-spin mr-2 h-4 w-4" />}
            Sign out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default LogoutDialog;