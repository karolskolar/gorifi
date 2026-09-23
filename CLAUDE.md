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
| Payment links, variable symbol, `payment_creditor_name` (module 15) | `docs/learnings/07-payment-links.md` |
| Distribution pipeline: hand-over, the board, the outbox enqueue, the cycle header (module 16) | `docs/learnings/08-distribution-pipeline.md` |
| Portal IA: the four friend routes, `resolveLanding`, `lib/dates.js`, the `portal-landing` gate, the appbar per state + the drawer / `useModalLayer()`, the „Ako to funguje" explainer + `lib/roasters.js`, the first-login gate + `explainer_seen_at` (module 18) | `docs/learnings/10-portal-ia.md` |
| Cycle stages: the three `order_cycles` columns, `markCycleReady()`, the `POST/PATCH /cycles` contract, `lib/cycle-stages.js` + `CycleTimeline.vue`, the admin date/stage controls, the guest „Kde je vaša káva" card (module 17) | `docs/learnings/09-cycle-stages.md` |
| Standing guest link: `friends.guest_link_token`, `helpers/standing-link.js`, the host + admin standing routes, `guest_waitlist`, `waiting_count`, cross-space token uniqueness (module 19) | `docs/learnings/11-guest-standing-link.md` |
| Guest Packeta: `guest_orders.delivery_fee` / `packeta_address` / `delivery_fee_paid`, the submit's delivery block, `guestPaymentBlock().amount = total + fee`, the mail fee/point rows (module 20) | `docs/learnings/12-guest-packeta.md` |

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
  unauthenticated write. Treat it as hostile input (bounds: ≤100 lines, qty ≤100, name 120 / phone 32 / email 160 / Packeta point 160).
  Public guest routes must never join `ADMIN_ENDPOINTS`.
- Host identity = Bearer session via `requireHost()`; never read `friend_id` from a body (SEC-A1 IDOR).
  `requireFriendOwner` yields `friendId: null` under shared-password auth — ownership guards are meaningless
  while the shared password can mint anyone's session, so any route that WRITES a credential needs the
  modern-mode 409 guard (GA-T5). An admin token is not host identity.
- `/g/:token` is a per-cycle `guest_order_links.token` OR a standing `friends.guest_link_token`, resolved by ONE
  `routes/guest.js resolveEntry()` (19 §UC-GL-002, GL-T2): a standing hit GETS-OR-CREATES the host's per-cycle row
  for the newest open round (never echoes either token — the per-cycle token NEVER reaches a standing visitor, so a
  standing rotation fully revokes it for new visitors), a legacy hit on a non-open cycle is the STALE pre-open page
  and never resolves to a newer round (D7); the listing's only 410 is `inactive`, submit keeps 409 `closed`.
- `order_token` alone resolves a guest order (module 14); `routes/guest.js` is the ONLY place it authenticates.
  It is published to host/admin surfaces via the shared `GUEST_ORDER_FIELDS` but never rendered into DOM
  attributes (compose the URL in JS at click time). Every miss answers the same uniform 404 (no oracle).
- `sanitizeFriend` strips CREDENTIALS only; audience-scoped fields (e.g. `display_name`) are deleted in their
  route. `friends.invite_code` never reaches a friend or guest payload — the guest CTA has its own endpoint for that.
- `friends.guest_link_token` (19 standing link) is `invite_code`'s class: stripped by `sanitizeFriend`, never in
  `routes/guest.js` LINK_SELECT, published ONLY by the FOUR standing routes — host `GET /guest-links/standing` +
  `POST …/standing/regenerate`, admin `GET /friends/:id/guest-link/standing` + `POST …/regenerate` (both GETs mint
  lazily; an inactive friend is never MINTED one, 409 `inactive_host`, but may be rotated); `helpers/standing-link.js`
  is its only writer and mints EVERY link token (`uniqueGuestToken()`, unique across BOTH spaces — never a one-table
  retry). No modern-mode guard: not a login credential. ~~⚠ Not in the e2e scrub yet — BLOCKING on GL-T6 (GL-T1).~~
  **Scrubbed since GL-T6** (NULLed + checked, with `guest_waitlist` name/phone/e164) — so `make-test-db.sh` FAILS
  CLOSED until PRODUCTION carries the GL-T1/GL-T3 migrations (`e2e/README.md`, learnings 11 §GL-T6).
  Admin surfaces never RENDER it (`FriendDetail.vue` copies `origin + url_path` at click); opening that page MINTS it — a PO-visible back-fill (GL-T6).
- `guest_waitlist` (19, GL-T3): `helpers/guest-waitlist.js` is its ONLY writer (signup/re-arm, both purges, admin DELETE); `notified_at` gets a timestamp from module 21 ONLY (19 resets it to NULL); `helpers/phone.js toE164()` is the ONE E.164 normaliser (`parsePhoneNumber` nowhere else); the public `POST /api/guest/:token/waitlist` answers ONE 200 for create AND duplicate (no oracle) and never joins `ADMIN_ENDPOINTS`; its rows are non-member PII — ~~⚠ not in the e2e scrub yet, exact lines on the GL-T6 row (BLOCKING).~~ **scrubbed since GL-T6a (name/phone/e164 — learnings 11 §GL-T6).** No COMMENT in `routes/guest.js` may say async/await either: the D11 pin greps it raw.
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
- Server length bounds are mirrored as `maxlength` in the UI. (⚠ `#pp-profile-name` had NO
  mirror at all until PI-T10 added its 120 — the rule had a hole on the one required field.)
- `PATCH /friends/:id/profile` is the ONE writer of `friends.packeta_address` in `backend/src`
  (no admin route and neither `INSERT INTO friends` touches the column), so its **160** bound
  lives there and NOT in the shared `validateAdminFriendFields`; `orders.packeta_address` is a
  different column with its own rule. Same place, same reason: `phone` blank ⇒ 400
  `{field:'phone'}` on THAT route only — the ADMIN PATCH may still clear a phone, and both
  halves are pinned (PI-T10). FUP-T12's „a non-string packeta_address = an absent key" stands.

### Money & data
- `transactions` rows come ONLY from the friend paid toggle and pack/unpack (`orders.total`, never
  `delivery_fee`). Guests have no balance: guest paid toggle, pickup PATCH, friend creation write NO ledger row.
- Hand-over (`handed_over_at`, stage 3) is LEDGER-NEUTRAL — `packed` is the money moment — and writes no
  `order_cycles.status`: the admin's „Ukončiť objednávku" button is the only way a cycle becomes
  **`completed`** (lock / unlock / open-for-ordering write the other values), gated in the UI only
  (PO 2026-09-19: the API still completes a cycle with un-handed bags — an escape hatch, pinned by e2e).
