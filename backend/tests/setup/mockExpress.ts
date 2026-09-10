/**
 * FAKE EXPRESS REQUEST / RESPONSE HELPER
 * ---------------------------------------
 * When unit-testing a CONTROLLER (not a full HTTP call via supertest), you
 * don't have a real `req`/`res` from Express - there's no actual HTTP server
 * involved. So we build minimal fake stand-ins that behave just enough like
 * the real thing for your controller code to run.
 *
 * The trick that trips people up: `res.status(200).json({...})` is a CHAIN -
 * `res.status()` must RETURN something that has a `.json()` method on it.
 * So our fake `res.status` mock returns `res` itself, letting the chain work.
 * The same applies to `res.cookie(...)`, which Express also lets you chain.
 *
 * Every method is a `vi.fn()` (a "spy") so that in your test's Assert step
 * you can check things like:
 *   expect(res.status).toHaveBeenCalledWith(201)
 *   expect(res.cookie).toHaveBeenCalledWith("refreshToken", "abc", expect.any(Object))
 *
 * EXTENDED FOR AUTH: auth controllers also read `req.cookies`, `req.headers`,
 * `req.ip`, and call `res.cookie()`, `res.clearCookie()`, and `res.redirect()`
 * - none of which the original workspace controllers needed. This file is
 * SHARED across all features, so we add support here once and every future
 * controller test (task, member, project, auth) can use it.
 */

import { vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

interface MockReqOptions {
  body?: Record<string, any>;
  params?: Record<string, any>;
  query?: Record<string, any>;
  user?: Record<string, any> | null; // populated by your auth middleware in real life
  cookies?: Record<string, any>;
  headers?: Record<string, any>;
  ip?: string;
}

export function createMockReqRes(options: MockReqOptions = {}) {
  const req = {
    body: options.body ?? {},
    params: options.params ?? {},
    query: options.query ?? {},
    // Pass `user: null` explicitly (not just omitting it) to simulate an
    // UNauthenticated request - the default below assumes authenticated,
    // since most controllers you'll test expect req.user to exist.
    user:
      options.user === null
        ? undefined
        : (options.user ?? { _id: "mock-user-id" }),
    cookies: options.cookies ?? {},
    headers: options.headers ?? { "user-agent": "vitest-test-agent" },
    ip: options.ip ?? "127.0.0.1",
  } as unknown as Request;

  const res = {} as unknown as Response;

  // Every one of these returns `res` itself so chains like
  // res.status(200).cookie(...).json(...) keep working, exactly like real Express.
  (res as any).status = vi.fn().mockReturnValue(res);
  (res as any).json = vi.fn().mockReturnValue(res);
  (res as any).send = vi.fn().mockReturnValue(res);
  (res as any).cookie = vi.fn().mockReturnValue(res);
  (res as any).clearCookie = vi.fn().mockReturnValue(res);
  (res as any).redirect = vi.fn().mockReturnValue(res);

  const next = vi.fn() as unknown as NextFunction;

  return { req, res, next };
}
