import db from '../db/schema.js';

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

export function packOrder(order) {
  db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'charge', ?, NULL)
  `).run(order.friend_id, order.id, -order.total);

  db.prepare('UPDATE orders SET packed = 1, packed_at = CURRENT_TIMESTAMP WHERE id = ?').run(order.id);
}

export function unpackOrder(order) {
  db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'charge', ?, 'Stornované')
  `).run(order.friend_id, order.id, order.total);

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
    )
  `).get(orderId, friendId, cycleId);
}
