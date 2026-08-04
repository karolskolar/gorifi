import { Router } from 'express';
import db from '../db/schema.js';
import { requireHost } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import {
  cycleSubOrders,
  findSubOrderWithLink,
  guestOrderStatus,
  guestPaymentReference,
  linkTotals,
  loadSubOrder,
} from '../helpers/guest-orders.js';

const router = Router();

// Mutations on a single guest sub-order.
//
// ⚠ MIXED-AUTH ROUTER — mounted BARE in index.js and gated PER ROUTE:
//   HOST-only  (friend Bearer identity, §UC-GSO-007/008)
//     PATCH  /:id/delivered
//     DELETE /:id
//   ADMIN-only (`requireAdmin`, §UC-GSO-009/010)
//     PATCH  /:id/paid
//     GET    /cycle/:cycleId/unpaid
// Wrapping the mount in either guard would be wrong in both directions — an admin
// route cannot live under a host guard, and vice versa. Every route added here
// MUST state its own guard on its first lines.
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

// ---------------------------------------------------------------------------
// ADMIN routes (§UC-GSO-009..010). From here down every handler is
// `requireAdmin`-gated: the admin is the money recipient (Decision 1), and under
// Decision 2 `paid` is theirs alone — a host Bearer token, the shared friends
// password and an anonymous request are all 401 here, exactly as an admin token is
// not host identity on the two routes above.
// ---------------------------------------------------------------------------

// PATCH /guest-orders/:id/paid — the admin matched an incoming payment to the
// sub-order's `G<id>` reference (§UC-GSO-009). ADMIN-only.
// Body: { paid? } — an explicit boolean sets the state, an absent field toggles.
//
// ⚠ NO `transactions` ROW. The friend equivalent (`PATCH /api/orders/:id/paid`)
// inserts a `payment` transaction (and a negative reversal when unticked) because
// friends have a running balance keyed on `friend_id`. A guest is not a friend:
// `guest_orders` has no `friend_id`, guests have no balance account, and Decision 1
// says they pay the admin directly. `paid` + `paid_at` on the row IS the whole
// bookkeeping. Copying the friend handler's transaction logic would move a REAL
// friend's balance (the host's — the only friend anywhere near this row) for money
// that never went through it, or write a row keyed on NULL that no balance query
// can ever see again. The host's payable total stays own-items-only; guest money is
// the admin's receivable (§UC-GSO-006).
//
// NOT gated on the sub-order's status, unlike the delivered tick above. That
// asymmetry is deliberate: `delivered` asserts a hand-over, which cannot have
// happened for a cancelled order — whereas money genuinely can arrive for an order
// that was then called off, and the refund workflow needs to CLEAR the flag
// afterwards. `paid = 1 AND status = 'cancelled'` is precisely the refund queue the
// unpaid overview below surfaces.
router.patch('/:id/paid', requireAdmin, (req, res) => {
  const row = findSubOrderWithLink(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Objednávka kolegu nebola nájdená' });
  }

  const requested = req.body?.paid;
  const paid = requested === undefined ? !row.paid : !!requested;

  // Two literal statements, for the same two reasons as the delivered toggle: the
  // timestamp rule ("set on tick, CLEARED on untick") cannot be got half-right,
  // and NOTHING outside these two columns can be written from here. The request
  // body is never spread into SQL, so a `delivered: 1` (the HOST's flag), a
  // `status`, `total`, `guest_name` or `link_id` smuggled into this body lands
  // nowhere. `paid_at` is server time, never the caller's.
  if (paid) {
    db.prepare('UPDATE guest_orders SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(row.id);
  } else {
    db.prepare('UPDATE guest_orders SET paid = 0, paid_at = NULL WHERE id = ?')
      .run(row.id);
  }

  res.json(mutationPayload(row));
});

// GET /guest-orders/cycle/:cycleId/unpaid — the admin's money overview for a cycle
// (§UC-GSO-010): who has not paid yet, how much, under which reference, through
// which host, and how to reach them. ADMIN-only.
//
// Two lists, because two different actions are needed:
//   `unpaid`  — live sub-orders with `paid = 0`: money still owed. Cancelled ones
//               are excluded (nothing is owed for them), consistent with
//               helpers/stock.js and the host's own totals.
//   `refunds` — `paid = 1 AND status = 'cancelled'`: money received for an order
//               that no longer exists, so it has to go back. GSO-T5's DELETE guard
//               stops a HOST creating this state, but a guest can still empty their
//               own cart after paying, and the admin may cancel after refunding —
//               and no other screen in the app shows it at all. Clearing `paid`
//               (above) takes a row off this queue.
//
// The `reference` is built by the SHARED formatter, so it is byte-identical to the
// string the guest was shown on their confirmation and status pages — matching a
// bank transfer to a sub-order is the entire purpose of this screen.
router.get('/cycle/:cycleId/unpaid', requireAdmin, (req, res) => {
  const cycle = db.prepare('SELECT id, name, status, type FROM order_cycles WHERE id = ?')
    .get(req.params.cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // ⚠ `amount` is the figure the admin acts on, and it is NOT always `total`.
  // Cancelling a sub-order ZEROES `total` (GSO-T4/T5) while keeping the item rows,
  // so a refund row's stored total says 0 — the money to give back is recoverable
  // only by recomputing price × quantity from those kept items. (That is exactly
  // why T4 and T5 keep them.) For a live sub-order the two are the same.
  const itemsAmount = (row) => Math.round(
    (row.items || []).reduce((acc, item) => acc + (item.price || 0) * (item.quantity || 0), 0) * 100
  ) / 100;

  // `order_token` is not in these rows (the shared column list omits it): it is the
  // guest's private edit credential, and the admin has no use for it.
  const rows = cycleSubOrders(cycle.id).map((row) => {
    const status = guestOrderStatus(row);
    return {
      id: row.id,
      guest_name: row.guest_name,
      guest_phone: row.guest_phone,
      guest_email: row.guest_email,
      total: row.total,
      amount: status === 'cancelled' ? itemsAmount(row) : row.total,
      status,
      paid: row.paid,
      delivered: row.delivered,
      created_at: row.created_at,
      reference: guestPaymentReference(row, cycle.name),
      host: { id: row.host_friend_id, name: row.host_name, active: row.host_active },
    };
  });

  const sum = (list) => ({
    count: list.length,
    total: Math.round(list.reduce((acc, row) => acc + (row.amount || 0), 0) * 100) / 100,
  });

  const unpaid = rows.filter((row) => row.status !== 'cancelled' && !row.paid);
  const refunds = rows.filter((row) => row.status === 'cancelled' && !!row.paid);

  res.json({
    cycle: { id: cycle.id, name: cycle.name, status: cycle.status, type: cycle.type },
    unpaid,
    totals: sum(unpaid),
    refunds,
    refund_totals: sum(refunds),
  });
});

export default router;
