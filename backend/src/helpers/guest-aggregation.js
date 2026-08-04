import db from '../db/schema.js';

// CYCLE-LEVEL guest line items — the one home for "which guest rows count toward
// this cycle's kilos and value?" (§UC-GSO-013, GSO-T8).
//
// ⚠ READ Decision 4 BEFORE USING THIS. Guest sub-orders live in their own tables
// precisely because many existing aggregations key on `orders` PER FRIEND — cycle
// progress (`submittedOrders`/`totalFriends`), analytics segmentation, the
// "who hasn't ordered" nudge list, vouchers, rewards. A guest is not a friend and
// must never appear as one nor inflate a friend count. So this helper is for
// CYCLE-LEVEL sums only (total kg, total value, roastery split, tier progress).
// Anything answering "who ordered / how many friends ordered / how active is this
// friend" must keep querying `orders` alone.
//
// The UNION shape is deliberately the same one helpers/stock.js
// (`orderedGramsByProduct`) and helpers/packing.js (`packingItemStats`) already
// use — `guest_order_items` → `guest_orders` → `guest_order_links` — so the three
// can never drift:
//   - the cycle comes from `guest_order_links.cycle_id` (a sub-order is attached
//     to a (host, cycle) pair, never to an `orders.id`);
//   - `guest_orders.status` is nullable with a 'submitted' DEFAULT, so it is
//     COALESCEd before the comparison. A bare `<> 'cancelled'` drops NULL-status
//     rows through SQL's three-valued logic — here that would silently UNDER-count
//     real kilos and could drop the cycle below a tier threshold;
//   - cancelled sub-orders keep their item rows (GSO-T4: the status predicate is
//     the mechanism, not deletion), so the predicate is what excludes a called-off
//     bag from the totals.
//
// `roastery` comes from the SAME cycle-snapshot `products` row a friend item joins
// (guest items store `product_id` into `products`), so the default-vs-other
// roastery split — which decides what counts toward the tier — classifies guest
// kilos exactly like friend kilos. `price` is the frozen marked-up unit price,
// built by the same `helpers/pricing.js applyMarkup()` as `order_items.price`, so
// summing the two together is apples-to-apples.
//
// The `products` columns come along because the admin's ordering sheet
// (`GET /api/cycles/:id/summary`) merges guest lines into the friend lines and needs
// the same metadata to render a guest-only line — a variant no friend ordered still
// has to be bought. Cycle-level callers that only want kilos simply ignore them.
//
// `host_friend_id` is selected but unused by the cycle-level callers: it is the
// attribution GSO-T9 (rewards/voucher volume credited to the host) needs, and
// leaving it in this one query keeps T9 from writing a fourth UNION.
//
// Weight: callers convert with `helpers/analytics.js variantToKg()` (kg, the unit
// every tier/margin figure around them is in). helpers/stock.js `VARIANT_GRAMS`
// is the *stock-limit* map in grams; do NOT introduce a third variant→weight map.
export function guestCycleItems(cycleIds) {
  const ids = [...new Set((cycleIds || []).map(Number))].filter((id) => Number.isFinite(id));
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT glink.cycle_id AS cycle_id,
           glink.host_friend_id AS host_friend_id,
           gord.id AS guest_order_id,
           gi.variant AS variant,
           gi.quantity AS quantity,
           gi.price AS price,
           gi.product_id AS product_id,
           p.roastery AS roastery,
           p.name AS name,
           p.purpose AS purpose,
           p.description1 AS description1,
           p.roast_type AS roast_type,
           p.variant_label AS variant_label
    FROM guest_order_items gi
    JOIN guest_orders gord ON gord.id = gi.guest_order_id
    JOIN guest_order_links glink ON glink.id = gord.link_id
    JOIN products p ON p.id = gi.product_id
    WHERE glink.cycle_id IN (${placeholders})
      AND COALESCE(gord.status, 'submitted') <> 'cancelled'
  `).all(...ids);
}
