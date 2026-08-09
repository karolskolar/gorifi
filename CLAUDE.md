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
  - Submitted orders: Changes are NOT auto-saved; user must click "Aktualizovať objednávku"
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
- Invitation → new friend flow: "Vytvoriť" in AdminInvitations passes `create=1&name=&phone=&email=` query params to `/admin/friends`; AdminFriends `onMounted` reads them to prefill the modal (previously only `name` was passed, phone/email were blanked)
- Modal field mapping in AdminFriends: friendName=Prihlasovacie meno (login), friendDisplayName=Poznámka (internal admin note), friendPhone=Telefón, friendEmail=Email. Invitations table has only name/phone/email (no user note field)

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

**Rate-limit buckets — `middleware/rate-limit.js` exports FOUR, each a SEPARATE bucket. Do not collapse them.**
- `authLimiter` (`RATE_LIMIT_AUTH_MAX`, 20) — admin login, friend auth.
- `abuseLimiter` (`RATE_LIMIT_ABUSE_MAX`, 40) — invite-code lookup, onboarding submit.
- `guestReadLimiter` (`RATE_LIMIT_GUEST_READ_MAX`, 300) — guest page loads.
- `guestWriteLimiter` (`RATE_LIMIT_GUEST_WRITE_MAX`, 60) — guest submits, edits, invite requests.

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
- `FriendOrder.vue` / `GuestOrder.vue` / `GuestOrderStatus.vue` hand-rolled `fixed bottom-0 z-50` cart bars are all *nested* inside their page-column div, so they survive as-is; converting them to the theme's `.cartbar` is safe even at root level. Do not "tidy" them up to root level while they are still on Tailwind utilities.

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
- ⚠ **`successMessage` ("Košík bol uložený") is reachable, unreadable, and once actively wrong.**
  `saveCart(false)` is its only writer and `doSubmitOrder()` its only non-silent caller (auto-save and
  cancel pass `silent: true` on purpose), so it has **no user-initiated trigger**. After a successful
  submit it renders behind the success modal, which navigates away on close. After a **failed** submit
  it is plainly visible **next to the error banner** — "saved" and "failed" side by side for 3 s
  (reproduced by stubbing the submit endpoint to 500). Pre-existing, not introduced by this row.
  Recommendation for **RD-FO-3** (which owns the cartbar messaging): retire the banner, or clear
  `successMessage` at the top of `doSubmitOrder()`'s try. Do **not** give it a trigger.
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
