import db from '../db/schema.js';
import { bindValue } from './bind-value.js';

// ⚠ THE ONE HOME for "where does this party pick up, and where is that stored".
//
// PO decision, 2026-09-03: the admin must be able to set a pickup point for EVERY
// party on the orders tab, "za každých okolností". The reported hole was a host who
// ordered nothing themselves while their unregistered colleague did — they are still
// the pickup party (they collect the bags) but they have NO `orders` row, so there
// was literally no column to write.
//
// So a party's pickup has TWO possible stores, and this module is the only place that
// chooses between them:
//
//   1. `orders` (the friend's own row for this cycle) — ANY status, draft included.
//   2. `guest_order_links` (their share link for this cycle) — the fallback used
//      when there is no `orders` row at all. One row per (host, cycle), and it always
//      exists whenever guest bags do (`guest_orders.link_id` points at it).
//
// ⚠ WHY THE CHOICE MUST LIVE IN ONE PLACE, and not per surface. The admin orders tab
// lists a party when they have an order OR guest bags; the Distribution sheet builds
// its synthetic rows from `o.status = 'submitted'`, so a host sitting on a DRAFT own
// order lands in its no-own-order branch. Two surfaces, two different notions of
// "has an own order" — and a per-surface choice of store would have had the same
// party's pickup written to `orders` on one screen and to the link on the other, each
// screen then reading back its own half. `pickupTargetFor()` answers "does an
// `orders` row exist", which is a fact about the database and not about the caller.
//
// ⚠ NOTHING HERE TOUCHES MONEY except the Packeta clearance below, which is
// explicitly asked for and provably ledger-neutral (see `applyPickup`).

/**
 * The row a party's pickup is stored on, or null when there is nowhere to put one
 * (a friend who neither ordered nor ever shared a link — such a party is not even
 * listed on the orders tab).
 */
export function pickupTargetFor(cycleId, friendId) {
  // ⚠ NO status filter. A draft has an `orders` row, and that row is where its
  // pickup belongs — see the two-surfaces note above.
  const order = db.prepare('SELECT * FROM orders WHERE cycle_id = ? AND friend_id = ?').get(cycleId, friendId);
  if (order) return { kind: 'order', row: order };

  const link = db.prepare('SELECT * FROM guest_order_links WHERE cycle_id = ? AND host_friend_id = ?').get(cycleId, friendId);
  if (link) return { kind: 'guest_link', row: link };

  return null;
}

/** An active pickup location by id, or null — including for an unbindable id. */
export function activeLocation(rawId) {
  // ⚠ FUP-T15: the caller's presence test stays on the RAW value, so a
  // present-but-unbindable id still enters this lookup and is refused by the route's
  // own 400 rather than being silently treated as absent.
  const id = bindValue(rawId);
  if (id === undefined) return null;
  return db.prepare('SELECT * FROM pickup_locations WHERE id = ? AND active = 1').get(id) || null;
}

/**
 * Write one of the two pickup columns on the resolved target, clearing the other.
 * `value` is `{ locationId }` or `{ note }` — the route has already established that
 * exactly one of them was asked for.
 *
 * Returns `{ cleared_parcel, parcel_fee_removed }` so the route can report what else
 * had to change.
 */
