# 16 — Distribution pipeline: delivery types, hand-over stage, distribution board

> Scope: The admin's post-lock pipeline for getting bags out of the door, in three layers.
> (a) **Vocabulary** — `backend/src/helpers/delivery.js`, a READ-ONLY derivation that maps
> every party (friend order, host-without-own-order, guest sub-order) to a delivery type
> (`packeta` / `pickup` / `in_person` / `via_host`) and a planning target; `helpers/pickup.js`
> stays the only writer of the pickup/Packeta columns. (b) **Stage 3 „Odovzdané“** — a new
> admin-only, ledger-neutral `handed_over_at` on `orders` AND `guest_orders` (CREATE + ALTER),
> settable only once the bag is packed (409 `not_packed`), reversible, inherited by every live
> guest sub-order when their host's bag is handed over; one PATCH per row kind plus one bulk
> endpoint; the existing `GET /api/cycles/:id/distribution` grows delivery/stage/plan fields
> (guests merged in JS, never a second `LEFT JOIN`). (c) **The distribution board** —
> `Distribution.vue` redesigned after the `ADist` prototype: plan cards per target with
> zabalené/odovzdané progress, group-by doručenie / stav / priateľ, stage filter, per-group
> „Odovzdať zabalené (n)“ with confirm, per-bag Zabalené → Odovzdané checkboxes, guest rows
> nested under their host, Packeta rows showing address + phone, the existing item checklist
> and print sheet preserved; the admin cycle header gains the plan line and the manual
> „Ukončiť“ button. Hand-over also **enqueues** `notifications` rows (`queued`) with a template
> key per delivery type — this module defines that contract and ships the table CREATE; it never
> sends. Out of scope (handoffs): **bag labels** (F7 — built elsewhere; the board keeps a
> „Štítky“ button as an entry point only); **sending messages, templates, segments, the
> composer, `phone_e164`, opt-in** (module 21 `21-whatsapp-notifications.md`); **the cycle stage
> model, `opens_at`/`closes_at`/`stage`, the timeline** (module 17 `17-cycle-stages.md` — this
> module only names the hook that promotes a cycle to `ready`); **guest Packeta as its own
> party, `guest_orders.packeta_address`/`delivery_fee`** (module 20 `20-guest-packeta.md` —
> but `delivery.js` must already classify a guest with a non-empty `packeta_address` as
> `packeta`); **the friend/guest read of their bag's stage** (modules 17/18 — this module
> publishes `handed_over_at` on ADMIN surfaces only); **cycle auto-completion** (dropped, PO
> Q8.c); **„vyzdvihnite do N dní“ copy** (dropped, PO Q8.b); any change to
> `helpers/stock.js`, `helpers/pricing.js`, `helpers/packing.js`'s two ledger writes,
> `helpers/guest-aggregation.js`.
> Actors: **Admin** — the ONLY writer of `handed_over_at`, of the bulk hand-over and of the
> board; sole reader of the distribution payload. **Friend (host)** — no new capability here;
> keeps `guest_orders.delivered` as their own, later, host-only tick (untouched); reads their
> bag's stage through module 17/18 surfaces. **Guest** — no new capability; reads their stage
> through module 17's timeline on the status page; is a notification RECIPIENT (rows queued, not
> sent). Neither friend nor guest may call any route in this module (401).
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §11 (F8 — vocabulary
> table, bag stages, board, API, notifications table), §15 Q8.a/b/c, §16 Decisions (Q8.b, Q8.c,
> F7 deferred, R1.3 wording), §18 roadmap v3 rows 3–4 — later sections win, struck text is
> superseded; prototype `docs/design/friends-portal-redesign/friends/admin2.jsx` (`ADist`, the
> LAYOUT + FLOW authority; its neobrutal skin is NOT — the admin re-skin is a later task) +
> `README.md` addendum 2026-09-06; `docs/specification/00-overview.md` §Scope extension — roadmap
> October 2026, glossary (Delivery type, Bag stages, Outbox); `docs/specification/01-architecture.md`
> §Roadmap October 2026 additions (`handed_over_at`, `helpers/delivery.js`, `notifications`
> shape), §Permissions (Roadmap October 2026), §Testing & gate (roadmap notes);
> `docs/learnings/06-pickup-point.md` (the two-store pickup model, the print/badge rules, the
> ledger-neutrality verification); repo `CLAUDE.md` (Money & data, print sheet rules, one-home
> helpers, `ADMIN_ENDPOINTS`, unbindable-body 400s, `instances: 1`); code —
> `frontend/src/views/Distribution.vue`, `backend/src/routes/cycles.js` (`GET /:id/distribution`,
> `PATCH /:id`), `backend/src/routes/orders.js` (`PATCH /:id/packed`),
> `backend/src/routes/order-items.js` + `guest-order-items.js` (the auto-unpack paths),
> `backend/src/routes/guest-orders.js` (`PATCH /:id/delivered`, HOST-only — untouched),
> `backend/src/helpers/packing.js`, `helpers/pickup.js`, `helpers/guest-orders.js`,
> `helpers/analytics.js` (`variantToKg`), `backend/src/db/schema.js`; shipped e2e
> (`guest-distribution`, `item-packed`, `order-pickup-edit`, `api-security`). The most recent
> decision wins on conflict.
> **Design reference:** `docs/design/friends-portal-redesign/friends/admin2.jsx` → `ADist`
> (open `Podpultovka Friends.html` → „Admin (prototyp 2026-09)“ → Distribúcia; desktop 1180).
> Match its LAYOUT, FLOW and COPY (plan cards → toolbar → groups → rows → confirm modal); render
> it in the CURRENT admin shadcn skin (01-architecture §Design system scope rule — no `neo/`
> classes, no theme tokens in admin views). `OPEN:` board layout — default = the prototype as
> drawn (00-overview §Scope extension lists it among the open prototype decisions).

---

## Resolved conflicts (recency / canonicity)

1. **§11 notification copy „Vyzdvihnite si ju do {dní} dní“ / §15 Q8.b default „5 dní“ vs
   §16 Q8.b.** §16 wins: the pickup message says only that the bag is at the place and can be
   picked up — **no „within N days“**, no per-location days setting. This module records only
   the template KEY; the text belongs to module 21 (UC-DP-008).
2. **§11 „first stage-3 bag → cycle `ready`; every bag handed over → offer Ukončiť“ + §15 Q8.c
   „auto-complete?“ vs §16 Q8.c.** §16 wins: **no auto-completion**, ever. The button is offered
   (enabled only when every party is handed over); the admin presses it (UC-DP-014). The
   `ready` promotion stays (UC-DP-009) — it is a stage inside `locked`, not a completion.
3. **§11 per-group „Vytlačiť štítky“ / „Poslať správu“ vs §16 F7 deferred + F5 last.** F7 is
   built elsewhere: the board keeps ONE „Štítky“ entry-point button per group and one
   „Vytlačiť štítky“ in the header, both wired to the labels feature's existing entry (OPEN
   below); nothing about labels is specified here. „Správa skupine“ / „Správy (n vo fronte)“
   are module 21's buttons and are **not rendered by this module** — 21 adds them.
4. **Prototype `togglePacked` cascade (un-packing a bag also clears `handed`) vs this module's
   rule.** REJECTED in favour of a refusal: un-packing a handed-over bag answers 409
   `handed_over`; the admin un-hands-over first (UC-DP-007). Reason: a silent cascade would
   also have to delete queued notifications behind the admin's back, and it would let a
   per-item uncheck (which auto-unpacks the order) erase a hand-over record from a screen
   that never showed it. Q8.a's default („unpack first if the bag changes“) is read together
   with this: the sequence is un-hand-over → unpack → change → pack → hand over.
