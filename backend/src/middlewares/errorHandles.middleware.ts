import { ErrorRequestHandler, Response } from "express";
import { HTTPSTATUS } from "../config/http.config";
import { AppError } from "../utils/appError";
import { z, ZodError } from "zod";
import { ErrorCodeEnum } from "../enums/error-code.enum";
import { config } from "../config/app.config";
import { logger } from "../utils/logger";

const formatZodError = (res: Response, error: z.ZodError) => {
  const errors = error?.issues?.map((err) => ({
    field: err.path.join("."),
    message: err.message,
  }));
  return res.status(HTTPSTATUS.BAD_REQUEST).json({
    message: "Validation failed",
    errors: errors,
    errorCode: ErrorCodeEnum.VALIDATION_ERROR,
  });
};

// `: any` on the return type is deliberate: Express types ErrorRequestHandler
// as returning void, but every branch below `return`s the Response object
// (the conventional way to guarantee a single terminal response per branch).
// `error` is likewise untyped by Express itself - anything can be thrown.
export const errorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  // Express only recognizes error-handling middleware by its 4-argument
  // arity - `next` must stay in the signature even though it's unused.
  _next
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above: Express types this handler as returning void, but every branch returns the Response object.
): any => {
  // req.log (attached by pino-http, wired in app.ts) carries this
  // request's correlation id automatically - fall back to the base logger
  // for any app assembly that doesn't mount pino-http (e.g. the lighter
  // test-only app builders under tests/setup/).
  (req.log ?? logger).error({ err: error, path: req.path }, "Request failed");

  if (error instanceof SyntaxError) {
    return res.status(HTTPSTATUS.BAD_REQUEST).json({
      message: "Invalid JSON format. Please check your request body.",
    });
  }

  // Thrown by express.json()'s underlying body-parser when a request body
  // exceeds the configured size limit - without this branch it falls
  // through to the generic 500 handler below, which is wrong (this is a
  // client error) and doesn't set the correct 413 status.
  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(HTTPSTATUS.PAYLOAD_TOO_LARGE).json({
      message: "Request body is too large.",
    });
  }

  if (error instanceof ZodError) {
    return formatZodError(res, error);
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      message: error.message,
      errorCode: error.errorCode,
    });
  }

  return res.status(HTTPSTATUS.INTERNAL_SERVER_ERROR).json({
    message: "Internal Server Error",
    error:
      config.NODE_ENV === "production"
        ? "Unknown error occurred"
        : error?.message || "Unknow error occurred",
  });
};
