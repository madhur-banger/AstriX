import { Logger } from "pino";

declare global {
  namespace Express {
    interface Request {
      // Attached by the auth middleware (src/middlewares/auth.middleware.ts)
      // once a bearer token is verified against a real Postgres user + Redis
      // session - a plain id pair, not an ORM document.
      user?: { id: string; sessionId: string };
      // Attached by pino-http (see index.ts) - a per-request child
      // logger carrying this request's correlation id. Optional
      // because app assemblies that don't mount pino-http (some test
      // harnesses) won't have it.
      log?: Logger;
    }
  }
}

declare module "swagger-ui-express";

declare module "swagger-jsdoc";
