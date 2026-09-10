import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import usePermissions from "@/hooks/use-permissions";
import { Permissions, PermissionType } from "@/constant";
import { UserType, WorkspaceWithMembersType } from "@/types/api.type";

const buildUser = (overrides: Partial<UserType> = {}): UserType =>
  ({
    _id: "u1",
    name: "Ada",
    email: "ada@x.com",
    ...overrides,
  }) as UserType;

const buildWorkspace = (
  members: WorkspaceWithMembersType["members"]
): WorkspaceWithMembersType =>
  ({
    _id: "w1",
    name: "Workspace",
    members,
  }) as WorkspaceWithMembersType;

const member = (
  userId: string,
  permissions: PermissionType[]
): WorkspaceWithMembersType["members"][number] =>
  ({
    _id: `member-${userId}`,
    userId,
    workspaceId: "w1",
    role: { _id: "role-1", name: "OWNER", permissions },
    joinedAt: "2024-01-01",
    createdAt: "2024-01-01",
  }) as WorkspaceWithMembersType["members"][number];

describe("usePermissions", () => {
  it("returns [] when there is no user or no workspace", () => {
    // #given a hook called with a missing user/workspace
    const { result: withoutUser } = renderHook(() =>
      usePermissions(undefined, buildWorkspace([]))
    );
    const { result: withoutWorkspace } = renderHook(() =>
      usePermissions(buildUser(), undefined)
    );

    // #then it resolves to an empty permission set, never throws
    expect(withoutUser.current).toEqual([]);
    expect(withoutWorkspace.current).toEqual([]);
  });

  it("resolves the current user's permissions from their membership in the workspace", () => {
    // #given a workspace where the current user is a member with permissions
    const user = buildUser({ _id: "u1" });
    const workspace = buildWorkspace([
      member("u1", [Permissions.EDIT_TASK, Permissions.VIEW_ONLY]),
      member("u2", [Permissions.CREATE_TASK]),
    ]);

    // #when resolving permissions
    const { result } = renderHook(() => usePermissions(user, workspace));

    // #then it returns only this user's permissions, not another member's
    expect(result.current).toEqual([
      Permissions.EDIT_TASK,
      Permissions.VIEW_ONLY,
    ]);
  });

  it("returns [] when the user has no matching membership in the workspace", () => {
    // #given a workspace where the current user isn't a member
    const user = buildUser({ _id: "not-a-member" });
    const workspace = buildWorkspace([member("u2", [Permissions.CREATE_TASK])]);

    // #when resolving permissions
    const { result } = renderHook(() => usePermissions(user, workspace));

    // #then no permissions leak from an unrelated member
    expect(result.current).toEqual([]);
  });

  it("recomputes (not stale) when the workspace argument changes, e.g. on a workspace switch", () => {
    // #given a hook initially resolved against workspace A, where the user
    // has EDIT_TASK
    const user = buildUser({ _id: "u1" });
    const workspaceA = buildWorkspace([member("u1", [Permissions.EDIT_TASK])]);
    const workspaceB = buildWorkspace([member("u1", [Permissions.VIEW_ONLY])]);

    const { result, rerender } = renderHook(
      ({ workspace }) => usePermissions(user, workspace),
      { initialProps: { workspace: workspaceA } }
    );
    expect(result.current).toEqual([Permissions.EDIT_TASK]);

    // #when the workspace argument switches to workspace B
    rerender({ workspace: workspaceB });

    // #then permissions reflect the NEW workspace's membership, not a stale
    // value held over from workspace A
    expect(result.current).toEqual([Permissions.VIEW_ONLY]);
  });

  it("resets to [] when switching to a workspace with no matching membership", () => {
    // #given a hook resolved against a workspace where the user is a member
    const user = buildUser({ _id: "u1" });
    const workspaceWithMembership = buildWorkspace([
      member("u1", [Permissions.EDIT_TASK]),
    ]);
    const workspaceWithoutMembership = buildWorkspace([
      member("someone-else", [Permissions.EDIT_TASK]),
    ]);

    const { result, rerender } = renderHook(
      ({ workspace }) => usePermissions(user, workspace),
      { initialProps: { workspace: workspaceWithMembership } }
    );
    expect(result.current).toEqual([Permissions.EDIT_TASK]);

    // #when switching to a workspace the user doesn't belong to
    rerender({ workspace: workspaceWithoutMembership });

    // #then the previous workspace's permissions never leak into the new one
    expect(result.current).toEqual([]);
  });
});