5. **§11 „guest bags cannot be handed over separately“ vs the §11 API list naming
   `PATCH /api/guest-orders/:id/handed-over`.** Both hold, at different layers: the API accepts
   a per-guest hand-over (needed for module 20's Packeta guests, for a host with NO own
   `orders` row, and for the withheld-bag correction), while the BOARD offers no clickable
   „Odovzdané“ on a `via_host` guest nested under a host who has an own order — that guest
   mirrors its own `handed_over_at`, which the host's hand-over stamps (UC-DP-005, UC-DP-011).
6. **Wording.** §16 R1.3 („objednávka“, never „kolo“/„cyklus“) binds friend/guest copy; the
   glossary lets the admin UI keep „cyklus“. The prototype's admin button reads
   „Ukončiť objednávku“; the shipped admin header reads „Označiť ako dokončený“. Default =
   prototype label (UC-DP-014, `OPEN:` for the PO).

---

## UC-DP-001 `helpers/delivery.js` — delivery type + planning target (system)

**Goal:** one home for „how does this bag leave, and where“ — consumed by the distribution
payload (UC-DP-003), the enqueue hook (UC-DP-008), later by module 20 (guest Packeta), module
21 (`helpers/segments.js`) and, if it adopts it, the labels feature. Read-only: this helper
never writes; `helpers/pickup.js` remains the sole writer of `pickup_location_*` /
`packeta_address` / `delivery_fee` (roadmap §11 vocabulary table, 01-architecture).

**Exports:**

- `deliveryOf(party, { host } = {})` → `{ type, target_key, target_label, target_detail, phone }`.
  `party` is a row in the shape the distribution query yields (friend party) or a
  `guest_orders` row (guest party); `host` is the host party's already-derived delivery when
  `party` is a guest.
- `deliveryGroupOrder(locations)` → the ordered list of `target_key`s the board and plan use:
  `['packeta', ...locations.map(l => 'loc' + l.id), 'in_person']`.
- `TARGET_LABELS = { packeta: 'Packeta', in_person: 'Osobne' }` — the only two literals.

**Business rules (the roadmap §11 table, made testable):**

| type | rule (evaluated in this order) | `target_key` | `target_label` | `target_detail` | `phone` |
|---|---|---|---|---|---|
| `packeta` | `packeta_address` is a non-empty string after `trim()` | `packeta` | „Packeta“ | the address as stored | friend: `friends.phone` (module 11 „Mobil“); guest: `guest_phone` |
| `pickup` | else `pickup_location_id` is a positive integer | `loc<id>` | `pickup_locations.name` looked up **without** `active = 1` (a soft-deleted place must still name itself — `helpers/pickup.js` `pickupOf()` rule) | `pickup_locations.address` or `null` | `null` |
| `in_person` | else (with or without `pickup_location_note`) | `in_person` | „Osobne“ | `pickup_location_note` or `null` | `null` |
| `via_host` | a **guest** party whose own `packeta_address` is empty | inherits `host.target_key` | inherits `host.target_label` | `cez {host_name}` | `guest_phone` (its own — the notification recipient) |

- A **friend party's** pickup columns are read through `helpers/pickup.js` resolution: a
  party with an `orders` row (any status) uses that row's columns; a host with NO `orders`
  row uses `guest_order_links` (`readPickup()` / `linkPickupsByHost()` — the two-store model of
  `docs/learnings/06-pickup-point.md`). `packeta_address` exists only on `orders`, so a
  no-own-order host can only ever be `pickup` or `in_person`.
- A **guest party** is checked for `packeta` FIRST, on its own `packeta_address` — the column
  arrives with module 20. Until then the property is `undefined` on every row, and the check
  MUST be own-property + type-safe (the `variantGrams()` discipline): `undefined`, `null`, a
  number, `''` and `'   '` all classify as „no Packeta“ ⇒ `via_host`. A `packeta` guest is
  its own party (its own bag, its own stage, its own row on the board — module 20 renders it;
  this module only guarantees the classification).
- `type` is exactly one of the four strings; `target_key` is `packeta` | `loc<int>` |
  `in_person`; no other value may be emitted (a consumer switching on them must not need a
  default branch).
- The helper takes ROWS, not ids, and issues no query except the pickup-location name/address
  lookup, which callers may pre-resolve by passing `locationsById` in the options to avoid an
  N+1 on the payload (UC-DP-003 does).
- Pickup-location ordering for `deliveryGroupOrder` = ascending `id` (the prototype's order;
  default, no PO decision needed).

**Acceptance criteria:** a row with both `packeta_address` and `pickup_location_id` set
classifies `packeta` (address wins, mirroring the exclusive-by-construction write rule); a
guest row without the module-20 column classifies `via_host` with the host's key/label; a
guest row with `packeta_address: 'Z-BOX …'` classifies `packeta`; a party whose location was
deactivated still gets its name.

---

## UC-DP-002 Schema — `handed_over_at` on `orders` + `guest_orders`; `notifications` CREATE (system)

**Goal:** the stage-3 timestamp on both bag tables, and the outbox table this module's hook
writes into — exactly the shapes 01-architecture §Roadmap October 2026 additions fixes.

**Business rules:**

- `orders.handed_over_at DATETIME` (nullable) — `try/catch ALTER TABLE` migration in
  `schema.js` (the `packed_at` precedent, schema.js:412-423) AND the column in the CREATE.
- `guest_orders.handed_over_at DATETIME` (nullable) — **CREATE and ALTER**, the deliberate
  exception to the GSO-T2 „guest tables never touch migrations“ rule, for the reason recorded
  at schema.js:940-955: the table already exists in prod/staging where
  `CREATE TABLE IF NOT EXISTS` is a no-op.
- `notifications` — `CREATE TABLE IF NOT EXISTS` with the 01-architecture column list
  VERBATIM: `id, channel CHECK IN ('whatsapp','email'), template_key, segment_key,
  recipient_kind CHECK IN ('friend','guest','waitlist'), recipient_id, phone_e164, body,
  status CHECK IN ('queued','released','sent','failed','skipped'), cycle_id, order_id NULL,
  guest_order_id NULL, created_at, released_at, sent_at, error`. `body` and `phone_e164` are
  NULLABLE (this module writes them as `NULL`, UC-DP-008). Module 21 owns every later column
  and adds them via its own ALTERs — it must not re-declare this CREATE.
- No index is required by this module; module 21 may add one on `(status, channel)`.
- No `orders.stage` / `guest_orders.stage` column: stage is DERIVED (UC-DP-003) from
  `packed` and `handed_over_at`, never stored twice.
- `guest_orders.delivered` / `delivered_at` are **untouched** in meaning and in every route
  (`PATCH /guest-orders/:id/delivered` stays HOST-only, ungated by hand-over — a host may
  tick „delivered“ before the admin records the hand-over, e.g. they collected in person and
  the admin catches up later).

**Acceptance criteria:** a fresh DB and a migrated DB both expose the two columns (asserted via
`PRAGMA table_info`); the backend boots twice against the same file (idempotent ALTERs).

---

## UC-DP-003 `GET /api/cycles/:id/distribution` — delivery, stage and plan (Admin)

**Goal:** the one payload the board, the cycle header plan line and the print sheet render
from. ADDITIVE to the shipped shape (cycles.js:522-625): every key the shipped e2e specs read
(`id`, `name`, `order_id`, `has_own_order`, `status`, `paid`, `total`, `packed`, `packed_at`,
the three `pickup_location_*`, `delivery_fee`, `packeta_address`, `balance`, `items[]`,
`guest_orders[]` with items) keeps its name, type and semantics.

