# Packeta Parcel Delivery Feature — Design Spec

**Date:** 2026-05-01

## Overview

Add optional Packeta parcel delivery as an alternative to admin-managed pickup locations. Friends can choose to have their coffee order shipped to a Packeta pickup point instead of collecting it at one of the predefined locations. Parcel delivery adds a configurable fee to the order.

## Scope

- Per-cycle parcel configuration (enabled/disabled + fee amount)
- Friend profile: default Packeta address stored on friend record
- Order submit flow: unified modal with pickup vs. Packeta choice
- Order storage: delivery fee as separate field (not an order_item)
- Admin views: red "Packeta" badge in Orders tab and Distribution view

## Data Model Changes

### `friends` table — new column

```sql
ALTER TABLE friends ADD COLUMN packeta_address TEXT;
```

Stores the friend's default Packeta pickup point address. Set via the existing "Upraviť profil" modal. Nullable — not required.

### `order_cycles` table — new columns

```sql
ALTER TABLE order_cycles ADD COLUMN parcel_enabled INTEGER DEFAULT 0;
ALTER TABLE order_cycles ADD COLUMN parcel_fee REAL DEFAULT 0;
```

- `parcel_enabled`: 0 = parcel delivery not available for this cycle, 1 = available
- `parcel_fee`: delivery fee in EUR added to the order when friend selects Packeta (e.g., 3.50)

Both set by admin when creating/editing a cycle, similar to `markup_ratio`.

### `orders` table — new columns

```sql
ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN packeta_address TEXT;
```