export function applyPickup(target, value) {
  const setLocation = Object.prototype.hasOwnProperty.call(value, 'locationId');
  const locationId = setLocation ? value.locationId : null;
  const note = setLocation ? null : value.note;

  if (target.kind === 'guest_link') {
    db.prepare('UPDATE guest_order_links SET pickup_location_id = ?, pickup_location_note = ? WHERE id = ?')
      .run(locationId, note, target.row.id);
    return { cleared_parcel: false, parcel_fee_removed: 0 };
  }

  const order = target.row;

  // ⚠ SWITCHING A PACKETA ORDER TO PERSONAL PICKUP (PO decision, 2026-09-03, an
  // explicit reversal of 2026-09-02's refusal — "chcem, aby … za každých okolností").
  //
  // `packeta_address` and the pickup columns are mutually exclusive by construction
  // (the submit route clears one when it writes the other), so an order left with a
  // parcel fee and no parcel address would claim a delivery charge for a delivery
  // nobody makes. Both parcel fields are therefore cleared with the switch.
  //
  // ⚠ AND IT IS LEDGER-NEUTRAL, which is what makes it safe on a PAID order —
  // verified in the code, not assumed: `PATCH /orders/:id/paid` posts
  // `roundMoney(order.total)` and `helpers/packing.js` charges `-roundMoney(order.total)`.
  // Both legs use `total` ALONE; `delivery_fee` has never entered `transactions` at
  // all. So zeroing it moves no balance and invalidates no existing row.
  //
  // What it DOES change is what the friend was asked to pay (`paymentTotal = total +
  // delivery_fee` on the client, and the QR built from it). If they already
  // transferred the fee, that is a refund conversation for the admin — which is
  // exactly why the frontend puts this one case behind an inline confirm that names
  // the amount, instead of switching silently.
  const clearedParcel = !!order.packeta_address || (order.delivery_fee || 0) > 0;
  const feeRemoved = clearedParcel ? (order.delivery_fee || 0) : 0;

  db.prepare(`
    UPDATE orders
       SET pickup_location_id = ?, pickup_location_note = ?,
           packeta_address = NULL, delivery_fee = 0
     WHERE id = ?
  `).run(locationId, note, order.id);

  return { cleared_parcel: clearedParcel, parcel_fee_removed: feeRemoved };
}

/**
 * The effective pickup of a party, in the uniform shape both admin payloads publish.
 * Reads through the same target resolution as the write, so a screen can never show
 * one store while the picker writes the other.
 */
export function readPickup(cycleId, friendId) {
  const target = pickupTargetFor(cycleId, friendId);
  if (!target) return { pickup_location_id: null, pickup_location_note: null, pickup_location_name: null };
  return pickupOf(target.row);
}

/** The same shape from a row already in hand (either store — the columns match). */
export function pickupOf(row) {
  const id = row.pickup_location_id || null;
  const location = id
    ? db.prepare('SELECT name FROM pickup_locations WHERE id = ?').get(id)
    : null;
  return {
    pickup_location_id: id,
    pickup_location_note: row.pickup_location_note || null,
    // ⚠ Looked up WITHOUT `active = 1`: a location soft-deleted after an order chose
    // it must still render its name, or the badge would go blank on a party whose
    // pickup is perfectly well defined (`DELETE /api/pickup-locations/:id`
    // deactivates rather than deletes once an order references it).
    //
    // ⚠ THE SAME RULE HAS A SECOND HOME: `helpers/delivery.js` `locationRow()`
    // (DP-T1), which labels the distribution board's groups. Reuse was not clean —
    // that one answers a different shape — so the two copies must be changed
    // TOGETHER: drop the rule in one place only and the board's group title
    // disagrees with this badge for the same party.
    pickup_location_name: location ? location.name : null,
  };
}

/**
 * Every host's link-stored pickup for one cycle, keyed by `host_friend_id` — for the
 * listing endpoints, which would otherwise run one query per placeholder row.
 */
export function linkPickupsByHost(cycleId) {
  const rows = db.prepare(`
    SELECT gl.host_friend_id, gl.pickup_location_id, gl.pickup_location_note, pl.name as pickup_location_name
      FROM guest_order_links gl
      LEFT JOIN pickup_locations pl ON pl.id = gl.pickup_location_id
     WHERE gl.cycle_id = ?
  `).all(cycleId);

  const map = new Map();
  for (const row of rows) {
    map.set(row.host_friend_id, {
      pickup_location_id: row.pickup_location_id || null,
      pickup_location_note: row.pickup_location_note || null,
      pickup_location_name: row.pickup_location_name || null,
    });
  }
  return map;
}