**Additions per PARTY row (friend order or synthetic host):**

- `phone` — `friends.phone` (added to the SELECT; the Packeta row needs it and the label
  feature may).
- `handed_over_at` — `orders.handed_over_at`, or for a synthetic host (`order_id: null`) the
  DERIVED value: the MAX of `handed_over_at` over their live guest sub-orders when EVERY live
  sub-order has one, else `null`.
- `stage` — `'handed'` when `handed_over_at` is non-null; else `'packed'` when the party is
  packed (`orders.packed = 1`; for a synthetic host: `packingItemStats({ orderId: null,
  friendId, cycleId })` reports `total > 0` and `packed_count === total` — the SAME union the
  pack gate uses); else `'to_pack'`.
- `delivery` — `deliveryOf(party)` (UC-DP-001); for the synthetic host the pickup columns are
  the `readPickup()` values already merged onto the row.
- `kg` — grams of every own item via `variantToKg()` (`helpers/analytics.js`, the only weight
  authority; `unit` variants are zero-gram) summed, plus every live guest item's — the guest
  half merged in JS (never a JOIN onto the friend row; the GSO-T6/T8 rule), rounded for
  display by the client with `Math.round(g/10)/100`.

**Additions per GUEST sub-order row (inside `guest_orders[]`):** `handed_over_at`,
`stage` (`'handed'` if its own `handed_over_at`; else `'packed'` if it has ≥1 item and all
its `guest_order_items.packed = 1`; else `'to_pack'`), `delivery` (`deliveryOf(guest,
{ host: party.delivery })` — `via_host` today, `packeta` after module 20), `kg`.

**Additions at the top level:**

- `plan: [{ target_key, target_label, type, count, packed_count, handed_count, kg }]` in
  `deliveryGroupOrder(locations)` order, one entry per key that has ≥1 party OR is a
  location active for this cycle's type (`for_coffee`/`for_bakery`) — so an empty configured
  point still shows „0“ on its plan card. Counts are over PARTIES (a host with nested
  `via_host` guests is ONE bag); a module-20 Packeta guest is its own party and counts under
  `packeta`.
- `totals: { count, packed_count, handed_count }` over parties.
- `locations: [{ id, name, address }]` — the pickup locations referenced by any party or
  active for the cycle type (the board's group sub-lines; saves the client a second call for
  names, while the picker keeps its own `GET /api/pickup-locations` call for the editable
  list, filtered by cycle type).

**Business rules:**

- **One query set.** The friend rows come from the existing query (`FROM orders … WHERE
  status = 'submitted'`, now also selecting `f.phone`, `o.handed_over_at`); guests from
  `cycleSubOrdersByHost()` (`GUEST_ORDER_FIELDS` grows `handed_over_at` — the ONE shared list,
  helpers/guest-orders.js:47-50, so every host/admin surface publishes it identically);
  pickup locations in one query; plan/totals/stage/kg computed in JS. ⚠ Never a second
  `LEFT JOIN` on `orders` (row multiplication, CLAUDE.md §Money & data).
- Cancelled sub-orders stay EXCLUDED (the shipped `liveSubOrders` filter) — a called-off bag
  is neither counted, staged nor handed over.
- No cycle-status gate on the read (unchanged) — the board is reachable for `open` cycles
  too (nothing to hand over yet, the plan shows 0/N), and for `completed` ones (a correction
  after completion must still be possible).
- ⚠ **Route joins `ADMIN_ENDPOINTS`**: `GET /api/cycles/1/distribution` is `requireAdmin` in
  code (cycles.js:522) but is **absent** from `e2e/tests/api-security.spec.js` today (verified
  2026-09-19) — this module adds it (UC-DP-015).

**Acceptance criteria:** a locked cycle with one Packeta friend, two friends at location L, a
host with two guests at L and one in-person friend yields `plan` = `packeta 1 · loc<L> 3 ·
in_person 1` (the host counts once), `totals.count = 5`; the host's `stage` is `'to_pack'`
until every own + guest item is checked, `'packed'` after `PATCH /orders/:id/packed`,
`'handed'` after UC-DP-004; the shipped `guest-distribution.spec.js` and
`order-pickup-edit.spec.js` API assertions pass UNMODIFIED.

---

## UC-DP-004 `PATCH /api/orders/:id/handed-over` — friend bag hand-over, guests inherit (Admin)

**Goal:** the stage-3 write for a friend's bag. „The bag left my hands“ — dropped at Packeta,
left at the pickup point, or handed to the friend/host (roadmap §11 bag stages).

**Route:** `requireAdmin`, in `routes/orders.js` next to `PATCH /:id/packed`. Body
`{ handed_over: true | false }` — an **explicit boolean is required**; a missing field, a
non-boolean, or an unbindable body shape (`{}`, `true`, `[id]`, `'abc'`) is **400**, never 500
(CLAUDE.md §Auth & boundaries). Unlike the host's `delivered` toggle there is no
absent-field-toggles convenience: hand-over fires notifications, so the intent must be stated.

**Business rules:**

- **404** unknown order. **400** `order.status !== 'submitted'` (same message family as the
  packed route: „Len odoslané objednávky môžu byť označené ako odovzdané“).
- **No cycle-status gate** — the same basis as `PATCH /:id/packed` and the pickup PATCH: the
  action is needed while `locked`, and a correction may be needed after `completed`.
- **Setting `true`:** requires `orders.packed = 1`, else **409 `{ reason: 'not_packed' }`**
  (PO Q8.a default: no partial-bag hand-over; „Najprv označte balíček ako zabalený“). Already
  handed over ⇒ **200 idempotent, the timestamp is NOT refreshed** (the first hand-over time is
  the record; a double click or second device converges).
- **Setting `false`:** clears `handed_over_at` (the mis-click case, roadmap §11 „reversible“).
  Already null ⇒ 200 idempotent. ⚠ Reversal has NO dependency on `packed` and no gate of its
  own — un-hand-over is always allowed.
