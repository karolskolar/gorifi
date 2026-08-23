// PC-T6 — 12 §UC-PC-010: cross-cycle catalog statistics.
//   GET /api/coffee-products/stats        — the ranking (purpose filter, window)
//   GET /api/coffee-products/:id/stats    — per-product history/trend + per-friend table
//
// ⚠ The invariants under test are the module's densest (each a standing
// CLAUDE.md rule with a recorded production bug behind it):
//   • Decision-4 split — guests count in per-product kg totals ONLY, never in
//     ANY friend figure (distinct_friends, repeat_buyers, the per-friend table).
//   • Guest half merged in JAVASCRIPT, never a JOIN onto the friend rows
//     (GSO-T6/T8 multiplied-rows trap). The unambiguous pin: 1 friend kg +
//     2 × 1 guest kg = 3.0 — a multiplied friend line reads 4.0 — with the
//     friend counts unmoved.
//   • Cancelled guest sub-orders excluded (the status predicate, GSO-T4).
//   • Window ordering `created_at DESC, id DESC` — the same-second tiebreak
//     (GSO-T8); pinned with a manufactured created_at collision.
//   • NULL `source_coffee_product_id` counts toward NOTHING (PC-T1 rule).
//
// ⚠ Orders/guest sub-orders cannot be manufactured against arbitrary direct-DB
// cycles over HTTP without a whole login+link dance, so fixtures here are
// direct DB inserts and every DB-shaped test self-skips without DB_PATH
// (house convention). The two auth tests and the 404 run without it.
//
// ⚠ Catalog rows, cycles and orders are GLOBAL and persist across tests on a
// shared DB: fixtures use unique names, assertions find rows by catalog_id —
// never global exact counts. Window tests rely on the fixture cycles being the
// NEWEST in the DB at assertion time (single worker, nothing runs after the
// inserts within the test); the collision test date-stamps its cycles into the
// future and deletes them in `finally`.

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'

let ctx
let adminToken
const admin = () => ({ 'X-Admin-Token': adminToken })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login must succeed against a seeded target').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ── fixture helpers (direct DB) ───────────────────────────────────────────────

const uniq = () => `PCT6 ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

function openDb() {
  return new DatabaseSync(DB_PATH)
}

function seedCycle(db, name, type = 'coffee', createdAt = null) {
  const r = createdAt
    ? db
        .prepare("INSERT INTO order_cycles (name, status, type, total_friends, created_at) VALUES (?, 'completed', ?, 0, ?)")
        .run(name, type, createdAt)
    : db
        .prepare("INSERT INTO order_cycles (name, status, type, total_friends) VALUES (?, 'completed', ?, 0)")
        .run(name, type)
  return Number(r.lastInsertRowid)
}

function seedCatalog(db, f) {
  const r = db
    .prepare(
      `INSERT INTO coffee_products (name, normalized_name, roastery, purpose, price_250g, price_1kg, status)
       VALUES (?, ?, ?, ?, ?, ?, 'available')`
    )
    .run(f.name, f.name.toLowerCase(), f.roastery ?? 'Goriffee', f.purpose ?? null, f.price_250g ?? 8, f.price_1kg ?? 30)
  return Number(r.lastInsertRowid)
}

// A cycle snapshot; pass source_coffee_product_id: null for the NULL-link case.
function seedSnapshot(db, cycleId, f) {
  const r = db
    .prepare(
      `INSERT INTO products (cycle_id, name, purpose, price_250g, price_1kg, roastery, source_coffee_product_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cycleId,
      f.name,
      f.purpose ?? null,
      f.price_250g ?? 8,
      f.price_1kg ?? 30,
      f.roastery ?? 'Goriffee',
      f.source_coffee_product_id ?? null
    )
  return Number(r.lastInsertRowid)
}

function seedFriend(db, cycleId, name) {
  const r = db
    .prepare('INSERT INTO friends (cycle_id, name, access_token, active) VALUES (?, ?, ?, 1)')
    .run(cycleId, name, `${uniq()}tok${Math.random().toString(36).slice(2)}`)
  return Number(r.lastInsertRowid)
}

function seedOrder(db, friendId, cycleId, status = 'submitted') {
  const r = db
    .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, ?, 0)")
    .run(friendId, cycleId, status)
  return Number(r.lastInsertRowid)
}

function seedItem(db, orderId, productId, variant, quantity = 1) {
  db.prepare('INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, ?, ?, 10)')
    .run(orderId, productId, variant, quantity)
}

function seedGuestLink(db, hostFriendId, cycleId) {
  const r = db
    .prepare('INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)')
    .run(`${uniq()}gl${Math.random().toString(36).slice(2)}`, hostFriendId, cycleId)
  return Number(r.lastInsertRowid)
}

