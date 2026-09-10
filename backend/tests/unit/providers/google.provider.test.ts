/**
 * UNIT TESTS: google.provider.ts
 * -----------------------------------
 * Mocks `axios` entirely - a real call here would hit Google's actual OAuth
 * endpoints, which is a hard "always mock this" boundary (slow, flaky,
 * requires a real OAuth code we don't have).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";

import {
  getGoogleAuthorizationUrl,
  exchangeGoogleCodeForProfile,
  generateGoogleOAuthState,
} from "../../../src/providers/google.provider";
import { UnauthorizedException } from "../../../src/utils/appError";
import { config } from "../../../src/config/app.config";

vi.mock("axios");

describe("getGoogleAuthorizationUrl", () => {
  it("builds the Google OAuth URL with the expected query params", () => {
    const url = new URL(getGoogleAuthorizationUrl("state-value-123"));

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(url.searchParams.get("client_id")).toBe(config.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      config.GOOGLE_CALLBACK_URL
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("profile email");
    expect(url.searchParams.get("state")).toBe("state-value-123");
  });
});

describe("generateGoogleOAuthState", () => {
  it("returns a 64-character hex string", () => {
    const state = generateGoogleOAuthState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on each call", () => {
    expect(generateGoogleOAuthState()).not.toBe(generateGoogleOAuthState());
  });
});

describe("exchangeGoogleCodeForProfile", () => {
  beforeEach(() => vi.resetAllMocks());

  it("exchanges the code for a token, fetches the profile, and returns a normalized OAuthProfile", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: "google-access-token" },
    });
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        sub: "google-sub-123",
        email: "user@example.com",
        email_verified: true,
        name: "Google User",
        picture: "https://example.com/pic.jpg",
      },
    });

    const profile = await exchangeGoogleCodeForProfile("auth-code");

    expect(axios.post).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        code: "auth-code",
        grant_type: "authorization_code",
      }),
      expect.anything()
    );
    expect(axios.get).toHaveBeenCalledWith(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: "Bearer google-access-token" } }
    );
    expect(profile).toEqual({
      provider: "GOOGLE",
      providerId: "google-sub-123",
      email: "user@example.com",
      name: "Google User",
      picture: "https://example.com/pic.jpg",
      emailVerified: true,
    });
  });

  it("treats a missing email_verified field as NOT verified (conservative default)", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: "google-access-token" },
    });
    vi.mocked(axios.get).mockResolvedValue({
      data: {
        sub: "google-sub-456",
        email: "unverified@example.com",
        name: "Unverified User",
        // email_verified intentionally omitted
      },
    });

    const profile = await exchangeGoogleCodeForProfile("auth-code");

    expect(profile.emailVerified).toBe(false);
  });

  it("throws UnauthorizedException when the token exchange fails", async () => {
    vi.mocked(axios.post).mockRejectedValue(
      new Error("Google rejected the code")
    );

    await expect(exchangeGoogleCodeForProfile("bad-code")).rejects.toThrow(
      UnauthorizedException
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedException when the profile fetch fails", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { access_token: "token" },
    });
    vi.mocked(axios.get).mockRejectedValue(new Error("Profile fetch failed"));

    await expect(exchangeGoogleCodeForProfile("code")).rejects.toThrow(
      "Failed to authenticate with Google"
    );
  });
});
