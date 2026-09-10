import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthContext } from "@/context/auth-provider";
import { resendVerificationEmailMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";
import { toast } from "@/hooks/use-toast";

// Advisory only — the backend never gates login/actions on isEmailVerified,
// so this is a dismissible nudge, not a hard wall in front of the app.
const EmailVerificationBanner = () => {
  const { user } = useAuthContext();
  const [dismissed, setDismissed] = useState(false);

  const { mutate, isPending } = useMutation({
    mutationFn: resendVerificationEmailMutationFn,
  });

  if (!user || user.isEmailVerified || dismissed) return null;

  const handleResend = () => {
    mutate(undefined, {
      onSuccess: () => {
        toast({
          title: "Verification email sent",
          description: "Check your inbox for the verification link.",
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
    <div className="flex items-center justify-between gap-3 border-b bg-yellow-50 px-4 py-2 text-sm text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100">
      <span>Please verify your email address to secure your account.</span>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={handleResend}
        >
          Resend email
        </Button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="text-yellow-900/70 hover:text-yellow-900 dark:text-yellow-100/70 dark:hover:text-yellow-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default EmailVerificationBanner;
