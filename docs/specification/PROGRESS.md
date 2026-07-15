# Gorifi Security Remediation — Backlog (Phase 2 & 3)

Task definitions live in **`docs/security-audit-2026-07.md`** (finding IDs like `C3`, `H6` are that
doc's; `§` refs point there). This file is the dependency-ordered build plan derived from it.

**Legend** — `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked.
One row = one shippable pipeline run (`/next-task`). **Top-to-bottom = dependency order** — never
start a row before the rows above it that it depends on. `⚠` marks a cross-task seam: what an earlier
task deliberately left unfinished and which later row completes it. ` · model=heavy` tags slices worth
a stronger model (calculators, migrations, auth state machines); untagged rows inherit the session model.

> **Stack note:** Gorifi is Vue 3 + Express + sql.js (JS, not React/TS). The `react-specs-driven-dev`
> pipeline agents discover the stack at runtime; treat "component/route" language as Vue views + Express
> routers. Tests run through the existing `e2e/` Playwright suite (target-agnostic via `BASE_URL`).

---

## 0. Foundations (cross-cutting)

- [x] SEC-F1  E2E harness: Playwright config + BASE_URL + seed + api-security/admin-auth/public smoke — `e2e/` · shipped on `security/phase-1-auth` (31 specs). New tasks extend this suite; it exists before every UI row below.
- [x] SEC-F2  Rate limiting on auth & registration endpoints (`express-rate-limit`) — `§H2` ⚠ throttles `/admin/login`, `/friends/auth`, `/invitations/register`, `/invitations/code/:code`, onboarding submit; make the limiter injectable so tests can assert 429. Consumed by SEC-S1 (admin brute-force) and SEC-S2 (invite-code guessing).

## 1. Phase 1 — shipped (context; do not re-run)

- [x] SEC-P1a  Server-side admin auth (`requireAdmin` on all 72 admin routes) — `§C1/C2/C4/C5`
- [x] SEC-P1b  Strip `access_token`/`password_hash`/`invite_code` from responses — `§C4`
- [x] SEC-P1c  CORS allowlist + atomic DB writes + dep patches (express 4.21, multer 2) — `§H1/C6/H5`

## 2. Friend authentication — close the deferred IDOR (Phase 2)

- [ ] SEC-A1  Frontend token-only sessions: use the Bearer token returned at login, stop persisting the plaintext friend password in `localStorage`, enforce `expiresAt` on restore, redirect to login on 401 — `§H4/H3/L2` · has_ui ⚠ Phase 1 left the legacy `{friendId,friendName,password}` localStorage shape and unused `expiresAt` in place (`FriendPortal.vue:244`, `OnboardingPage.vue:80`); this row removes password persistence and starts honoring expiry. Backend still accepts `X-Friends-Password` until SEC-A3.
- [x] SEC-A2  Backend object-level ownership on friend-scoped routes — `requireFriendOwner`/`enforceOrderOwnership`: token auth must match the target friendId (403); shared-password allowed only in legacy mode, rejected in modern. Applied to friends balance/profile, subscriptions, transactions history, orders get/update/submit. Closes the friend-vs-friend IDOR — `§C3` · shipped on `security/phase-2-auth` (e2e auth-ownership.spec.js).
- [x] SEC-A3  Shared-password deprecation path enforced in code: in `modern` mode all friend-scoped routes reject shared/cycle-password auth and require a per-friend token (SEC-A2 helpers). Forced password change added (must_change_password): admin reset flags it, login reports it, friend must set their own password before continuing (requirement #3). User greenlit; flip `auth_mode` to `modern` after resetting all friend passwords — `§H3/L2` · shipped on `security/phase-2-auth`. ⚠ deploy phase-2 + reset friend passwords, then set auth_mode=modern in admin settings to fully close the legacy window.
- [ ] SEC-A1  Frontend token-only cleanup: stop persisting the plaintext friend password in `localStorage`, honor `expiresAt` on restore, drop the legacy password aliases — `§H4/H3/L2` · has_ui ⚠ partially addressed by phase-2 (forced-change writes token-only), but the legacy `password` storage path in `FriendPortal.vue` restore still exists; finish removing it once all friends are on individual credentials.

## 3. Secrets & credential storage (Phase 2)

- [x] SEC-S1  Admin password → bcrypt: migrate the SHA-256 hash on next successful login / change-password, raise admin minimum length to ≥10 — `§H3` · depends: SEC-F2 ⚠ Phase 1 kept the unsalted `crypto.createHash('sha256')` in `admin.js`; friend auth already uses bcrypt — reuse `friend-auth.js` `hashPassword/comparePassword`.
- [x] SEC-S2  CSPRNG identifiers: replace `Math.random()` in `generateUid`/`generateInviteCode` with `crypto.randomInt`, lengthen new invite codes to ≥8 chars (existing codes stay valid) — `§H3/M6` · depends: SEC-F2 ⚠ 5-char `Math.random()` invite codes are brute-forceable; SEC-F2 rate-limits `/invitations/code/:code` lookups, this removes the weak generation.
- [x] SEC-S3  Password policy: raise friend minimum to ≥8 and admin to ≥10 in backend validators + all frontend forms (currently 4) — `§H3/M4` · has_ui · depends: SEC-A1 (friend flows), SEC-S1 (admin flow).

## 4. Input & request hardening (Phase 2)

- [x] SEC-H1  SSRF guard on server-side `fetch`: host allowlist + block loopback/private/link-local IPs + size & timeout caps on `products/:id/image-from-url` and the gsheet imports (allowlist `docs.google.com`) — `§H6` ⚠ Phase 1 admin-gated these routes and left an explicit `NOTE: SSRF vector — Phase 2 adds a host allowlist` comment in `products.js`; this row implements it.
- [x] SEC-H2  Upload MIME validation: allowlist real image types by magic-bytes (png/jpeg/webp/gif), reject `svg+html` payloads instead of trusting `req.file.mimetype`, on the product + bakery image routes — `§M1`.
- [ ] SEC-H3  Voucher/discount bounds: validate `supplier_discount`/`applied_discount` in `[0,100]`, non-negative, guard the divide-by-zero at `applied_discount = 100` — `§M2` ⚠ SEC-P1 admin-gated `/vouchers/generate`; this closes the value-range hole behind it.

## 5. Infrastructure & transport (Phase 2)

- [ ] SEC-I1  Nginx security headers + limits: add `Strict-Transport-Security` (only once TLS-at-edge confirmed), `Content-Security-Policy`, `Referrer-Policy`; repeat headers inside each `location` block (nginx drops inherited `add_header`); set `client_max_body_size` and `limit_req` — `§H7/H3/M3` ⚠ HSTS depends on confirming Nginx Proxy Manager terminates TLS upstream; acceptance requires a user-run deploy (sandbox has no server access — see memory `deploy-requires-user-ssh`).
- [ ] SEC-I2  Container hardening: `USER node` + `HEALTHCHECK /api/health` in Dockerfile; `mem_limit`/`cpus`/`pids_limit` in docker-compose — `§M5`.

## 6. Data layer & operations (Phase 3 — structural)

- [ ] SEC-D1  Migrate `sql.js` → `better-sqlite3`: swap the engine behind the existing `dbHelpers` API, enable WAL, remove the whole-file `saveDb()` rewrite, add native build deps to the Dockerfile/host — `§C6/H7` · model=heavy ⚠ Phase 1 added a temp-file+fsync+rename atomic-write shim to `saveDb()`; this removes that shim entirely (WAL + atomic commits replace it) and removes the single-writer footgun. Highest-effort row; land after Phase 2 stabilizes.
- [ ] SEC-D2  Encrypted, scheduled, off-host backups: use the SQLite `.backup` API (WAL-safe), encrypt at rest (age/gpg), `chmod 600`, ship off-host, install the cron entry in `setup-server.sh` — `§M4/M5` · depends: SEC-D1 ⚠ backup method changes once the DB is `better-sqlite3`/WAL — a raw `cp` of a live WAL DB is unsafe.
- [ ] SEC-D3  Build reproducibility & runtime: Node 20+ everywhere (`setup-server.sh` is EOL Node 18, Dockerfile pins by tag), pin base image by digest, `npm ci` in Dockerfile + `deploy.sh` — `§L3/L4`.

## Log

<!-- /next-task appends one line per completed task below (durable cross-session record). -->
2026-07-15 · SEC-H2 · task/sec-h2 · upload MIME validation — new helper image-upload.js: detectImageMime() sniffs magic bytes (PNG/JPEG/GIF/WebP); imageFromUpload/imageFromBody reject anything else (incl. data:text/html and data:image/svg+xml). Wired into products.js + bakery-products.js file uploads and body.image, and image-from-url now derives type from bytes not the remote Content-Type. e2e image-upload.spec.js (rejects svg-as-png and data:text/html; accepts real PNG). Full suite 44 passed / 2 skipped. Direct impl (self-reviewed).
2026-07-15 · SEC-H1 · task/sec-h1 · SSRF guard — new helper safe-fetch.js (assertPublicHttpUrl blocks non-http + private/loopback/link-local/CGNAT/ULA/IPv4-mapped; safeFetch adds timeout, size cap, redirect:'error'). Wired into products.js image-from-url (strict) + the two gsheet imports (allowRedirects, fixed docs.google.com host). e2e ssrf.spec.js (rejects metadata/loopback/private/file://). Full suite 41 passed / 2 skipped. NOTE: UI e2e needs `frontend build → backend/public` first — the committed backend/public is a stale pre-guard build; skipping the rebuild fails the router-guard admin-auth tests. Direct impl (self-reviewed).
2026-07-14 · SEC-S3 · task/sec-s3 · friend password minimum raised 4→8 in backend validators (setup-credentials, change-password, admin reset-password, onboarding submit) + frontend forms (FriendPortal, OnboardingPage, AdminFriends). Admin already ≥10 (SEC-S1). e2e friend-password-policy.spec.js (reset rejects <8). Full suite 37 passed / 2 skipped. Direct impl (self-reviewed).
2026-07-14 · SEC-S2 · task/sec-s2 · CSPRNG for identifiers — `randomCode()` via `crypto.randomInt` replaces `Math.random()` in generateUid/generateInviteCode; invite codes lengthened 5→8 chars (existing codes stay valid, exact-match lookup). e2e invite-code.spec.js (new friend's code is 8 chars from the unambiguous alphabet). Full suite 36 passed / 2 skipped. Direct impl (self-reviewed).
2026-07-14 · SEC-S1 · task/sec-s1 · admin password → bcrypt (reuses friend-auth hashPassword/comparePassword); legacy SHA-256 hashes migrate transparently on next login (verified: legacy login succeeds → hash becomes $2b$); min length raised 4→10 on setup + change-password; frontend placeholder updated. e2e admin-password.spec.js (rejects <10-char new password). Full suite 35 passed / 2 skipped. Implemented directly (this session predates the agents-framework 1.1.0 fix; self-reviewed).
2026-07-13 · SEC-F2 · task/sec-f2 · rate limiting (express-rate-limit) on /admin/login, /friends/auth, /invitations/register, /invitations/code/:code, onboarding submit; configurable via RATE_LIMIT_* env; `trust proxy` set. e2e rate-limit.spec.js (429 after limit). Implemented directly — the react-specs-driven implementer agent stalled ~50min producing nothing on this plain-JS/no-unit-test stack; reviewer agent also skipped for the same reason (self-reviewed). ⚠ authLimiter shared per-IP across admin+friend auth (conservative); abuseLimiter across register/code/onboarding.