- ONE HOME each — never re-inline: `helpers/stock.js` (stock UNION own+guest), `helpers/pricing.js` (variant→price;
  unknown variant is DROPPED, never fallback-priced; `unit` is priceable but zero-gram), `helpers/packing.js`
  (packed gate), `helpers/guest-aggregation.js` (guest UNION for aggregates), `rewards.js` (reward volume),
  `helpers/pickup.js` (which row stores a party's pickup — and `pickupLocationInUse()`, the same
  two-store rule asked as "is this point referenced?"; `DELETE /api/pickup-locations/:id` soft-deletes
  off THAT answer and never counts `orders` alone — FUP-T23; plus `activeLocation()`, the SEPARATE
  question "is this point choosable?" (`active = 1`) — the two are NEVER merged: one is broad and fails
  CLOSED, the other narrow and fails to `null`. BOTH writers of `pickup_location_id` — `POST …/submit`
  and `PATCH …/pickup`, the only two — call `activeLocation()`; a grep for that SELECT returns one hit,
  comments included, and a mutation in it must redden both — FUP-T25), `guestPaymentReference()` (stays in
  `helpers/guest-orders.js`), `helpers/payment.js` (variable symbol — friend = order id, guest = `9`+6-digit
  id, balance = `8`+6-digit id, DERIVED never stored; anything but an integer `0 < id < 1e6` — a float, a
  numeric STRING, `0`, a negative, a missing argument — yields `''`, never a guessed VS; the ONE
  `paymentSettings()` reader + the three `SETTING_*` key constants reads AND writes share;
  `guestPaymentBlock()`, whose `amount` is the module-20 seam, is THE composer of the guest `payment`
  block — `routes/guest.js` composes none of its own (status payload, submit 201 and the confirmation
  mail all quote that one object) — and `balancePaymentBlock()` likewise owns the balance one, sign flip
  and rounding included). No `padStart(6` and no `payment_iban` literal outside it in `backend/src`.
- Module 17's home: `helpers/cycle-stage.js` — `CYCLE_STAGES` + `LOCKED_STAGE_DEFAULT` (the enum the
  route, the helper and schema.js's CHECK all read) and `markCycleReady()`, whose predicate is
  `status='locked' AND (stage IS NULL OR stage <> 'ready')` — ⚠ `stage IS NULL` COUNTS (no backfill, so
  it is every locked cycle in prod; the DP-T1 stub's `stage IN ('ordered','arrived')` is SUPERSEDED),
  it writes `stage` and nothing else, ever — never `status`, never a ledger row — and it returns
  `{ changed, stage }` while the published `cycle_stage` is the STRING: all three hand-over routes read
  `.stage`. ⚠ The lock default (`stage='ordered'`) fires from `open` ONLY — §UC-CS-002's table scopes
  it „INTO locked from `open`", and the shipped `!== 'locked'` also fired from `completed`, RESETTING a
  handed-out round from `ready` to `ordered` on the admin's own `completed → locked` recovery path
  (FUP-T26). `locked → planned` and `completed → open` keep their stale stage DELIBERATELY (the table
  leaves both alone; `stageIndex()` reads `status` first, so neither reaches a screen) — all three are
  pinned API-level, and a fixture whose stage already equals the default proves nothing. A locked cycle
  with `stage IS NULL` is now reachable (`planned → locked`), but its test still builds the row directly.
  `order_cycles` ALTERs go AFTER schema.js's `_check_test` recreate block (it rebuilds from a hard-coded
  column list; anything added before is dropped — and it would itself crash on a DB old enough to fire it,
  recorded not fixed). `stage` is enum-checked BEFORE the write (a CHECK throw is a 500), NOT via
  `bindValue`; the two DATES do use `bindValue` (unbindable ⇒ skip) but a finite NUMBER passes it and must
  still 400 `Neplatný dátum`. `dates_order` compares the row AS IT WOULD BE; the `not_locked` 409 is
  checked FIRST, so `{status:'open',stage:…}` writes neither.
- The LOCKED landing's own-order card writes NO ledger row (§UC-PI-007): `paid` renders read-only
  (admin-only), `paymentTotal` = goods + `delivery_fee` for DISPLAY, the VS is quoted from the server's
  `payment` block. ⚠ `paymentTotal`'s ITEM source branches on `isReadonly` — `readonly` clears the cart by
  design, so a locked screen sums the SUBMITTED lines — but it stays ONE computed that the card, the button,
  the QR and `PaymentModal` all read. The card reads `FriendOrder`'s loaded order through
  `defineExpose({ownOrder, openPaymentModal})`: no second loader, no second `PaymentModal` (PI-T5).
