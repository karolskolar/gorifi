import db from '../db/schema.js';

// Stock-limit accounting (`products.stock_limit_g`), shared by every caller that
// has to answer "how many grams of this product are already taken?".
//
// GSO-T3 turned that question into a UNION: friend orders (`order_items`) and
// guest sub-orders (`guest_order_items`, reached through `guest_orders` →
// `guest_order_links` for cycle scoping) draw from the SAME limited stock, so a
// guest order must reduce what a friend can buy and vice versa. The counting
// used to be copy-pasted in three places (products.js availability, orders.js
// cart PUT, orders.js submit), each `order_items`-only; it lives here now so the
// UNION can never drift between them — and so GSO-T7/T8 can reuse it.
//
// Which rows count:
//   - friend side: only `orders.status = 'submitted'` (a draft cart reserves
//     nothing, matching the behaviour before this refactor);
//   - guest side: every sub-order that is not `cancelled` (guest sub-orders are
//     created already submitted — there is no guest draft state). Link
//     deactivation deliberately does NOT release stock: existing sub-orders
//     survive a deactivated link, only new visits break.
//
// `guest_orders.status` is nullable, and in SQL's three-valued logic a bare
// `status != 'cancelled'` would silently DROP a NULL-status row — i.e. under-count
// grams and let stock through, the dangerous direction. Hence COALESCE. (The
// friend side is an equality test, `status = 'submitted'`, where a NULL row is
// correctly treated as not-yet-submitted, so it needs no such guard.)

// Variant → grams. Single source of truth (was inline in three places).
// Variants that are not OWN keys of this map (an unknown variant, or a bakery
// 'unit' line) score 0 g and therefore never participate in stock limits.
export const VARIANT_GRAMS = {
  '150g': 150, '200g': 200, '250g': 250, '500g': 500, '1kg': 1000, '20pc5g': 100,
};

// The variant is CLIENT-SUPPLIED on every order path, so this lookup must be
// own-property and type safe. A bare `VARIANT_GRAMS[variant] || 0` was not:
//   - a prototype key ('constructor', 'valueOf', 'toString', …) resolves to a
//     truthy FUNCTION, which passed the `perUnit <= 0` guard below, made
//     `perUnit * quantity` NaN, and turned the whole check into
//     `NaN > stock_limit_g` → false → "no violation". One junk line next to
//     legitimate ones disabled the limit for that product entirely (10 kg sold
//     against a 2 kg limit, reproduced end to end);
//   - a non-string key (e.g. `{ toString: 1 }`) throws on property coercion,
//     turning a 400 into a 500.
export function variantGrams(variant) {
  if (typeof variant !== 'string') return 0;
  if (!Object.prototype.hasOwnProperty.call(VARIANT_GRAMS, variant)) return 0;
  const grams = VARIANT_GRAMS[variant];
  return typeof grams === 'number' && Number.isFinite(grams) ? grams : 0;
}

// Quantities are client-supplied too: only real numbers and numeric strings
// count. `Number(value)` alone would throw on an object with a non-callable
// `toString`, and NaN must never reach the arithmetic below.
function safeQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// [{ product_id, variant, quantity }] → { [productId]: grams }
// Every accumulated value is guaranteed finite: a non-finite line is skipped
// rather than propagated, so no future edit to VARIANT_GRAMS can reopen the
// NaN-defeats-the-comparison hole described above.
export function gramsByProductFromItems(items) {
  const grams = {};
  for (const item of Array.isArray(items) ? items : []) {
    const quantity = safeQuantity(item?.quantity);
    const perUnit = variantGrams(item?.variant);
    if (quantity <= 0 || perUnit <= 0) continue;
    const productId = Number(item.product_id);
    if (!Number.isFinite(productId)) continue;
    const lineGrams = perUnit * quantity;
    if (!Number.isFinite(lineGrams)) continue;
    grams[productId] = (grams[productId] || 0) + lineGrams;
  }
  return grams;
}

