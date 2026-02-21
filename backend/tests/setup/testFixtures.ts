/**
 * TEST FIXTURES / FACTORIES
 * -------------------------
 * A "fixture" is just reusable fake test data. Instead of retyping
 * `{ name: "Test User", email: "..." }` in 20 different test files (and
 * having to update all 20 when the schema changes), we write one function
 * that builds it, and every test calls that function.
 *
 * Pattern used below: a "builder function" that takes optional overrides.
 * This is the single most useful testing pattern you'll reuse forever:
 *
 *   buildFakeUser()                          -> sensible defaults
 *   buildFakeUser({ name: "Custom Name" })   -> defaults + your override
 *
 * As you add tests for tasks/members/projects, ADD MORE FUNCTIONS HERE
 * (buildFakeTask, buildFakeProject, etc.) following the exact same shape.
 * Keeping them all in one file means every test file imports from the
 * same source of truth instead of duplicating fake objects everywhere.
 */

import mongoose from "mongoose";

/**
 * Wraps an arrow function so it becomes safe to use as a mock for a
 * Mongoose model CONSTRUCTOR (anything called with `new Model(...)`).
 *
 * WHY THIS IS NEEDED: arrow functions have no [[Construct]] internal slot -
 * `new someArrowFn()` throws "TypeError: ... is not a constructor" every
 * time, by JS spec, no exceptions. Vitest's `vi.mocked(X).mockImplementation(fn)`
 * just stores whatever `fn` you give it and calls it as-is (with `new`, if
 * that's how the real code calls X) - it doesn't fix this for you.
 * A plain `function` expression DOES have [[Construct]], and when a
 * constructor function explicitly returns an object, that returned object
 * is used instead of `this` - which is exactly the pattern our fake
 * Workspace/User/Account/Member objects rely on.
 */
export function asConstructorMock<T extends (...args: any[]) => any>(fn: T) {
  return function (this: any, ...args: Parameters<T>) {
    return fn(...args);
  };
}

// ---------------------------------------------------------------------------
// Generic helper: makes a valid-looking random MongoDB ObjectId.
// Use this instead of hardcoding a string like "abc123" - Mongoose will
// reject "abc123" as an invalid ObjectId format in real (non-mocked) calls,
// and even in mocked unit tests, using real ObjectIds keeps your tests
// honest about what production data actually looks like.
// ---------------------------------------------------------------------------
export function makeObjectId(): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId();
}

// ---------------------------------------------------------------------------
// Fake USER
// Adjust the field names/types here to EXACTLY match your real
// src/models/user.model.ts schema. This is a best-guess based on how
// UserModel is used in workspace.service.ts (it has _id, currentWorkspace,
// and a .save() method).
// ---------------------------------------------------------------------------
export function buildFakeUser(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "Test User",
    email: `test-${Date.now()}@example.com`,
    currentWorkspace: null,
    // Checked by src/middlewares/auth.middleware.ts - defaults to true so
    // most tests don't need to think about it; override to `false` in the
    // specific test that exercises the "deactivated user" guard clause.
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake WORKSPACE
// Matches src/models/workspace.model.ts: name, description, owner, inviteCode.
// ---------------------------------------------------------------------------
export function buildFakeWorkspace(
  overrides: Partial<Record<string, any>> = {}
) {
  return {
    _id: makeObjectId(),
    name: "Test Workspace",
    description: "A workspace created for testing",
    owner: makeObjectId(),
    inviteCode: "TEST-INVITE-CODE",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ROLE (roles-permission.model.ts)
// Used for OWNER/ADMIN/MEMBER roles with a permissions array.
// ---------------------------------------------------------------------------
export function buildFakeRole(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "OWNER",
    permissions: [] as string[],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake MEMBER (join table between User <-> Workspace <-> Role)
// ---------------------------------------------------------------------------
export function buildFakeMember(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    workspaceId: makeObjectId(),
    role: makeObjectId(),
    joinedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake ACCOUNT (account.model.ts) - links a User to an auth provider
// (email/password, google, etc). Used by auth.service.ts.
// ---------------------------------------------------------------------------
export function buildFakeAccount(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    provider: "email",
    providerId: "test@example.com",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake SESSION (session.model.ts) - one row per logged-in device/browser.
// Used by auth.service.ts for refresh-token rotation and "log out all devices".
// ---------------------------------------------------------------------------
export function buildFakeSession(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    userId: makeObjectId(),
    userAgent: "vitest-test-agent",
    ipAddress: "127.0.0.1",
    isValid: true,
    // Default to one hour in the future so "is this session expired?" checks
    // pass by default - override with a past Date to test the expired path.
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake PROJECT (project.model.ts)
// Matches src/models/project.model.ts: name, description, emoji, workspace, createdBy.
// ---------------------------------------------------------------------------
export function buildFakeProject(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    name: "Test Project",
    description: "A project created for testing",
    emoji: "📊",
    workspace: makeObjectId(),
    createdBy: makeObjectId(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake TASK (task.model.ts)
// Matches src/models/task.model.ts: taskCode, title, description, project,
// workspace, status (default TODO), priority (default MEDIUM), assignedTo,
// createdBy, dueDate.
// ---------------------------------------------------------------------------
export function buildFakeTask(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: makeObjectId(),
    taskCode: `task-${Math.random().toString(36).slice(2, 5)}`,
    title: "Test Task",
    description: "A task created for testing",
    status: "TODO",
    priority: "MEDIUM",
    workspace: makeObjectId(),
    project: makeObjectId(),
    assignedTo: null,
    createdBy: makeObjectId(),
    dueDate: null,
    ...overrides,
  };
}
