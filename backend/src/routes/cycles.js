import { Router } from 'express';
import db from '../db/schema.js';
import { variantToKg } from '../helpers/analytics.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { cycleSubOrdersByHost, guestOrderStatus } from '../helpers/guest-orders.js';
import { guestCycleItems } from '../helpers/guest-aggregation.js';
import { bindValue } from '../helpers/bind-value.js';

const router = Router();

// The admin's ordering surfaces below (`roastery_breakdown` here, the "Podľa
// produktu" sheet in GET /:id/summary) count guest bags as well as friend ones
// (§UC-GSO-013). They have to: the bags are physically handed to guests at
// distribution (GSO-T7), so anything they leave out is coffee that was never bought.
//
// ⚠ Both merge the guest side IN JAVASCRIPT, from `guestCycleItems()`, and never by
// adding a JOIN to the SQL. That is not a style choice: these queries aggregate over
// `LEFT JOIN orders`, and a second join onto the guest tables multiplies every
// friend row by the number of guest sub-orders in the cycle (the GSO-T6 trap —
// `orders_count` and every SUM would inflate). Keeping the guest half out of the SQL
// makes multiplication impossible by construction.

// SQLite's `ORDER BY` on the summary sheet, reproduced for the merged array:
// purpose rank, then name, then variant — BINARY collation, NULLs first.
const SUMMARY_PURPOSE_RANK = { Espresso: 1, Filter: 2, Kapsule: 3 };

function purposeRank(purpose) {
  if (typeof purpose !== 'string') return 4;
  if (!Object.prototype.hasOwnProperty.call(SUMMARY_PURPOSE_RANK, purpose)) return 4;
  return SUMMARY_PURPOSE_RANK[purpose];
}

