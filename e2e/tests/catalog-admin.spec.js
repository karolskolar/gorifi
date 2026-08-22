// PC-T4 — 12 §UC-PC-006: POST /api/coffee-products/migrate, the one-time (but
// idempotent and deliberately re-runnable) historical migration. Groups every
// unlinked historical coffee snapshot by the ONE normalization helper, creates
// catalog rows from the NEWEST snapshot per group (highest cycle_id, id DESC
// tiebreak — the GSO-T8 same-second lesson), backfills
// `products.source_coffee_product_id`, and returns the report incl.
// `fuzzy_review`.
//
// ⚠ This file is the module's ADMIN-surface spec: PC-T5 (merge/duplicates) and
// PC-T7 (catalog CRUD + AdminCatalog.vue) extend it later. This task owns only
// the migration half.
//
// ⚠ Unlinked historical snapshots CANNOT be manufactured over HTTP any more —
// PC-T3 made the manual POST born-linked and imports never create snapshots —
// so every fixture here is a direct DB insert and the whole DB-shaped half
// self-skips without DB_PATH (house convention; the backlog row says so
// explicitly).
//
// ⚠ Catalog rows and snapshots are GLOBAL and persist across tests on a shared
// DB: fixture names are unique per test (`uniq()`), report-level assertions
// filter by those names or assert deltas — never global exact counts on a
// first run (residue from other suites legitimately migrates alongside).

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

// ── fixture helpers ───────────────────────────────────────────────────────────

// Unique, normalization-stable prefix per call. Alphanumerics + single spaces
// only, so the normalized key is predictable (lowercase of the name).
const uniq = () => `PCT4 ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

function openDb() {
  return new DatabaseSync(DB_PATH)
}

// Insert a cycle directly. type: 'coffee' | 'bakery' | null (NULL must COALESCE
// to coffee — part of the candidate predicate under test).
function seedCycle(db, name, type = 'coffee') {
  const r = db
    .prepare("INSERT INTO order_cycles (name, status, type, total_friends) VALUES (?, 'completed', ?, 0)")
    .run(name, type)
  return Number(r.lastInsertRowid)
}

// Insert an UNLINKED historical snapshot directly (the pre-module-12 shape:
// source_coffee_product_id NULL).
function seedSnapshot(db, cycleId, f) {
  const r = db
    .prepare(
      `INSERT INTO products
         (cycle_id, name, description1, description2, roast_type, purpose,
          price_250g, price_1kg, image, roastery, source_bakery_product_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cycleId,
      f.name,
      f.description1 ?? null,
      f.description2 ?? null,
      f.roast_type ?? null,
      f.purpose ?? null,
      f.price_250g ?? null,
      f.price_1kg ?? null,
      f.image ?? null,
      f.roastery ?? null,
      f.source_bakery_product_id ?? null
    )
  return Number(r.lastInsertRowid)
}

function productRow(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id)
}

function catalogByNormalized(db, normalizedName, roastery = 'Goriffee') {
  return db
    .prepare('SELECT * FROM coffee_products WHERE normalized_name = ? AND roastery = ?')
    .all(normalizedName, roastery)
}