// Grams already claimed per product in this cycle, friend + guest combined.
//
// `excludeFriendId`     — ignore that friend's own submitted order (their new
//                         cart replaces it, so it must not block itself).
// `excludeGuestOrderId` — the guest-side equivalent, for editing an existing
//                         sub-order (GSO-T4).
export function orderedGramsByProduct(cycleId, productIds, { excludeFriendId, excludeGuestOrderId } = {}) {
  const ids = [...new Set((productIds || []).map(Number))].filter((id) => Number.isFinite(id));
  const totals = {};
  if (ids.length === 0) return totals;

  const placeholders = ids.map(() => '?').join(',');
  const params = [];

  let friendWhere = '';
  if (excludeFriendId !== undefined && excludeFriendId !== null && excludeFriendId !== '') {
    friendWhere = ' AND o.friend_id != ?';
  }
  let guestWhere = '';
  if (excludeGuestOrderId !== undefined && excludeGuestOrderId !== null && excludeGuestOrderId !== '') {
    guestWhere = ' AND gord.id != ?';
  }

  const sql = `
    SELECT product_id, variant, SUM(quantity) AS total_qty FROM (
      SELECT oi.product_id AS product_id, oi.variant AS variant, oi.quantity AS quantity
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.cycle_id = ? AND o.status = 'submitted' AND oi.product_id IN (${placeholders})${friendWhere}
      UNION ALL
      SELECT gi.product_id AS product_id, gi.variant AS variant, gi.quantity AS quantity
      FROM guest_order_items gi
      JOIN guest_orders gord ON gord.id = gi.guest_order_id
      JOIN guest_order_links glink ON glink.id = gord.link_id
      WHERE glink.cycle_id = ? AND COALESCE(gord.status, 'submitted') <> 'cancelled'
        AND gi.product_id IN (${placeholders})${guestWhere}
    )
    GROUP BY product_id, variant
  `;

  params.push(cycleId, ...ids);
  if (friendWhere) params.push(excludeFriendId);
  params.push(cycleId, ...ids);
  if (guestWhere) params.push(excludeGuestOrderId);

  for (const row of db.prepare(sql).all(...params)) {
    const productId = Number(row.product_id);
    totals[productId] = (totals[productId] || 0) + variantGrams(row.variant) * row.total_qty;
  }
  return totals;
}

// Human-readable Slovak violations for the products in `gramsByProduct` whose
// stock limit the request would breach. Empty array = the request fits.
// Message shape is unchanged from the original inline checks.
//
// ⚠ CONCURRENCY: every caller runs this check OUTSIDE the transaction that then
// writes the items (both the friend paths in orders.js and the guest path in
// guest.js). That is only safe because the app runs single-process
// (`instances: 1` in deploy/ecosystem.config.cjs) and these handlers are fully
// synchronous, so no second request can interleave between check and insert.
// Switching PM2 to cluster mode WOULD REOPEN OVERSELLING — the check would have
// to move inside the write transaction first.
export function stockViolations(cycleId, gramsByProduct, options = {}) {
  const ids = Object.keys(gramsByProduct || {}).map(Number).filter((id) => Number.isFinite(id));
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const limitedProducts = db.prepare(
    `SELECT id, name, stock_limit_g FROM products WHERE id IN (${placeholders}) AND stock_limit_g IS NOT NULL`
  ).all(...ids);
  if (limitedProducts.length === 0) return [];

  const ordered = orderedGramsByProduct(cycleId, limitedProducts.map((p) => p.id), options);

  const violations = [];
  for (const product of limitedProducts) {
    const existingGrams = ordered[product.id] || 0;
    const requestedGrams = gramsByProduct[product.id] || 0;
    // Negated `<=` rather than `>` so that a non-finite total (which should now
    // be impossible — see gramsByProductFromItems) FAILS CLOSED as a violation
    // instead of silently reporting "fits".
    if (!(existingGrams + requestedGrams <= product.stock_limit_g)) {
      const remainingG = Math.max(0, product.stock_limit_g - existingGrams);
      violations.push(`${product.name}: zostáva ${remainingG}g z ${product.stock_limit_g}g`);
    }
  }
  return violations;
}

// Per-product availability for every stock-limited product in a cycle.
// Shape is the contract of GET /api/products/cycle/:cycleId/availability and is
// also embedded in the guest payload.
export function cycleAvailability(cycleId, options = {}) {
  const limitedProducts = db.prepare(
    'SELECT id, stock_limit_g FROM products WHERE cycle_id = ? AND active = 1 AND stock_limit_g IS NOT NULL'
  ).all(cycleId);
  if (limitedProducts.length === 0) return [];

  const ordered = orderedGramsByProduct(cycleId, limitedProducts.map((p) => p.id), options);

  return limitedProducts.map((product) => {
    const orderedGrams = ordered[product.id] || 0;
    return {
      product_id: product.id,
      stock_limit_g: product.stock_limit_g,
      ordered_g: orderedGrams,
      remaining_g: Math.max(0, product.stock_limit_g - orderedGrams),
    };
  });
}
