export const BASE_URL = __ENV.BASE_URL || "http://localhost:8000/api";

// The base mailbox every synthetic user is derived from via +addressing
// (userN@ -> base+userN@), e.g. "loadtest@example.com" -> "loadtest+user0@
// example.com". Each derived address is a distinct row (unique index on
// users.email in schema.ts), so NUM_USERS independent accounts come from
// one base address instead of NUM_USERS separately-configured ones. All
// synthetic users share LOAD_TEST_PASSWORD.
export const LOAD_TEST_EMAIL = __ENV.LOAD_TEST_EMAIL;
export const LOAD_TEST_PASSWORD = __ENV.LOAD_TEST_PASSWORD;

export const userEmail = (index) => {
  const at = LOAD_TEST_EMAIL.indexOf("@");
  return `${LOAD_TEST_EMAIL.slice(0, at)}+user${index}${LOAD_TEST_EMAIL.slice(at)}`;
};

const intEnv = (name, fallback) => {
  const raw = __ENV[name];
  return raw ? parseInt(raw, 10) : fallback;
};

// How many distinct simulated users the run provisions. Each scenario picks
// a fresh user per ITERATION (via k6/execution's scenario.iterationInTest -
// see scenarios.js), not per VU, and defaults its total iteration count to
// this same number - so by default every user does ~1 operation per
// scenario instead of a handful of VUs looping through many operations
// each as the same identity.
export const NUM_USERS = intEnv("NUM_USERS", 10);

// *_VUS is pure concurrency (how many requests are in flight at once) -
// independent of NUM_USERS/population size. *_ITERATIONS is the TOTAL
// number of operations across the whole scenario (not per VU); it defaults
// to NUM_USERS so each user is touched about once by default. Set it above
// NUM_USERS if you deliberately want users making more than one call each.
export const WORKSPACE_VUS = intEnv("WORKSPACE_VUS", 5);
export const WORKSPACE_ITERATIONS = intEnv("WORKSPACE_ITERATIONS", NUM_USERS);

export const PROJECT_VUS = intEnv("PROJECT_VUS", 5);
export const PROJECT_ITERATIONS = intEnv("PROJECT_ITERATIONS", NUM_USERS);

export const TASK_VUS = intEnv("TASK_VUS", 5);
export const TASK_ITERATIONS = intEnv("TASK_ITERATIONS", NUM_USERS);
