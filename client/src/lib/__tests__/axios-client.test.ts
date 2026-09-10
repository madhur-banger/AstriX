import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  AxiosError,
  AxiosRequestHeaders,
  InternalAxiosRequestConfig,
} from "axios";

type MockAxiosInstance = ((
  config: InternalAxiosRequestConfig
) => Promise<unknown>) & {
  interceptors: {
    request: {
      use: (
        fn: (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig
      ) => void;
    };
    response: {
      use: (
        onFulfilled: (r: unknown) => unknown,
        onRejected: (error: AxiosError) => Promise<unknown>
      ) => void;
    };
  };
};

// The module under test wires interceptors onto whatever axios.create()
// returns, and also calls axios.post() directly to hit /auth/refresh. Both
// come from the same default `axios` import, so both are mocked here - the
// interceptor callbacks themselves are captured off the mock's call args so
// tests can invoke them directly instead of driving a real HTTP round trip.
//
// Everything the vi.mock factory below reads or assigns has to come from
// vi.hoisted: the factory (and the side-effecting `import "@/lib/axios-client"`
// further down, which calls axios.create() eagerly at module-eval time) both
// run before any of this file's own top-level `let`/`const` statements would
// otherwise have executed, which is a temporal-dead-zone ReferenceError
// waiting to happen for anything declared the normal way.
const hoisted = vi.hoisted(() => {
  const noopRequest = (config: unknown) => config;
  const noopResponseError = (error: unknown) => Promise.reject(error);
  return {
    mockPost: vi.fn(),
    interceptors: {
      request: noopRequest as (config: unknown) => unknown,
      responseError: noopResponseError as (error: unknown) => Promise<unknown>,
    },
  };
});
const mockPost = hoisted.mockPost;

vi.mock("axios", () => {
  const create = vi.fn((): MockAxiosInstance => {
    const instance = vi.fn((config: InternalAxiosRequestConfig) =>
      Promise.resolve({ data: { retried: true }, config })
    ) as unknown as MockAxiosInstance;
    instance.interceptors = {
      request: {
        use: (fn) => {
          hoisted.interceptors.request = fn as (config: unknown) => unknown;
        },
      },
      response: {
        use: (_onFulfilled, onRejected) => {
          hoisted.interceptors.responseError = onRejected as (
            error: unknown
          ) => Promise<unknown>;
        },
      },
    };
    return instance;
  });

  return {
    default: { create, post: hoisted.mockPost },
  };
});

const requestInterceptor = (config: InternalAxiosRequestConfig) =>
  hoisted.interceptors.request(config) as InternalAxiosRequestConfig;
const responseErrorInterceptor = (error: AxiosError) =>
  hoisted.interceptors.responseError(error);

vi.mock("@/lib/base-url", () => ({ baseURL: "http://api.test" }));

import { useStoreBase } from "@/store/store";
// Static, one-time import: the interceptors are registered as a side effect
// of loading this module. `useStoreBase` above and the store this module
// reads from must be the SAME module instance, which a per-test
// vi.resetModules()+dynamic-import would break (it would hand the freshly
// re-imported axios-client.ts a different store instance than the one this
// test file's `useStoreBase` import points at).
import "@/lib/axios-client";

const buildError = (overrides: {
  status?: number;
  url?: string;
  retried?: boolean;
}): AxiosError =>
  ({
    isAxiosError: true,
    response: overrides.status
      ? { status: overrides.status, data: {} }
      : undefined,
    config: {
      url: overrides.url ?? "/task/1",
      _retry: overrides.retried ?? false,
      headers: {} as AxiosRequestHeaders,
    },
  }) as unknown as AxiosError;

describe("axios-client", () => {
  beforeEach(() => {
    mockPost.mockReset();
    useStoreBase.getState().clearAuth();
  });

  it("attaches the Authorization header from the store when a request goes out", () => {
    // #given a token in the store
    useStoreBase.getState().setAccessToken("token-abc");

    // #when the request interceptor runs
    const config = requestInterceptor({ headers: {} as AxiosRequestHeaders });

    // #then the header carries the current access token
    expect(config.headers["Authorization"]).toBe("Bearer token-abc");
  });

  it("does not add an Authorization header when there is no token", () => {
    // #given no token in the store
    // #when the request interceptor runs
    const config = requestInterceptor({ headers: {} as AxiosRequestHeaders });

    // #then no Authorization header is added
    expect(config.headers["Authorization"]).toBeUndefined();
  });

  it("passes through non-401 errors without touching the refresh flow", async () => {
    // #given a 500 error
    const error = buildError({ status: 500 });

    // #when the response interceptor handles it
    await expect(responseErrorInterceptor(error)).rejects.toMatchObject({
      errorCode: "UNKNOWN_ERROR",
    });

    // #then no refresh was attempted
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("on a 401, refreshes once and retries the original request with the new token", async () => {
    // #given a 401 on a non-refresh endpoint, and a refresh call that succeeds
    mockPost.mockResolvedValue({ data: { access_token: "new-token" } });
    const error = buildError({ status: 401, url: "/task/1" });

    // #when the response interceptor handles it
    await responseErrorInterceptor(error);

    // #then exactly one refresh call was made, and the store now holds the
    // new access token
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      "http://api.test/auth/refresh",
      {},
      { withCredentials: true }
    );
    expect(useStoreBase.getState().accessToken).toBe("new-token");
  });

  it("queues concurrent 401s behind a single in-flight refresh instead of firing one refresh per request", async () => {
    // #given two requests that both 401 while a refresh is already pending
    let resolveRefresh!: (value: { data: { access_token: string } }) => void;
    mockPost.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const errorA = buildError({ status: 401, url: "/task/1" });
    const errorB = buildError({ status: 401, url: "/task/2" });

    // #when both requests hit the interceptor before the refresh resolves
    const promiseA = responseErrorInterceptor(errorA);
    const promiseB = responseErrorInterceptor(errorB);

    // #then only ONE refresh call was made for both requests
    expect(mockPost).toHaveBeenCalledTimes(1);

    // #and once the single refresh resolves, both queued requests retry
    resolveRefresh({ data: { access_token: "shared-new-token" } });
    await Promise.all([promiseA, promiseB]);
    expect(useStoreBase.getState().accessToken).toBe("shared-new-token");
  });

  it("does not retry the refresh endpoint itself on a 401 - clears auth instead", async () => {
    // #given the /auth/refresh call itself comes back 401
    const error = buildError({ status: 401, url: "/auth/refresh" });
    useStoreBase.getState().setAccessToken("stale-token");

    // #when the response interceptor handles it
    await expect(responseErrorInterceptor(error)).rejects.toBeDefined();

    // #then no refresh attempt loop happens and local auth state is cleared
    expect(mockPost).not.toHaveBeenCalled();
    expect(useStoreBase.getState().accessToken).toBeNull();
  });

  it("clears auth and does not retry indefinitely when the refresh call itself fails", async () => {
    // #given a 401 whose refresh attempt then fails
    mockPost.mockRejectedValue(new Error("refresh failed"));
    const error = buildError({ status: 401, url: "/task/1" });
    useStoreBase.getState().setAccessToken("stale-token");

    // #when the response interceptor handles it
    await expect(responseErrorInterceptor(error)).rejects.toThrow(
      "refresh failed"
    );

    // #then auth state is cleared and there's no further retry
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(useStoreBase.getState().accessToken).toBeNull();
  });

  it("does not attempt a second refresh for a request already marked as retried", async () => {
    // #given a request that has already been retried once
    const error = buildError({ status: 401, url: "/task/1", retried: true });

    // #when the response interceptor handles it again
    await expect(responseErrorInterceptor(error)).rejects.toBeDefined();

    // #then no refresh is attempted a second time for this request
    expect(mockPost).not.toHaveBeenCalled();
  });
});
