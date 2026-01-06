It is ordered by **risk first**, then **correctness**, then **hardening**.

---

# 🔐 API Security TODO

## 1. Authentication & Token Safety (Critical)

* [ ] Remove access tokens from URL query parameters (OAuth callback)
* [ ] Switch Google OAuth callback to:

  * [ ] HttpOnly + Secure cookies **OR**
  * [ ] Authorization code → token exchange
* [ ] Stop mutating `req` object for passing JWTs between middleware
* [ ] Separate JWT secret from sign options (prevent undefined secrets)
* [ ] Add `issuer (iss)` claim to all JWTs
* [ ] Enforce `issuer` validation in JWT strategy
* [ ] Add `tokenVersion` to JWT payload and User model
* [ ] Reject JWTs when `tokenVersion` mismatches (forced logout support)
* [ ] Define short-lived access tokens (≤ 15 min)

---

## 2. OAuth (Google) Hardening

* [ ] Implement OAuth `state` parameter and validation (CSRF protection)
* [ ] Prevent account takeover by:

  * [ ] Matching Google logins on `(provider, providerId)`
  * [ ] Disallowing email-only auto-linking unless verified
* [ ] Handle missing or unverified Google email safely
* [ ] Persist OAuth provider metadata (issued_at, provider scopes)

---

## 3. Session & Logout Semantics

* [ ] Decide single auth model:

  * [ ] Stateless JWT **OR**
  * [ ] Cookie-based session auth
* [ ] Implement real logout by:

  * [ ] Incrementing `tokenVersion` **OR**
  * [ ] Token blacklist / revocation store
* [ ] Invalidate tokens on:

  * [ ] Password change
  * [ ] Account provider change
  * [ ] Manual logout
* [ ] Add refresh token rotation (if JWT-based)

---

## 4. Password & Credential Security

* [ ] Enforce strong password policy (length, complexity)
* [ ] Add login rate limiting (IP + account-based)
* [ ] Add account lockout / cooldown after repeated failures
* [ ] Add email verification before enabling login
* [ ] Version password hashes to allow future rehashing
* [ ] Ensure constant-time password comparisons

---

## 5. API Access Control

* [ ] Never return raw database models in auth responses
* [ ] Introduce UserDTO / AuthResponseDTO
* [ ] Validate workspace membership on every protected route
* [ ] Enforce role-based authorization (RBAC) consistently
* [ ] Add explicit authorization guards (not implicit checks)

---

## 6. Transport & Headers

* [ ] Enable `helmet` for security headers
* [ ] Enforce HTTPS in production
* [ ] Configure strict CORS per environment (no `*`)
* [ ] Set `SameSite`, `Secure`, `HttpOnly` flags on cookies
* [ ] Add Content Security Policy (CSP)

---

## 7. Token & Error Handling

* [ ] Differentiate JWT errors:

  * [ ] Expired token
  * [ ] Invalid signature
  * [ ] Revoked token
* [ ] Avoid leaking auth failure reasons in responses
* [ ] Normalize auth error responses
* [ ] Log auth failures securely (no tokens in logs)

---

## 8. Observability & Auditing

* [ ] Log authentication events (login, logout, refresh)
* [ ] Log OAuth account linking events
* [ ] Track suspicious activity (failed logins, token reuse)
* [ ] Add audit trail for permission changes
* [ ] Add metrics for auth success/failure rates

---

## 9. Dependency & Configuration Safety

* [ ] Validate all auth-related env vars at startup
* [ ] Rotate JWT secrets safely
* [ ] Pin and audit auth-related dependencies
* [ ] Disable debug logs in production
* [ ] Prevent stack traces from leaking to clients

---

## 10. Testing & Verification

* [ ] Unit test JWT signing & verification
* [ ] Test OAuth CSRF scenarios
* [ ] Test token revocation flows
* [ ] Test expired and malformed tokens
* [ ] Add auth regression tests

---

## 11. Documentation

* [ ] Document auth flows (email, Google)
* [ ] Document token lifecycle
* [ ] Document logout semantics
* [ ] Document security assumptions and threat model

---

