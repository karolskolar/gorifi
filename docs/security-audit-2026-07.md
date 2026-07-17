# Gorifi — Security & Technology Stack Audit

**Date:** 2026-07-11
**Scope:** Full backend (Express + sql.js, ~5.7k LOC), frontend (Vue 3 + Vite, ~12.8k LOC), deployment/infra (Docker, PM2, nginx, deploy scripts), and dependencies.
**Method:** Manual review of core files + parallel deep audits of routes, frontend, and infra; findings cross-verified by direct code inspection and `npm audit`.

---

## Executive summary

**Overall verdict: the application is currently exploitable by anyone who can reach it over the network.** The single dominant issue is that **there is effectively no server-side authorization** — not for admin endpoints, and not for object-level ownership on friend endpoints. This is not an oversight in one handler; `CLAUDE.md` documents it as an intentional pattern ("Admin routes in this project do NOT validate tokens server-side… Don't add server-side admin auth checks to new routes"). The frontend's login screens and route structure are the *only* gate, and they are trivially bypassed with `curl`.

The consequences are concrete and financial: an unauthenticated attacker can read every friend's personal data (phone, email, `access_token`, `password_hash`), credit their own balance to any amount, mark orders paid, change the payment IBAN so friends pay *them*, and delete or vandalize all business data.

Underneath the auth problem sits a second class of risk: **data durability**. The database is `sql.js` (SQLite compiled to WebAssembly) held entirely in memory and rewritten wholesale, non-atomically, on every single write. A single ill-timed crash or restart can destroy the entire database, and the design tolerates exactly one process ever touching the file.

Neither problem is exotic. Both are fixable with well-understood patterns. This report ranks every finding by severity and states the benefit of fixing each.

### Risk snapshot

| # | Severity | Finding | Effort |
|---|----------|---------|--------|
| C1 | 🔴 Critical | No server-side admin authorization on any endpoint | Medium |
| C2 | 🔴 Critical | Unauthenticated financial ledger manipulation (payments/adjustments) | Low* |
| C3 | 🔴 Critical | Object-level auth (IDOR) — act as / read any friend via shared password | Medium |
| C4 | 🔴 Critical | PII + credential disclosure (`access_token`, `password_hash`, phone/email) | Low |
| C5 | 🔴 Critical | Payment IBAN & shared password readable/writable unauthenticated | Low* |
| C6 | 🔴 Critical | Non-atomic DB writes → total database loss on crash mid-write | Low |
| H1 | 🟠 High | Wide-open CORS (`cors()` with no origin allowlist) | Low |
| H2 | 🟠 High | No rate limiting anywhere (brute-force admin/friend passwords, invite codes) | Low |
| H3 | 🟠 High | Weak secrets: 4-char passwords, unsalted SHA-256 admin hash, `Math.random()` tokens | Medium |
| H4 | 🟠 High | Plaintext friend password persisted in `localStorage` | Medium |
| H5 | 🟠 High | Vulnerable dependencies (Express/qs/path-to-regexp; Vite/Rollup) | Low |
| H6 | 🟠 High | SSRF via server-side `fetch()` of client-supplied image/sheet URLs | Low |
| H7 | 🟠 High | No TLS / HSTS enforced in repo; single-writer DB not guaranteed | Medium |
| M1 | 🟡 Medium | Stored-XSS vector via unvalidated upload MIME → `data:` URI | Low |
| M2 | 🟡 Medium | Voucher/discount amounts unbounded & client-supplied | Low |
| M3 | 🟡 Medium | No CSP; security headers dropped in nginx `location` blocks | Low |
| M4 | 🟡 Medium | Backups unencrypted, on-host only, likely unscheduled | Medium |
| M5 | 🟡 Medium | Container runs as root; no healthcheck / resource limits | Low |
| M6 | 🟡 Medium | Invite codes 5 chars, `Math.random()` — brute-forceable | Low |
| L1–L6 | ⚪ Low | Info leaks, dead auth surface, Node 18 EOL, build reproducibility | Low |

\* Low code effort, but *depends on* C1/C3 being fixed first (they share the same root cause).

