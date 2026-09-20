import { Router } from 'express';
import db from '../db/schema.js';
import { variantToKg } from '../helpers/analytics.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { cycleSubOrdersByHost, guestOrderStatus, loadSubOrder } from '../helpers/guest-orders.js';
import { guestCycleItems } from '../helpers/guest-aggregation.js';
import { bindValue } from '../helpers/bind-value.js';
import { roundMoney } from '../helpers/pricing.js';
import { readPickup } from '../helpers/pickup.js';
import { packingItemStats } from '../helpers/packing.js';
import { deliveryOf, deliveryGroupOrder, TARGET_LABELS } from '../helpers/delivery.js';
import {
  orderStage,
  guestOrderStage,
  readHandOverBatch,
  partyDelivery,
  inheritingGuests,
} from '../helpers/handover.js';
import { enqueueForHandOver } from '../helpers/outbox.js';
import { markCycleReady } from '../helpers/cycle-stage.js';

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

// ─── the distribution payload's derived fields (DP-T2, 16 §UC-DP-003) ────────
//
// ⚠ EVERYTHING BELOW IS COMPUTED IN JAVASCRIPT OVER ROWS THE EXISTING QUERIES
// ALREADY RETURN. That is the whole point: the guest half of a party's weight and
// of the cycle's plan comes from the sub-orders `cycleSubOrdersByHost()` already
// nested under their host, never from a second `LEFT JOIN` onto `orders`. A join
// would multiply each friend row by that host's sub-order count — one host would
// become three parties, `totals.count` and every plan card would inflate, and the
// host's OWN grams would be counted once per colleague (CLAUDE.md §Money & data,
// the GSO-T6/T8 trap, and the same rule the roastery breakdown above states at
// length). Doing it here makes the multiplication impossible by construction.
//
// ⚠ The field is called `kg` and it carries GRAMS — §UC-DP-003's wording, and the
// unit the client's `Math.round(g/10)/100` display rule expects. `variantToKg()`
// (helpers/analytics.js) stays the one weight authority; the ×1000 is rounded per
// LINE so the binary dust of 0.096 × 3 × 1000 never reaches the payload. A variant
// the map does not know — a bakery `unit` line, an unknown string, or a prototype
// key like `'constructor'`, which makes that lookup yield a FUNCTION and the
// product NaN — scores 0 g, the `variantGrams()` fail-closed posture.
function lineGrams(variant, quantity) {
  const kg = variantToKg(variant, quantity);
  return Number.isFinite(kg) ? Math.round(kg * 1000) : 0;
}

function itemsGrams(items) {
  let grams = 0;
  for (const item of Array.isArray(items) ? items : []) {
    grams += lineGrams(item?.variant, item?.quantity);
  }
  return grams;
}

const LOC_KEY = /^loc([1-9][0-9]*)$/;

/** `loc<id>` → the integer id, anything else → null. */
function locIdOf(targetKey) {
  const hit = LOC_KEY.exec(targetKey);
  return hit ? Number(hit[1]) : null;
}

// ⚠ `guestStage()` and the friend half of `partyStage()` MOVED to
// `helpers/handover.js` in DP-T3 (as `guestOrderStage()` / `orderStage()`), because
// the hand-over routes answer the same `stage` in their mutation payloads. Two
// copies is how the row the board patches in place stops agreeing with the row a
// reload fetches. The synthetic-host branch below stays here: it is the board's own
// derivation and has no mutation counterpart.

/**
 * The synthetic host's hand-over, DERIVED: they have no `orders` row to stamp, so
 * their bag has left only when every LIVE sub-order in it has (the cancelled ones
 * are already filtered out of `guest_orders[]`). Timestamps are SQLite
 * `YYYY-MM-DD HH:MM:SS`, which sorts lexicographically, so no Date parsing.
 */
function derivedHandedOver(subOrders) {
  if (!Array.isArray(subOrders) || subOrders.length === 0) return null;
  let max = null;
  for (const sub of subOrders) {
    if (!sub.handed_over_at) return null;
    if (max === null || String(sub.handed_over_at) > String(max)) max = sub.handed_over_at;
  }
  return max;
}

/**
 * A party's stage. `handed` wins over `packed` (it implies it), and the two kinds of
 * party read DIFFERENT sources on purpose: a friend with an own order reads
 * `orders.packed` — the column the ledger moment writes (helpers/packing.js) — while
 * a synthetic host has no such column and is measured by `packingItemStats()`, the
 * SAME union `PATCH /orders/:id/packed` gates on. Re-deriving either here would be a
 * second home for the pack rule.
 */