- **ONE transaction, exactly these writes, re-checked inside it (`instances: 1`, synchronous
  handler — no `await` anywhere in it, GA-T8):**
  1. `UPDATE orders SET handed_over_at = CURRENT_TIMESTAMP WHERE id = ? AND packed = 1 AND
     handed_over_at IS NULL` (or `… SET handed_over_at = NULL WHERE id = ?` on reversal). A
     `changes = 0` on the `true` path after the pre-check means the row was un-packed between
     check and write ⇒ the transaction throws and the route answers the same 409.
  2. **Guest inheritance (roadmap §11):** `UPDATE guest_orders SET handed_over_at =
     <same timestamp> WHERE link_id IN (SELECT id FROM guest_order_links WHERE host_friend_id =
     ? AND cycle_id = ?) AND COALESCE(status,'submitted') <> 'cancelled' AND handed_over_at IS
     NULL` — every live sub-order of this host for this cycle, because their bags are inside
     the host's bag. On reversal the mirror: `… SET handed_over_at = NULL WHERE link_id IN (…)
     AND COALESCE(status,'submitted') <> 'cancelled'` — inheritance is symmetric so a
     mis-click is fully undone. ⚠ A module-20 **Packeta guest is NOT inherited** either way:
     the predicate additionally requires the guest's own `packeta_address` to be empty
     (`COALESCE(packeta_address,'') = ''` once the column exists; until then the predicate is
     a no-op by construction — implement it now so module 20 changes nothing here).
  3. The outbox enqueue / dequeue of UC-DP-008 for the order and each inherited guest.
  4. The cycle-stage hook of UC-DP-009 on the `true` path.
- ⚠ **NO `transactions` row. No `total` / `paid` / `packed` / `delivered` / `delivery_fee`
  write.** Stage 2 (`packed`) is and stays the ledger moment (`helpers/packing.js`); stage 3 is
  ledger-neutral by construction (roadmap §11, 01-architecture). Pinned by UC-DP-015 with the
  `MAX(id)`-watermark idiom of `guest-distribution.spec.js` (never a global count).
- Literal column names only; never spread the body into an UPDATE.
- **Response:** `{ order: { id, packed, packed_at, handed_over_at, stage }, guests: [{ id,
  handed_over_at, stage }], queued_notifications: <n>, cycle_stage: <string|null> }` — enough
  for the board to patch its rows in place without a reload.

**Acceptance criteria:** `true` on an unpacked submitted order ⇒ 409 `not_packed` and the row
read back has `handed_over_at IS NULL`; on a packed order ⇒ 200, `orders.handed_over_at` set,
every live guest sub-order of that host stamped with the identical timestamp, the cancelled
one untouched; `false` ⇒ all cleared; a second `true` ⇒ 200 with the original timestamp;
ledger watermark unmoved across all of it; friend Bearer / anonymous ⇒ 401; `[3]` body ⇒ 400.

---

## UC-DP-005 `PATCH /api/guest-orders/:id/handed-over` — guest bag hand-over (Admin)

**Goal:** the per-sub-order write, for the three cases where a guest bag IS the unit being
handed over: (a) a module-20 Packeta guest (own party); (b) a host with NO own `orders` row,
whose „party“ is exactly the set of their guest bags (there is no order id to PATCH); (c) a
correction on one withheld bag under a handed-over host.

**Route:** `requireAdmin`, on the MIXED `/api/guest-orders` router — gated **per route**, the
guard on the route's first lines, header comment updated (the guest-orders.js:17-27 idiom).
⚠ Never wrap the mount. Body contract identical to UC-DP-004 (`{ handed_over: boolean }`,
400 otherwise).

**Business rules:**

- **404** unknown sub-order (`findSubOrderWithLink`). **409 `{ reason: 'cancelled' }`** for a
  cancelled sub-order (terminal — same shape and reason as the host's `delivered` route).
- **`true`:** requires `≥1 guest_order_items` row and **all** with `packed = 1`, else **409
  `not_packed`**. Already handed ⇒ 200, timestamp kept. **`false`:** clears; idempotent.
- ⚠ **Does NOT touch the host's `orders.handed_over_at`** in either direction — a guest-level
  correction is a correction of one bag. The board's host row stage therefore stays as it is,
  and the guest row shows its own state (UC-DP-011 renders a mixed host as „odovzdané okrem
  {n}“ — see there).
- One transaction: the single-row UPDATE with the re-check in its WHERE (`… AND handed_over_at
  IS NULL AND NOT EXISTS (SELECT 1 FROM guest_order_items WHERE guest_order_id = ? AND
  COALESCE(packed,0) = 0) AND EXISTS (SELECT 1 FROM guest_order_items WHERE guest_order_id = ?)`),
  the UC-DP-008 enqueue/dequeue for this guest, the UC-DP-009 hook.
- ⚠ **No `transactions` row** (guests have no ledger); no `paid` / `delivered` / `total` write.
- **Response:** `mutationPayload(row)` (guest-orders.js:64-69) — which now carries
  `handed_over_at` via `GUEST_ORDER_FIELDS` — plus `stage` and `queued_notifications`.

**Acceptance criteria:** a guest with one unchecked item ⇒ 409 and the row unchanged; all
checked ⇒ 200 with `handed_over_at`; the host's order row is unchanged by it; a cancelled
sub-order ⇒ 409 `cancelled`; friend Bearer (even the HOST's own) ⇒ 401 — `handed_over` is
admin-only exactly as `paid` is, and unlike `delivered`.

---

## UC-DP-006 `POST /api/cycles/:id/distribution/hand-over` — bulk, one transaction (Admin)

**Goal:** the per-group „Odovzdať zabalené (n)“ action (roadmap §11 API list): many bags in one
transaction, each re-checked for `packed` inside it (`instances: 1`, synchronous).

**Route:** `requireAdmin`, `routes/cycles.js`. Body `{ order_ids: int[], guest_order_ids:
int[] }` — both arrays REQUIRED (empty allowed), every element a positive integer, **at least
one id overall**, each array ≤ 500 elements; anything else 400, unbindable shapes 400.

**Business rules:**

- **404** unknown cycle. Every id must belong to THIS cycle (`orders.cycle_id` /
  `guest_order_links.cycle_id` via the link) — a foreign id ⇒ **400 `{ reason: 'foreign_id',
  order_ids: [...], guest_order_ids: [...] }`**, nothing written.
- **All-or-nothing on `not_packed`.** Inside the transaction every order id is re-read; any
  submitted order with `packed = 0`, or any guest with an unchecked/zero item set, aborts the
  whole batch with **409 `{ reason: 'not_packed', order_ids: [...], guest_order_ids: [...] }`**
  naming the offenders. The confirm dialog promised „n balíčkov prejde“ on a snapshot; if the
  snapshot is stale (another device un-packed one) the admin sees exactly which, reloads, and
  decides — a partial success would leave the toast count wrong and one bag silently behind.
  Non-submitted orders and cancelled guests in the batch are 409 offenders too (`reason:
  'not_packed'` for orders — they cannot be packed; `reason: 'cancelled'` listed separately for
  guests).
- **Already handed-over ids are SKIPPED, not errors** (idempotent re-run of a group), and
  counted in `already_handed`.
- Each handed order applies the FULL UC-DP-004 write (its guests inherit; enqueue; stage
  hook). A guest id in `guest_order_ids` whose host order is in `order_ids` of the same batch
  is deduplicated (inherited once, stamped once, enqueued once). Guest ids are otherwise the
  UC-DP-005 write.
- One timestamp for the whole batch (read once, bound to every UPDATE) — the plan card's
  „odovzdané“ bar and module 21's segments group by it.
- Reversal is NOT bulk: un-hand-over is per bag (UC-DP-004/005). A bulk reversal is a Phase 2
  item, **not** silently implemented.
- ⚠ No `transactions` row; no `await` in the handler.
- **Response 200:** `{ handed_over: n, already_handed: m, guests_inherited: k,
  queued_notifications: q, cycle_stage }`.

**Acceptance criteria:** a batch of two packed orders + one unpacked ⇒ 409 naming the unpacked
id and **no row changed** (all three read back); the two-packed batch ⇒ 200 `handed_over: 2`,
guests of both stamped, one timestamp string across all rows; re-sending the same batch ⇒
`handed_over: 0, already_handed: 2`; an id from another cycle ⇒ 400 `foreign_id`; ledger
watermark unmoved.

---

## UC-DP-007 A handed-over bag cannot be un-packed or item-unchecked (Admin)

**Goal:** stage order is real: Odovzdané implies Zabalené. Un-packing posts the ledger
reversal and re-opens the bag for changes — neither may happen to a bag that already left the
admin's hands without the admin first taking the hand-over back (resolved conflict 4).

**Business rules (a gate, added at every door that reaches `unpackOrder()`):**

- `PATCH /api/orders/:id/packed` toggling to **un**packed while `orders.handed_over_at IS NOT
  NULL` ⇒ **409 `{ reason: 'handed_over' }`**, copy „Balíček je už odovzdaný — najprv zrušte
  odovzdanie.“ Packing (0 → 1) is unaffected.
- `PATCH /api/order-items/:id/packed` **un**checking an item whose parent order is handed over
  ⇒ the same 409, and the item stays checked (the auto-unpack at order-items.js:40 is never
  reached). Checking is unaffected.
- `PATCH /api/guest-order-items/:id/packed` **un**checking an item ⇒ 409 `handed_over` if the
  guest sub-order's own `handed_over_at` is set OR the host's own order (`hostOwnOrder()`) is
  handed over (guest-order-items.js:61-67 would otherwise un-pack the host).
- The gate is a READ + 409 in each route before its transaction, AND repeated as a predicate
  inside it — never a change to `packOrder`/`unpackOrder` themselves (`helpers/packing.js`'s
  two ledger writes are out of scope). ⚠ Refusal tests read the row back.
- Frontend: the „Zabalené“ checkbox and every item checkbox of a handed-over bag render
  disabled with `title="Najprv zrušte odovzdanie"`; a refused change snaps the control back
  (CLAUDE.md §Frontend).

**Acceptance criteria:** on a handed-over order, un-pack ⇒ 409, `packed` still 1, ledger
watermark unmoved; item uncheck ⇒ 409, `order_items.packed` still 1; after `handed_over:
false` the same un-pack ⇒ 200 with the reversal row exactly as today (`item-packed.spec.js`
passes unmodified on non-handed bags).

---

## UC-DP-008 Outbox enqueue hook — `notifications` rows as `queued` (system)

**Goal:** the stage-3 moment is when people want to hear „your coffee is at X“ (roadmap §11
Notifications table, Q5.d default: queued on hand-over, released by the admin). This module
writes the ROWS and defines their contract; module 21 renders, releases and sends. **The API
never sends** (01-architecture).

**Contract — one row per (recipient, bag) at hand-over, written INSIDE the hand-over
transaction (UC-DP-004/005/006):**

| bag handed over | recipient_kind / recipient_id | template_key | segment_key |
|---|---|---|---|
| friend order, `delivery.type = 'pickup'` | `friend` / `orders.friend_id` | `pickup` | `loc<id>` |
| friend order, `packeta` | `friend` / `orders.friend_id` | `packeta` | `packeta` |
| friend order, `in_person` | — **no row** (module 21 UC-WA-004 defines no template for in-person hand-over; the admin arranges it directly) | — | `in_person` (segment only, for the board's „Správa skupine“ with template `custom`) |
| each guest **inherited** from a host (via_host) | `guest` / `guest_orders.id` | `host` | `host:<host_friend_id>` |
| guest handed over on its own, `via_host` (UC-DP-005 cases b/c) | `guest` / `guest_orders.id` | `host` | `host:<host_friend_id>` |
| guest handed over on its own, `packeta` (module 20) | `guest` / `guest_orders.id` | `packeta` | `packeta` |
| a host with NO own order (synthetic party) | — no `friend` row; only the guest rows above | — | — |

Fixed columns: `channel = 'whatsapp'`, `status = 'queued'`, `cycle_id`, `order_id` (friend
rows) / `guest_order_id` (guest rows), `created_at = CURRENT_TIMESTAMP`, **`body = NULL`,
`phone_e164 = NULL`, `released_at/sent_at/error = NULL`**.

**Business rules:**

- **Facts, not text.** This module stores WHICH template for WHOM about WHICH bag. Module 21
  renders `body` from the template key + the live row (recipient name, place, address, host,
  amount) at RELEASE time and resolves `phone_e164` then (from `friends.phone_e164` /
  `guest_phone`, opt-in, `skipped` on a missing number — all 21's rules). ⚠ Reason: template
  text is editable in 21's composer before release, and the PO fixed the pickup wording (no
  „N dní“) — rendering at enqueue would freeze stale text into rows.
- **Template keys are module 21's three literals** (UC-WA-004 owns the set and the texts):
  `pickup` ↔ „Doručené na odberné miesto“, `packeta` ↔ „Odovzdané Packete“, `host` ↔
  „Odovzdané priateľovi“. An `in_person` bag enqueues NO row (no template; the admin
  arranges the hand-over directly — orchestrator reconciliation 2026-09-19). Recipients are never friends without
  a bag: the „everyone at point X“ segments are 21's composer, not a hand-over row.
- **Idempotent enqueue:** before INSERT, if a `queued` row exists for the same `(template_key,
  recipient_kind, recipient_id, order_id/guest_order_id)` no second row is written. A
  `released`/`sent` row does not block a new `queued` one (a genuine re-hand-over after a
  reversal is a new event).
- **Reversal dequeues:** `handed_over: false` **DELETEs** this bag's rows with `status =
  'queued'` (and, on a host reversal, its inherited guests' `queued` rows) — never
  `released`/`sent`/`failed`/`skipped` rows (those are history). The row count returned as
  `dequeued_notifications`.
- Hand-over of a bag whose recipient is a deactivated friend still enqueues (21 decides
  whether to skip; this module records the event).
- ⚠ **No sending, no outbound call, no import of any WhatsApp/mail code from these routes**;
  no `released` transition exists in this module.
- Board copy that mentions the messages (confirm modal second sentence, toast half „· n správ
  zaradených na odoslanie (WhatsApp)“, header „Správy (n vo fronte)“) is **module 21's** — this
  module does not render it (resolved conflict 3). Rows still accumulate from day one so the
  trigger data exists when 21 lands (§16 F5 consequence).

**Acceptance criteria:** hand-over of a `pickup` friend with two live guests inserts exactly
three `queued` rows (1 × `pickup` for the friend with `order_id`, 2 ×
`host` with the guest ids, `segment_key = 'host:<id>'`), all `body IS NULL`;
a repeat hand-over inserts none; reversal deletes exactly those three and leaves a pre-existing
`sent` row alone; a synthetic host's guest hand-over inserts guest rows only; no row ever has
`status <> 'queued'` after any route in this module.

---

## UC-DP-009 Cycle stage seam — first hand-over promotes the cycle to `ready` (system)

**Goal:** name the hook module 17 needs (01-architecture: „`stage` … moves to `ready` on the
first hand-over, never auto-completes the cycle“) without specifying the stage model.

**Business rules:**

- `backend/src/helpers/cycle-stage.js` exports `markCycleReady(cycleId)`. This module
  ships it as a **no-op stub** (returns `null`) with a header comment naming module 17
  (`17-cycle-stages.md`, its stage-transition UC) as the owner of the body. Until 17 ships
  there is no `order_cycles.stage` column to write.
- Every `true` hand-over path (UC-DP-004/005/006) calls it INSIDE the transaction after its
  writes, once per request (the bulk route once, not per bag), and echoes its return as
  `cycle_stage` in the response.
- Module 17's contract for the body (recorded here so the seam connects, NOT specified here):
  set `stage = 'ready'` only when `status = 'locked'` and `stage IN ('ordered','arrived')`;
  never touch `status`; reversal of a hand-over does NOT demote (a bag came back, the cycle is
  still in its ready phase — 17 may reconsider).
- ⚠ **Nothing in this module writes `order_cycles.status`.** Completion is the admin's button
  (UC-DP-014) calling the existing `PATCH /cycles/:id { status: 'completed' }`.

**Acceptance criteria (this module):** a hand-over on a DB without the `stage` column
succeeds and answers `cycle_stage: null`; the stub is the only symbol module 17 replaces.

---

## UC-DP-010 Distribution board — plan header, group-by, stage filter (Admin)

**Goal:** the admin plans the week from the board right after lock: how many bags go to
Packeta, to each pickup point, in person (roadmap §11 „Header = the plan“). Layout/flow/copy
from `ADist`; skin = current admin shadcn (no `neo/`). `OPEN:` board layout — default =
prototype as drawn.

**Structure (top → bottom, `Distribution.vue`):**

1. **Header bar** (existing, `print:hidden`): back button, title „Distribúcia · {cycle.name}“
   (the prototype appbar sub adds „· uzamknuté“ when `status = 'locked'`; „· ukončené“ when
   completed), actions right: **„Vytlačiť štítky“** (F7 entry point — `OPEN:` target: the
   labels feature's existing route/print; default = the button navigates to that feature's
   entry, no behaviour specified here), **„Tlačiť“** (existing `window.print()`), **„Ukončiť
   objednávku“** (UC-DP-014's gate, same rule as on CycleDetail).
2. **Title block:** `h1` „Distribúcia plán“ (prototype: „Distribúcia“ + highlighted „plán“),
   sub-line „{totals.count} balíčkov · {totals.packed_count} zabalených ·
   {totals.handed_count} odovzdaných“ — plural forms via a new `bagsLabel(count)` in
   `lib/plural.js` (one home: „balíček“ / „balíčky“ / „balíčkov“ for 1 / 2–4 / 0,5+), the
   participles agreeing („1 zabalený“, „2 zabalené“, „5 zabalených“ — nominative plural of the
   count noun, no reader address, vy-form register untouched).
3. **Plan cards** (`data-testid="plan-card-<target_key>"`), one per `plan[]` entry in order:
   icon (truck / pin / hand), `target_label`, big count `count`, a two-tone progress bar
   (handed share, then packed-not-handed share — `handed_count / count` and
   `(packed_count − handed_count) / count`), line „{packed}/{n} zabal. · {handed}/{n} odovzd. ·
   {kg} kg“ (kg via `Math.round(g/10)/100`, trailing zeros stripped). **Click** = set group-by
   to „Podľa doručenia“ AND focus that one group (card gets the `on` state); click again =
   unfocus. Cards with `count = 0` render (the plan shows empty points).
4. **Toolbar:** segmented **group-by** „Podľa doručenia“ (default) / „Podľa stavu“ / „Podľa
   priateľa“ (`data-testid="group-by-<delivery|stage|friend>"`), and **stage filter** tabs
   „Všetko“ (default) / „Na zabalenie“ / „Zabalené“ / „Odovzdané“
   (`data-testid="stage-filter-<all|to_pack|packed|handed>"`). Changing group-by clears the
   card focus.
5. **Groups** (UC-DP-011 rows inside), then the confirm modal (UC-DP-012).

**Grouping rules (testable):**

- **Podľa doručenia:** groups in `deliveryGroupOrder` order — Packeta (title „Packeta“, sub
  „zásielky odovzdáte na pobočke / Z-BOXe“), each pickup location (title = name, sub =
  address or nothing), „Osobné odovzdanie“ (sub „dohodnete individuálne“). A party lands in
  the group of ITS `delivery.target_key`; nested `via_host` guests travel with their host; a
  module-20 Packeta guest is its own row under Packeta with badge „hosť · {host}“. With filter
  „Všetko“ every group renders even when empty („Nič v tejto skupine.“); with any other
  filter, empty groups are hidden.
- **Podľa stavu:** exactly three groups „Na zabalenie“ / „Zabalené“ / „Odovzdané“; a party
  appears in exactly one, by its `stage`.
- **Podľa priateľa:** one group „Všetci“, parties sorted by `name.localeCompare` (today's
  flat list).
- **Stage filter** applies to PARTIES (host rows); nested guests are never filtered
  independently of their host.
- Within a group, parties sort by name (`localeCompare`, existing behaviour).
- **Group header:** title, sub, badge „{n} balíček/balíčky/balíčkov“, „{p} zabal. · {h}
  odovzd.“, actions „Štítky“ (F7 entry point, see header rule), „Odovzdať zabalené ({ready})“
  where `ready` = parties in the group with `stage = 'packed'`; disabled when `ready = 0`
  (`data-testid="handover-group-<group_key>"`). No „Správa skupine“ — module 21 adds it.
- **State handling:** `loadSeq` guard on the load; group-by / filter / focus are local `ref`s
  and survive in-place row patches; the per-item pending map, `guestCollapse` fold map and the
  pickup-locations error Alert are kept as shipped.
- Empty cycle (no parties): plan cards at 0, a single muted line „Zatiaľ nie je čo
  distribuovať.“ in place of groups.

**Acceptance criteria:** with the UC-DP-003 fixture, four plan cards render with the counts
above; clicking `plan-card-loc<L>` leaves exactly one group visible; „Podľa stavu“ shows the
host under „Na zabalenie“ until packed; „Odovzdané“ filter hides every group but the handed
ones; no `neo/` class in the diff.

---

## UC-DP-011 Board rows — Zabalené → Odovzdané, item checklist, nested guests, Packeta detail (Admin)

**Goal:** every bag is one row with two ordered steps; the existing packing mechanics (per-item
checkboxes gating „Zabaliť“, guest folds, the pickup picker) survive inside it.

**Row structure (prototype columns „Kto · Doručenie / obsah · Platba · Krok 1 · Krok 2“;
`data-testid="bag-row-<friend.id>"`, guest rows `guest-row-<guest_orders.id>`):**

- **Kto:** name; badge „+{n} hostia“ on a host with nested guests (plural per `lib/plural.js`
  `colleaguesLabel`-style rule: „+1 hosť“ / „+2 hostia“ / „+5 hostí“); badge „hosť“ on a nested
  guest row; „hosť · {host}“ on a module-20 Packeta guest row; the existing „Bez vlastnej
  objednávky“ badge on a synthetic host.
- **Doručenie / obsah:** `packeta` → „{address} · {phone}“ (phone in the mono class; both
  needed on the bag and on the label); `pickup` → „{items} pol. · {kg} kg“; `in_person` → the
  `pickup_location_note` if any, else „{items} pol. · {kg} kg“; nested guest → „v balíku
  hostiteľa · {items} pol.“. The `PickupLocationPicker` stays on every friend/host row
  (props `cycleId` + `friendId`, never an order id; `print:hidden`; the two print badges
  `dist-pickup-badge-<friend.id>` and the Packeta badge `hidden print:inline-flex` exactly as
  shipped — `docs/learnings/06-pickup-point.md`). ⚠ After a pickup change the party's
  `delivery` may change group: patch `pickup_location_*` / `cleared_parcel` in place from
  `updated` as today, then **re-fetch the distribution payload** (loadSeq-guarded) so
  `delivery`, `plan` and the grouping come from `helpers/delivery.js` — never a client-side
  re-derivation (one home).
- **Platba:** „Zaplat.“ / „Nezapl.“ badges (existing paid semantics; a synthetic host shows
  none — the shipped „0 EUR non-order is not unpaid“ rule); `BalanceBadge` kept.
- **Krok 1 „Zabalené“** (`data-testid="packed-toggle-<friend.id>"`): the existing whole-order
  toggle (`PATCH /orders/:id/packed`), disabled until every item is checked (mirrors the 409)
  and disabled with `title="Najprv zrušte odovzdanie"` when handed over (UC-DP-007). A
  synthetic host has none (no `orders` row — shipped rule); their Krok 1 shows the derived
  stage read-only.
- **Krok 2 „Odovzdané“** (`data-testid="handover-toggle-<friend.id>"`): checkbox bound to
  `stage === 'handed'`; **disabled with `title="Najprv zabaliť"` until `stage` is `packed` or
  `handed`** (the prototype's `opacity .4`); checking → `PATCH /orders/:id/handed-over
  { handed_over: true }`; unchecking → `{ handed_over: false }`. For a **synthetic host** it
  calls the bulk route with `guest_order_ids` = all their live sub-order ids (one
  transaction; `false` is sent per guest via UC-DP-005 in sequence — the only per-guest
  reversal the board offers). Per-row pending state; a refused change snaps back and shows the
  server's message inline (`409 not_packed` → „Najprv označte balíček ako zabalený“).
- **Nested `via_host` guest rows:** Krok 1 = the guest's own derived stage (read-only
  checkbox — their items are checked in the checklist below); Krok 2 = a read-only checkbox
  mirroring the guest's OWN `handed_over_at` (`data-testid="handover-toggle-guest-<id>"`).
  `OPEN:` clickable per-guest Odovzdané on a nested guest — default **no** (prototype: guest
  checkboxes are not interactive; the API allows it for corrections, UC-DP-005 case c). When
  a host is handed over but ≥1 live guest is not (a UC-DP-005 correction), the host row shows
  a small „odovzdané okrem {n}“ note.
- **Row is expandable** (`OPEN:` — the prototype has no item list; default = click on the
  Kto/obsah cells toggles it): expanded, it renders the SHIPPED card body verbatim — „Vlastná
  objednávka“ block, one fold per guest with `guest-group-toggle-<id>` /
  `guest-group-items-<id>` / `guest-group-summary-<id>`, the per-item checkboxes with their
  `own:`/`guest:` pending keys, the „{checked}/{total} ✓“ counter. Rows start **expanded**
  while `stage = 'to_pack'` and collapsed otherwise (the admin packs to-pack bags; done bags
  are one line). Expansion state is local, keyed by party id, and survives in-place patches.
- Handed-over rows render dimmed (`done` state); the shipped `opacity-50` on packed cards
  moves to the row.

**Print (the shipped rules, restated for the new DOM — CLAUDE.md §Frontend):** every row
prints expanded and every guest fold prints (`hidden print:flex`, never `v-if`); pickers,
checkboxes, plan cards, toolbar, group actions and modals are `print:hidden`; the pickup and
Packeta badges are `hidden print:inline-flex`; the print-only item table („Pre · Produkt ·
Praženie · Varianta · Počet“) is kept per row; group headers print as text so the sheet is
sorted by drop. The print sheet is the CURRENT grouping and filter (what the admin sees is
what prints).

**Acceptance criteria:** Krok 2 is disabled on a `to_pack` row and enabled once „Zabalené“
succeeds; ticking it stamps the host and every nested guest (guest checkboxes flip without a
reload); un-ticking clears all; a synthetic host's Krok 2 hands over their guests via the bulk
route; under `emulateMedia({ media: 'print' })` a folded guest's items are visible and
`dist-pickup-badge-<id>` is visible while the picker is not (located by testid — the shipped
test idiom); the existing `guest-distribution.spec.js` UI describe passes with, at most,
selector retargets listed in UC-DP-015.

---

## UC-DP-012 Per-group bulk hand-over with confirm and toast (Admin)

**Goal:** „Odovzdať zabalené (n)“ — the moment the admin has dropped a whole group's bags
(the Packeta batch at the counter, the pickup-point visit) and records it once.

**Flow (prototype `confirm` modal, admin `Dialog` primitive):**

1. Click „Odovzdať zabalené ({ready})“ on a group → modal titled **„Odovzdať zabalené?“**,
   subtitle **„{group.title} · {ready} balíčkov prejde do stavu Odovzdané.“** (plural per
   `bagsLabel`), banner **„Hostia v balíku hostiteľa sa označia spolu s ním. Peniaze sa
   nemenia — účtovanie prebehlo pri zabalení.“**, buttons **„Zrušiť“** / **„Áno, odovzdané“**
   (`data-testid="handover-confirm"`). The prototype's second sentence about the WhatsApp
   message is module 21's (resolved conflict 3) — not rendered here.
2. Confirm → `POST /cycles/:id/distribution/hand-over` with `order_ids` = the group's
   `stage = 'packed'` parties that have an `order_id`, and `guest_order_ids` = the live
   sub-order ids of the group's `stage = 'packed'` synthetic hosts plus (module 20) the group's
   packed Packeta guests. Under „Podľa stavu“ the „Zabalené“ group's button hands over every
   packed bag of the cycle; under „Podľa priateľa“ the single group likewise.
3. **200** → patch rows from the payload (`handed_over`, `guests_inherited`), recompute plan
   cards from a re-fetch (loadSeq), toast **„{n} balíček odovzdaný“ / „{n} balíčky odovzdané“ /
   „{n} balíčkov odovzdaných“** for 3.5 s (`data-testid="handover-toast"`). The „· n správ
   zaradených na odoslanie (WhatsApp)“ half is module 21's.
4. **409 `not_packed`** → close the modal, re-fetch, show an inline Alert „Niektoré balíčky
   už nie sú zabalené — zoznam bol obnovený.“ and highlight the named rows.
5. The group button is pending-disabled for the duration; other rows stay interactive.

**Acceptance criteria:** a group with 2 packed + 1 to-pack shows „(2)“; confirming hands over
exactly those two and their guests; the toast says „2 balíčky odovzdané“; a stale snapshot
(un-pack one via API between open and confirm) yields the Alert and no row changes.

---

## UC-DP-013 `api.js` + `ADMIN_ENDPOINTS` + router wiring (system)

**Goal:** the plumbing the two UI UCs and the security sweep depend on.

**Business rules:**

- `frontend/src/api.js` (admin block, `X-Admin-Token`): `setOrderHandedOver(id, handedOver)`
  → `PATCH /orders/:id/handed-over`; `setGuestOrderHandedOver(id, handedOver)` →
  `PATCH /guest-orders/:id/handed-over`; `handOverDistribution(cycleId, { order_ids,
  guest_order_ids })` → `POST /cycles/:id/distribution/hand-over`. `getCycleDistribution`
  unchanged.
- **`ADMIN_ENDPOINTS` additions** (`e2e/tests/api-security.spec.js`, the standing CLAUDE.md
  rule): `GET /api/cycles/1/distribution` (missing today — UC-DP-003), `PATCH
  /api/orders/1/handed-over`, `PATCH /api/guest-orders/1/handed-over`, `POST
  /api/cycles/1/distribution/hand-over`. ⚠ `/api/guest-orders` is a MIXED mount: only the
  admin routes join; the host routes stay in `FRIEND_IDENTITY_ENDPOINTS`.
- No new public route ⇒ nothing joins the `self-hosted-fonts.spec.js` zero-external-requests
  sweep; no CSP change.
- Server length/array bounds (≤ 500 ids) are the only new bounds; no new `maxlength`.

**Acceptance criteria:** the four routes answer 401 to anonymous and friend-Bearer callers
in the sweep; the SPA route `/admin/cycle/:id/distribution` is unchanged
(`colleagues-panel.spec.js:855` keeps passing).

---

## UC-DP-014 Admin cycle header — plan line + manual „Ukončiť“ (Admin)

**Goal:** the admin sees the plan without opening the board, and completes the round by hand
when everything is out (roadmap §11 „Admin cycle header“, §16 Q8.c: NO auto-complete).

**Business rules (`CycleDetail.vue` header):**

- When `cycle.status` is `locked` or `completed`, fetch `GET /cycles/:id/distribution`
  **non-blocking** (the `loadGuestUnpaid` precedent, loadSeq-guarded; a failure hides the line
  and never blocks the tab) and render **one plan line** under the title: „{label} {count}“
  joined by „ · “ in plan order, e.g. „Packeta 3 · Kaviareň Ruža 5 · Coworking Nivy 2 · Osobne
  4“, followed by „ — {handed}/{total} odovzdaných“ (`data-testid="cycle-plan-line"`).
  Zero-count targets are omitted from this line (it is a summary, unlike the cards).
- The existing „Označiť ako dokončený“ button (CycleDetail.vue ~:1432, `markCompleted()` →
  `PATCH /cycles/:id { status: 'completed' }`) is **relabelled „Ukončiť objednávku“**
  (`OPEN:` exact admin label — default the prototype's; „Ukončiť cyklus“ acceptable per the
  glossary's admin exemption) and gains the gate: **enabled only when `totals.count > 0` and
  `totals.handed_count === totals.count`**; otherwise disabled with `title="Až keď je všetko
  odovzdané"` (prototype). The same button with the same gate sits in the board header
  (UC-DP-010 item 1). Clicking it is the ONLY way a cycle becomes `completed` — no hand-over
  path ever writes `status`.