function compareSqlText(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

// True when this line belongs on the sheet the caller asked for. Mirrors the SQL
// WHERE the friend half applies: '_default' = no roastery set, a name = exact match,
// absent = everything.
function matchesRoasteryFilter(roastery, roasteryFilter) {
  if (!roasteryFilter) return true;
  if (roasteryFilter === '_default') return roastery === null || roastery === undefined || roastery === '';
  return roastery === roasteryFilter;
}

// Get all order cycles (admin)
router.get('/', requireAdmin, (req, res) => {
  // ⚠ The guest sub-orders join in as a CORRELATED SUBQUERY, never as a second
  // LEFT JOIN. This query aggregates over `LEFT JOIN orders`, so a second join onto
  // guest_orders would multiply every friend-order row by the number of guest
  // sub-orders in the cycle — `orders_count` and the `unpaid_count` friend term
  // would both inflate (the DISTINCT saves the id counts only if every CASE is
  // wrapped in it, and nothing would save a SUM). The subquery is evaluated once
  // per group and cannot touch the friend aggregate at all.
  //
  // §UC-GSO-010: guests owe the admin directly, so an unpaid guest sub-order is an
  // outstanding payment for the cycle exactly as an unpaid friend order is.
  // Cancelled sub-orders owe nothing — the same
  // `COALESCE(status,'submitted') <> 'cancelled'` predicate helpers/stock.js uses,
  // because `status` is nullable with a DEFAULT.
  const GUEST_UNPAID = `
    SELECT COUNT(*) FROM guest_orders gord
    JOIN guest_order_links glink ON glink.id = gord.link_id
    WHERE glink.cycle_id = c.id
      AND COALESCE(gord.status, 'submitted') <> 'cancelled'
      AND gord.paid = 0
  `;

  const cycles = db.prepare(`
    SELECT c.*,
           COUNT(DISTINCT CASE WHEN o.status = 'submitted' THEN o.id END) as orders_count,
           COUNT(DISTINCT CASE WHEN o.status = 'submitted' AND o.paid = 0 THEN o.id END)
             + (${GUEST_UNPAID}) as unpaid_count,
           (${GUEST_UNPAID}) as guest_unpaid_count
    FROM order_cycles c
    LEFT JOIN orders o ON o.cycle_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all();

  // Per-cycle roastery breakdown (coffee cycles only).
  // NULL/empty roastery is bucketed under the default roastery name.
  const defaultRoastery = db.prepare("SELECT name FROM roasteries WHERE is_default = 1").get();
  const defaultName = defaultRoastery ? defaultRoastery.name : 'Default';

  const items = db.prepare(`
    SELECT o.cycle_id, p.roastery, oi.variant, oi.quantity, oi.price
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON oi.product_id = p.id
    WHERE o.status = 'submitted'
  `).all();

  const breakdownByCycle = {};
  const addToBreakdown = (it) => {
    const roastery = it.roastery && it.roastery.trim() ? it.roastery : defaultName;
    if (!breakdownByCycle[it.cycle_id]) breakdownByCycle[it.cycle_id] = {};
    if (!breakdownByCycle[it.cycle_id][roastery]) {
      breakdownByCycle[it.cycle_id][roastery] = { name: roastery, total_kg: 0, total_value: 0 };
    }
    breakdownByCycle[it.cycle_id][roastery].total_kg += variantToKg(it.variant, it.quantity);
    breakdownByCycle[it.cycle_id][roastery].total_value += (it.price || 0) * it.quantity;
  };
  for (const it of items) {
    addToBreakdown(it);
  }
  // §UC-GSO-013: guest bags are bought from the same roastery as the friends' — this
  // breakdown is what the admin orders by. Added as a SECOND PASS over the same
  // accumulator (never as a JOIN — see the note at the top of this file), so the
  // friend rows above cannot be multiplied.
  for (const it of guestCycleItems(cycles.map((c) => c.id))) {
    addToBreakdown(it);
  }

  for (const cycle of cycles) {
    if (cycle.type !== 'coffee') {
      cycle.roastery_breakdown = [];
      continue;
    }
    const map = breakdownByCycle[cycle.id] || {};
    cycle.roastery_breakdown = Object.values(map)
      .map(r => ({
        name: r.name,
        total_kg: Math.round(r.total_kg * 10) / 10,
        total_value: Math.round(r.total_value * 100) / 100,
      }))
      .sort((a, b) => {
        if (a.name === defaultName) return -1;
        if (b.name === defaultName) return 1;
        return a.name.localeCompare(b.name);
      });
  }

  res.json(cycles);
});

// Get single cycle (admin — returns full row incl. shared_password)
router.get('/:id', requireAdmin, (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }
  res.json(cycle);
});

// Get public cycle info (no auth required) - for friend ordering page
router.get('/:id/public', (req, res) => {
  const cycle = db.prepare('SELECT id, name, status, markup_ratio, expected_date, type, plan_note, parcel_enabled, parcel_fee FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Return all active friends (global, not cycle-specific)
  const friends = db.prepare('SELECT id, name FROM friends WHERE active = 1 ORDER BY name').all();

  res.json({
    cycle,
    friends
  });
});

// Authenticate for cycle (validates password and friend selection)
router.post('/:id/auth', (req, res) => {
  // FUP-T13 — `friendId` is bound straight into the friend lookup below, so an
  // object/array/boolean raised a binder error ⇒ 500 + ~1.1 KB of stack. This route
  // is NOT admin-guarded (bare mount): anyone holding the cycle's shared password
  // could trigger it. `bindValue` yields `undefined`, which binds as NULL, matches no
  // friend and lands on the route's OWN 404 — the same answer an unknown id gets, so
  // no new oracle. The password check above it is untouched and still runs first.
  const { password } = req.body;
  const friendId = bindValue(req.body.friendId);

  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Check password
  if (!cycle.shared_password) {
    return res.status(400).json({ error: 'Heslo nie je nastavené pre tento cyklus' });
  }

  if (password !== cycle.shared_password) {
    return res.status(401).json({ error: 'Nesprávne heslo' });
  }

  // Validate friend exists and is active (global, no cycle check)
  const friend = db.prepare('SELECT id, name FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  res.json({
    success: true,
    friend
  });
});

// Create new order cycle (admin)
router.post('/', requireAdmin, (req, res) => {
  // FUP-T13 — every one of these is bound directly into the INSERT below, so any
  // non-bindable shape was a 500 + stack. `bindValue` maps such a value to
  // `undefined`, which better-sqlite3 binds as NULL — i.e. EXACTLY what an absent
  // field already stored, so no new branch and no new message. `name` then falls into
  // the route's existing `!name` refusal. `status` is enum-checked below and
  // `bakery_product_ids` is `Array.isArray`-gated, so neither needs this.
  const name = bindValue(req.body.name);
  const expected_date = bindValue(req.body.expected_date);
  const type = bindValue(req.body.type);
  const plan_note = bindValue(req.body.plan_note);
  const { bakery_product_ids, status } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nazov je povinny' });
  }

  const cycleType = type || 'coffee';
  const cycleStatus = status === 'planned' ? 'planned' : 'open';

  // Count active friends at the time of cycle creation
  const friendsCount = db.prepare('SELECT COUNT(*) as count FROM friends WHERE active = 1').get();
  const totalFriends = friendsCount.count;

  const result = db.prepare('INSERT INTO order_cycles (name, status, total_friends, expected_date, type, plan_note) VALUES (?, ?, ?, ?, ?, ?)').run(name, cycleStatus, totalFriends, expected_date || null, cycleType, plan_note || null);
  const cycleId = result.lastInsertRowid;

  // For bakery cycles, snapshot selected bakery products into the products table
  if (cycleType === 'bakery' && Array.isArray(bakery_product_ids) && bakery_product_ids.length > 0) {
    for (const rawId of bakery_product_ids) {
      // The ARRAY was checked, its ELEMENTS never were — `[{}]` / `[true]` bound
      // straight into this lookup and 500'd (FUP-T13).
      const bpId = bindValue(rawId);
      const bp = bpId === undefined ? null : db.get('SELECT * FROM bakery_products WHERE id = ? AND active = 1', [bpId]);
      if (!bp) continue;

      // Insert into cycle_bakery_products junction
      db.run('INSERT INTO cycle_bakery_products (cycle_id, bakery_product_id) VALUES (?, ?)', [cycleId, bp.id]);

      // Get active variants for this product
      const variants = db.all(
        'SELECT * FROM bakery_product_variants WHERE bakery_product_id = ? AND active = 1 ORDER BY sort_order',
        [bp.id]
      );

      // Snapshot each variant as its own products row
      const categoryLabel = bp.category === 'sladké' ? 'Sladké' : 'Slané';
      for (const variant of variants) {
        db.run(
          `INSERT INTO products (cycle_id, name, description1, description2, purpose, price_unit, weight_grams, composition, image, source_bakery_product_id, variant_label, source_variant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cycleId, bp.name, bp.description || null, bp.subtitle || null, categoryLabel, variant.price, variant.weight_grams || null, bp.composition || null, bp.image || null, bp.id, variant.label || null, variant.id]
        );
      }

      // Fallback: if product has no variants, snapshot with product-level data
      if (variants.length === 0) {
        db.run(
          `INSERT INTO products (cycle_id, name, description1, description2, purpose, price_unit, weight_grams, composition, image, source_bakery_product_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cycleId, bp.name, bp.description || null, bp.subtitle || null, categoryLabel, bp.price, bp.weight_grams || null, bp.composition || null, bp.image || null, bp.id]
        );
      }
    }
  }

  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(cycleId);
  res.status(201).json(cycle);
});

// Update cycle (lock/unlock/complete/password/markup_ratio/expected_date) (admin)
router.patch('/:id', requireAdmin, (req, res) => {
  // FUP-T13 — same binder hazard as POST, plus the half a status check cannot see:
  // an UPDATE that coerced an unbindable value to NULL would answer 200 while WIPING
  // the column. `bindValue` returns `undefined` for those, so every `!== undefined`
  // gate below SKIPS the write and the stored value survives; an EXPLICIT null still
  // returns `null` and still clears. `status` is enum-checked and `parcel_enabled` is
  // `? 1 : 0`, so neither is bound raw and neither is touched here.
  const name = bindValue(req.body.name);
  const shared_password = bindValue(req.body.shared_password);
  const markup_ratio = bindValue(req.body.markup_ratio);
  const expected_date = bindValue(req.body.expected_date);
  const plan_note = bindValue(req.body.plan_note);
  const parcel_fee = bindValue(req.body.parcel_fee);
  const { status, parcel_enabled } = req.body;
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);

  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  if (status && !['planned', 'open', 'locked', 'completed'].includes(status)) {
    return res.status(400).json({ error: 'Neplatny status' });
  }

  const updates = [];
  const values = [];

  if (status) {
    updates.push('status = ?');
    values.push(status);
  }
  if (name) {
    updates.push('name = ?');
    values.push(name);
  }
  if (shared_password !== undefined) {
    updates.push('shared_password = ?');
    values.push(shared_password || null);
  }
  if (markup_ratio !== undefined) {
    updates.push('markup_ratio = ?');
    values.push(markup_ratio);
  }
  if (expected_date !== undefined) {
    updates.push('expected_date = ?');
    values.push(expected_date || null);
  }
  if (plan_note !== undefined) {
    updates.push('plan_note = ?');
    values.push(plan_note || null);
  }
  if (parcel_enabled !== undefined) {
    updates.push('parcel_enabled = ?');
    values.push(parcel_enabled ? 1 : 0);
  }
  if (parcel_fee !== undefined) {
    updates.push('parcel_fee = ?');
    values.push(parcel_fee || 0);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.prepare(`UPDATE order_cycles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete cycle (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    // Clear voucher references first (FK without CASCADE)
    db.prepare('DELETE FROM vouchers WHERE source_cycle_id = ?').run(req.params.id);

    const result = db.prepare('DELETE FROM order_cycles WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Cyklus nebol najdeny' });
    }
    res.status(204).send();
  } catch (e) {
    console.error('Error deleting cycle:', e.message);
    res.status(500).json({ error: 'Chyba pri mazaní cyklu: ' + e.message });
  }
});