function tableSnapshot(db, table, excludeCols = []) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .filter((c) => !excludeCols.includes(c))
  return JSON.stringify(db.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY id`).all())
}

function migrate() {
  return ctx.post('/api/coffee-products/migrate', { headers: admin() })
}

// ── 1. auth ───────────────────────────────────────────────────────────────────

test.describe('UC-PC-006 — route guard', () => {
  test('anonymous POST /api/coffee-products/migrate is 401', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const res = await anon.post('/api/coffee-products/migrate')
      expect(res.status(), 'the migration must not be reachable anonymously').toBe(401)
    } finally {
      await anon.dispose()
    }
  })
})

// ── 2. the acceptance fixture: multi-cycle history → ONE catalog row ─────────

test.describe('UC-PC-006 — grouping, newest-snapshot creation, backfill', () => {
  test('multi-cycle history (incl. a case/whitespace variant) groups to ONE catalog row from the newest snapshot; bakery rows stay NULL-linked', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Pink Bourbon`
    const image = 'data:image/png;base64,PCT4IMG'
    const db = openDb()
    let ids
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, null) // NULL type must COALESCE to coffee
      const c3 = seedCycle(db, `${stem} c3`, 'coffee') // newest (highest cycle_id)
      const c4 = seedCycle(db, `${stem} c4`, 'coffee')
      const bk = seedCycle(db, `${stem} bakery`, 'bakery')
      ids = {
        s1: seedSnapshot(db, c1, { name: stem.toUpperCase(), description1: 'stary profil', price_250g: 8 }),
        // Case/whitespace/punctuation variant of the same identity — must land
        // in the SAME group via the one normalization helper.
        s2: seedSnapshot(db, c2, { name: `  ${stem}!  `, description1: 'stredny profil', price_250g: 8.5 }),
        s3: seedSnapshot(db, c3, { name: stem, description1: 'starsi profil', price_250g: 9 }),
        // NEWEST snapshot of the group (highest cycle_id = c4): carries the
        // metadata and the image the catalog row must be built from.
        s4: seedSnapshot(db, c4, {
          name: stem,
          description1: 'najnovsi profil',
          description2: 'kvety, med',
          roast_type: 'Light roast',
          purpose: 'Filter',
          price_250g: 9.9,
          price_1kg: 39,
          image,
        }),
        bakeryRow: seedSnapshot(db, bk, { name: stem, price_250g: 5 }),
        bakerySourced: seedSnapshot(db, c3, { name: stem, price_250g: 5, source_bakery_product_id: 999999 }),
      }
    } finally {
      db.close()
    }

    const res = await migrate()
    expect(res.status()).toBe(200)
    const report = await res.json()

    // The report shape is the UC-PC-006 contract, key-for-key.
    expect(Object.keys(report).sort()).toEqual(['catalog_created', 'fuzzy_review', 'summary', 'unlinked_remaining'])
    expect(Object.keys(report.summary).sort()).toEqual(
      ['already_linked', 'catalog_created', 'fuzzy_review', 'groups', 'snapshots_linked'])
    expect(report.summary.catalog_created).toBe(report.catalog_created.length)
    expect(report.summary.fuzzy_review).toBe(report.fuzzy_review.length)
    // Every coffee snapshot groups somewhere — non-zero is a bug signal.
    expect(report.unlinked_remaining).toBe(0)

    const key = stem.toLowerCase()
    const db2 = openDb()
    try {
      // Exactly ONE catalog row for the whole group, built from the NEWEST
      // snapshot: its exact name string (original casing/whitespace), its
      // metadata, its prices as current prices, its image.
      const rows = catalogByNormalized(db2, key)
      expect(rows).toHaveLength(1)
      const cat = rows[0]
      expect(cat.name).toBe(stem)
      expect(cat.description1).toBe('najnovsi profil')
      expect(cat.description2).toBe('kvety, med')
      expect(cat.roast_type).toBe('Light roast')
      expect(cat.purpose).toBe('Filter')
      expect(cat.price_250g).toBe(9.9)
      expect(cat.price_1kg).toBe(39)
      expect(cat.image).toBe(image)
      expect(cat.status).toBe('available')
      // Informational attributes are NEVER migration-written.
      for (const col of ['country', 'region', 'altitude', 'farm', 'variety', 'processing', 'curator_pick_note']) {
        expect(cat[col], `${col} must stay NULL`).toBeNull()
      }
      expect(cat.is_new).toBe(0)

      // All four coffee snapshots link to it; bakery-shaped rows stay NULL.
      for (const sid of [ids.s1, ids.s2, ids.s3, ids.s4]) {
        expect(productRow(db2, sid).source_coffee_product_id, `snapshot ${sid} linked`).toBe(cat.id)
      }
      expect(productRow(db2, ids.bakeryRow).source_coffee_product_id, 'bakery-cycle row untouched').toBeNull()
      expect(productRow(db2, ids.bakerySourced).source_coffee_product_id, 'bakery-sourced row untouched').toBeNull()

      // The report accounts for the created row by name.
      const created = report.catalog_created.find((e) => e.catalog_id === cat.id)
      expect(created).toBeTruthy()
      expect(Object.keys(created).sort()).toEqual(['catalog_id', 'name', 'needs_image'])
      expect(created.name).toBe(stem)
      expect(created.needs_image).toBe(false)
    } finally {
      db2.close()
    }
  })

  test('same-second collision: two snapshots in ONE cycle — the higher id wins (id DESC tiebreak)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Cerro Azul`
    const db = openDb()
    let older, newer
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      older = seedSnapshot(db, c, { name, description1: 'older twin', price_250g: 7 })
      newer = seedSnapshot(db, c, { name, description1: 'newer twin', price_250g: 7.5 })
    } finally {
      db.close()
    }

    expect((await migrate()).status()).toBe(200)

    const db2 = openDb()
    try {
      const rows = catalogByNormalized(db2, name.toLowerCase())
      expect(rows).toHaveLength(1)
      expect(rows[0].description1, 'the id DESC twin supplies the metadata').toBe('newer twin')
      expect(rows[0].price_250g).toBe(7.5)
      expect(productRow(db2, older).source_coffee_product_id).toBe(rows[0].id)
      expect(productRow(db2, newer).source_coffee_product_id).toBe(rows[0].id)
    } finally {
      db2.close()
    }
  })

  test('a group exact-matching an EXISTING catalog row backfills links and leaves the row byte-identical (no decision-13 refresh)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Existing Match`
    const db = openDb()
    let snapId, catalogBefore
    try {
      // A pre-existing catalog row (as an earlier import would have created it).
      db.prepare(
        `INSERT INTO coffee_products (name, normalized_name, roastery, price_250g, status)
         VALUES (?, ?, 'Goriffee', 8.9, 'available')`
      ).run(name, name.toLowerCase())
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      // Historical snapshot with a DIFFERENT price — the migration must link,
      // never refresh (an exact match backfills only; prices are the exact
      // divergence decision 13 would have overwritten).
      snapId = seedSnapshot(db, c, { name: name.toUpperCase(), description1: 'iny popis', price_250g: 99 })
      catalogBefore = JSON.stringify(
        db.prepare('SELECT * FROM coffee_products WHERE normalized_name = ? AND roastery = ?').get(name.toLowerCase(), 'Goriffee')
      )
    } finally {
      db.close()
    }

    const res = await migrate()
    expect(res.status()).toBe(200)
    const report = await res.json()

    const db2 = openDb()
    try {
      const rows = catalogByNormalized(db2, name.toLowerCase())
      expect(rows, 'no second catalog row for the same identity').toHaveLength(1)
      expect(JSON.stringify(rows[0]), 'the existing catalog row is byte-identical — backfill only').toBe(catalogBefore)
      expect(productRow(db2, snapId).source_coffee_product_id).toBe(rows[0].id)
      expect(report.catalog_created.some((e) => e.catalog_id === rows[0].id), 'a matched group creates nothing').toBe(false)
    } finally {
      db2.close()
    }
  })

  test('same name under a different roastery is a different group — two catalog rows', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Dvojka`
    const other = `Praziaren ${uniq()}`
    const db = openDb()
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      seedSnapshot(db, c, { name, price_250g: 8 }) // roastery NULL → default (Goriffee)
      seedSnapshot(db, c, { name, price_250g: 9, roastery: other })
    } finally {
      db.close()
    }

    expect((await migrate()).status()).toBe(200)

    const db2 = openDb()
    try {
      expect(catalogByNormalized(db2, name.toLowerCase(), 'Goriffee')).toHaveLength(1)
      expect(catalogByNormalized(db2, name.toLowerCase(), other)).toHaveLength(1)
    } finally {
      db2.close()
    }
  })
})

// ── 3. the frozen-history pin: exactly one column, nothing else ───────────────

test.describe('UC-PC-006 — historical rows byte-identical apart from the link column', () => {
  test('products (minus source_coffee_product_id), order_items and orders are byte-identical before/after', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Frozen History`
    const db = openDb()
    let before
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      const pid = seedSnapshot(db, c, { name, description1: 'popis', price_250g: 8, price_1kg: 30 })
      // Non-vacuity: a real order_items row referencing the fixture snapshot,
      // so "order_items untouched" is proven against data that exists.
      const friend = db.prepare('SELECT id FROM friends ORDER BY id LIMIT 1').get()
      expect(friend, 'seeded target must carry at least one friend (run e2e/seed.mjs)').toBeTruthy()
      const ord = db
        .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, 'submitted', 16)")
        .run(friend.id, c)
      db.prepare(
        "INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, '250g', 2, 8)"
      ).run(Number(ord.lastInsertRowid), pid)

      before = {
        products: tableSnapshot(db, 'products', ['source_coffee_product_id']),
        orderItems: tableSnapshot(db, 'order_items'),
        orders: tableSnapshot(db, 'orders'),
        cycles: tableSnapshot(db, 'order_cycles'),
      }
    } finally {
      db.close()
    }

    expect((await migrate()).status()).toBe(200)

    const db2 = openDb()
    try {
      expect(tableSnapshot(db2, 'products', ['source_coffee_product_id']),
        'the migration writes EXACTLY source_coffee_product_id — every other products byte survives').toBe(before.products)
      expect(tableSnapshot(db2, 'order_items'), 'order_items must not move').toBe(before.orderItems)
      expect(tableSnapshot(db2, 'orders'), 'orders must not move').toBe(before.orders)
      expect(tableSnapshot(db2, 'order_cycles'), 'order_cycles must not move').toBe(before.cycles)
      // And the link DID land (the exclusion above is not hiding a no-op run).
      const linked = db2
        .prepare('SELECT source_coffee_product_id FROM products WHERE name = ?')
        .get(name)
      expect(linked.source_coffee_product_id).not.toBeNull()
    } finally {
      db2.close()
    }
  })
})

