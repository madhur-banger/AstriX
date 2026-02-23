/**
 * UNIT TESTS: roleGuard.ts
 * ---------------------------
 * Deliberately NOT mocked - every other test file in the suite mocks
 * roleGuard away to isolate controllers, so its actual permission-checking
 * logic (against the real RolePermissions map) has never been directly
 * exercised until this file.
 */

import { describe, it, expect } from "vitest";

import { roleGuard } from "../../../src/utils/roleGuard";
import { Permissions } from "../../../src/enums/role.enum";
import { ForbiddenException } from "../../../src/utils/appError";

describe("roleGuard", () => {
  it("passes silently when the role has every required permission", () => {
    expect(() =>
      roleGuard("OWNER", [
        Permissions.CREATE_PROJECT,
        Permissions.DELETE_PROJECT,
      ])
    ).not.toThrow();
  });

  it("throws ForbiddenException (403 - authenticated, but not allowed) when the role is missing one of several required permissions", () => {
    // MEMBER has VIEW_ONLY/CREATE_TASK/EDIT_TASK but not DELETE_TASK.
    expect(() =>
      roleGuard("MEMBER", [Permissions.VIEW_ONLY, Permissions.DELETE_TASK])
    ).toThrow(ForbiddenException);
  });

  it("passes when requiredPermissions is an empty array (vacuously true)", () => {
    expect(() => roleGuard("MEMBER", [])).not.toThrow();
  });

  it("throws for a role name that isn't in the RolePermissions map", () => {
    expect(() =>
      roleGuard("NOT_A_REAL_ROLE" as any, [Permissions.VIEW_ONLY])
    ).toThrow();
  });

  it("throws the exact 'insufficient permissions' message", () => {
    expect(() => roleGuard("MEMBER", [Permissions.DELETE_TASK])).toThrow(
      "You do not have the necessary permissions to perform this action"
    );
  });
});
