# 01 — Architecture (Gorifi)

Reference for the `/next-task` pipeline and contributors. Gorifi predates this
spec, so this documents the **existing** system, not a greenfield design.

## Stack

- **Backend:** Node.js (ESM, `"type":"module"`) + Express 4.22. **Plain JavaScript — no TypeScript.** Entry `backend/src/index.js`; routers in `backend/src/routes/*.js`; middleware in `backend/src/middleware/*.js`.
- **Database:** `sql.js` (SQLite compiled to WASM) held in memory, persisted to a single file via an atomic temp-write+rename in `backend/src/db/schema.js`. `dbHelpers` exposes `all/get/run/prepare/transaction` (mimics better-sqlite3). Migrating to `better-sqlite3` is backlog SEC-D1.
- **Frontend:** Vue 3 + Vite 7 + Tailwind, plain JS + a little TS in `frontend/src/lib`. API client `frontend/src/api.js`; router `frontend/src/router.js`; views `frontend/src/views`.
- **UI language:** Slovak.

## Auth & data models

- **Admin:** password (bcrypt migration pending — SEC-S1; currently SHA-256) → session token stored in `settings.admin_token` (JSON `{token,expiry}`). Enforced server-side by `requireAdmin` (`middleware/admin-auth.js`), which checks the `X-Admin-Token` header on every admin route.
- **Friends:** per-friend session tokens (`friend_sessions`, `crypto.randomBytes`) sent as `Authorization: Bearer`. Legacy shared global password (`X-Friends-Password`) still accepted in `auth_mode = legacy`; rejected in `modern`. `must_change_password` forces a password reset on next login. Ownership enforced by `requireFriendOwner`/`enforceOrderOwnership` (`middleware/friend-auth.js`).
- Key tables: `friends`, `order_cycles`, `products`, `orders`, `order_items`, `transactions`, `vouchers`, `invitations`, `friend_sessions`, `settings`, `pickup_locations`, `bakery_products*`. Full model: `docs/data-model.md`.

## Permissions & roles

- **Public:** health, friend login/auth-mode, cycle `/public` + `/auth`, product listing, pickup locations, payment-settings, invite-code lookup, onboarding self-signup.
- **Friend (token, object-level ownership):** own balance/profile/subscriptions/transactions/orders/vouchers.
- **Admin (`requireAdmin`):** everything else — cycles, products, friends, transactions, analytics, settings, invitations, onboarding-links, roasteries, bakery products.

## Dependencies (pre-approved)

Backend: `express`, `cors`, `express-rate-limit`, `bcryptjs`, `multer`, `sql.js`, `nanoid`, `csv-parse`. Frontend: `vue`, `vue-router`, `vite`, `tailwindcss`, `chart.js`/`vue-chartjs`, `radix-vue`, `qrcode`, `bysquare`, `@vueuse/core`. New established packages in these families are fine; flag anything niche.

## Testing & gate

**This repo has no unit-test runner and no TypeScript** — do not add Vitest/Jest/`node:test` or a `tsconfig` to satisfy a pipeline default. The quality bar is:

1. **Syntax/gate:** `node --check <changed backend files>` (there are no `lint`/`typecheck`/`test` scripts in `backend/package.json`; none should be fabricated).
2. **End-to-end (the real test bar):** Playwright suite in **`e2e/`**, target-agnostic via `BASE_URL`.
   - Run: `cd e2e && npx playwright test` (or `npm test`). Against a local prod-like server: build the frontend into `backend/public`, start `backend/src/index.js` on a port, `node seed.mjs`, then point `BASE_URL` at it. Against staging: `BASE_URL=https://gorifi-dev.skolar.sk`.
   - Specs: `e2e/tests/*.spec.js`; seed `e2e/seed.mjs`; creds `e2e/fixtures.js`.
   - The browser needs `npx playwright install --with-deps chromium` once.
   - Rate-limit spec (`rate-limit.spec.js`) only runs when the server is started with a low `RATE_LIMIT_AUTH_MAX` (≤10); it self-skips otherwise.

**Implementer/e2e-tester note:** "tests first" here means adding/extending **Playwright e2e specs**, not unit tests. When the implementer reports `blocked: no test runner`, the resolution is this e2e convention — no need to introduce one.

## Deployment

Nginx Proxy Manager (TLS) → LXC container (nginx) → PM2 apps: `gorifi-backend` (prod, :3000) and `gorifi-staging` (:3001). Deploy: `./deploy/deploy.sh staging|production` (rsync-over-ssh to Tailscale host `gorifi`; requires the operator's tailnet access — the sandbox cannot deploy autonomously). Backend restart runs the `try/catch ALTER TABLE` migrations.