- ⚠ The gate is **UX-only**: `PATCH /cycles/:id` keeps accepting `status: 'completed'`
  regardless of hand-over (an API escape hatch for a bag that will never be collected).
  `OPEN:` should the server refuse completion with un-handed bags (409)? Default **no** —
  recorded here so the implementer does not add it silently.
- The „Distribúcia“ header button is unchanged.

**Acceptance criteria:** a locked cycle with 5 parties and 3 handed shows the plan line and a
disabled „Ukončiť objednávku“; after the last two hand-overs the button enables; clicking it
sets `status = 'completed'` and the plan line persists on the completed cycle; the API still
accepts `completed` with un-handed bags.

---

## UC-DP-015 Verification — e2e obligations (system)

**Goal:** what the new spec files must pin, and which shipped assertions may move. Same bar as
every module: Playwright in `e2e/`, no unit runner, `node --check` on changed backend files.

**1. `api-security.spec.js` — `ADMIN_ENDPOINTS` +=** the four routes of UC-DP-013.

**2. New `e2e/tests/distribution-handover.spec.js` (API; fixtures per test):**

- **409 `not_packed`** on an unpacked order, an item-incomplete guest, and inside the bulk
  route (all-or-nothing, offenders named) — every refusal **reads the row back**.
- **Ledger neutrality** across hand-over, reversal and bulk: the `MAX(id)`-watermark idiom of
  `guest-distribution.spec.js` filtered to the friend id and the order/guest ids — never a
  global count.