---

## The root cause

Three files establish the entire (broken) security model:

- **`backend/src/index.js:31`** — `app.use(cors())` with no configuration → every origin is allowed.
- **`backend/src/index.js`** — no global auth middleware; routers are mounted raw.
- **`backend/src/middleware/friend-auth.js:45-65`** — in `legacy` mode, a correct global `X-Friends-Password` returns `{ valid: true }` **with no `friendId`**. Every ownership check in the codebase is written as `if (validation.friendId && <mismatch>) reject` — so when the shared password is used, `validation.friendId` is `undefined` and the check is skipped entirely.
- **Admin token** (`admin.js:59-95`) is issued and can be verified, but **no other route ever calls that verification.** It is decorative.

Fix these two things — enforce admin auth server-side, and bind friend requests to the authenticated `friendId` — and the majority of Critical/High findings collapse at once.

---

## 🔴 Critical findings

### C1 — No server-side authorization on admin endpoints
**Where:** all of `admin.js`, `cycles.js`, `products.js`, `transactions.js`, `friends.js`, `invitations.js`, `onboarding.js`, `pickup-locations.js`, `bakery-products.js`, `roasteries.js`, `subscriptions.js`, `friend-groups.js`. Documented as intentional in `CLAUDE.md:175`.

**Exploit:** `curl -X DELETE https://gorifi.skolar.sk/api/cycles/1` — no token needed. Or `PATCH /api/admin/settings` to change any setting. The admin login exists purely on the client.

**Impact:** Full compromise of all business data and the financial ledger by anyone who knows the URL.

**Fix:** Add one Express middleware that validates `X-Admin-Token` against the stored session, and apply it to every admin/mutating router. Remove the guidance in `CLAUDE.md` that tells contributors *not* to do this.

**Benefit:** Closes the single largest hole. Turns "anyone on the internet" into "authenticated admin only" for every privileged action in one change.

---

### C2 — Unauthenticated manipulation of the money ledger
**Where:** `transactions.js:7` (`GET /friend/:friendId`), `:28` (`POST /payment`), `:77` (`POST /adjustment`), `:127` (`PATCH /:id`), `:186` (`DELETE /:id`); `orders.js:393` (`PATCH /:id/paid`). **Verified directly** — none call any auth.

**Exploit:** `POST /api/transactions/adjustment {"friend_id": <me>, "amount": 100000}` → instant +100000 balance. `PATCH /api/orders/<id>/paid {"paid":true}` marks any order paid without money moving.

**Impact:** Arbitrary creation/erasure of debt and credit for any customer. Direct financial loss.

