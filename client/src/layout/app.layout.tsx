import { Outlet, useLocation } from "react-router-dom";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AuthProvider } from "@/context/auth-provider";
import Asidebar from "@/components/asidebar/asidebar";
import Header from "@/components/header";
import CreateWorkspaceDialog from "@/components/workspace/create-workspace-dialog";
import CreateProjectDialog from "@/components/workspace/project/create-project-dialog";
import EmailVerificationBanner from "@/components/account/email-verification-banner";
import ErrorBoundary from "@/components/error-boundary";

const AppLayout = () => {
  const { pathname } = useLocation();

  return (
    <AuthProvider>
      <SidebarProvider>
        <Asidebar />
        <SidebarInset className="overflow-x-hidden">
          <div className="w-full">
            <>
              <Header />
              <EmailVerificationBanner />
              <div className="px-3 lg:px-20 py-3">
                {/* Keyed by route so a crash on one page doesn't stay
                    tripped after navigating away from it. */}
                <ErrorBoundary key={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </div>
            </>
            <CreateWorkspaceDialog />
            <CreateProjectDialog />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </AuthProvider>
  );
};

export default AppLayout;
