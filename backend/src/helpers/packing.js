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
