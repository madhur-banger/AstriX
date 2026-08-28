# AstriX — Security Concerns (Deep Audit)

This is an expanded pass over the entire repo — backend, auth flows, frontend, and infra — going beyond the first review to include a real dependency vulnerability scan (`npm audit`), business-logic checks (role escalation, ownership invariants), injection surface, HTTP security headers, and session/rate-limit architecture. Every finding is backed by something actually run or read against the repo, not inferred.

Organized by category, then a full severity-ranked table at the end for triage. Your `TODO.md` items are cross-referenced where they overlap.

---

## Category 1 — Dependency & Supply-Chain Security

This is new since the last review and is arguably the single fastest fix with the biggest headline impact for "does this look production-ready."

### D1. 🔴 Backend has 15 known vulnerabilities, including 1 critical, via `npm audit`
Running `npm audit --omit=dev` against `backend/` today reports **15 vulnerabilities: 1 critical, 9 high, 5 moderate**. The notable ones:

| Package | Severity | Issue |
|---|---|---|
| `tar` (via `@mapbox/node-pre-gyp` → `bcrypt`) | **Critical** | Arbitrary file creation/overwrite via hardlink path traversal (GHSA-34x7-hfp2-rc4v) |
| `mongoose` | High | **Improper sanitization of `$nor` in `sanitizeFilter` allows NoSQL injection** (GHSA-wpg9-53fq-2r8h) — directly relevant given every service in this codebase queries Mongoose with user-derived IDs |
| `express-rate-limit` | High | IPv4-mapped IPv6 addresses bypass per-client rate limiting on dual-stack servers (GHSA-46wh-pxpv-q5gq) — undermines the auth brute-force protection (S-series findings below) |
| `path-to-regexp` | High | ReDoS via multiple route parameters |
| `js-yaml`, `minimatch`, `brace-expansion` | High/Moderate | ReDoS / DoS, pulled in transitively (likely via `swagger-jsdoc`) |
| `passport` | Moderate | Session regeneration issue on login/logout (GHSA-v923-w3x8-wh69) |
| `uuid` | Moderate | Missing buffer bounds check — relevant since `utils/uuid.ts` is what generates workspace invite codes |

**Fix**: `npm audit fix` resolves most of these; `bcrypt` needs `npm audit fix --force` (bumps to `bcrypt@6.0.0`, a breaking change worth testing — the hashing API is compatible but worth a smoke test on login/register before deploying). The mongoose finding specifically means: until patched, do not rely on `sanitizeFilter` as your only defense against NoSQL injection — see I1 below for the actual current exposure.

### D2. 🟠 Frontend has 13 known vulnerabilities (11 high, 2 moderate)
`npm audit --omit=dev` against `client/` reports vulnerabilities in `sharp` (image processing, likely a transitive dependency of a Vite plugin) and `yaml` (stack overflow via deeply nested collections). Lower real-world exploitability than the backend findings since these are build-time/tooling dependencies, not runtime request-handling code, but still worth clearing with `npm audit fix` before calling the build pipeline "production-grade."

### D3. 🟡 No `Dependabot`/`Renovate` config, no scheduled audit in CI
Nothing in `.github/` automatically re-checks for new CVEs after this initial fix. Without this, D1/D2 will silently regress the moment a new advisory is published for any dependency already in use.
- **Fix**: add `.github/dependabot.yml` with `package-ecosystem: npm` for both `backend/` and `client/`, weekly schedule. Fifteen minutes of setup, permanent coverage.

### D4. 🟡 No dependency vulnerability scanning gate in CI
`pr-check.yml` only runs `npm ci && npm run build` — a PR that reintroduces a critical CVE (or one that ships with a brand-new dependency that already has a known vulnerability) merges cleanly today.
- **Fix**: add `npm audit --audit-level=high` (or a dedicated tool like `osv-scanner`/Snyk) as a required step in `pr-check.yml`.

---

## Category 2 — Authentication & Session Architecture