- **Inheritance:** host hand-over stamps every live guest with the identical timestamp,
  skips the cancelled one, leaves `delivered` untouched; reversal clears them all; a per-guest
  PATCH leaves the host alone.
- **Idempotency:** repeat `true` keeps the original timestamp; repeat bulk reports
  `already_handed`.
- **No cycle gate:** hand-over works on `locked` AND on `completed` (asserted so nobody
  „fixes“ it into a 409 — the pickup-edit lesson).
- **UC-DP-007 gate:** un-pack / item uncheck / guest item uncheck on a handed-over bag ⇒ 409
  `handed_over`, rows unchanged; after reversal the un-pack posts exactly one reversal row.
- **Outbox contract (UC-DP-008):** row counts and columns per case in its acceptance
  criteria; dedupe; dequeue on reversal leaves a hand-inserted `sent` row; every row
  `status = 'queued'`, `body IS NULL`. Uses `node:sqlite` on `DB_PATH` (self-skips without it,
  the documented skip) — and remember its constraint error codes differ from better-sqlite3's.
- **Bodies:** `{}`, `true`, `[3]`, `'abc'`, `{ handed_over: 'yes' }` ⇒ 400, never 500; ids from
  another cycle ⇒ 400 `foreign_id`.
- **Payload (UC-DP-003):** `plan`, `totals`, `stage`, `delivery.type/target_key` per the
  fixture; `guest_orders[].handed_over_at` present via `GUEST_ORDER_FIELDS` (also on
  `GET /guest-links/cycle/:id` for the host — presence pin, it is not a credential).