function seedGuestOrder(db, linkId, status = 'submitted') {
  const r = db
    .prepare("INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, status, total) VALUES (?, ?, ?, '0900', ?, 0)")
    .run(linkId, `${uniq()}go${Math.random().toString(36).slice(2)}`, `Guest ${uniq()}`, status)
  return Number(r.lastInsertRowid)
}

function seedGuestItem(db, guestOrderId, productId, variant, quantity = 1) {
  db.prepare('INSERT INTO guest_order_items (guest_order_id, product_id, variant, quantity, price) VALUES (?, ?, ?, ?, 12)')
    .run(guestOrderId, productId, variant, quantity)
}

// ── API helpers ───────────────────────────────────────────────────────────────

function statsReq(query = '') {
  return ctx.get(`/api/coffee-products/stats${query}`, { headers: admin() })
}

function productStatsReq(id) {
  return ctx.get(`/api/coffee-products/${id}/stats`, { headers: admin() })
}

async function rankingRow(catalogId, query = '') {
  const res = await statsReq(query)
  expect(res.status(), `GET /stats${query} must succeed`).toBe(200)
  const body = await res.json()
  expect(Array.isArray(body.products), 'response carries a products array').toBe(true)
  expect(body.window && Array.isArray(body.window.cycle_ids), 'response names the window it evaluated').toBe(true)
  return { row: body.products.find((p) => p.catalog_id === catalogId) ?? null, body }
}

// ── the verbatim §UC-PC-010 acceptance fixture ────────────────────────────────
// friend A orders product P in 2 cycles (0.25 kg each), friend B in 1 cycle
// (1 kg), one guest 1 kg, one CANCELLED guest 1 kg.
function seedVerbatimFixture(db) {
  const stem = uniq()
  const c1 = seedCycle(db, `${stem} c1`)
  const c2 = seedCycle(db, `${stem} c2`)
  const catP = seedCatalog(db, { name: `${stem} P`, purpose: 'Espresso' })
  const catQ = seedCatalog(db, { name: `${stem} Q`, purpose: 'Filter' })
  const sp1 = seedSnapshot(db, c1, { name: `${stem} P`, purpose: 'Espresso', source_coffee_product_id: catP })
  const sp2 = seedSnapshot(db, c2, { name: `${stem} P`, purpose: 'Espresso', source_coffee_product_id: catP })
  const sq2 = seedSnapshot(db, c2, { name: `${stem} Q`, purpose: 'Filter', source_coffee_product_id: catQ })

  const friendA = seedFriend(db, c1, `${stem} Friend A`)
  const friendB = seedFriend(db, c1, `${stem} Friend B`)

  seedItem(db, seedOrder(db, friendA, c1), sp1, '250g', 1)
  seedItem(db, seedOrder(db, friendA, c2), sp2, '250g', 1)
  seedItem(db, seedOrder(db, friendB, c2), sp2, '1kg', 1)

  const link = seedGuestLink(db, friendA, c2)
  seedGuestItem(db, seedGuestOrder(db, link, 'submitted'), sp2, '1kg', 1)
  seedGuestItem(db, seedGuestOrder(db, link, 'cancelled'), sp2, '1kg', 1)

  return { stem, c1, c2, catP, catQ, sp1, sp2, sq2, friendA, friendB }
}

// ── 1. auth (ADMIN_ENDPOINTS also pins these; asserted here per the task row) ─

test.describe('UC-PC-010 — route guard', () => {
  test('anonymous GET /api/coffee-products/stats is 401', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anon.get('/api/coffee-products/stats')
      expect(res.status()).toBe(401)
    } finally {
      await anon.dispose()
    }
  })

  test('anonymous GET /api/coffee-products/1/stats is 401', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anon.get('/api/coffee-products/1/stats')
      expect(res.status()).toBe(401)
    } finally {
      await anon.dispose()
    }
  })
})

// ── 2. the ranking: the verbatim acceptance numbers ───────────────────────────

