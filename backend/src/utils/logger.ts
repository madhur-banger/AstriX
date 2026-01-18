import pino from "pino";
import { config } from "../config/app.config";

// JSON structured logs everywhere (not just "production") - this is what
// ships to CloudWatch from the ECS deployment, and JSON in dev too means
// local logs actually match what you'd see there. Silenced during tests so
// the (expected) error-path logs exercised by the test suite don't spam
// the runner's output.
export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : "info",
});
