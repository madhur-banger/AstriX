import Logo from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStore } from "@/store/store";
import React from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

const GoogleOAuth = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const status = params.get("status");
  const token =  params.get("token");
  const currentWorkspace = params.get("current_workspace");

  const [processed, setProcessed] = React.useState(false);

  React.useEffect(() => {
    if (processed) return;

    // Explicit failure from backend
    if (status === "failure") {
      setProcessed(true);
      return;
    }

    // Success path
    if (status === "success") {

      setProcessed(true);

      if (currentWorkspace) {
        navigate(`/workspace/${currentWorkspace}`, { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    }
  }, [
    status,
    currentWorkspace,
    navigate,
    processed,
  ]);

  // 🔒 CRITICAL: block render until OAuth resolved
  if (!processed && status !== "failure") {
    return null;
  }

  // Only render failure UI if backend explicitly says failure
  if (status === "failure") {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <Link
            to="/"
            className="flex items-center gap-2 self-center font-medium"
          >
            <Logo />
            AstriX
          </Link>
        </div>
        <Card>
          <CardContent>
            <div style={{ textAlign: "center", marginTop: "50px" }}>
              <h1>Authentication Failed</h1>
              <p>We couldn't sign you in with Google. Please try again.</p>

              <Button
                onClick={() => navigate("/")}
                style={{ marginTop: "20px" }}
              >
                Back to Login
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return null;
};

export default GoogleOAuth;
