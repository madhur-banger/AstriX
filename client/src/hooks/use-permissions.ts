import { PermissionType } from "@/constant";
import { UserType, WorkspaceWithMembersType } from "@/types/api.type";
import { useMemo } from "react";

// Derived, never stored: switching workspaces recomputes this on the same
// render as the new workspace arrives, so the previous workspace's
// permissions can never leak into the new one.
const usePermissions = (
  user: UserType | undefined,
  workspace: WorkspaceWithMembersType | undefined
): PermissionType[] =>
  useMemo(() => {
    if (!user || !workspace) return [];

    const member = workspace.members?.find(
      (member) => member.userId === user._id
    );

    return member?.role?.permissions ?? [];
  }, [user, workspace]);

export default usePermissions;
