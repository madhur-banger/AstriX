// client/src/store/store.ts
// ============================================
// ZUSTAND STORE - Updated for Secure Auth
// ============================================

import { create, StateCreator } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import createSelectors from "./selector";

/**
 * SECURITY NOTE: NO PERSISTENCE!
 * 
 * We deliberately DO NOT persist the access token to localStorage/sessionStorage.
 * 
 * Why?
 * 1. localStorage/sessionStorage can be accessed by JavaScript
 * 2. XSS attacks can steal tokens from storage
 * 3. Access tokens should be short-lived and refreshable
 * 
 * How does this work?
 * - Access token lives in memory (Zustand state)
 * - When user refreshes page, access token is gone
 * - Frontend calls /auth/refresh to get new access token
 * - Refresh token is in httpOnly cookie (sent automatically)
 * - This is the most secure approach for SPAs!
 */

// ============================================
// USER TYPE
// ============================================

interface User {
  _id: string;
  email: string;
  name: string;
  profilePicture: string | null;
  currentWorkspace: {
    _id: string;
    name: string;
    owner: string;
    inviteCode: string;
  } | null;
}

// ============================================
// AUTH STATE
// ============================================

type AuthState = {
  // Access token - stored in memory only
  accessToken: string | null;
  
  // User data - also in memory
  user: User | null;
  
  // Loading state for initial auth check
  isAuthChecking: boolean;
  
  // Whether we've done initial auth check
  isInitialized: boolean;
  
  // Actions
  setAccessToken: (token: string) => void;
  setUser: (user: User) => void;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  setAuthChecking: (checking: boolean) => void;
  setInitialized: (initialized: boolean) => void;
};

// ============================================
// AUTH SLICE
// ============================================

const createAuthSlice: StateCreator<
  AuthState,
  [["zustand/immer", never], ["zustand/devtools", never]]
> = (set) => ({
  accessToken: null,
  user: null,
  isAuthChecking: true, // Start as true, will be set false after check
  isInitialized: false,

  setAccessToken: (token) =>
    set(
      (state) => {
        state.accessToken = token;
      },
      false,
      "setAccessToken"
    ),

  setUser: (user) =>
    set(
      (state) => {
        state.user = user;
      },
      false,
      "setUser"
    ),

  setAuth: (token, user) =>
    set(
      (state) => {
        state.accessToken = token;
        state.user = user;
        state.isAuthChecking = false;
        state.isInitialized = true;
      },
      false,
      "setAuth"
    ),

  clearAuth: () =>
    set(
      (state) => {
        state.accessToken = null;
        state.user = null;
        state.isAuthChecking = false;
        state.isInitialized = true;
      },
      false,
      "clearAuth"
    ),

  setAuthChecking: (checking) =>
    set(
      (state) => {
        state.isAuthChecking = checking;
      },
      false,
      "setAuthChecking"
    ),

  setInitialized: (initialized) =>
    set(
      (state) => {
        state.isInitialized = initialized;
      },
      false,
      "setInitialized"
    ),
});

// ============================================
// STORE CREATION
// ============================================

type StoreType = AuthState;

export const useStoreBase = create<StoreType>()(
  devtools(
    immer((...a) => ({
      ...createAuthSlice(...a),
    })),
    {
      name: "auth-store",
      // Only enable devtools in development
      enabled: process.env.NODE_ENV === "development",
    }
  )
  // NOTE: No persist middleware! This is intentional for security.
);

export const useStore = createSelectors(useStoreBase);

// ============================================
// SELECTOR HOOKS (for convenience)
// ============================================

export const useAccessToken = () => useStore((s) => s.accessToken);
export const useUser = () => useStore((s) => s.user);
export const useIsAuthenticated = () => useStore((s) => !!s.accessToken);
export const useIsAuthChecking = () => useStore((s) => s.isAuthChecking);
export const useIsInitialized = () => useStore((s) => s.isInitialized);