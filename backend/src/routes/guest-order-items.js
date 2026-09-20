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
    SELECT gord.id, gord.status, gord.handed_over_at, glink.host_friend_id, glink.cycle_id
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

  // ⚠ STAGE ORDER (DP-T4, 16 §UC-DP-007), and here it has TWO predicates because a
  // guest item can un-pack two different bags:
  //   • the sub-order's OWN `handed_over_at` — this colleague's bag has left (which
  //     is also the only stamp a host with NO own order ever has), and
  //   • the HOST's own order being handed over — because the un-pack below reaches
  //     `unpackOrder(ownOrder)` and would take the host's delivered bag back apart,
  //     ledger reversal and all, through a checkbox on somebody else's row.
  // Checking (0 → 1) is unaffected in both cases: a colleague who orders after the
  // host's bag went out still gets packed normally.
  if (newPacked === 0 && (subOrder.handed_over_at || (ownOrder && ownOrder.handed_over_at))) {
    return res.status(409).json({
      error: 'Balíček je už odovzdaný — najprv zrušte odovzdanie.',
      reason: 'handed_over',
    });
  }

  const toggle = db.transaction(() => {
    // ⚠ Both halves of the gate REPEATED AS THIS UPDATE'S OWN PREDICATE, so the
    // check and the write are one statement. The host clause binds `null` when the
    // host has no own order — `SELECT 1 FROM orders WHERE id = NULL` matches nothing,
    // so `NOT EXISTS` is true and the absence of an order is not a refusal.
    const written = db.prepare(`
      UPDATE guest_order_items SET packed = ?
       WHERE id = ?
         AND (? = 1 OR (
           NOT EXISTS (SELECT 1 FROM guest_orders WHERE id = ? AND handed_over_at IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM orders WHERE id = ? AND handed_over_at IS NOT NULL)
         ))
    `).run(newPacked, item.id, newPacked, item.guest_order_id, ownOrder ? ownOrder.id : null);
    if (written.changes === 0) return { conflict: 'handed_over' };

    if (newPacked === 0 && ownOrder && ownOrder.packed) {
      unpackOrder(ownOrder);
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
