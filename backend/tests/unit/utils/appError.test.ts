/**
 * UNIT TESTS: appError.ts
 */

import { describe, it, expect } from "vitest";

import {
  AppError,
  HttpException,
  InternalServerException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from "../../../src/utils/appError";
import { HTTPSTATUS } from "../../../src/config/http.config";
import { ErrorCodeEnum } from "../../../src/enums/error-code.enum";

describe("AppError", () => {
  it("defaults to a 500 status code with no errorCode", () => {
    const error = new AppError("Something broke");
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(HTTPSTATUS.INTERNAL_SERVER_ERROR);
    expect(error.errorCode).toBeUndefined();
    expect(error.message).toBe("Something broke");
  });

  it("accepts a custom status code and error code", () => {
    const error = new AppError("Custom", HTTPSTATUS.CONFLICT, "AUTH_NOT_FOUND");
    expect(error.statusCode).toBe(HTTPSTATUS.CONFLICT);
    expect(error.errorCode).toBe("AUTH_NOT_FOUND");
  });
});

describe("HttpException", () => {
  it("uses the given message/status/errorCode as-is", () => {
    const error = new HttpException(
      "Custom Http Error",
      HTTPSTATUS.BAD_GATEWAY
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(HTTPSTATUS.BAD_GATEWAY);
    expect(error.message).toBe("Custom Http Error");
  });
});

describe("InternalServerException", () => {
  it("defaults to 500 + INTERNAL_SERVER_ERROR", () => {
    const error = new InternalServerException();
    expect(error.statusCode).toBe(HTTPSTATUS.INTERNAL_SERVER_ERROR);
    expect(error.errorCode).toBe(ErrorCodeEnum.INTERNAL_SERVER_ERROR);
    expect(error.message).toBe("Internal Server Error");
  });

  it("accepts a custom message and errorCode", () => {
    const error = new InternalServerException("Custom", "AUTH_NOT_FOUND");
    expect(error.message).toBe("Custom");
    expect(error.errorCode).toBe("AUTH_NOT_FOUND");
  });
});

describe("NotFoundException", () => {
  it("defaults to 404 + RESOURCE_NOT_FOUND", () => {
    const error = new NotFoundException();
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(HTTPSTATUS.NOT_FOUND);
    expect(error.errorCode).toBe(ErrorCodeEnum.RESOURCE_NOT_FOUND);
    expect(error.message).toBe("Resource not found");
  });
});

describe("BadRequestException", () => {
  it("defaults to 400 + VALIDATION_ERROR", () => {
    const error = new BadRequestException();
    expect(error.statusCode).toBe(HTTPSTATUS.BAD_REQUEST);
    expect(error.errorCode).toBe(ErrorCodeEnum.VALIDATION_ERROR);
    expect(error.message).toBe("Bad Request");
  });
});

describe("UnauthorizedException", () => {
  it("defaults to 401 + ACCESS_UNAUTHORIZED", () => {
    const error = new UnauthorizedException();
    expect(error.statusCode).toBe(HTTPSTATUS.UNAUTHORIZED);
    expect(error.errorCode).toBe(ErrorCodeEnum.ACCESS_UNAUTHORIZED);
    expect(error.message).toBe("Unauthorized Access");
  });

  it("accepts a custom message and errorCode override", () => {
    const error = new UnauthorizedException("Nope", "AUTH_TOKEN_NOT_FOUND");
    expect(error.message).toBe("Nope");
    expect(error.errorCode).toBe("AUTH_TOKEN_NOT_FOUND");
  });
});