- `delivery_fee`: the parcel fee charged for this order (copied from cycle's `parcel_fee` at submit time). 0 if not using parcel delivery.
- `packeta_address`: the specific Packeta pickup point address chosen for this order. NULL if not using parcel delivery.

The order `total` field continues to represent product total only. The full amount the friend pays = `total + delivery_fee`. This keeps existing analytics and product calculations unaffected.

## Friend Profile — "Upraviť profil" Modal

**File:** `frontend/src/views/FriendPortal.vue`

Add a new field below the existing "Prihlasovacie meno" section:

```
Adresa Packeta výdajného miesta
[________________________________]
Adresa výdajného miesta pre doručenie Packetou (voliteľné)
```

- Label: "Adresa Packeta výdajného miesta"
- Placeholder: "napr. Z-BOX Hlavná 15, Bratislava"
- Helper text: "Adresa výdajného miesta pre doručenie Packetou (voliteľné)"
- Saved via the existing `PATCH /friends/:id/profile` endpoint (extend to accept `packeta_address`)

## Friend Order Submit Flow

**File:** `frontend/src/views/FriendOrder.vue`

### Decision logic on submit

When the friend clicks submit:

1. **No pickup locations AND parcel not enabled** → submit directly (no modal)
2. **Pickup locations exist but parcel not enabled** → existing pickup location modal (unchanged)
3. **No pickup locations but parcel enabled** → show delivery modal with Packeta option pre-selected + a "Bez doručenia (vyzdvihnem osobne)" radio option that submits without pickup or parcel
4. **Both pickup locations and parcel enabled** → show unified delivery modal with both sections

### Unified Delivery Modal

A single modal with two radio-button sections at the top:

```
┌─────────────────────────────────────────┐
│  Spôsob prevzatia                       │
│                                         │
│  ○ Osobný odber                         │
│  ○ Doručenie Packetou (+3.50 EUR)       │
│                                         │
│  ─── when "Osobný odber" selected ───   │
│                                         │
│  ○ Nešička                              │
│    Adresa nešičky...                    │
│  ○ Janka doma                           │
│    Jankina adresa...                    │
│  ○ Iné                                  │
│    [poznámka input]                     │
│                                         │
│  ─── when "Doručenie Packetou" ───      │
│                                         │
│  Adresa výdajného miesta *              │
│  [pre-filled from profile___________]   │
│  □ Uložiť ako predvolenú adresu        │
│                                         │
│  [Zrušiť]          [Potvrdiť a odoslať] │
└─────────────────────────────────────────┘
```

**Behavior:**
- Top-level choice: "Osobný odber" vs "Doručenie Packetou (+X.XX EUR)"
- Fee amount shown inline from `cycle.parcel_fee`
- When "Osobný odber" selected: show existing pickup location radio buttons + "Iné"
- When "Doručenie Packetou" selected: show address input, pre-filled from `friend.packeta_address`
- "Uložiť ako predvolenú adresu" checkbox — if checked, updates the friend's `packeta_address` profile field on submit
- Address is required when Packeta is selected — "Potvrdiť a odoslať" disabled without it
- If only Packeta is available (no pickup locations), skip the radio choice and show Packeta section directly, with a "Bez doručenia (vyzdvihnem osobne)" link/option below

### Submit payload changes

`POST /orders/cycle/:cycleId/friend/:friendId/submit` — extend body:

```json
{
  "pickup_location_id": null,
  "pickup_location_note": null,
  "packeta_address": "Z-BOX Hlavná 15, Bratislava",
  "use_parcel_delivery": true
}
```

When `use_parcel_delivery` is true:
- Backend sets `orders.delivery_fee = cycle.parcel_fee`
- Backend sets `orders.packeta_address` to the provided address
- Backend clears `pickup_location_id` and `pickup_location_note`

When `use_parcel_delivery` is false (or absent):
- Backend sets `delivery_fee = 0`, `packeta_address = NULL`
- Existing pickup location logic applies unchanged

## Admin — Cycle Configuration

**File:** `frontend/src/views/CycleDetail.vue`

Add parcel delivery settings in the cycle edit area, near the existing `markup_ratio` control:

```
Doručenie Packetou
[toggle switch]  Povoliť doručenie Packetou

Cena doručenia (EUR)
[3.50_____________]
```

- Toggle enables/disables `parcel_enabled`
- Fee input only shown when toggle is on
- Saved via the existing cycle update endpoint (`PATCH /cycles/:id`)

## Admin — Orders Tab (CycleDetail)

**File:** `frontend/src/views/CycleDetail.vue`

In the orders table, orders with Packeta delivery show:
- Red badge "Packeta" in the same position as the blue pickup location badges
- CSS: `bg-red-100 text-red-800` (vs existing `bg-blue-100 text-blue-800` for pickup locations)
- Order sum column shows the total including delivery fee

The cycle summary row ("Celkom") should show total delivery fees if any exist.

## Admin — Distribution View

**File:** `frontend/src/views/Distribution.vue`

For orders with Packeta delivery:
- Red "Packeta" badge shown alongside existing pickup location badges
- Below the friend's order header row (where name, balance, status are shown), add a row showing the full Packeta address in smaller/muted text
- Example: `📦 Z-BOX Hlavná 15, Bratislava`

## Backend API Changes

### `PATCH /friends/:id/profile`

Extend to accept `packeta_address`:

```js
const { name, packeta_address } = req.body;
// ... existing name logic ...
if (packeta_address !== undefined) {
  db.prepare('UPDATE friends SET packeta_address = ? WHERE id = ?')
    .run(packeta_address?.trim() || null, friendId);
}
```

### `GET /friends/:id` and friends list endpoints

Include `packeta_address` in the response for friend data.

### `POST /orders/cycle/:cycleId/friend/:friendId/submit`

Extend to handle parcel delivery:

```js
const { pickup_location_id, pickup_location_note, use_parcel_delivery, packeta_address } = req.body;

if (use_parcel_delivery) {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle.parcel_enabled) {
    return res.status(400).json({ error: 'Doručenie Packetou nie je pre tento cyklus dostupné' });
  }
  if (!packeta_address?.trim()) {
    return res.status(400).json({ error: 'Adresa výdajného miesta je povinná' });
  }
  // Set delivery fields, clear pickup fields
  db.prepare(`UPDATE orders SET
    delivery_fee = ?, packeta_address = ?,
    pickup_location_id = NULL, pickup_location_note = NULL
    WHERE id = ?`).run(cycle.parcel_fee, packeta_address.trim(), orderId);
} else {
  // Clear delivery fields, apply pickup logic (existing)
  db.prepare('UPDATE orders SET delivery_fee = 0, packeta_address = NULL WHERE id = ?').run(orderId);
  // ... existing pickup_location logic ...
}
```

### `PATCH /friends/:id/profile` — save packeta_address from modal

When the "Uložiť ako predvolenú adresu" checkbox is checked during order submit, the frontend makes an additional `PATCH /friends/:id/profile` call with `{ packeta_address }`.

### Cycle endpoints

`GET /cycles/:id` and `POST /cycles` / `PATCH /cycles/:id` — include `parcel_enabled` and `parcel_fee` in responses and accept them in request bodies.

### Orders list endpoints

All endpoints returning order data should include `delivery_fee` and `packeta_address` fields. The cycle detail endpoint (`GET /cycles/:id`) already joins order data — extend it to include the new columns.

## Edge Cases

- **Friend switches from Packeta to pickup (or vice versa) when updating a submitted order:** The modal pre-selects based on current order state. If `order.packeta_address` is set, pre-select "Doručenie Packetou" and show the address. Otherwise pre-select "Osobný odber" and show pickup locations.
- **Parcel disabled after friend already submitted with Packeta:** The order retains its `delivery_fee` and `packeta_address`. If the friend updates the order while parcel is now disabled, the Packeta option won't appear and they must choose a pickup location (delivery fee gets cleared).
- **Cycle parcel_fee changes after orders submitted:** Existing orders keep their original `delivery_fee`. Only new submits/updates pick up the current fee.
- **Empty packeta_address in profile:** The address field in the modal is simply empty — friend must type it. No error, just an empty input.

## What Is NOT In Scope

- Packeta API integration (pickup point search, validation) — address is free text
- Tracking numbers or shipment status
- Different parcel services (only Packeta)
- Parcel delivery for bakery cycles (could be enabled later by simply setting `parcel_enabled` on a bakery cycle — the data model supports it, but the UI won't actively surface it for bakery)
