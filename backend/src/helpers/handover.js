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

// The per-array cap of the bulk route (§UC-DP-006). A group on the board is a
// pickup point's worth of bags, so 500 is far above anything real and low enough
// that a malicious body cannot make the server walk a million ids inside a
// transaction that blocks every other request (`instances: 1`).
export const HAND_OVER_BATCH_MAX = 500;

/**
 * One id LIST out of a bulk body, or `undefined` for anything unusable.
 *
 * The field is REQUIRED even when empty — `{ order_ids: [], guest_order_ids: [3] }`
 * is the guest-only batch of a host with no own order, and leaving the array out
 * has to be refused rather than read as „none", so a typo in a field name cannot
 * silently hand over half of what the admin confirmed.
 *
 * ⚠ WHAT THE TRAP IS FOR **THIS** SHAPE. On the per-bag routes the one-element
 * array is the trap (`[id]` spreads into a single-slot statement and reads as a
 * value). Here a one-element array is the NORMAL input — a batch of one bag — so
 * the trap moves inside it: an ELEMENT that is not an integer. `'7'`, `7.5`,
 * `true`, `null`, `[7]` and `{}` all reach a bind slot, and `'7'` would even
 * COMPARE correctly against an INTEGER column through SQLite's affinity rules —
 * so the refusal has to be made on the type, not discovered at the binder. One
 * bad element poisons the whole list: a batch is all-or-nothing, and „we ignored
 * the ids we could not read" is exactly the partial success this route exists to
 * prevent.
 */
function readIdList(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return undefined;
  const value = body[field];
  if (!Array.isArray(value)) return undefined;
  if (value.length > HAND_OVER_BATCH_MAX) return undefined;

  // Deduplicated, ORDER PRESERVED: the same id twice is a UI double-click, not a
  // reason to refuse, and it must not be counted twice in the response either.
  const ids = new Set();
  for (const element of value) {
    if (typeof element !== 'number' || !Number.isInteger(element) || element <= 0) return undefined;
    ids.add(element);
  }
  return [...ids];
}

/**
 * Bind `{ order_ids: int[], guest_order_ids: int[] }` out of a bulk request body,
 * or `undefined` (§UC-DP-006).
 *
 * Both arrays are required, every element is a positive integer, each array holds
 * at most `HAND_OVER_BATCH_MAX`, and AT LEAST ONE id overall — an empty batch is a
 * button that should not have been clickable, and answering 200 `handed_over: 0`
 * to it would tell the admin a group went out when nothing did.
 *
 * Non-objects (`true`, `'abc'`, `null`) and a bare ARRAY body are refused here
 * rather than relied upon to die in body-parser's strict mode, exactly as
 * `readHandedOverFlag()` does.
 */
export function readHandOverBatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const orderIds = readIdList(body, 'order_ids');
  const guestOrderIds = readIdList(body, 'guest_order_ids');
  if (!orderIds || !guestOrderIds) return undefined;
  if (orderIds.length + guestOrderIds.length === 0) return undefined;
  return { orderIds, guestOrderIds };
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
 *     = ''` would be a second home for the classification. ~~Asking the classifier
 *     is a no-op by construction now and correct the day GP-T6 lands, with nothing
 *     to change here.~~ **GP-T6 (20 §UC-GP-010) FOUND THAT FALSE**: the classifier
 *     can only see what it is HANDED, and this SELECT did not hand it the column —
 *     so every guest classified `via_host` and a Packeta guest WAS inherited (stamped
 *     with the host's hand-over and enqueued an „odovzdané priateľovi" message) once
 *     module 20 shipped the column. `gord.packeta_address` is selected below for
 *     exactly that reason; pinned by `guest-packeta.spec.js` GP-T6 (per bag + bulk).
 *     A seam "correct with nothing to change" still needs its INPUT to exist.
 */
export function inheritingGuests(hostFriendId, cycleId, hostDelivery) {
  const rows = db.prepare(`
    SELECT gord.id, gord.link_id, gord.status, gord.handed_over_at, gord.packeta_address
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
