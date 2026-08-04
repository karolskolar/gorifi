import { Router } from 'express';
import db from '../db/schema.js';
import { requireHost } from '../middleware/friend-auth.js';
import {
  findSubOrderWithLink,
  guestOrderStatus,
  linkTotals,
  loadSubOrder,
} from '../helpers/guest-orders.js';

const router = Router();

// Mutations on a single guest sub-order.
//
// ⚠ MIXED-AUTH ROUTER — mounted BARE in index.js and gated PER ROUTE. The two
// routes here are the HOST's (§UC-GSO-007/008, friend Bearer identity), while
// GSO-T6 adds ADMIN routes on this same prefix (`PATCH /:id/paid` and
// `GET /cycle/:cycleId/unpaid`, each with `requireAdmin`). Wrapping the mount in
// either guard would therefore be wrong in both directions — T6 would have to
// unpick a `requireAdmin` mount, and an admin route cannot live under a host
// guard. Every route added here MUST state its own guard on its first lines.
//
// Decision 2, "single-owner flags", is what this file is about:
//   - `delivered` is HOST-only — the hand-over checklist. The host ticks it when
//     the colleague picks their bag up; the admin will see it read-only (GSO-T6)
//     and never toggles it (their own delivery tracking is the Distribution
//     packing flow, a separate concept).
//   - `paid` is ADMIN-only — the admin is the money recipient. The host sees it
//     READ-ONLY, so NOTHING in this file may write `paid`/`paid_at`. Every UPDATE
//     below names its columns literally for exactly that reason: the request body
//     is never spread into SQL, so no `paid: 1` (or `status`, `total`, `link_id`,
//     `guest_name`, …) smuggled into a delivered PATCH can land.
//
// Ownership: `guest_orders` carries no host column — it hangs off
// `guest_order_links`, which does. So every action resolves
// `guest_orders.link_id → guest_order_links.host_friend_id` and compares it to
// the authenticated friend. A row that does not exist answers 404 BEFORE any
// ownership check, so the endpoint is not an existence oracle for other hosts'
// sub-orders (same precedent as guest-links.js and routes/guest.js).

// Resolve :id to a sub-order the authenticated friend actually hosts.
// Returns { host, row } or a ready { error, status }.
function resolveOwnSubOrder(req) {
  const host = requireHost(req);
  if (host.error) return { error: host.error, status: host.status };

  const row = findSubOrderWithLink(req.params.id);
  if (!row) return { error: 'Objednávka kolegu nebola nájdená', status: 404 };
  if (String(row.host_friend_id) !== String(host.friendId)) {
    return { error: 'Nemáte oprávnenie na túto objednávku', status: 403 };
  }
  return { host, row };
}

// The response of both mutations: the row that changed (in the same enriched
// shape the host view lists) plus the recomputed guest aggregate, so the client
// needs no follow-up round trip.
function mutationPayload(row) {
  return {
    guest_order: loadSubOrder(row.id),
    totals: linkTotals(row.link_id),
  };
}

