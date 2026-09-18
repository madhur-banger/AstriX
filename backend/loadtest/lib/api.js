import http from "k6/http";
import { check } from "k6";
import { BASE_URL } from "./config.js";

export const authHeaders = (token) => ({
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
});

const login = (email, password) =>
  http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: { "Content-Type": "application/json" },
    tags: { name: "auth_login" },
  });

const register = (email, password) =>
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ name: "Load Test", email, password }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "auth_register" } }
  );

// Logs in, registering the account first if it doesn't exist yet. Tries
// login before register (not the other way around) so a run against an
// already-registered account - the steady-state case - costs exactly one
// request against /auth/login's 5-per-15min limiter, not two.
export const loginOrRegister = (email, password) => {
  let res = login(email, password);

  if (res.status === 401) {
    const registerRes = register(email, password);

    if (registerRes.status !== 201 && registerRes.status !== 400) {
      throw new Error(`Register failed (${registerRes.status}): ${registerRes.body}`);
    }

    res = login(email, password);
  }

  check(res, { "login succeeded": (r) => r.status === 200 });
  if (res.status === 429) {
    throw new Error(
      "Login rate-limited (429) - AUTH_RATE_LIMIT_MAX is too low for NUM_USERS " +
        "worth of provisioning. See README.md."
    );
  }
  if (res.status !== 200) {
    throw new Error(
      `Login failed (${res.status}) even after registering - check LOAD_TEST_PASSWORD ` +
        `matches the existing account: ${res.body}`
    );
  }

  return res.json("access_token");
};

export const createWorkspace = (token, name) => {
  const res = http.post(
    `${BASE_URL}/workspace/create/new`,
    JSON.stringify({ name }),
    { ...authHeaders(token), tags: { name: "workspace_create" } }
  );
  check(res, { "workspace create succeeded": (r) => r.status === 201 });
  return res;
};

export const deleteWorkspace = (token, workspaceId) =>
  http.del(`${BASE_URL}/workspace/delete/${workspaceId}`, null, {
    ...authHeaders(token),
    tags: { name: "workspace_delete" },
  });

export const listWorkspaces = (token) =>
  http.get(`${BASE_URL}/workspace/all`, {
    ...authHeaders(token),
    tags: { name: "workspace_list" },
  });

// pageSize=100 (the schema's max - see project.validation.ts) rather than
// the endpoint's default of 10: setup() searches this list by exact name
// for the persistent base project, and a workspace carrying leftover
// projects from an earlier messy run (crash before cleanup) could otherwise
// push it past page 1 and cause setup() to create a duplicate.
export const listProjects = (token, workspaceId) =>
  http.get(`${BASE_URL}/project/workspace/${workspaceId}/all?pageSize=100`, {
    ...authHeaders(token),
    tags: { name: "project_list" },
  });

export const createProject = (token, workspaceId, name) => {
  const res = http.post(
    `${BASE_URL}/project/workspace/${workspaceId}/create`,
    JSON.stringify({ name }),
    { ...authHeaders(token), tags: { name: "project_create" } }
  );
  check(res, { "project create succeeded": (r) => r.status === 201 });
  return res;
};

export const deleteProject = (token, workspaceId, projectId) =>
  http.del(
    `${BASE_URL}/project/${projectId}/workspace/${workspaceId}/delete`,
    null,
    { ...authHeaders(token), tags: { name: "project_delete" } }
  );

export const createTask = (token, workspaceId, projectId, title) => {
  const res = http.post(
    `${BASE_URL}/task/project/${projectId}/workspace/${workspaceId}/create`,
    JSON.stringify({ title, priority: "MEDIUM", status: "TODO" }),
    { ...authHeaders(token), tags: { name: "task_create" } }
  );
  check(res, { "task create succeeded": (r) => r.status === 200 });
  return res;
};

export const deleteTask = (token, workspaceId, taskId) =>
  http.del(`${BASE_URL}/task/${taskId}/workspace/${workspaceId}/delete`, null, {
    ...authHeaders(token),
    tags: { name: "task_delete" },
  });
