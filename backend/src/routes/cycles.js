import { Router } from 'express';
import db from '../db/schema.js';
import { variantToKg } from '../helpers/analytics.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { cycleSubOrdersByHost, guestOrderStatus } from '../helpers/guest-orders.js';

const router = Router();

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
  for (const it of items) {
    const roastery = it.roastery && it.roastery.trim() ? it.roastery : defaultName;
    if (!breakdownByCycle[it.cycle_id]) breakdownByCycle[it.cycle_id] = {};
    if (!breakdownByCycle[it.cycle_id][roastery]) {
      breakdownByCycle[it.cycle_id][roastery] = { name: roastery, total_kg: 0, total_value: 0 };
    }
    breakdownByCycle[it.cycle_id][roastery].total_kg += variantToKg(it.variant, it.quantity);
    breakdownByCycle[it.cycle_id][roastery].total_value += (it.price || 0) * it.quantity;
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
  const { password, friendId } = req.body;

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
  const { name, expected_date, type, bakery_product_ids, plan_note, status } = req.body;
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
    for (const bpId of bakery_product_ids) {
      const bp = db.get('SELECT * FROM bakery_products WHERE id = ? AND active = 1', [bpId]);
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
  const { status, name, shared_password, markup_ratio, expected_date, plan_note, parcel_enabled, parcel_fee } = req.body;
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

  const roasteryFilter = req.query.roastery;

  let summaryQuery = `
    SELECT p.name, p.purpose, p.description1, p.roast_type, p.variant_label, p.roastery, oi.variant, SUM(oi.quantity) as total_quantity,
           SUM(oi.quantity * oi.price) as total_price
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    WHERE o.cycle_id = ? AND o.status = 'submitted'
  `;
  const summaryParams = [req.params.id];

  if (roasteryFilter === '_default') {
    summaryQuery += ' AND (p.roastery IS NULL OR p.roastery = "")';
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