**Fix:** Require admin auth on all transaction/paid mutations (fixed by C1's middleware); reject non-finite/negative/over-limit amounts server-side.

**Benefit:** The ledger becomes trustworthy — the whole point of the app (who owes what) can no longer be forged.

---

### C3 — Broken object-level authorization (IDOR) across friend endpoints
**Where:** `orders.js:85` & `:255` (edit/submit any friend's cart via `:friendId` path param), `friends.js:306`/`:348` (balance/detail), `subscriptions.js`, `vouchers.js:139`, `friends.js:487` (profile). Root cause: the `if (validation.friendId && …)` bypass in `friend-auth.js`.

**Exploit:** With the one shared friends password (which is itself readable — see C5), call `PUT /api/orders/cycle/5/friend/<victimId>` to overwrite someone else's order, or `GET /api/friends/<any>/balance`.

**Impact:** Any friend can read and modify any other friend's orders, balances, subscriptions, and profile.

**Fix:** Make `validateFriendAuth` always resolve a concrete `friendId` (require token-based sessions; deprecate the shared-password mode). Change ownership checks to hard-fail when `friendId` is absent, and compare against the resource owner.

**Benefit:** Customers can only see and touch their own data — a baseline expectation for any multi-user app, and a GDPR necessity.

---

### C4 — PII and credential-material disclosure
**Where:** `friends.js:272` (`GET /` returns `access_token`, `invite_code`, `phone`, `email` for all friends), `friends.js:348` (`GET /:id/detail` — no auth — returns `password_hash` and `access_token` too), `transactions.js:7`.

**Exploit:** `GET /api/friends` or enumerate `GET /api/friends/1/detail`, `…/2/detail`… → every customer's contact details plus their login credential material.

**Impact:** Mass personal-data breach (GDPR-reportable) and account-takeover material (`access_token` is a live credential; `password_hash` enables offline cracking, made worse by the 4-char minimum).

**Fix:** Gate these behind admin auth; strip `access_token`, `password_hash`, `invite_code` from all API responses; return only the fields each caller needs.

**Benefit:** Eliminates the breach and removes credential material from the wire entirely.

---

### C5 — Payment IBAN & shared friends password readable and writable unauthenticated
**Where:** `admin.js:104` (`GET /settings` returns `friendsPassword`, IBAN, Revolut in cleartext), `admin.js:130` (`PUT /settings` — no auth).

**Exploit:** `PUT /api/admin/settings {"paymentIban":"<attacker IBAN>"}` → every friend's payment QR now points at the attacker's bank account. `GET /api/admin/settings` hands out the shared friends password that unlocks C3.

**Impact:** Payment redirection (direct theft of customer payments) and disclosure of the master friends password.

**Fix:** Admin auth on settings (C1); never return secret settings values to non-admins.

**Benefit:** Protects the actual cash flow and removes the key that unlocks the IDOR class.

---

### C6 — Non-atomic database writes risk total data loss
**Where:** `db/schema.js:683-688` — `saveDb()` does `writeFileSync(dbPath, buffer)` directly over the live file, rewriting the entire DB on every mutation. PM2 `max_memory_restart: '256M'` (`ecosystem.config.cjs:13`) makes an OOM kill mid-write plausible under load.

**Impact:** A crash, power loss, or OOM during a write leaves a truncated/corrupt file — losing the **entire** database, not one row. No WAL, no journaling.

**Fix:** Write to a temp file, `fsync`, then atomic `rename()` over the target. Longer-term, migrate off `sql.js` to `better-sqlite3` (real file-backed SQLite with WAL and atomic commits) — a near drop-in given `dbHelpers` already mimics its API.

**Benefit:** A mid-write crash can no longer destroy the database; the app survives restarts and OOM kills without corruption.

---

## 🟠 High findings

### H1 — Wide-open CORS
**`index.js:31`** `app.use(cors())` allows any website to make authenticated requests to the API from a victim's browser.
**Fix:** `cors({ origin: ['https://gorifi.skolar.sk'], credentials: true })`.
**Benefit:** Prevents malicious sites from driving the API using a logged-in user's session.

### H2 — No rate limiting
No throttling on `POST /api/admin/login`, friend auth, invite-code lookup, or onboarding. Combined with 4-char passwords (H3), admin login is brute-forceable in seconds.
**Fix:** `express-rate-limit` on auth and registration routes; add `limit_req` in nginx as defense-in-depth.
**Benefit:** Makes password/invite-code brute force and registration spam infeasible.

### H3 — Weak secrets and token generation
4-character minimum passwords (admin + friends); admin password hashed with **unsalted SHA-256** (`admin.js:8`); UIDs/invite codes/… generated with **`Math.random()`** (`schema.js:12-29`), which is not cryptographically secure. (Session tokens correctly use `crypto.randomBytes` — keep that.)
**Fix:** Raise minimum length (≥10 for admin, ≥8 for friends); hash admin password with bcrypt like friend passwords already are; replace `Math.random()` with `crypto.randomInt`/`randomBytes`.
**Benefit:** Credentials survive an offline crack attempt; codes/tokens become unguessable.

### H4 — Plaintext friend password stored in `localStorage`
**`FriendPortal.vue:244`** writes `{friendId, friendName, password}` with the real password in cleartext (legacy mode). `expiresAt` is stored but never checked (`OnboardingPage.vue:80`).
**Fix:** Complete the migration to token-only sessions; stop persisting passwords; enforce `expiresAt` on restore.
**Benefit:** A stolen laptop or XSS no longer yields a reusable account password.

### H5 — Vulnerable dependencies (confirmed via `npm audit`)
Backend: `express@4.18` pulls vulnerable `qs`, `body-parser`, and `path-to-regexp` (high-severity ReDoS). Frontend: `vite@7.2`/`rollup` with high-severity path-traversal / arbitrary-file-read advisories; `postcss` XSS. Also `multer@1.x` is deprecated/EOL.
**Fix:** `npm audit fix` in both packages; bump Express to latest 4.x, Vite/Rollup to patched releases; move `multer` to 2.x.
**Benefit:** Removes known, publicly-documented CVEs from the runtime and build chain.

### H6 — SSRF via server-side fetch of client URLs
**`products.js:208`** (`/:id/image-from-url`) and the Google-Sheets import do `fetch()` on a client-supplied URL with no auth and no allowlist.
**Exploit:** point it at `http://169.254.169.254/…` or internal services.
**Fix:** Require auth; validate/allowlist hosts; block private/link-local IP ranges; cap size and timeout.
**Benefit:** Prevents the server from being used to probe or exfiltrate from the internal network.

### H7 — Transport & single-writer not enforced
nginx configs are `listen 80` only (`nginx-gorifi.conf:2`); no HSTS. TLS is presumably terminated upstream (Nginx Proxy Manager) but nothing in the repo enforces or documents that. The `sql.js` model tolerates exactly one writer; PM2 in cluster mode (or a stray process) would corrupt it.
**Fix:** Document/enforce TLS + add HSTS; keep PM2 in `fork` mode with a single instance and add a comment forbidding cluster mode until the DB migrates to `better-sqlite3`.
**Benefit:** Guarantees encrypted transport and removes the silent-corruption footgun.

---

## 🟡 Medium findings

- **M1 — Stored-XSS via uploads** (`products.js`, `bakery-products.js`): `req.file.mimetype` is trusted and embedded into a `data:` URI; a crafted `image/svg+xml` can carry script. **Fix:** allowlist real image MIME types, re-encode/validate. **Benefit:** removes a persistent XSS vector.
- **M2 — Unbounded voucher/discount math** (`vouchers.js:8`): client supplies `supplier_discount`/`applied_discount` with no upper bound; `applied_discount = 100` causes divide-by-zero/negative. **Fix:** validate 0–100 and non-negative server-side. **Benefit:** prevents inflated self-credit and math crashes.
- **M3 — Missing CSP; headers dropped in nginx** (`nginx-gorifi.conf:45`): only `X-Frame-Options`/`X-Content-Type-Options` set; nginx drops parent `add_header` inside `location` blocks that set their own. **Fix:** add CSP + `Referrer-Policy`; repeat headers in each `location` (or use a shared snippet). **Benefit:** defense-in-depth against XSS/clickjacking.
- **M4 — Backups unencrypted, on-host, likely unscheduled** (`backup.sh`, `setup-server.sh`): archives contain password hashes + live session tokens, written with default umask, never copied off-host, and no cron installer exists. **Fix:** `chmod 600`, encrypt, ship off-host, install the cron job. **Benefit:** a host loss no longer destroys both DB and backups; a leaked backup isn't cleartext.
- **M5 — Container hardening** (`Dockerfile`, `docker-compose.yml`): runs as root, no `HEALTHCHECK`, no memory/CPU/pid limits. **Fix:** `USER node`, add healthcheck hitting `/api/health`, set resource limits. **Benefit:** smaller blast radius on compromise; auto-restart on hang.
- **M6 — Invite codes brute-forceable** (`schema.js:22`): 5 chars from `Math.random()`, and a valid code leaks the inviter's name. **Fix:** longer codes via `crypto`, rate-limit lookups. **Benefit:** stops mass self-registration and enumeration.

---

## ⚪ Low findings

- **L1 — Info leaks:** raw `e.message` / SQL constraint text returned to clients (`cycles.js:248`, `roasteries.js`); `console.error` in the browser. **Fix:** generic client messages, log detail server-side.
- **L2 — Dead auth surface:** dual friend-auth formats and legacy cycle-password aliases (`api.js:38-49`) keep the plaintext-password path (H4) alive. **Fix:** remove once token migration completes.
- **L3 — Node 18 (EOL) on the PM2 path** (`setup-server.sh:18`) vs Node 20 in Docker. **Fix:** standardize on Node 20 LTS+. **Benefit:** patched runtime, consistent environments.
- **L4 — Non-reproducible builds:** `npm install` (not `npm ci`) in Dockerfile and deploy; floating `node:20-alpine` tag. **Fix:** `npm ci`, pin by digest. **Benefit:** deterministic, auditable builds.
- **L5 — `.dockerignore` gaps:** doesn't exclude `.env`/`deploy/`; safe today only because the Dockerfile copies specific paths. **Fix:** tighten the ignore list. **Benefit:** removes latent secret-leak-into-image risk.
- **L6 — Deploy as remote root with `rsync --delete`** (`deploy.sh:8,146`): high-consequence if `REMOTE_PATH` is ever mis-set; the stale-config guard checks the wrong sentinel. **Fix:** deploy as a non-root user; fix the guard.

---

## Technology-stack assessment

| Layer | Current | Assessment |
|-------|---------|------------|
| Runtime | Node 18 (PM2) / 20 (Docker) | Node 18 is **EOL** — standardize on 20+ |
| Web framework | Express 4.18 | Fine, but **update** (transitive CVEs) |
| Database | **sql.js** (WASM SQLite, full-file rewrite) | ⚠️ **Biggest architectural risk.** In-memory, non-atomic, single-writer, O(n) per write. Migrate to `better-sqlite3` — the `dbHelpers` shim already mimics its API, so it's close to a drop-in. |
| Auth | Ad-hoc, client-enforced | ⚠️ Needs a real server-side model (admin middleware + token-only friend sessions) |
| Passwords | bcrypt (friends) / **unsalted SHA-256** (admin) | Unify on bcrypt |
| File uploads | multer **1.x** (EOL) | Update to 2.x + validate MIME |
| Frontend | Vue 3.5 + Vite 7 | Current & healthy; just apply `npm audit fix` and plan `radix-vue`→`reka-ui` |
| Infra | Docker + PM2 + nginx (NPM upstream) | Reasonable shape; needs TLS/HSTS enforcement, container hardening, real backups |

**The stack is mostly reasonable — the frontend is modern and the deployment topology is sensible.** The two things that genuinely need rethinking are (1) the authorization model and (2) the `sql.js` persistence layer. Everything else is hardening.

---

## Recommended remediation order

**Phase 1 — Stop the bleeding (days, do before anything else):**
1. Add server-side admin auth middleware → apply to all admin/mutating routes (C1, C2, C5).
2. Make `validateFriendAuth` always resolve a `friendId`; hard-fail ownership checks; strip `access_token`/`password_hash` from responses (C3, C4).
3. Lock CORS to the real origin (H1).
4. `npm audit fix` both packages; bump Express + multer (H5).
5. Atomic DB writes (temp + rename) (C6).

**Phase 2 — Harden (1–2 weeks):**
6. Rate limiting on auth/registration (H2).
7. Kill the shared-password path; token-only sessions; stop storing plaintext passwords; enforce expiry (H3, H4, L2).
8. bcrypt for admin; raise password minimums; `crypto` for codes (H3, M6).
9. SSRF allowlist; upload MIME validation; voucher bounds (H6, M1, M2).
10. TLS/HSTS + CSP + nginx header fix; container `USER`/healthcheck/limits (H7, M3, M5).

**Phase 3 — Structural (as capacity allows):**
11. Migrate `sql.js` → `better-sqlite3` (removes C6/H7 root cause, fixes performance).
12. Encrypted, scheduled, off-host backups (M4).
13. Standardize Node 20+, `npm ci`, pinned images (L3, L4).

---

*Audit performed read-only. No code was modified. Findings cite `file:line`; the two Critical financial/auth claims (C1–C5) and dependency CVEs (H5) were verified by direct inspection.*
