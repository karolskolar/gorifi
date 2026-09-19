# Early features (2026-01 → 2026-07): ordering flow, auto-save, cycle progress, pickup locations, analytics, live dashboard, bakery variants, Packeta, invitations alert

> Moved verbatim out of `CLAUDE.md` on 2026-09-03 (it had grown to 153 KB). These are the full per-task learnings; the load-bearing rules are summarised in `CLAUDE.md` → Hard rules. **Append new learnings for this area HERE, and add only the one-line rule to `CLAUDE.md`.**

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
- ~~Modal field mapping in AdminFriends: friendName=Prihlasovacie meno (login)~~ **SUPERSEDED — and this bullet was the bug.** ⚠ `friendName` writes **`friends.name`, a DISPLAY label that never was a login**; the field is now labelled **`Meno a priezvisko *`** (FC-T2, module 11 — was `Meno *` from IA-T5; `admin-friends-labels.spec.js`'s exact-label pins were retargeted with it, case (a)) and `POST /api/friends` still sets no credentials. A friend gets a real login ONLY via `POST /api/invitations/:id/approve` (module 07) or the per-friend "Nastaviť username" / "Resetovať heslo" actions. The rest of the mapping still holds: friendDisplayName=Poznámka (internal admin note), friendPhone=**Mobil** (FC-T2 relabel), friendEmail=Email; the `invitations` table has name/phone/email/username (no user note field). Module 11 (FC-T1/T2) added: server bounds 120/32/160/200 mirrored as `maxlength`, `Kontakt` (amber `Bez e-mailu`) + `Google` (`googleLinked`) columns, the truthful three-state `Prihlásenie` badge (`Neúplné` when password-no-username) + `dočasné heslo` marker, and save errors render in an in-dialog `modalError` Alert (the page Alert is hidden behind the radix overlay — do not "fix" it back). ⚠ **THE GUARD IS NOW TWO FILES:** `grep -i prihlasovac frontend/src/views/AdminFriends.vue frontend/src/views/FriendPortalSession.vue` must stay EMPTY (07 §UC-IA-007) — the one legitimate `Prihlásen*` string in the admin view is the `Prihlásenie` column header, which reports real credential state (`hasCredentials`) and makes no claim about the name field.

⚠⚠ **WHY THE ONE-FILE FORM FAILED — FUP-T20, found by the product owner on staging.** The friend profile modal (`FriendPortalSession.vue`) carried the **identical** `Prihlasovacie meno *` label on the **identical** column: it binds `profileName` → writes `friends.name`, with its own help line one row below saying the opposite ("Toto meno vidí správca a kolegovia."). The real login is the read-only `Užívateľské meno` box above it. So a friend edited "their login name", their login did not change and their display name silently did — module 11 fixed exactly this in the admin view while the friend view shipped it to production, **because the guard named one file**. Any future guard stated as a grep must enumerate **every view that edits the column**, not the view where the bug was found. FUP-T20's fix: label **`Meno a priezvisko *`**, help text **"Celé meno. Uvádza sa na zásielke pri doručení Packetou a vidí ho správca aj kolegovia."** (the PO mapping: `friends.name` is the **Packeta delivery name**, which is why it is required), the read-only **`Jedinečné ID` box REMOVED** (internal identifier, nothing to act on — the `friendUid` prop and `currentFriendUid` computed went with it; the uid still rides in `gorifi_friend_auth` and on the admin's ID column), and `username` stays **read-only** (PO decision — the admin renames, Google auth likely removes the need). Machine-checked by a rendered-copy sweep (text + `placeholder`/`title`/`aria-label`/`alt`, the `admin-friends-labels.spec.js` idiom) in `portal-profile-modal.spec.js`, which owns that modal. ⚠ The substring is **legitimate** in `AdminInvitations.vue` and `InviteRegister.vue`, where it labels a real `friends.username` field — the rule is "no view that edits `friends.name` may call it a login", not "the word is banned".

⚠ **`friends.display_name` (the admin-only Poznámka) was being SENT to the friend's browser, and the fix is route-scoped on purpose (FUP-T20).** `GET /friends/:id/profile` does `SELECT *` and `sanitizeFriend` strips credentials only, so the note travelled to every friend portal; nothing rendered it, but it was one DevTools tab from visible. It is `delete`d **in that route**, never in `sanitizeFriend` — that function has **7 call sites, several admin**, and `AdminFriends.vue` reads `display_name` for its Poznámka column off exactly those, so a central strip would silence the leak and blank the admin's note. Rule: `sanitizeFriend` stays the one home for **credential** stripping (11 §UC-FC-005); **audience-scoped** fields belong to their route. Pinned by a raw-body `not.toMatch(/display_name/)` on the friend route **plus an admin counter-assertion** that `GET /api/friends` and `GET /api/friends/:id/detail` still carry the note value — a removal-only test passes while breaking the admin.


