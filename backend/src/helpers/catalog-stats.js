import db from '../db/schema.js';
import { variantToKg } from './analytics.js';
import { guestCycleItems } from './guest-aggregation.js';

// Cross-cycle catalog statistics — 12 §UC-PC-010 (PC-T6). Exported PURE
// functions the two admin endpoints in routes/coffee-products.js wrap.
//
// ⚠ Module 13's recommendation ranking imports these FUNCTIONS server-side —
// it must never call the admin HTTP endpoints or re-write this SQL (§Seams).
// PC-T7's `GET /` list column imports `allTimeKgByCatalogId()`.
//
// The BINDING conventions (01-architecture §Catalog & passport extensions +
// standing CLAUDE.md rules — each with a recorded production bug behind it):
//
//   • Decision-4 split: guests count in per-PRODUCT kg totals ONLY. Distinct
//     friend counts, repeat-buyer counts and the per-friend table NEVER include
//     guests — a guest must never appear as, or inflate a count of, a friend.
//   • The guest half comes from `guestCycleItems()` (the ONE guest UNION for
//     aggregation) and is merged in JAVASCRIPT, never as a JOIN onto the
//     friend-row query — a second join multiplies friend rows (the GSO-T6/T8
//     trap; the pin: 1 friend kg + 2 × 1 guest kg = 3.0, never 4.0). Cancelled
//     guest sub-orders are excluded INSIDE guestCycleItems (the status
//     predicate) — do not re-implement it here.
//   • `variantToKg()` (helpers/analytics.js) is the ONLY weight authority —
//     never a third variant→weight map.
//   • Friend orders count per the house convention: `orders.status =
//     'submitted'` only (a draft cart is not a purchase).
//   • A NULL `products.source_coffee_product_id` counts toward NOTHING
//     (PC-T1): the friend query filters it in SQL, the guest merge drops
//     unlinked product ids.
//   • Window ordering is `created_at DESC, id DESC` — the id tiebreak is
//     MANDATORY (GSO-T8: second-resolution timestamps make same-second cycle
//     pairs a real, reproduced ambiguity).

const round3 = (n) => Math.round(n * 1000) / 1000;

// The cycle window: ids of coffee cycles (`COALESCE(type,'coffee') = 'coffee'`
// — a NULL type is a pre-migration coffee cycle, the catalog-migrate
// predicate), newest first. `lastN` limits to the last N; null/undefined =
// all time (still enumerated, so the /stats response can name the window it
// evaluated and the numbers stay auditable).
export function coffeeCycleWindow(lastN = null) {
  const base = `SELECT id FROM order_cycles
                WHERE COALESCE(type, 'coffee') = 'coffee'
                ORDER BY created_at DESC, id DESC`;
  const rows = Number.isInteger(lastN) && lastN > 0
    ? db.prepare(`${base} LIMIT ?`).all(lastN)
    : db.prepare(base).all();
  return rows.map((r) => r.id);
}

// Friend half: submitted order_items on LINKED snapshots within the window.
// One flat row per item — kg conversion happens in JS via variantToKg.
function friendItemRows(cycleIds) {
  if (cycleIds.length === 0) return [];
  const placeholders = cycleIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT p.source_coffee_product_id AS catalog_id,
           o.friend_id AS friend_id,
           o.cycle_id AS cycle_id,
           oi.variant AS variant,
           oi.quantity AS quantity
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.status = 'submitted'
    JOIN products p ON p.id = oi.product_id
    WHERE p.source_coffee_product_id IS NOT NULL
      AND o.cycle_id IN (${placeholders})
  `).all(...cycleIds);
}

// Guest half, already restricted to non-cancelled sub-orders by
// guestCycleItems. Returns flat rows mapped product_id →
// source_coffee_product_id (unlinked snapshots dropped) — merged into the
// friend aggregates in JS by the callers, never joined.
function guestItemRows(cycleIds) {
  const items = guestCycleItems(cycleIds);
  if (items.length === 0) return [];
  const linkByProduct = new Map(
    db.prepare('SELECT id, source_coffee_product_id FROM products WHERE source_coffee_product_id IS NOT NULL')
      .all()
      .map((r) => [r.id, r.source_coffee_product_id])
  );
  const rows = [];
  for (const it of items) {
    const catalogId = linkByProduct.get(it.product_id);
    if (catalogId == null) continue; // NULL-linked snapshot: counts toward nothing
    rows.push({ catalog_id: catalogId, cycle_id: it.cycle_id, variant: it.variant, quantity: it.quantity });
  }
  return rows;
}

// Which cycles (within the window) offered which catalog product — a linked
// snapshot IS the offering record (UC-PC-012: no junction table).
function offeredCycleRows(cycleIds) {
  if (cycleIds.length === 0) return [];
  const placeholders = cycleIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT source_coffee_product_id AS catalog_id, cycle_id
    FROM products
    WHERE source_coffee_product_id IS NOT NULL
      AND cycle_id IN (${placeholders})
  `).all(...cycleIds);
}

