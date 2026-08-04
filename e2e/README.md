# Gorifi E2E Tests (Playwright)

Target-agnostic end-to-end tests. They validate the Phase 1 security fixes
(server-side admin authorization, no credential leakage, CORS lockdown) plus
public-flow smoke tests and the admin login/guard/logout UI flow.

## Layout

- `tests/api-security.spec.js` — API-level: admin endpoints 401 without a token,
  public endpoints stay 200, valid token unlocks, no `access_token` /
  `password_hash` / `invite_code` in responses, CORS lockdown.
- `tests/admin-auth.spec.js` — UI: router guard redirect, login success/failure,
  data loads through the admin token, logout re-protects.
- `tests/public-flow.spec.js` — UI: friend portal + admin login load, SPA fallback.
- `tests/item-packed.spec.js` — GSO-T1: per-item packing persistence
  (`order_items.packed`) and the whole-order "Zabaliť" gate (API-level, plus a
  UI-level pass on the Distribution page: checkbox persists across reload,
  button disabled until every item is checked).
- `tests/guest-link.spec.js` — GSO-T2: the host's guest share link
  (`guest_order_links`) — create, regenerate (new token, same row id, so
  sub-orders survive), deactivate/reactivate, unknown cycle 404 — plus the auth
  boundaries (anonymous 401, shared-password-without-identity 401, foreign
  friend 403) and a UI pass on BOTH share entry points — the FriendOrder card
  and the FriendPortal cycle card (which must not appear on a locked cycle, and
  must not navigate into the cycle when clicked), incl. a stale-response race
  test: one dialog is reused across cycles, so a `page.route`-delayed GET for a
  closed cycle must not swap in its link (and its buttons must not act on it).
- `tests/guest-order.spec.js` — GSO-T3: the public guest ordering surface
  (`GET /api/guest/:token`, `POST /api/guest/:token/orders`) — link resolution
  (200 / 410 deactivated / 410 non-open cycle / 404 unknown token), identity
  validation (name + mobile required, ≥9 digits), a successful submit with
  frozen marked-up prices + `order_token` + payment info, the 409 lock race,
  and the **stock-limit UNION in both directions** (a guest order shrinks the
  friend-side availability and cart/submit gates; a friend order shrinks what a
  guest can submit). Plus a UI pass on `/g/:token` — which needs **no** auth
  workaround at all, since the page is genuinely public: cart, blocked submit,
  confirmation (payment reference + personal status URL + localStorage), bakery
  variant grouping, and the dead-link page.
