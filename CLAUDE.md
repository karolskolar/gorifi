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
- `abuseLimiter` is ONE 40/window/IP bucket shared by invite-code lookup, onboarding submit and every guest page load — an office behind one NAT can exhaust it. Fix would be a separate limiter instance, not a higher global max.
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