- `GET /orders/cycle/:id/friend/:id` publishes a TOP-LEVEL `pickup` block from `helpers/pickup.js pickupOf()`
  (never spliced into the `SELECT *` order row, like `payment`; never `readPickup()` — the route already holds
  the `orders` row, which is the store that wins) and `p.purpose` on its items (`CartLineList` groups by it,
  and PI-T6's history has no catalogue to look it up in). The badge shows exactly one of location name /
  note / „Packeta · {address}"; the name must come from that block, not from the ACTIVE-only picker feed.
- Module 16's homes: `helpers/delivery.js` (which TARGET a party is on — read-only, never imports
  `pickup.js`), `helpers/handover.js` (stage vocabulary + hand-over binder), `helpers/outbox.js` (the only
  `notifications` writer), `lib/plural.js` (count-agreeing Slovak forms), `lib/distribution-plan.js` (the
  cycle header's plan sentence + the completion gate, shared by `CycleDetail.vue` and the board).
- CLIENT payment links have ONE home too: `frontend/src/lib/payment-links.js` (`revolutLink` amount variant
  behind `REVOLUT_AMOUNT_LINK`, `paymeLink`, `payBySquarePayload` = the shipped bysquare object with EXACTLY
  `variableSymbol` + `beneficiary.name = creditorName || 'Gorifi'` changed; relative `./money.js` import so
  plain `node` can drive it; never imported by an admin view). ⚠ EVERY value interpolated into a URL goes
  through `encodeURIComponent` — the creditor name is length-validated only, so `&`/`#`/`+`/`%`/newline are
  this file's problem; pin the parameter KEY SET, not the value (raw interpolation grows a key). ⚠ But encode
  VALUES, never STRUCTURE: PayMe's `PI=/VS<vs>/SS/KS` slashes stay BARE (a bank app may split the raw query),
  only the symbol between them is encoded — and a `searchParams.get()` assertion DECODES, so a wire format
  needs a raw-segment pin, never a round-trip one. Gate each control on its composed href, never on the raw
  prop: an empty `href` is a link to the current URL, i.e. a reload that discards g-confirm's state.
- `PaymentModal.vue` props are ADDITIVE, not frozen (15 D4: `variableSymbol`, `creditorName`; the struck claim
  is rewritten in ALL SIX copies — 06 §UC-GX-005, the component header, 15's header, 18's §Out of scope + its
  §Procedure, 20's surface table; `grep -rn frozen` found them, a list did not). The PayMe bar is `v-if` on
  `(pointer: coarse)` — a CSS-hidden `<a>` counts as a second Revolut bar in the `.m-body` order pin. `€` on
  lines / `EUR` on totals applies to the Revolut label's amount suffix too.
- Every payment SURFACE quotes the server's block; no client derives a symbol. `FriendOrder.vue` reads
  `payment.variable_symbol` off the last order GET/PUT/submit (`''` when `payment` is `null`), never from
  `order.id`; ~~`FriendBalanceCard.vue` is the ONE home of the balance trigger + `PaymentModal` mount~~
  **— RELOCATED by PI-T7 exactly as that clause promised (18 §UC-PI-008/010): the balance is one debt with
  TWO surfaces on two views, so `FriendPortalSession.vue` holds the ONE `<PaymentModal>` mount, the ONE
  `getFriendBalance()` call and `openBalancePayment()`; `FriendBalanceCard.vue` (now on `/zostatok`, props-fed,
  no fetch) owns the ONE `data-testid="pay-balance"` control and `DebtBanner.vue` (three landing call sites,
  `balance < -0.01` written once inside it) owns `debt-banner-pay`. Both call that one function.
  `FriendTransactionsModal.vue` is DELETED; `FriendTransactionList.vue` is its verbatim row markup. Counts are
  pinned in SOURCE per file (`portal-balance.spec.js` §6) because a second mount is invisible in the DOM.**
  It clears `payment` BEFORE
  each read (defence in depth for an in-place `friendId` change + the failed-reload gap — CROSS-SESSION is
  structural: `FriendPortal.vue` mounts `FriendPortalSession` with `v-if` + `:key`, which DESTROYS the
  subtree on logout, and that `v-if` is the six-leak guard), and does NOT reload on close — module 15
  writes no ledger row. ⚠ Entering `/zostatok` DOES re-read the balance (18 §UC-PI-010) — that is the VIEW's
  rule; „one request per session load" (§UC-PI-004) is the LANDING's, and `payment-links.spec.js` pins the
  landing count at exactly 1. `.neg.pill` / `.zero` now have no renderer left (the card paints one 38px
  `.display`); they stay in the canon-ported theme.
  `FriendOrder`'s success modal shares `payBySquarePayload`/`revolutLink` but carries NO VS row and NO PayMe.
- VS payloads GROW, never move: guest block 6 keys — `amount`, `reference`, `iban` AND
  `revolut_username` all stay byte-identical (name every one; a rule stated narrower than what it
  protects reads as licence to move the rest) — friend order
  `payment:{variable_symbol}` only (no IBAN — `money-rounding` mocks `payment-settings`) and `null` with no
  order, balance `payment.amount = max(0, -balance)`. Admin rows carry `variable_symbol`, `null` on a
  placeholder; `CycleDetail` renders it only behind `isOrdered` (a DRAFT is not a debt). Mail carries the VS
  as TEXT — no `revolut.me`/`payme.sk` URL ever (08 one-origin pin).
- `variantGrams()` stays own-property + type safe; stock compares `!(a + b <= limit)` so NaN fails closed.
- Guest aggregates: CYCLE-level totals include guests; per-FRIEND aggregates never do. Merge the guest half in
  JS, never as a second `LEFT JOIN` on `orders` (row multiplication corrupts `orders_count`); cycle-level guest
  counts use correlated subqueries. Guest kg lives in its own map (`guestKgMap`) — folding it in doubles money.
- Guest cancel = `status='cancelled'`, `total=0`, `delivery_fee=0` (GP-T1), item rows AND `packeta_address` KEPT;
  every consumer filters on status. `cancelled` is terminal. Destructive guest edits require a literal `items: []`. A paid sub-order is frozen for item edits
  (`items_editable`) but cancellable → refund queue; host DELETE refuses 409 `paid`.
- Guest Packeta (module 20): `packeta_address IS NOT NULL` is THE marker (never `delivery_fee > 0`); `total` stays
  product-only, the fee is `roundMoney(cycle.parcel_fee)` re-read inside the submit tx; `use_parcel_delivery` is a
  STRICT boolean; `delivery_fee_paid` has TWO writers — the soft cancel + the paid toggle, frozen at the first of {paid, cancel}
  (~~ONE writer~~, orchestrator 2026-09-23 pending PO; learnings 12 §6).
- `delivered` is host-only, `paid` admin-only. Name literal columns; never spread a request body into an UPDATE.
- Share-link regeneration UPDATEs the token in place (DELETE+INSERT cascades away every sub-order).
- Guest edit PUT delivery block (GP-T2, learnings 12 §9–11): only beside a NON-EMPTY `items` and AFTER the paid 409; flag absent/`null` ⇒ both columns untouched; `guest_email`'s only edit write is the Packeta switch's `… WHERE guest_email IS NULL` (write-once, D3) — a body e-mail beside a stored one is ignored, never validated.
- Pickup: `orders` row if one exists (any status), else `guest_order_links`; no cycle-open gate; exactly one of
  `pickup_location_id`/`pickup_location_note`; switching Packeta → pickup zeroes `delivery_fee` (ledger-neutral).
- Guest tables live in `schema.js` CREATEs; new columns on tables already in prod need CREATE **and** ALTER.
- SQLite: `WHERE col = ""` is an identifier and throws — use `''`. Single-row picks on second-resolution
  `created_at` need `, id DESC`. `orders` has no `UNIQUE(friend_id, cycle_id)` — get-or-create relies on `instances: 1`.
- Friend creation via `POST /api/friends` sets no credentials; logins come only from approve / set-username / reset.
- The profile modal AUTO-OPENS for a friend with an empty `phone` (18 §UC-PI-015, PO 2026-09-19).
  ⚠ Trigger = `entry.freshLogin`, which `beginSession` takes from the THREE **login** paths only —
  a RESTORE is not a login, so a reload/deep link never re-opens it (§UC-PI-013's boundary, and the
  measured difference between 16 and 53 exposed spec files). The decision waits on
  `hydrateCurrentFriend` and asks `hasOwnProperty(friend,'phone')`, never truthiness (no phone key
  until the fetch lands). Dismissal = `profileAutoOpenArmed`, a session-side `ref`, lowered on open.
  ⚠ Precedence here IS coded — the OPPOSITE of PI-T9's explainer, because this is a `NeoModal` that
  would STACK on a non-dismissable gate rather than a view it could wait under. ⚠⚠ **The term list is
  DERIVED, never maintained by hand — it was wrong in review TWICE.** The derivation: walk every overlay
  MOUNT in `FriendPortalSession.vue` (~~`<NeoModal>`, `<LandingStateModal>`, `<NeoDrawer>`, the teleported
  `fixed inset-0` div~~ **every `*Modal`/`*Dialog`/`*Drawer` component and `fixed` element, any shape — that
  four-shape list missed `<PaymentModal :open>`, the TENTH mount, PI-T12**) and ask „can it raise with NO
  friend action?" SEVEN can — forced-password,
  credential-setup, Google prompt, explainer, `showClosedModal`, `showLockedModal` and **`showVoucherModal`**
  (whose `z-50` teleport the `z-index:200` profile modal paints OVER: measured `elementFromPoint` →
  `INPUT.inp` on top of a one-shot irreversible decision) — plus `showProfileModal`, a term of a DIFFERENT
  kind (it may already be OPEN, and `openProfileModal()` re-seeds every field). The surface in front WINS
  and the profile modal queues behind it. `portal-profile-modal.spec.js` PINS THE WALK IN SOURCE, so an
  eighth self-raising overlay reds instead of stacking — and (PI-T12) PINS THE COUNTS (10 mounts, 8 terms)
  and the exact derived term set, so a term added or dropped reds too; each term also has a behaviour test
  that reds when that ONE term is deleted. `showInviteModal`/`showBalancePayment`/the drawer need a click;
  `showPasswordChange`/`showPasswordSet` are folds; `showMagicPrompt` is a banner — none are terms.
- `friends.explainer_seen_at` (18 §UC-PI-013): NO back-fill, ever — every existing friend meets the explainer once.
  `POST /:id/explainer-seen` is the ONE writer (`requireFriendOwner` + the `friendId: null` 401, `COALESCE` so a
  second call never moves the stamp, no body, no limiter); nothing clears it and no admin route touches it. It rides
  the friend object of the FOUR **login** payloads only (`friends.js` ×3 + `magic-link.js`) — a session RESTORE is
  not a login and must never open the gate, which is what keeps ~32 localStorage-signed-in spec files measuring
  their own screen — and is why `routes/onboarding.js`, a FIFTH session mint with no `friend: {` for the
  prescribed grep to see, deliberately carries no such field (a registrant meets the explainer at the NEXT login).
  ⚠ E2E: `seed.mjs` pre-stamps the seeded circle except `E2EExplainerGate` (needs `DB_PATH`, and a `DB_PATH` that
  is not the database `BASE_URL` serves is refused with **exit 1** — a `console.log` was not enough, because the
  one caller the check exists for spawns the seed with `stdio: 'ignore'`), and
  a fixture that UI-logs-in a freshly created friend calls `helpers/portal.js ackExplainer()` — otherwise it lands
  on `/ako-to-funguje`, where the hamburger is a back chevron and `openMenu`/`logout`/`openProfile` time out.
  ⚠ **SAME SHAPE, SECOND FIXTURE FACT (PI-T10): a fixture friend that logs in through the CARD also needs a
  `phone`** — `POST /api/friends { name, phone }` — or the profile modal opens by itself over the drawer those
  helpers reach for. ⚠ **The 76 TEMPLATE rows all carry a phone; `seed.mjs`'s OWN TWO friends do not** —
  `E2ETester` (`:109`) and `E2EExplainerGate` (`:128`) are created with `{ name }` alone and the template holds
  no `E2E*` row at all, so „the seeded circle is immune" (PI-T10's first wording) is FALSE for exactly the two
  friends a spec is most likely to reach for. `E2ETester` is explainer-pre-stamped, so a legacy card login as
  that friend (e.g. `magic-link.spec.js`) meets the auto-open; nothing is red today, which is why the rule and
  not the gate is what has to say so. A required field also reaches RESTORE-based specs, for a different reason:
  „Uložiť" is disabled on a phone-less friend. The AUTO-OPEN population is the CARD-login files, not the ~32
  localStorage ones — the trigger is `entry.freshLogin`. Carried in `portal-profile-modal` (`FIXTURE_PHONE`),
  `friends-consolidation` (`makeFriendWithSession`), `google-auth` (`GA_FIXTURE_PHONE`), `portal-appbar` and
  `portal-session-boundary` (`nextBoundaryPhone()`, unique per friend — it is a swept field value there).
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
  on a DIRECT child of `.app` silently compute `relative/1`. Overlays: `NeoModal`, `NeoDrawer`, radix `Dialog`, or
  `<Teleport to="body">`; never a hand-rolled fixed div at root. `.cartbar`/`.cat-tabs` survive only by cascade order.
- `<script setup>` has NO module scope: a singleton/guard/cache needs a plain `<script>` block.
- `components/neo/use-modal-layer.js` is the ONE home of what a `.modal-layer` surface DOES — body scroll
  lock (ONE module-scope counter across every surface), Esc, the capture-phase scrim-mousedown ORIGIN rule,
  the focus trap, the focus restore. `NeoModal.vue` and `NeoDrawer.vue` both call it; a third surface calls
  it too, never a second copy. `closable`/`trapping` are passed as GETTERS so both stay read at event time.
- The drawer is `v-if`-mounted and carries `role="dialog"` — 30 spec files resolve `getByRole('dialog')`, so
  a spec that counts dialogs while the menu is open is counting the menu; `v-show` there breaks all of them.
- The friend appbar's per-view chrome (subtitle, ticker, lock chip, menu-vs-back) is a `computed` the SESSION
  exposes (`defineExpose({ appbar })`) and `FriendPortal.vue` reads — never a ref in the parent, which
  outlives the session. `.appbar .titles .s` is the VIEW SUBTITLE (fixed strings); the friend's `name`
  renders in ONE place, the drawer header (`data-testid="drawer-friend-name"`), and no uid anywhere.
  `.titles` has no role/tabindex/aria-label in ANY state, and there is no logout glyph and no pencil.
- `friends-theme.css` is a byte-for-byte canon port with a numbered adaptation list (ends **A13** — the
  `portal2.css` canon sync, with its two recorded deviations D1/D2). New styling
  goes in `<style scoped>` (or a real canon sync), never ad-hoc theme edits. `line-height` often must be inline.
- One-home components — extend, never fork: `CartLineList.vue` (every ordered-items list — its PRESENTATION;
  `lib/order-lines.js` is the one home of the MAPPING into it: `lineSize`/`cartLines` (the live cart's
  already-marked-up `total`) / `orderLines` (a server `order_items` row's SNAPSHOT `price × quantity`, never
  re-priced from today's catalogue) / `deliveryExtras` (the fee is an EXTRA, never an item). Dependency-free,
  so a spec can import it with plain `node` — PI-T5), `GuestProductGrid.vue`
  + `lib/guest-cart.js`, `CatScrollArrow.vue`, `ProductImageModal.vue`, `GuestShareDialog.vue`
  (⚠ exactly ONE mount on the friend surface — `FriendOrder.vue`; the session reaches it through
  `defineExpose({openShareDialog})`, never a second instance, and the rule is SOURCE-pinned per file in
  `portal-landing.spec.js` because a closed second instance has no DOM signature — PI-T3; GL-T6c: via
  `shareHost` = whichever of `landingOrder`/`lockedOrder`/`closedOrder` is mounted, so the drawer row works on
  locked/closed too, and `FriendOrder`'s `shareCycleId` is `null` on a `readonly` mount ⇒ standing-only dialog),
  `FriendOrder.vue` (`mode='route'|'landing'`; the landing mounts it, never a fork — its landing wrapper is
  `display:contents` or `.cartbar`'s sticky clamps inside the subtree; `readonly` is LANDING-ONLY and is the
  ONE read-only catalogue rendering — `.p2-ro` on the CARDS wrapper only so `.cat-tabs` stays browsable, plus
  disabled steppers, no stock bars, no cartbar, no status banners — PI-T4),
  `lib/history-badges.js` (the SHORT „Moje objednávky" badges — ⚠ a SANCTIONED **second** status
  vocabulary, never merged with 17's long `cycle-stages.js STEPS`: two registers for two surfaces, not
  one fact twice; `status` before `stage` like 17; `portal-history.spec.js` §1 reds on a merge — PI-T6).
  ⚠ ~~„no
  tabgroup" is NOT a property of `readonly`~~ **SPLIT, PI-T5**: the four tabgroup sites (`.tabgroup`,
  `#panel-guests`'s `v-if`, `#panel-own`'s `v-show`/`role`/`aria-labelledby`) are on `hasTabs`
  (`= !isReadonly || props.colleaguesTab`), which asks „may this friend reach Kolegovia?" — the CLOSED
  catalogue passes nothing and has none, the LOCKED landing passes `colleagues-tab` and keeps them
  (hand-over ticks happen precisely then). It can only ADD tabs back to a read-only mount; the deep link
  and the open landing are unaffected. Collapsing the two names reds one landing or the other, and the
  caller is the only one who can tell them apart,
  `lib/roasters.js` (18 §UC-PI-014 — the TWO roaster descriptions + `roasterFor()`; dependency-free
  so a spec imports it. Consumers: `PortalExplainer.vue`, `FriendOrder.vue`, and GL-T4's
  `GuestRoastersLine.vue`. ⚠ NO ADMIN FILE EVER — roastery admin keeps its own data; the importer
  SET **and** the boundary are swept in `portal-explainer.spec.js` §7. Badge class: Goriffee plain,
  Robo `acc-o`, an UNKNOWN roastery keeps today's `acc-o` — and `role="button"`/`tabindex` go on the
  card badge ONLY on a match, with the JS guard in `openRoaster()` too, since a dispatched click
  ignores a missing role — PI-T8),
  `PortalExplainer.vue` (the WHOLE „Ako to funguje" view, `asGate` = PI-T9's first-login gate, never
  a second screen; it EMITS `done {hide}` and routes nothing. ⚠ `CycleTimeline` is NOT mounted here
  and that is §UC-PI-012 item 3, not an omission: an explainer describes the process, the timeline
  reports one round — `portal-explainer.spec.js` §1 reds both the import and the DOM. Packeta badge
  = `currentCycle ?? catalogCycle` (`currentCycle` is NULL under `closed`), ways from
  `api.getPickupLocations('coffee')` — the argument is load-bearing. The WhatsApp mention, „(PayMe)",
  „— Karol" and both roaster texts are PO copy: reproduce, never improve — PI-T8),
  `LandingStateModal.vue` (the landing's „Objednávky sú zatvorené/uzamknuté" modal; `title`/`intro`/`lead` are
  PROPS because PI-T5's no-order locked variant is the same modal with three strings — never a second one),
  `PickupLocationPicker.vue` (props `cycleId`+`friendId`, never an order id), `lib/plural.js`,
  `CycleTimeline.vue` (props `cycle`/`variant` `vertical|compact`/`steps`; ONE component for both
  variants, scoped styles with token FALLBACKS and no `.app`/`.modal-layer` ancestor — it renders in
  the portal, in the modal layer and in the shadcn admin header). ⚠ A consumer passes `:cycle` and lets
  the component call `timelineSteps()`; `:steps` is module 18's desc-injection seam ONLY, because the
  array's `state` field is where stage-first ordering gets back on a screen (CS-T3). ⚠ Its token
  FALLBACKS are measurable ONLY on the admin page (CS-T3's `.d`): `GuestOrderStatus.vue`'s root is
  `.app`, which DEFINES `--nb-ink:#0a0a0a` byte-identically, so a computed-style read of `.mk` there
  passes with every fallback deleted — pin the vertical variant's state vector, keys and labels
  instead (CS-T4). Its one vertical mount is that page's „Kde je vaša káva" card
  (`guest-timeline-card`, `cycle && !isCancelled`, INSIDE the read view so edit mode hides it).
- Portal IA (module 18): `/`, `/moje-objednavky`, `/zostatok`, `/ako-to-funguje` all mount
  `FriendPortal.vue` with `meta.view` and NO auth guard (anonymous ⇒ the login state on the SAME URL);
  `/cycle/:id` stays the standalone deep link and never gets a `meta.view`. EVERY piece of module-18
  state lives in `FriendPortalSession.vue` (the `:key="sessionSeq"` side) — never the parent, a plain
  `<script>` block or `localStorage`. `lib/portal-state.js resolveLanding()` is the one home of the
  landing state (`state`/`currentCycle`/`catalogCycle`/`nextCycle`/`nextText`/`nextOpening`;
  `currentCycle` is NULL under `closed`) and it DELEGATES — `nextText` to `nextOpeningText()`, the
  open→locked precedence + the two-open `[cycle-stages]` warn to `currentCycleFor()`, „newest" to
  `newestCycleWith()`. `lib/dates.js` owns the SHORT forms ONLY (`12. 9.` / `12. 9. 2026` /
  `piatku 12. 9.` / `weeksUntil`; an unparsable STRING renders raw, a non-string renders `''`); a date
  INSIDE one of module 17's composed sentences stays LONG (`fmtDay`, „3. októbra"). ⚠ The two specs
  disagree about that ONE sentence and PI-T1 kept 17's shipped form — PO decision pending, do not
  resolve it at a call site (learnings 10 §1). `data-testid="portal-landing"` on the session's page
  column is THE e2e „portal is ready" gate; specs reach it only through `e2e/helpers/portal.js`
  (`expectLanding`/`expectNoLanding`; PI-T2 adds the drawer helpers THERE, never a second module).
- Where a round IS: `lib/cycle-stages.js` is the one home of the six `STEPS`, their Slovak copy and
  `stageIndex`/`timelineSteps`/`fmtDay`/`daysUntil`/`inWeeksText`/`nextOpeningText`/`openUntilText`/
  `currentCycleFor`/`newestCycleWith`; it imports only `./plural.js` (which owns
  `daysLabel`/`weeksLabel`) so a Playwright spec can import it — this repo's substitute for a unit test. ⚠ `stageIndex()` reads `status` BEFORE
  `stage`, and that order is the ONLY thing hiding the three stale-/reset-stage transitions CS-T1
  measured (learnings 09 §10); invert it and all three reach the friend with nothing going red. No
  string in the lib or the component may contain „kolo"/„kolá"/„cyklus"/„cykl" (sweep regex
  ~~`/\bkol[oáa]|cykl/iu` — the spec's `kol[oáa]\b` misses „kolá" and false-positives „okolo") — ONE
  module-scoped `BANNED` in `cycle-stages.spec.js`~~ **— SUPERSEDED by PI-T11: the ONE home is
  `e2e/helpers/vocabulary.js BANNED` (see the PI-T11 rule below), imported by `cycle-stages.spec.js`
  and `portal-vocabulary.spec.js`**, shared by the lib harvest and CS-T4's
  rendered-page sweep. The guest read-only sentence is „Objednávky sú uzavreté, objednávku už nie je
  možné upraviť." (CS-T4 dropped „cykle"). ~~⚠ THREE → TWO (GL-T2) guest-facing „cyklus" strings survive
  deliberately … `routes/guest.js` `CLOSED` („…v tomto cykle je už uzavreté.") and
  `GuestProductGrid.vue:88` („V tomto cykle…", EDIT mode + the zero-product LIVE listing) … PO decision
  pending.~~ **— SWEPT by GL-T7 (module-19 closeout, learnings 11 §GL-T7): NO guest-facing „cyklus"
  survives. `CLOSED` + its three `routes/guest.js` siblings and the two HOST 409s of
  `routes/guest-orders.js` say „Objednávky sú/boli (práve) uzavreté, …", the grid says „V ponuke zatiaľ
  nie sú žiadne produkty." (all PO DRAFTS; status + `reason` byte-identical); the ADMIN
  `POST /guest-orders/:id/cancel` 409s KEEP „Cyklus" (audience rule, pinned).**
- A dialog/loader reused across entities needs a `loadSeq` guard; per-row mutations need per-id pending state;
  friend-authenticated children of `FriendOrder` need the `ready` gate; its two panels stay `v-show`.
- `v-model` on `<select>` (never `:value`); a refused change snaps the control back.
- Print sheets: fold with `hidden print:flex`, never `v-if`; pickers `print:hidden`, badges `hidden print:inline-flex`;
  a dialog is chrome — `DialogContent.vue`'s overlay AND box are `print:hidden` (override via `props.class`).
- A `disabled` attribute does NOT stop a dispatched click reaching the handler — every gated action needs a JS
  guard too. A refusal message and the rows it highlights share a scope, and it is cleared in the doors that
  ACT on its advice, never in the loader's success path (which also runs after a snap-back).
- **No view that edits `friends.name` may call it a login.** `grep -i prihlasovac frontend/src/views/AdminFriends.vue
  frontend/src/views/FriendPortalSession.vue` must stay empty; `friends.name` is the Packeta delivery name.
  (`AdminInvitations.vue` / `InviteRegister.vue` legitimately label the real `username`.)
  Same rule server-side: `'Meno a priezvisko je povinné'` is ONE string with THREE homes in `routes/friends.js`
  (`POST /`, admin `PATCH /:id`, friend `PATCH /:id/profile`) — grep the string, re-word every hit or none (FUP-T21).
- ⚠ ONE global `admin_token` row: EVERY `POST /api/admin/login` replaces it, so a login that
  lands after its test timed out still rotates it and every CACHED token minted earlier 401s.
  Files mitigate by convention („re-log-in before each fixture block") and the convention has
  gaps — a red full suite with admin 401s on `POST /api/friends`/`/api/cycles` is this, not
  file order. Mid-run the row is only ROTATED: no 401→logout path exists (all four `logout()`
  callers are button handlers), so it is never deleted.
  ⚠⚠ **AND THE USUAL CAUSE IS A LOADED BOX, SO CHECK THE BOX BEFORE BLAMING THE DIFF.** The
  first failure in that cascade is a **10 s TIMEOUT on the admin login redirect**, not a 401 —
  the 401s are downstream. Measured 2026-09-20 on PI-T3, one tree, three runs: **115 failed**
  (17.4 min — and that one was measuring a CORRUPT DB: 65 `disk image is malformed` in its
  server log, so read the SERVER log before reading the test log), **33 failed** (14.2 min,
  clean DB, loaded box), **0 failed** (11.9 min, idle box). A full run that takes ~14 min where
  it usually takes ~12 is already telling you. Confirm with a HEAD baseline AND a clean-box
  re-run before calling a regression; one red run is not evidence.
- ⚠ **A wait-loop that polls `pgrep -f "playwright test"` MATCHES ITSELF and never exits.** Its
  own `bash -c` command line contains the pattern, so the loop spins forever, survives the run
  it was watching, and quietly loads the box for every later run. This is the `pkill -f`
  self-match rule above with a worse ending — `pkill` fails loudly, this one is silent. Four of
  them were found still spinning hours later and are the measured cause of the flaky runs in the
  rule above. Poll the LOG for a summary line instead, or match on something the watcher cannot
  contain (`pgrep -f "[p]laywright test"`).
- Portal → order navigation has ONE home: `e2e/helpers/portal.js gotoCycle()`. A cold
  `page.goto('/cycle/:id')` BOUNCES to `/` (the Bearer token is in memory; `FriendPortal.vue` owns the
  restore), so it goes in through that bounce and `goBack()`s — which makes `/cycle/:id` the bottom
  history entry, so a test wanting the leave guard on a traversal uses `goForward()`, never `goBack()`.
- A spec that greps `.vue` SOURCE must strip `//` comments BEFORE `/* */`: `@/components/ui/*` in a line
  comment opens a fake block comment that swallowed 16 709 chars and turned a source pin green (PI-T3).
  Every absence pin needs a readability gate (stripped length vs raw) beside it.
- The „cyklus/kolo" ban has ONE regex, `e2e/helpers/vocabulary.js BANNED` (union of three spellings, all ten case forms incl. „kôl"/„kolám"/„kolami"; JS `\b` is ASCII-only), and the friend source guard's file set is the router's IMPORT CLOSURE (`importClosure()`), never a typed list — a new friend component is guarded by being imported (PI-T11).
- The ban's source guard covers `VOCABULARY_ROOTS` = friend ∪ GUEST roots (`GUEST_SURFACE_ROOTS`, pinned EQUAL to `router.js`'s `/g/…` components) plus the guest SERVER: all of `routes/guest.js`, the non-`requireAdmin` blocks of `routes/guest-orders.js` — admin strings keep „Cyklus", pinned (GL-T7).
- A rendered-copy sweep reads the app's OWN copy: `e2e/helpers/copy-sweep.js` (one home, text + `placeholder`/
  `title`/`aria-label`/`alt`) drops every `[data-user-copy]` subtree, and a view marks the person-typed
  interpolation — never the app copy beside it. The test template has a friend NAMED `Prihlasovacie.meno`; a
  sweep that reddens on data is repaired by marking the data render, never by narrowing the regex (FUP-T22).
- Never `maximum-scale=1` / `user-scalable=no`; iOS zoom is handled by A12 (16px inputs under `pointer: coarse`).
- A10 (`line-height:normal`) is for canon-SILENT classes only; where `portal2.jsx`/`portal2.css` DECLARES a line-height, the port and its `portal-fidelity` pin use THAT value (PI-T12 measured three drifts, one under a comment citing „the canon's value").
- Text: `min-w-0` is not `overflow-wrap` (set `overflow-wrap:anywhere` on the container); `€` on item lines,
  `EUR` on totals; ordinary space before `€`. **kg display = `lib/kg.js kgLabel(grams)` — ONE home, returns the
  whole „X kg" string** (`FriendOrder`, `GuestProductGrid`, `FriendPortalSession`, `Distribution` all import it;
  FUP-T24). Nothing strips trailing zeros: `Number#toString` never emits them, and that holds only while the
  number goes straight into a template — `toFixed(2)` at a call site would print „1.00 kg" on that screen alone.
  `CycleDetail`'s „max {limit}" badge is a DIFFERENT rule (unit switches at 1000 g, no rounding) — do not fold it in.
- Preflight `svg{display:block}` breaks inline icon+text — fix at the call site with `inline-flex`.
- ⚠ The closed landing prints the SAME date twice, in TWO formats, and that is an open PO question, not a bug:
  the modal's card is `lib/dates.js fmtDayMonth` („3. 10.") and the warn banner is module 17's composed
  sentence („približne 3. októbra"). Never reconcile it at a call site; `portal-landing.spec.js` §5 pins both
  halves, so whichever way the PO rules, exactly one of those expectations is the edit (PI-T1 §1, PI-T4).
- Guest surface (`GuestOrder.vue`, `GuestOrderStatus.vue`) deliberately lags the friend skin in places; it is
  not the reference when restyling.
- `GuestShareDialog.vue` = standing section (`standing-link`, own `standingSeq`, the ONE native-share button, URL rendered by spec) THEN the per-cycle one; per-cycle assertions scope to `per-cycle-link`, whose loading `.sub` stays a DIRECT `.m-body` child (pinned) and whose error banner stays first (GL-T6b).
- Nothing new inside a guest hero (`.card.hl`, `preopen-hero`) may carry `.badge` or `.mono`: shipped pins count/strict-resolve them. `GuestSteps`/`GuestRoastersLine` re-declare those rules in scoped classes, pinned computed-style-equal (GL-T4).
- The pre-open preview is `GuestProductGrid readonly` (GL-T5) — REMOVES steppers/stock bar/lightbox/tab stops (each JS-guarded); the `.p2-ro` fade is the CALLER's wrapper over strip AND cards; `gorifi_guest_waitlist` memory is `{at, whatsapp_opt_in, cycle_id}` and expires with the preview round (learnings 11 §GL-T5).

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
  including that origin, fresh `DB_PATH` under the scratchpad + `node e2e/seed.mjs` (⚠ **the seed needs `DB_PATH`
  too** since PI-T9 — without it step 7's explainer pre-stamp SKIPS, silently, and every UI friend login in the
  suite lands on `/ako-to-funguje`; a correct run prints `explainer: pre-stamped N friend(s); 1 left`),
  `GOOGLE_CLIENT_ID=test-client
  GOOGLE_AUTH_TEST_MODE=1`, and all five limiter maxima raised **to `100000` for a full run** (`1000` is
  measurably too small: the shared `authLimiter` exhausts mid-run and the tail collapses into 429s on
  `admin login` that read as a mass regression) — **named, because the glob invites a wrong guess**: `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_ABUSE_MAX`, `RATE_LIMIT_GUEST_READ_MAX`,
  `RATE_LIMIT_GUEST_WRITE_MAX`, `RATE_LIMIT_MAGIC_MAX` (⚠ **`_MAGIC_`, not `_MAGIC_LINK_`** — an unread name
  is silently ignored, leaving the tightest bucket at its default 10, and `magic-link.spec.js` then reds ~5
  tests with **429** partway through a full run, which reads exactly like a regression; the tell is a 429 on
  an assertion that expected 400/200). `rate-limit*.spec.js` / `magic-link-rate-limit.spec.js` then self-skip
  — the documented skips (4 with `forced-change-ui.spec.js`'s `test.fixme`). Build `frontend` first; a missing `backend/public` answers 503.
- Kill the old server BY THE PID OWNING THE PORT (`ss -lptnH 'sport = :3997'`), confirm the port is free, then
  start — `pkill -f` self-matches and a stale server measures deleted code. Background it with `setsid … </dev/null`.
- The DB is an INPUT: copy `e2e/fixtures/prod-template.sqlite` to a fresh path PER RUN (`e2e/make-test-db.sh`
  builds it; `e2e/scrub-local.mjs --verify` re-checks it), and start only AFTER the port is free — otherwise the
  new server dies with `EADDRINUSE` in its own log, the OLD one keeps serving, and the only tell is `seed.mjs`
  printing `exists` instead of `created` (GR-T9). Readiness-probe `/api/health`; `/api/cycles` is admin and 401s.
- Pipe output to a FILE, not `| tail`. Check `echo "EXIT: $?"` of the test command itself.
- A bare positional filter is a SUBSTRING match — `playwright test guest-order` also runs
  `guest-order-shell` and `guest-order-recovery`. Report the files that RAN
  (`grep -oE 'tests/[a-z0-9-]+\.spec\.js' <log> | sort | uniq -c`), never the ones you typed; the
  danger is OVER-collection — **and UNDER-collection, which my own earlier version of this rule got
  WRONG.** Measured twice (2026-09-20): a filter list where EVERY entry matches nothing is LOUD
  (`Error: No tests found.`, exit 1). But a list where ONE entry matches nothing **and the others
  match is SILENT** — exit 0, the missing entry simply dropped, the rest reported as a clean pass.
  That is the COMMON case for a targeted gate, and it is how a deleted or mistyped spec file leaves
  a row's gate while the summary still says „N passed". PI-T5 passed `tests/order-flow.spec.js`,
  which does not exist, and the run said nothing. **So: reconcile the files that RAN against the
  files you asked for, every time** — `grep -oE 'tests/[a-z0-9-]+\.spec\.js' <log> | sort -u` and
  compare with your own list. A count nobody reconciles hides both directions.
- Never run the full suite per task: targeted spec files per row, full suite at module milestones. Full run
  **~12 min on an IDLE box** (measured repeatedly 2026-09-20: 11.8–11.9 min green; **~14 min is the tell that
  the box is loaded**, and ~17 min meant a corrupt DB). ⚠ ~~on this 4 GB/2-core box~~ — **the hardware claim
  was STALE: measured 2026-09-20 it is 8-core / 12 GB.** The Chromium SIGSEGV (exit 139) guidance was written
  for the old box and has not been re-observed since; keep the habit, drop the certainty. **Confirm a
  suspicious failure by running its file alone, twice, on a fresh DB — and check the box and the SERVER log
  before blaming the diff** (see the loaded-box rule above; 65 `disk image is malformed` lines once sat unread
  in a server log while a file-ordering theory was built on the test log).
- A CLOSED landing opens a `role="dialog"` BY ITSELF (the state modal), and its scrim covers the hamburger:
  a spec whose fixture lands `closed` and then reaches for the drawer calls `dismissLandingState(page)` first,
  and one that counts dialogs there is counting the modal. ⚠ `signIn()` helpers that `localStorage.clear()` in
  an `addInitScript` run on EVERY navigation, a RELOAD included — so a test asserting something is NOT
  persisted may not use them, or it passes whatever the app stores (measured, PI-T4).
- A 320px claim about a modal-layer surface measures the LAYER and every descendant scroller (`portal-fidelity.spec.js noLayerOverflow`), never only the document or the outer box: a scrim or an `overflow-y:auto` column absorbs the spill (PI-T12: the drawer hid 1016 > 271).
- Spec hygiene: refusal tests read the row back; absence assertions need a non-vacuity gate; Playwright role
  names match as case-insensitive substrings unless `exact: true`; `innerText` applies `text-transform`;
  NBSP survives regex `toHaveText`; `li` counts must be `li.ln`; UI+API admin tests must adopt the browser's token.
- A „patch in place, THEN re-fetch" pair is unprovable unless the test HOLDS the second call (`page.route`
  delay ≥4 s on this box) — delete the patch and the re-fetch paints the same screen a moment later, green.
  ⚠ NECESSARY, NOT SUFFICIENT: `expect` RETRIES for `expect.timeout` (**10 s**, `playwright.config.js`), so an
  assertion made during a 5 s hold just waits for the response, watches the defect repair itself and passes —
  measured PI-T6 (a „one shared pending flag" mutation went 15/15 green). The hold must OUTLAST the assertion
  window, or the discriminating assertions carry an explicit shorter `{ timeout }`.
- A row-scoped text assertion about MONEY must target the CELL (`row.getByRole('cell').nth(n)`). ⚠ NOT the
  `innerText` rule above: `toContainText`/`toHaveText` resolve from **`textContent`** unless `useInnerText` is
  passed, and Vue condenses away the whitespace node between `</td><td>`, so adjacent cells concatenate with
  NOTHING between them. (Chromium's real `innerText` inserts a TAB there and does NOT reproduce this — check it
  that way and you will wrongly conclude the rule is bogus.) The VS is a bare `orders.id`, so „VS 243"+„0.00 EUR"
  reads as „30.00 EUR" — a 1-in-10 flake steered by whichever spec created orders first (DP-T2, 2026-09-20).
- `node:sqlite` (test helpers) and better-sqlite3 (routes) report DIFFERENT constraint error codes — verify a
  constraint guard against the driver the route loads.
- The admin request path has ONE home: `e2e/helpers/admin.js` `makeAdmin({ctx,token,adopt,timeout})`, which
  re-authenticates **exactly once** on a 401 and publishes the fresh token back into the file's own
  `adminToken` (42 spec files adopt it; a private `async function admin(path…)` copy is swept out by
  `admin-token-retry.spec.js` §5). There is ONE `admin_token` row and every login REPLACES it, so a late login
  kills every cached token — the cascade's FIRST failure is a 10 s timeout on the admin login redirect, the
  401s are downstream (FUP-T27). ⚠ `api-security.spec.js` tests staleness ON PURPOSE and must NEVER adopt it —
  pinned in source AND demonstrated live (§4 shows the retry answering 200 where that test needs 401).
  ⚠ **The remaining gap, with ONE definition and its MEASURED number** (the first write-up said „31 files",
  which is wrong under every reading): **41** spec files mention `X-Admin-Token`, **34** of them do not adopt
  the helper, and **23** carry the exact `headers: { 'X-Admin-Token'` shape without adopting. FIVE files both
  adopt AND still inline (`cycle-stages`, `distribution-handover`, `guest-order-recovery`,
  `invitation-approval`, plus the retry spec itself) — so „adopted" does NOT mean „protected": the PATCH
  matrices in `cycle-stages` and `distribution-handover` still build their own header and get no retry.
  ⚠ Adoption is NOT always a drop-in: a file that ROTATES the admin password mid-test
  (`bcrypt-nonstring-shape`, `admin-password`) needs the helper's `password` option, or the retry logs in with
  the default, 401s and THROWS instead of returning the route's answer. Loud, not silent — but not free. ⚠ Run `npx playwright test --list` after ANY
  scripted edit of the suite: a SyntaxError reports as `Total: 0 tests in 0 files`, which is not a pass.