// Get order summary for cycle (for email to company) (admin)
router.get('/:id/summary', requireAdmin, (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }

  // FUP-T13 — `?roastery[a]=1` and a repeated `?roastery=` yield an object/array from
  // the qs parser and were bound into the WHERE below ⇒ 500. Unbindable ⇒ `undefined`
  // ⇒ the `!roasteryFilter` branch, i.e. the unfiltered sheet an absent param already
  // returns. The `'_default'` chip is a string and is unaffected.
  const roasteryFilter = bindValue(req.query.roastery);

  let summaryQuery = `
    SELECT p.id as product_id, p.name, p.purpose, p.description1, p.roast_type, p.variant_label, p.roastery, oi.variant, SUM(oi.quantity) as total_quantity,
           SUM(oi.quantity * oi.price) as total_price
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
  `;
  const summaryParams = [req.params.id];

  if (roasteryFilter === '_default') {
    // ⚠ SINGLE quotes. `""` is a QUOTED IDENTIFIER in SQLite, and unlike `"abc"`
    // (which falls back to a string literal) an empty one has no fallback: this
    // branch threw `no such column: ""` and 500'd the endpoint for every admin who
    // clicked the "hlavná pražiareň" filter chip. Pre-existing since the filter
    // shipped; found by GSO-T8's summary tests and fixed here because this row has to
    // honour the same filter for guest lines.
    summaryQuery += " AND (p.roastery IS NULL OR p.roastery = '')";
  } else if (roasteryFilter) {
    summaryQuery += ' AND p.roastery = ?';
    summaryParams.push(roasteryFilter);
  }

  summaryQuery += `
    GROUP BY p.id, oi.variant
    ORDER BY
      CASE p.purpose
        WHEN 'Espresso' THEN 1
        WHEN 'Filter' THEN 2
        WHEN 'Kapsule' THEN 3
        ELSE 4
      END,
      p.name, oi.variant
  `;

  const summary = db.prepare(summaryQuery).all(...summaryParams);

  // §UC-GSO-013 — guest bags belong on the sheet the admin orders with, MERGED into
  // the friend line for the same product + variant (a guest's 250g of X is not a
  // separate thing to buy). A variant no friend ordered becomes its own line, built
  // from the same `products` metadata the friend half selects.
  //
  // Cancelled sub-orders are excluded by `guestCycleItems()` — their item rows
  // survive the cancel (GSO-T4), and buying a called-off bag costs real money.
  const lineByKey = new Map();
  for (const item of summary) {
    lineByKey.set(`${item.product_id}|${item.variant}`, item);
  }
  let guestLinesAdded = false;
  for (const item of guestCycleItems([req.params.id])) {
    if (!matchesRoasteryFilter(item.roastery, roasteryFilter)) continue;
    const key = `${item.product_id}|${item.variant}`;
    const existing = lineByKey.get(key);
    if (existing) {
      existing.total_quantity += item.quantity;
      existing.total_price += item.quantity * (item.price || 0);
      continue;
    }
    const line = {
      product_id: item.product_id,
      name: item.name,
      purpose: item.purpose,
      description1: item.description1,
      roast_type: item.roast_type,
      variant_label: item.variant_label,
      roastery: item.roastery,
      variant: item.variant,
      total_quantity: item.quantity,
      total_price: item.quantity * (item.price || 0),
    };
    lineByKey.set(key, line);
    summary.push(line);
    guestLinesAdded = true;
  }
  // Only a NEW line can be out of place; merging into an existing one keeps the SQL
  // order intact. Sorting only when needed also keeps the guest-free response
  // byte-identical to what this endpoint returned before this task.
  if (guestLinesAdded) {
    summary.sort((a, b) =>
      purposeRank(a.purpose) - purposeRank(b.purpose)
      || compareSqlText(a.name, b.name)
      || compareSqlText(a.variant, b.variant)
    );
  }

  const totalItems = summary.reduce((acc, item) => acc + item.total_quantity, 0);
  const totalPrice = summary.reduce((acc, item) => acc + item.total_price, 0);

  // Get distinct roasteries used in this cycle
  const cycleRoasteries = db.prepare(`
    SELECT DISTINCT p.roastery FROM products p WHERE p.cycle_id = ? AND p.active = 1 AND p.roastery IS NOT NULL AND p.roastery != ''
  `).all(req.params.id).map(r => r.roastery);

  res.json({
    cycle,
    items: summary,
    totalItems,
    totalPrice,
    roasteries: cycleRoasteries
  });
});

