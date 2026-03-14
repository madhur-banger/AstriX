/**
 * END-TO-END (E2E) TESTS: user routes
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";

import userRoutes from "../../src/routes/user.route";
import UserModel from "../../src/models/user.model";
import SessionModel from "../../src/models/session.model";
import WorkspaceModel from "../../src/models/workspace.model";
import MemberModel from "../../src/models/member.model";
import RoleModel from "../../src/models/roles-permission.model";
import { Roles } from "../../src/enums/role.enum";
import { generateTokenPair, calculateExpiryDate } from "../../src/utils/jwt";
import { config } from "../../src/config/app.config";
import { buildRoutedApp } from "../setup/buildTestApp";
import { createAuthenticatedUser } from "../setup/e2eAuth";

describe("User routes (E2E via supertest + in-memory DB)", () => {
  let app: ReturnType<typeof buildRoutedApp>;

  beforeEach(() => {
    app = buildRoutedApp("/api/user", userRoutes);
  });

  it("GET /api/user/current -> 200 with the authenticated user (password excluded)", async () => {
    const { authHeader, user } = await createAuthenticatedUser();

    const res = await request(app)
      .get("/api/user/current")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.user._id).toBe(String(user._id));
    expect(res.body.user.password).toBeUndefined();
  });

  it("GET /api/user/current -> 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/user/current");
    expect(res.status).toBe(401);
  });

  it("GET /api/user/current -> 401 with a garbage bearer token", async () => {
    const res = await request(app)
      .get("/api/user/current")
      .set("Authorization", "Bearer complete-nonsense");
    expect(res.status).toBe(401);
  });

  describe("PATCH /api/user/current (profile update)", () => {
    it("updates the name and persists it", async () => {
      const { authHeader, user } = await createAuthenticatedUser();

      const res = await request(app)
        .patch("/api/user/current")
        .set("Authorization", authHeader)
        .send({ name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.user.name).toBe("Updated Name");

      const persisted = await UserModel.findById(user._id);
      expect(persisted!.name).toBe("Updated Name");
    });

    it("-> 400 when the body is empty (no fields to update)", async () => {
      const { authHeader } = await createAuthenticatedUser();

      const res = await request(app)
        .patch("/api/user/current")
        .set("Authorization", authHeader)
        .send({});

      expect(res.status).toBe(400);
    });

    it("-> 401 with no Authorization header", async () => {
      const res = await request(app)
        .patch("/api/user/current")
        .send({ name: "Nope" });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/user/current (account deletion)", () => {
    it("deletes an OAuth-only account (no password) with no password in the body", async () => {
      const { authHeader, user } = await createAuthenticatedUser();

      const res = await request(app)
        .delete("/api/user/current")
        .set("Authorization", authHeader)
        .send({});

      expect(res.status).toBe(200);

      const persisted = await UserModel.findById(user._id);
      expect(persisted).toBeNull();
    });

    it("-> 400 when the account has a password but none is provided to confirm", async () => {
      const user = await UserModel.create({
        name: "Has Password",
        email: `e2e-delete-${Date.now()}@example.com`,
        password: "Correct@123",
      });

      // createAuthenticatedUser always creates its OWN fresh user (no
      // password) - build a real session/token directly against the
      // password-holding user created above instead.
      const session = await SessionModel.create({
        userId: user._id,
        expiresAt: calculateExpiryDate(config.JWT.REFRESH_TOKEN_EXPIRES_IN),
      });
      const { accessToken } = generateTokenPair(
        user._id,
        session._id.toString()
      );

      const res = await request(app)
        .delete("/api/user/current")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({});

      expect(res.status).toBe(400);

      const stillThere = await UserModel.findById(user._id);
      expect(stillThere).not.toBeNull();
    });

    it("-> 400 and does not delete anything when the caller owns a workspace", async () => {
      await RoleModel.create({ name: Roles.OWNER, permissions: [] });
      const { authHeader, user } = await createAuthenticatedUser();

      const workspace = await WorkspaceModel.create({
        name: "Owned Workspace",
        owner: user._id,
      });
      const ownerRole = await RoleModel.findOne({ name: Roles.OWNER });
      await MemberModel.create({
        userId: user._id,
        workspaceId: workspace._id,
        role: ownerRole!._id,
      });

      const res = await request(app)
        .delete("/api/user/current")
        .set("Authorization", authHeader)
        .send({});

      expect(res.status).toBe(400);

      const stillThere = await UserModel.findById(user._id);
      expect(stillThere).not.toBeNull();
    });

    it("-> 401 with no Authorization header", async () => {
      const res = await request(app).delete("/api/user/current").send({});
      expect(res.status).toBe(401);
    });
  });
});
