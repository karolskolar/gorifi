# Voucher System Design

## Purpose

Allow admin to return extra supplier discount margin to selected friends as redeemable credit vouchers. Friends must accept (credit added to balance) or decline (donate back to project) before they can place new orders.

## Business Context

- Supplier discount tiers: 5–25kg → 30%, 26–50kg → 35%, >50kg → 40%
- Friends already pay prices based on one discount tier (e.g., 30% off retail)
- When the actual supplier discount is higher (e.g., 35%), the extra margin (5%) can be returned to friends
- Voucher amount = (discount_received - discount_applied) × retail_price_of_friend_order
- Retail price derived as: `order_total / (1 - discount_applied)`

Example: Friend paid 45€ (at 30% off retail). Retail = 45 / 0.70 = 64.29€. Extra 5% voucher = 64.29 × 0.05 = 3.21€.

## Data Model

### New `vouchers` table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `friend_id` | INTEGER FK | References friends.id |
| `source_cycle_id` | INTEGER FK | Cycle the discount is based on |
| `supplier_discount` | REAL | Discount actually received from supplier, stored as percentage (e.g., 35) |
| `applied_discount` | REAL | Discount already applied to friend prices, stored as percentage (e.g., 30) |
| `order_total` | REAL | Friend's order total in that cycle |
| `retail_total` | REAL | Calculated: order_total / (1 - applied_discount) |
| `voucher_amount` | REAL | Calculated: retail_total × (supplier_discount - applied_discount) |
| `status` | TEXT | 'pending' / 'accepted' / 'declined' |
| `transaction_id` | INTEGER FK | References transactions.id (set when accepted, NULL otherwise) |
| `created_at` | DATETIME | When admin created the voucher |
| `resolved_at` | DATETIME | When friend accepted/declined |

Constraints:
- One pending voucher per friend per source cycle (UNIQUE on friend_id + source_cycle_id where status = 'pending')
- `voucher_amount` rounded to 2 decimal places

## API Endpoints

### Admin endpoints (no server-side auth, per project convention)

**POST /api/vouchers/generate**

Creates vouchers for selected friends from a given cycle.

Request body:
```json
{
  "source_cycle_id": 5,
  "supplier_discount": 35,
  "applied_discount": 30,
  "friend_ids": [1, 3, 7]
}
```

Backend calculates for each friend:
1. Fetch their submitted order total for the source cycle
2. Calculate retail_total = order_total / (1 - applied_discount/100)
3. Calculate voucher_amount = retail_total × (supplier_discount - applied_discount) / 100
4. Insert voucher row with status 'pending'

Returns: created voucher objects with calculated amounts.

Validation:
- All friend_ids must have a submitted order in the source cycle
- No duplicate pending vouchers for same friend + cycle
- supplier_discount must be > applied_discount

**GET /api/vouchers**

List all vouchers. Supports optional query params: `?status=pending`, `?source_cycle_id=5`.

Returns: voucher objects joined with friend name and cycle name.

### Friend endpoints (authenticated via session token)

**GET /api/vouchers/pending**

Returns pending vouchers for the authenticated friend. Empty array if none.

**POST /api/vouchers/:id/resolve**

Accept or decline a voucher.

Request body:
```json
{
  "action": "accept"
}
```

Actions:
- `accept`: Creates an `adjustment` transaction with +voucher_amount and note "Voucher z cyklu {cycle_name}". Sets voucher status to 'accepted', stores transaction_id, sets resolved_at.
- `decline`: Sets voucher status to 'declined', sets resolved_at. No transaction created.

Validation:
- Voucher must belong to authenticated friend
- Voucher must be in 'pending' status

## Frontend: Friend Voucher Gate

### Location: FriendPortal.vue

On mount (after auth check), call `GET /api/vouchers/pending`. If the response contains one or more pending vouchers, show a full-screen modal overlay that blocks all interaction with the cycle list.

### Modal content

- Gift icon and "Máš voucher!" heading
- Reference to source cycle name
- "Hodnota voucheru je X% z tvojej objednávky" with the calculated amount in large text
- Two buttons:
  - Primary (green): "Použiť ako kredit na ďalšiu objednávku" → calls resolve with action 'accept'
  - Secondary (outline): "Nepotrebujem — podporím projekt" → calls resolve with action 'decline'
- Footer note: "Toto rozhodnutie je jednorazové a nedá sa zmeniť."

### After resolution

- Accept: Green banner "Kredit X.XX € pridaný — Bude odpočítaný z tvojej ďalšej objednávky"
- Decline: Thank-you banner "Ďakujeme za podporu! Tvoj voucher X.XX € bol venovaný projektu"
- Banner shown briefly, then normal cycle list accessible

### Multiple vouchers

If a friend has multiple pending vouchers (unlikely but possible), show them one at a time. Each must be resolved before showing the next.

## Frontend: Admin Voucher Management

### Location: New admin page, accessible from sidebar

### Create flow (3 steps in one page)

**Step 1 — Cycle & Discounts:**
- Dropdown: select source cycle (completed/locked cycles with orders)
- Two number inputs: "Zľava od dodávateľa" (%) and "Zľava aplikovaná priateľom" (%)
- Calculated display: "Extra zľava na vrátenie: X%"

**Step 2 — Select Friends:**
- List of friends who have submitted orders in the selected cycle
- Each row: friend name, order total, calculated voucher amount
- Checkbox selection with "Vybrať všetkých" toggle
- Footer: selected count and total voucher amount
- "Vytvoriť vouchery" button

**Step 3 — Confirmation:**
- Success message with count of created vouchers

### Voucher list (optional, secondary)

Simple table showing all vouchers: friend, cycle, amount, status, resolved date. Useful for admin to track who accepted/declined.

## Route Structure

- Backend: `backend/src/routes/vouchers.js` — all voucher endpoints
- Frontend: `/admin/vouchers` — admin voucher management page
- No new route for friend side — modal is part of FriendPortal.vue

## Migration

Standard try/catch ALTER TABLE pattern not needed — this is a new table. Add CREATE TABLE to schema.js.

## Edge Cases

- Friend has no order in selected cycle: excluded from friend picker (backend validates too)
- Admin tries to create duplicate voucher for same friend+cycle: backend rejects
- Friend's session expires while viewing modal: re-auth required, modal shown again on next login (voucher still pending)
- Multiple pending vouchers: resolved one at a time, sequentially
