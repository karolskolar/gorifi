import { Router } from 'express';
import db from '../db/schema.js';
import { unpackOrder } from '../helpers/packing.js';

const router = Router();

// Admin: Toggle the persisted Distribution packing checkbox on a single order
// item. Mounted under /api/order-items with requireAdmin applied at the mount
// (see index.js). Returns the updated item plus the parent order's packed flag
// so the Distribution view can refresh both the row and the "Zabaliť" state.
//
// If unchecking an item on an order that is currently packed, the order is
// auto-unpacked and the packing charge is reversed (via the shared unpackOrder
// helper) so the friend's balance stays consistent with the whole-order toggle.
router.patch('/:id/packed', (req, res) => {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'Položka objednávky neexistuje' });
  }

  const parentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id);

  // Same rule as the whole-order toggle in orders.js: only submitted orders can
  // be packed. Without this, a draft order's items could be pre-checked and the
  // order would show up in Distribution with "Zabaliť" already unlocked
  // (submit never touches order_items), defeating the deliberate final step.
  if (!parentOrder || parentOrder.status !== 'submitted') {
    return res.status(400).json({ error: 'Len odoslané objednávky môžu byť označené ako zabalené' });
  }

  const newPacked = item.packed ? 0 : 1;

  const toggle = db.transaction(() => {
    db.prepare('UPDATE order_items SET packed = ? WHERE id = ?').run(newPacked, item.id);

    // Unchecking an item on an already-packed order un-packs the whole order
    // and posts the reversal transaction (same as the orders.js unpack path).
    if (newPacked === 0 && parentOrder.packed) {
      unpackOrder(parentOrder);
    }
  });

  toggle();

  const updated = db.prepare('SELECT * FROM order_items WHERE id = ?').get(item.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id);

  res.json({
    ...updated,
    order_packed: order ? order.packed : 0
  });
});

export default router;
