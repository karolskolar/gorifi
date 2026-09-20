import db from '../db/schema.js';
import { deliveryOf } from './delivery.js';
import { pickupTargetFor } from './pickup.js';

// ⚠ THE ONE HOME for module 16's STAGE VOCABULARY and for the two resolutions the
// hand-over writers share (DP-T3, 16 §UC-DP-004/005; the bulk route of §UC-DP-006
// is DP-T4's and uses exactly these).
//
// Three callers need the same answers and must never disagree:
//   • `GET /cycles/:id/distribution` (routes/cycles.js, DP-T2) — the board's read
//   • `PATCH /orders/:id/handed-over` (routes/orders.js)        — the friend write
//   • `PATCH /guest-orders/:id/handed-over`                     — the guest write
// A mutation response that computed „handed" by its own rule would let the row the
// board patches in place disagree with the row a reload fetches, which is the
// GSO-T6/T8 class of bug applied to a stage badge.
//
// ⚠ NOTHING HERE WRITES. `helpers/pickup.js` stays the SOLE WRITER of the pickup /
// Packeta / fee columns and the sole decider of WHICH ROW stores a party's pickup;
// `helpers/delivery.js` stays read-only and takes ROWS, not ids. This module is the
// small composition of the two that the routes need — "give me the delivery of the
// party (cycle, friend)" — and it exists here precisely so `delivery.js` does not
// have to learn about `pickupTargetFor` (which its own e2e pin forbids by name).
//
// ⚠ Every function is SYNCHRONOUS and safe to call inside a `db.transaction()`.
// An `await` in a hand-over handler would break the check-then-write atomicity the
// whole app rests on under `instances: 1` (CLAUDE.md, GA-T8).

// The three stages of a bag are `to_pack` → `packed` → `handed`, and `handed`
// implies `packed`. They are deliberately NOT exported as a list: nothing needs one
// yet, and a constant with no consumer is a contract nobody is checking. DP-T5's
// board filter tabs are the first caller that will want it.

/**
 * A friend bag's stage, read off its `orders` row. `handed` wins over `packed`
 * because it implies it, and the `packed` column is the one the LEDGER moment
 * writes (`helpers/packing.js`) — never re-derived from the item rows here.
 */
export function orderStage(row) {
  if (row && row.handed_over_at) return 'handed';
  return row && row.packed ? 'packed' : 'to_pack';
}

/**
 * A guest sub-order's stage. Its own `handed_over_at` wins; otherwise it is packed
 * only when it HAS items and every one of them is checked off — an empty bag is
 * `to_pack`, not a free pass (`[].every()` is `true`, which is exactly the bug the
 * length test prevents; the same shape as the pack gate's `total > 0`).
 */
export function guestOrderStage(subOrder) {
  if (subOrder && subOrder.handed_over_at) return 'handed';
  const items = Array.isArray(subOrder?.items) ? subOrder.items : [];
  return items.length > 0 && items.every((item) => !!item.packed) ? 'packed' : 'to_pack';
}

/**
 * Bind `{ handed_over: <boolean> }` out of a request body, or `undefined`.
 *
 * ⚠ AN EXPLICIT BOOLEAN IS REQUIRED — deliberately unlike the host's `delivered`
 * toggle, which treats an absent field as "flip it" (§UC-DP-004). A hand-over
 * fires notifications, so the intent has to be stated; and "absent means toggle"
 * on a route with a 409 gate turns a malformed body into a real state change.
 *
 * Unbindable shapes are refused rather than coerced: `{}` (no field), `true` and
 * `'abc'` (not an object — body-parser's `strict` mode usually refuses these
 * first, but this does not RELY on that), `[id]` — ⚠ the one-element array is the
 * trap, because it spreads into a single-slot statement and reads as a value —
 * and any non-boolean value (`'true'`, `1`, `null`). An inherited property is not
 * data (the `variantGrams()` discipline).
 */
export function readHandedOverFlag(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, 'handed_over')) return undefined;
  const value = body.handed_over;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * The delivery of the PARTY (cycle, friend) — Packeta, a pickup point or in person.
 *
 * Asks `helpers/pickup.js` which row stores this party's pickup (their `orders` row
 * when one exists at ANY status, else their `guest_order_links` row) and hands that
 * row to `helpers/delivery.js` to be NAMED. Both halves stay where they live; this
 * is only the join, and it is what lets a host with NO own order still classify —
 * the §UC-DP-005 case (b) party, whose pickup lives on the link.
 *
 * ⚠ IT RE-RESOLVES FROM (cycle, friend), NEVER FROM THE ROW THE CALLER IS HOLDING,
 * and that is REQUIRED rather than tidy. A guest route holds a `guest_orders` row,
 * which carries no pickup at all; a host with no own `orders` row has their pickup
 * on the link, which no order-shaped row in hand would show. Classifying whatever
 * row happened to be loaded would file such a party under „Osobne" and send their
 * colleagues the wrong message. Going through the single home costs one indexed
 * lookup and cannot get that wrong.
 */
export function partyDelivery(cycleId, friendId, locationsById) {
  const target = pickupTargetFor(cycleId, friendId);
  return deliveryOf(target ? target.row : null, { locationsById });
}

/**
 * The LIVE guest sub-orders of one host in one cycle that travel INSIDE that host's
 * bag — the set a friend hand-over stamps, and the set its reversal clears.
 *
 * Two filters, and neither is a hand-written re-statement of a rule that lives
 * elsewhere:
 *   • `COALESCE(status,'submitted') <> 'cancelled'` — the standing predicate
 *     (helpers/stock.js, packingItemStats): a called-off bag is not handed to
 *     anybody, and its item rows survive the cancel, so the status IS the filter.
 *   • `delivery.type === 'via_host'` — asked of `helpers/delivery.js` rather than
 *     written as SQL. ⚠ THIS IS THE MODULE-20 PACKETA EXCLUSION (§UC-DP-004): a
 *     guest with their own `packeta_address` is their OWN party and is never
 *     inherited in either direction. Expressing it as `COALESCE(packeta_address,'')
 *     = ''` would not even parse today (the column arrives with module 20) and
 *     would be a second home for the classification when it did. Asking the
 *     classifier is a no-op by construction now and correct the day GP-T6 lands,
 *     with nothing to change here.
 */
export function inheritingGuests(hostFriendId, cycleId, hostDelivery) {
  const rows = db.prepare(`
    SELECT gord.id, gord.link_id, gord.status, gord.handed_over_at
      FROM guest_orders gord
      JOIN guest_order_links glink ON glink.id = gord.link_id
     WHERE glink.host_friend_id = ? AND glink.cycle_id = ?
       AND COALESCE(gord.status, 'submitted') <> 'cancelled'
     ORDER BY gord.id
  `).all(hostFriendId, cycleId);

  const inheriting = [];
  for (const row of rows) {
    // `link_id` is selected on purpose: it is what tells `deliveryOf` this is a
    // GUEST row, which is what makes the classification fail CLOSED to `via_host`
    // rather than to a standalone bag.
    const delivery = deliveryOf(row, { host: hostDelivery });
    if (delivery.type === 'via_host') inheriting.push({ ...row, delivery });
  }
  return inheriting;
}
