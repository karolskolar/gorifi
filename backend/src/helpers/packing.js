import db from '../db/schema.js';
import { roundMoney } from './pricing.js';

// Shared "Zabalené" (packed) balance logic for friend orders.
//
// Marking an order packed posts a `charge` transaction for the order total
// (negative amount = the friend owes it); un-packing posts the reversal
// (positive amount, note 'Stornované'). Both the whole-order toggle
// (orders.js PATCH /:id/packed) and the per-item toggle
// (order-items.js PATCH /:id/packed — which auto-unpacks an order when an item
// is unchecked) must post the SAME transactions so the friend's balance never
// drifts. Keeping the SQL in one place guarantees that.
//
// Both helpers assume they run inside a db.transaction().
//
// ⚠ BOTH AMOUNTS GO THROUGH `roundMoney`. These two helpers post `order.total`
// straight into the ledger, so before the money-rounding fix they INHERITED the
// unrounded order total into the friend's balance — an order stored as
// 26.189999999999998 charged 26.189999999999998, and the balance could never come
// back to a true zero against the 26.19 the friend was actually asked to pay. Rows
// written before that fix still hold unrounded totals, so this stays here
// permanently, not just as belt-and-braces on a now-clean column.
//
// The reversal negates the ROUNDED charge, so pack→unpack still nets exactly 0.

export function packOrder(order) {
  db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'charge', ?, NULL)
  `).run(order.friend_id, order.id, -roundMoney(order.total));

  db.prepare('UPDATE orders SET packed = 1, packed_at = CURRENT_TIMESTAMP WHERE id = ?').run(order.id);
}

export function unpackOrder(order) {
  db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'charge', ?, 'Stornované')
  `).run(order.friend_id, order.id, roundMoney(order.total));

  db.prepare('UPDATE orders SET packed = 0, packed_at = NULL WHERE id = ?').run(order.id);
}

// The host's own submitted order for a cycle, or undefined. The guest per-item
// toggle needs it to auto-unpack (guest items hang off the host+cycle pair via the
// share link, not off an order id), and a host may legitimately have none —
// §Edge Cases, "host has no own order at lock time".
export function hostOwnOrder(friendId, cycleId) {
  return db.prepare(
    "SELECT * FROM orders WHERE friend_id = ? AND cycle_id = ? AND status = 'submitted'"
  ).get(friendId, cycleId);
}

// Everything that has to be checked off before a host's order may be marked packed
// (Decision 3 / §UC-GSO-011): the friend's own `order_items` PLUS every item of
// every non-cancelled guest sub-order placed through that host's share link for the
// same cycle.
//
// One home for the UNION, for the same reason helpers/stock.js is: the gate in
// orders.js and any future surface that wants to show "4 of 5 handed over" must
// count the identical set, or the button and the counter disagree.
//
// `guest_orders.status` is nullable with a 'submitted' DEFAULT, so it is COALESCEd
// before the comparison — a bare `<> 'cancelled'` drops NULL rows in SQL's
// three-valued logic, which here would silently REMOVE real bags from the gate
// (the dangerous direction: packing a host whose colleague's bag is untouched).
//
// Cancelled sub-orders keep their item rows (GSO-T4: the status predicate is the
// mechanism, not deletion), so excluding them here is what stops a called-off bag
// from blocking the pack forever.
//
// ⚠ AND A PACKETA SUB-ORDER IS NOT IN THE HOST'S BAG (GP-T6, 20 §UC-GP-010 / D6). A
// guest with their own `packeta_address` is their OWN party on the distribution board —
// the admin posts that parcel, the host never touches it — so it must not gate the
// host's „Zabaliť". `gord.packeta_address IS NULL` is the module-20 marker (learnings 12
// §1: the address, never the fee — a fee of 0 is legal); every writer stores either NULL
// or a trimmed non-blank string (submit/edit validate it, `applyGuestDelivery` NULLs
// it), which is what keeps this SQL agreeing with `helpers/delivery.js`'s trimmed test.
// Status is filtered FIRST by the line above, so a cancelled Packeta row (which KEEPS
// its address) is excluded by status, not by this. ⚠ `packed` is the LEDGER moment of
// the host's own order: this line lets the host pack WITHOUT the Packeta bag, and its
// twin in `routes/guest-order-items.js` stops unticking that bag from un-packing the
// host — change one without the other and a host packs early or un-packs late.
export function packingItemStats({ orderId = null, friendId, cycleId }) {
  return db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN packed = 1 THEN 1 ELSE 0 END) AS packed_count
    FROM (
      SELECT oi.packed AS packed
      FROM order_items oi
      WHERE oi.order_id = ?
      UNION ALL
      SELECT gi.packed AS packed
      FROM guest_order_items gi
      JOIN guest_orders gord ON gord.id = gi.guest_order_id
      JOIN guest_order_links glink ON glink.id = gord.link_id
      WHERE glink.host_friend_id = ? AND glink.cycle_id = ?
        AND COALESCE(gord.status, 'submitted') <> 'cancelled'
        AND gord.packeta_address IS NULL
    )
  `).get(orderId, friendId, cycleId);
}
