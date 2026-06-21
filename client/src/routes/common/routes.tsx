import { lazy } from "react";
import { AUTH_ROUTES, BASE_ROUTE, PROTECTED_ROUTES } from "./routePaths";

const SignIn = lazy(() => import("@/page/auth/Sign-in"));
const SignUp = lazy(() => import("@/page/auth/Sign-up"));
const ForgotPassword = lazy(() => import("@/page/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("@/page/auth/ResetPassword"));
const WorkspaceDashboard = lazy(() => import("@/page/workspace/Dashboard"));
const Members = lazy(() => import("@/page/workspace/Members"));
const ProjectDetails = lazy(() => import("@/page/workspace/ProjectDetails"));
const Settings = lazy(() => import("@/page/workspace/Settings"));
const Tasks = lazy(() => import("@/page/workspace/Tasks"));
const AccountSettings = lazy(() => import("@/page/account/AccountSettings"));
const InviteUser = lazy(() => import("@/page/invite/InviteUser"));
const LandingPage = lazy(() => import("@/page/home/landingPage"));
const Unauthorized = lazy(() => import("@/page/errors/Unauthorized"));
const VerifyEmail = lazy(() => import("@/page/auth/VerifyEmail"));
const TermsOfService = lazy(() => import("@/page/legal/TermsOfService"));
const PrivacyPolicy = lazy(() => import("@/page/legal/PrivacyPolicy"));

export const authenticationRoutePaths = [
  { path: AUTH_ROUTES.SIGN_IN, element: <SignIn /> },
  { path: AUTH_ROUTES.SIGN_UP, element: <SignUp /> },
  { path: AUTH_ROUTES.FORGOT_PASSWORD, element: <ForgotPassword /> },
  { path: AUTH_ROUTES.RESET_PASSWORD, element: <ResetPassword /> },
];

export const protectedRoutePaths = [
  { path: PROTECTED_ROUTES.WORKSPACE, element: <WorkspaceDashboard /> },
  { path: PROTECTED_ROUTES.TASKS, element: <Tasks /> },
  { path: PROTECTED_ROUTES.MEMBERS, element: <Members /> },
  { path: PROTECTED_ROUTES.SETTINGS, element: <Settings /> },
  { path: PROTECTED_ROUTES.PROJECT_DETAILS, element: <ProjectDetails /> },
  { path: PROTECTED_ROUTES.ACCOUNT_SETTINGS, element: <AccountSettings /> },
];

export const baseRoutePaths = [
  { path: BASE_ROUTE.HOME, element: <LandingPage /> },
  { path: BASE_ROUTE.INVITE_URL, element: <InviteUser /> },
  { path: BASE_ROUTE.UNAUTHORIZED, element: <Unauthorized /> },
  { path: BASE_ROUTE.VERIFY_EMAIL, element: <VerifyEmail /> },
  { path: BASE_ROUTE.TERMS, element: <TermsOfService /> },
  { path: BASE_ROUTE.PRIVACY, element: <PrivacyPolicy /> },
];
