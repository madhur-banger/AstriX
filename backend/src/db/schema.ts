import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const roleNameEnum = pgEnum("role_name", ["OWNER", "ADMIN", "MEMBER"]);
export const permissionEnum = pgEnum("permission", [
  "CREATE_WORKSPACE",
  "DELETE_WORKSPACE",
  "EDIT_WORKSPACE",
  "MANAGE_WORKSPACE_SETTINGS",
  "ADD_MEMBER",
  "CHANGE_MEMBER_ROLE",
  "REMOVE_MEMBER",
  "CREATE_PROJECT",
  "EDIT_PROJECT",
  "DELETE_PROJECT",
  "CREATE_TASK",
  "EDIT_TASK",
  "DELETE_TASK",
  "VIEW_ONLY",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
]);
export const taskPriorityEnum = pgEnum("task_priority", [
  "LOW",
  "MEDIUM",
  "HIGH",
]);
export const oauthProviderEnum = pgEnum("oauth_provider", [
  "GOOGLE",
  "GITHUB",
  "FACEBOOK",
  "EMAIL",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    email: text("email").notNull(),
    passwordHash: text("password_hash"),
    profilePicture: text("profile_picture"),
    isActive: boolean("is_active").notNull().default(true),
    isEmailVerified: boolean("is_email_verified").notNull().default(false),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    // Circular reference with workspaces.ownerId (Phase 1 §1.3). The
    // `() => workspaces.id` thunk lets Drizzle emit the FK as a separate
    // ALTER TABLE after both tables exist, but TS can't infer the return
    // type of a function referencing a not-yet-declared const without an
    // explicit annotation - hence `(): AnyPgColumn =>`, Drizzle's documented
    // fix for exactly this circular-reference case.
    currentWorkspaceId: uuid("current_workspace_id").references(
      (): AnyPgColumn => workspaces.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  })
);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: uuid("owner_id")
    .notNull()
    .references((): AnyPgColumn => users.id),
  inviteCode: text("invite_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: roleNameEnum("name").notNull(),
    permissions: permissionEnum("permissions").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Phase 1's DDL declares `name` UNIQUE; the first draft of this
    // Drizzle schema dropped it (caught only by seed-roles.ts's
    // onConflictDoNothing() needing a real constraint to target).
    nameIdx: uniqueIndex("roles_name_idx").on(t.name),
  })
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userWorkspaceUnique: uniqueIndex(
      "workspace_members_user_workspace_unique"
    ).on(t.userId, t.workspaceId),
    workspaceIdx: index("workspace_members_workspace_id_idx").on(
      t.workspaceId
    ),
  })
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    emoji: text("emoji").notNull().default("📊"),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceIdx: index("projects_workspace_id_idx").on(t.workspaceId),
  })
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskCode: text("task_code").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: taskStatusEnum("status").notNull().default("TODO"),
    priority: taskPriorityEnum("priority").notNull().default("MEDIUM"),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    dueDate: timestamp("due_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    workspaceProjectIdx: index("tasks_workspace_project_idx").on(
      t.workspaceId,
      t.projectId
    ),
    workspaceStatusIdx: index("tasks_workspace_status_idx").on(
      t.workspaceId,
      t.status
    ),
    assignedToIdx: index("tasks_assigned_to_idx").on(t.assignedTo),
  })
);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: oauthProviderEnum("provider").notNull(),
  providerId: text("provider_id").notNull(),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  assignee: one(users, {
    fields: [tasks.assignedTo],
    references: [users.id],
  }),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
    role: one(roles, {
      fields: [workspaceMembers.roleId],
      references: [roles.id],
    }),
  })
);
