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

  // ⚠ STAGE ORDER (DP-T4, 16 §UC-DP-007): un-checking an item whose parent order is
  // already HANDED OVER is refused, and the auto-unpack below is never reached. The
  // bag is with the friend; re-opening it here would post the ledger reversal for a
  // delivery that happened. Checking (0 → 1) is unaffected.
  if (newPacked === 0 && parentOrder.handed_over_at) {
    return res.status(409).json({
      error: 'Balíček je už odovzdaný — najprv zrušte odovzdanie.',
      reason: 'handed_over',
    });
  }

  const toggle = db.transaction(() => {
    // ⚠ The same gate REPEATED AS THIS UPDATE'S OWN PREDICATE, so the check and the
    // write are one statement: an item cannot be released by a hand-over landing
    // between the read above and here. `changes === 0` ⇒ the bag left in between,
    // and the abort happens BEFORE the unpack, with nothing written — so the 409
    // cannot leave a half-applied toggle behind.
    const written = db.prepare(`
      UPDATE order_items SET packed = ?
       WHERE id = ?
         AND (? = 1 OR NOT EXISTS (
           SELECT 1 FROM orders WHERE id = ? AND handed_over_at IS NOT NULL
         ))
    `).run(newPacked, item.id, newPacked, item.order_id);
    if (written.changes === 0) return { conflict: 'handed_over' };

    // Unchecking an item on an already-packed order un-packs the whole order
    // and posts the reversal transaction (same as the orders.js unpack path).
    if (newPacked === 0 && parentOrder.packed) {
      unpackOrder(parentOrder);
    }
    return { ok: true };
  });

  const toggled = toggle();
  if (toggled.conflict === 'handed_over') {
    return res.status(409).json({
      error: 'Balíček je už odovzdaný — najprv zrušte odovzdanie.',
      reason: 'handed_over',
    });
  }

  const updated = db.prepare('SELECT * FROM order_items WHERE id = ?').get(item.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(item.order_id);

  res.json({
    ...updated,
    order_packed: order ? order.packed : 0
  });
});

export default router;
