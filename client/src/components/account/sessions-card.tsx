import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/reusable/confirm-dialog";
import useConfirmDialog from "@/hooks/use-confirm-dialog";
import { toast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/helper";
import {
  getSessionsQueryFn,
  logoutAllMutationFn,
  revokeSessionMutationFn,
} from "@/lib/api";
import { SessionType } from "@/types/api.type";
import { Loader, MonitorSmartphone } from "lucide-react";
import { format } from "date-fns";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useStoreBase } from "@/store/store";
import { getSessionIdFromAccessToken } from "@/lib/access-token";
import { AUTH_ROUTES } from "@/routes/common/routePaths";

const SessionsCard = () => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { accessToken, clearAuth } = useStoreBase();

  const currentSessionId = useMemo(
    () => getSessionIdFromAccessToken(accessToken),
    [accessToken]
  );

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sessions"],
    queryFn: getSessionsQueryFn,
    staleTime: 0,
  });

  const { open, context, onOpenDialog, onCloseDialog } =
    useConfirmDialog<SessionType>();

  const revokeMutation = useMutation({
    mutationFn: revokeSessionMutationFn,
  });

  const logoutAllMutation = useMutation({
    mutationFn: logoutAllMutationFn,
  });

  const handleRevoke = () => {
    if (!context) return;
    const isCurrentSession = context.id === currentSessionId;

    revokeMutation.mutate(context.id, {
      onSuccess: () => {
        onCloseDialog();

        // Revoking your own session kills the refresh token this tab is
        // using - drop the in-memory auth state now instead of leaving the
        // UI looking signed in until the next request 401s.
        if (isCurrentSession) {
          clearAuth();
          queryClient.clear();
          toast({
            title: "Signed out",
            description: "You revoked the session for this device.",
          });
          navigate(AUTH_ROUTES.SIGN_IN, { replace: true });
          return;
        }

        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        toast({ title: "Session revoked" });
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

  const handleLogoutAll = () => {
    logoutAllMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        toast({
          title: "Signed out everywhere else",
          description: "Other devices have been logged out.",
        });
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
        <div className="mb-5 border-b flex items-center justify-between">
          <h1 className="text-[17px] tracking-[-0.16px] dark:text-[#fcfdffef] font-semibold mb-1.5 text-center sm:text-left">
            Active sessions
          </h1>
          <Button
            variant="outline"
            size="sm"
            disabled={logoutAllMutation.isPending}
            onClick={handleLogoutAll}
          >
            {logoutAllMutation.isPending && (
              <Loader className="animate-spin mr-2 h-4 w-4" />
            )}
            Log out of other devices
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader className="animate-spin h-4 w-4" />
            Loading sessions...
          </div>
        )}

        {isError && (
          <p className="text-sm text-destructive">
            Couldn&apos;t load your active sessions. Try again shortly.
          </p>
        )}

        {!isLoading && !isError && data?.sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No active sessions found.
          </p>
        )}

        <ul className="space-y-3">
          {data?.sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center justify-between gap-4 rounded-md border p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {session.userAgent || "Unknown device"}
                    {session.id === currentSessionId && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                        This device
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.ipAddress || "Unknown IP"} · signed in{" "}
                    {format(new Date(session.createdAt), "MMM d, yyyy p")}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive shrink-0"
                onClick={() => onOpenDialog(session)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        isOpen={open}
        isLoading={revokeMutation.isPending}
        onClose={onCloseDialog}
        onConfirm={handleRevoke}
        title="Revoke session"
        description="This device will be signed out immediately. If it's the device you're using right now, you'll be signed out too."
        confirmText="Revoke"
        cancelText="Cancel"
      />
    </div>
  );
};

export default SessionsCard;
