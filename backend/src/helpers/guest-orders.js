import db from '../db/schema.js';

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
// `order_token` is deliberately absent from every column list here: it is the
// guest's private status/edit URL and neither the host nor the admin ever needs
// it (GSO-T2 rule). Only routes/guest.js — where the token IS the credential —
// selects it.

const GUEST_ORDER_COLUMNS = `
  id, link_id, guest_name, guest_phone, guest_email, status, total,
  paid, paid_at, delivered, delivered_at, created_at
`;

// `guest_orders.status` is nullable with a 'submitted' DEFAULT, so never compare
// it bare — same reason helpers/stock.js wraps it in COALESCE.
export function guestOrderStatus(order) {
  return order?.status || 'submitted';
}

// The line items of the given sub-orders, attached in place as `items`.
// One query for the whole set (the host view renders every sub-order of a link,
// so a per-row query would be an N+1).
function attachItems(orders) {
  if (orders.length === 0) return orders;
  const placeholders = orders.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT gi.id, gi.guest_order_id, gi.product_id, gi.variant, gi.quantity, gi.price,
           p.name AS product_name, p.variant_label, p.purpose
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
    total: Math.round(total * 100) / 100,
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
