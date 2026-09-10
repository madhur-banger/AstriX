// The access token is a JWT signed by the backend with `{ userId, sessionId }`
// (see backend/src/utils/jwt.ts). Reading the sessionId claim client-side is
// only ever used for UI decisions - "is this row the device I'm on?" - never
// for authorisation, so the signature deliberately isn't verified here.
type AccessTokenClaims = {
  userId?: unknown;
  sessionId?: unknown;
};

const decodeBase64Url = (segment: string): string => {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  return atob(base64 + "=".repeat(padding));
};

export const getSessionIdFromAccessToken = (
  accessToken: string | null
): string | null => {
  if (!accessToken) return null;

  const payloadSegment = accessToken.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const claims = JSON.parse(
      decodeBase64Url(payloadSegment)
    ) as AccessTokenClaims | null;
    return typeof claims?.sessionId === "string" ? claims.sessionId : null;
  } catch {
    return null;
  }
};
