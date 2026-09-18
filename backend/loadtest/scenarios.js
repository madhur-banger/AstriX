// AstriX API load test - simulates NUM_USERS independent users, each with
// their own account/token/workspace. Each scenario picks a DIFFERENT user
// per operation (not per VU), so load is spread thin across many identities
// rather than a handful of users each making many calls. *_VUS is pure
// concurrency; *_ITERATIONS is the total operation count for that scenario
// and defaults to NUM_USERS, so by default every user does ~1 op per
// scenario.
//
// Usage - thousands of users, modest concurrency:
//   BASE_URL=http://localhost:8000/api \
//   LOAD_TEST_EMAIL=loadtest@example.com \
//   LOAD_TEST_PASSWORD='...' \
//   NUM_USERS=2000 \
//   WORKSPACE_VUS=30 \
//   PROJECT_VUS=30 \
//   TASK_VUS=50 \
//   k6 run scenarios.js
//
// (WORKSPACE_ITERATIONS/PROJECT_ITERATIONS/TASK_ITERATIONS default to
// NUM_USERS - set them explicitly to make users repeat operations instead.)
//
// See README.md for the full option list, the multi-user model, and the
// cleanup model.

import { sleep } from "k6";
import { scenario } from "k6/execution";
import {
  LOAD_TEST_EMAIL,
  LOAD_TEST_PASSWORD,
  userEmail,
  NUM_USERS,
  WORKSPACE_VUS,
  WORKSPACE_ITERATIONS,
  PROJECT_VUS,
  PROJECT_ITERATIONS,
  TASK_VUS,
  TASK_ITERATIONS,
} from "./lib/config.js";
import {
  loginOrRegister,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  createProject,
  deleteProject,
  listProjects,
  createTask,
  deleteTask,
} from "./lib/api.js";

const BASE_WORKSPACE_NAME = "loadtest-base-workspace";
const BASE_PROJECT_NAME = "loadtest-base-project";