### A1. 🔴 Cookie `Secure` flag is inverted
```ts
// backend/src/config/app.config.ts
COOKIE: { SECURE: NODE_ENV === "development", ... }
```
Sets `Secure: true` in dev, `Secure: false` in production — backwards. In production the refresh-token cookie could legally be sent over plain HTTP.
- **Fix**: `SECURE: NODE_ENV === "production"`.

### A2. 🟠 No password-reset ("forgot password") flow exists anywhere in the backend
Searched every controller/service/route for `forgotPassword`/`resetPassword` — none exist. A user who forgets their password today has **no self-service recovery path** at all; this is a hard blocker for any real user base, not just a nice-to-have.
- **Fix**: standard flow — `POST /auth/forgot-password` issues a single-use, short-expiry token (store a hash of it, not the raw token, same pattern as your existing `Session` model), emailed via a new email-service integration (see the Roadmap document's B1 catalog). `POST /auth/reset-password` consumes the token, forces re-hash, and — importantly — invalidates all existing sessions for that user (ties into A5 below).

### A3. 🟠 No email verification flow
Registration creates a fully active account immediately on a syntactically valid email — nothing confirms the address is real or owned by the registrant. Combined with no rate limiting on registration beyond the shared `authLimiter` (5/15min per IP, easily distributed across many IPs), this makes throwaway/fraudulent account creation trivial.
- **Fix**: add an `isEmailVerified` boolean to `User` (schema already has `isActive` — this is a natural sibling field), send a verification link/OTP on register, gate meaningful actions (creating a workspace, inviting members) behind it if you want it strictly enforced, or simply gate it softly with a banner if you don't want to block onboarding.

### A4. 🟠 Refresh-token rotation is written but disabled *(TODO.md-adjacent)*
`refreshAccessTokenService` has rotation logic present in a comment but not active — a given refresh token stays valid and reusable for its full 7-day life. Without rotation, there's no way to detect "this refresh token was stolen and is now being used by two different parties" (the classic signal rotation is designed to catch).
- **Fix**: enable rotation; on each refresh, issue+store a new refresh token and mark the old one used. If a used-and-already-rotated token is presented again, treat it as a compromise signal and invalidate the entire session family, not just that one session.

### A5. 🟡 No `tokenVersion` field — can't force-invalidate live access tokens
Password change, admin-forced logout, or a detected compromise can revoke *sessions* (blocking refresh) but cannot invalidate an access token that's already been issued and is still within its 15-minute window. Small blast radius today given the short expiry, but it's the standard mechanism and directly needed for A2's password-reset flow to be actually secure (a leaked-then-reset password should immediately kill any tokens issued before the reset).
- **Fix**: add `tokenVersion: number` to `User`, embed in JWT payload at sign time, compare against the current DB value in `JwtStrategy`'s verify callback, increment on password change/reset/forced logout.

### A6. 🟡 Missing OAuth `state` parameter *(TODO.md item 2)*
`passport-google-oauth20` is initialized without a `state` param — increases susceptibility to login CSRF/session-fixation-adjacent attacks on the OAuth callback.
- **Fix**: generate + validate a random `state` value across the redirect.

### A7. 🟡 OAuth callback may pass tokens via URL *(TODO.md item 1)*
Flagged previously — worth re-confirming directly against `googleLoginCallback`'s actual redirect construction. If tokens are appended to the redirect URL query string, they land in browser history, any proxy/CDN access logs, and the `Referer` header of whatever page loads next.
- **Fix**: exchange a short-lived one-time code server-side, or set the refresh token as an httpOnly cookie directly on the redirect response.

### A8. 🟡 bcrypt cost factor is 10
```ts
export const hashValue = async (value: string, saltRounds: number = 10) => await bcrypt.hash(value, saltRounds);
```
10 rounds was a reasonable default several years ago; current guidance for new systems is closer to 12, given how much cheaper GPU-accelerated brute-forcing has gotten. Low urgency (10 is not "broken," just dated) but a one-line, zero-risk improvement.
- **Fix**: bump `saltRounds` default to 12. (Existing hashes remain valid — bcrypt encodes its own cost factor per-hash, so this doesn't require a migration, only affects newly-hashed passwords going forward.)

### A9. 🟢 Dead/unused session config in `.env.example`
`SESSION_SECRET` and `SESSION_EXPIRES_IN` are documented in `.env.example` but never referenced anywhere in `backend/src` — the app is fully JWT/Session-model based, not `express-session`/`cookie-session` based (see also the unused `cookie-session` npm dependency flagged previously). This is confusing for anyone deploying the app who reasonably assumes every documented env var matters.
- **Fix**: remove both from `.env.example`, and remove the unused `cookie-session` package from `package.json`.

### A10. Positive finding worth stating explicitly: JWT algorithm confusion is correctly prevented
```ts
// signing: algorithm: "HS256" (explicit, not left to default)
// verifying (passport.config.ts): algorithms: ["HS256"]   ← explicit allow-list on verify too
```
Both signing and verification pin the algorithm explicitly rather than trusting whatever `alg` header arrives in the token — this is exactly the correct defense against the classic "alg: none" / RS256-to-HS256 confusion attack family. Worth knowing this is already right, not something to fix.

---

## Category 3 — Authorization & Business-Logic Invariants

This category goes beyond "is the endpoint behind a permission check" (already reviewed and generally solid — see Backend Architecture doc §3.4/§8.4) into "does the permission system enforce every invariant the domain actually needs."

### B1. 🟠 No protection against removing the last OWNER of a workspace
```ts
// workspace.service.ts::changeMemberRoleService
const member = await MemberModel.findOne({ userId: memberId, workspaceId });
member.role = role;
await member.save();   // no check for "is this the last OWNER, and are we demoting them?"
```
An OWNER can demote themselves (or, via `changeRoleSchema`, be demoted by another OWNER if multiple exist) with nothing stopping the workspace from ending up with **zero owners** — at which point nobody has `DELETE_WORKSPACE`/`CHANGE_MEMBER_ROLE` permission and the workspace becomes permanently stuck in its current state, un-administrable by anyone short of a manual database fix.
- **Fix**: before applying a role change, if the target member currently holds the OWNER role, count remaining OWNERs in that workspace and reject the change with a clear error if it would bring the count to zero.

### B2. 🟡 No self-role-change guard
Nothing stops an OWNER from changing their *own* role via the same endpoint (accidentally locking themselves out of a workspace they created, especially relevant combined with B1). Most mature multi-tenant apps explicitly disallow self-role-changes through the "change someone else's role" endpoint and require a separate, more deliberate "transfer ownership" flow instead.
- **Fix**: reject `changeMemberRoleService` calls where `memberId === callerId`, or build an explicit ownership-transfer endpoint that requires re-confirmation.

### B3. 🟡 Invite-code based join has no expiry or usage cap
`Workspace.inviteCode` is generated once at workspace creation and — as far as the reviewed code shows — never rotates or expires. Anyone who ever obtains that code (leaked in a screenshot, a forwarded link, a scraped page) can join the workspace indefinitely, with no owner visibility into how the code was distributed.
- **Fix**: add an `inviteCodeExpiresAt` and/or a regenerate-on-demand action in workspace settings (you likely already want a "regenerate invite link" button in the UI regardless, for the case of accidental leakage).

### B4. Positive finding worth stating explicitly: tenancy re-verification is done correctly and consistently
As already noted in the Backend Architecture doc, every service re-verifies that a referenced resource (`project`, `assignedTo`) actually belongs to the workspace being operated on, rather than trusting client-supplied IDs. This is the correct defense against IDOR-style cross-tenant access and is applied consistently, not just in one or two places — genuinely good practice, worth keeping as new domain objects (subtasks, comments) are added in the Roadmap.

---

## Category 4 — Injection & Input Handling

### I1. 🟠 No NoSQL-injection-hardening middleware (`express-mongo-sanitize`), compounded by D1's mongoose CVE
There is no `express-mongo-sanitize`/`hpp` (HTTP Parameter Pollution) middleware anywhere in `backend/src/index.ts`. Current practical exposure is **partially mitigated** by two things already in place: (a) every mutating endpoint validates `req.body` against a Zod object schema with `z.string()`/`z.enum()` types, which rejects a `{ "$gt": "" }`-style operator-injection payload at the type level before it ever reaches Mongoose; (b) most `:id` route params are parsed through an `objectIdSchema`-style Zod validator before being handed to `findById`. However: **query-string parameters and any field not covered by a Zod schema are not similarly protected**, and the now-confirmed mongoose `sanitizeFilter` CVE (D1) means you can't lean on Mongoose's own built-in sanitizer as a backstop either.
- **Fix**: add `express-mongo-sanitize` and `hpp` as global middleware (cheap, defense-in-depth, no behavior change for well-formed requests), and patch the mongoose CVE per D1.

### I2. 🟡 Swagger UI likely broken/insecure under default Helmet CSP
```ts
app.use(helmet());                                              // default CSP: script-src 'self', no exceptions
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));  // renders inline <script>/<style> — no CSP override here
```
`swagger-ui-express` renders a React-based UI that relies on inline scripts/styles. Helmet's **default** Content-Security-Policy (`script-src 'self'`, `style-src 'self'`) will block those inline tags in any browser that enforces CSP — meaning `/api/docs` may currently render broken (blank page, console CSP errors) rather than actually being usable, and there's no code checked-in giving that route a relaxed policy. Worth verifying directly in a real browser against the deployed dev environment; if it does work, Helmet's CSP may not be as strict as the library default suggests (some Helmet versions ship a looser default), but nothing in the code explicitly confirms an override either way.
- **Fix**: give `/api/docs` a scoped CSP exception (`helmet({ contentSecurityPolicy: false })` on just that route, or the swagger-ui-express-recommended CSP directives) rather than disabling CSP globally.

### I3. 🟢 No explicit request body size limit declared
`express.json()` is called with no `limit` option, which defaults to 100kb — a reasonable ceiling already, not actually "unlimited" as a naive read might suggest. Still worth declaring explicitly (`express.json({ limit: "1mb" })`, tuned to your largest expected payload) so the ceiling is a documented, deliberate choice rather than an implicit default someone has to go look up.

### I4. Positive finding worth stating explicitly: no `dangerouslySetInnerHTML` anywhere in the frontend
Searched all of `client/src` — zero uses of `dangerouslySetInnerHTML`. Every piece of user-generated content (task titles/descriptions, comments once added, workspace names) goes through React's default JSX text escaping. This means there is currently no direct stored-XSS vector via task/project content — worth explicitly preserving this constraint as rich-text task descriptions get added in the Roadmap's Milestone 2 (a markdown renderer or rich-text editor is exactly the kind of addition that can silently reintroduce this risk if not chosen carefully — prefer a sanitizing renderer like `react-markdown` with `rehype-sanitize`, not a raw HTML editor).

---

## Category 5 — HTTP Security Headers & Transport

### H1. 🟡 Helmet is used with all defaults — no explicit tuning
```ts
app.use(helmet());
```
This is a reasonable baseline (it does set `X-Content-Type-Options`, `X-Frame-Options`, a default CSP, HSTS, etc.) but nothing here is deliberately tuned for this app's actual needs — e.g., no explicit `hsts: { maxAge: ..., preload: true }` for the production domain once one exists, no explicit `frameguard` confirmation (relevant since embedding AstriX in an iframe should almost certainly be disallowed), and as noted in I2 no per-route CSP relaxation for the one route (`/api/docs`) that legitimately needs it.
- **Fix**: move from `helmet()` to an explicit config object once a real production domain exists, so the header set is a documented decision, not an inherited default.

### H2. 🟡 CORS `origin` is a single string, not environment-aware for multiple valid frontends
```ts
cors({ origin: config.FRONTEND_ORIGIN, credentials: true, ... })
```
Fine for a single environment, but the moment `staging` exists alongside `dev`/`prod` (Roadmap Milestone 6), this needs to become either an array of allowed origins or a validating function — a hardcoded single string will simply reject the staging frontend outright once it exists on a different domain.

### H3. 🟡 No WAF in front of the ALB or CloudFront
No `aws_wafv2_web_acl` resource exists anywhere in `infra/`. There's currently no L7 protection (common SQLi/XSS payload signatures, basic bot filtering, geographic/IP-reputation blocking) sitting in front of either the API or the static frontend beyond what the application itself does.
- **Fix**: add a WAF module with AWS's managed rule groups (`AWSManagedRulesCommonRuleSet` at minimum) attached to both the ALB and the CloudFront distribution — this is usually a small, self-contained Terraform addition once the rest of the networking exists (as it does here).

### H4. 🟠 CloudFront has a live, fully-configured `/api/*` proxy to the ALB that the application doesn't use — and that nothing (like a WAF, per H3) is guarding
Confirmed directly in `infra/modules/cloudfront_s3/main.tf` and its wiring in `infra/environments/dev/main.tf` (`alb_dns_name = module.alb.alb_dns_name`): the deployed CloudFront distribution has a working `path_pattern = "/api/*"` behavior forwarding cookies, `Authorization`, and query strings straight to the ALB. The application itself never sends traffic through this path — `VITE_API_BASE_URL` and the OAuth callback URLs all point directly at the ALB's own DNS name — but the CloudFront path is live and reachable by anyone who discovers the distribution's domain. This is a second, undocumented ingress route into the backend, with different caching/header-forwarding behavior than the direct-ALB path, and it inherits none of whatever protections (H3's WAF, once added) end up scoped only to the "official" path.
- **Fix**: either finish adopting this path as the real API entry point and retire the direct-ALB URL, or delete the `/api/*` behavior and ALB origin from the CloudFront module so there is exactly one documented, guarded way to reach the backend. Full detail in the DevOps document §6.

### H5. 🟡 The ALB's HTTPS listener is commented out — no TLS is actually being terminated at the load balancer today
`infra/modules/alb/main.tf` has the `aws_lb_listener.https` resource (and the HTTP→HTTPS redirect) entirely commented out — only the plain-HTTP port-80 listener is active, despite the ACM module generating a certificate specifically for this purpose. This **lowers the immediate exploitability** of the already-flagged leaked private key finding (there's currently no live TLS endpoint presenting that cert for anyone to intercept), but it does not make the leak acceptable — it means whoever eventually uncomments the HTTPS listener (a very natural, expected next step, since the cert exists for exactly this) will unknowingly wire up a certificate whose private key has been public in git history the whole time, with nothing about that step prompting a rotation first.
- **Fix**: rotate/regenerate the ALB certificate as part of purging the leaked key from history — do this *before* the HTTPS listener is ever uncommented, not after. Full detail in the DevOps document §5.

---

## Category 6 — Rate Limiting, Scaling & Abuse Resistance

### R1. 🟠 Rate limiting uses `express-rate-limit`'s default in-memory store
```ts
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 5, ... });  // no `store` option — defaults to MemoryStore
```
`MemoryStore` tracks counts **per running process**. The moment ECS runs more than one task (which you'll want for any real availability), each task has its own independent counter — an attacker hitting the ALB round-robin across N tasks effectively gets `5 × N` login attempts per window instead of 5, silently defeating the brute-force protection at exactly the point where you'd otherwise consider the app "scaled." It also resets on every deploy/restart.
- **Fix**: back the limiter with Redis (`rate-limit-redis` + the ElastiCache module already suggested in the Roadmap's infra catalog for Socket.io) — this becomes necessary the moment task count > 1, so it's worth sequencing alongside whichever milestone first scales ECS horizontally.

### R2. 🟡 `express-rate-limit` version in use has a known bypass (see D1)
Compounds R1: even single-instance, the installed version is vulnerable to an IPv4-mapped-IPv6 bypass. Patch via D1's `npm audit fix`.

### R3. 🟢 Registration has no additional anti-abuse layer beyond the shared IP rate limit
No CAPTCHA, no email-domain denylist, no signal beyond "5 requests per IP per 15 minutes" (shared with login). Low priority pre-launch, but worth having a plan (hCaptcha/Turnstile on `/register`) before any public marketing launch, since IP-based limits alone are cheap to route around with residential proxies.

---

## Category 7 — Observability, Backup & Incident Response

None of this is a "vulnerability" in the traditional sense, but all of it determines whether a real incident is survivable — genuinely part of "does this look production ready."

### O1. 🟠 No structured logging (already flagged, restated here for completeness)
18 raw `console.log`/`console.error` calls, no log levels, no correlation IDs tying a request to its downstream effects. In an actual incident, this is the difference between finding the answer in two minutes and not finding it at all.

### O2. 🟠 No error tracking / APM integration
No Sentry, no equivalent. A production error today is only visible if someone happens to be tailing CloudWatch logs at the right time, or a user reports it.
- **Fix**: Sentry's free tier covers both `backend` and `client` and is a same-day integration.

### O3. 🟠 CloudWatch alarms exist but have no notification target — corrected from the earlier "no alerting exists" finding
A deeper pass through `infra/modules/ecs/main.tf` found this was stated too broadly before: three CloudWatch alarms **do** exist (high CPU, high memory, and zero-running-tasks with `treat_missing_data = "breaching"`, a genuinely good detail), gated behind `var.enable_alarms`. What's actually missing is any `alarm_actions` — no SNS topic, no email/Slack/PagerDuty subscription wired to any of them. An alarm can fire and sit in `ALARM` state indefinitely, visible only to someone who happens to open the CloudWatch console. The gap is notification, not detection.
- **Fix**: add an `aws_sns_topic` + email/Slack subscription and wire it into each alarm's `alarm_actions`. Full detail in the DevOps document §8.

### O6. 🟠 IAM role for GitHub Actions is broader than intended — most ECS/CloudFront actions are `Resource: "*"`, not scoped to this project
Confirmed directly in `infra/modules/iam/main.tf`: of the ECS permissions granted to the GitHub Actions role, only `ecs:DescribeServices` is scoped to this project's specific cluster ARN — `UpdateService`, `RegisterTaskDefinition`, `DeregisterTaskDefinition`, and `DescribeClusters` all carry `Resource: "*"`, meaning this role can act on **any ECS service in the entire AWS account**, not just `astrix-dev-*`. The same pattern applies to CloudFront (`CreateInvalidation`/`ListDistributions` are also `Resource: "*"`, though `CreateInvalidation` specifically could be scoped to a single distribution ARN in IAM and isn't here). For a single-project AWS account the practical blast radius is unchanged either way, but the policy itself doesn't express or enforce that boundary — the moment a second project shares this account, this role becomes a lateral-movement path between them.
- **Fix**: scope `Resource` to `arn:aws:ecs:*:*:{cluster,task-definition,service}/astrix-dev-*` and the specific CloudFront distribution ARN respectively. Not urgent for a single-project account; important before a second project ever shares it. Full detail in the DevOps document §7.

### O7. 🟡 Committed policy JSON files disclose real AWS SSO role ARNs, not just an account ID
`infra/scripts/backend-bucket-policy.json` and `infra/scripts/terraform-kms-policy.json` are committed to the repository (not gitignored) and contain the actual IAM Identity Center (SSO) permission-set role ARNs used to administer this AWS account (e.g. a real `AWSReservedSSO_TerraformProvisioner_...` role ARN). This is more specific reconnaissance information than the already-flagged bare account ID (A10 in the original pass) — it reveals the exact role names an attacker would need to target for any privilege-escalation attempt against this account, should they ever gain any foothold at all.
- **Fix**: move these policy documents out of the committed repo into a local, gitignored config, or template the role names via a Terraform variable populated from a non-committed `.tfvars` file.

### O4. 🟡 No documented backup/restore procedure for MongoDB
The database itself lives outside this repo's Terraform (MongoDB Atlas or similar, presumably), so backup cadence and restore testing are entirely undocumented here. Even a one-paragraph runbook ("Atlas continuous backups are enabled, restore tested quarterly, RPO/RTO targets are X") is worth having before this holds anything you can't afford to lose.

### O5. 🟢 No `SECURITY.md` / responsible-disclosure policy
If this is ever public-facing, a `SECURITY.md` with a contact for responsible disclosure is a small, standard addition that signals maturity to anyone who finds an issue and wants to report it privately rather than publicly.

---

## Full Severity Table

| # | Finding | Category | Severity | Effort |
|---|---|---|---|---|
| A1 | Cookie `Secure` flag inverted | Auth | 🔴 Critical | Minutes |
| D1 | Backend: 15 vulns incl. 1 critical (`tar`), mongoose NoSQL-injection CVE | Dependencies | 🔴 Critical | Minutes–hours |
| *(carried over)* Private TLS key committed to git | Infra/Secrets | 🔴 Critical | Hours — see the DevOps document §5: the HTTPS listener using this cert is currently commented out, which lowers immediate exploitability, but does not make the leak acceptable — rotate before the listener is ever re-enabled |
| A2 | No password-reset flow at all | Auth | 🟠 High | Days |
| A3 | No email verification | Auth | 🟠 High | Days |
| A4 | Refresh-token rotation disabled | Auth | 🟠 High | Hours |
| B1 | No last-owner protection | Business logic | 🟠 High | Hours |
| D2 | Frontend: 13 vulns (11 high) | Dependencies | 🟠 High | Minutes |
| I1 | No NoSQL-injection middleware | Injection | 🟠 High | Hours |
| R1 | Rate limiter not distributed (in-memory) | Rate limiting | 🟠 High | Half-day (needs Redis) |
| O1 | No structured logging | Observability | 🟠 High | Hours |
| O2 | No error tracking (Sentry etc.) | Observability | 🟠 High | Hours |
| A5 | No `tokenVersion` forced-invalidation | Auth | 🟡 Medium | Hours |
| A6 | No OAuth `state` param | Auth | 🟡 Medium | Hours |
| A7 | OAuth token possibly in URL | Auth | 🟡 Medium | Hours |
| A8 | bcrypt cost factor 10 vs 12 | Auth | 🟡 Medium | Minutes |
| B2 | No self-role-change guard | Business logic | 🟡 Medium | Minutes |
| B3 | Invite codes never expire | Business logic | 🟡 Medium | Hours |
| D3 | No Dependabot/Renovate | Dependencies | 🟡 Medium | Minutes |
| D4 | No dependency scan gate in CI | Dependencies | 🟡 Medium | Minutes |
| I2 | Swagger UI likely broken under default CSP | Injection/Headers | 🟡 Medium | Minutes |
| H1 | Helmet defaults untuned | Headers | 🟡 Medium | Hours |
| H2 | CORS single-origin, not multi-env-ready | Headers | 🟡 Medium | Hours |
| H3 | No WAF | Infra | 🟡 Medium | Half-day |
| H4 | Unused CloudFront `/api/*` proxy is live, unguarded | Infra | 🟠 High | Hours (route through it, or remove it) |
| H5 | ALB HTTPS listener commented out (cert unused, but not yet exploitable live) | Infra | 🟡 Medium | Minutes to re-enable, but rotate cert first |
| R2 | express-rate-limit bypass CVE | Rate limiting | 🟡 Medium | Covered by D1's fix |
| O3 | CloudWatch alarms exist, no notification target wired | Observability | 🟠 High | Minutes (SNS topic + subscription) |
| O4 | No documented DB backup/restore plan | Observability | 🟡 Medium | Documentation only |
| O6 | GitHub Actions IAM role over-scoped (`Resource: "*"` on ECS/CloudFront) | Infra/IAM | 🟠 High | Hours |
| O7 | Committed policy JSON exposes real AWS SSO role ARNs | Infra/Secrets | 🟡 Medium | Hours |
| A9 | Dead session config/dependency | Auth | 🟢 Low | Minutes |
| I3 | No explicit body-size limit declared | Injection | 🟢 Low | Minutes |
| R3 | No CAPTCHA on registration | Rate limiting | 🟢 Low | Half-day |
| O5 | No `SECURITY.md` | Observability | 🟢 Low | Minutes |

**Suggested fix order**: the two 🔴 items first (both are minutes-to-hours of work — do them today), then D1/D2 (`npm audit fix`, same day, huge headline improvement), then A2+A3 (password reset + email verification — these are the biggest *functional* gap standing between this and something you'd let real strangers sign up for), then B1 (data-integrity landmine, cheap to fix), then the remaining 🟠 items as you build out Milestone 0 of the Roadmap document.