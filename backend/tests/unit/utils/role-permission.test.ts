/**
 * UNIT TESTS: role-permission.ts
 * ---------------------------------
 * Locks in the OWNER/ADMIN/MEMBER permission matrix as a regression test -
 * a silent edit here could otherwise remove a permission from a role
 * without any test noticing, since every other test mocks roleGuard away.
 */

import { describe, it, expect } from "vitest";

import { RolePermissions } from "../../../src/utils/role-permission";
import { Permissions } from "../../../src/enums/role.enum";

describe("RolePermissions", () => {
  it("grants OWNER every permission", () => {
    const allPermissions = Object.values(Permissions);
    expect(RolePermissions.OWNER.sort()).toEqual(allPermissions.sort());
  });

  it("grants ADMIN workspace-settings/project/task management but NOT workspace deletion", () => {
    expect(RolePermissions.ADMIN).toEqual(
      expect.arrayContaining([
        Permissions.ADD_MEMBER,
        Permissions.CREATE_PROJECT,
        Permissions.EDIT_PROJECT,
        Permissions.DELETE_PROJECT,
        Permissions.CREATE_TASK,
        Permissions.EDIT_TASK,
        Permissions.DELETE_TASK,
        Permissions.MANAGE_WORKSPACE_SETTINGS,
        Permissions.VIEW_ONLY,
      ])
    );
    expect(RolePermissions.ADMIN).not.toContain(Permissions.DELETE_WORKSPACE);
    expect(RolePermissions.ADMIN).not.toContain(Permissions.CREATE_WORKSPACE);
    expect(RolePermissions.ADMIN).not.toContain(Permissions.CHANGE_MEMBER_ROLE);
  });

  it("grants MEMBER only VIEW_ONLY/CREATE_TASK/EDIT_TASK", () => {
    expect(RolePermissions.MEMBER.sort()).toEqual(
      [
        Permissions.VIEW_ONLY,
        Permissions.CREATE_TASK,
        Permissions.EDIT_TASK,
      ].sort()
    );
    expect(RolePermissions.MEMBER).not.toContain(Permissions.DELETE_TASK);
    expect(RolePermissions.MEMBER).not.toContain(Permissions.CREATE_PROJECT);
  });
});
