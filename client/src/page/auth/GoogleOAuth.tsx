// client/src/page/auth/GoogleOAuth.tsx
// ============================================
// GOOGLE OAUTH CALLBACK HANDLER
// ============================================

import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useStoreBase } from "@/store/store";
import { getCurrentUserQueryFn } from "@/lib/api";
import Logo from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

/**
 * GOOGLE OAUTH CALLBACK PAGE
 * 
 * This page handles the redirect from Google OAuth.
 * 
 * Flow:
 * 1. User clicks "Login with Google"
 * 2. Redirected to Google, authenticates
 * 3. Google redirects to backend /auth/google/callback
 * 4. Backend creates session, sets refresh token cookie
 * 5. Backend redirects here with access_token in URL params
 * 6. We extract token, store in Zustand, fetch user, redirect to app
 * 
 * SECURITY NOTE:
 * - Access token in URL is not ideal but necessary for OAuth redirect
 * - We immediately clear it from URL after extracting
 * - Refresh token is in httpOnly cookie (more secure)
 */
const GoogleOAuth: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { setAuth } = useStoreBase();

  const [status, setStatus] = useState<"loading" | "success" | "failure">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleOAuthCallback = async () => {
      const urlStatus = params.get("status");
      const accessToken = params.get("access_token");
      const currentWorkspace = params.get("current_workspace");
      const urlError = params.get("error");

      // Clear URL params immediately for security
      window.history.replaceState({}, "", window.location.pathname);

      // Handle explicit failure
      if (urlStatus === "failure") {
        setStatus("failure");
        setError(urlError || "Authentication failed");
        return;
      }

      // Handle success
      if (urlStatus === "success" && accessToken) {
        try {
          // Store access token
          useStoreBase.getState().setAccessToken(accessToken);

          // Fetch user data
          const response = await getCurrentUserQueryFn();

          const user = response.user;

          // Set full auth state
          setAuth(accessToken, user);

          setStatus("success");

          // Redirect to workspace or home
          if (currentWorkspace) {
            navigate(`/workspace/${currentWorkspace}`, { replace: true });
          } else {
            navigate("/", { replace: true });
          }
        } catch (err: any) {
          console.error("Error fetching user after OAuth:", err);
          setStatus("failure");
          setError("Failed to complete authentication");
        }
      } else {
        // No valid params - shouldn't happen normally
        setStatus("failure");
        setError("Invalid callback parameters");
      }
    };

    handleOAuthCallback();
  }, [params, navigate, setAuth]);

  // Loading state
  if (status === "loading") {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Completing sign in...</p>
        </div>
      </div>
    );
  }

  // Success state (briefly shown before redirect)
  if (status === "success") {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Redirecting...</p>
        </div>
      </div>
    );
  }

  // Failure state
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
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <div className="text-center space-y-4">
            <h1 className="text-xl font-semibold">Authentication Failed</h1>
            <p className="text-muted-foreground">
              {error || "We couldn't sign you in with Google. Please try again."}
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={() => navigate("/sign-in")} className="w-full">
                Back to Login
              </Button>
              <Button
                variant="outline"
                onClick={() => navigate("/sign-up")}
                className="w-full"
              >
                Create Account
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default GoogleOAuth;