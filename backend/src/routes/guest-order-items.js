import { Router } from 'express';
import db from '../db/schema.js';
import { unpackOrder, hostOwnOrder } from '../helpers/packing.js';
import { guestOrderStatus } from '../helpers/guest-orders.js';

const router = Router();

// Admin: toggle the persisted Distribution packing checkbox on a single GUEST
// order item (§UC-GSO-011). Mounted under /api/guest-order-items with requireAdmin
// applied at the mount (see index.js) — the exact mirror of routes/order-items.js,
// which does the same for a friend's own items.
//
// Two differences from the friend route, both load-bearing:
//
//  - **The status gate is `cancelled`, not `submitted`.** Guest sub-orders are
//    created already submitted (there is no guest draft), so the friend rule
//    "only submitted orders can be packed" has no analogue; what it protects
//    against here is checking off a bag that was called off. A cancelled sub-order
//    keeps its item rows (GSO-T4), so without this the admin could tick items that
//    are not part of the delivery — and those ticks would then be invisible in the
//    gate, which excludes cancelled sub-orders.
//
//  - **No transaction is ever written for the guest item itself.** Guests have no
//    `friend_id` and no running balance; they pay the admin directly (Decision 1,
//    pinned by GSO-T6 on the paid toggle). The ONE money movement below belongs to
//    the HOST: un-checking a bag on an order the admin had already packed un-packs
//    that order, and `unpackOrder()` reverses the charge for the host's OWN order
//    total — the same reversal the whole-order toggle posts, so the host's balance
//    nets back to where it was before packing.
//
// A host with no own order (§Edge Cases) simply has no order to un-pack: their
// packing record is these checkboxes alone, and `order_packed` comes back 0.
//
// No guest-edit-vs-packed conflict is possible and none is defended against: guest
// edits are only accepted while the cycle is `open` (routes/guest.js), and
// distribution happens after the lock (§Edge Cases).
router.patch('/:id/packed', (req, res) => {
  const item = db.prepare('SELECT * FROM guest_order_items WHERE id = ?').get(req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'Položka objednávky hosťa neexistuje' });
  }

  // The sub-order carries no host column — the link does (GSO-T5 rule).
  const subOrder = db.prepare(`
    SELECT gord.id, gord.status, glink.host_friend_id, glink.cycle_id
    FROM guest_orders gord
    JOIN guest_order_links glink ON glink.id = gord.link_id
    WHERE gord.id = ?
  `).get(item.guest_order_id);

  if (!subOrder) {
    return res.status(404).json({ error: 'Objednávka hosťa neexistuje' });
  }

  if (guestOrderStatus(subOrder) === 'cancelled') {
    return res.status(400).json({ error: 'Zrušená objednávka hosťa sa nedá zabaliť' });
  }

  const newPacked = item.packed ? 0 : 1;
  const ownOrder = hostOwnOrder(subOrder.host_friend_id, subOrder.cycle_id);

  const toggle = db.transaction(() => {
    db.prepare('UPDATE guest_order_items SET packed = ? WHERE id = ?').run(newPacked, item.id);

    if (newPacked === 0 && ownOrder && ownOrder.packed) {
      unpackOrder(ownOrder);
    }
  });

  toggle();

  const updated = db.prepare('SELECT * FROM guest_order_items WHERE id = ?').get(item.id);
  const order = ownOrder
    ? db.prepare('SELECT packed FROM orders WHERE id = ?').get(ownOrder.id)
    : null;

  res.json({
    ...updated,
    // Same field name the friend route answers with, so the Distribution view can
    // patch the host card's "Zabaliť" state from either kind of tap.
    order_packed: order ? order.packed : 0,
    host_order_id: ownOrder ? ownOrder.id : null,
  });
});

export default router;
