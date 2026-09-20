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

### Catalog & passport extensions (modules 12–13 — conventions the module specs must follow)

- **`coffee_products` (catalog, module 12):** one row per real-world Goriffee coffee.
  Columns: `id`, `name`, `normalized_name`, `roastery` (default `'Goriffee'`), `country`,
  `region`, `altitude`, `farm`, `variety`, `processing`, `description1`, `description2`,
  `roast_type`, `purpose`, `is_new`, `curator_pick_note`, `image`,
  `status` (`available`/`retired`), current prices (last imported), timestamps.
  `UNIQUE(normalized_name, roastery)`. Only `country`/`purpose`/`roast_type`
  are ever filtered or aggregated; **flavor chips were removed from v1 entirely (PM
  2026-08-22) — no column, no auto-tagger, no display; nothing may assume they exist**; `region`/`altitude`/`farm`/`variety`/`processing` are
  display-only (13's detail modal) and NEVER come from the importer — admin-entered once.
- **Normalization is ONE exported function** (trim, case-fold, collapse whitespace, fold
  punctuation) with a single home in a backend helper — the importer, the migration and
  the merge tool must all call it; two normalizers drifting is how duplicates return.
- **`products.source_coffee_product_id`** (nullable FK) is the ONLY schema change to an
  existing table. `order_items`, frozen snapshot prices, and every guarded seam
  (`helpers/stock.js`, `helpers/pricing.js`, guest aggregation JS-merge, packing gates)
  are untouched — module specs must not propose changes there.
- **Import layer (module 12 — bakery-pattern pivot, 2026-08-22):** imports are
  admin-main-menu, CATALOG-targeted (`/api/coffee-products/import*`), cycle-independent.
  Sheet parsing/column mapping is reused byte-identical from the legacy importers;
  consolidation per parsed row: exact normalized match → update catalog current prices
  (+report old→new); fuzzy near-miss → create-as-new-but-flagged, NEVER auto-merged;
  no match → new catalog row ("needs image"). Naturally idempotent (re-import = 0
  changes). **No import path touches any cycle — cycles are frozen by construction.**
  Coffee cycle creation ticks catalog products (bakery flow, cycles.js snapshot
  precedent) with prices frozen at snapshot time; the per-cycle import endpoints and
  CycleDetail import UI are RETIRED with the pivot. Response is a
  machine-readable JSON report (new / matched / price changes old→new / pending fuzzy /
  unparsed rows) — the future autonomous-import routine consumes exactly this API, so the
  report shape is a contract. Matching scope is Goriffee-only by construction.
- **Migration (module 12 — MANUAL WORKBENCH, reworked 2026-08-23 after staging testing):**
  no automatic linking or creation. `GET /migration/pending` lists one row per distinct
  (normalized_name, roastery) among unlinked coffee snapshots; the admin checkbox-selects
  groups and either ASSIGNS them to an existing catalog product or CREATES one from the
  selection (newest-snapshot pick). No similarity suggestions anywhere in migration —
  the auto flow's fuzzy pairs merged unrelated products on real data. Transactional;
  only-write on `products` = the link column; never mutates snapshots/prices/order_items.
  The **merge tool** (repoint links from B to A, delete B) is a permanent admin feature,
  transactional, and must refuse to merge across roasteries.
- **[DEFERRED with module 13, PM 2026-08-22] `friend_brew_methods(friend_id, method)`** — UNIQUE pair, the `friend_subscriptions`
  pattern. Methods: `espresso` / `moka` / `filter` / `frenchpress` / `capsules`.
  Multi-select semantics (module 13): recommendations/tab-defaulting use the UNION of
  matching purposes; purpose-tab defaulting only when unambiguous; mismatch hints only
  when a product's purpose matches NONE of the friend's methods.
- **[DEFERRED with module 13, PM 2026-08-22] `friend_reviews(friend_id, coffee_product_id, verdict, brew_method, created_at)`** —
  `UNIQUE(friend_id, coffee_product_id)`, verdict `up`/`mid`/`down`, upsert-latest-wins.
  Friend-owned writes (`requireFriendOwner`); never a `transactions` row (reviews are not
  financial events — the GSO-T6 lesson).
- **Cross-cycle statistics (module 12):** keyed on catalog id via the snapshot link.
  Weight authority stays `variantToKg()`; guests count in product/cycle totals ONLY,
  never in per-friend aggregates (Decision-4 discipline); guest kg merges in JS, never as
  a JOIN onto friend-row queries (the GSO-T6/T8 rule). Repeat-buyer counts (distinct
  friends with the product in ≥2 cycles) must be computable per purpose and windowable
  (last N cycles) — they power deferred social-proof badges and 13's internal ranking.
- **New admin routes** (catalog CRUD, merge, migration trigger, stats) mount under
  `requireAdmin` AND must be added to `ADMIN_ENDPOINTS` in `e2e/tests/api-security.spec.js`
  (standing CLAUDE.md invariant). Friend-facing passport/review routes are Bearer +
  ownership-guarded; catalog fields exposed to friends are the display set only.
- **No new dependencies:** fuzzy matching is implemented in-repo (normalized edit
  distance or trigram similarity over `normalized_name` — the candidate set is ~tens of
  products); no fuzzy-string package.

- **Roadmap October 2026 additions (modules 15–21).** All via the `try/catch ALTER`
  pattern; new tables via `CREATE TABLE IF NOT EXISTS` in `schema.js`; a column on a table
  already in prod needs CREATE **and** ALTER.
  - `settings`: `payment_creditor_name` (module 15). `payment_revolut_username` stays.
  - `orders.handed_over_at DATETIME`, `guest_orders.handed_over_at DATETIME` (module 16) —
    admin-only, **ledger-neutral**, settable only when packed (409 `not_packed`),
    clearable. A host hand-over stamps every non-cancelled **`via_host`** guest sub-order of
    that host in the same transaction — a guest with its own `packeta_address` (module 20) is
    its own bag and is never stamped by the host (16/20 seam). `helpers/delivery.js` derives the party's type/target read-only;
    `helpers/pickup.js` stays the only writer of the pickup/Packeta columns.
  - `order_cycles.opens_at TEXT`, `closes_at TEXT`, `stage TEXT CHECK (stage IN
    ('ordered','arrived','ready'))` nullable (module 17); `stage` is meaningful only while
    `status='locked'`, defaults to `ordered` **on lock FROM `open` only** (FUP-T26,
    2026-09-20 — the default does NOT fire from `completed` or `planned`; see
    `17-cycle-stages.md` §UC-CS-002), moves to `ready` on the first hand-over, never
    auto-completes the cycle.
  - `friends.explainer_seen_at DATETIME`, `friends.whatsapp_opt_in INTEGER DEFAULT 1`
    (existing friends default on; new registrations off until ticked), `friends.phone_e164
    TEXT`, `friends.guest_link_token TEXT UNIQUE` (modules 18/19/21). `phone` stays as
    entered; `phone_e164` is derived at write time (+421 default) and is the only column
    the sender reads.
  - `guest_orders.delivery_fee REAL DEFAULT 0`, `guest_orders.packeta_address TEXT`
    (module 20) — mirror of the friend columns; `total` stays product-only; cancel zeroes
    the fee; no `transactions` row ever (guests have no ledger).
  - `guest_waitlist(id, host_friend_id, cycle_id NULL, name, phone, phone_e164,
    whatsapp_opt_in, created_at, notified_at)` (module 19) — public write through the
    `guestWrite` bucket with the guest bounds; idempotent per (host, phone_e164).
  - `notifications(id, channel CHECK IN ('whatsapp','email'), template_key, segment_key,
    recipient_kind CHECK IN ('friend','guest','waitlist'), recipient_id, phone_e164,
    body, status CHECK IN ('queued','released','sent','failed','skipped'), cycle_id,
    order_id NULL, guest_order_id NULL, created_at, released_at, sent_at, error)` (module
    21) — the outbox. Rows are **queued** by hand-over (module 16 hook) or the composer,
    **released** by one admin „Poslať“ per group, **sent** by the `gorifi-wa` process. The
    API never sends.

## Permissions & roles

- **Public:** health, friend login/auth-mode, cycle `/public` + `/auth`, product listing, pickup locations, payment-settings, invite-code lookup, onboarding self-signup.
- **Friend (token, object-level ownership):** own balance/profile/subscriptions/transactions/orders/vouchers.
- **Admin (`requireAdmin`):** everything else — cycles, products, friends, transactions, analytics, settings, invitations, onboarding-links, roasteries, bakery products; from module 12 also the catalog (CRUD, merge, migration, cross-cycle stats). Friend-token surfaces grow the passport/review/brew-method routes only if module 13 is un-deferred (drafted 2026-08-22, then deferred wholesale).

- **Roadmap October 2026:** hand-over PATCH/bulk, distribution board read, cycle stage
  PATCH, notifications (compose/release/read), WhatsApp settings + pairing, waitlist read
  are **admin** (`requireAdmin` + `ADMIN_ENDPOINTS`). Standing-link creation/regeneration
  and the „kto čaká“ count are **host** (`requireHost`). Pre-open page read and the
  waitlist write are **public** guest routes in `routes/guest.js` (token = credential,
  `guestRead`/`guestWrite` buckets, uniform 404, hostile-input bounds) and never join
  `ADMIN_ENDPOINTS`. Payment links, timeline and the explainer are read-only friend/guest
  surfaces with no new write.

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
- Module 12 addition: an admin catalog view (old admin skin — shadcn, NO theme classes). Module 13's friend-portal passport screen + product detail modal are DEFERRED with that module (if revived: Podpultovka skin, modal on `NeoModal` — never a hand-rolled overlay inside `.app`, per the `.app > *` rule).
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
- Integrations: Pay by Square QR via `bysquare` + `qrcode`, Revolut payment link, PayMe.sk
  deep link, Packeta as a manually-entered address (no API). ⚠ AMENDED by PL-T3/PL-T4
  (15 §UC-PL-004): the QR/link PAYLOAD and the URL composition live in
  `frontend/src/lib/payment-links.js` — ~~inside `PaymentModal.vue`~~ — because there are
  FOUR mount sites and a second encode site (`FriendOrder.vue`'s success modal). Only the
  two library calls stay in the components, where their error handling is UI.
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

- **Roadmap October 2026 — the first background process (module 21).** `gorifi-wa` is a
  SEPARATE PM2 app (`deploy/ecosystem.config.cjs`, `instances: 1`, `max_memory_restart:
  '1200M'`) running **whatsapp-web.js** (headless Chromium via Puppeteer, `LocalAuth`
  session on disk under `/var/www/gorifi{,-staging}/wa-session`, Puppeteer args
  `--no-sandbox --disable-dev-shm-usage`). It talks to the API only through the
  `notifications` table in the same SQLite file (WAL; short transactions; it is the ONLY
  second writer to the DB and it writes only `notifications.status/sent_at/error`). It
  polls `released` rows, sends with pacing (random 3–10 s gap, ≤ 30/hour), stops on an
  auth error, and exposes `GET :3010/health` (state, number, queue counts, last error)
  which the API proxies to the admin settings page along with the pairing QR. The API
  process never imports whatsapp-web.js. **Server sizing:** 8 GB RAM / 4 vCPU / +2 GB
  disk / 1–2 GB swap, `/dev/shm ≥ 256 MB` in the LXC — the PO has confirmed resources are
  not a constraint. Decision record: roadmap doc §12/§16 — **no Baileys, no Business
  Cloud API**; the outbox sender is a single implementation behind one interface.
  Fallback when the bot is down or a recipient has no valid number: the composer's
  wa.me click-to-chat tab (from the admin's own phone) and/or `channel='email'` via the
  existing mailer.
- **Payment deep links (module 15)** are pure URL composition — client-side, no outbound
  call, no dependency — in ~~`PaymentModal.vue`~~ **`frontend/src/lib/payment-links.js`**
  (PL-T3/PL-T4; "pure URL composition in PaymentModal.vue" always meant client-side, not
  "inline in that file", and there are now four callers plus `FriendOrder.vue`'s success
  modal): `https://revolut.me/<user>?amount=<minor>&currency=EUR`,
  `https://payme.sk/?V=1&IBAN=…&AM=…&CC=EUR&PI=/VS<vs>/SS/KS&MSG=…&CN=…`. The variable
  symbol is server-owned like `guestPaymentReference()` (one home:
  `backend/src/helpers/payment.js` — module 21's messages quote it, never re-derive it).
- **Packeta stays manual** (free-text point); no Packeta API in this roadmap.

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


For module 21, **`whatsapp-web.js`** (+ its `puppeteer` peer, `qrcode-terminal` optional) is
pre-approved, installed ONLY in the `gorifi-wa` process's own `package.json`
(`backend-wa/` or `wa/`), never in `backend/`. **`libphonenumber-js`** is pre-approved for
E.164 normalisation in `backend/` (small, no network). For module 15 no new package: URL
composition only; `bysquare` gains the `variableSymbol` field it already supports.

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


**Roadmap October 2026 gate notes.** Same bar (no unit runner; Playwright in `e2e/`).
Every new admin route joins `ADMIN_ENDPOINTS`; every new public guest route joins the
zero-external-requests sweep in `self-hosted-fonts.spec.js`. Ledger-neutrality of
hand-over, the 409 `not_packed` refusal, guest inheritance from host, waitlist
idempotency and the outbox never-sends-from-API rule each need a spec that reads the
row back. The `gorifi-wa` process is NOT exercised by the e2e suite (no Chromium-in-
Chromium, no real number): its contract is covered by testing the outbox transitions
the API owns (`queued → released`) and a **stub sender** (`WA_SENDER=stub`) that flips
`released → sent` without network, so the composer flow is e2e-testable. Money paths
(payment link amounts, guest Packeta fee) reuse `guest-payment-modal.spec.js`'s pixel-QR
approach — changing the bysquare payload is a sanctioned edit to that spec, listed per
module.

## Deployment

Nginx Proxy Manager (TLS) → LXC container (nginx) → PM2 apps: `gorifi-backend` (prod, :3000) and `gorifi-staging` (:3001). Deploy: `./deploy/deploy.sh staging|production` (rsync-over-ssh to Tailscale host `gorifi`; requires the operator's tailnet access — the sandbox cannot deploy autonomously). Backend restart runs the `try/catch ALTER TABLE` migrations.
