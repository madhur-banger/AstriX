/**
 * END-TO-END (E2E) TESTS: workspace routes
 * --------------------------------------------
 * This is the OUTERMOST layer of testing: we build a real Express app,
 * mount the REAL workspace routes on it, and fire REAL HTTP requests at it
 * using `supertest` - exactly like a frontend or Postman would. Nothing is
 * mocked except your actual auth middleware (passport/session), because
 * setting up a real login flow in a test is usually more trouble than it's
 * worth - we just inject `req.user` directly the way your real auth
 * middleware would after a successful login.
 *
 * WHAT E2E TESTS ARE FOR (and NOT for):
 * They confirm the whole chain wires together correctly: routing -> zod
 * validation -> permission checks -> service -> real DB -> JSON response
 * shape -> HTTP status code. They are NOT the place to enumerate every
 * business-logic edge case (that's what the service unit tests are for) -
 * keep this file to a handful of "does the happy path work end-to-end" and
 * "does an obviously bad request get rejected with the right status" cases.
 *
 * ASSUMPTION CALLOUT:
 * We seed the OWNER role with ALL permission values from your Permissions
 * enum, so that a workspace owner passes every roleGuard check in these
 * tests. If your enums/role.enum.ts is structured differently, adjust the
 * `Object.values(Permissions)` line below.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express, { NextFunction, Request, Response } from "express";
import request from "supertest";

import workspaceRoutes from "../../src/routes/workspace.routes";
import UserModel from "../../src/models/user.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles, Permissions } from "../../src/enums/role.enum";

function buildTestApp(fakeUserId: string) {
  const app = express();
  app.use(express.json());

  // Stand-in for your real passport/session auth middleware: in production
  // this would populate req.user after verifying a JWT/cookie. Here we just
  // hardcode it, since we're testing the ROUTES, not the auth system itself.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { _id: fakeUserId };
    next();
  });

  app.use("/api/workspace", workspaceRoutes);

  // Minimal error handler so a thrown/rejected controller error becomes a
  // JSON response instead of supertest seeing a raw connection error.
  // Replace this with your real src/middlewares/errorHandles.middleware.ts
  // if you want the exact production error shape asserted here too.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ message: err.message || "Internal error" });
  });

  return app;
}

describe("Workspace routes (E2E via supertest + in-memory DB)", () => {
  let userId: string;
  let app: express.Express;

  beforeEach(async () => {
    // Seed a role with EVERY permission so this user (as OWNER) clears every
    // roleGuard check across all the routes exercised below.
    await RoleModel.create({
      name: Roles.OWNER,
      permissions: Object.values(Permissions),
    });

    const user = await UserModel.create({
      name: "E2E Test User",
      email: `e2e-${Date.now()}@example.com`,
    });
    userId = user._id.toString();
    app = buildTestApp(userId);
  });

  it("POST /api/workspace/create/new -> 201 with the created workspace", async () => {
    const res = await request(app)
      .post("/api/workspace/create/new")
      .send({ name: "E2E Workspace", description: "made via supertest" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Workspace created successfully");
    expect(res.body.workspace.name).toBe("E2E Workspace");
  });

  it("POST /api/workspace/create/new -> 400-level status when name is missing", async () => {
    const res = await request(app)
      .post("/api/workspace/create/new")
      .send({ description: "no name provided" });

    // Zod's thrown error should be caught by asyncHandler -> next(err) ->
    // our error handler above, resulting in SOME 4xx/5xx status.
    // If your real error handler maps ZodError to exactly 400, tighten
    // this assertion to `expect(res.status).toBe(400)`.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("full lifecycle: create -> get by id -> update -> delete", async () => {
    // 1. Create
    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .send({ name: "Lifecycle Workspace" });
    expect(createRes.status).toBe(201);
    const workspaceId = createRes.body.workspace._id;

    // 2. Get by id - confirms the membership check (getMemberRoleInWorkspace)
    //    correctly recognizes the creator as a member.
    const getRes = await request(app).get(`/api/workspace/${workspaceId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.workspace._id).toBe(workspaceId);

    // 3. Update - confirms the EDIT_WORKSPACE permission check passes for the owner.
    const updateRes = await request(app)
      .put(`/api/workspace/update/${workspaceId}`)
      .send({ name: "Renamed via E2E" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.workspace.name).toBe("Renamed via E2E");

    // 4. Delete - confirms the DELETE_WORKSPACE permission check + ownership check pass.
    const deleteRes = await request(app).delete(
      `/api/workspace/delete/${workspaceId}`
    );
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.message).toBe("Workspace deleted successfully");

    // 5. Confirm it's REALLY gone by trying to fetch it again -> should now 404-ish.
    const getAfterDeleteRes = await request(app).get(
      `/api/workspace/${workspaceId}`
    );
    expect(getAfterDeleteRes.status).toBeGreaterThanOrEqual(400);
  });

  it("GET /api/workspace/:id -> error status for a workspace the user never joined", async () => {
    // Create a SECOND, unrelated user+app who was never added as a member
    // of any workspace, then try to access one that belongs to `userId`.
    const outsiderUser = await UserModel.create({
      name: "Outsider",
      email: `outsider-${Date.now()}@example.com`,
    });
    const outsiderApp = buildTestApp(outsiderUser._id.toString());

    const createRes = await request(app)
      .post("/api/workspace/create/new")
      .send({ name: "Private Workspace" });
    const workspaceId = createRes.body.workspace._id;

    const res = await request(outsiderApp).get(`/api/workspace/${workspaceId}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
