import db from '../db/schema.js';
import { roundMoney } from './pricing.js';

// Guest sub-order reads, shared by every surface that shows them.
//
// GSO-T2 introduced `loadSubOrders(linkId)` inside routes/guest-links.js with the
// explicit intent that the host view could later be ENRICHED without reshaping
// the response. GSO-T5 is that enrichment (items per sub-order) and adds a second
// consumer — routes/guest-orders.js, the host's delivered/remove mutations, which
// answer with the same row shape — so the loaders live here instead of being
// duplicated. GSO-T6's admin surfaces (nested sub-orders, unpaid overview) reuse
// them too.
//
// ⚠ `order_token` IS in the column list, and that is a CONSCIOUS REVERSAL of the
// GSO-T2 rule that used to be stated here ("deliberately absent from every column
// list … neither the host nor the admin ever needs it"). 14 §UC-GR-006 reverses it,
// for a reason the incident supplied: a guest lost her status URL when the host
// regenerated their share link, and nobody — not the host who invited her, not the
// admin holding her money — could send it back to her, because the one column that
// answers "what is her link?" was hidden from every surface with a person in front
// of it. Publishing it is precisely the recovery capability (the host's "Kopírovať
// odkaz", the admin's resend on the orders tab and the receivables screen).
//
// The reversal is bounded, and this is the half of the GSO-T2 rule that SURVIVES:
// **routes/guest.js remains the ONLY place `order_token` is a CREDENTIAL.** No other
// route may authenticate by it — publishing a column to an already-authenticated
// host/admin surface is not the same as accepting it as identity, and nothing here
// changes who may call these loaders.
//
// Every consumer of the loaders below is host- or admin-authenticated:
// guest-links GET/POST/PATCH (requireHost + ownership), the guest-orders mutations
// (host) and its unpaid overview (requireAdmin), and `cycleSubOrders(ByHost)` →
// the admin orders tab (routes/orders.js) and the admin distribution sheet
// (routes/cycles.js). A public payload never passes through here — routes/guest.js
// composes the guest's own `statusPayload` itself.
//
// ⚠ It goes in the ONE SHARED LIST (Decision D6), never a per-surface pick: that is
// the whole point of the list, and per-surface picks are how a column ends up
// published on one screen and missing from the next.
//
// ⚠ Published ≠ RENDERED. The token must not reach the DOM (share-dialog.spec.js
// pins that the share dialog's HTML never contains one): UI composes
// `${origin}/g/o/${order_token}` in JS at click time, never into an attribute.

const GUEST_ORDER_FIELDS = [
  'id', 'link_id', 'guest_name', 'guest_phone', 'guest_email', 'status', 'total',
  'paid', 'paid_at', 'delivered', 'delivered_at', 'created_at', 'order_token',
];

const GUEST_ORDER_COLUMNS = GUEST_ORDER_FIELDS.join(', ');

// The same field list qualified with a table alias, for the joined reads (a
// sub-order plus its host / cycle). One list, so a column can never be published
// on one surface and missing on another.
function guestOrderColumns(alias) {
  return GUEST_ORDER_FIELDS.map((field) => `${alias}.${field}`).join(', ');
}

// `guest_orders.status` is nullable with a 'submitted' DEFAULT, so never compare
// it bare — same reason helpers/stock.js wraps it in COALESCE.
//
// ⚠ ONE HOME. routes/guest.js carried an identical private `orderStatus()` until
// GSO-T6; both callers now import this. Two copies of the "nullable status"
// rule is exactly how one of them ends up comparing the raw column.
export function guestOrderStatus(order) {
  return order?.status || 'submitted';
}

// The payment reference the guest is told to put on their transfer, and the ONLY
// thing that ties an incoming bank payment to a sub-order (Decision 1).
//
// `G<id>` is what makes it unambiguous — duplicate first names are the norm in a
// group order. It is produced in three places (the guest's confirmation screen,
// their status page, and the admin's unpaid overview) and every one of them MUST
// render the identical string, so it is built here once. A second, drifting
// formatter would mean the admin chasing a reference the guest was never given.
export function guestPaymentReference(order, cycleName) {
  return `G${order.id} / ${order.guest_name} / ${cycleName}`;
}