test.describe('UC-PC-010 — ranking (GET /stats)', () => {
  test('verbatim fixture: total 2.5 / friend 1.5 / guest 1.0, 2 distinct friends, 1 repeat buyer; cancelled guest excluded', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let f
    try {
      f = seedVerbatimFixture(db)
    } finally {
      db.close()
    }

    const { row, body } = await rankingRow(f.catP)
    expect(row, 'product P must appear in the ranking').toBeTruthy()

    // Row shape is the §UC-PC-010 contract, key-for-key.
    expect(Object.keys(row).sort()).toEqual([
      'catalog_id', 'cycles_offered', 'cycles_ordered', 'distinct_friends',
      'friend_kg', 'guest_kg', 'name', 'purpose', 'repeat_buyers', 'total_kg',
    ])

    expect(row.total_kg, 'total = friends + guests, cancelled guest excluded').toBe(2.5)
    expect(row.friend_kg).toBe(1.5)
    expect(row.guest_kg, 'the cancelled 1 kg guest bag must not count').toBe(1.0)
    expect(row.distinct_friends, 'guests must never inflate a friend count').toBe(2)
    expect(row.repeat_buyers, 'A ordered in 2 distinct cycles; B in 1; the guest is nobody').toBe(1)
    expect(row.cycles_offered).toBe(2)
    expect(row.cycles_ordered).toBe(2)

    // The window is auditable: all-time still names the cycles it evaluated.
    expect(body.window.cycle_ids).toEqual(expect.arrayContaining([f.c1, f.c2]))
  })

  test('windowed to the last 1 cycle: the repeat count drops, window names exactly that cycle', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let f
    try {
      f = seedVerbatimFixture(db)
    } finally {
      db.close()
    }

    const { row, body } = await rankingRow(f.catP, '?last_n_cycles=1')
    // The fixture's c2 is the newest coffee cycle in the DB at this point
    // (single worker; nothing inserts cycles after this test's seeding).
    expect(body.window.cycle_ids, 'window = exactly the newest coffee cycle').toEqual([f.c2])

    expect(row, 'P appears within the window').toBeTruthy()
    expect(row.repeat_buyers, 'A has only 1 cycle inside the window — no repeat buyers').toBe(0)
    expect(row.distinct_friends, 'A and B both ordered in c2').toBe(2)
    expect(row.friend_kg).toBe(1.25)
    expect(row.guest_kg).toBe(1.0)
    expect(row.total_kg).toBe(2.25)
    expect(row.cycles_offered).toBe(1)
    expect(row.cycles_ordered).toBe(1)
  })

  test('purpose filter partitions: Espresso finds P and not Q, Filter the reverse', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let f
    try {
      f = seedVerbatimFixture(db)
    } finally {
      db.close()
    }

    const espresso = await rankingRow(f.catP, '?purpose=Espresso')
    expect(espresso.row, 'P (Espresso) matches the Espresso filter').toBeTruthy()
    expect(espresso.body.products.find((p) => p.catalog_id === f.catQ), 'Q (Filter) must not').toBeFalsy()

    const filter = await rankingRow(f.catQ, '?purpose=Filter')
    expect(filter.row, 'Q (Filter) matches the Filter filter').toBeTruthy()
    expect(filter.body.products.find((p) => p.catalog_id === f.catP), 'P (Espresso) must not').toBeFalsy()
  })

  // ⚠ THE GSO-T6/T8 PIN. The guest half must merge in JavaScript — a JOIN onto
  // the friend rows multiplies them: 1 friend kg beside TWO 1 kg guest orders
  // reads 4.0 through a multiplied join, 3.0 through the JS merge. The friend
  // count staying 1 is the other half of the same pin.
  test('JS-merge non-multiplication: 1 friend kg + 2 × 1 guest kg = 3.0, friend counts unmoved', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let catR
    try {
      const stem = uniq()
      const c = seedCycle(db, `${stem} c`)
      catR = seedCatalog(db, { name: `${stem} R`, purpose: 'Espresso' })
      const sr = seedSnapshot(db, c, { name: `${stem} R`, source_coffee_product_id: catR })
      const friendF = seedFriend(db, c, `${stem} Friend F`)
      seedItem(db, seedOrder(db, friendF, c), sr, '1kg', 1)
      const link = seedGuestLink(db, friendF, c)
      seedGuestItem(db, seedGuestOrder(db, link), sr, '1kg', 1)
      seedGuestItem(db, seedGuestOrder(db, link), sr, '1kg', 1)
    } finally {
      db.close()
    }

    const { row } = await rankingRow(catR)
    expect(row).toBeTruthy()
    expect(row.total_kg, 'a multiplied friend line would read 4.0').toBe(3.0)
    expect(row.friend_kg).toBe(1.0)
    expect(row.guest_kg).toBe(2.0)
    expect(row.distinct_friends, 'guests must not appear as friends').toBe(1)
    expect(row.repeat_buyers).toBe(0)
  })

  test('repeat buyer means ≥ 2 DISTINCT cycles — two orders in ONE cycle do not qualify', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let catS
    try {
      const stem = uniq()
      const c = seedCycle(db, `${stem} c`)
      catS = seedCatalog(db, { name: `${stem} S`, purpose: 'Espresso' })
      const ss = seedSnapshot(db, c, { name: `${stem} S`, source_coffee_product_id: catS })
      const friendF = seedFriend(db, c, `${stem} Friend F2`)
      // Two separate submitted orders, SAME cycle (no UNIQUE(friend,cycle) —
      // the get-or-create convention; a direct insert can manufacture this).
      seedItem(db, seedOrder(db, friendF, c), ss, '250g', 1)
      seedItem(db, seedOrder(db, friendF, c), ss, '250g', 1)
    } finally {
      db.close()
    }

    const { row } = await rankingRow(catS)
    expect(row).toBeTruthy()
    expect(row.distinct_friends).toBe(1)
    expect(row.repeat_buyers, 'two orders in one cycle is NOT a repeat buyer').toBe(0)
    expect(row.friend_kg).toBe(0.5)
  })

  test('draft orders do not count (submitted-only convention)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let catD
    try {
      const stem = uniq()
      const c = seedCycle(db, `${stem} c`)
      catD = seedCatalog(db, { name: `${stem} D`, purpose: 'Espresso' })
      const sd = seedSnapshot(db, c, { name: `${stem} D`, source_coffee_product_id: catD })
      const friendF = seedFriend(db, c, `${stem} Friend D`)
      seedItem(db, seedOrder(db, friendF, c, 'draft'), sd, '1kg', 1)
    } finally {
      db.close()
    }

    const { row } = await rankingRow(catD)
    expect(row, 'the catalog row still appears (zero-activity rows are listed)').toBeTruthy()
    expect(row.friend_kg).toBe(0)
    expect(row.distinct_friends).toBe(0)
    expect(row.cycles_ordered).toBe(0)
    expect(row.cycles_offered, 'offered even though nobody submitted').toBe(1)
  })

  test('NULL source_coffee_product_id counts toward nothing (PC-T1 rule)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let catT
    try {
      const stem = uniq()
      const c = seedCycle(db, `${stem} c`)
      catT = seedCatalog(db, { name: `${stem} T`, purpose: 'Espresso' })
      const linked = seedSnapshot(db, c, { name: `${stem} T`, source_coffee_product_id: catT })
      const orphan = seedSnapshot(db, c, { name: `${stem} T orphan`, source_coffee_product_id: null })
      const friendF = seedFriend(db, c, `${stem} Friend T`)
      const o = seedOrder(db, friendF, c)
      seedItem(db, o, linked, '250g', 1)
      seedItem(db, o, orphan, '1kg', 1) // must be invisible to every stat
    } finally {
      db.close()
    }

    const { row } = await rankingRow(catT)
    expect(row).toBeTruthy()
    expect(row.friend_kg, 'only the LINKED snapshot counts — 0.25, not 1.25').toBe(0.25)
    expect(row.total_kg).toBe(0.25)
  })

  // ⚠ The GSO-T8 same-second lesson: `last_n_cycles` MUST order
  // `created_at DESC, id DESC`. Manufactured collision: two coffee cycles with
  // an identical (future) created_at — the HIGHER id must win the window.
  test('last_n_cycles carries the id DESC tiebreak on a same-second created_at collision', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const FUTURE = '2099-01-01 00:00:00'
    const db = openDb()
    const cleanup = { cycles: [] }
    let catW, cLow, cHigh
    try {
      const stem = uniq()
      catW = seedCatalog(db, { name: `${stem} W`, purpose: 'Espresso' })
      cLow = seedCycle(db, `${stem} low`, 'coffee', FUTURE)
      cHigh = seedCycle(db, `${stem} high`, 'coffee', FUTURE)
      cleanup.cycles = [cLow, cHigh]
      const sLow = seedSnapshot(db, cLow, { name: `${stem} W`, source_coffee_product_id: catW })
      const sHigh = seedSnapshot(db, cHigh, { name: `${stem} W`, source_coffee_product_id: catW })
      const friendF = seedFriend(db, cLow, `${stem} Friend W`)
      seedItem(db, seedOrder(db, friendF, cLow), sLow, '250g', 1) // 0.25 kg in the LOWER id
      seedItem(db, seedOrder(db, friendF, cHigh), sHigh, '1kg', 1) // 1.0 kg in the HIGHER id
      db.close()

      const { row, body } = await rankingRow(catW, '?last_n_cycles=1')
      expect(body.window.cycle_ids, 'the higher id wins the same-second tie').toEqual([cHigh])
      expect(row).toBeTruthy()
      expect(row.friend_kg, 'stats reflect the tiebreak winner only').toBe(1.0)
    } finally {
      // The future-dated cycles would poison every later window pick — delete
      // them (and their dependents) unconditionally.
      const db2 = openDb()
      try {
        for (const id of cleanup.cycles) {
          db2.prepare('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cycle_id = ?)').run(id)
          db2.prepare('DELETE FROM orders WHERE cycle_id = ?').run(id)
          db2.prepare('DELETE FROM products WHERE cycle_id = ?').run(id)
          db2.prepare('DELETE FROM friends WHERE cycle_id = ?').run(id)
          db2.prepare('DELETE FROM order_cycles WHERE id = ?').run(id)
        }
      } finally {
        db2.close()
      }
    }
  })

  test('invalid last_n_cycles refuses with 400', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await statsReq(`?last_n_cycles=${bad}`)
      expect(res.status(), `last_n_cycles=${bad} must 400`).toBe(400)
    }
  })
})