// The ranking (GET /stats): one row per catalog product —
//   { catalog_id, name, purpose, total_kg (friends+guests), friend_kg,
//     guest_kg, distinct_friends, repeat_buyers, cycles_offered,
//     cycles_ordered }
// `purpose` filters by the CATALOG row's purpose (the current truth — snapshots
// may drift per cycle; the filter must partition products stably). `cycleIds`
// comes from coffeeCycleWindow(). Zero-activity products are listed (the admin
// ranking must show what never sold, too). Ordered total_kg DESC, name ASC —
// sortable client-side.
export function catalogRanking({ purpose = null, cycleIds }) {
  const catalogRows = purpose
    ? db.prepare('SELECT id, name, purpose FROM coffee_products WHERE purpose = ?').all(purpose)
    : db.prepare('SELECT id, name, purpose FROM coffee_products').all();

  const stats = new Map(catalogRows.map((r) => [r.id, {
    catalog_id: r.id,
    name: r.name,
    purpose: r.purpose,
    friend_kg: 0,
    guest_kg: 0,
    friendCycles: new Map(), // friend_id → Set<cycle_id> (friends ONLY — Decision 4)
    offeredCycles: new Set(),
    orderedCycles: new Set(),
  }]));

  for (const row of friendItemRows(cycleIds)) {
    const s = stats.get(row.catalog_id);
    if (!s) continue; // purpose-filtered out
    s.friend_kg += variantToKg(row.variant, row.quantity);
    s.orderedCycles.add(row.cycle_id);
    let cycles = s.friendCycles.get(row.friend_id);
    if (!cycles) s.friendCycles.set(row.friend_id, (cycles = new Set()));
    cycles.add(row.cycle_id);
  }

  // Guest half — JS merge (kg + ordered-cycles only; never a friend figure).
  for (const row of guestItemRows(cycleIds)) {
    const s = stats.get(row.catalog_id);
    if (!s) continue;
    s.guest_kg += variantToKg(row.variant, row.quantity);
    s.orderedCycles.add(row.cycle_id);
  }

  for (const row of offeredCycleRows(cycleIds)) {
    const s = stats.get(row.catalog_id);
    if (s) s.offeredCycles.add(row.cycle_id);
  }

  const products = [];
  for (const s of stats.values()) {
    let repeat = 0;
    for (const cycles of s.friendCycles.values()) {
      if (cycles.size >= 2) repeat += 1; // ≥2 DISTINCT cycles, never 2 orders in one
    }
    products.push({
      catalog_id: s.catalog_id,
      name: s.name,
      purpose: s.purpose,
      total_kg: round3(s.friend_kg + s.guest_kg),
      friend_kg: round3(s.friend_kg),
      guest_kg: round3(s.guest_kg),
      distinct_friends: s.friendCycles.size,
      repeat_buyers: repeat,
      cycles_offered: s.offeredCycles.size,
      cycles_ordered: s.orderedCycles.size,
    });
  }
  products.sort((a, b) => b.total_kg - a.total_kg || a.name.localeCompare(b.name));
  return products;
}

