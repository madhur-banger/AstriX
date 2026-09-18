-- Phase 1 schema: MongoDB (Mongoose) -> PostgreSQL
-- Source of truth for this DDL: backend/migrations/phase-1-schema-design-and-postgres-fundamentals.md
-- Applied by hand in psql per that file's §1.6 verification chain. Sessions,
-- password-reset/email-verification tokens are intentionally NOT modeled
-- here -- they move to Redis in Phase 3.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── users ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT,
  email                 TEXT NOT NULL UNIQUE,
  password_hash         TEXT,
  profile_picture       TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  is_email_verified     BOOLEAN NOT NULL DEFAULT false,
  last_login            TIMESTAMPTZ,
  current_workspace_id  UUID,  -- FK added below, once workspaces exists
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_idx ON users (email);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── roles ─────────────────────────────────────────────────────────────────
CREATE TYPE role_name AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE permission AS ENUM (
  'CREATE_WORKSPACE','DELETE_WORKSPACE','EDIT_WORKSPACE','MANAGE_WORKSPACE_SETTINGS',
  'ADD_MEMBER','CHANGE_MEMBER_ROLE','REMOVE_MEMBER',
  'CREATE_PROJECT','EDIT_PROJECT','DELETE_PROJECT',
  'CREATE_TASK','EDIT_TASK','DELETE_TASK',
  'VIEW_ONLY'
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        role_name NOT NULL UNIQUE,
  permissions permission[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── workspaces ────────────────────────────────────────────────────────────
CREATE TABLE workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    UUID NOT NULL REFERENCES users(id),  -- no ON DELETE -> RESTRICT
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD CONSTRAINT users_current_workspace_fk
  FOREIGN KEY (current_workspace_id) REFERENCES workspaces(id)
  ON DELETE SET NULL;

CREATE TRIGGER workspaces_set_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── workspace_members ─────────────────────────────────────────────────────
CREATE TABLE workspace_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id      UUID NOT NULL REFERENCES roles(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT workspace_members_user_workspace_unique UNIQUE (user_id, workspace_id)
);

CREATE INDEX workspace_members_workspace_id_idx ON workspace_members (workspace_id);

CREATE TRIGGER workspace_members_set_updated_at BEFORE UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── accounts (OAuth) ──────────────────────────────────────────────────────
CREATE TYPE oauth_provider AS ENUM ('GOOGLE', 'GITHUB', 'FACEBOOK', 'EMAIL');

CREATE TABLE accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       oauth_provider NOT NULL,
  provider_id    TEXT NOT NULL UNIQUE,
  refresh_token  TEXT,
  token_expiry   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

-- ── projects ──────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  emoji        TEXT NOT NULL DEFAULT '📊',
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX projects_workspace_id_idx ON projects (workspace_id);

CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── tasks ─────────────────────────────────────────────────────────────────
CREATE TYPE task_status AS ENUM ('BACKLOG','TODO','IN_PROGRESS','IN_REVIEW','DONE');
CREATE TYPE task_priority AS ENUM ('LOW','MEDIUM','HIGH');

CREATE TABLE tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_code    TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT,
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status       task_status NOT NULL DEFAULT 'TODO',
  priority     task_priority NOT NULL DEFAULT 'MEDIUM',
  assigned_to  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by   UUID NOT NULL REFERENCES users(id),
  due_date     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_workspace_project_idx ON tasks (workspace_id, project_id);
CREATE INDEX tasks_workspace_status_idx  ON tasks (workspace_id, status);
CREATE INDEX tasks_assigned_to_idx       ON tasks (assigned_to);

CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
