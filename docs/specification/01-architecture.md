# 01 — Architecture (Gorifi)

Reference for the `/next-task` pipeline and contributors. Gorifi predates this
spec, so this documents the **existing** system, not a greenfield design.

## Stack

- **Backend:** Node.js (ESM, `"type":"module"`) + Express 4.22. **Plain JavaScript — no TypeScript.** Entry `backend/src/index.js`; routers in `backend/src/routes/*.js`; middleware in `backend/src/middleware/*.js`.
- **Database:** `better-sqlite3` (file-backed SQLite, WAL) — migrated from sql.js in SEC-D1. `dbHelpers` exposes `all/get/run/prepare/transaction/exec` (unchanged API); a thin `db` shim in `backend/src/db/schema.js` keeps the try/catch `ALTER TABLE` migration blocks working verbatim.
- **Frontend:** Vue 3 + Vite 7 + Tailwind, plain JS + a little TS in `frontend/src/lib`. API client `frontend/src/api.js`; router `frontend/src/router.js`; views `frontend/src/views`.
- **UI language:** Slovak.

## Auth & data models

- **Admin:** password (bcrypt migration pending — SEC-S1; currently SHA-256) → session token stored in `settings.admin_token` (JSON `{token,expiry}`). Enforced server-side by `requireAdmin` (`middleware/admin-auth.js`), which checks the `X-Admin-Token` header on every admin route.
- **Friends:** per-friend session tokens (`friend_sessions`, `crypto.randomBytes`) sent as `Authorization: Bearer`. Legacy shared global password (`X-Friends-Password`) still accepted in `auth_mode = legacy`; rejected in `modern`. `must_change_password` forces a password reset on next login. Ownership enforced by `requireFriendOwner`/`enforceOrderOwnership` (`middleware/friend-auth.js`).
- Key tables: `friends`, `order_cycles`, `products`, `orders`, `order_items`, `transactions`, `vouchers`, `invitations`, `friend_sessions`, `settings`, `pickup_locations`, `bakery_products*`. Full model: `docs/data-model.md`.

### Auth extensions (modules 08–11 — conventions the module specs must follow)