- **Stub seam:** `cycle_stage: null` in the response while module 17 is absent.

**3. New `e2e/tests/distribution-board.spec.js` (UI, admin token adopted from the browser):**
plan-card counts and focus; the three group-bys and the four filters; Krok 2 disabled →
enabled → ticks host + nested guests; snap-back on a forced 409; per-group confirm + toast
copy; the synthetic host's Krok 2 through the bulk route; the print assertions of UC-DP-011
(`emulateMedia`, badge by **testid**); `cycle-plan-line` and the „Ukončiť objednávku“ gate on
CycleDetail; a whole-document check that no `neo/` class name appears on the admin route.

**4. Shipped specs — expected to pass UNMODIFIED:** `guest-distribution.spec.js` (API
describes; the UI describe relies on `guest-group-toggle/items/summary-<id>` and the item
rows, which UC-DP-011 preserves inside the expanded row — the row must be expanded by default
for `to_pack` bags precisely so these tests need no click), `item-packed.spec.js`,
`order-pickup-edit.spec.js` (both surfaces, `dist-pickup-*` testids kept),
`colleagues-panel.spec.js:855`. Case (a) retargets are allowed ONLY if a selector in
`guest-distribution.spec.js` depends on the old card layout (e.g. `Card` per friend); each
edit cites UC-DP-011 in a comment and keeps the asserted property.

