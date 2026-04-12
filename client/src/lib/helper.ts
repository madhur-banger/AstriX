import { isAxiosError } from "axios";

// Narrows an unknown mutation/query error down to a user-facing message,
// preferring the backend's own `{ message }` response body (set by
// errorHandles.middleware.ts) over axios's generic "Request failed with
// status code N" text.
export const getErrorMessage = (
  error: unknown,
  fallback = "Something went wrong"
): string => {
  if (isAxiosError<{ message?: string }>(error)) {
    return error.response?.data?.message || error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
};

// A `returnUrl` arrives from the query string, so it is attacker-controlled.
// Only same-origin relative paths are safe to hand to navigate(): anything
// else ("//evil.com", "https://evil.com", "javascript:...") would turn the
// sign-in page into an open redirect.
const SAFE_RELATIVE_PATH = /^\/(?!\/)/;

export const getSafeReturnUrl = (returnUrl: string | null): string | null => {
  if (!returnUrl) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(returnUrl);
  } catch {
    return null;
  }

  // "/\evil.com" is normalised to "//evil.com" by some browsers.
  if (!SAFE_RELATIVE_PATH.test(decoded) || decoded.startsWith("/\\")) {
    return null;
  }

  return decoded;
};

//THE UPDATED ONE BECAUSE OF THE FILTERS ->  Take Note ->
export const transformOptions = (
  options: string[],
  iconMap?: Record<string, React.ComponentType<{ className?: string }>>
) =>
  options.map((value) => ({
    label: value
      .replace(/_/g, " ")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    value: value,
    icon: iconMap ? iconMap[value] : undefined,
  }));

export const transformStatusEnum = (status: string): string => {
  return status.replace(/_/g, " ");
};

export const formatStatusToEnum = (status: string): string => {
  return status.toUpperCase().replace(/\s+/g, "_");
};

export const getAvatarColor = (initials: string): string => {
  const colors = [
    "bg-red-500 text-white",
    "bg-blue-500 text-white",
    "bg-green-500 text-white",
    "bg-yellow-500 text-black",
    "bg-purple-500 text-white",
    "bg-pink-500 text-white",
    "bg-teal-500 text-white",
    "bg-orange-500 text-black",
    "bg-gray-500 text-white",
  ];

  // Simple hash to map initials to a color index
  const hash = initials
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

  return colors[hash % colors.length];
};

export const getAvatarFallbackText = (name: string) => {
  if (!name) return "NA";
  const initials = name
    .split(" ")
    .map((n) => n.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2); // Ensure only two initials
  return initials || "NA";
};
