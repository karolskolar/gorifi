# Gorifi (Podpultovka)

Group coffee + bakery order management for a circle of friends. UI is **Slovak, impersonal vy-form**
(never gendered participles addressing the reader: "nevytvoril si" ✗, "ešte nie je vytvorený" ✓).

## Stack & layout

- **Backend:** Node + Express + better-sqlite3 (file SQLite, WAL). PM2 runs it with `instances: 1` — many
  check-then-write paths are safe ONLY because of that plus synchronous handlers (see Hard rules).
- **Frontend:** Vue 3 + Vite + Tailwind. Friend/guest portal = "Podpultovka" neobrutal skin
  (`frontend/src/friends-theme.css`, `components/neo/`, `.app` / `.modal-layer` roots). Admin = old shadcn skin.
- **Tests:** Playwright only, in `e2e/` (no unit runner). `e2e/README.md` is the run recipe.

```
backend/src/
  db/schema.js          schema + try/catch ALTER TABLE migrations (column exists → ignore); generateGuestToken()
  routes/               Express routers; index.js mounts admin routers behind requireAdmin
  helpers/              stock.js, pricing.js, packing.js, guest-orders.js, guest-aggregation.js, pickup.js, analytics.js
  middleware/           admin-auth.js, friend-auth.js (requireHost, requireFriendOwner), rate-limit.js
frontend/src/           api.js (all endpoints), router.js, views/, components/, lib/ (plural.js, purposes.js, guest-cart.js, gis.js)
e2e/                    tests/*.spec.js, seed.mjs, fixtures.js, README.md
docs/specification/     NN-module.md specs (UC-XXX use cases), PROGRESS.md backlog
docs/learnings/         full per-task learnings, moved out of this file (index below)
```

- `dbHelpers`: `all/get/run/prepare/transaction/exec`. Auth: admin token (`X-Admin-Token`, ONE token app-wide);
  friends via Bearer session or legacy shared password (`X-Friends-Password`), `auth_mode` legacy/modern.
- `frontend/src/api.js` handles FormData (drops Content-Type) and custom headers; `guestRequest()` sends no auth.

## Dev & deploy

```bash
cd backend && npm run dev      # :3000
cd frontend && npm run dev     # :5173
./deploy/deploy.sh staging|production [backend|frontend]   # rsync from local files; production asks y/N (echo y |)
```
- Nginx Proxy Manager (TLS) → LXC nginx → PM2 `gorifi-backend:3000` (gorifi.skolar.sk, podpultovka.biz) /
  `gorifi-staging:3001` (gorifi-dev.skolar.sk, dev.podpultovka.biz). Files: `deploy/ecosystem.config.cjs`,
  `deploy/nginx-gorifi*.conf`, `docs/deploy/nginx-proxy-manager.md`. `VITE_STAGING=true` shows the amber banner.
- Backend restart is required for DB migrations. New domains need `server_name` in both nginx confs AND the
  `CORS_ORIGIN` default in `backend/src/index.js`, or every XHR 500s and the SPA renders blank.
- `backend/public` is git-ignored build output used only for the local prod-like e2e gate; prod serves `frontend/dist`.
- Git: feature branches, no PRs; merge `--no-ff` into main only after the user confirms on staging.

## Detailed learnings — read the file BEFORE touching its area

| Area | File |
|---|---|
| Ordering flow, auto-save, cycle progress, pickup locations, analytics, live dashboard, bakery variants, Packeta, invitations alert | `docs/learnings/01-early-features.md` |
| Guest shared orders (share link, public `/g/:token`, status URL, host view, admin surfaces, distribution, aggregation, rewards, lead capture, rate-limit buckets) | `docs/learnings/02-guest-shared-orders.md` |
| Podpultovka restyle: `.app` cascade, FriendOrder shell/cards/cartbar, fonts, CatScrollArrow, CartLineList, brand/domain, invite screen, iOS zoom, `<script setup>` scope | `docs/learnings/03-friend-portal-restyle.md` |
| Security/auth/CSP: self-hosted fonts, Google auth (GA-T3/T5/T8), invitation approve endpoint, module 07 | `docs/learnings/04-security-auth-csp.md` |
| E2E harness traps (wrong cwd, reporter glyphs) | `docs/learnings/05-e2e-harness.md` |
| Admin sets a party's pickup point (`helpers/pickup.js`, `PickupLocationPicker.vue`) | `docs/learnings/06-pickup-point.md` |