// Get distribution list (per-friend orders for packing) (admin)
router.get('/:id/distribution', requireAdmin, (req, res) => {
  const cycle = db.prepare('SELECT * FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }

  // Get friends who have submitted orders for this cycle (global friends)
  // Include packed status and balance
  const friendsWithOrders = db.prepare(`
    SELECT f.id, f.name, o.id as order_id, o.status, o.paid, o.total, o.packed, o.packed_at,
           o.pickup_location_id, o.pickup_location_note, pl.name as pickup_location_name,
           o.delivery_fee, o.packeta_address,
           COALESCE((SELECT SUM(amount) FROM transactions WHERE friend_id = f.id), 0) as balance
    FROM orders o
    JOIN friends f ON f.id = o.friend_id
    LEFT JOIN pickup_locations pl ON pl.id = o.pickup_location_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
    ORDER BY f.name
  `).all(req.params.id);

  // GSO-T7 (§UC-GSO-011): the guest bags. Grouped per guest under their host so the
  // admin can pre-separate them, and CANCELLED sub-orders are dropped — a called-off
  // bag is neither handed over nor allowed to block the host's packing gate (the
  // same status predicate the gate in orders.js and helpers/stock.js use; the item
  // rows themselves survive a cancellation, GSO-T4).
  const subOrdersByHost = cycleSubOrdersByHost(req.params.id);
  const liveSubOrders = (hostFriendId) =>
    (subOrdersByHost.get(hostFriendId) || []).filter((sub) => guestOrderStatus(sub) !== 'cancelled');

  const distribution = friendsWithOrders.map(friend => {
    const items = db.prepare(`
      SELECT oi.id, oi.packed, p.name as product_name, p.purpose, p.roast_type, p.variant_label, oi.variant, oi.quantity, oi.price
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY
        CASE p.purpose
          WHEN 'Espresso' THEN 1
          WHEN 'Filter' THEN 2
          WHEN 'Kapsule' THEN 3
          ELSE 4
        END,
        p.name
    `).all(friend.order_id);

    return { ...friend, has_own_order: true, items, guest_orders: liveSubOrders(friend.id) };
  });

  // §Edge Cases, "host has no own order at lock time": the query above starts
  // `FROM orders`, so a host whose only stake is their colleagues' bags is invisible
  // to it — yet distribution still shows them as the PICKUP PARTY, because that is
  // who collects. Synthesised in here, the same way GSO-T6 does on the admin orders
  // tab (routes/orders.js).
  //
  // Such a row deliberately carries `order_id: null` / `has_own_order: false`: the
  // whole-order `packed` flag lives on `orders`, and there is no row to write it to.
  // Their packing record is the per-bag checkboxes alone, and the frontend offers no
  // "Zabaliť" for them (it would PATCH /api/orders/null/packed).
  //
  // "No own order" here means no SUBMITTED one — a host sitting on an unsubmitted
  // draft lands in this branch too, which is correct: a draft is not part of the
  // distribution and the whole-order endpoint refuses to pack it anyway.
  const listedFriends = new Set(distribution.map((party) => party.id));
  for (const hostFriendId of subOrdersByHost.keys()) {
    if (listedFriends.has(hostFriendId)) continue;
    const subOrders = liveSubOrders(hostFriendId);
    // Only cancelled bags left ⇒ nothing to hand over, so not a pickup party.
    if (subOrders.length === 0) continue;

    const balance = db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?'
    ).get(hostFriendId);

    distribution.push({
      id: hostFriendId,
      name: subOrders[0].host_name,
      order_id: null,
      has_own_order: false,
      status: 'none',
      paid: 0,
      total: 0,
      packed: 0,
      packed_at: null,
      pickup_location_id: null,
      pickup_location_note: null,
      pickup_location_name: null,
      delivery_fee: 0,
      packeta_address: null,
      balance: balance ? balance.balance : 0,
      items: [],
      guest_orders: subOrders
    });
  }

  distribution.sort((a, b) => a.name.localeCompare(b.name));

  res.json({ cycle, distribution });
});

export default router;