// ── 4. idempotency: second run = zero writes ──────────────────────────────────

test.describe('UC-PC-006 — idempotent, deliberately re-runnable', () => {
  test('a second run writes NOTHING (byte-compare) and reports zero created/linked', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Idempotent`
    const db = openDb()
    let snapId
    try {
      const c1 = seedCycle(db, `${name} c1`, 'coffee')
      const c2 = seedCycle(db, `${name} c2`, 'coffee')
      seedSnapshot(db, c1, { name, price_250g: 8 })
      snapId = seedSnapshot(db, c2, { name: name.toUpperCase(), price_250g: 8.5 })
    } finally {
      db.close()
    }

    const first = await migrate()
    expect(first.status()).toBe(200)
    const firstReport = await first.json()
    expect(firstReport.unlinked_remaining).toBe(0)

    const db2 = openDb()
    let before, linkedTo
    try {
      before = {
        products: tableSnapshot(db2, 'products'),
        catalog: tableSnapshot(db2, 'coffee_products'),
      }
      linkedTo = productRow(db2, snapId).source_coffee_product_id
      expect(linkedTo).not.toBeNull()
    } finally {
      db2.close()
    }

    const second = await migrate()
    expect(second.status()).toBe(200)
    const report = await second.json()

    // Already-linked rows are skipped; the run creates and links nothing.
    expect(report.summary.catalog_created).toBe(0)
    expect(report.summary.snapshots_linked).toBe(0)
    expect(report.summary.groups).toBe(0)
    expect(report.catalog_created).toEqual([])
    expect(report.summary.already_linked).toBeGreaterThanOrEqual(2)
    expect(report.unlinked_remaining).toBe(0)

    const db3 = openDb()
    try {
      expect(tableSnapshot(db3, 'products'), 'second run: zero products writes').toBe(before.products)
      expect(tableSnapshot(db3, 'coffee_products'), 'second run: zero catalog writes').toBe(before.catalog)
      expect(productRow(db3, snapId).source_coffee_product_id, 'links survive the re-run').toBe(linkedTo)
    } finally {
      db3.close()
    }
  })
})

// ── 5. the fuzzy tail: create-as-new-but-flagged, never auto-merged ──────────

test.describe('UC-PC-006 — fuzzy_review', () => {
  test('a near-miss group pair is migrated as TWO rows and reported under fuzzy_review', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Pink Bourbon`
    const variant = `${stem} Honey`
    const db = openDb()
    let sA, sB
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      sA = seedSnapshot(db, c1, { name: stem, price_250g: 8 })
      sB = seedSnapshot(db, c2, { name: variant, price_250g: 9 })
    } finally {
      db.close()
    }

    const res = await migrate()
    expect(res.status()).toBe(200)
    const report = await res.json()

    const db2 = openDb()
    try {
      const a = catalogByNormalized(db2, stem.toLowerCase())
      const b = catalogByNormalized(db2, variant.toLowerCase())
      expect(a, 'never auto-merged — both groups become their own row').toHaveLength(1)
      expect(b).toHaveLength(1)
      expect(productRow(db2, sA).source_coffee_product_id).toBe(a[0].id)
      expect(productRow(db2, sB).source_coffee_product_id).toBe(b[0].id)

      // The pair is flagged for the admin (either direction — group processing
      // order decides which row names the other as candidate).
      const pair = report.fuzzy_review.find(
        (e) =>
          (e.catalog_id === a[0].id && e.candidate_catalog_id === b[0].id) ||
          (e.catalog_id === b[0].id && e.candidate_catalog_id === a[0].id)
      )
      expect(pair, 'the near-miss pair must land in fuzzy_review').toBeTruthy()
      expect(Object.keys(pair).sort()).toEqual(
        ['candidate_catalog_id', 'candidate_name', 'catalog_id', 'name', 'similarity'])
      expect(pair.similarity).toBeGreaterThanOrEqual(0.75)
      expect(pair.similarity).toBeLessThan(1)
    } finally {
      db2.close()
    }
  })
})