// Per-product stats (GET /:id/stats), all-time. Returns null for an unknown
// catalog id (the route answers 404).
//   history — the availability history AND the order trend in one per-cycle
//     series: every cycle that OFFERED the product (a linked snapshot exists),
//     chronological, with the friend/guest kg split. Ordered ⊆ offered by
//     construction (an item references a snapshot, and the snapshot is the
//     offering), so one array carries both.
//   friends — the per friend × product table: { friend_id, name, times
//     (count of DISTINCT cycles ordered in), total_kg }. Friends only, by
//     construction (Decision 4) — the guest half never touches it.
export function catalogProductStats(catalogId) {
  const product = db
    .prepare('SELECT id, name, purpose, roastery, status FROM coffee_products WHERE id = ?')
    .get(catalogId);
  if (!product) return null;

  const cycleIds = coffeeCycleWindow(null); // all time
  const perCycle = new Map(); // cycle_id → { friend_kg, guest_kg }
  const ensure = (cycleId) => {
    let e = perCycle.get(cycleId);
    if (!e) perCycle.set(cycleId, (e = { friend_kg: 0, guest_kg: 0 }));
    return e;
  };

  const perFriend = new Map(); // friend_id → { kg, cycles: Set }
  for (const row of friendItemRows(cycleIds)) {
    if (row.catalog_id !== catalogId) continue;
    const kg = variantToKg(row.variant, row.quantity);
    ensure(row.cycle_id).friend_kg += kg;
    let f = perFriend.get(row.friend_id);
    if (!f) perFriend.set(row.friend_id, (f = { kg: 0, cycles: new Set() }));
    f.kg += kg;
    f.cycles.add(row.cycle_id);
  }

  for (const row of guestItemRows(cycleIds)) {
    if (row.catalog_id !== catalogId) continue;
    ensure(row.cycle_id).guest_kg += variantToKg(row.variant, row.quantity);
  }

  // Offering cycles, chronological (created_at ASC, id ASC — a trend series).
  const history = db.prepare(`
    SELECT DISTINCT c.id AS cycle_id, c.name AS cycle_name, c.created_at AS created_at
    FROM products p
    JOIN order_cycles c ON c.id = p.cycle_id
    WHERE p.source_coffee_product_id = ?
    ORDER BY c.created_at ASC, c.id ASC
  `).all(catalogId).map((c) => {
    const kg = perCycle.get(c.cycle_id) || { friend_kg: 0, guest_kg: 0 };
    return {
      cycle_id: c.cycle_id,
      cycle_name: c.cycle_name,
      created_at: c.created_at,
      friend_kg: round3(kg.friend_kg),
      guest_kg: round3(kg.guest_kg),
      total_kg: round3(kg.friend_kg + kg.guest_kg),
    };
  });

  const friendIds = [...perFriend.keys()];
  const names = new Map();
  if (friendIds.length > 0) {
    const placeholders = friendIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT id, name FROM friends WHERE id IN (${placeholders})`).all(...friendIds)) {
      names.set(r.id, r.name);
    }
  }
  const friends = friendIds.map((id) => ({
    friend_id: id,
    name: names.get(id) ?? null,
    times: perFriend.get(id).cycles.size,
    total_kg: round3(perFriend.get(id).kg),
  }));
  friends.sort((a, b) => b.times - a.times || b.total_kg - a.total_kg || (a.name || '').localeCompare(b.name || ''));

  return { product, history, friends };
}

// PC-T7 SEAM: all-time kg per catalog product (friends + guests, cancelled
// guests excluded) — the `GET /` list's `all_time_kg` column imports THIS,
// never re-derives it. Returns Map<catalog_id, kg>; products with no orders
// are absent (callers default to 0).
export function allTimeKgByCatalogId() {
  const cycleIds = coffeeCycleWindow(null);
  const kg = new Map();
  const add = (catalogId, amount) => kg.set(catalogId, (kg.get(catalogId) || 0) + amount);
  for (const row of friendItemRows(cycleIds)) add(row.catalog_id, variantToKg(row.variant, row.quantity));
  for (const row of guestItemRows(cycleIds)) add(row.catalog_id, variantToKg(row.variant, row.quantity));
  for (const [id, v] of kg) kg.set(id, round3(v));
  return kg;
}
