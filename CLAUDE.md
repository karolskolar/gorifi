# Gorifi

Coffee order management application for coordinating group coffee orders among friends.

## Tech Stack

- **Backend:** Node.js + Express + better-sqlite3 (file-backed SQLite, WAL)
- **Frontend:** Vue 3 + Vite + Tailwind CSS
- **Language:** Slovak (UI text is in Slovak)

## Project Structure

```
backend/
  src/
    db/schema.js      # Database schema and helpers
    routes/           # Express route handlers
    index.js          # Server entry point
frontend/
  src/
    api.js            # API client with all endpoints
    router.js         # Vue Router config
    views/            # Vue page components
```

## Development

```bash
# Backend (port 3000)
cd backend && npm run dev

# Frontend (port 5173)
cd frontend && npm run dev
```

## Key Patterns

### Database
- Uses better-sqlite3 (file-backed SQLite, WAL mode). Migrated from sql.js in SEC-D1; `dbHelpers` API (`all/get/run/prepare/transaction/exec`) is unchanged, so route code is unaffected. A thin `db` shim in `schema.js` keeps the try/catch `ALTER TABLE` migration blocks working verbatim.
- Schema defined in `backend/src/db/schema.js`
- Migrations handled via try/catch ALTER TABLE (column already exists = ignore)
- `dbHelpers` provides `all()`, `get()`, `run()`, `prepare()`, `transaction()` methods

### API Client
- Frontend API client in `frontend/src/api.js`
- Supports FormData for file uploads (auto-removes Content-Type header)
- Custom headers can be injected (e.g., `X-Friends-Password`)

### Authentication
- **Admin:** Password-based, stored in settings table
- **Friends:** Single global password (set in Admin > Settings) + friend selection from dropdown (honor system)
- Password sent via `X-Friends-Password` header for friend order endpoints

## Learnings

### Friend Ordering Flow (2026-01-24)
- URL format: `/` → Friend portal (login + cycle list), `/cycle/:cycleId` → Order page
- Friends authenticate with global password (same for everyone), select name from dropdown
- Auth state stored in localStorage key `gorifi_friend_auth` as `{ friendId, friendName, password }`
- FriendPortal.vue handles login, shows cycle list with order status
- FriendOrder.vue shows products/cart, redirects to portal if not authenticated
- Password validated via `POST /friends/auth`, stored in memory for `X-Friends-Password` header
- Admin sets global friends password in `/admin/settings`

### Database Migrations
- Add new columns with try/catch pattern after CREATE TABLE:
  ```javascript
  try {
    db.run('ALTER TABLE tablename ADD COLUMN newcol TYPE');
  } catch (e) {
    // Column already exists, ignore
  }
  ```

### Vue Patterns
- Use `computed()` for derived state from route params
- Reactivity trigger for objects: `cart.value = { ...cart.value }`

### Cycle Progress Feature (2026-01-31)
- Each cycle stores `total_friends` at creation time (snapshot of active friends count)
- This ensures progress display (e.g., "5/12 priateľov") remains fixed even if friends are added later
- `/friends/cycles` endpoint returns: `totalKilos`, `submittedOrders`, `totalFriends`
- Kilos calculated from order_items: 250g = 0.25kg, 1kg = 1.0kg

### Order Auto-Save & Status Notifications (2026-02-01, updated 2026-02-02)
- **Auto-save behavior differs based on order existence and status:**
  - No order exists yet: NO auto-save (items stay in cart but not saved to DB until submit)
  - Existing draft orders: Cart changes are auto-saved (debounced 500ms)
  - Submitted orders: Changes are NOT auto-saved; user must click "Aktualizovať" (the button has read that since before the redesign; RD-FO-3 made the cartbar warning copy match it)
- **Order creation:** Orders are only created when user explicitly submits (not by auto-save)
- **Status notifications in cart footer:**
  - Yellow: "Objednávka ešte nebola odoslaná" - when cart has items but not submitted
  - Orange: "Zmeny v objednávke neboli odoslané ani uložené" - when submitted order has unsaved changes
- **Change detection:** `lastSubmittedCart` ref stores snapshot of cart at submission time
- **Leave confirmation:** Modal shown when navigating away with:
  - Unsaved changes on submitted orders
  - Cart items but no order (new items not yet submitted)
- **Cancel order behavior:**
  - If order exists: Deletes the order record entirely
  - If no order: Just clears cart (no DB operation)
  - Shows as "Neobjednané" in admin dashboard
  - Redirects user to cycle list after canceling