// PATCH /guest-orders/:id/delivered — the host's hand-over checklist
// (§UC-GSO-007). HOST-only. Body: { delivered? } — an explicit boolean sets the
// state (what the UI sends, so a double click or a second device converges
// instead of racing); an absent field toggles the current value.
//
// Deliberately NOT gated on the cycle being open: the hand-over happens AFTER the
// lock, when the goods have arrived and been distributed. Nor on the link being
// active — a host who stopped taking new sub-orders still has to hand the
// existing ones over.
router.patch('/:id/delivered', (req, res) => {
  const resolved = resolveOwnSubOrder(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { row } = resolved;

  // A cancelled sub-order cannot be handed over — there is nothing to give the
  // colleague, and `cancelled` is terminal (GSO-T4), so a hand-over tick on it
  // could only ever be a false record. 409 (a conflict with the resource's
  // current state) rather than 404: the sub-order is still very much readable,
  // it just cannot take this transition. Same code the guest's own edit gets.
  if (guestOrderStatus(row) === 'cancelled') {
    return res.status(409).json({
      error: 'Táto objednávka bola zrušená, nie je čo odovzdať.',
      reason: 'cancelled',
    });
  }

  const requested = req.body?.delivered;
  const delivered = requested === undefined ? !row.delivered : !!requested;

  // Two literal statements rather than one parameterised pair, so the timestamp
  // rule ("set on tick, CLEARED on untick") is impossible to get half-right, and
  // so no column outside these two can be written from here.
  if (delivered) {
    db.prepare('UPDATE guest_orders SET delivered = 1, delivered_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(row.id);
  } else {
    db.prepare('UPDATE guest_orders SET delivered = 0, delivered_at = NULL WHERE id = ?')
      .run(row.id);
  }

  res.json(mutationPayload(row));
});

// DELETE /guest-orders/:id — the host removes a whole sub-order while the cycle is
// open (§UC-GSO-008, Decision 8: typo, prank, colleague changed their mind
// offline). HOST-only.
//
// ⚠ This is a SOFT cancel, not a row delete: `status = 'cancelled'`, `total = 0`,
// and the `guest_order_items` rows are KEPT — exactly the semantics GSO-T4's
// empty-cart path produces, which is why the guest's status URL then renders
// cancelled and refuses to revive it (`cancelled` is terminal).
//
// Why the item rows stay: the `cancelled` status IS the mechanism everywhere.
// helpers/stock.js releases the grams via `COALESCE(status,'submitted') <>
// 'cancelled'`, and T7/T8/T9 have to filter on that status regardless (a
// cancelled sub-order must not appear as a distribution party, in the unpaid
// overview or as a rewards contributor). Deleting the rows would buy nothing on
// top of that and would destroy the host's and the admin's record of what was
// ordered and then called off.
//
// Status codes:
//   404 — no such sub-order
//   403 — it belongs to another host
//   409 — the sub-order is already PAID (money is the admin's business, see
//         below), or the cycle is no longer open (removal ends at the lock: after
//         it, the goods are ordered from the roastery and distribution has begun)
//   200 — removed, or already cancelled (idempotent, see below)
router.delete('/:id', (req, res) => {
  const resolved = resolveOwnSubOrder(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { row } = resolved;

  // Already cancelled ⇒ 200 no-op. DELETE is idempotent by definition and
  // `cancelled` is terminal, so the requested end state is simply already the
  // current one: a double click, a retried request or a second device must not
  // be answered with an error the host cannot act on. (The guest's PUT on a
  // cancelled sub-order is a 409 instead, because there the request asks for a
  // DIFFERENT state — a revival — which genuinely conflicts.)
  if (guestOrderStatus(row) === 'cancelled') {
    return res.json({ ...mutationPayload(row), already_cancelled: true });
  }

  // ⚠ A PAID sub-order is the admin's business, not the host's.
  //
  // Cancelling zeroes `total` and every "not cancelled" aggregate then drops the
  // row (the host's totals here, and per T6/T8/T9 the unpaid overview, the cycle
  // kilos and the rewards), so money the colleague really sent would go INVISIBLE
  // — reconstructable only by recomputing price × quantity from the kept item
  // rows. Under Decision 2 the money is the admin's side of the deal: the host
  // does not get to unilaterally erase an order somebody has paid for, exactly as
  // cash a guest hands them has to go through the admin. So refuse, and point the
  // host at the admin, who can refund and then cancel.
  //
  // Checked BEFORE the cycle-status gate: it is the more specific and more
  // consequential reason, and it is the one the host has to act on.
  //
  // Unreachable until GSO-T6 ships the only legitimate `paid` toggle — closed now
  // precisely because T6 makes it reachable. T6 MAY additionally surface
  // `paid = 1 AND status = 'cancelled'` in its unpaid/overview screen as a refund
  // queue (for orders the admin cancels after refunding); that is an addition to
  // this guard, not a replacement for it.
  if (row.paid) {
    return res.status(409).json({
      error: 'Táto objednávka je už zaplatená. Zrušenie vyriešte so správcom.',
      reason: 'paid',
    });
  }

  if (row.cycle_status !== 'open') {
    return res.status(409).json({
      error: 'Cyklus je už uzavretý, objednávku kolegu už nie je možné odstrániť.',
      reason: 'closed',
    });
  }

  const apply = db.transaction(() => {
    // Re-read inside the transaction: the admin may have locked the cycle — or
    // matched an incoming payment and marked this sub-order paid — while the
    // request was being validated.
    const cycle = db.prepare('SELECT status FROM order_cycles WHERE id = ?').get(row.cycle_id);
    if (cycle?.status !== 'open') return { conflict: 'closed' };
    const current = db.prepare('SELECT paid FROM guest_orders WHERE id = ?').get(row.id);
    if (!current) return { conflict: 'gone' };
    if (current.paid) return { conflict: 'paid' };
    // The predicate makes the write itself idempotent, so a concurrent cancel
    // (the guest emptying their own cart at the same moment) cannot double-apply.
    // `delivered`/`paid` are left exactly as they are: this records that the
    // sub-order was called off, it does not rewrite what had already happened.
    const result = db.prepare(`
      UPDATE guest_orders SET status = 'cancelled', total = 0
      WHERE id = ? AND COALESCE(status, 'submitted') <> 'cancelled'
    `).run(row.id);
    return { changed: result.changes };
  });

  const applied = apply();
  if (applied.conflict === 'gone') {
    return res.status(404).json({ error: 'Objednávka kolegu nebola nájdená' });
  }
  if (applied.conflict === 'paid') {
    return res.status(409).json({
      error: 'Táto objednávka je už zaplatená. Zrušenie vyriešte so správcom.',
      reason: 'paid',
    });
  }
  if (applied.conflict === 'closed') {
    return res.status(409).json({
      error: 'Cyklus bol práve uzavretý, objednávku kolegu už nie je možné odstrániť.',
      reason: 'closed',
    });
  }

  res.json(mutationPayload(row));
});

export default router;
