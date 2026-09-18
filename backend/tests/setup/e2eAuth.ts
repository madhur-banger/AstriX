/**
 * Registers + logs in a real user through the real HTTP routes (not a
 * shortcut through the service layer) so e2e tests exercise the exact bearer
 * token production issues. Mirrors tests/setup/e2eAuth.ts's role in the
 * Mongo suite.
 */
import request from "supertest";
import { Express } from "express";

let counter = 0;

export const registerAndLogin = async (
  app: Express,
  overrides: Partial<{ name: string; email: string; password: string }> = {}
) => {
  counter += 1;
  const email = overrides.email ?? `e2e-user-${Date.now()}-${counter}@example.com`;
  const password = overrides.password ?? "Password1!";
  const name = overrides.name ?? "E2E User";

  await request(app).post("/api/auth/register").send({ name, email, password });

  const loginRes = await request(app).post("/api/auth/login").send({ email, password });

  return {
    userId: loginRes.body.user.id as string,
    email,
    password,
    accessToken: loginRes.body.access_token as string,
    authHeader: `Bearer ${loginRes.body.access_token}`,
    currentWorkspaceId: loginRes.body.user.currentWorkspaceId as string,
  };
};