Specs: `docs/specification/*.md`, `docs/superpowers/specs/*.md`. Spec text that cites "CLAUDE.md GSO-T3" /
"CLAUDE.md 2026-08-07" etc. now resolves to these files (search by task id or date). When you finish a task,
append the full write-up to the matching learnings file and add at most one line per new rule below.

## Hard rules

### Auth & boundaries
- Admin routers are guarded server-side (`requireAdmin` in `index.js`). Every new admin route also goes into
  `ADMIN_ENDPOINTS` in `e2e/tests/api-security.spec.js`. Frontend token checks are UX only.
- `POST /api/admin/logout` is PUBLIC and idempotent-200 by design (four `logout()` callers have no try/catch, so a
  401 would strand a stale-token admin): it deletes the one `admin_token` row only for the CURRENT token, reads it
  via `isValidAdminToken`, binds no body, and must never join `ADMIN_ENDPOINTS` (FUP-T19).
- A wholly unreadable `admin_google_subs` (parse throws / not an array) is parked byte-for-byte under
  `admin_google_subs_corrupt` before any overwrite — never clobber a parked copy, never park a merely filtered array.
- `routes/invitations.js` and `/api/guest-orders` are MIXED mounts — gate per route, never wrap the mount.
  `routes/guest.js` (`/api/guest`) is PUBLIC: the URL token is the credential and it is the app's only
  unauthenticated write. Treat it as hostile input (bounds: ≤100 lines, qty ≤100, name 120 / phone 32 / email 160).
  Public guest routes must never join `ADMIN_ENDPOINTS`.
- Host identity = Bearer session via `requireHost()`; never read `friend_id` from a body (SEC-A1 IDOR).
  `requireFriendOwner` yields `friendId: null` under shared-password auth — ownership guards are meaningless
  while the shared password can mint anyone's session, so any route that WRITES a credential needs the
  modern-mode 409 guard (GA-T5). An admin token is not host identity.
- `order_token` alone resolves a guest order (module 14); `routes/guest.js` is the ONLY place it authenticates.
  It is published to host/admin surfaces via the shared `GUEST_ORDER_FIELDS` but never rendered into DOM
  attributes (compose the URL in JS at click time). Every miss answers the same uniform 404 (no oracle).
- `sanitizeFriend` strips CREDENTIALS only; audience-scoped fields (e.g. `display_name`) are deleted in their
  route. `friends.invite_code` never reaches a friend or guest payload — the guest CTA has its own endpoint for that.
- Rate limits: FIVE separate buckets in `middleware/rate-limit.js` (`auth`, `abuse`, `guestRead`, `guestWrite`,
  `magicLink`). Never collapse them.
- CSP is copied in THREE files (`deploy/nginx-gorifi.conf`, `deploy/nginx-gorifi-staging.conf`,
  `docs/deploy/nginx-proxy-manager.md`), string-equal-checked by `self-hosted-fonts.spec.js`. Fix CSP breakage by
  self-hosting, never by loosening (GIS is the one sanctioned exception). Fonts: `frontend/public/fonts`, always
  BOTH `latin` and `latin-ext` (č š ž ľ ť are latin-ext). Any new public route joins that spec's zero-external-
  requests sweep. `lib/gis.js` is the one GIS loader.
- An `await` in a handler breaks the `instances: 1` check-then-write atomicity: re-check right before the INSERT
  and translate `SQLITE_CONSTRAINT*` + the exact index message into the 409 (GA-T8). PM2 cluster mode would
  reopen overselling and every such race.
- `POST /invitations/:id/approve`: bcrypt + retry loops OUTSIDE the transaction, exactly TWO writes inside, no
  subscriptions/session/transactions row. Temp password stays uppercase; only usernames are lowercased.
- Unbindable body shapes (`{}`, `true`, `[id]`, `'abc'`) must 400, never 500 — the one-element array is the trap.
- Server length bounds are mirrored as `maxlength` in the UI.