// ── 3. per-product stats (GET /:id/stats) ─────────────────────────────────────

test.describe('UC-PC-010 — per-product stats (GET /:id/stats)', () => {
  test('availability history lists exactly the offering cycles with the friend/guest kg split; per-friend table has no guest row', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let f
    try {
      f = seedVerbatimFixture(db)
    } finally {
      db.close()
    }

    const res = await productStatsReq(f.catP)
    expect(res.status()).toBe(200)
    const body = await res.json()

    // Shape contract.
    expect(Object.keys(body).sort()).toEqual(['friends', 'history', 'product'])
    expect(body.product.id).toBe(f.catP)

    // History = exactly the offering cycles (the trend is this per-cycle series).
    expect(body.history.map((h) => h.cycle_id)).toEqual([f.c1, f.c2])
    const h1 = body.history.find((h) => h.cycle_id === f.c1)
    const h2 = body.history.find((h) => h.cycle_id === f.c2)
    expect(Object.keys(h1).sort()).toEqual(['created_at', 'cycle_id', 'cycle_name', 'friend_kg', 'guest_kg', 'total_kg'])
    expect(h1.friend_kg).toBe(0.25)
    expect(h1.guest_kg).toBe(0)
    expect(h1.total_kg).toBe(0.25)
    expect(h2.friend_kg).toBe(1.25)
    expect(h2.guest_kg, 'cancelled guest excluded from the trend too').toBe(1.0)
    expect(h2.total_kg).toBe(2.25)

    // Per friend × product — friends ONLY, by construction (Decision 4).
    expect(body.friends).toHaveLength(2)
    const a = body.friends.find((r) => r.friend_id === f.friendA)
    const b = body.friends.find((r) => r.friend_id === f.friendB)
    expect(a, 'friend A present').toBeTruthy()
    expect(Object.keys(a).sort()).toEqual(['friend_id', 'name', 'times', 'total_kg'])
    expect(a.times, 'A ordered in 2 distinct cycles').toBe(2)
    expect(a.total_kg).toBe(0.5)
    expect(b.times).toBe(1)
    expect(b.total_kg).toBe(1.0)
    // No guest row anywhere: every row is one of the two friends.
    for (const r of body.friends) expect([f.friendA, f.friendB]).toContain(r.friend_id)
    expect(JSON.stringify(body.friends), 'no guest name leaks into the friend table').not.toMatch(/Guest PCT6/)
  })

  test('a cycle that OFFERED the product without any order still appears with zero kg', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    let catV, cA, cB
    try {
      const stem = uniq()
      cA = seedCycle(db, `${stem} cA`)
      cB = seedCycle(db, `${stem} cB`)
      catV = seedCatalog(db, { name: `${stem} V`, purpose: 'Filter' })
      const sA = seedSnapshot(db, cA, { name: `${stem} V`, source_coffee_product_id: catV })
      seedSnapshot(db, cB, { name: `${stem} V`, source_coffee_product_id: catV }) // offered, never ordered
      const friendF = seedFriend(db, cA, `${stem} Friend V`)
      seedItem(db, seedOrder(db, friendF, cA), sA, '250g', 2)
    } finally {
      db.close()
    }

    const res = await productStatsReq(catV)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.history.map((h) => h.cycle_id)).toEqual([cA, cB])
    const hB = body.history.find((h) => h.cycle_id === cB)
    expect(hB.total_kg).toBe(0)
    const hA = body.history.find((h) => h.cycle_id === cA)
    expect(hA.friend_kg).toBe(0.5)
  })

  test('unknown id is 404; non-integer id is 404', async () => {
    const missing = await productStatsReq(99999999)
    expect(missing.status()).toBe(404)
    const nonInt = await productStatsReq('abc')
    expect(nonInt.status()).toBe(404)
  })
})
