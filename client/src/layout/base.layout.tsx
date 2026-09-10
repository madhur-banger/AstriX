import { Outlet, useLocation } from "react-router-dom";
import ErrorBoundary from "@/components/error-boundary";

const BaseLayout = () => {
  const { pathname } = useLocation();

  return (
    <div className="flex flex-col w-full h-auto">
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-full mx-auto h-auto ">
          {/* Keyed by route so a crash on one page doesn't stay
              tripped after navigating away from it. */}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
};

export default BaseLayout;
