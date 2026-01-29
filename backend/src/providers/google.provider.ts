import axios from "axios";
import crypto from "crypto";
import { config } from "../config/app.config";
import { UnauthorizedException } from "../utils/appError";

export interface OAuthProfile {
  provider: string;
  providerId: string;
  email: string;
  name: string;
  picture?: string;
  // Whether Google itself has confirmed the user controls this email
  // address. Used to gate auto-linking to a pre-existing account (see
  // loginOrCreateAccountService) - never trust an unverified email for
  // that decision.
  emailVerified: boolean;
}

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

interface GoogleProfileResponse {
  sub: string;
  email: string;
  email_verified?: boolean;
  name: string;
  picture?: string;
}

export const getGoogleAuthorizationUrl = (state: string): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");

  url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.GOOGLE_CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "profile email");
  url.searchParams.set("state", state);

  return url.toString();
};

export const exchangeGoogleCodeForProfile = async (
  code: string
): Promise<OAuthProfile> => {
  try {
    const tokenResponse = await axios.post<GoogleTokenResponse>(
      "https://oauth2.googleapis.com/token",
      {
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: config.GOOGLE_CALLBACK_URL,
        grant_type: "authorization_code",
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const { access_token } = tokenResponse.data;

    const profileResponse = await axios.get<GoogleProfileResponse>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const googleProfile = profileResponse.data;

    return {
      provider: "GOOGLE",
      providerId: googleProfile.sub,
      email: googleProfile.email,
      name: googleProfile.name,
      picture: googleProfile.picture,
      // Conservative default: treat a missing field as NOT verified rather
      // than assuming Google confirmed it.
      emailVerified: googleProfile.email_verified === true,
    };
  } catch {
    throw new UnauthorizedException("Failed to authenticate with Google");
  }
};

export const generateGoogleOAuthState = (): string => {
  return crypto.randomBytes(32).toString("hex");
};