**5. Procedure:** targeted files first (`distribution-handover`, `distribution-board`,
`guest-distribution`, `item-packed`, `order-pickup-edit`, `api-security`), `--workers=1`, all
five `RATE_LIMIT_*_MAX` raised, output to a file, `EXIT:` checked; full suite only at the
module milestone (project memory: e2e gate frequency).

---

## Open items (for the orchestrator / PO)

- `OPEN:` **Board layout** — default = prototype `ADist` as drawn, in the admin shadcn skin.
- `OPEN:` **Expandable rows** — the prototype has no item checklist; default = click-to-expand
  row holding the shipped card body, expanded by default while `to_pack`.
- `OPEN:` **Clickable Odovzdané on a nested `via_host` guest** — default no (read-only
  mirror); the API allows the correction.
- `OPEN:` **„Ukončiť“ label** — default „Ukončiť objednávku“ (prototype); admin may keep
  „cyklus“.
- `OPEN:` **Server-side completion gate** — default none (UX gate only; API escape hatch kept).
- `OPEN:` **„Štítky“ / „Vytlačiť štítky“ target** — the labels feature is built elsewhere;
  its entry route is an open dependency (client-supplied).
- Phase 2, named so it is not built silently: bulk **reversal**; per-location „N dní“ copy
  (dropped by PO, not Phase 2); friend/guest visibility of `handed_over_at` (modules 17/18).

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Board layout** = prototype `ADist` as drawn, in the current admin skin.
- **Rows**: item checklist EXPANDED while the bag is „Na zabalenie“; packed and handed-over bags collapse to one line, click to expand.
- **Clickable „Odovzdané“ on a nested `via_host` guest** = NO (read-only inherited state; API still permits per-row PATCH).
- **„Ukončiť“ label** = „Ukončiť objednávku“.
- **Server-side completion gate** = NONE (UX gate only; API completes on request — escape hatch for a bag that will never be handed over).
- **„Štítky“ / „Vytlačiť štítky“ target** = wired to a placeholder route constant; PO supplies the labels feature's route later.