// The line items of the given sub-orders, attached in place as `items`.
// One query for the whole set (the host view renders every sub-order of a link,
// so a per-row query would be an N+1).
//
// GSO-T7 added `gi.packed` (the admin's persisted Distribution checkbox) and
// `p.roast_type` — the bag label needs the same fields a friend item shows, so the
// Distribution view can render both kinds of row through one template. Additive, as
// always here: this list is EXTENDED, never reshaped, so no surface loses a column.
function attachItems(orders) {
  if (orders.length === 0) return orders;
  const placeholders = orders.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT gi.id, gi.guest_order_id, gi.product_id, gi.variant, gi.quantity, gi.price, gi.packed,
           p.name AS product_name, p.variant_label, p.purpose, p.roast_type
    FROM guest_order_items gi
    JOIN products p ON p.id = gi.product_id
    WHERE gi.guest_order_id IN (${placeholders})
    ORDER BY gi.id
  `).all(...orders.map((order) => order.id));

  const byOrder = new Map(orders.map((order) => [order.id, []]));
  for (const row of rows) {
    byOrder.get(row.guest_order_id)?.push(row);
  }
  for (const order of orders) {
    order.items = byOrder.get(order.id) || [];
  }
  return orders;
}

// What the host is going to collect for their colleagues. CANCELLED sub-orders
// are excluded (they owe nothing and there is nothing to hand over) but are still
// LISTED, so the host can see what was called off.
//
// This is deliberately NOT part of the host's own payable total: per §UC-GSO-006
// the host pays for their own items only, and the guests pay the admin directly
// (Decision 1). It is a context figure, aggregated separately.
function subOrderTotals(orders) {
  const live = orders.filter((order) => guestOrderStatus(order) !== 'cancelled');
  const total = live.reduce((sum, order) => sum + (order.total || 0), 0);
  return {
    count: live.length,
    total: roundMoney(total),
  };
}

function subOrderRows(linkId) {
  if (!linkId) return [];
  return db.prepare(
    `SELECT ${GUEST_ORDER_COLUMNS} FROM guest_orders WHERE link_id = ? ORDER BY created_at, id`
  ).all(linkId);
}

// Every sub-order under a link, each with its items, plus the host's running
// total. The response shape of GET/POST/PATCH on /api/guest-links.
export function loadSubOrders(linkId) {
  const guestOrders = attachItems(subOrderRows(linkId));
  return { guest_orders: guestOrders, totals: subOrderTotals(guestOrders) };
}

// Just the aggregate, for mutation responses that already carry the single row
// they changed and only need the recomputed context figure.
export function linkTotals(linkId) {
  return subOrderTotals(subOrderRows(linkId));
}

// One sub-order in the same enriched shape as a row of loadSubOrders().
export function loadSubOrder(id) {
  const order = db.prepare(`SELECT ${GUEST_ORDER_COLUMNS} FROM guest_orders WHERE id = ?`).get(id);
  if (!order) return null;
  attachItems([order]);
  return order;
}

// Every sub-order of a whole CYCLE (not of one link), each with its items and its
// host, in one query — the admin's cycle-wide reads.
//
// Deliberately NOT filtered:
//   - by status: a cancelled sub-order is part of the record and the admin views
//     mark it as such (same rule as the host view). Callers that mean "owed for"
//     or "counts towards kilos" filter on `guestOrderStatus()` themselves.
//   - by `friends.active`: a deactivated host stops taking NEW sub-orders
//     (routes/guest.js 410s their link), but the ones already placed still have to
//     be handed over and paid for. Dropping them here would make real money
//     invisible on the admin's screens.
export function cycleSubOrders(cycleId) {
  if (!cycleId) return [];
  const rows = db.prepare(`
    SELECT ${guestOrderColumns('gord')},
           glink.host_friend_id, f.name AS host_name, f.active AS host_active
    FROM guest_orders gord
    JOIN guest_order_links glink ON glink.id = gord.link_id
    JOIN friends f ON f.id = glink.host_friend_id
    WHERE glink.cycle_id = ?
    ORDER BY gord.created_at, gord.id
  `).all(cycleId);
  return attachItems(rows);
}

// The same set grouped by host, for nesting sub-orders under their host's order in
// the admin cycle detail (§UC-GSO-009). Keys are `host_friend_id`.
export function cycleSubOrdersByHost(cycleId) {
  const byHost = new Map();
  for (const row of cycleSubOrders(cycleId)) {
    if (!byHost.has(row.host_friend_id)) byHost.set(row.host_friend_id, []);
    byHost.get(row.host_friend_id).push(row);
  }
  return byHost;
}

// THE soft cancel. Returns the number of rows changed (0 = it was already
// cancelled), so a caller can distinguish a real transition from a converged no-op.
//
// ⚠ ONE HOME, and it has THREE doors, all of which must behave identically:
//   - the guest's own empty-cart PUT      (routes/guest.js)
//   - the host's DELETE                   (routes/guest-orders.js, §UC-GSO-008)
//   - the admin's cancel                  (routes/guest-orders.js, 14 §UC-GR-005)
// They were three hand-written copies of the same two-column UPDATE, and the third
// had ALREADY DRIFTED: the guest door omitted the `<> 'cancelled'` predicate. That
// is exactly the failure this repo's "two copies is how one of them stops enforcing
// it" rule predicts, so the statement lives here now and nowhere else.
//
// What it does NOT own — deliberately, because it differs per door: the gates
// (cycle-open, terminal-cancelled, the host's `paid` refusal and D4's deliberate
// ABSENCE of that refusal for the admin), the error strings, and the enclosing
// transaction. Each caller keeps its own; this is only the write.
//
// SOFT: `status = 'cancelled'`, `total = 0`, and the `guest_order_items` rows are
// KEPT. The status predicate IS the release mechanism (helpers/stock.js's
// `COALESCE(status,'submitted') <> 'cancelled'`, and the filter every aggregate
// applies), so deleting the rows would release nothing extra while destroying the
// refund amount (`total` is 0 by then, so it is recomputed from these rows) and the
// record of what was ordered and then called off.
//
// `paid` / `paid_at` / `delivered` / `delivered_at` are untouched by construction:
// only two columns are ever named here.
//
// The WHERE predicate makes the write itself idempotent, so two doors racing (a
// guest emptying their cart while the admin cancels) cannot double-apply.
export function softCancelGuestOrder(id) {
  return db.prepare(`
    UPDATE guest_orders SET status = 'cancelled', total = 0
    WHERE id = ? AND COALESCE(status, 'submitted') <> 'cancelled'
  `).run(id).changes;
}

// A sub-order together with everything needed to authorize a host action on it:
// the owning host (via the link — `guest_orders` itself has no host column) and
// the cycle whose lock decides whether removal is still allowed.
export function findSubOrderWithLink(id) {
  return db.prepare(`
    SELECT gord.id, gord.link_id, gord.status, gord.paid, gord.delivered,
           glink.host_friend_id, glink.cycle_id, glink.active AS link_active,
           c.status AS cycle_status
    FROM guest_orders gord
    JOIN guest_order_links glink ON glink.id = gord.link_id
    LEFT JOIN order_cycles c ON c.id = glink.cycle_id
    WHERE gord.id = ?
  `).get(id);
}