export const options = {
  // k6 defaults setupTimeout to 60s. setup() provisions NUM_USERS
  // sequentially (see setup() below) - at a few hundred ms/user for anyone
  // not already provisioned, a few hundred users alone can blow past 60s.
  // 20 minutes covers NUM_USERS in the low thousands; raise it further for
  // more than that.
  setupTimeout: "20m",
  scenarios: {
    // shared-iterations (not per-vu-iterations): `iterations` is the TOTAL
    // count across the whole scenario, pulled from a shared queue by `vus`
    // concurrent workers - so vus controls concurrency only, and iterations
    // controls how many distinct users get touched (see pickUser below).
    // With per-vu-iterations, each VU would run its full iteration count
    // back-to-back as the SAME picked identity, which is the "one user
    // making many calls" shape this is deliberately avoiding.
    workspace_crud: {
      executor: "shared-iterations",
      exec: "workspaceScenario",
      vus: WORKSPACE_VUS,
      iterations: WORKSPACE_ITERATIONS,
      maxDuration: "10m",
    },
    project_crud: {
      executor: "shared-iterations",
      exec: "projectScenario",
      vus: PROJECT_VUS,
      iterations: PROJECT_ITERATIONS,
      maxDuration: "10m",
    },
    task_crud: {
      executor: "shared-iterations",
      exec: "taskScenario",
      vus: TASK_VUS,
      iterations: TASK_ITERATIONS,
      maxDuration: "10m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "http_req_duration{name:workspace_create}": ["p(95)<1000"],
    "http_req_duration{name:project_create}": ["p(95)<1000"],
    "http_req_duration{name:task_create}": ["p(95)<1000"],
  },
};

// Picked per ITERATION, not per VU: scenario.iterationInTest is a
// globally-unique, zero-based counter across every iteration of this
// scenario regardless of which VU ran it, so consecutive calls from the
// same worker slot land on different users instead of one user repeating
// many calls back-to-back. Wraps around (modulo) if a scenario's total
// iterations exceed NUM_USERS, so a user can still be touched more than
// once by design (raise NUM_USERS to avoid that, or raise iterations
// deliberately if repeat visits from the same user are what you want to
// test).
const pickUser = (data) => data.users[scenario.iterationInTest % data.users.length];

export const setup = () => {
  if (!LOAD_TEST_EMAIL || !LOAD_TEST_PASSWORD) {
    throw new Error(
      "LOAD_TEST_EMAIL and LOAD_TEST_PASSWORD are required - see README.md"
    );
  }

  // Computed here, once, and threaded through via the returned `data`
  // object - NOT read from a module-level constant. k6 re-executes each
  // script's top-level code independently per VU and separately again for
  // setup()/teardown(), so a value derived from Date.now() at module scope
  // resolves differently in each context and breaks teardown()'s ability to
  // find what setup() named. `data` is the one channel k6 guarantees is
  // identical everywhere.
  const runPrefix = `loadtest-${__ENV.RUN_ID || Date.now()}`;

  // Accounts persist across runs (fixed emails), and so does each user's
  // base workspace/project (fixed names, NOT runPrefix-tagged) - both are
  // stable fixtures reused across runs, not runPrefix-tagged. This
  // matters: k6 does not call teardown() if setup() throws (e.g. an
  // AUTH_RATE_LIMIT_MAX or memory ceiling hit partway through
  // provisioning), so if the base workspace were created fresh every run,
  // every failed run would permanently orphan one per already-provisioned
  // user with no cleanup path. Only the ephemeral per-iteration data the
  // scenarios below create is runPrefix-tagged, since that's the only
  // thing that actually needs sweeping after each run.
  const users = [];
  for (let i = 0; i < NUM_USERS; i++) {
    const token = loginOrRegister(userEmail(i), LOAD_TEST_PASSWORD);

    const existing = listWorkspaces(token).json("workspaces") || [];
    let baseWorkspaceId = (existing.find((w) => w.name === BASE_WORKSPACE_NAME) || {}).id;

    if (!baseWorkspaceId) {
      const created = createWorkspace(token, BASE_WORKSPACE_NAME);
      baseWorkspaceId = created.json("workspace.id");
    }
    if (!baseWorkspaceId) {
      throw new Error(`user ${i} (${userEmail(i)}): failed to get/create base workspace`);
    }

    const existingProjects = listProjects(token, baseWorkspaceId).json("projects") || [];
    let baseProjectId = (existingProjects.find((p) => p.name === BASE_PROJECT_NAME) || {}).id;

    if (!baseProjectId) {
      const created = createProject(token, baseWorkspaceId, BASE_PROJECT_NAME);
      baseProjectId = created.json("project.id");
    }
    if (!baseProjectId) {
      throw new Error(`user ${i} (${userEmail(i)}): failed to get/create base project`);
    }

    users.push({ token, baseWorkspaceId, baseProjectId });
  }

  return { users, runPrefix };
};

// ============================================================================
// WORKSPACE SCENARIO WITH ERROR LOGGING
// ============================================================================
export const workspaceScenario = (data) => {
  const user = pickUser(data);
  const name = `${data.runPrefix}-ws-${scenario.iterationInTest}`;
  const created = createWorkspace(user.token, name);
  const workspaceId = created.json("workspace.id");

  // ✅ ERROR LOGGING - CREATE
  if (created.status !== 201) {
    console.error(
      `❌ WORKSPACE_CREATE_FAILED | iter=${scenario.iterationInTest} | ` +
      `status=${created.status} | body=${(created.body || "").slice(0, 200)}`
    );
  }

  if (workspaceId) {
    const deleted = deleteWorkspace(user.token, workspaceId);
    // ✅ ERROR LOGGING - DELETE
    if (deleted.status !== 200) {
      console.error(
        `❌ WORKSPACE_DELETE_FAILED | wsId=${workspaceId} | ` +
        `status=${deleted.status} | body=${(deleted.body || "").slice(0, 200)}`
      );
    }
  } else {
    console.error(
      `❌ WORKSPACE_NO_ID | iter=${scenario.iterationInTest} | ` +
      `response=${(created.body || "").slice(0, 200)}`
    );
  }

  sleep(1);
};

// ============================================================================
// PROJECT SCENARIO WITH ERROR LOGGING
// ============================================================================
export const projectScenario = (data) => {
  const user = pickUser(data);
  const name = `${data.runPrefix}-proj-${scenario.iterationInTest}`;
  const created = createProject(user.token, user.baseWorkspaceId, name);
  const projectId = created.json("project.id");

  // ✅ ERROR LOGGING - CREATE
  if (created.status !== 201) {
    console.error(
      `❌ PROJECT_CREATE_FAILED | iter=${scenario.iterationInTest} | ` +
      `workspace=${user.baseWorkspaceId} | ` +
      `status=${created.status} | body=${(created.body || "").slice(0, 200)}`
    );
  }

  if (projectId) {
    const deleted = deleteProject(user.token, user.baseWorkspaceId, projectId);
    // ✅ ERROR LOGGING - DELETE
    if (deleted.status !== 200) {
      console.error(
        `❌ PROJECT_DELETE_FAILED | projId=${projectId} | ` +
        `status=${deleted.status} | body=${(deleted.body || "").slice(0, 200)}`
      );
    }
  } else {
    console.error(
      `❌ PROJECT_NO_ID | iter=${scenario.iterationInTest} | ` +
      `response=${(created.body || "").slice(0, 200)}`
    );
  }

  sleep(1);
};

// ============================================================================
// TASK SCENARIO WITH ERROR LOGGING (MOST FAILURES HERE)
// ============================================================================
export const taskScenario = (data) => {
  const user = pickUser(data);
  const title = `${data.runPrefix}-task-${scenario.iterationInTest}`;
  const created = createTask(user.token, user.baseWorkspaceId, user.baseProjectId, title);
  const taskId = created.json("task.id");

  // ✅ ERROR LOGGING - CREATE (THIS IS WHERE MOST FAILURES ARE)
  if (created.status !== 200) {
    console.error(
      `❌ TASK_CREATE_FAILED | iter=${scenario.iterationInTest} | ` +
      `workspace=${user.baseWorkspaceId} | project=${user.baseProjectId} | ` +
      `status=${created.status} | duration=${created.timings.duration}ms | ` +
      `body=${(created.body || "").slice(0, 200)}`
    );
  }

  if (taskId) {
    const deleted = deleteTask(user.token, user.baseWorkspaceId, taskId);
    // ✅ ERROR LOGGING - DELETE
    if (deleted.status !== 200) {
      console.error(
        `❌ TASK_DELETE_FAILED | taskId=${taskId} | ` +
        `status=${deleted.status} | body=${(deleted.body || "").slice(0, 200)}`
      );
    }
  } else {
    console.error(
      `❌ TASK_NO_ID | iter=${scenario.iterationInTest} | ` +
      `response=${(created.body || "").slice(0, 200)}`
    );
  }

  sleep(1);
};

// Runs once, after every scenario finishes, regardless of whether individual
// iterations failed - the backstop for anything a scenario created but
// couldn't delete itself (e.g. a VU killed mid-iteration). Sweeps every
// user's workspaces (not just one) for anything runPrefix-tagged - i.e.
// workspace_crud's own throwaway creates, since each user's persistent base
// workspace (BASE_WORKSPACE_NAME, from setup()) is deliberately NOT
// runPrefix-tagged and is left alone. Deleting a workspace cascades to its
// projects and tasks (onDelete: "cascade" in src/db/schema.ts), so no
// per-task/per-project cleanup is needed here.
//
// NOTE: k6 does not run teardown() at all if setup() throws - so a failure
// during provisioning (rate limit, OOM, etc.) skips this entirely. That's
// fine for the persistent base workspace (nothing to orphan - see setup()),
// but any runPrefix-tagged data already created by a scenario before such a
// failure would need manual cleanup. In practice this only matters if
// setup() itself fails, since scenarios only run after setup() succeeds.
export const teardown = (data) => {
  for (const user of data.users) {
    const listed = listWorkspaces(user.token);
    const workspaces = listed.json("workspaces") || [];

    for (const ws of workspaces) {
      if (ws.name && ws.name.startsWith(data.runPrefix)) {
        deleteWorkspace(user.token, ws.id);
      }
    }
  }
};