- **Backend order updates:** PUT `/orders/cycle/:cycleId/friend/:friendId`
  - Creates order if doesn't exist (only when explicitly called)
  - Preserves order status when items change (doesn't reset to 'draft')
  - Deletes order entirely when cart is emptied (total = 0)
- **Backend order retrieval:** GET `/orders/cycle/:cycleId/friend/:friendId`
  - Does NOT auto-create orders; returns null if no order exists

## Deployment

### Architecture
```
Nginx Proxy Manager (SSL) → LXC Container (nginx) → PM2 apps
├── gorifi.skolar.sk     → port 80 → gorifi-backend:3000
└── gorifi-dev.skolar.sk → port 80 → gorifi-staging:3001
```

### Deploy Commands
```bash
./deploy/deploy.sh staging             # Deploy to dev
./deploy/deploy.sh production          # Deploy to production
./deploy/deploy.sh staging backend     # Backend only
./deploy/deploy.sh production frontend # Frontend only
```

### Deploy Files
- `deploy/ecosystem.config.cjs` - PM2 config (both apps)
- `deploy/nginx-gorifi.conf` - Production nginx
- `deploy/nginx-gorifi-staging.conf` - Dev/staging nginx
- `deploy/deploy.sh` - Deployment script

### Staging Indicator
- `VITE_STAGING=true` env var shows amber "STAGING" banner
- Set automatically by deploy script for staging builds

### Friend Portal Display (2026-02-03)
- Cycle list shows friend's own order kilos (not cycle total)
- Progress display (submitted/total friends) removed from friend view
- Kilos only shown when friend has an order
- Capsules counted as 100g (20 × 5g)

### Dismissable Notifications (2026-02-03)
- Orange "unsaved changes" notification can be closed to save screen space on mobile
- Notification reappears if user makes more cart changes after dismissing
- State tracked via `changesNotificationDismissed` ref, reset on cart change

### First-Time Deployment (2026-02-03)
- Deploy script must copy `ecosystem.config.cjs` BEFORE starting PM2 (not after)
- Script creates log directories (`/var/log/gorifi`, `/var/log/gorifi-staging`) if missing
- Both production and staging run in same LXC container on different ports (3000, 3001)

### Pickup Locations Feature (2026-02-20)
- Admin configures pickup locations (name + address) in Settings
- `pickup_locations` table: id, name, address, active, created_at
- `orders` table has `pickup_location_id` (nullable FK) and `pickup_location_note` (text for "Iné" option)
- Route: `backend/src/routes/pickup-locations.js` — CRUD endpoints (GET `/` public, GET `/all` admin, POST, PATCH, DELETE)
- Friend order submit (`POST /orders/cycle/:cycleId/friend/:friendId/submit`) accepts `pickup_location_id` + `pickup_location_note` in body
- FriendOrder.vue shows pickup modal on submit when locations exist; skips modal if none configured (backward compatible)
- "Iné" = NULL pickup_location_id + optional note text
- Delete with existing orders = soft-delete (active=0) instead of hard delete
- Admin views (CycleDetail orders tab, Distribution) show pickup location as blue badge
- Deploy script deploys from local files (rsync), no git push needed — but backend restart required for DB migrations
- Production deploy requires `y` confirmation prompt — pipe `echo "y" |` to auto-confirm

### Coffee Analytics Feature (2026-04-03)
- Admin-only analytics dashboard at `/admin/analytics/coffee` (and `/admin/analytics/bakery` placeholder)
- Single backend endpoint `GET /api/analytics/coffee` computes all metrics (cycles, friends, summary)
- Computation helpers in `backend/src/helpers/analytics.js` (tier logic, margin formula, weight calc, segmentation)
- Charts use Chart.js via vue-chartjs (Bar, Doughnut components)
- Chart components in `frontend/src/components/analytics/` (CycleTrendsChart, MarginChart, SegmentDonutChart, BuyerFlowChart, FriendAnalyticsTable)
- Tier thresholds: 5kg→30%, 26kg→35%, 51kg→40% — stored as constants in helpers
- Margin formula: `totalOrderValue × (1 - (1 - tierDiscount) / (1 - 0.30))`
- Friend segmentation: core/regular/occasional/new/inactive based on last 3 coffee cycles
- ~~Admin routes in this project do NOT validate tokens server-side.~~ **Superseded (SEC-A*/GSO-T1):** admin routers ARE now guarded server-side — `index.js` mounts them with `requireAdmin` (`middleware/admin-auth.js`), e.g. `app.use('/api/order-items', requireAdmin, orderItemsRouter)`. New admin routes MUST be guarded, and added to the canonical anonymous-401 list `ADMIN_ENDPOINTS` in `e2e/tests/api-security.spec.js`. The frontend localStorage + dashboard token verify is UX only, not the boundary.
- Weight from order_items: variant → kg mapping in `variantToKg()` helper
- Spec: `docs/coffee-analytics-spec.md`, Plan: `docs/superpowers/plans/2026-04-03-coffee-analytics.md`

### Live Cycle Dashboard Feature (2026-04-04)
- Real-time dashboard at `/admin/analytics/live` for current open coffee cycle
- Backend endpoint `GET /api/analytics/live-cycle` in `backend/src/routes/live-cycle.js`
- Shows tier progress bar, 6 metric cards, previous cycle comparison, "who hasn't ordered" nudge list
- Auto-refreshes every 60 seconds + manual refresh button
- Tab navigation: Živý prehľad | Káva | Pekáreň (across all 3 analytics pages)
- Only shows coffee cycles; bakery live dashboard not yet implemented
- "Who hasn't ordered" list uses friend segmentation (Core/Regular prioritized) for nudge targeting
- Hidden when cycle status is 'locked' (no point nudging)
- Spec: `docs/live-cycle-dashboard-spec.md`

### Bakery Product Variants Feature (2026-04-19)
- Bakery products support multiple weight/price variants (e.g. Makovník: 1ks, 1/2, 1/4)
- `bakery_product_variants` table: id, bakery_product_id, label, weight_grams, price, sort_order, active
- Existing products auto-migrated to have one variant each (from their weight_grams + price)
- `products` table gained `variant_label` and `source_variant_id` columns for cycle snapshots
- Cycle creation: each variant becomes its own `products` row (N variants → N rows), grouped by `source_bakery_product_id`
- FriendOrder.vue groups snapshotted products by `source_bakery_product_id` into single cards with per-variant +/- controls
- `variant_label` shown in: friend cart, admin orders tab, summary tab, clipboard copy, distribution view
- Admin modal: weight/price fields replaced with repeatable variant rows (label + weight + price) with add/remove
- Bakery products also have a `subtitle` column — shown next to product name in friend order (lighter, smaller text)
- Subtitle snapshotted as `description2` in products table (coffee already uses description2 for its own purpose)
- Spec: `docs/superpowers/specs/2026-04-19-bakery-product-variants-design.md`

### Packeta Parcel Delivery Feature (2026-05-01)
- Optional Packeta parcel delivery as alternative to admin-managed pickup locations
- Per-cycle config: `order_cycles.parcel_enabled` (boolean) + `order_cycles.parcel_fee` (EUR amount)
- Friend profile: `friends.packeta_address` stores default pickup point address (editable in "Upraviť profil" modal)
- Order storage: `orders.delivery_fee` (separate from product total) + `orders.packeta_address` (address for this order)
- `delivery_fee` is NOT in `order_items` — it's a field on the order. `paymentTotal = total + delivery_fee`
- Submit endpoint: `use_parcel_delivery` boolean in body triggers parcel path, clears pickup fields (and vice versa)
- Unified delivery modal in FriendOrder.vue: radio choice "Osobný odber" vs "Doručenie Packetou", then appropriate sub-section
- 4 modal scenarios: (1) no pickup + no parcel = no modal, (2) pickup only = pickup section, (3) parcel only = packeta + "bez doručenia", (4) both = radio choice
- Admin views: red badge `border-red-400 text-red-600 bg-red-50` for Packeta (vs blue for pickup locations)
- Distribution view shows full Packeta address below order header
- Friend portal shows delivery method badge (red Packeta / blue pickup) on cycle cards
- `friends/cycles` endpoint returns `orderPickupName` and `orderPacketa` fields (scoped inside `if (friendId)` block — variable scoping matters)
- Spec: `docs/superpowers/specs/2026-05-01-packeta-parcel-delivery-design.md`

### Pending Invitations Dashboard Alert + Prefill (2026-07-07)
- AdminDashboard shows a clickable amber banner when pending invitations exist; fetches count via `api.getInvitations('pending')` on mount (non-blocking, swallows errors), navigates to `/admin/invitations` on click
- Slovak pluralization inline: 1 → "čakajúca pozvánka", 2-4 → "čakajúce pozvánky", 5+ → "čakajúcich pozvánok"
- ~~Invitation → new friend flow: "Vytvoriť" passes `create=1&name=&phone=&email=` query params to `/admin/friends`; AdminFriends `onMounted` prefills the modal~~ **SUPERSEDED (module 07, IA-T4/IA-T5, 2026-08-13).** "Vytvoriť" now opens an **approval dialog in place — no navigation**; the query params and the `onMounted` receiver are both DELETED. See `docs/specification/07-invitation-approval.md`.
- ~~Modal field mapping in AdminFriends: friendName=Prihlasovacie meno (login)~~ **SUPERSEDED — and this bullet was the bug.** ⚠ `friendName` writes **`friends.name`, a DISPLAY label that never was a login**; the field is now labelled **`Meno a priezvisko *`** (FC-T2, module 11 — was `Meno *` from IA-T5; `admin-friends-labels.spec.js`'s exact-label pins were retargeted with it, case (a)) and `POST /api/friends` still sets no credentials. A friend gets a real login ONLY via `POST /api/invitations/:id/approve` (module 07) or the per-friend "Nastaviť username" / "Resetovať heslo" actions. The rest of the mapping still holds: friendDisplayName=Poznámka (internal admin note), friendPhone=**Mobil** (FC-T2 relabel), friendEmail=Email; the `invitations` table has name/phone/email/username (no user note field). Module 11 (FC-T1/T2) added: server bounds 120/32/160/200 mirrored as `maxlength`, `Kontakt` (amber `Bez e-mailu`) + `Google` (`googleLinked`) columns, the truthful three-state `Prihlásenie` badge (`Neúplné` when password-no-username) + `dočasné heslo` marker, and save errors render in an in-dialog `modalError` Alert (the page Alert is hidden behind the radix overlay — do not "fix" it back). ⚠ `grep -i prihlasovac frontend/src/views/AdminFriends.vue` must stay EMPTY (07 §UC-IA-007) — the one legitimate `Prihlásen*` string there is the `Prihlásenie` column header, which reports real credential state (`hasCredentials`) and makes no claim about the name field.

### Guest Shared Orders — schema + host share link (GSO-T2, 2026-08-04)
- All three guest tables live in `schema.js` from GSO-T2 on: `guest_order_links` (one per host+cycle, `UNIQUE(host_friend_id, cycle_id)`), `guest_orders` (`link_id` carries host+cycle; `paid` = admin-only, `delivered` = host-only), `guest_order_items` (incl. `packed`). Later guest tasks must NOT add migrations for them.
- Share tokens: `generateGuestToken()` in `schema.js` (14 chars, `crypto.randomInt` over `CODE_ALPHABET`, SEC-S2). Never hand-roll a second RNG.
- `routes/guest-links.js` is friend-authenticated, mounted BARE (`app.use('/api/guest-links', guestLinksRouter)`) — no `requireAdmin`.
- Host identity rule: these routes are keyed on `/cycle/:cycleId`, so the host is whoever holds the Bearer session. `requireHost()` rejects bare shared-password auth (no resolved `friendId`) with 401, and never reads a `friend_id` from the body — that would reopen the SEC-A1 IDOR. Ownership on `/guest-links/:id` is a 403 when `host_friend_id` differs.
- Regeneration UPDATEs the token on the existing row (never DELETE+INSERT) — `guest_orders.link_id` cascades on delete, so re-inserting would wipe every sub-order.
- `GET /api/guest-links/cycle/:cycleId` returns `{ link, guest_orders, totals }`; the list is empty until the guest ordering endpoints exist. `order_token` (the guest's private edit URL) is never exposed to the host.
- Share UI: one shared `components/GuestShareDialog.vue` (loads on open, copy button, `navigator.share` only when available, regenerate with inline confirm, deactivate/reactivate) with TWO entry points per §UC-GSO-005 — the FriendOrder.vue "Zdieľať objednávku s kolegami" card and a "Zdieľať s kolegami" button on the FriendPortal cycle card (open cycles only, `@click.stop` so the card's navigation does not fire). Don't fork the dialog; extend the component.
- `GuestShareDialog` is ONE instance reused across cycles (per-card entry points), so every request in it is sequence-guarded: `let loadSeq = 0`, `const seq = ++loadSeq` before each await, `if (seq !== loadSeq) return` before touching state. Without it a slow GET for a closed cycle overwrites `link.value` and the deactivate/regenerate buttons hit the wrong cycle's row (reproduced in Chromium; covered by the "slow load … cannot overwrite" e2e test). Any future dialog reused across entities needs the same guard.
- The dialog names the cycle it is sharing (`cycleName` in the DialogDescription) — several open cycles sit side by side in the portal, so an unlabelled URL cannot be verified.
- Slovak register for these views is impersonal/vy-form — avoid gendered past participles addressing the user ("nevytvoril si" ✗, "ešte nie je vytvorený" ✓).
- Spec: `docs/superpowers/specs/2026-07-18-guest-shared-orders-design.md` (§UC-GSO-005, Decisions 6 & 8)

### Guest Ordering — public surface + the stock/pricing seams (GSO-T3, 2026-08-04)
- `routes/guest.js` is mounted BARE at `/api/guest` — **no admin or friend auth; the URL token IS the credential.** This is the app's only unauthenticated *write* endpoint, so treat it as a hostile input boundary. Contract: 404 unknown token, 410 inactive link **or inactive host**, 409 lock race (re-checked inside the insert transaction so a mid-request lock writes nothing), 400 identity/bounds/stock.
- Bounds on that write (all 400, Slovak vy-form, with a `field` marker): items ≤ 100 lines *checked before the pricing loop* (it does one SELECT per line), per-line quantity ≤ 100, `guest_name` ≤ 120, `guest_phone` ≤ 32, `guest_email` ≤ 160. Mirrored as `maxlength` in `GuestOrder.vue`. Without these, 20k lines were accepted (754 ms of blocked event loop) and a 200k-char name persisted into the host/admin views.
- **`helpers/stock.js` is the ONLY place stock is counted.** UNION of `order_items` (`status='submitted'`, `excludeFriendId`) + `guest_order_items` (via `guest_orders` → `guest_order_links`, `COALESCE(status,'submitted') <> 'cancelled'`, `excludeGuestOrderId` — unused until GSO-T4). Used by `products.js` availability and BOTH `orders.js` gates. Never re-inline this SQL.
- `variantGrams()` must stay own-property + type safe. `VARIANT_GRAMS[variant] || 0` was a **stock-limit bypass**: a prototype key (`constructor`, `valueOf`, …) resolves to a truthy *function*, passed the `<= 0` guard, made grams `NaN`, and `NaN > limit` is `false` → "no violation" (10 kg sold against a 2 kg limit, reproduced end to end). Three layers now: type/`hasOwnProperty` gate, non-finite lines skipped, and `stockViolations` compares `!(existing + requested <= limit)` so anything non-finite **fails closed**. Don't "simplify" any of them.
- **`helpers/pricing.js` is the ONLY variant→price map.** An unknown variant returns null and the line is **DROPPED** — never priced at `price_250g`. That old fallback let goods be bought without ever touching `stock_limit_g` (a friend could order `variant:'zzz'` and it scored 0 g). `'unit'` is **priceable but zero-gram**: bakery ordering depends on it, so reject *unpriceable* variants, never *zero-gram* ones.
- ⚠ CONCURRENCY: the stock check runs OUTSIDE the insert transaction on all three call sites. That is only safe because `deploy/ecosystem.config.cjs` sets `instances: 1` and the handlers are fully synchronous (better-sqlite3). **PM2 cluster mode would reopen overselling.**
- Guest prices are marked up server-side and the FE never multiplies; `guest_order_items.price` is the frozen marked-up unit price. (`markup_ratio` is already public via `/cycles/:id/public`, so not publishing it to guests is layering, not secrecy.)
- Payment info (IBAN / Revolut / reference `G<id> / Name / Cycle`) is returned ONLY by the submit response, never by the public listing. `PaymentModal.vue` is reused as-is.
- `api.js` `guestRequest()` sends **no** auth headers and attaches `err.status`; `GuestOrder.vue` stores the status URL in `localStorage.gorifi_guest_orders` keyed by link token.
- ~~`abuseLimiter` is ONE bucket shared with the guest surface~~ — **resolved (2026-08-04)**: the guest routes moved to their own `guestReadLimiter` / `guestWriteLimiter`. See "Rate-limit buckets" below.
- Spec: same design doc (§UC-GSO-001..003, Decisions 1 & 7, §Edge Cases)

### Guest status/edit URL + the shared guest UI seam (GSO-T4, 2026-08-04)
- `components/GuestProductGrid.vue` + `lib/guest-cart.js` are the **one home** for the guest product grid (extracted from `GuestOrder.vue`, which duplicated FriendOrder's). Both the order screen (`/g/:token`) and the status/edit screen consume it — **extend it, never fork it**. Keep `GuestOrderStatus.vue`'s `loadSeq` guard (see the GSO-T2 rule above).
- **Deliberate read/write asymmetry on the status URL.** `resolveGuestOrder()` is **404-only** — a locked cycle or a deactivated link/host must still let the guest `GET` their order and the payment reference. The write half re-applies the gates: 410 inactive link/host, 409 non-open cycle, 409 cancelled. `products`/`availability` are published **only when `editable`**, which is what stops the status `GET` leaking the listing a locked cycle is supposed to 410. Don't "simplify" the two resolvers into one.
- `cancelled` is **TERMINAL** (lifecycle diagram has no edge back), so `PUT` on a cancelled sub-order is 409. This is also what stops a guest reviving what GSO-T5's host-delete removed.
- **Cancelling KEEPS the `guest_order_items` rows** — `UPDATE guest_orders SET total = 0, status = 'cancelled'`, no DELETE. The status predicate is the mechanism: `helpers/stock.js` already excludes via `COALESCE(status,'submitted') <> 'cancelled'`, and **T7/T8/T9 must filter on status regardless** (a cancelled order with `total 0` must not appear as a distribution party, in the unpaid overview, or as a rewards contributor — row deletion achieves none of that). Deleting bought nothing and destroyed the host/admin record of what was called off.
- ⚠ On this endpoint **only a literal `items: []` may cancel.** A `PUT` with `items` absent/non-array, or a non-empty `items` where nothing prices, must 400 non-destructively. Before this guard, `PUT {}` — or no body, or `quantity: true` — returned 200 and irreversibly cancelled the order (terminal, so the guest couldn't even re-save the same cart). Any future edit path on an unauthenticated write needs the same "destructive action requires explicit intent" check.
- Edits are **items-only**: identity (name/phone/email) is frozen at submit, because anyone holding the URL could otherwise rewrite someone else's contact details. `paid`/`delivered`/`status`/`total`/`order_token` stay server-owned.
- An `orderToken` only resolves under its own link `:token` (cross-link → 404, same message, no oracle). `statusPayload()` is the pinned response shape — GSO-T10's CTA hangs off it.
- Spec: same design doc (§UC-GSO-004, §Guest sub-order lifecycle)

### Host "Objednávky kolegov" view + single-owner flags (GSO-T5, 2026-08-04)
- **`/api/guest-orders` is a MIXED router: mounted BARE, gated per route.** GSO-T5 added host-only routes (`PATCH /:id/delivered`, `DELETE /:id`); GSO-T6 adds `requireAdmin` routes (`PATCH /:id/paid`, `GET /cycle/:cycleId/unpaid`) to the same prefix. Never wrap this mount in `requireAdmin` or in host auth.
- **Decision 2 — single owner per flag.** `delivered` is **HOST-only** (hand-over checklist); `paid` is **ADMIN-only** and the host sees it **read-only**. Neither route may write the other's flag: the request body is never spread, only literal columns are named. Verified by re-reading the row from the DB, not just the response.
- `requireHost()` lives in `middleware/friend-auth.js` (one home, shared by `guest-links.js` and `guest-orders.js`). Sub-order ownership walks `guest_orders.link_id → guest_order_links.host_friend_id`; **404 before 403** for a nonexistent row. An admin token is **not** host identity — these routes 401 it.
- `helpers/guest-orders.js` holds the shared sub-order loaders (`loadSubOrders` incl. `items`, `loadSubOrder`, `linkTotals`, `findSubOrderWithLink`, `guestOrderStatus`). The T2 GET payload is **extended, never reshaped** — `totals` stays `{count, total}` excluding cancelled, and `order_token` is still never exposed.
- **`DELETE /:id` is a SOFT cancel** (§UC-GSO-008): `status='cancelled'`, `total=0`, **item rows kept** (T4's rule — the status predicate is the mechanism). Stock is released because consumers filter on status; verified by `remaining_g` recovering. Idempotent **200** on an already-cancelled row (DELETE converges on the requested end state), **409 `closed`** when the cycle isn't open, re-checked inside the write transaction.
- ⚠ **`DELETE` refuses with 409 `reason:'paid'` when the admin has already marked the sub-order paid.** Otherwise the write zeroed `total` while leaving `paid=1`, the row dropped out of every non-cancelled aggregate, and **the money the guest sent left no refund signal anywhere**. Under Decision 2 the host escalates to the admin instead. T6 *may* additionally surface `paid = 1 AND status = 'cancelled'` as a refund queue — that's an addition to this guard, not a replacement.
- `PATCH .../delivered` has **no cycle-open gate** (hand-over happens *after* the lock) but 409s on a cancelled row. That asymmetry with `DELETE` is deliberate.
- `GuestSubOrders.vue`: mutations are sequenced and pending-tracked **per sub-order id** (`rowSeq` map), not by one shared counter — a superseded request must still revert and surface its error, or the checkbox lies about persisted state. `loadSeq` is only the load guard. Its `ready` prop is an **auth-ready gate, not cosmetic**: a child's `setup()` runs before FriendOrder's `onMounted` restores the friend session, so fetching earlier 401s on every fresh load. Any future friend-authenticated child of FriendOrder needs the same gate.
- Badges: paid = green, unpaid = amber, cancelled = neutral stone (distinct from Packeta red / pickup blue).
- Spec: same design doc (§UC-GSO-006..008, Decisions 2 & 8)

### Admin guest surfaces + the paid-freeze rule (GSO-T6, 2026-08-04)
- `PATCH /api/guest-orders/:id/paid` is `requireAdmin` and writes **NO `transactions` row** — unlike the friend toggle (`orders.js:353`), which posts one because friends carry a running balance. **Guests have no `friend_id` and no balance** (Decision 1: they pay the admin directly). Never copy the friend handler here; a stray row would corrupt a real friend's balance. Pinned by a before/after row count plus a NULL-`friend_id` check.
- `GET /api/guest-orders/cycle/:cycleId/unpaid` is the admin receivables view: name, amount, reference `G<id> / Name / Cycle` (via the shared `guestPaymentReference()` — one formatter, so the admin sees exactly what the guest sees), host, contact. Excludes paid and cancelled. It **also** carries a refund queue (`paid = 1 AND status = 'cancelled'`) whose `amount` is recomputed from the kept item rows, since cancelling zeroes `total`.
- ⚠ **`unpaid_count` in `cycles.js` uses a CORRELATED SUBQUERY, never a second `LEFT JOIN`.** `orders_count` and `unpaid_count` come from one `LEFT JOIN orders`; adding a guest join multiplies rows and **silently corrupts `orders_count`** (and the roastery kg breakdown) too. Any future cycle-level guest aggregate must follow the same pattern and assert `orders_count` is unmoved.
- `guest_unpaid_count` is **diagnostic only** — no frontend reads it, and it must **never be summed** with `unpaid_count`, which already includes guests.
- ⚠ **A guest may CANCEL a paid sub-order but may NOT change what they owe.** `guest.js` `PUT` returns 409 `reason:'paid'` when `paid` and `items` is non-empty, re-checked inside the write transaction; a literal `items: []` still cancels (landing in the refund queue). Without this, a guest could pay €10 then edit to €90 and stay marked paid, invisible on every admin surface — and it also let the refund amount drift to the last cart rather than what was paid. The guard is **state-based, not terminal**: clearing `paid` unfreezes the order.
- The guest status page now has **FOUR** states: editable / **paid-frozen** / read-only (locked) / cancelled. `statusPayload` exposes **`items_editable = editable && !paid`** — any future guest-write affordance must consult it, because `editable` alone no longer means "items can change". Paid-frozen hides edit mode but offers a direct cancel button (cancel used to live only inside edit mode).
- `CycleDetail.vue`: guest badge violet "Hosť • pozval X". ⚠ An independent `v-if` card placed **between** the orders tab's `v-if`/`v-else-if`/`v-else` links silently stops **both** order tables rendering — the card must be a sibling *above* the chain. A passing API test will not catch this; the three-state render spec exists for it. `loadGuestUnpaid` carries a `loadSeq` guard (per-row pending means two toggles can resolve out of order on a money screen).
- `"Objednávky (N)"` now counts **listed parties** (including a host with `status:'none'` who has sub-orders), not orders.
- Spec: same design doc (§UC-GSO-009..010, Decisions 1 & 2)

### Distribution guest leg — the completed packed gate (GSO-T7, 2026-08-04)
- **`helpers/packing.js` `packingItemStats()` is the ONE home for the packed gate's counting.** It UNIONs `order_items` with `guest_order_items` for the non-cancelled sub-orders under that (host, cycle) — correlated on **both** `glink.host_friend_id` AND `glink.cycle_id` (dropping the cycle correlation would let another cycle's guest bags gate this one), with `COALESCE(gord.status,'submitted') <> 'cancelled'`. Rule: **all own+guest items packed, at least one item across both.** Zero items overall still 409s.
- ⚠ GSO-T1's gate had `total === 0 → 409`, which would have **blocked a host whose only stake is guest bags**. T7 changed that deliberately: such a host IS packable, and their gate covers guest items only.
- `PATCH /api/guest-order-items/:id/packed` (`requireAdmin`) mirrors T1's `order-items.js`: 400 unless the parent order is `submitted`, and unchecking a guest item on a packed order **auto-unpacks the HOST's order** via `unpackOrder`. Guest items themselves never create a `transactions` row (GSO-T6 rule), but the auto-unpack correctly reverses the **host's own order total** — verified to net to zero, and `orders.packed` is written only by `packOrder`/`unpackOrder` so a reversal can't exist without its charge.
- **Synthetic distribution rows:** a host with guest bags but no `orders` row appears as the pickup party with `order_id: null`, `has_own_order: false`, a violet "Bez vlastnej objednávky" badge and **no "Zabaliť"** — the whole-order `packed` flag lives on `orders`, so there is nowhere to store it. A host whose only sub-order is cancelled is absent entirely. `/api/cycles/:id/distribution` has exactly one consumer (`Distribution.vue`) and nothing keys on `order_id`.
- ⚠ **`Distribution.vue` pending keys are `own:<id>` / `guest:<id>`, not bare ids.** `order_items.id` and `guest_order_items.id` are independent sequences, so a bare id would make an own item and a guest bag share one pending flag and one `v-for` key — one tap would silently swallow the other's guard. Applied consistently across the pending map, both `v-for` keys and all four count/gate helpers. Regression-tested with a manufactured collision (needs `DB_PATH`; self-skips without it).
- The per-item pending pattern from GSO-T1 (state patched in place from the PATCH response, no shared lock, no full `loadData()` per tap) was **extended, not regressed** — that global lock was a live prod bug until PR #24.
- Spec-waived residuals (not introduced here): the gate is evaluated only at pack time, so a sub-order submitted after packing leaves an unticked bag (§Edge Cases waives it — distribution happens after lock, and the same hole pre-exists for own items); and `orders` has no `UNIQUE(friend_id, cycle_id)`, so `hostOwnOrder()`'s `.get()` relies on the get-or-create convention plus `instances: 1` — a UNIQUE index would make it safe by construction.
- Spec: same design doc (§UC-GSO-011, Decision 3)

### Guest kilo aggregation — the Decision 4 split (GSO-T8, 2026-08-04)
- ⚠ **The rule that governs every guest aggregate:** **cycle-LEVEL** totals (kg, value, roastery split, tier progress, margin, ordering quantities) **include guests**; **per-FRIEND** aggregates (`num_friends`, `orders_count`, `total_eligible`, the not-ordered nudge list, segmentation, the per-friend analytics table, `top5_share`, `new/returning/churned`, `previous.friend_ids`) stay **friend-only** — a guest must never appear as, or inflate a count of, a friend. Decision 4 says guest rows in `orders` "would silently corrupt all of them"; the same applies to guest rows in a friend aggregate.
- `helpers/guest-aggregation.js` `guestCycleItems(cycleIds)` is the **one** guest UNION for aggregation (the 4th consumer of the shape in `stock.js`/`packing.js`): correlated on `glink.cycle_id`, `COALESCE(gord.status,'submitted') <> 'cancelled'`, and it returns `host_friend_id` unused so **GSO-T9 reuses it rather than writing a fifth UNION**.
- ⚠ **The guest half is merged in JAVASCRIPT, never as a JOIN.** These aggregates are over `LEFT JOIN orders`; a second join multiplies friend rows (the GSO-T6 trap). The unambiguous pin: 1 friend kg + 2 × 1 guest kg = **3.0** (a multiplied friend line reads 4.0) with `orders_count` still 1.
- The **ordering sheet** (`GET /api/cycles/:id/summary`, the "Podľa produktu" Sumár the admin orders from the roastery with) and `roastery_breakdown` now include guests. Before this, T7 had the admin **packing guest bags that were never ordered**. Guest lines merge into the friend line keyed **`product_id|variant`** (an ordering sheet must not list a guest 250g of X separately); a variant no friend ordered becomes its own line from the same `products` metadata.
- `avg_kg_per_person` / `avg_value_per_person` stay **friend/friend** (numerator is `friendKg`, not `totalKg`) because they drive `friends_needed` / `min_viable_base` / `potential_kg` — a guest-inflated average would understate how many friends are still needed. Consequence: `total_kg / num_friends` no longer reproduces the shown average.
- `friends.js` `orderKilos` is **per-friend "your order"** and must NOT absorb guest kg (the host's payable total is own-items-only per T5). There is **no** cycle-level `totalKilos` on `/friends/cycles` — it was removed in 2026-02-03; the older CLAUDE.md note describing it is stale and the GSO-T8 backlog row inherited that staleness.
- ⚠ **`WHERE col = ""` is a BUG in SQLite** — an empty double-quoted token is a quoted *identifier*, and the usual double-quote→string fallback does not apply to the empty string, so it throws `no such column: ""`. This made `GET /api/cycles/:id/summary?roastery=_default` (the "hlavná pražiareň" chip) **500 on every call in production**. Always `''`.
- Single-row picks need an `id` tiebreak: `live-cycle.js` used `ORDER BY created_at DESC LIMIT 1` on **second-resolution** timestamps, so two cycles created in the same second made "the current live cycle" an arbitrary pick — verified to actually flip. Both picks (current + `previous`) now end `, id DESC`. ⚠ `analytics.js:28` still orders the whole series `ORDER BY created_at ASC` with no tiebreak — same class, and ties there perturb `cycleIds.slice(-3)` / streaks / trends. Left as a follow-up because it reorders an approved payload and wants its own test.
- e2e note: Playwright restarts the worker after a failure, so `beforeAll` re-runs — live-cycle specs must build their **own** cycle per test (`freshLiveCycle()`) rather than sharing accumulated state.
- Spec: same design doc (§UC-GSO-013, Decision 4)

### Reward volume credited to the host (GSO-T9, 2026-08-04)
- Decision 5: guest kilos count toward the **host's** reward/voucher volume. `rewards.js` is the **only** place reward volume is computed — it reuses GSO-T8's `guestCycleItems()` and keys the guest half on `guest_order_links.host_friend_id`. `friend-groups.js` has **no** kg queries (pure `is_root`/`root_friend_id` CRUD) and `vouchers.js` derives money from the host's **own** `orders.total`, which the host actually paid — crediting guest totals there would discount money the host never paid. The backlog row and Decision 5's own text conflate the grouping *concept* with the kg *math*; only `rewards.js` does the math.
- ⚠ **Guest kg lives in a SEPARATE `guestKgMap`, added once inside `buildGroupReport`.** Merged in JS, never as a JOIN (the GSO-T6/T8 rule). **This invariant is test-protected, NOT structurally impossible** — folding `guestKgMap` into `kgMap` compiles cleanly and silently **doubles a financial figure**; only the e2e catches it (verified: the mutation fails 7/7 with money-shaped numbers). If this function is ever refactored, use one `{own, guest}` record per (friend, cycle) with two distinct writers so there is no slot to double into.
- ⚠ **`orderedMembers` means "friends with a submitted order" and nothing else.** A guest-only host goes in the separate **`guestOnlyMembers`** list, rendered under its own `Objem od hosti:` heading. Listing them under `Objednali:` was both false on the money screen and a breach of the Decision 4 rule that "who ordered" is answered from `orders` alone — a future consumer reading `orderedMembers` otherwise would be silently wrong. The two lists are disjoint and together account for the whole bar (`kg − guestKg` = own). `memberCount` stays the friend count.
- Deactivating a host **keeps** their reward credit (the report is history and the coffee was bought); hard-deleting one cascades cleanly via `guest_order_links.host_friend_id ON DELETE CASCADE` with `foreign_keys = ON`.
- ⚠ **A dangling `root_friend_id` used to erase volume entirely.** `root_friend_id` was added by bare `ALTER TABLE` with **no FK**, and deleting a root left members pointing at nothing — such a friend landed in *no* bucket and vanished from the whole report (verified: 6.0 kg before a root delete, **0.0 across every bucket** after). Fixed at both ends: the `friends.js` DELETE clears pointers **inside the same transaction** as the delete, and `rewards.js` treats an unresolvable pointer as unassigned. Both halves are tested independently — databases that ran the old delete still contain dangling rows, which is why the tolerance matters as well as the prevention.
- e2e: the dangling-pointer test writes the bad row directly and needs `DB_PATH`; without it the suite reads **213 passed / 3 skipped** instead of 214/2.
- Spec: same design doc (§UC-GSO-014, Decision 5)

### Guest lead capture — the final GSO row (GSO-T10, 2026-08-04)
- ⚠ The CTA has its **own** endpoint — `POST /api/guest/:token/orders/:orderToken/invite-request` — specifically so the host's **`friends.invite_code` is never published into a guest payload**. `friends.js` strips that field from every friend response, and reusing `POST /invitations/register` would have required sending it to anyone holding an office-wide link. **Do not "simplify" this into a reuse of the register route.** It requires the token **pair**, so only someone who actually placed a sub-order can create a lead (and that's what makes the prefill possible).
- ⚠ **`validateIdentity()` in `guest.js` is shared with the shipped checkout submit** — editing it touches GSO-T3's money path. `guest-order.spec.js` is the regression net.
- `invitations.source` is a plain TEXT column (the `onboarding_source` pattern; named `source` because no onboarding link is involved), **server-set in exactly one place**, never from a body. NULL = legacy invite-code registration and renders no badge. `GET /api/invitations` is `SELECT i.*`, so it surfaces with no route change.
- State decisions: a **locked** cycle still allows the CTA (201 — the coffee just arrived, which is exactly when a guest asks for an account), a **cancelled** sub-order still allows it (201 — still a lead), and a **dead link / deactivated host** does not (410 — the lead would be credited to a host who can no longer log in). Resolution therefore uses **T4's read-side 404-only resolver** and re-applies only the 410; the gates it drops (cycle-open, cancelled) are precisely the ones lead capture must not honour. `statusPayload.invite_request.available` carries that to the page, because the page **cannot distinguish a lock from a dead link** (both only clear `editable`).
- Slovak register: the CTA is **"Chcete si nabudúce objednať sami?"** — vy-form, deliberately not the spec's literal "Chceš si nabudúce objednať sám?", which both addresses the reader informally and genders them. The admin-side **"Prišiel cez hosťovskú objednávku"** keeps its participle because it describes a **third party** (the lead), not the reader — same basis as GSO-T6's "Hosť • pozval X". The pin is about the reader, not about all participles.
- Duplicate pending phone → clean **409**, never a 500 (`invitations` has a partial unique index `idx_invitations_phone_pending ON invitations(phone) WHERE status='pending'`). Both an app check and a `UNIQUE`→409 translation exist; **only the app check is load-bearing today** — `instances: 1` plus synchronous better-sqlite3 makes check→insert atomic in-process — but keep the translation for the PM2-cluster scenario the GSO-T3 concurrency note already warns about.
- Accepted risk, recorded: the request phone need not match the sub-order's, so a token-pair holder can occupy someone else's single pending slot and use 201-vs-409 as an "is this number queued" oracle. Bounded by `abuseLimiter`, every probe leaves an admin-visible row, and `POST /invitations/register` has the identical property with a friend's invite code. If ever tightened, compare **digit-normalised**, not exact — a guest may legitimately have typed an office landline at checkout.
- Follow-ups (not done): a guest-sourced lead converted via "Vytvoriť" writes **no** `friends.onboarding_source`, so provenance dies with the invitation row the admin later deletes; and `POST /invitations/register` is now the weaker twin of this endpoint (no length bounds, `{name: 123}` → 500).
- Spec: same design doc (§UC-GSO-015, §Lead Capture)

### Rate-limit buckets, and `backend/public` (follow-ups, 2026-08-04)

### ⚠ `<script setup>` has NO module scope — a singleton declared there is per-instance (ML-T3, 2026-08-15)

`<script setup>` compiles its **entire body** into the component's `setup()`, so a
`const` at its top level is created **fresh for every component instance**. Only
`import`s are hoisted out. A module-scope singleton in an SFC therefore needs a
**plain `<script>` block alongside** `<script setup>` — that is the only way to get one.

Found on `MagicLogin.vue`'s single-shot redemption guard: it lived in `<script setup>`,
*looked* module-scope, and was per-mount — so an in-SPA Back to `/magic/:token` fired the
POST again and **spent a single-use login credential twice**. Caught only by the guard's
own e2e ("Expected: 1, Received: 2"); nothing else would have noticed, because the server
correctly refuses the replay and the page shows the same neutral card either way.

⚠ **It fails silently in exactly the cases that matter** — a guard, a cache, a
"warn once" flag, an in-flight-request dedupe. Verify in the BUILT chunk if unsure: the
declaration must sit at module top level, not inside `setup(…)`.

**Rate-limit buckets — `middleware/rate-limit.js` exports FIVE, each a SEPARATE bucket. Do not collapse them.**
- `authLimiter` (`RATE_LIMIT_AUTH_MAX`, 20) — admin login, friend auth.
- `abuseLimiter` (`RATE_LIMIT_ABUSE_MAX`, 40) — invite-code lookup, onboarding submit.
- `guestReadLimiter` (`RATE_LIMIT_GUEST_READ_MAX`, 300) — guest page loads.
- `guestWriteLimiter` (`RATE_LIMIT_GUEST_WRITE_MAX`, 60) — guest submits, edits, invite requests.
- `magicLinkLimiter` (`RATE_LIMIT_MAGIC_MAX`, 10) — `POST /api/magic-link/request` (ML-T2).

⚠ The magic-link split has its own two reasons, neither shared by the others: an
accepted request triggers an **outbound Mailgun send**, a cost profile no other
bucket has; and on `authLimiter` the office-NAT coupling would let a recovery
spammer behind the shared IP lock colleagues out of **password login** — at
exactly the moment those colleagues need it — and vice versa.

⚠ The guest split exists because a guest link is shared privately **at office scale**, so a whole team usually arrives behind **one NAT'd IP**. While the guest routes sat on `abuseLimiter`, a busy order could exhaust the shared 40 and lock colleagues out of **registering** — and vice versa. Reads are generous because a page load is cheap and repeats (every colleague opening the link, every refresh); writes stay moderate and are additionally bounded by the T3 input caps. Pinned by `e2e/tests/rate-limit-isolation.spec.js`, which exhausts the guest **write** bucket and asserts guest reads, the invite-code lookup and registration all still reach their handlers. It self-skips unless started with a low `RATE_LIMIT_GUEST_WRITE_MAX` (the `rate-limit.spec.js` precedent), so a normal full-suite run reads **231 passed / 3 skipped**.

**`backend/public` is git-ignored build output.** Production never uses it — nginx serves `/var/www/gorifi/frontend/dist` with its own SPA fallback and only proxies `/api` to the backend (`deploy/nginx-gorifi.conf`), and `deploy.sh` rsyncs `frontend/dist`. It exists only for running the app as one prod-like process locally, which is what the e2e recipe does. It **used to be committed**, and by the end was a 2026-03-08 build with zero guest code — so a fresh clone silently served a months-old frontend against current API code, and it broke UI specs until someone rebuilt. Absent beats stale: when `index.html` is missing, non-API routes answer **503 with the build command** rather than an opaque 500 from `sendFile`.

### Guest sub-orders on screen: folding, and the friend-page tab split (2026-08-07)

Four UI-only changes to how guest sub-orders are presented. **No backend, schema or authorization change** — every rule in the GSO-T1..T10 sections above still holds verbatim.

- **Three screens now fold a guest's item list**, each with its own state keyed by `guest_orders.id`: the admin cycle detail orders tab (`CycleDetail.vue`), the admin Distribution page (`Distribution.vue`), and the host's "Objednávky kolegov" (`GuestSubOrders.vue`). Folding is always **manual and defaults to expanded** on the two packing/hand-over screens.
- ⚠ **Distribution deliberately does NOT auto-fold a guest once all their bags are ticked.** It was built that way and reverted: ticking the last bag hides the very rows the admin needs to **untick** after a mis-scan, forcing an expand before every correction — and it dead-locks `guest-distribution.spec.js`'s untick-and-repack flow. Folding is not packing; a folded bag still holds the "Zabaliť" gate closed.
- ⚠ **Distribution folds with `hidden print:flex`, never `v-if`.** A printed picking sheet must still list every bag. Pinned via `emulateMedia({ media: 'print' })`.
- **`FriendOrder.vue` splits into two top-level panels** — "Moja objednávka" / "Kolegovia" — with the share card moved **entirely** into the colleagues panel. Before this, everything guest-related sat above the product list, so the host's own offer started ~860 px down and got worse with every colleague.
- ⚠ **The panels are `v-show`, NOT `v-if`, and that is load-bearing.** `GuestSubOrders` must stay mounted on both tabs or its `summary` emit never fires, and the tab badge — the whole reason the colleagues are still discoverable — would only appear *after* the host opened the tab it advertises. It also stops the hand-over ticks re-fetching on every switch. `GuestSubOrders` is the single owner of that fetch; the parent never queries the link itself.
- Badge: violet with the colleague count at rest; **amber with the not-yet-handed-over count when the cycle is locked** — the only moment the host owes anyone an action. No badge when nobody has ordered, but **the tab stays visible**, because it is now the only place sharing can be found.
- Only the **purpose tabs** stay sticky. Two stacked sticky bars eat a third of a phone screen. The main switch scrolls away, is not persisted and is not in the URL — a locked cycle also opens on "Moja objednávka" (product decision).
- ⚠ `mobile-no-h-overflow.spec.js` targets the purpose strip by **`data-testid="purpose-tabs"`**, not `getByRole('tablist').first()` — the main switch is now the first tablist in the DOM. The two controls have opposite requirements and both are asserted: the purpose strip **must** scroll within itself, the switch **must not** (it has no scroll affordance, so an overflowing label is simply unreachable). The switch shrinks its type/padding below `sm` to fit 320 px.
- Any future child of `FriendOrder` that is friend-authenticated still needs the `ready` auth-ready gate (GSO-T5 rule) — the tab split does not change setup/onMounted ordering.

Full suite after this work: **238 passed / 3 skipped**.

### ⚠ `.app > *` neutralises every Tailwind positioning utility (Podpultovka redesign, 2026-08-07)

`friends-theme.css` (RD-DS-1) declares `.app>*{position:relative;z-index:1}` to keep content above the halftone `.app::before` texture. That rule is specificity `(0,1,0)` — **the same as every Tailwind positioning utility** — and `friends-theme.css` is imported *after* `style.css`, so on a **direct child of `.app`** it wins. Measured live:

| direct child of `.app` | computed |
|---|---|
| `class="fixed z-50"` | `relative / 1` ❌ |
| `class="absolute z-40"` | `relative / 1` ❌ |
| `class="sticky top-0 z-40"` | `relative / 1` ❌ |
| `class="relative z-10"` | `relative / 1` ❌ (z-index silently clamped) |
| theme `.cartbar` / `.cat-tabs` / `.modal-layer` | `sticky 50` / `sticky 40` / `fixed 200` ✓ |
| the same utilities **nested one level deeper** | survive ✓ |

The theme's own classes survive only because they sit *later in the same stylesheet* than `.app>*`. Secondary effect: every direct child becomes a **stacking context**, so `z-*` inside one can no longer compete across siblings.

**This fails silently** — no build error, no failing spec, just a modal that lays out in page flow or a bar that stops sticking. UC-DS-001 states the rule abstractly but names only the `h-screen` collision; the positioning half is the one that actually bites.

**Rule:** a hand-rolled `position:fixed` overlay that is a direct child of `.app` must either **teleport out of `.app`** (correct when its subtree uses no theme tokens — it then also keeps the old `system-ui` font instead of inheriting `var(--font-body)`, which is what "visually untouched" actually requires) or be **rebuilt on `NeoModal`/`.modal-layer`** (correct when it does want the tokens). Radix-portaled dialogs (all shadcn `Dialog`s, `PaymentModal`, `GuestShareDialog`) and `NeoModal` are immune — the risk is confined to hand-rolled overlays.

Known call sites, enumerated when RD-FL-1 landed the first `.app`:
- `FriendPortal.vue` voucher overlay — **fixed in RD-FL-1** via `<Teleport to="body">`; the view now has zero exposed direct children.
- ~~⚠ `FriendOrder.vue` `<header … sticky top-0 z-40>` is a **direct child** of the root.~~ **Resolved in RD-FO-1**: the header is gone, replaced by the non-sticky `BrandChrome`. `order-shell.spec.js` asserts `header` count 0, `.appbar` computing `position: relative`, and the appbar moving 1:1 with the page.
- ~~⚠ `FriendOrder.vue` `TabsList … class="sticky top-16 z-30"`~~ **Resolved in RD-FO-1**: it is `.cat-tabs` now, `top: 0` from the theme, which is correct precisely because nothing above it is pinned any more. Pinned by `order-shell.spec.js` (`top`, `z-index`, and the strip's box actually reaching y = 0 after a scroll) — `mobile-no-h-overflow.spec.js` would not have caught a wrong `top`.
- ~~`FriendOrder.vue` /~~ `GuestOrder.vue` / `GuestOrderStatus.vue` hand-rolled `fixed bottom-0 z-50` cart bars are *nested* inside their page-column div, so they survive as-is. Do not "tidy" them up to root level while they are still on Tailwind utilities. **`FriendOrder.vue`'s is resolved (RD-FO-3)**: it is now `.cartbar` and a **direct child of `.app`**, which is safe **only** because the theme's `.cartbar` rule sits *later* in `friends-theme.css` than `.app>*` at equal `(0,1,0)` specificity — proven by counterfactual, live: a plain `<div class="sticky bottom-0 z-50">` appended to `.app` computes `relative`/`z-index:1`, and the same node with `.cartbar` added computes `sticky`/`50` (rule indices 637 vs 741). RD-GX-1 gets the same free pass **only** when it converts to the theme class — not before.

### FriendOrder shell — the neobrutal chrome, banners, switch and category strip (RD-FO-1, 2026-08-08)

`frontend/src/views/FriendOrder.vue` is now an `.app` scope (04 §UC-FO-001..004). **Shell only** —
product cards (RD-FO-2), the cartbar (RD-FO-3), the modals (RD-FO-4), the locked composition
(RD-FO-5) and the Kolegovia panel's *contents* (RD-KG-1) are still on the old skin by design.

- **Appbar subtitle is the friend's NAME ONLY.** The prototype shows "Lego · X42KPGZZ", but
  `GET /orders/cycle/:id/friend/:id` returns `{id, name, packeta_address}` and `friends.js` strips
  `invite_code` from every friend response. Module 03's portal appbar sources its uid from the
  *session*, which `guest-host-view.spec.js:641-647` proves is **optional** in the stored shape — so
  a code here would render for some friends and not others. Consistency won; revisit only if a
  client-side code source becomes guaranteed.
- ⚠ **The green "odoslaná" banner now YIELDS while unsent changes exist**
  (`isSubmitted && cartItems.length > 0 && !hasUnsubmittedChanges`). That is the prototype's
  `submitted && !dirty && lines > 0` — a deliberate handoff UX change, in contract, and the cartbar
  warning carries the state instead. It is a *condition*, so nothing but a spec can catch its loss.
- ⚠ **The badge computeds live in this view and module 05 must never re-own them.**
  `guestBadgeIsPending = isLocked && pendingDelivery > 0`, `guestBadgeCount = pending ? pendingDelivery : count`,
  fed exclusively by `GuestSubOrders`' `summary` emit. The badge has to be right *before* its tab is
  opened, which is only possible from the parent. Visuals follow the prototype and semantics follow
  the repo (resolved conflict #1): plain white `.tabbadge` at rest, amber `.tabbadge.pending` only
  when locked with an outstanding hand-over. The prototype paints pending unconditionally — wrong here.
- **Both panels stay `v-show`.** Same rule as 2026-08-07, now also asserted structurally
  (`#panel-guests` present in the DOM with `style.display: none` while the own tab is active).
- **One product list, not two.** The radix `TabsContent` panels and the "only one purpose" fallback
  were byte-divergent copies of the same card markup, and the fallback was the **poorer** copy in
  **four** ways: no roast/roastery badges, no `canIncrement` on "+", **no stock-limit bar at all**
  (no `getRemainingGrams`, no "Vypredané"), and **no 500 g variant** — its own comment said so
  verbatim: `<!-- Weight variants (150g / 200g / 250g / 1kg) -->`. The two that mattered HID PRODUCT
  from the user: on a single-purpose cycle a 500 g option was unbuyable and no stock bar existed
  even when the product had a `stock_limit_g`. ⚠ The
  missing `canIncrement` was **cosmetic only** — `increment()` already returns early on
  `!canIncrement` (`2ecb934:519`), so the button was *dead*, not an over-order path; an earlier
  version of this note claimed the limit "could be stepped past", which is wrong. Collapsed into
  `activeProducts` (the active purpose only): after stripping indentation the surviving card block is
  byte-identical to the `TabsContent` one apart from the `v-for` source, so nothing was lost from the
  richer copy. Net −280 lines and one card for RD-FO-2 to restyle; the strip is still absent when
  there is a single purpose.
- **`.tabgroup` fits 320 px — and the BADGE, not the label, is what spends the margin.** The model is
  `min₁ + min₂ + gap ≤ content`: `grid-auto-columns: 1fr` is `minmax(auto, 1fr)`, so each track floors
  at its own min-content and only the surplus is shared. "Moja objednávka" therefore legitimately
  **exceeds** its half cell (136.2 px border-box against 133.5 px) and the Kolegovia track hands the
  difference back. ⚠ An earlier version of this note read the tab's `clientWidth` (132) against its
  own border-box (136.2) and called the 4.2 px difference "spare" — it is the tab's own transparent
  2 px border, not slack. Measured at 320 px (content box 272 px, gap 5 px): **41.3 px** headroom with
  no badge on Figtree, 32.5 px on the fallback face, **12.3 px with a 1-digit badge** (the shipped
  state), 3.6 px with a 1-digit badge on the fallback face — and a 3-digit badge on the fallback face
  **overflows by 2 px**. No override shipped, but the margin is thin and data-dependent.
  ⚠ Neither `mobile-no-h-overflow.spec.js`'s seeded cycle nor `order-shell.spec.js` originally put a
  badge on screen at 320 px, so the tight case was **untested**; `order-shell.spec.js`'s 320 px test
  now creates a real guest sub-order, asserts the badge is rendered (a non-vacuity gate) and asserts
  the headroom stays positive. If an override is ever needed it goes on `.tabgroup .tab` only and
  **cannot be a Tailwind utility** — that selector is `(0,2,0)` and `friends-theme.css` loads after
  Tailwind, so it needs a scoped block.
- ~~⚠ `successMessage` ("Košík bol uložený")~~ **RETIRED in RD-FO-3.** It was reachable, unreadable, and once actively wrong: `saveCart(false)` was its only writer and `doSubmitOrder()` its only non-silent caller, so it had **no user-initiated trigger** — after a successful submit it rendered behind the success modal, which navigates away on close, and after a **failed** submit it sat plainly **next to the error banner**, "saved" and "failed" side by side for 3 s. Retired rather than cleared, because clearing would have left a ref, a timeout and a banner no reachable state ever shows. Pinned by a test that stubs the submit to 500 and asserts the error banner appears **alone**.
- The Kolegovia **share card** (RD-KG-1's to restyle) is pinned by TEXT, not structure — the
  accessible names `Zdieľať objednávku s kolegami` (`guest-link.spec.js:259`,
  `guest-host-view.spec.js:945`) and `Zdieľať odkaz`, matched as `/Zdieľať/` when a locked cycle
  asserts count 0 (`guest-host-view.spec.js:929`), plus `getByText('Objednávate aj pre kolegov?')`
  (`:944`). Its `p-4` is **not** pinned: `guest-link.spec.js`'s `div.p-4` `cardFor()` locator only ever
  runs after `page.goto('/')`, i.e. on the **portal**, so the "never use the `p-4` shorthand" rule
  belongs to `FriendPortalSession.vue` (where it is documented) and does not constrain this route —
  UC-DS-004 rule 2 lists `p-4` among the allowed layout utilities. The order page's column uses axis
  utilities for consistency with the portal, not because a spec requires it.
- **snapTab is proven by A/B, not asserted** (02 §UC-DS-012's deferred obligation, discharged in
  `e2e/tests/order-shell.spec.js`): the same tab, same page — `snapTab` centres the strip and leaves
  `window.scrollY` at 0, `scrollIntoView()` scrolls the *document*. ⚠ Both halves need a **short
  viewport**: with one card per purpose the page does not scroll at 844 px tall and `scrollIntoView`
  looks as innocent as `snapTab`. ⚠ The centring tolerance is 24 px because `.cat-tabs` is
  `scroll-snap-type: x proximity` and re-snaps to the nearest tab edge after the smooth scroll
  (measured 5 px off the ideal centre), and Chromium serialises that computed value as bare `"x"`.
- The back chevron, both switch tabs and every category tab carry the house zero-pixel ARIA layer
  (role + tabindex + Enter/Space). Not decoration: the controls they replace were a real `<button>`
  and radix `TabsTrigger`s, both natively focusable — pointer-only spans would have been an
  accessibility **regression**, and the Kolegovia panel plus every non-first category would have
  become keyboard-unreachable. ⚠ The chevron's label is **"Späť"**, not "Späť na zoznam cyklov":
  the fatal-error state renders a button with that exact text and Playwright matches accessible
  names as a case-insensitive SUBSTRING unless `exact: true`.
- Dropped with this row: the per-category page tint (`backgroundClass`) and the coloured
  `TabsTrigger` classes (resolved conflict #7) — the active tab is `.tab.on` and nothing else.
  `Alert`, `Badge` and `Tabs*` imports are gone; `Card`/`CardContent`/`Button`/`Dialog*` stay because
  RD-FO-2..4 still own that markup.

Full suite after this work: **367 passed / 3 skipped** (+14, zero pre-existing specs modified).

### RD-FO-2 — product cards, the `.vbox` matrix, the stock bar (04 §UC-FO-005..007)

- **One card root, two bodies.** `Card`/`CardContent` are gone from the product list; `.card` IS the
  neo card. `FriendOrder.vue` still imports them for the Kolegovia share card (RD-KG-1), and `Button`
  for the **modals** (RD-FO-4) and that same share card — the cartbar stopped needing it in RD-FO-3.
  Do not "clean up" those imports before RD-FO-4 and RD-KG-1 both land.
- ⚠ **`GuestProductGrid.vue` is the guest-side twin and deliberately stays on the OLD skin until
  RD-GX-1.** Its `getGroupQuantityTotal` (the whole-card `ring-2 ring-primary`) still exists there;
  the friend view's copy is gone, because 04 §UC-FO-007 replaces the ring with per-`.vbox` `.sel`.
- ⚠ **`COFFEE_VARIANTS` is the fixed order and the CART KEYS.** One `.vbox` per non-null price field:
  `price_150g/200g/250g/500g/1kg/20pc5g` → `150g … 20pc5g`. The old template gated every weight
  behind `v-if="!product.price_20pc5g"`, so a product priced for capsules **and** weights showed only
  the capsules — a published price nobody could buy. Only `label` is presentational
  (`20pc5g` → "20 ks × 5g"); the `variant` string is `order_items.variant` and `variantGrams`' key.
- ⚠ **The gram math is untouched (04 resolved conflict #6).** `getRemainingGrams` / `canIncrement` /
  `variantGrams` / `loadAvailability(excludeFriendId)` are verbatim; only the DISPLAY became kg.
  `kg(g) = Math.round(g/10)/100 + ' kg'` — up to 2 decimals, trailing zeros stripped, dot decimal
  (250 → "0.25 kg", 1000 → "1 kg", 1250 → "1.25 kg"). A `toFixed(2)` "tidy-up" would render "1.00 kg".
  The fill includes the friend's **own uncommitted cart**, so the bar moves before anything is saved.
  Fill is always accent magenta; the sold-out signal is the danger-red **"Vypredané"** LABEL, never a
  bar colour (the old amber/red bar tinting is gone).
- ⚠ **The `+` ceiling is BOTH `incDisabled` AND the `canIncrement` re-check in `onQty`.** 02
  §UC-DS-008 forbids a `max` in `NeoStepper`, so the rule lives in the view. `incDisabled` carries the
  shipped `:disabled` semantics to assistive tech and costs no fidelity — RD-DS-3 recorded that the
  theme has no `.stepper button:disabled` rule, so the button looks identical, which IS the silent
  refusal 04 §UC-FO-006 asks for. `onQty` routes every increase through `increment()`, so a click that
  bypasses the disabled attribute still cannot exceed the limit. Never bind `setQuantity` to a
  stepper's `update:modelValue` — that hands it an unchecked write and retires the ceiling.
  ⚠ **But the `onQty` half is NOT test-covered, and cannot be.** `NeoStepper.inc()` returns early on
  `incDisabled`, so a forced click never reaches `onQty`; `incDisabled` and `canIncrement` read the
  same state in the same tick, so there is no e2e-reachable state where the button is enabled and the
  increment would still exceed the limit. The suite pins `incDisabled` + the silent refusal only.
  Consequence for **RD-FO-3**: if the cartbar's steppers omit `incDisabled`, nothing in the suite
  notices the ceiling going away — bind it, and don't trust a green run as proof.
- ⚠ **The 368px column fallback — and it is 368 because `.card` has a 3px border.** 04 §UC-FO-005
  mandates `1fr 1fr` for >1 variant. A `.vbox`'s min-content is 146px (the 38+24+38 stepper plus two
  10px gaps = 120, plus 11px padding and 2px border a side); two of them plus the 10px gap need 302px
  of card CONTENT box, and that box is `viewport − 32 (page column) − 28 (card padding) − 6
  (`.card`'s own `border:3px`, friends-theme.css:45)` ⇒ **368px**. At 378px the tracks are 151px,
  which only reproduces from `−66`; a `−60` derivation predicts 154px and is how the number first
  shipped as 362.
  ⚠ **The 6px error was invisible.** `grid-cols-2` is `repeat(2, minmax(0,1fr))` — track minimum
  **zero** — so across 362–367 the tracks sat *below* min-content and the shortfall was absorbed by
  the flex stepper buttons shrinking to 36.5–37.75px, silently losing the 38×38 hit target 02
  §UC-DS-008 pins as "from CSS — do not override". Pinned now by the 364px case in
  `order-product-card.spec.js`; any future breakpoint on this grid must assert button size, not
  just column count.
  ⚠ **The media query is NOT what satisfies `mobile-no-h-overflow`** — the class-vs-inline switch is.
  Forcing `grid-cols-2` at 320px gives a document overflow of **0** (122px tracks, 26px buttons: ugly,
  not overflowing). The 15px overflow only appears with the spec's literal inline
  `gridTemplateColumns:'1fr 1fr'`, because bare `1fr` is `minmax(auto,1fr)` and `auto` floors the track
  at min-content. So `grid-cols-*` CLASSES exist for two reasons — a media query cannot reach an
  inline style, **and** `minmax(0,…)` is what stops the document scrolling — while the media query's
  own job is protecting the `.vbox` from being squeezed. RD-GX-1 inherits this whole derivation.
- ⚠ **`min-w-0` is not `overflow-wrap`.** Both product-card text columns carry an inline
  `overflow-wrap:anywhere` (the RD-FL-4 `plan_note` precedent). `min-w-0` lets the flex item SHRINK;
  an unbreakable token still paints outside it — a 44-char space-free product name put the `<h3>` at
  479px inside a 183px column and scrolled the document **263px** sideways at 320px. Set on the
  CONTAINER, not the `h3`, because `overflow-wrap` inherits and `description1`/`description2` are
  equally free admin text. A hyphenated name does **not** reproduce it (`-` is a break opportunity),
  which is why the fixture name is spelled without one.
- **`phone` is CSS, not a reactive.** The prototype's `phone` is a demo frame toggle
  (`device === "phone"`), not a media query; this port expresses it as Tailwind `sm:` like module 03
  already does (`px-4 sm:px-7`). No `resize`/`matchMedia` listener exists on this view — do not add
  one. ⚠ The one thing a class **cannot** carry is `line-height`: `friends-theme.css` loads after
  Tailwind and `:where(.app,…) .display` ties `leading-[0.95]` on specificity, so every line-height
  in these cards is an INLINE style.
- Text metrics: every text-bearing element in both cards carries an A10-covered class
  (`.display`, `.badge`, `.sub`, `.mono`, `.vbox .vsize`, `.vbox .vprice`, `.stepper .val`), so no
  call-site `line-height:normal` was needed and **A10's selector list did not grow**.
- ⚠ **`.pimg` no-photo = the BARE FRAME** — built-in dark gradient, zero children, no `.band`/`.cap`/
  `.lbl`, no placeholder icon. This closes 02 §UC-DS-013's OPEN and is recorded there; RD-GX-1
  inherits it for `GuestProductGrid.vue`.
- Product name is `<h3 class="display">` on **both** card types (04 §UC-FO-015 pins
  `getByRole('heading')` for `guest-host-view.spec.js`); on the bakery card it is additionally
  `inline` so the subtitle sits on its baseline.
- `NeoStepper`'s first regression net is `e2e/tests/order-product-card.spec.js` (02 §UC-DS-014 item 6):
  v-model round-trip, the `min` floor **and its no-emit rule** (a no-op tap at 0 must not dirty the
  cart, or the leave guard fires on nothing), the stock ceiling, and the `.sel` flip.
- ⚠ **`order-shell.spec.js:337/342` were re-pointed** from `{ name: '+' | '-', exact: true }` to
  `{ name: 'viac' | 'menej' }` — 03 §UC-FL-013 case (b), structurally unsatisfiable against a
  mandated primitive (`NeoStepper` labels its buttons in Slovak and renders U+2212, and an aria-label
  wins over text content, so **both** lookups broke). One pre-existing-spec file edited: **0**;
  pipeline-authored spec files edited: **1**, two lines.

Full suite after this work: **379 passed / 3 skipped** (+12).

### Podpultovka friends-portal restyle — what survives it (2026-08-09)

A 25-row, frontend-only re-skin of the friend + guest portal (`friends-theme.css`,
`components/neo/`, `.app` / `.modal-layer` roots). ⚠ **`git diff 7c3f85e..HEAD -- backend/`
is empty** — every GSO-T1..T10 rule above still holds verbatim, and `frontend/src/api.js`
was never touched, so no request shape or header set moved.

- ⚠ **`.app > *` neutralises Tailwind positioning utilities on a direct child.** No build
  error, no failing spec — `.cartbar` stays sticky only by cascade order. A plain
  `sticky` div as a direct child of `.app` computes `relative`.
- ⚠ **`.m-foot .btn` is `nowrap` + `flex:1` with `min-width:auto`, so a too-wide modal
  footer gives NO degradation signal** — no shrink, no wrap, no ellipsis; it paints
  outside the border and hands the scrim a scrollbar. Measure **min-content**, never the
  flex-resolved width. The ≤400px padding relief is invisible only while the even split
  clears **both** floors — three rows recorded "invisible at every width" and **two were
  false**. Never generalise one footer's verdict to another button pair.
- ⚠ **Tailwind preflight sets `svg{display:block}`**, which breaks an inline icon+text
  badge onto two lines. Fix at the call site with `inline-flex`, never by widening the
  theme's `line-height:normal` selector list.
- ⚠ **`v-if` on modal mounts is load-bearing** — shipped specs locate "Zavrieť" unscoped,
  so an always-mounted dialog matches them and its scrim swallows clicks.
- Playwright matches role names as a **case-insensitive substring** unless `exact: true`.
- Vue's `condense` deletes a newline-bearing whitespace node between elements, silently
  concatenating adjacent strings.
- Session state: `FriendPortalSession.vue` is keyed on the **auth handshake, not the
  friend id** — keying on identity flushes at the first `await` while `entry` is seeded
  once at setup, so friend B mounted with friend A's data (six consecutive leak bugs,
  worst of which auto-opened B's credential dialog pre-filled with A's plaintext password).

**Running the e2e suite locally** (528 tests, ~11 min) — three harness traps that each
produce plausible wrong numbers:
- ⚠ **`CORS_ORIGIN` must include the gate's own origin.** The default allowlist is
  the skolar.sk pair + the podpultovka.biz trio + `localhost:5173` (see `index.js`), so a
  same-origin SPA on `localhost:3997` gets **500 on every XHR** and renders a blank body —
  surfacing as ~31 unrelated-looking UI failures that read exactly like a regression.
- ⚠ **`e2e/seed.mjs` is not optional** on a fresh `DB_PATH`, or every admin-authenticated
  spec fails at the login field.
- ⚠ Confirm the port is **free first** (a stale server serves a `backend/public` deleted
  underneath it), check `echo "EXIT: $?"` rather than piping through `tail` (which returns
  *tail's* status), and remember `pkill -f` matches its own shell — chain nothing after it.

### ⚠ Brand webfonts are SELF-HOSTED, and the gate had no CSP at all (RD-DS-6, 2026-08-09)

The Podpultovka restyle shipped with a `<link>` to `fonts.googleapis.com` in
`frontend/index.html`. Production **and** staging nginx send
`style-src 'self' 'unsafe-inline'; font-src 'self' data:`, which blocks the Google
stylesheet **and** the `fonts.gstatic.com` woff2 files. Measured live on staging:
`document.fonts.size === 0`, one `style-src-elem` violation, and every screen rendering
in the `Inter, sans-serif` fallback. The whole 25-row restyle was verified in the wrong
typeface.

- **Fixed by self-hosting, never by relaxing the CSP.** `font-src 'self'` already permits
  it, so there is **no deploy-config change** — `frontend/public/fonts/*.woff2` (Vite
  copies `public/` to `dist/` verbatim, so `/fonts/x.woff2` is the runtime URL and it is
  **not** hashed or bundled) plus `frontend/src/fonts.css`, imported from `main.js`.
  `friends-theme.css` was deliberately **not** touched — it is a byte-for-byte design-canon
  port with a numbered adaptation list, and this belongs to none of it.
- ⚠ **`latin-ext` is a SEPARATE subset and is NOT optional.** `á é í ó ú ý ô` are `latin`
  (U+0000–00FF), but **`č š ž ľ ť ď ň ĺ ŕ` are U+0100–017F**. Ship only `latin` and every
  one of those falls back to another typeface **mid-word** — "Zrušiť", "Späť", "Prihlásiť",
  "Objednávky kolegov". Both subsets ship for all three families, with Google's
  `unicode-range` descriptors preserved verbatim so the browser still picks per character.
  Any future face added here needs both.
- Figtree is a **variable** font: Google emits five `@font-face` blocks (400–800) that all
  point at **one file per subset**. Kept verbatim — 17 rules, 9 files, ~118 KB. Darker
  Grotesque's `vietnamese` subset is kept too: `unicode-range` means it is never fetched by
  a Slovak UI, so it costs nothing at runtime.
- ⚠ **`document.fonts.check()` is not a valid probe** — it returned `true` on staging while
  zero faces were loaded (it answers "would this family be used", not "did the bytes
  arrive"). Use `FontFace.status === 'loaded'` or a rendered-width measurement.
- ⚠ **THE ROOT CAUSE IS THE GATE, NOT THE LINK: every e2e run in the whole effort went
  against Express on `localhost:3997`, which sends NO security headers.** The suite could
  not see a CSP failure of any kind. `e2e/tests/self-hosted-fonts.spec.js` closes it by
  standing up a throwaway static server over `frontend/dist` that sets
  `deploy/nginx-gorifi.conf`'s exact header, and asserting zero
  `securitypolicyviolation` events — **if that header ever changes, change the copy in the
  spec too.** Verified non-vacuous — reverted to the pre-fix build, 4 of its tests fail.
- ⚠ **The same CSP was blocking a SECOND asset, and the first version of this entry
  overstated the sweep that should have caught it.** `InviteRegister.vue` loaded the
  Goriffee logo from `https://www.goriffee.com/...png`, which `img-src 'self' data:`
  blocks — a broken logo on the **public** registration page. (That URL also 404s
  upstream now, so it was dead twice over; the replacement is the brand's current
  official mark, self-hosted at `frontend/public/goriffee-logo.svg`. ⚠ Its colour
  treatment differs from the retired PNG — white wordmark on a black plate — and is
  **pending design sign-off**.) The spec's "zero non-same-origin requests" assertion only
  ever visited `/`, so it could not have caught it. It now sweeps **`/`, `/invite/:code`
  and `/g/:token`** — every public unauthenticated route that renders its own chrome —
  which is what makes "this catches the next CDN link somebody adds, font or not" a true
  claim rather than an aspiration. **Any new public route must be added to that list**; an
  authenticated one is covered for chrome by its own spec. `revolut.me` in
  `FriendOrder.vue`/`PaymentModal.vue` is deliberately out of scope: those are `<a href>`
  navigations, not subresource fetches, so no CSP directive applies and nothing is
  requested until the user clicks.
- Residual, not introduced here: `friends-theme.css:207` `.pimg .lbl` asks for `'Anton'`,
  which was never loaded by any `<link>` and is not self-hosted either. RD-FO-2 made `.lbl`
  unreachable (the no-photo `.pimg` is a bare frame), so it is dead, not broken.
- Nginx caching was left alone: `/fonts/` falls through to `location /`, so it gets
  ETag/Last-Modified 304s rather than `/assets`' `expires 1y; immutable`. Deliberate — the
  filenames are **not** content-hashed, so `immutable` would pin a stale face forever if the
  subsets are ever refreshed from Google.

### ⚠⚠ GA-T8 — `await` in a handler BREAKS the `instances: 1` atomicity assumption (2026-08-17)

The standing concurrency note says non-transactional check-then-write is safe because
`deploy/ecosystem.config.cjs` sets `instances: 1` **and the handlers are fully
synchronous** (better-sqlite3). Module 10 is the first code to put an `await` — a network
call to Google — **between a uniqueness check and its INSERT**, and that second clause is
what the safety actually rested on. It no longer holds anywhere an `await` appears.

`POST /api/invitations/register` is the first instance: request A carrying a Google token
yields at `verifyGoogleIdToken`, request B passes the same phone dedupe during that
window and inserts, and A's INSERT then hits `idx_invitations_phone_pending` and falls
into the generic catch — **500 on a public endpoint whose contract is a 409.** No bad row
is written (the index holds); the failure is the wrong status and a stack in the log.

- **The fix is BOTH layers, and neither alone is enough.** Re-run the check immediately
  before the INSERT inside the async branch (keeps the synchronous path untouched), **and**
  translate `SQLITE_CONSTRAINT*` + the exact index message into the same 409 — the GSO-T10
  pattern, which is also the layer that survives a future PM2 cluster.
- ⚠ **Match on `code.startsWith('SQLITE_CONSTRAINT')` PLUS the exact message**, never a
  bare `/UNIQUE/i` — a future index on the same table would otherwise start answering 409
  for the wrong reason.
- ⚠ **`node:sqlite` and `better-sqlite3` report DIFFERENT error codes for the same
  violation** (`ERR_SQLITE_ERROR` vs `SQLITE_CONSTRAINT_UNIQUE`). The e2e helpers use
  `node:sqlite`; the routes use better-sqlite3. **A probe written against the test driver
  will "pass" while proving nothing about the route.** Verify a constraint-translation
  guard against the driver the route actually loads.
- ⚠ The window is **unreachable over HTTP in this suite** — only `TEST:` tokens verify and
  they resolve in a microtask, which never yields to another request. So it is provable
  only by a direct probe, and a green suite says nothing about it.
- **Rule going forward:** any handler that gains an `await` must be re-read for
  check-then-write pairs that were previously atomic by virtue of being synchronous.
  GA-T4/T5/T7 added `await`s to handlers with no such pair; that was luck, not design.

### ⚠ GA-T5 — shared-password mode is a credential-planting surface (2026-08-16)

`PUT /api/friends/:id/google-link` carries a **modern-mode guard** (409
`field:'auth_mode'`). It is not decoration and it is not symmetry with the login route —
without it, **two requests using only the office-wide shared password plant an
attacker-controlled Google credential on any friend's row**, reproduced live:

```
POST /api/friends/auth {password: <shared>, friendId: <victim>}  → 200, Bearer token
PUT  /api/friends/<victim>/google-link {id_token: <attacker's>}  → 200, google_sub planted
```

The legacy dropdown login mints a per-friend session for **anybody** from the shared
password alone (`friends.js:226`), so `requireFriendOwner` + a resolved-identity gate stop
only the ONE-request (`X-Friends-Password`) form. The planted link is inert while legacy —
then becomes a **permanent alternative credential the moment `auth_mode` flips to modern**,
surviving the victim's own password change, which no other legacy primitive does. The
migration window does not cover it, because the blast radius outlives the window (the
UC-FC-009 reasoning at `friends.js:967-990`).

- ⚠ **Any future route that writes a CREDENTIAL needs this guard**, not just an ownership
  guard. Ownership is meaningless while a shared password can mint anyone's session.
- ⚠ **Recorded residual:** the same two-request form still reaches **unlink** and
  **prompt-dismiss** in legacy mode. Neither plants a credential (sever a login method,
  silence a prompt — both recoverable, and in legacy nobody logs in via Google anyway), and
  §UC-GA-004 mandates no mode guard on either. Revisit if either gains destructive weight.
- ⚠ `requireFriendOwner` returns `{friendId: null}` for bare shared-password auth whenever
  `auth_mode !== 'modern'` — **the spec's "guarded … with a RESOLVED friendId" describes a
  guard that does not exist.** `friends.js:398/745/958`, `subscriptions.js:10,21` and
  `transactions.js:55` share the hole; all read or write self-correcting data, which is why
  only the contact half of `PATCH /:id/profile` was hardened before.
- ⚠ **The app-level 409 pre-check is load-bearing independently of `instances: 1`:**
  `schema.js:663-667` creates `idx_friends_google_sub` inside a **swallowing** try/catch, so
  on any DB where creation ever failed the pre-check is the ONLY defence. The two layers are
  HTTP-**indistinguishable** (deleting the pre-check leaves every HTTP test green — the
  single-statement UPDATE rolls back atomically), so layer 2 is provable only by calling
  `writeGoogleLink()` directly against a real migrated DB.
- The 409 body is frozen at `{error, field}` and names **no** friend — id, name, uid, email
  and sub are all asserted absent, or linking becomes a friend-table enumeration oracle.

### ⚠ GA-T3 — the ONE sanctioned CSP exception, and the THIRD policy copy (2026-08-16)

Google Identity Services needs four **scoped** path sources. They are added to
`script-src` / `style-src` / `connect-src` and a **new** `frame-src`, per Google's current
docs (`developers.google.com/identity/gsi/web/guides/get-google-api-clientid`, §CSP —
the older `/guides/csp` URL is stale). **Nothing else is relaxed**: `font-src 'self' data:`
and `img-src 'self' data:` are byte-identical to RD-DS-6. Fixing a CSP problem by
loosening is still forbidden; this is the one exception and it stays minimal.

- ⚠ **THE POLICY LIVES IN THREE FILES, NOT TWO.** `deploy/nginx-gorifi.conf` (3 lines),
  `deploy/nginx-gorifi-staging.conf` (3), **and `docs/deploy/nginx-proxy-manager.md`**
  (report-only). That third one is the dangerous one: NPM is a real hop in front of
  **both** prod and staging, and the runbook's own Notes tell the operator to promote it
  from `-Report-Only` to enforcing. Promoting the pre-GIS version would have killed
  Google sign-in in production — the RD-DS-6 failure mode exactly, invisible to every
  gate. All seven lines are now machine-checked: `self-hosted-fonts.spec.js` reads all
  three files off disk and string-equals every line against `PROD_CSP`, so drift in
  either direction reddens and names the file.
- ⚠ **The residual is what an operator PASTED into NPM's web UI** — that lives in a
  database on the proxy host, not the repo, and no suite can reach it. The manual check
  is `docs/deploy/nginx-proxy-manager.md` §2b's `curl -sI … | grep -i content-security`.
- ⚠ **`frame-src` is a NEW directive and it REPLACES the `default-src 'self'` fallback**,
  so **same-origin iframes are now blocked too**. Free today (the app renders none — the
  only `'iframe'` token in `frontend/src` is `NeoModal.vue`'s focus-trap selector), and
  pinned by a test, so the day someone legitimately needs one they get a red test rather
  than a blank frame. Add `'self'` to all three copies if that day comes.
- **`frontend/src/lib/gis.js` is the ONE home for GIS script loading** — never
  `index.html`, never guest routes. Idempotent, dedupes concurrent callers onto one
  promise and one tag, **times out rather than hanging** (a blocked Google must degrade
  to the password form), clears itself after failure so a retry works, and **resolves
  `null` when `googleClientId` is null** so call sites need no separate guard. It does
  NOT call `initialize()`. ⚠ Options apply only to the call that *starts* the load.
- Route sweep: `accounts.google.com` allowed on `/` and `/invite/:code` **only**;
  **`/g/:token` and `/magic/:token` stay at ZERO external requests**. Nothing imports the
  loader yet and *that zero is asserted*, so GA-T4 turning it on is a loud, self-
  describing failure rather than a silent drift.
- ⚠ **Use `BASE_URL=http://localhost:3997`, never the IP.** `CORS_ORIGIN` allows
  `localhost` but not `127.0.0.1`, and the built `index.html` loads its assets with
  `crossorigin` — so the IP gives a **500 on the stylesheet** and `document.fonts.size
  === 0`, which reads exactly like a font regression.
- For a future hardening pass: Google wants `Referrer-Policy:
  strict-origin-when-cross-origin` (both confs already send it), and if anyone ever adds
  `Cross-Origin-Opener-Policy` it **must** be `same-origin-allow-popups` or the GIS popup
  goes blank. None is sent today.

### `.cat-tabs` scroll affordance — `CatScrollArrow.vue` (2026-08-10)

The theme's only overflow signal on the category strip was `.cat-tabs::after`, a 28px
`transparent → --bg` fade. Users read it as a soft edge, not as "there is more to the
right", so categories past the fold went unfound. `components/CatScrollArrow.vue` adds an
accent control at the strip's right edge that both signals the overflow and performs the
scroll. **No theme rule was added** — `friends-theme.css` is untouched and its adaptation
list still ends at A11; the whole control is one SFC with `<style scoped>`.

- **ONE component, TWO call sites** — `views/FriendOrder.vue` and
  `components/GuestProductGrid.vue` (which itself serves both `/g/:token` and the
  status/edit screen). They are the same control; never inline a second copy.
- ⚠ **It must stay the LAST DIRECT CHILD of `.cat-tabs`, and it finds that scroller via
  `parentElement`** — not via a prop. `position:sticky` only pins against the scroll
  container the element actually lives in, so "the element I am a child of" and "the
  element I control" are necessarily the same node; a prop could disagree with the DOM.
- ⚠ **Sticky-inside-the-horizontal-scroller is the only technique that works**, and it is
  the theme's own (`.cat-tabs::after` is `position:sticky; right:-1px`). Do **not** wrap
  `.cat-tabs` in a positioned container to get `position:absolute`: `.cat-tabs` is itself
  `position:sticky; top:0`, and a wrapper box its own height leaves it no travel — it
  silently stops sticking (`order-shell.spec.js` pins top/z-index/y=0-after-scroll).
  `display:contents` generates no box, so it rescues nothing.
- ⚠ **`z-index: 2` is load-bearing.** `::after` is generated content — last in paint order —
  and is itself sticky with `z-index:auto`, so without it the fade washes over the arrow.
  Pure appearance bug: every behavioural assertion still passes. Pinned by **sampling the
  rendered pixel** (screenshot → `data:` URL → canvas → `getImageData`), because the thing
  covering it is a pseudo-element that cannot be located or hit-tested. Mutation-verified:
  removing the z-index reads `rgb(255, 165, 199)` against the accent's `rgb(255, 45, 135)`.
- ⚠ **`margin-left: -44px` cancels the arrow's contribution to `scrollWidth` exactly** —
  its own `36px` plus one more `8px` flex `gap`. Without it a strip whose tabs comfortably
  FIT reports an overflow and renders an arrow that scrolls nowhere, and `scrollWidth`
  moves as the arrow appears/disappears at the right end. The 8px is the theme's
  `.cat-tabs { gap: 8px }`; if that gap changes, this number moves with it.
- ⚠ **The hidden state is `display:none` AND `position:static`**, and the element is always
  rendered (class toggle, not `v-if`) so `parentElement` survives. A `position:sticky`
  element still *computes* as sticky while `display:none`, which would have put a hidden
  affordance into `guest-order-shell.spec.js`'s exact sticky census. That spec's fixture
  has two purposes that fit, so it honestly still reads `['cat-tabs','cartbar']`; the set
  **with** the arrow showing — `['cat-tabs','catarrow on','cartbar']` — is pinned in
  `cat-scroll-arrow.spec.js`. It is not a fourth page-edge bar: it rides the strip's own
  right edge, inside the scroller.
- ⚠ **`aria-hidden="true"` + `tabindex="-1"`, deliberately.** `.cat-tabs` is a
  `role="tablist"` whose children are `role="tab"`; a focusable control there breaks the
  ARIA contract and inflates the count `mobile-no-h-overflow.spec.js:84` asserts. Same
  basis as the appbar's profile pencil — exactly one control answers to an action's name,
  and this is an adjacent, pointer-only duplicate of scrolling. Nothing is lost: the tabs
  are focusable and focus scrolls them into view.
- Re-measures on `scroll`, on a `ResizeObserver` (disconnected on unmount) **and on
  `document.fonts.ready`** — tab widths are font-metric driven and Figtree loads async, so
  the first measurement runs against the fallback face.
- Judgement call, recorded: the arrow overlays the strip's rightmost ~40px, so a tab
  resting exactly there is partially un-tappable. No `scroll-padding-right` was added —
  tabs are ≥70px wide so a clickable region always remains, and the arrow withdraws at the
  right end, which is where it would bite most. Revisit if short category names appear.

Full suite after this work: **554 passed / 3 skipped** (+9).

### Colleague kilos on the portal card + grouped cart lines (2026-08-12)

Two product decisions, **frontend only** — `git diff -- backend/` is empty, `api.js` is
untouched, and no request shape or endpoint moved. Both were specified from screenshots
of a redesigned card / cart bar.

**1. The portal cycle card's share row now prints the colleagues' QUANTITY.**
- Two lines: `3 kolegovia · 4 kg` (emphasised, `data-testid="share-row-count"`) over
  `objednali cez váš odkaz`. This **retires the `.tabbadge` chip** and the single
  "N | kolegovia cez váš odkaz" line. The count alone answered the host's real question —
  how much coffee am I collecting for other people — only if every colleague buys one bag.
- ⚠ **No new request and no new endpoint.** `GET /api/guest-links/cycle/:id` already
  carries `guest_orders[].items` (`helpers/guest-orders.js attachItems`), so
  `summariseSubOrders()` sums grams client-side off the payload the concurrency-capped
  batch already fetches. `guestCounts` became **`guestSummaries`** = `{count, grams, units}`
  keyed by cycle id; every RD-FL-5 rule about it still holds (sequence guard, merge map
  that does not heal on error, non-blocking, context-only).
- ⚠ **`count` comes from the server's `totals`, the quantity is derived** — so the number
  beside the kilos can never disagree with the host's "Objednávky kolegov" tab. Cancelled
  sub-orders count for **neither** figure (the same status predicate every backend guest
  aggregate applies); pinned with a cancelled 1 kg bag that must not reach the screen.
- ⚠ **Trailing zeros are STRIPPED here ("4 kg", not "4.00 kg")** — the RD-FO-2
  `Math.round(g/10)/100` rule, deliberately NOT `formatKilos`, which the "Objednané ·"
  badge in the same card still uses. The two are fed different units (kg from the API vs
  grams summed off items) and the design canon for this row prints "4 kg".
- ⚠ **An empty quantity drops the "· " separator rather than printing "0 kg"**, which
  next to a live colleague count reads as a failure. Bakery cycles print `ks` (units), the
  same split `orderQuantityLabel` uses one row above.
- `lib/plural.js` is the **one home** for `colleaguesLabel()` (1 kolega / 2-4 kolegovia /
  5+ kolegov). It was private to `GuestSubOrders.vue`; two screens now print it from two
  different sources, and two copies of a three-branch declension is how one of them ends
  up reading "3 kolegov".

**2. `FriendOrder.vue`'s cart lines are grouped by purpose and column-aligned.**
- ⚠ This **REVERSES 04 resolved conflict #10** (the prototype's flat list). What comes back
  is the grouping and one neutral `.badge.acc-o` header per purpose — the per-purpose page
  tints that the deleted `groupedCartItems` also carried do **not**.
- ⚠ **Group order is `availablePurposes`, not the cart's key order**, so the strip above and
  the cart below agree; a purpose no longer in the product list is **appended, never
  dropped**, or a line could go invisible while still being billed.
- Four columns: `.ln-name` (flex, ellipsis) · `.ln-qty` (26px, `1×`) · `.ln-size` (52px) ·
  `.ln-amt` (58px min, right). The fee line carries no header and no qty/size but keeps
  `.ln-amt`, so its figure stays in the same column. Verified by geometry, not text: every
  row 22px tall, all four columns sharing one x per column.
- ⚠ **`€` on the LINES only.** `.sum` ("Celkom: 28.50 EUR"), the success modal, the QR and
  `PaymentModal` all still say `EUR` — that is the figure the friend actually pays.
- ⚠ **The name is shortened by CSS, never in the data.** `overflow:hidden` +
  `text-overflow:ellipsis` + `white-space:nowrap` on a `min-width:0` flex item, with the
  full string kept in the DOM and in `title`. This is also what makes it safe against the
  RD-FO-2 hazard one screen up (a space-free 44-char name scrolled the document 263px
  sideways): unlike `overflow-wrap`, a clipped box cannot paint outside its row. Pinned at
  320px with an unbreakable name — clipped, one row, zero document overflow.
- Styles are a `<style scoped>` block in the view, **not** an addition to
  `friends-theme.css` (the `CatScrollArrow.vue` precedent — the theme is a byte-for-byte
  canon port with a numbered adaptation list this belongs to none of). Nothing below
  re-declares a property the theme's `(0,3,0)` `.cartbar .lines .ln` rule sets.
- ⚠ **`GuestOrder.vue` / `GuestOrderStatus.vue` / `GuestProductGrid.vue` still render the
  OLD flat cart footer with `EUR`** — the guest surface belongs to RD-GX-1 and was out of
  scope here. The two skins are now visibly different; do not treat the guest one as the
  reference when RD-GX-1 lands.

Specs edited: `order-cartbar.spec.js` (grouped assertions + a new long-name test) and
`portal-share-row.spec.js` (its `linkPayload` fixture now carries real `items`, plus a
cancelled row, and the `.tabbadge` locators became `share-row-count`). Verified locally:
those two files plus `order-shell`, `order-locked`, `order-product-card`,
`colleagues-panel`, `portal-fidelity`, `portal-cycles`, `mobile-no-h-overflow`,
`guest-host-view`, `guest-link`, `portal-session-boundary` — **157 passed**. The full suite
was not run for this change.

**Follow-up the same day — the cart fold's label absorbed the item count.**
`Položiek: N` is gone from the `.cartbar` meta row; the `<details>` summary now reads
**"Zobraziť položky v košíku (11 položiek)"** via `itemsLabel()` in `lib/plural.js`
(1 položka / 2-4 položky / 5+ položiek; 0 takes the genitive plural, "0 položiek", which
is correct Slovak and not a fallback).
- ⚠ The deadline row is now dropped **wholesale** when the cycle carries no
  `expected_date` — with the count gone it would otherwise be an empty flex row in the
  bar's vertical rhythm, and freeing that line is the whole point.
- The line it frees is spent on the control: the summary is `display:flex` (**full bar
  width**, so a thumb landing right of the label still opens the fold — the vertical
  padding alone would leave a narrow column), `min-height:40px`, 14.5px, `--ink` instead
  of the theme's `--ink-dim`, which at 13px dimmed read as a caption rather than a
  control. Measured 358×40 at 390px.
- Specificity here is **not** a cascade-order bet like `.cartbar` itself: the theme's
  `.cartbar details summary` is (0,3,0) and `<style scoped>` appends a data attribute to
  the last compound ⇒ (0,4,0), so it wins regardless of file order.
- ⚠ `getByText('Položiek: N')` was asserted in **four** friend-side spec files
  (`order-cartbar`, `order-locked`, `order-modals`, `order-product-card`) — all now read
  the summary's text instead, plus one assertion that `Položiek` has really left the meta
  row. The guest views keep their own `Položiek: N` footer (RD-GX-1's scope), so
  `guest-order-shell` / `guest-status-shell` are untouched and still pass.
Verified locally: those four files, **67 passed**, plus a 320px no-overflow check.

**Follow-up — decluttering the guest confirmation screen (`GuestOrder.vue`, 2026-08-12).**
Five product-decided cuts to `/g/:token`'s post-submit screen, frontend only.
- The rotated green `.badge.ok-solid` **"✔ Odoslané" is REMOVED.** It was the third
  statement of one fact: badge + the 34px "Objednávka je odoslaná" headline + the appbar
  subtitle "Objednávka odoslaná".
- ⚠ **`line-height:1.3` on the `h1.h-screen`, overriding the theme's
  `.h-screen{line-height:.95}` — not cosmetic.** This headline WRAPS on a phone and `.hl`
  paints a filled block plus a `0 4px 0` underline shadow, so at .95 the second line's
  block overlapped the descenders of "OBJEDNÁVKA JE" and clipped the underline. .95 is
  right for the single-line headlines the canon uses it for. Inline, because A9/A10 cannot
  beat a class rule that declares its own value. The `.sub` beneath went 10px → **20px**
  (the underline shadow eats 4px of any margin below the highlight).
- The copy-row label is now **"Na tomto odkaze uvidíte stav objednávky - uložte si ho!"**
  (verbatim from the product owner, plain hyphen) and the `.field-help` paragraph under it
  is **gone**. ⚠ Its second sentence was the ONLY on-screen explanation of the
  localStorage fallback (`api.js` writes `gorifi_guest_orders`, keyed by link token); the
  behaviour is unchanged but now undocumented **deliberately** — do not "restore" it.
  ⚠ `.field-lbl` is `text-transform:uppercase`, so this sentence renders as caps and wraps
  to two lines at 390px. Accepted.
- ⚠ Both removals are asserted in `guest-payment-modal.spec.js` as **absences**
  (`.badge.ok-solid` count 0, `.field-help` count 0, no `/Odoslané/` in the column) —
  new copy alone would let a revert pass. The headline's leading is asserted as
  **geometry** (the `.hl` box starting more than one font-size below the h1's top), which
  is the only way to see the overlap a text assertion cannot.
Verified locally: `guest-payment-modal` (11), `guest-order` + `guest-order-shell` +
`guest-invite-dead` (52) — **63 passed**, plus phone/desktop screenshots.

### `CartLineList.vue` — one home for every list of ordered coffee (2026-08-12)

Product decision: the colleagues' sub-orders on the host's screen and the guest's own
order summary must read exactly like the friend cart bar — grouped by purpose, one-row
names, quantity/size in aligned columns, `€` on every amount. Frontend only.

⚠ **`components/CartLineList.vue` is now the ONLY place this list is rendered**, on FIVE
surfaces: `FriendOrder.vue`'s cart bar, `GuestOrder.vue`'s cart bar AND its confirmation
sum card, `GuestOrderStatus.vue`'s item list, and `GuestSubOrders.vue`'s sub-order cards.
Before it they were five hand-rolled copies in **four different formats** — the host read
two of them on one screen. Extend the component; never fork it. Call sites map their own
row shape into `{ key, name, purpose, size, quantity, amount }` and own nothing else.

- ⚠ **Every value the component's CSS shares with the theme's `.cartbar .lines .ln`
  (0,3,0) is byte-identical, deliberately** — inside a cart bar the theme wins, outside it
  the component's rules are the only ones there are, and matching numbers is what makes
  the two cases indistinguishable. It deliberately does NOT declare `max-height` /
  `overflow-y` (the 170px scroll cap is the cart bar's alone; a list in a card must show
  every line) or `margin-top` (call sites pass their own, which falls through to the root).
- ⚠ **`line-height:normal` inside the component is load-bearing**: the `.ln-*` column
  classes are NOT in the theme's A10 list, so without it every line inherits preflight's
  1.5. The three call sites that used to carry their own `line-height:normal` inline (with
  measured +4.25px/+8.5px notes) delegate to it now.
- ⚠ **It renders `ul`/`li`**, so `li` counts in specs must be `li.ln` — the purpose header
  is an `li` too. Two shipped assertions counted bare `li` and read 3 for a 2-item order.
- ⚠ **The purpose header is a `.badge`, which collided with the sub-order card's "exactly
  ONE badge" rule** (§UC-KG-001/003, the paid/cancelled status flag). Fixed by scoping
  that assertion to a new `data-testid="sub-order-badges"` row — plus a second assertion
  that every *other* badge in the card is a group header, so the original rule is still
  enforced rather than merely relocated.
- ⚠ **`€` on item lines REVERSES 05 §UC-KG-003 item 2** ("EUR on totals only, item lines
  carry a bare mono column", from the prototype). A bare "15.20" was ambiguous precisely
  where it mattered: a colleague's lines sit in a card directly above a cart-bar total
  that belongs to a **different** order. Totals still say `EUR`.
- ⚠ **The amount uses an ORDINARY space before `€`.** A U+00A0 slipped in first and cost
  half an hour: Playwright normalises NBSP away for a STRING `toHaveText` but **not** for a
  REGEX one, so `toHaveText('9.04 €')` passed while `toHaveText(/^\d+\.\d{2} €$/)` failed
  on the same node. `.ln-amt` is `nowrap`, so NBSP bought nothing anyway.
- `GuestSubOrders`' precomposed `"2× Name — 250g"` string is gone. It existed because a
  sibling `<span>` could lose its separator to Vue's `condense` whitespace mode — a hazard
  that cannot arise once the size is a COLUMN. Its `variantText` now comes from
  `lib/guest-cart.js`, so `'unit'` reads "ks" instead of printing nothing.
- `lib/purposes.js` `purposeOrder(products)` gives the two guest screens the group order
  (`GuestProductGrid` computes it internally and never exposes it; `FriendOrder` passes its
  own `availablePurposes`). ⚠ **Deliberately NOT wired into either of those two copies**:
  they feed a `groupedProducts[activeTab]` LOOKUP whose keys fall back to `'Ostatne'`
  (no diacritic) while everything else in the app uses `'Ostatné'` — normalising there
  would make a purposeless product's tab select an empty group, i.e. silently hide
  product. Here the fallback only affects group ORDER, and unranked purposes are appended.
- `lib/guest-cart.js` `cartLines()` now carries `purpose` (presentation only — nothing
  prices or weighs by it).
- **NOT changed, and visible:** `GuestOrder.vue`'s cart bar still shows `Položiek: N` in
  its meta row with the small `<summary>`; the friend bar merged that into
  "Zobraziť položky v košíku (N položiek)" with a 40px hit target earlier the same day.
  The two bars now differ in that one respect.
Verified locally: `order-cartbar`, `colleagues-panel`, `guest-host-view`,
`guest-status-shell`, `guest-order-shell`, `guest-payment-modal`, `guest-status`,
`guest-order` — **~170 passed** — plus screenshots of all three restyled surfaces and
320px no-overflow checks.

**Follow-up — the guest cart bar matches the friend one (2026-08-12).**
`GuestOrder.vue`'s footer took the same change the friend bar took earlier the same day:
`Položiek: N` left the meta row for the `<details>` label
("Zobraziť položky v košíku (2 položky)", `itemsLabel`), the deadline row is dropped
wholesale when the cycle has no `expected_date`, and the summary is the same enlarged
control (`display:flex` full width, `min-height:40px`, 14.5px, `--ink`) via the same
(0,4,0) scoped override of `.cartbar details summary`. Measured 358×40 at 390px.
- ⚠ **The two bars still differ in ONE state, and it is by design.** The guest fold is
  `v-if="cartItems.length > 0"` (shipped rule, pinned), so an **empty guest cart shows no
  count at all** while the friend bar reads "(0 položiek)". Nothing is lost — the 0.00
  total and the disabled "Objednať" say it — and `guest-order-shell.spec.js` now asserts
  that absence rather than the old "Položiek: 0".
- ⚠ **`GuestOrderStatus.vue`'s EDIT bar keeps `Položiek: N`** and was deliberately not
  touched: it has no `<details>` fold to merge the count into. Its spec is unchanged.
Verified locally: `guest-order-shell`, `guest-status-shell`, `guest-order`,
`guest-payment-modal` — **73 passed**, plus screenshots at 390px/320px.

### The new domain, the tab brand, and the invite screen's restyle (2026-08-12)

**podpultovka.biz** serves the app alongside `gorifi.skolar.sk`. Wiring is in three
places and nowhere else: `server_name` in **both** `deploy/nginx-*.conf`
(`podpultovka.biz www.podpultovka.biz` on prod, `dev.podpultovka.biz` on staging),
and the `CORS_ORIGIN` default in `backend/src/index.js` — without the origin in that
allowlist every XHR from the new host 500s and the SPA renders a blank body (the same
failure mode the e2e harness note describes). TLS/DNS live outside the repo: the two
existing **Nginx Proxy Manager** proxy hosts each gained the new names plus a reissued
Let's Encrypt cert; `docs/deploy/nginx-proxy-manager.md` §5 is the runbook. ⚠ The
domain was first implemented as `.sk` and corrected to `.biz` — if a stray `.sk`
reference ever surfaces, it is that mistake, not a second domain.

**The tab is Podpultovka.** `index.html`'s `<title>` was still the Vite scaffold's
literal `frontend`; it is now `Podpultovka`, the favicon is `/coffee-cup.png` (was
`vite.svg`), and `FriendPortal.vue` sets `Podpultovka - Objednávky`.
- ⚠ **`GuestShareDialog`'s share-sheet title moves WITH `document.title`.** The
  UC-KG-006 freeze that kept it on "Objednávka Gorifi" was about *consistency* — the
  app must not introduce itself under one name in a message linking to a tab called
  another — so renaming the tab obliges renaming the payload. Both are pinned
  (`public-flow`/`modern-login` for the title, `share-dialog` for the payload).
- Admin screens still say "Gorifi Admin" — internal tool, still on the old skin.

**`InviteRegister.vue` (`/invite/:code`) is on the Podpultovka skin** — it was the
last friend-facing screen on shadcn `Card`/`Input`/`Label`/`Button`/`Alert`, and it is
the FIRST screen a new member ever sees. It has **no design-canon screen**
(`03-friend-login-portal.md:587` puts the route out of scope), so it is composed from
the two shipped public-screen precedents: the modern login's 480px branded column +
`.card` form, and the guest **g-dead** card for the terminal states.
- ⚠ **The Goriffee logo is GONE and `frontend/public/goriffee-logo.svg` is deleted**
  (product decision). This route was its only consumer app-wide. That also retires
  RD-DS-6's "colour treatment differs — design sign-off pending" residual: the asset
  needing sign-off no longer renders anywhere.
- ⚠ **`self-hosted-fonts.spec.js` had TWO tests pinning that logo** (an `h-12` decode
  check and an img-src-under-CSP check). Both were **retargeted, not deleted** — the
  value was never "a logo exists" but "an image this route renders actually decodes"
  (a CSP-blocked or 404 image is `complete` with `naturalWidth === 0`, which
  `toBeVisible()` misses). They now assert the chrome that replaced it plus a decode
  sweep over *every* image the route renders, and the CSP test additionally asserts
  `.app`'s themed background so a page that failed to mount cannot pass by rendering
  nothing. The route sweep at §1b is unchanged and still the generalizing assertion.
- Copy is **vy-form**: `Pozvánka od X` replaces "Pozval/a ťa" (a noun phrase needs no
  gender at all), "Tvoje meno" → labels only, "Popros priateľa" → "Požiadajte…".
- **No placeholders** on the three fields (the 2026-08-10 login decision, 81abbf9),
  and the email's "(pre zásielkovňu, voliteľné)" moved out of the label into
  `.field-help` — `.field-lbl` is `text-transform:uppercase`, so a parenthetical
  there renders as shouting.
- ⚠ **The success state is CENTRED (`flex-1`), not a top-aligned column.** Built
  top-aligned first and it was a headline stranded above ~1000px of empty halftone:
  g-confirm gets away with that composition only because a sum card, a line list and
  a payment button follow it. Terminal states with two lines of content use the
  g-dead centring. It carries no "Odoslané" badge, per the g-confirm declutter rule.
- ⚠ Both wrapping headlines carry inline **`line-height:1.3`** over
  `.h-screen{line-height:.95}` — the g-confirm lesson (`.hl`'s filled block plus its
  `0 4px 0` underline shadow overlap the line above at .95). Mutation-verified: the
  new spec's geometry test reddens when the override is removed, which no text
  assertion can do.
- ⚠ **`innerText` applies `text-transform`.** Three classes here are uppercase
  (`.h-screen`, `.badge`, `.field-lbl`), so a copy assertion read from `innerText`
  must be case-insensitive — `toContain('Pozvánka od')` fails against
  "POZVÁNKA OD …" while the copy is perfectly correct. `toHaveText` reads
  `textContent` and is NOT transformed, which is why element-level assertions can
  stay exact.
- New spec: `e2e/tests/invite-register-shell.spec.js` (9 tests). It provisions a real
  invite code via `GET /invitations/my-code` on a friend Bearer session — `friends.js`
  strips `invite_code` from every friend response, so that is the only route to one.
  ⚠ Running it repeatedly exhausts `abuseLimiter` (invite-code lookup, 40/window) and
  the *page* then renders its invalid state; raise `RATE_LIMIT_ABUSE_MAX` for repeated
  local runs, exactly as `RATE_LIMIT_AUTH_MAX` is raised for admin re-login.

**⚠ Running the suite locally: raise ALL FOUR rate-limit buckets, not just `AUTH`.**
The documented recipe raises nothing, and the failures it produces read exactly like
real regressions in code you just touched:
- `authLimiter` (20) — exhausted by admin re-login across several spec files;
  `share-dialog.spec.js`'s `refreshAdminToken` fails with `429 !== 200`.
- `abuseLimiter` (40) — the invite-code lookup. Exhausting it makes
  **`/invite/:code` render its INVALID state**, so an invite spec fails on copy that
  is perfectly correct, and a manual check of the page looks like a broken route.
- `guestReadLimiter` / `guestWriteLimiter` (300/60) — `guest-status.spec.js` alone
  runs enough guest writes that batching it with other guest files 429s ~15 tests.
- ⚠⚠ **KILL THE SERVER BY THE PID THAT OWNS THE PORT, and assert the port is free before
  restarting.** `pgrep -f node | head -1`-style killing takes a *stale* process while the
  one holding `:3997` survives; the replacement then fails to bind **silently**, and the
  suite goes on measuring **the code you just deleted**. This produced a false green
  during FUP-T12 — the fix was in the tree and the failures were still real.
  Use `kill $(ss -lptnH 'sport = :3997' | grep -oP 'pid=\K[0-9]+')`, then check
  `ss -ltn | grep -c ':3997'` is `0`, then start. Same class as the "confirm the port is
  free first" note above, but this is the failure it actually causes.
- ⚠ **`bcrypt-nonstring-shape.spec.js` CANNOT pass on the default `RATE_LIMIT_AUTH_MAX=20`** —
  it is the heaviest single consumer of `authLimiter` (~65 bucketed requests; each of
  its 12 change-password tests adds a login to prove the password is untouched). For
  this file the "raise all the buckets" recipe is a **hard requirement, not a
  convenience**, and the failure looks like a broken auth fix rather than a budget.
- `magicLinkLimiter` (10) — ⚠ **the newest, and the easiest to miss.**
  `magic-link.spec.js`'s shared-server describe issues **20** requests to
  `/api/magic-link/request`, and the limiter counts the 400s too, so from request
  11 onward you get `429` and ~10 red tests that read exactly like a real
  regression in the code you just touched.
Every one of these passes when its file is run ALONE, which is the tell. Start the
gate with `RATE_LIMIT_AUTH_MAX / RATE_LIMIT_ABUSE_MAX / RATE_LIMIT_GUEST_READ_MAX /
RATE_LIMIT_GUEST_WRITE_MAX / RATE_LIMIT_MAGIC_MAX` raised — `rate-limit.spec.js`,
`rate-limit-isolation.spec.js` and `magic-link-rate-limit.spec.js` then self-skip
(they need LOW limits), which is exactly the documented "4 skipped".
⚠ Also: pipe the run to a FILE, never `| tail -N`. A `tail -25` keeps the summary
(which is honest about pass/fail) but discards every `✘` line above it, so a run
with failures is indistinguishable from a clean one at a glance.

**⚠ `order-fidelity.spec.js`'s cartbar-`<details>` test was STALE IN PRODUCTION.**
Commit `113d261` (the cart fold absorbing the item count) deliberately overrode the
theme's `inline-flex` summary with `display:flex; min-height:40px`; that spec still
asserted the canon `inline-flex` and a 24px `<details>`, and the change shipped to
prod with the failure unnoticed because — as its own CLAUDE.md note says — the full
suite was not run for it. Retargeted, not deleted: the `line-height:normal` counter
it exists for is asserted first and unchanged, the geometry now pins the **40px hit
target** the decision bought (mutation-verified: dropping the override reddens it),
and `CANON.cartbarDetails` is gone in favour of a separate `SHIPPED` constant so a
prototype number and a deliberate divergence can never again be confused.
⚠ One structural consequence is now pinned too: a **block-level** summary's 8px top
margin **collapses** with the `<details>`'s own, where the canon's inline-level one
could not — so `detailsH === summaryH` today, and giving `.cartbar details` any
padding or border would silently add 8px back to the bar's height.

### ⚠ A12 — iOS zoomed the whole app in after login (2026-08-12, reported from prod)

Mobile Safari zooms the viewport IN when a text control with a computed
`font-size` **under 16px** is focused, and **does not zoom back out on blur** — so
one tap in the login field left every subsequent screen magnified for the rest of
the session (appbar chip and logout glyph clipped off the right edge, ticker cut
mid-word, cycle-list gear unreachable). The canon's `.inp` is **15px**, i.e. exactly
1px inside the trigger; `.inp.mono` is 13px.

- Fixed as **adaptation A12** in `friends-theme.css` (the 4th addition to the ported
  stylesheet), gated on **`@media (pointer: coarse)`** so desktop keeps the canon
  15px — the deviation is 1px, only on devices that have the bug. The gate is
  deliberately **not** `max-width`: an iPad in landscape is 1024px wide and zooms
  just the same.
- ⚠ **`.inp.mono` needs its own line inside the block.** It is (0,2,0) against
  `.inp`'s (0,1,0) — `:where()` contributes nothing — so it would keep 13px and keep
  zooming. It has no call site today, so that line ships as a no-op on purpose.
- ⚠ **The fix must NEVER be `maximum-scale=1` / `user-scalable=no`**, which is what
  most search results suggest: it removes pinch-zoom for everyone (WCAG 1.4.4) on the
  one screen where someone who cannot read a password most needs to magnify.
  `ios-input-zoom.spec.js` asserts the viewport meta contains neither.
- ⚠ **The zoom itself is NOT reproducible in this suite** — no engine here implements
  it and the gate runs Chromium. The spec measures the *condition* it keys on
  (computed font-size under `pointer: coarse`, which Chromium reports under touch
  emulation), plus the desktop counter-assertion that the 15px canon is untouched.
  A test watching `visualViewport.scale` would be silently vacuous.
- Remaining instances NOT fixed (admin-only, still old skin): the `text-sm` (14px)
  `<textarea>`s in `CycleDetail.vue` and `AdminBakeryProducts.vue`. Same bug class;
  out of scope for a friend-surface fix.

**⚠ THE LOCAL GATE IS UNRELIABLE ON A SMALL BOX, and it produces failures that read
exactly like regressions.** This host is 4 GB / 2 cores: Chromium dies with
**SIGSEGV** ("worker process exited unexpectedly", `Target crashed`, bash exit
**139** — which also silently truncates an `&&` chain, so a build never runs and the
test then measures a STALE `backend/public`), and the long walkthrough specs cross
their 30s timeout under memory pressure. A **different set** of tests fails on every
run — that non-determinism is the tell. Confirm any suspicious failure by running its
file ALONE, two or three times, before believing it.

### Noto Sans Condensed on the product description (design brief, 2026-08-13)

Two lines under the badges in a **coffee** product card change typeface — a
frontend-only, typography-only change (`git diff -- backend/` is empty):

| line | field | was | now |
|---|---|---|---|
| spec | `description1` | `.sub` Figtree 13px `--ink-dim` | **`.pspec`** Noto Sans Cond **700**, 14.5px, lh 1.25, ls .005em, `--ink` |
| notes | `description2` | `.mono` Courier Prime 12.5px `--ink-faint` | **`.pnotes`** Noto Sans Cond **500**, 14px, lh 1.3, ls .005em, `--ink-dim` |

- **`--font-cond`, `.pspec` and `.pnotes` are a CANON SYNC**, not a local invention:
  the design project's own `friends/theme.css` carries all three verbatim (fetched and
  compared, 2026-08-13). So they are ported into `friends-theme.css` like every other
  rule there — **not** as a numbered adaptation (the list still ends at A12).
- ⚠ **The canon also moved `--font-mono` to `'Space Mono','Courier Prime',monospace`.
  That is NOT ported.** Space Mono is not self-hosted here, so the stack would fall
  straight through to Courier Prime and render identically while implying a face we do
  not ship. The brief scopes the change to two lines and says mono stays.
- ⚠ **Only the COFFEE card changed.** The bakery card renders the same two columns
  with a *different mapping* — `description2` is a subtitle beside the name and
  `description1` a plain line — so it keeps `.sub`. Admin views (`CycleDetail.vue`)
  also render these fields and are deliberately untouched (old skin).
- The notes line **loses `.mono` on purpose** (it was the least readable text on the
  card). Mono stays on dates, prices, IBANs and references — pinned by asserting zero
  `.mono` inside a product card *and* that `.cartbar .deadline` still has it, so
  "mono left the card" cannot be satisfied by mono leaving the screen.

**Self-hosting (four new files, 99,192 B total).** OFL 1.1, and the prod CSP is
`font-src 'self' data:` — a CDN is blocked outright (RD-DS-6). Two cuts only, 500 and
700, no italic, no variable font.
- ⚠ **The latin-ext range here is NARROWER than Google's, and is declared exactly as
  shipped** — the one place this file departs from "preserve Google's ranges verbatim",
  because these files are subset from the handoff TTFs rather than being Google's own
  subset. Noto's Latin coverage is enormous: at Google's literal latin-ext range each
  weight came to **62.6 KB**, the excess being IPA Extensions (U+1D00-1DBF), Latin
  Extended Additional (U+1E00-1E9F, i.e. Vietnamese) and Extended-D (U+A720-A7FF).
  Restricting to U+0100-024F + punctuation/currency gives **28.1/28.7 KB**. Declaring
  the narrower range is the load-bearing half: a codepoint outside it now falls
  through to `'Noto Sans'` → sans-serif instead of fetching a file with no glyph.
- ⚠ **Slovak is in latin-ext, not latin** (carons are U+0100-017F). Shipping only
  `latin` breaks "mliečna čokoláda" **mid-word**. Both subsets ship for both cuts.
- **`self-hosted-fonts.spec.js`'s exact-set `FAMILIES` assertion is what forced the
  ledger update** — a face cannot arrive here without one. That is its whole purpose;
  `PROBES` gained both cuts, so latin AND latin-ext are load-verified per weight.
- **Preload: the 700 cut only, both subsets** (~50 KB), per the brief's no-FOUT
  criterion. Deliberately not all four — this is fetched on every route including the
  portal, where no card exists. Measured: **no "preloaded but not used" console
  warning** on either the order page or the portal. `crossorigin` is required even
  same-origin, or the browser fetches each file twice.

**Verified:** every briefed value asserted as *computed* style on both the friend and
the guest card (06 §UC-GX-002 pixel-identical), both acceptance strings on **one** line
at 390px — including `Honey Co-Fermented Pink Bourbon · SCA 86`, which the brief only
required to fit in two — and the diacritic check is mutation-proved: removing
`noto-sans-condensed-500-latin-ext.woff2` reddens exactly one test with
"500|latin-ext rendered in the FALLBACK face (brand 316.4 vs fallback 316.4)".
⚠ That check needed **two** `document.fonts.load` call sites wrapped in a catch —
unhandled, a missing subset surfaces as an opaque `page.evaluate: NetworkError` from
whichever helper ran first, masking the assertion that names the broken subset.
⚠ Two shipped assertions in `order-product-card.spec.js` pinned the OLD classes
(`.sub` / `.flex-1 .mono`) and were retargeted; the second (`unbreakable product
name`) merely needed `.mono` → `.pnotes` as its probe.
⚠ `gotoFriendCard` must enter via the portal card — a direct `page.goto('/cycle/:id')`
races FriendOrder's session restore and bounces to `/`, which cost a debugging round.

Batch after this work: **106 passed** across the ten affected files.

**Follow-up the same day — the portal cycle card's date and plan rows.** Product
decision: extend the condensed face to `FriendPortalSession.vue`'s cycle card — the
date under the cycle name is **Noto Sans Cond 700**, the `plan_note` block **500**.
Sizes, colours and spacing are unchanged (12px, `--ink-dim` / `--ink-faint`); only the
family and weight move, so no new woff2 and no new token.
- ⚠ **`.mono` is REMOVED from both rows, not overridden.** An inline `font-family`
  would have won while leaving the class in place, and several specs read `.mono` as
  "this is the mono face". Consequence to keep in mind: `.mono` is what used to carry
  A10's `line-height:normal` on the date row — `.sub` stays there and covers it, and
  the plan block's inline `line-height:1.7` was already the only declaration (20.4px,
  still pinned).
- ⚠ **FOUR shipped assertions located these rows by class** — `.mono.sub` and
  `.mono` **nth(1)** in `portal-cycles.spec.js`, `.mono.sub` / `.mono:not(.sub)` in
  `portal-fidelity.spec.js` (the line-height invariant AND the 320px hostile-text
  `overflow-wrap` test). All four now use `data-testid="cycle-date"` /
  `"cycle-plan"`, added for exactly this reason. The `nth(1)` one was the dangerous
  case: with the class gone it would not have errored but silently re-pointed at the
  archive rows' money column, which IS still `.mono`.
- The face is now asserted (family + weight), not just relocated — otherwise the
  change would have been a locator rename with nothing pinning it.
Verified: 64 passed across `portal-cycles`, `portal-fidelity`, `portal-share-row`,
`portal-appbar`, `mobile-no-h-overflow`; zero overflow at 390px and 320px.
- **Sizes bumped the same day** (both rows read too small in the condensed face):
  date **12 → 14px**, plan **12 → 13.5px**. The plan stays *below* the date so the
  hierarchy is carried by size AND weight, not weight alone. ⚠ Two assertions moved
  with it: `portal-cycles`' `font-size` on the plan, and — less obviously —
  `portal-fidelity`'s **computed line-height**, since the row's leading is the inline
  unitless `1.7` (12 × 1.7 = 20.4px → 13.5 × 1.7 = **22.95px**). A size change on any
  row whose leading is a multiplier moves that pin too.

### ⚠ `POST /api/invitations/:id/approve` — two invariants no test can hold (IA-T3, 2026-08-13)

The approve endpoint (module 07) converts a pending invitation into a friend **with a
working login** in ONE `better-sqlite3` transaction. Two of its properties are
**structural, not behavioural — a refactor can break either with the ENTIRE SUITE
GREEN**, so they live here:

1. **bcrypt `hashPassword()`, both collision-retry loops and `getPlaceholderCycleId()`
   run OUTSIDE the transaction.** better-sqlite3 transactions are synchronous and
   bcrypt is ~62 ms of CPU (measured over 9 approvals: 61.8–64.7 ms hashing, then a
   **0.13–0.21 ms** transaction — the tx holds the write lock ~400× shorter than the
   hashing it follows). Moving `hashPassword` into the `db.transaction` callback is
   undetectable by any test in this repo.
2. **Exactly TWO writes inside the transaction** — INSERT friend, UPDATE invitation.
   Nothing else may join them.

Same class as the standing `instances: 1` concurrency caveat. The comment at
`invitations.js:326` is the only in-code guard.

Also load-bearing, and each proved rather than assumed:
- ⚠ **The `SQLITE_CONSTRAINT` → 409 translation is real, not decorative.** Deleting
  the app-level `isUsernameTaken` check leaves the suite **15/15 green** — the UNIQUE
  index catches it and the catch produces the identical `409 field:'username'`. The
  regex matches better-sqlite3's actual `UNIQUE constraint failed: friends.username`;
  a `friends.uid` collision correctly falls through to 500.
- ⚠ **THREE deliberate non-writes**, each a rule with a reason: **no
  `friend_subscriptions` row** (no rows = sees everything, so an invited friend starts
  UNFILTERED — deliberately diverging from onboarding's bakery auto-subscribe), **no
  session mint** (the friend logs in themselves), **no `transactions` row** (creation
  is not a financial event — the GSO-T6 lesson). All three are asserted as zero rows
  and mutation-verified, with a non-vacuity test proving onboarding DOES create
  `['bakery']` in the same run.
- ⚠ **The temp password is UPPERCASE-ONLY** (`randomCode(12)` over the unambiguous
  alphabet) and `friends.js:35` lowercases **only the username, never the password** —
  which is exactly why it authenticates unmangled. Do not "normalise" the password.
- The plaintext exists in **exactly one place repo-wide** outside `schema.js`: the 201
  body. Never persisted, never logged (error paths log `e.message` only). The 201
  friend object is hand-picked and pinned by an exact-keys assertion PLUS a raw-text
  regex for `invite_code|access_token|password_hash`, so a later `SELECT *` fails loudly.
- **`requireAdmin` is PER-ROUTE.** `routes/invitations.js` is a MIXED mount — public
  `/code/:code` + `/register`, admin for the rest. Wrapping the mount breaks the public
  registration flow.

### Module 07 — invitation → friend WITH a login (IA-T1..T5, 2026-08-13)

The reported bug: the "Nový priateľ" modal's `Prihlasovacie meno *` field wrote
`friends.name` and `POST /api/friends` set no credentials, so approving an invitation
produced a friend who **could not log in** (the "Prihlásenie" column showed `-`). Spec:
`docs/specification/07-invitation-approval.md`; backlog rows in `PROGRESS.md` §5.

The shipped flow: applicant optionally requests a username on `/invite/:code` →
admin clicks "Vytvoriť" → **approval dialog** (username prefilled from the request or a
slugify of the name, editable note) → `POST /api/invitations/:id/approve` creates the
friend with a generated temp password and `must_change_password = 1` → the dialog shows
the credentials with a copy button → the friend logs in and is forced to set their own
password. **No email** — the copy button is the whole delivery mechanism (SMTP is a
recorded phase-2 follow-up).

⚠ **Two UI hazards this module discovered, both fixed, both worth not reintroducing:**
- **`@keyup.enter` on an input inside a dialog opened by an Enter keypress fires on
  open.** The browser's native "Enter activates a focused button" delivers `keydown` to
  the BUTTON, Radix synchronously focuses the dialog's first input, and the **keyup half
  of that same physical press** lands on the input. On the approval dialog this silently
  approved before the admin saw anything — minting an account and a one-time password
  nobody read. Use **`@keydown.enter`** (structurally cannot see a keyup targeting
  another element) plus an **`event.repeat` guard** (auto-repeat delivers genuine
  keydowns to the newly focused input ~500 ms later).
- **A one-time secret on screen needs a route-leave guard.** Browser Back unmounted the
  dialog and destroyed an uncopied temp password with no warning. `onBeforeRouteLeave` +
  `confirm()` while `approveResult` is set. Reload is deliberately unguarded.

⚠ **e2e harness traps recorded here because they cost real time:**
- **There is exactly ONE admin token app-wide** (`admin.js` does `INSERT OR REPLACE …
  'admin_token'`), so a UI admin login **invalidates** a token minted earlier by an API
  `beforeAll`. Any spec mixing `loginAsAdminUI(page)` with API `admin()` calls must adopt
  the browser's token (`localStorage.getItem('adminToken')`).
- **A back-navigation test cannot use `page.goto` to reach the page** — backing out of a
  document-loaded entry is a real document navigation that a vue-router guard never
  sees, so the test passes for the wrong reason. Navigate in-SPA instead.