### Money & data
- `transactions` rows come ONLY from the friend paid toggle and pack/unpack (`orders.total`, never
  `delivery_fee`). Guests have no balance: guest paid toggle, pickup PATCH, friend creation write NO ledger row.
- ONE HOME each — never re-inline: `helpers/stock.js` (stock UNION own+guest), `helpers/pricing.js` (variant→price;
  unknown variant is DROPPED, never fallback-priced; `unit` is priceable but zero-gram), `helpers/packing.js`
  (packed gate), `helpers/guest-aggregation.js` (guest UNION for aggregates), `rewards.js` (reward volume),
  `helpers/pickup.js` (which row stores a party's pickup), `guestPaymentReference()`.
- `variantGrams()` stays own-property + type safe; stock compares `!(a + b <= limit)` so NaN fails closed.
- Guest aggregates: CYCLE-level totals include guests; per-FRIEND aggregates never do. Merge the guest half in
  JS, never as a second `LEFT JOIN` on `orders` (row multiplication corrupts `orders_count`); cycle-level guest
  counts use correlated subqueries. Guest kg lives in its own map (`guestKgMap`) — folding it in doubles money.
- Guest cancel = `status='cancelled'`, `total=0`, item rows KEPT; every consumer filters on status. `cancelled`
  is terminal. Destructive guest edits require a literal `items: []`. A paid sub-order is frozen for item edits
  (`items_editable`) but cancellable → refund queue; host DELETE refuses 409 `paid`.
- `delivered` is host-only, `paid` admin-only. Name literal columns; never spread a request body into an UPDATE.
- Share-link regeneration UPDATEs the token in place (DELETE+INSERT cascades away every sub-order).
- Pickup: `orders` row if one exists (any status), else `guest_order_links`; no cycle-open gate; exactly one of
  `pickup_location_id`/`pickup_location_note`; switching Packeta → pickup zeroes `delivery_fee` (ledger-neutral).
- Guest tables live in `schema.js` CREATEs; new columns on tables already in prod need CREATE **and** ALTER.
- SQLite: `WHERE col = ""` is an identifier and throws — use `''`. Single-row picks on second-resolution
  `created_at` need `, id DESC`. `orders` has no `UNIQUE(friend_id, cycle_id)` — get-or-create relies on `instances: 1`.
- Friend creation via `POST /api/friends` sets no credentials; logins come only from approve / set-username / reset.
- FOUR credential routes, never merged: `setup-credentials` (transition, so NO mode guard possible),
  `change-password` (400s without one), admin `reset-password`, and `set-password` (GA-T11 — the FIRST
  password, modern-mode-guarded, 409 once one exists, `username` honoured only while NULL, never a rename).
  `hasCredentials === false` is reachable in modern mode ONLY via a Google login (every other mint needs
  `password_hash`; a mode flip deletes all sessions). ⚠ Such a row MAY still have a `username` — admin
  `PUT /:id/admin-username` is the one writer that sets it without a password — which is why `set-password`
  honours a supplied one only while NULL. That branch is not dead code; deleting it reintroduces FUP-T20's
  portal-side rename on a credential route.

### Frontend
- `.app > *` is `position:relative; z-index:1` at (0,1,0) and loads after Tailwind — `fixed/sticky/absolute/z-*`
  on a DIRECT child of `.app` silently compute `relative/1`. Overlays: `NeoModal`, radix `Dialog`, or
  `<Teleport to="body">`; never a hand-rolled fixed div at root. `.cartbar`/`.cat-tabs` survive only by cascade order.
- `<script setup>` has NO module scope: a singleton/guard/cache needs a plain `<script>` block.
- `friends-theme.css` is a byte-for-byte canon port with a numbered adaptation list (ends **A12**). New styling
  goes in `<style scoped>` (or a real canon sync), never ad-hoc theme edits. `line-height` often must be inline.
- One-home components — extend, never fork: `CartLineList.vue` (every ordered-items list), `GuestProductGrid.vue`
  + `lib/guest-cart.js`, `CatScrollArrow.vue`, `ProductImageModal.vue`, `GuestShareDialog.vue`,
  `PickupLocationPicker.vue` (props `cycleId`+`friendId`, never an order id), `lib/plural.js`.
- A dialog/loader reused across entities needs a `loadSeq` guard; per-row mutations need per-id pending state;
  friend-authenticated children of `FriendOrder` need the `ready` gate; its two panels stay `v-show`.
- `v-model` on `<select>` (never `:value`); a refused change snaps the control back.
- Print sheets: fold with `hidden print:flex`, never `v-if`; pickers `print:hidden`, badges `hidden print:inline-flex`.
- **No view that edits `friends.name` may call it a login.** `grep -i prihlasovac frontend/src/views/AdminFriends.vue
  frontend/src/views/FriendPortalSession.vue` must stay empty; `friends.name` is the Packeta delivery name.
  (`AdminInvitations.vue` / `InviteRegister.vue` legitimately label the real `username`.)
  Same rule server-side: `'Meno a priezvisko je povinné'` is ONE string with THREE homes in `routes/friends.js`
  (`POST /`, admin `PATCH /:id`, friend `PATCH /:id/profile`) — grep the string, re-word every hit or none (FUP-T21).
- Never `maximum-scale=1` / `user-scalable=no`; iOS zoom is handled by A12 (16px inputs under `pointer: coarse`).
- Text: `min-w-0` is not `overflow-wrap` (set `overflow-wrap:anywhere` on the container); `€` on item lines,
  `EUR` on totals; kg display `Math.round(g/10)/100` with trailing zeros stripped; ordinary space before `€`.
- Preflight `svg{display:block}` breaks inline icon+text — fix at the call site with `inline-flex`.
- Guest surface (`GuestOrder.vue`, `GuestOrderStatus.vue`) deliberately lags the friend skin in places; it is
  not the reference when restyling.

### Documentation discipline
- A rule stated as a guard/grep must enumerate EVERY file that edits the column, and a superseded claim must be
  rewritten in EVERY copy (this file, code comments, spec supersession maps, e2e assertions) — grep `e2e/` rather
  than trust a map. Mark superseded notes with ~~strike~~ + pointer rather than deleting them.

## Running the e2e suite (every point here has produced a false result)

Full recipe and env in `e2e/README.md`. Checklist:
- `cd e2e && npx playwright test …` — from the repo root you get **`No tests found`, which is NOT a pass**. Any
  wrapper must assert an `N passed` (N>0) summary and no `N failed`; never grep for `✘` (reporter-dependent).
- **`--workers=1`** for any multi-file batch (one global admin token; parallel files clobber it → mass 401s).
- Gate server: `BASE_URL=http://localhost:3997` (never the IP — CORS/crossorigin → CSS 500), `CORS_ORIGIN`
  including that origin, fresh `DB_PATH` under the scratchpad + `node e2e/seed.mjs`, `GOOGLE_CLIENT_ID=test-client
  GOOGLE_AUTH_TEST_MODE=1`, and ALL FIVE `RATE_LIMIT_*_MAX` raised (`rate-limit*.spec.js` / `magic-link-rate-
  limit.spec.js` then self-skip — the documented skips). Build `frontend` first; a missing `backend/public` answers 503.
- Kill the old server BY THE PID OWNING THE PORT (`ss -lptnH 'sport = :3997'`), confirm the port is free, then
  start — `pkill -f` self-matches and a stale server measures deleted code. Background it with `setsid … </dev/null`.
- Pipe output to a FILE, not `| tail`. Check `echo "EXIT: $?"` of the test command itself.
- Never run the full suite per task: targeted spec files per row, full suite at module milestones. Full run
  ~11 min; on this 4 GB/2-core box Chromium SIGSEGVs (exit 139) non-deterministically — confirm a suspicious
  failure by running its file alone, twice, on a fresh DB.
- Spec hygiene: refusal tests read the row back; absence assertions need a non-vacuity gate; Playwright role
  names match as case-insensitive substrings unless `exact: true`; `innerText` applies `text-transform`;
  NBSP survives regex `toHaveText`; `li` counts must be `li.ln`; UI+API admin tests must adopt the browser's token.
- `node:sqlite` (test helpers) and better-sqlite3 (routes) report DIFFERENT constraint error codes — verify a
  constraint guard against the driver the route loads.
