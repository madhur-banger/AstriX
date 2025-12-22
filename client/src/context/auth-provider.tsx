import { createContext, useContext, useEffect } from "react";
import useWorkspaceId from "@/hooks/use-workspace-id";
import { UserType, WorkspaceType } from "@/types/api.type";
import { PermissionType } from "@/constant";
import useAuth from "@/hooks/api/use-auth";

// Define the context shape
type AuthContextType = {
  user?: UserType;
  // workspace?: WorkspaceType;
  // hasPermission: (permission: PermissionType) => boolean;
  error: any;
  isLoading: boolean;
  isFetching: boolean;
  // workspaceLoading: boolean;
  refetchAuth: () => void;
  // refetchWorkspace: () => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // const navigate = useNavigate();
  // const workspaceId = useWorkspaceId();

  const {
    data: authData,
    error: authError,
    isLoading: authLoading,
    isFetching,
    refetch: refetchAuth,
  } = useAuth();

  const user = authData?.user;

  useEffect(() => {});

  return (
    <AuthContext.Provider
      value={{
        user,
        error: authError,
        isLoading: authLoading,
        isFetching,
        refetchAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuthContext = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useCurrentUserContext must be used within a AuthProvider");
  }
  return context;
};