- `tests/guest-status.spec.js` — GSO-T4: the guest's personal status/edit URL
  (`GET/PUT /api/guest/:token/orders/:orderToken`). The PAIR of tokens is the
  credential, so a real order token under a **different** link token must 404
  (same message as an unknown one — no existence oracle). Covers the three
  lifecycle decisions: `cancelled` is terminal (a PUT gets 409, it is not
  revived), an **explicit** empty cart ⇒ `cancelled` + total 0 + **stock
  released** while the item rows are KEPT (so the release is proven to come from
  the `<> 'cancelled'` status predicate in `helpers/stock.js`, not from deletion),
  and a locked cycle makes the page read-only — `GET` still 200s while the
  product listing 410s, `PUT` 409s. Because cancelling is irreversible, one test
  pins down that **only** a literal `items: []` triggers it: `PUT {}`, a bodyless
  `PUT`, a non-array `items`, and a non-empty `items` in which nothing prices are
  all non-destructive 400s. Plus the `excludeGuestOrderId` seam (a re-save at the
  stock limit must not block itself, while another guest's grams still count),
  the GSO-T3 bounds re-applied to the edit, and a UI pass on
  `/g/:token/o/:orderToken` (items/total/flags, "Zaplatiť" → PaymentModal,
  editing through the shared `GuestProductGrid` — incl. bakery variant grouping,
  since this is the grid's second consumer — the cancel confirmation, and
  read-only when locked).
- `tests/guest-host-view.spec.js` — GSO-T5: the host's "Objednávky kolegov" view.
  The enriched `GET /api/guest-links/cycle/:cycleId` (each sub-order now carries
  its `items`, plus `paid` read-only and `delivered`, with `order_token` still
  unexposed), and the two HOST-owned mutations on
  `/api/guest-orders/:id` — `PATCH .../delivered` and `DELETE`. Pins down
  Decision 2's single ownership from both sides: `delivered` toggles on/off
  (setting and CLEARING `delivered_at`, and still available after the lock,
  because the hand-over happens after distribution), while a host token cannot
  write `paid` — nor `status`/`total`/`link_id` — through the delivered body, and
  an **admin token is not a substitute for host identity** on either route
  (anonymous 401, shared-password-without-identity 401, foreign friend 403,
  missing row 404 before any 403). `DELETE` is a **soft cancel**: status
  `cancelled`, total 0, item rows KEPT, stock genuinely released
  (`remaining_g` recovers and is buyable again), refused with 409 once the cycle
  is not open, and idempotent on an already-cancelled sub-order. The T4↔T5
  handshake is asserted end to end — after a host removal the guest's own status
  URL renders cancelled and a `PUT` cannot revive it. Also covers the case
  GSO-T4 left open: a **regenerated** link (new token, same row id) still
  resolves an existing sub-order's status URL while the retired token 404s. UI
  pass on the section in FriendOrder: sub-orders with their items, a read-only
  paid badge (and no paid control), the delivered checkbox toggling and
  surviving a fresh load, and a removal rendering as "Zrušené". Note: the
  durability step re-enters through the portal rather than `page.reload()`,
  because a hard load of `/cycle/:id` bounces to the portal by design.
  One describe (`DELETE — a PAID sub-order is the admin's business`) pins the rule
  that a host may **not** soft-cancel a sub-order the admin already marked paid
  (409 `reason: 'paid'`) — cancelling zeroes the total and drops the row from every
  "not cancelled" aggregate, so paid money would go invisible. `paid` has no HTTP
  setter until GSO-T6, so that test pre-sets the flag directly in the server's
  SQLite file via `node:sqlite` and therefore needs **`DB_PATH` exported for the
  Playwright process too** (same value as the server's — see the recipe below); it
  self-skips when the file is unreachable, e.g. against staging.
- `seed.mjs` — seeds a backend with an admin password, legacy friends password,
  one cycle, one friend (idempotent; NOT for production). Also fills the payment
  settings (IBAN / Revolut username) **only if they are empty**, because guest
  confirmation needs them — a real environment's values are never overwritten.
- `fixtures.js` — credentials/constants, overridable via env.

## Run against a local prod-like backend

```bash
# from repo root: build the frontend into backend/public, run backend on one port
cd frontend && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public && cd ..
DB_PATH=/tmp/gorifi-e2e.sqlite PORT=3997 CORS_ORIGIN=http://localhost:3997 node backend/src/index.js &

cd e2e
npm install && npx playwright install --with-deps chromium
BASE_URL=http://localhost:3997 node seed.mjs
# DB_PATH is the same file the server was started with; guest-host-view.spec.js
# needs it to pre-set the admin-only `paid` flag (it self-skips without it).
DB_PATH=/tmp/gorifi-e2e.sqlite BASE_URL=http://localhost:3997 npm test
```

Two gotchas in that recipe that look like app bugs when you skip them:

- **`CORS_ORIGIN=http://localhost:PORT` is required**, not optional. The built
  SPA uses `crossorigin` script tags, so serving it from `backend/public` on a
  bare `localhost:PORT` without that origin allow-listed makes the asset
  requests 500 — every UI spec then fails on a blank page.
- **Start a fresh server.** A backend left running from an earlier session keeps
  serving from a `backend/public` whose hashed asset files have since been
  replaced under it (`rm -rf` + rebuild), so `express.static` 500s and the UI
  specs fail for reasons that have nothing to do with your diff.

### Friend-portal UI specs need the friend list stubbed

`FriendPortal.loadInitialData()` resolves a stored friend session against
`GET /api/friends?active=true`, which is `requireAdmin`-gated (SEC-A*) — an
anonymous browser gets 401, the call throws, and the portal falls back to the
login card with an empty name dropdown. So a browser cannot reach any
friend-authenticated page (`/cycle/:id` bounces to `/` unless auth is already in
memory) purely through the UI. This is a **pre-existing app-side gap**, not a
test-harness one, and it is why `forced-change-ui.spec.js` is `test.fixme`.

Until it is fixed, friend-UI specs seed `localStorage.gorifi_friend_auth` with a
real session token and `page.route`-stub only that one friends-list response —
see `guest-link.spec.js`. Everything actually under test still talks to the real
backend with the real Bearer token.

### Full-suite runs and the shared auth-limiter budget

`authLimiter` (`backend/src/middleware/rate-limit.js`) guards both
`/admin/login` and `/friends/auth` behind ONE shared per-IP bucket
(`RATE_LIMIT_AUTH_MAX`, default 20 per 15 min window). Every spec runs from
the same test-runner IP, and several specs each perform their own
login/friend-auth calls — run the **full** suite repeatedly against the same
long-lived server (e.g. iterating locally without restarting it) and the
shared bucket exhausts, producing real `429`s that look like unrelated
failures (wrong-password checks, invite-code lookups, `item-packed.spec.js`'s
`beforeAll` admin login, etc.) even though nothing is actually broken. This
is suite/environment fragility, not a spec bug — a single run against a
freshly-seeded server passes cleanly.

Mitigations:
- Prefer a **fresh** DB + freshly-started server per full-suite run (matches
  the recipe above) rather than re-running against a server that has already
  served many earlier runs.
- If you must re-run repeatedly against the same long-lived server, start it
  with a generous budget, e.g. `RATE_LIMIT_AUTH_MAX=1000`, to get a true
  pass/fail signal (`rate-limit.spec.js` still self-skips above 10, so this
  doesn't weaken that check).

The same applies to `abuseLimiter` (`RATE_LIMIT_ABUSE_MAX`, default 40 per IP per
window), which is ONE bucket shared by the public invite-code lookup, onboarding
submit and — since GSO-T3 — every `/api/guest/:token` call. `guest-order.spec.js`
alone makes ~35 of them, so a full-suite run against the default budget can 429
in unrelated-looking places. Run the suite with a generous budget:

```bash
DB_PATH=/tmp/gorifi-e2e.sqlite PORT=3997 CORS_ORIGIN=http://localhost:3997 \
  RATE_LIMIT_AUTH_MAX=1000 RATE_LIMIT_ABUSE_MAX=2000 node backend/src/index.js &
```

## Run against staging

```bash
cd e2e
# staging must already be seeded; pass the real credentials so auth'd tests work
BASE_URL=https://gorifi-dev.skolar.sk \
  ADMIN_PASSWORD='<staging admin pw>' \
  FRIENDS_PASSWORD='<staging friends pw>' \
  FRIEND_NAME='<an existing friend>' \
  CYCLE_NAME='<an existing cycle>' \
  npm test
```

Without staging credentials you can still run the anonymous checks, which must
all pass once Phase 1 is deployed:

```bash
BASE_URL=https://gorifi-dev.skolar.sk npx playwright test api-security \
  --grep "without an admin token|stays public"
```
