import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import Logo from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { verifyEmailMutationFn } from "@/lib/api";
import { getErrorMessage } from "@/lib/helper";

const VerifyEmail = () => {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<"loading" | "success" | "failure">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  const hasRun = useRef(false);

  const { mutate } = useMutation({
    mutationFn: verifyEmailMutationFn,
  });

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    if (!token) {
      setStatus("failure");
      setError("This verification link is missing or invalid.");
      return;
    }

    mutate(
      { token },
      {
        onSuccess: () => setStatus("success"),
        onError: (err) => {
          setStatus("failure");
          setError(getErrorMessage(err, "Verification failed."));
        },
      }
    );
  }, [token, mutate]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <Link to="/" className="flex items-center gap-2 self-center font-medium">
        <Logo />
        AstriX
      </Link>
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6 text-center space-y-4">
          {status === "loading" && (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <p className="text-muted-foreground">Verifying your email...</p>
            </div>
          )}
          {status === "success" && (
            <>
              <h1 className="text-xl font-semibold">Email verified</h1>
              <p className="text-muted-foreground">
                Your email address has been verified.
              </p>
              <Button asChild className="w-full">
                <Link to="/">Continue</Link>
              </Button>
            </>
          )}
          {status === "failure" && (
            <>
              <h1 className="text-xl font-semibold">Verification failed</h1>
              <p className="text-muted-foreground">{error}</p>
              <Button asChild className="w-full">
                <Link to="/">Back to app</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default VerifyEmail;
