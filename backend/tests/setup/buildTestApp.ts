/**
 * SHARED E2E APP BUILDER
 * ------------------------
 * Mounts a single router behind the REAL `authenticate` middleware and the
 * REAL `errorHandler` - the same two pieces every protected router in
 * src/index.ts is wired through. Using this (instead of each e2e file
 * hand-rolling its own minimal error handler / fake `req.user` stub) means
 * e2e tests actually exercise production auth/error wiring, not a stand-in.
 */

import express, { Router } from "express";
import cookieParser from "cookie-parser";
import { authenticate } from "../../src/middlewares/auth.middleware";
import { errorHandler } from "../../src/middlewares/errorHandles.middleware";

export function buildRoutedApp(
  mountPath: string,
  router: Router,
  options: { authenticated?: boolean } = {}
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  if (options.authenticated === false) {
    app.use(mountPath, router);
  } else {
    app.use(mountPath, authenticate, router);
  }

  app.use((req, res) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
    });
  });

  app.use(errorHandler);

  return app;
}