function partyStage(party, cycleId) {
  if (party.handed_over_at) return 'handed';
  if (party.has_own_order) return orderStage(party);
  const stats = packingItemStats({ orderId: null, friendId: party.id, cycleId });
  const total = Number(stats?.total || 0);
  const packedCount = Number(stats?.packed_count || 0);
  return total > 0 && packedCount === total ? 'packed' : 'to_pack';
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
        total_value: roundMoney(r.total_value),
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
  const { bakery_product_ids, coffee_product_ids, status } = req.body;
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

  // PC-T8 (12 §UC-PC-012): for COFFEE cycles, snapshot selected CATALOG products
  // — the sibling of the bakery branch above, never a rewrite of it. Honoured
  // only when the cycle's type resolves to 'coffee'; `coffee_product_ids` is
  // OPTIONAL on purpose (an id-less coffee POST keeps today's empty-cycle
  // behavior, so existing fixtures and scripted creation stay valid).
  //
  // NO junction table (resolved decision): a coffee catalog product snapshots to
  // exactly ONE row per cycle (variants are price columns), so
  // `source_coffee_product_id` IS the selection record — bakery needs
  // `cycle_bakery_products` only because its variant explosion breaks the 1:1.
  //
  // Per id: only `status = 'available'` rows snapshot — a missing or RETIRED
  // row is skipped exactly as the bakery loop's `if (!bp) continue`, so retired
  // products can never enter a new cycle even by hand-crafted request. All six
  // prices are COPIED from the catalog's current prices — THIS is the freeze
  // moment (later catalog edits never touch existing snapshots). `image` stays
  // NULL (resolved decision 5: the read-path COALESCE serves the catalog image)
  // and `stock_limit_g` stays NULL (per-cycle, set later via the snapshot PATCH).
  if (cycleType === 'coffee' && Array.isArray(coffee_product_ids) && coffee_product_ids.length > 0) {
    for (const rawId of coffee_product_ids) {
      // The ARRAY was checked, its ELEMENTS never were (the FUP-T13 lesson on
      // the bakery loop) — `[{}]` / `[true]` must skip, never 500.
      const cpId = bindValue(rawId);
      const cp = cpId === undefined || cpId === null
        ? null
        : db.get("SELECT * FROM coffee_products WHERE id = ? AND status = 'available'", [cpId]);
      if (!cp) continue;

      db.run(
        `INSERT INTO products (cycle_id, name, description1, description2, roast_type, purpose, roastery,
           price_150g, price_200g, price_250g, price_500g, price_1kg, price_20pc5g, price_8pc12g,
           image, stock_limit_g, source_coffee_product_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [
          cycleId, cp.name, cp.description1, cp.description2, cp.roast_type, cp.purpose, cp.roastery,
          cp.price_150g, cp.price_200g, cp.price_250g, cp.price_500g, cp.price_1kg, cp.price_20pc5g, cp.price_8pc12g,
          cp.id,
        ]
      );
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
    // Rounded at the write: `orders.delivery_fee` is COPIED from this column on every
    // parcel submit, and the client's `paymentTotal` adds it to the order total before
    // the Pay-by-Square encode — so noise here reaches a bank, not just a screen.
    values.push(roundMoney(parcel_fee || 0));
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
    SELECT f.id, f.name, f.phone, o.id as order_id, o.status, o.paid, o.total, o.packed, o.packed_at,
           o.handed_over_at,
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

    // ⚠ `phone` rides along with the balance rather than in a second query: this
    // branch is already per-host, and the Packeta row and the label sheet both need
    // the number (§UC-DP-003).
    const balance = db.prepare(`
      SELECT f.phone AS phone,
             COALESCE((SELECT SUM(amount) FROM transactions WHERE friend_id = f.id), 0) AS balance
        FROM friends f WHERE f.id = ?
    `).get(hostFriendId);

    distribution.push({
      id: hostFriendId,
      name: subOrders[0].host_name,
      phone: balance ? balance.phone : null,
      order_id: null,
      has_own_order: false,
      status: 'none',
      paid: 0,
      total: 0,
      packed: 0,
      packed_at: null,
      // ⚠ NOT a column on this party — there is no `orders` row to stamp. It is
      // DERIVED below from the live sub-orders (§UC-DP-003), and declared here only
      // so the key exists in the same position as on a friend party.
      handed_over_at: null,
      // ⚠ THE EFFECTIVE PICKUP, not a hardcoded null (PO decision, 2026-09-03). This
      // party collects their colleagues' bags, so the picking sheet has to say where
      // — the reported bug was this row showing no pickup point at all.
      //
      // ⚠ Read through `helpers/pickup.js`, the SAME resolution the write uses. It
      // matters here specifically: this branch is reached whenever there is no
      // SUBMITTED order, which includes a host sitting on a DRAFT — and that draft IS
      // an `orders` row, so its pickup is the one that counts. Hardcoding the link
      // here would show a different place than the orders tab does for the same party.
      ...readPickup(req.params.id, hostFriendId),
      delivery_fee: 0,
      packeta_address: null,
      balance: balance ? balance.balance : 0,
      items: [],
      guest_orders: subOrders
    });
  }

  distribution.sort((a, b) => a.name.localeCompare(b.name));

  // ── DP-T2 (§UC-DP-003): delivery, stage, weight, and the cycle's plan ───────
  //
  // Everything from here down is ADDITIVE. Not one key above is renamed, retyped or
  // dropped — `guest-distribution.spec.js` and `order-pickup-edit.spec.js` read this
  // payload and must keep passing untouched.

  // ⚠ ONE query for the whole (small) table, not one lookup per party. It is both
  // the N+1 escape `helpers/delivery.js` documents (`locationsById`) and the source
  // of `locations[]`, and it is deliberately UNFILTERED: a point that was
  // soft-deleted after a party chose it must still name itself, exactly as
  // `pickupOf()` and `delivery.js locationRow()` both do.
  const locationRows = db.prepare('SELECT id, name, address, active, for_coffee, for_bakery FROM pickup_locations').all();
  const locationsById = new Map(locationRows.map((row) => [row.id, row]));

  // "Active for this cycle's type" — the same filter the friend's picker applies
  // (`GET /api/pickup-locations?type=…`). These are the points that get a plan card
  // even with nobody on them, so the admin can tell "no bags there" apart from
  // "that point is not set up".
  const isBakery = (cycle.type || 'coffee') === 'bakery';
  const activeIds = new Set(
    locationRows.filter((row) => row.active && (isBakery ? row.for_bakery : row.for_coffee)).map((row) => row.id)
  );

  for (const party of distribution) {
    // The pickup columns on the row are the ones `helpers/pickup.js` already
    // resolved (the SELECT for a friend, `readPickup()` for a synthetic host), so
    // this only NAMES what is there — `delivery.js` is read-only by contract.
    party.delivery = deliveryOf(party, { locationsById });

    let guestGrams = 0;
    for (const sub of party.guest_orders) {
      // ⚠ `{ host: party.delivery }` IS THE CALL-SITE CONTRACT (DP-T1). A guest bag
      // without its own Packeta address travels inside the host's bag, so it must
      // inherit the host's group — never be classified standalone, which is what
      // would make it tickable on its own on the board. The helper fails closed if
      // this is omitted; that backstop is not a licence to omit it.
      sub.delivery = deliveryOf(sub, { host: party.delivery, locationsById });
      sub.kg = itemsGrams(sub.items);
      sub.stage = guestOrderStage(sub);
      guestGrams += sub.kg;
    }

    // ⚠ CYCLE-LEVEL weight includes guests — this is the bag the admin carries, and
    // `guest_orders` here is already the LIVE set (cancelled bags filtered out
    // above), so a called-off order weighs nothing. Per-FRIEND aggregates elsewhere
    // (cycle progress, analytics, rewards) still must not fold guests in.
    party.kg = itemsGrams(party.items) + guestGrams;

    if (!party.has_own_order) {
      party.handed_over_at = derivedHandedOver(party.guest_orders);
    }
    party.stage = partyStage(party, cycle.id);
  }

  // ── plan / totals / locations ───────────────────────────────────────────────
  // Counts are over PARTIES: a host with nested `via_host` guests is ONE bag.
  const partiesByKey = new Map();
  const referencedIds = new Set();
  for (const party of distribution) {
    const key = party.delivery.target_key;
    if (!partiesByKey.has(key)) partiesByKey.set(key, []);
    partiesByKey.get(key).push(party);
    const locId = locIdOf(key);
    if (locId !== null) referencedIds.add(locId);
  }

  // ⚠ A DANGLING id (the `pickup_locations` row is gone outright) keeps its key and
  // loses only its label. Dropping such a party from the plan would hide a real bag,
  // so it is ordered in like any other.
  //
  // ⚠ ~~Reachable today, because `DELETE /api/pickup-locations/:id` only soft-deletes
  // when an `orders` row references the point, and a host with no own order stores
  // their pickup on `guest_order_links`.~~ **FIXED by FUP-T23** — that delete now asks
  // `helpers/pickup.js pickupLocationInUse()`, which knows BOTH stores, so no API
  // path produces a dangling id any more. The tolerance STAYS: databases written
  // before the fix still carry dangling ids, and a bag must never be dropped over a
  // missing label. (The e2e fixture for it is now a DB_PATH-gated direct write —
  // `distribution-handover.spec.js`.)
  const planLocationIds = [...new Set([...referencedIds, ...activeIds])];
  const orderedKeys = deliveryGroupOrder(planLocationIds.map((id) => ({ id })));

  const plan = [];
  for (const key of orderedKeys) {
    const parties = partiesByKey.get(key) || [];
    const locId = locIdOf(key);
    // Packeta and "Osobne" are not configurable places: they appear only when a bag
    // is actually going that way. A pickup point appears when it is active for this
    // cycle's type, even at zero.
    if (parties.length === 0 && !(locId !== null && activeIds.has(locId))) continue;

    let label;
    if (parties.length > 0) {
      // Taken from the party so a group title can never disagree with the row under it.
      label = parties[0].delivery.target_label;
    } else {
      label = locId !== null ? (locationsById.get(locId)?.name ?? null) : TARGET_LABELS[key];
    }

    plan.push({
      target_key: key,
      target_label: label ?? null,
      type: locId !== null ? 'pickup' : key,
      count: parties.length,
      // ⚠ `packed_count` INCLUDES the handed-over parties (handed implies packed):
      // the board's two-tone bar is `handed / count` plus `(packed − handed) / count`
      // (§UC-DP-010), which only adds up while this is a superset.
      packed_count: parties.filter((party) => party.stage === 'packed' || party.stage === 'handed').length,
      handed_count: parties.filter((party) => party.stage === 'handed').length,
      kg: parties.reduce((sum, party) => sum + party.kg, 0),
    });
  }

  const totals = {
    count: distribution.length,
    packed_count: distribution.filter((party) => party.stage === 'packed' || party.stage === 'handed').length,
    handed_count: distribution.filter((party) => party.stage === 'handed').length,
  };

  // The names behind the `loc<id>` keys, so the board needs no second call. A
  // dangling id has no row and simply is not here — the plan card above already
  // renders it label-less. The picker keeps its own `GET /api/pickup-locations`
  // call: that one is the EDITABLE list and is filtered to active points.
  const locations = planLocationIds
    .map((id) => locationsById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id)
    .map((row) => ({ id: row.id, name: row.name, address: row.address }));

  res.json({ cycle, distribution, plan, totals, locations });
});

// Admin: STAGE 3 IN BULK — „Odovzdať zabalené (n)" for a whole group
// (DP-T4, 16 §UC-DP-006). ONE transaction, all-or-nothing.
//
// It is the per-group button behind the board's plan cards: every bag at one
// pickup point, or every Packeta parcel, leaves in one action. The per-bag routes
// (`PATCH /orders/:id/handed-over`, `PATCH /guest-orders/:id/handed-over`, DP-T3)
// stay the unit of CORRECTION; this is the unit of WORK.
//
// ⚠ **ALL-OR-NOTHING, AND THE 409 NAMES THE OFFENDERS.** The admin confirmed
// „n balíčkov prejde" against a SNAPSHOT the board fetched seconds ago. If another
// device un-packed one of them in between, a partial success would leave the toast
// count wrong and one bag silently behind — with no screen anywhere that says which.
// So the whole batch aborts, the response lists exactly the ids that blocked it, and
// the admin reloads and decides. Every refusal below is reached BEFORE the first
// write, and the writes themselves abort by THROWING, so the transaction rolls back
// rather than relying on the order of the statements staying as it is today.
//
// ⚠ **ONE TIMESTAMP FOR THE WHOLE BATCH**, read once and bound to every UPDATE. The
// plan card's „odovzdané" bar and module 21's segments group by it, and two bags
// that left together must not land a second apart in the record.
//
// ⚠ **ALREADY-HANDED IDS ARE SKIPPED, NOT ERRORS** — re-running a group after
// adding one bag to it is the normal way this button is used. A skipped bag is
// counted in `already_handed` and **mints nothing**: `enqueueForHandOver` only ever
// sees the bags this call actually STAMPED. That is DP-T3's lesson applied here —
// the dedupe on a `queued` row holds only until module 21 moves one to `released`,
// after which an enqueue for a no-op would be a duplicate „your coffee is at X"
// message to a real person, for a request that changed nothing.
//
// ⚠ **NO `transactions` ROW, EVER, AND NO `await`.** Stage 2 (`packed`) is the
// ledger moment (`helpers/packing.js`); stage 3 is ledger-neutral by construction,
// in bulk exactly as per bag. The handler is fully synchronous, which is what keeps
// the check-then-write atomic under `instances: 1` (CLAUDE.md, GA-T8).
//
// ⚠ **REVERSAL IS NOT BULK.** Un-hand-over stays per bag (§UC-DP-004/005); a bulk
// reversal is a Phase 2 item and is deliberately NOT implemented here.
//
// ⚠ RECORDED FOR THE BOARD ROWS (DP-T5/T6/T7), because it decides WHICH ids the
// group button should send:
//   • A guest listed EXPLICITLY in `guest_order_ids` with an unchecked item aborts
//     the whole batch — while the same bag merely INHERITED from its host in the
//     same batch goes through, because inheritance has no pack gate (§UC-DP-004).
//     That asymmetry is literally what §UC-DP-005/006 mandate, and it is narrow,
//     but it means „send every id I can see" is NOT equivalent to „send the hosts".
//     The group button should send the party ids (orders, plus the guest ids of
//     synthetic hosts) rather than every nested guest row it happens to render.
//   • The work here is LINEAR in the number of ids and fully synchronous — a few
//     indexed statements per bag inside one transaction that blocks every other
//     request under `instances: 1`. `HAND_OVER_BATCH_MAX` is what bounds it.
//
// Status codes:
//   400 — the body is not `{ order_ids: int[], guest_order_ids: int[] }` with at
//         least one id, or an id belongs to another cycle / does not exist
//         (`reason: 'foreign_id'`, both lists echoed)
//   404 — unknown cycle
//   409 — `not_packed` (an unpacked or non-submitted order, or a guest bag with no
//         items or an unchecked one) / `cancelled` (a called-off guest bag, listed
//         separately), naming every offender; NOTHING is written
//   200 — `{ handed_over, already_handed, guests_inherited, queued_notifications,
//         cycle_stage, handed_over_at }`
router.post('/:id/distribution/hand-over', requireAdmin, (req, res) => {
  const batch = readHandOverBatch(req.body);
  if (!batch) {
    return res.status(400).json({
      error: 'Zadajte, ktoré balíčky sa odovzdávajú',
      reason: 'invalid_ids',
    });
  }

  const cycle = db.prepare('SELECT id FROM order_cycles WHERE id = ?').get(req.params.id);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol nájdený' });
  }
  const cycleId = cycle.id;

  // ⚠ THE ABORT IS A THROW, NOT A RETURN. better-sqlite3 commits a transaction that
  // returns normally, so a refusal discovered after the first UPDATE would COMMIT
  // the bags written before it — the partial success this route exists to prevent.
  // Throwing rolls the whole thing back whatever the statement order, which makes
  // all-or-nothing structural instead of a property of how this function is written.
  class BatchRefusal extends Error {
    constructor(status, body) {
      super('hand-over batch refused');
      this.status = status;
      this.body = body;
    }
  }

  const apply = db.transaction(() => {
    // ── 1. resolve every id, and refuse a FOREIGN one before anything else ────
    // „Foreign" covers an id from another cycle AND one that does not exist: both
    // answer the same 400, so the endpoint is not an existence oracle for rows in
    // cycles the caller did not name.
    const readOrder = db.prepare(`
      SELECT id, friend_id, cycle_id, status, packed, handed_over_at
        FROM orders WHERE id = ?
    `);
    const readGuest = db.prepare(`
      SELECT gord.id, gord.link_id, gord.status, gord.handed_over_at,
             glink.host_friend_id, glink.cycle_id
        FROM guest_orders gord
        JOIN guest_order_links glink ON glink.id = gord.link_id
       WHERE gord.id = ?
    `);

    const orderRows = new Map();
    const guestRows = new Map();
    const foreignOrderIds = [];
    const foreignGuestIds = [];

    for (const id of batch.orderIds) {
      const row = readOrder.get(id);
      if (!row || row.cycle_id !== cycleId) foreignOrderIds.push(id);
      else orderRows.set(id, row);
    }
    for (const id of batch.guestOrderIds) {
      const row = readGuest.get(id);
      if (!row || row.cycle_id !== cycleId) foreignGuestIds.push(id);
      else guestRows.set(id, row);
    }
    if (foreignOrderIds.length > 0 || foreignGuestIds.length > 0) {
      throw new BatchRefusal(400, {
        error: 'Niektoré balíčky nepatria do tohto cyklu',
        reason: 'foreign_id',
        order_ids: foreignOrderIds,
        guest_order_ids: foreignGuestIds,
      });
    }

    // ── 2. the OFFENDERS, all of them, before the first write ─────────────────
    // An already-handed bag is checked FIRST and skipped: it has demonstrably left,
    // so re-asking „is it packed?" would refuse a re-run of a group over something
    // that is already done. (It also covers the recorded seam where a bag was
    // cancelled AFTER it was handed over — see the note at the end of this handler.)
    const notPackedOrderIds = [];
    const notPackedGuestIds = [];
    const cancelledGuestIds = [];

    for (const id of batch.orderIds) {
      const row = orderRows.get(id);
      if (row.handed_over_at) continue;
      // A non-submitted order cannot be packed at all, so it is an offender for the
      // same reason and with the same reason string (§UC-DP-006).
      if (row.status !== 'submitted' || !row.packed) notPackedOrderIds.push(id);
    }
    for (const id of batch.guestOrderIds) {
      const row = guestRows.get(id);
      if (row.handed_over_at) continue;
      if (guestOrderStatus(row) === 'cancelled') { cancelledGuestIds.push(id); continue; }
      // The pack gate, asked of the SHARED stage rule (helpers/handover.js) rather
      // than re-derived here: a bag is packable only when it HAS items and every one
      // is checked off. The same rule is re-asserted as the UPDATE's own predicate
      // below — this half is what produces the NAMED offender.
      if (guestOrderStage(loadSubOrder(id)) === 'to_pack') notPackedGuestIds.push(id);
    }

    if (notPackedOrderIds.length > 0 || notPackedGuestIds.length > 0 || cancelledGuestIds.length > 0) {
      const onlyCancelled =
        notPackedOrderIds.length === 0 && notPackedGuestIds.length === 0;
      throw new BatchRefusal(409, {
        error: onlyCancelled
          ? 'Zrušené objednávky kolegov sa nedajú odovzdať.'
          : 'Najprv označte všetky balíčky ako zabalené',
        reason: onlyCancelled ? 'cancelled' : 'not_packed',
        order_ids: notPackedOrderIds,
        guest_order_ids: notPackedGuestIds,
        // Listed SEPARATELY (§UC-DP-006): „not packed yet" is a thing the admin
        // fixes by packing, „cancelled" is a bag that will never be handed to
        // anybody. The board highlights them differently.
        cancelled_guest_order_ids: cancelledGuestIds,
      });
    }

    // ── 3. the writes ─────────────────────────────────────────────────────────
    // ONE timestamp, read once. `CURRENT_TIMESTAMP` is the same expression the
    // per-bag routes stamp with, so the two writers produce byte-identical strings.
    const stamp = db.prepare('SELECT CURRENT_TIMESTAMP AS stamp').get().stamp;

    const stampOrder = db.prepare(`
      UPDATE orders SET handed_over_at = ?
       WHERE id = ? AND status = 'submitted' AND packed = 1 AND handed_over_at IS NULL
    `);
    const stampInheritedGuest = db.prepare(
      'UPDATE guest_orders SET handed_over_at = ? WHERE id = ? AND handed_over_at IS NULL'
    );
    // The per-bag gate of §UC-DP-005, as the UPDATE's OWN predicate — the same
    // statement `PATCH /guest-orders/:id/handed-over` runs. ⚠ `COALESCE(packed, 0)`
    // because the column is nullable: a bare `packed = 0` drops NULL rows in SQL's
    // three-valued logic, which is the dangerous direction (it would hand over a bag
    // nobody checked).
    const stampOwnGuest = db.prepare(`
      UPDATE guest_orders SET handed_over_at = ?
       WHERE id = ?
         AND handed_over_at IS NULL
         AND COALESCE(status, 'submitted') <> 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM guest_order_items WHERE guest_order_id = ? AND COALESCE(packed, 0) = 0
         )
         AND EXISTS (SELECT 1 FROM guest_order_items WHERE guest_order_id = ?)
    `);

    const stampedBags = [];
    const inheritedGuestIds = new Set();
    let handedOver = 0;
    let alreadyHanded = 0;
    let guestsInherited = 0;
    // Whether anything actually took the batch's own timestamp. A call that only
    // stamped a LATE colleague onto an already-handed bag wrote that bag's original
    // stamp instead, so reporting the batch one would name a string no row carries.
    let usedBatchStamp = false;

    // ORDERS FIRST, and that order is load-bearing: a guest whose host is in the
    // same batch must be stamped by the HOST's write (inherited once, stamped once,
    // enqueued once — §UC-DP-006), so the explicit pass below can skip it.
    for (const id of batch.orderIds) {
      const row = orderRows.get(id);

      if (row.handed_over_at) {
        alreadyHanded += 1;
      } else {
        const written = stampOrder.run(stamp, id);
        if (written.changes === 0) {
          // Unreachable under `instances: 1` (the offender pass above ran in this same
          // synchronous transaction), and kept because it is the layer that survives
          // PM2 cluster mode and the day this handler gains an `await`.
          throw new BatchRefusal(409, {
            error: 'Najprv označte všetky balíčky ako zabalené',
            reason: 'not_packed',
            order_ids: [id],
            guest_order_ids: [],
            cancelled_guest_order_ids: [],
          });
        }
        handedOver += 1;
        usedBatchStamp = true;
      }

      // ⚠ THE INHERITANCE PASS RUNS FOR AN ALREADY-HANDED ORDER TOO — the skip above
      // skips the ORDER, never its bag. A colleague whose sub-order arrived AFTER the
      // host's bag went out has no stamp of its own, and the per-bag route
      // (`PATCH /orders/:id/handed-over`, §UC-DP-004) deliberately stamps exactly
      // that case on a repeat call. Skipping the whole party here would make the two
      // writers of this column disagree, in the open-cycle window where a late
      // sub-order is reachable — and the bag left behind would be invisible from the
      // group button that is supposed to be the unit of work.
      //
      // ⚠ THE STAMP BOUND HERE IS THE **BAG'S**, not always the batch's: the host's
      // own `handed_over_at` when it already had one, the batch stamp when this call
      // wrote it. Same rule as the per-bag route (which reads the column back and
      // binds it), and it is what keeps a host and their colleagues carrying the
      // identical string. `handed_over_at` in the response reports the batch stamp
      // only when something actually took it.
      const bagStamp = row.handed_over_at || stamp;

      // The FULL §UC-DP-004 write for this bag: its delivery through the one home,
      // its live `via_host` guests, the same stamp on every one of them. ⚠ No pack
      // gate on inheritance, exactly as per bag — the colleague's bag travels inside
      // the host's, so it left when the host's did.
      const delivery = partyDelivery(cycleId, row.friend_id);
      if (!row.handed_over_at) {
        stampedBags.push({
          kind: 'friend', cycleId, orderId: id, friendId: row.friend_id, delivery,
        });
      }

      for (const guest of inheritingGuests(row.friend_id, cycleId, delivery)) {
        // An already-handed guest keeps its own first record — the predicate says so
        // — and is therefore not counted and not enqueued again. On an already-handed
        // order this is what makes the pass a no-op for everyone but the late arrival.
        if (stampInheritedGuest.run(bagStamp, guest.id).changes === 0) continue;
        guestsInherited += 1;
        inheritedGuestIds.add(guest.id);
        stampedBags.push({
          kind: 'guest', cycleId, guestOrderId: guest.id,
          hostFriendId: row.friend_id, delivery: guest.delivery,
        });
      }
    }

    for (const id of batch.guestOrderIds) {
      // ⚠ THE DEDUPE. This bag was just inherited from its host in this same batch:
      // it is stamped, counted (in `guests_inherited`) and enqueued already. Without
      // this skip its UPDATE would report `changes === 0` — indistinguishable from
      // the pack gate refusing — and turn a perfectly good batch into a 409.
      if (inheritedGuestIds.has(id)) continue;

      const row = guestRows.get(id);
      if (row.handed_over_at) { alreadyHanded += 1; continue; }

      if (stampOwnGuest.run(stamp, id, id, id).changes === 0) {
        throw new BatchRefusal(409, {
          error: 'Najprv označte všetky položky ako zabalené',
          reason: 'not_packed',
          order_ids: [],
          guest_order_ids: [id],
          cancelled_guest_order_ids: [],
        });
      }
      handedOver += 1;
      usedBatchStamp = true;

      // A guest bag is classified WITH ITS HOST's delivery (the DP-T1 call-site
      // contract): the row itself carries no pickup, and a host with no own order
      // keeps theirs on the link.
      const hostDelivery = partyDelivery(cycleId, row.host_friend_id);
      stampedBags.push({
        kind: 'guest', cycleId, guestOrderId: id, hostFriendId: row.host_friend_id,
        delivery: deliveryOf(loadSubOrder(id), { host: hostDelivery }),
      });
    }

    // ⚠ ONLY THE BAGS THIS CALL ACTUALLY STAMPED (the DP-T3 rule). A skipped
    // already-handed bag is not an event and mints nothing.
    const queued = enqueueForHandOver(stampedBags);

    // §UC-DP-009 — the module-17 seam, inside the transaction, once per request.
    // A no-op stub until CS-T1; every response echoes `cycle_stage: null` today.
    const cycleStage = markCycleReady(cycleId);

    return {
      handedOver,
      alreadyHanded,
      guestsInherited,
      queued,
      cycleStage,
      stamp: usedBatchStamp ? stamp : null,
    };
  });

  let applied;
  try {
    applied = apply();
  } catch (err) {
    if (err instanceof BatchRefusal) return res.status(err.status).json(err.body);
    throw err;
  }

  // ⚠ RECORDED, NOT FIXED (DP-T3 review, 2026-09-20; see the DP-T4 and WA-T5 rows of
  // PROGRESS.md). A sub-order CANCELLED AFTER it was handed over stays stamped and
  // keeps its `queued` message. This route only ever SKIPS such a bag (the
  // already-handed branch above) — it grows no cancel path of its own, so it is not
  // the place the seam closes. ⚠ And the „one door" premise recorded on the row does
  // not hold: no hand-over route has a cycle-status gate, so a bag CAN be handed over
  // while the cycle is still open, which is exactly when the host's DELETE and the
  // guest's own empty cart are allowed. All THREE cancel doors are reachable after a
  // hand-over, so the fix belongs either at `softCancelGuestOrder()` (the one home
  // all three share) or at module 21's release, never at the admin cancel alone.
  res.json({
    handed_over: applied.handedOver,
    already_handed: applied.alreadyHanded,
    guests_inherited: applied.guestsInherited,
    queued_notifications: applied.queued,
    cycle_stage: applied.cycleStage,
    // Additive to §UC-DP-006's response: the one stamp the batch wrote (null when
    // it stamped nothing), so DP-T7 can patch the board's rows in place without
    // guessing which of them moved.
    handed_over_at: applied.stamp,
  });
});

// Reconcile which CATALOG products a cycle offers — the picker from cycle
// creation (UC-PC-012), reopenable for the whole life of an editable cycle
// (PM 2026-08-23: "musí byť dostupné počas celého otvorenia cyklu").
//
// Semantics, and each one is deliberate:
//  • ADD  — a requested catalog product with no snapshot here gets one, with the
//           catalog's CURRENT prices frozen into it (the UC-PC-012 rule). Adding
//           to a live cycle is the sanctioned ADD-only exception, exactly like the
//           manual POST (UC-PC-005); it never touches an existing snapshot.
//  • REACTIVATE — if an INACTIVE snapshot for that catalog product already exists
//           (it was unticked earlier), flip `active` back to 1 instead of inserting
//           a second row. Prices stay as they were frozen — re-adding must not
//           silently re-price a cycle friends are already ordering from.
//  • REMOVE — an active catalog-linked snapshot that is no longer requested is
//           SOFT-deleted (`active = 0`), the same write the existing product DELETE
//           does. order_items, orders and totals are untouched; a friend who already
//           ordered it keeps their line. `removed_with_orders` reports which ones had
//           orders so the UI can warn BEFORE the admin confirms.
//  ⚠ Snapshots with a NULL `source_coffee_product_id` (manually added, or
//    pre-migration history) are OUT of this reconciliation entirely — they are not
//    catalog-governed, so an unticked box must never delete them.
router.put('/:id/catalog-products', requireAdmin, (req, res) => {
  const cycleId = Number(req.params.id);
  if (!Number.isInteger(cycleId)) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }
  const cycle = db.prepare('SELECT id, status, type FROM order_cycles WHERE id = ?').get(cycleId);
  if (!cycle) {
    return res.status(404).json({ error: 'Cyklus nebol najdeny' });
  }
  if ((cycle.type || 'coffee') !== 'coffee') {
    return res.status(409).json({ error: 'Katalog kavy sa vztahuje len na kavove cykly', reason: 'not_coffee' });
  }
  if (!['open', 'planned'].includes(cycle.status)) {
    return res.status(409).json({ error: 'Cyklus je uzamknuty — produkty sa uz nedaju menit', reason: 'closed' });
  }

  const raw = req.body?.coffee_product_ids;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ error: 'coffee_product_ids musia byt pole', field: 'coffee_product_ids' });
  }
  const requested = new Set();
  for (const entry of raw) {
    const id = Number(bindValue(entry));
    if (Number.isInteger(id) && id > 0) requested.add(id);
  }

  const run = db.transaction(() => {
    const snapshots = db.prepare(
      'SELECT id, source_coffee_product_id, active, name FROM products WHERE cycle_id = ? AND source_coffee_product_id IS NOT NULL'
    ).all(cycleId);
    const bySource = new Map();
    for (const row of snapshots) bySource.set(row.source_coffee_product_id, row);

    const added = [];
    const reactivated = [];
    const removed = [];
    const removed_with_orders = [];

    for (const catalogId of requested) {
      const existing = bySource.get(catalogId);
      if (existing) {
        if (!existing.active) {
          db.prepare('UPDATE products SET active = 1 WHERE id = ?').run(existing.id);
          reactivated.push({ product_id: existing.id, name: existing.name });
        }
        continue;
      }
      const cp = db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(catalogId);
      if (!cp) continue; // unknown id: skipped, the UC-PC-012 bakery-`continue` rule
      const ins = db.prepare(`
        INSERT INTO products
          (cycle_id, name, description1, description2, roast_type, purpose,
           price_150g, price_200g, price_250g, price_500g, price_1kg, price_20pc5g, price_8pc12g,
           image, roastery, source_coffee_product_id, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
      `).run(
        cycleId, cp.name, cp.description1, cp.description2, cp.roast_type, cp.purpose,
        cp.price_150g, cp.price_200g, cp.price_250g, cp.price_500g, cp.price_1kg, cp.price_20pc5g, cp.price_8pc12g,
        cp.roastery, cp.id
      );
      added.push({ product_id: Number(ins.lastInsertRowid), name: cp.name });
    }

    for (const row of snapshots) {
      if (!row.active || requested.has(row.source_coffee_product_id)) continue;
      const orders = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?').get(row.id).c;
      db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(row.id);
      removed.push({ product_id: row.id, name: row.name });
      if (orders > 0) removed_with_orders.push({ product_id: row.id, name: row.name, order_items: orders });
    }

    return { added, reactivated, removed, removed_with_orders };
  });

  const result = run();
  const active_count = db.prepare(
    'SELECT COUNT(*) AS c FROM products WHERE cycle_id = ? AND active = 1'
  ).get(cycleId).c;
  return res.json({ ...result, active_count });
});

export default router;