- **Magic link (module 09):** new table `login_tokens` (`friend_id`, `token_hash`,
  `expires_at`, `used_at`, `created_at`). The raw token is high-entropy
  (`crypto.randomBytes(32)`), sent ONLY in the e-mail link, stored **hashed** (SHA-256 is
  fine — the input is already 256-bit random, bcrypt's slow hash buys nothing here),
  **single-use** (`used_at` set atomically on redemption), TTL **15 minutes**. Request
  endpoint is public, rate-limited on its own or the `authLimiter` bucket, and its
  response is **enumeration-safe**: identical 200 body whether the identifier matched a
  friend, matched a friend without an e-mail, or matched nothing. Redemption mints a
  normal `friend_sessions` row (and honours `must_change_password` exactly like password
  login); `friend_sessions` gains a `via` provenance column so the non-blocking
  "set a new password" prompt can key on magic-link sessions (09 §UC-ML-001/008).
  Redeeming while `auth_mode = legacy` is out of scope — the feature is
  modern-mode only.
- **Remember me (module 09):** today every friend session is a flat 30-day token. The
  checkbox introduces a **short default** (24 h) with **60 days** as the opt-in (product
  decision 2026-08-14: cycles run ~monthly, so the remembered session must span two
  cycles — a friend who orders every cycle never re-logs-in on a remembered device) —
  `createFriendSession(friendId, { remember })` grows a TTL parameter; no schema change
  (`expires_at` already exists). Frontend keeps using `localStorage` (`gorifi_friend_auth`)
  in both cases; the TTL, not the storage, is the mechanism.
- **Google sign-in (module 10):** Google Identity Services (GIS) button → ID token (JWT)
  POSTed to the backend → verified server-side (signature against Google's JWKS,
  `aud` = our OAuth client ID, `iss` = `accounts.google.com`/`https://accounts.google.com`,
  `exp`). Identity key is the token's **`sub`** claim (stable, never reassigned) — never
  the e-mail. New columns: `friends.google_sub` (UNIQUE, nullable), `friends.google_email`
  (display only), `friends.google_prompt_dismissed` (the "už sa nepýtať" flag).
  **Explicit-link only**: login matches `google_sub`; no row ⇒ no login (with a hint to
  link first), never auto-link by e-mail. Admin: allowlisted Google identities in
  `settings` (key `admin_google_subs` or e-mails confirmed at link time); admin password
  auth stays as backup. Client ID is public config (`GOOGLE_CLIENT_ID` env → exposed to
  the frontend); there is **no client secret** in the ID-token flow.
- **E-mail layer (module 08):** `sendMail()` grows an optional `html` part —
  **multipart/alternative, the plain-text part always present** (deliverability + the
  mailer's existing contract). Templates are server-side (`backend/src/helpers/email-templates.js`
  or similar), brand-styled with **inline CSS only, table layout, no remote images/fonts**
  (mail clients strip `<style>`/external assets; the halftone/webfont brand chrome does
  not survive e-mail — approximate with system-font stacks and the brand colors). The
  login URL in any outbound mail comes from `resolveLoginUrl()` and production pins
  `PUBLIC_BASE_URL=https://podpultovka.biz` in `/var/www/gorifi/.env` (deployment
  requirement, part of module 08's acceptance).

## Permissions & roles

- **Public:** health, friend login/auth-mode, cycle `/public` + `/auth`, product listing, pickup locations, payment-settings, invite-code lookup, onboarding self-signup.
- **Friend (token, object-level ownership):** own balance/profile/subscriptions/transactions/orders/vouchers.
- **Admin (`requireAdmin`):** everything else — cycles, products, friends, transactions, analytics, settings, invitations, onboarding-links, roasteries, bakery products.

## Frontend structure

- `frontend/src/views/*.vue` — one view per route (`router.js`). Friend/guest surfaces:
  `FriendPortal.vue`, `FriendOrder.vue`, `GuestOrder.vue`, `GuestOrderStatus.vue`.
- `frontend/src/components/` — shared components (`FriendBalanceCard.vue`, `GuestSubOrders.vue`,
  `GuestShareDialog.vue`, `GuestProductGrid.vue`, `GuestInviteRequest.vue`, `PaymentModal.vue`, …).
- `frontend/src/components/ui/` — shadcn-vue-style primitives on `radix-vue`
  (button, card, dialog, input, tabs, …) styled via Tailwind + `class-variance-authority`;
  `frontend/src/lib/utils.ts` has `cn()`.
- `frontend/src/api.js` — single API client (Bearer token for friends, bare `guestRequest()` for guests).
- `frontend/src/lib/guest-cart.js` — guest cart logic shared by order + status screens.
- State is per-view `ref`/`computed` (no store). Cart map keyed `productId|variant → qty`.
- Sequencing conventions that must survive any restyle: `loadSeq` guards on reused
  dialogs/views, per-row `rowSeq` pending maps on mutation screens, the `ready`
  auth-gate prop for friend-authenticated children of `FriendOrder`, and `v-show`
  (not `v-if`) for the Moja objednávka/Kolegovia panels.

## Design system ("09 Neobrutal PP", friend + guest surfaces only)

- **Canonical stylesheet:** `docs/design/friends-portal-redesign/friends/theme.css` —
  tokens + every component class; maps 1:1 to the prototype
  (`docs/design/friends-portal-redesign/Podpultovka Friends.html`, screenshots in `screenshots/`).
  Port it into the Tailwind setup (tokens in `tailwind.config.js` / CSS custom properties
  + component classes); details in `02-design-system.md`.
- **Scope rule:** the new language applies ONLY to friend + guest routes. Admin views keep
  the current shadcn look — tokens are declared on scoped wrappers (`.app`, `.modal-layer`),
  never on `:root`.
- Tokens: bg `#fff8f3` (5px halftone dots at 6%), ink `#0a0a0a`, accent magenta `#ff2d87`,
  ok `#1f8a5b`, danger `#d11a5b`, warn `#8a5a00`/`#fff1cf`. Borders 3px ink (2px badges,
  4px modals); hard offset shadows (`3px 3px 0` buttons, `5px 5px 0` cards, `8px 8px 0` modals,
  `6px 6px 0 #ff2d87` highlighted). Radius 6/10/12–16.
- Fonts (Google Fonts): **Darker Grotesque 800** (display, uppercase), **Figtree** (UI/body),
  **Courier Prime** (money, counts, IDs, links, payment references ONLY).
- Hit targets: buttons ≥44px, steppers 38px, checkboxes 24/32px. Button press physics:
  hover translate(1,1)/shadow 2px, active translate(3,3)/shadow 0.
- Brand chrome on every friend/guest screen: black appbar → hazard tape → magenta ticker.
- Phone-first 378 px; desktop = same layout centered at max-width 760 px.

## i18n policy

None — UI copy is hardcoded Slovak. Register for friend/guest surfaces is impersonal
vy-form; never address the reader with a gendered past participle ("nevytvoril si" ✗).
Prototype copy is final — transcribe it verbatim, don't rewrite it.

## Shared services, background jobs, integrations

- No background jobs or schedulers.
- Integrations: Pay by Square QR via `bysquare` + `qrcode` (inside `PaymentModal.vue`),
  Revolut payment link, Packeta as a manually-entered address (no API).
- **Outbound e-mail — Mailgun (IA-T6, 07 §UC-IA-009). The backend's first and only
  outbound network call.** `backend/src/helpers/mailer.js` is the one home: Node's global
  `fetch` to `${MAILGUN_BASE_URL}/v3/${MAILGUN_DOMAIN}/messages` (EU region,
  `mg.podpultovka.biz`), basic auth `api:<key>`, 10 s `AbortSignal.timeout`, no
  dependency. Egress to `api.eu.mailgun.net:443` is therefore a deployment requirement —
  a host that blocks it degrades to `{sent:false,error:'network'}` per approval, never to
  a failed approval. Secrets live only in `/var/www/gorifi{,-staging}/.env`, loaded via
  `node_args: --env-file-if-exists` (see `deploy/ecosystem.config.cjs`); with any of the
  three vars missing the mailer is a **no-op**, which is what keeps local dev and the e2e
  suite from sending mail. One boot line reports which way it resolved. Sole caller:
  `POST /api/invitations/:id/approve`, after the transaction commits.
- Fonts are self-hosted (`frontend/public/fonts`, RD-DS-6) — the CSP allows no external
  subresource host, so any *browser-side* third-party asset is out of the question.
  ⚠ **Google sign-in (module 10) is the one sanctioned exception**: GIS requires loading
  `https://accounts.google.com/gsi/client` and its iframe/popup, so the nginx CSP must
  gain the GIS-specific allowances Google documents (`script-src`/`frame-src`/`connect-src`
  for `accounts.google.com`) — scoped additions, not a relaxation of the self-hosted-fonts
  rule, and `e2e/tests/self-hosted-fonts.spec.js`'s CSP copy must be updated in the same
  change (its header is a verbatim copy of `deploy/nginx-gorifi.conf`).
- **Google token verification (module 10)** is the backend's second outbound call
  (after Mailgun): fetching Google's JWKS / verifying ID tokens. Same rules as the
  mailer — timeout-bounded, never throws into a request handler unhandled, secrets (none
  exist in this flow) never logged.

## NFRs

- No horizontal page overflow at 320 px (pinned by `mobile-no-h-overflow.spec.js`;
  the purpose-tab strip must scroll within itself, the main switch must not).
- Print: Distribution-style listings must survive `emulateMedia({media:'print'})` folding
  rules (guest surfaces: folded content uses `hidden print:flex`, never `v-if`) — admin
  screens are untouched by this effort, but the same rule applies to any new fold.
- Sticky elements (`cat-tabs`, `cartbar`) must not stack more than one bar per edge on phones.

## Dependencies (pre-approved)

Backend: `express`, `cors`, `express-rate-limit`, `bcryptjs`, `multer`, `sql.js`, `nanoid`, `csv-parse`. Frontend: `vue`, `vue-router`, `vite`, `tailwindcss`, `chart.js`/`vue-chartjs`, `radix-vue`, `qrcode`, `bysquare`, `@vueuse/core`. New established packages in these families are fine; flag anything niche.

For module 10, **`google-auth-library`** (official, `verifyIdToken` with built-in JWKS
caching) is pre-approved as the ID-token verifier; `jose` is the acceptable lighter
alternative if the module spec prefers it. Do NOT hand-roll JWT signature verification.
The Mailgun no-SDK rule stands — module 08 builds on the existing `fetch`-based mailer,
no nodemailer/Mailgun SDK, and e-mail templates are plain template literals, not a
templating engine dependency.

## Testing & gate

**This repo has no unit-test runner and no TypeScript** — do not add Vitest/Jest/`node:test` or a `tsconfig` to satisfy a pipeline default. The quality bar is:

1. **Syntax/gate:** `node --check <changed backend files>` (there are no `lint`/`typecheck`/`test` scripts in `backend/package.json`; none should be fabricated).
2. **End-to-end (the real test bar):** Playwright suite in **`e2e/`**, target-agnostic via `BASE_URL`.
   - Run: `cd e2e && npx playwright test` (or `npm test`). Against a local prod-like server: build the frontend into `backend/public`, start `backend/src/index.js` on a port, `node seed.mjs`, then point `BASE_URL` at it. Against staging: `BASE_URL=https://gorifi-dev.skolar.sk`.
   - Specs: `e2e/tests/*.spec.js`; seed `e2e/seed.mjs`; creds `e2e/fixtures.js`.
   - The browser needs `npx playwright install --with-deps chromium` once.
   - Rate-limit spec (`rate-limit.spec.js`) only runs when the server is started with a low `RATE_LIMIT_AUTH_MAX` (≤10); it self-skips otherwise.

**Implementer/e2e-tester note:** "tests first" here means adding/extending **Playwright e2e specs**, not unit tests. When the implementer reports `blocked: no test runner`, the resolution is this e2e convention — no need to introduce one.

Baseline before the redesign effort: **238 passed / 3 skipped** (the skips need `DB_PATH` or a low rate-limit env; see CLAUDE.md). Restyling must keep the suite green — existing specs assert behavior and a few structural hooks (e.g. `data-testid="purpose-tabs"`); update selectors in specs only when a task's spec section explicitly says the DOM structure changes. There is no visual-regression tooling: pixel fidelity is verified manually against `docs/design/friends-portal-redesign/screenshots/` (e.g. via Playwright screenshots side-by-side), not asserted in CI.

## Deployment

Nginx Proxy Manager (TLS) → LXC container (nginx) → PM2 apps: `gorifi-backend` (prod, :3000) and `gorifi-staging` (:3001). Deploy: `./deploy/deploy.sh staging|production` (rsync-over-ssh to Tailscale host `gorifi`; requires the operator's tailnet access — the sandbox cannot deploy autonomously). Backend restart runs the `try/catch ALTER TABLE` migrations.
