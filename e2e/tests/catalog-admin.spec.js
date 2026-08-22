// PC-T4 — 12 §UC-PC-006: POST /api/coffee-products/migrate, the one-time (but
// idempotent and deliberately re-runnable) historical migration. Groups every
// unlinked historical coffee snapshot by the ONE normalization helper, creates
// catalog rows from the NEWEST snapshot per group (highest cycle_id, id DESC
// tiebreak — the GSO-T8 same-second lesson), backfills
// `products.source_coffee_product_id`, and returns the report incl.
// `fuzzy_review`.
//
// ⚠ This file is the module's ADMIN-surface spec. PC-T4 owns the migration
// half (§§1–5); PC-T5 added the merge tool + stateless duplicates review
// (§§6–10, 12 §UC-PC-007/008); PC-T7 (catalog CRUD + AdminCatalog.vue)
// extends it later.
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
// source_coffee_product_id NULL) — PC-T5's merge fixtures pass
// f.source_coffee_product_id to seed born-linked snapshots.
function seedSnapshot(db, cycleId, f) {
  const r = db
    .prepare(
      `INSERT INTO products
         (cycle_id, name, description1, description2, roast_type, purpose,
          price_250g, price_1kg, image, roastery, source_bakery_product_id,
          source_coffee_product_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      f.source_bakery_product_id ?? null,
      f.source_coffee_product_id ?? null
    )
  return Number(r.lastInsertRowid)
}

// Insert a catalog row directly (PC-T5 merge fixtures need full control over
// every column, incl. status/image, before PATCH exists in PC-T7).
function seedCatalog(db, f) {
  const r = db
    .prepare(
      `INSERT INTO coffee_products
         (name, normalized_name, roastery, description1, description2, roast_type,
          purpose, price_250g, price_1kg, image, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      f.name,
      f.name.toLowerCase(),
      f.roastery ?? 'Goriffee',
      f.description1 ?? null,
      f.description2 ?? null,
      f.roast_type ?? null,
      f.purpose ?? null,
      f.price_250g ?? null,
      f.price_1kg ?? null,
      f.image ?? null,
      f.status ?? 'available'
    )
  return Number(r.lastInsertRowid)
}

function catalogRowById(db, id) {
  return db.prepare('SELECT * FROM coffee_products WHERE id = ?').get(id) ?? null
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

// ── PC-T5 fixture helpers (merge + duplicates) ────────────────────────────────

function merge(targetId, sourceId) {
  return ctx.post(`/api/coffee-products/${targetId}/merge`, {
    headers: admin(),
    data: { source_id: sourceId },
  })
}

function duplicates() {
  return ctx.get('/api/coffee-products/duplicates', { headers: admin() })
}

// The catalog CSV import (the PC-T2 vehicle) — PC-T5 uses it to create catalog
// rows over HTTP where no DB shape is asserted, so those tests run without
// DB_PATH. Same column vocabulary as catalog-import.spec.js.
function csvFor(rows) {
  const header = 'Name,Description1,Popis2,Roast,Purpose,Price250g,Price1kg'
  const lines = rows.map((r) =>
    [r.name ?? '', r.desc1 ?? '', r.desc2 ?? '', r.roast ?? '', r.purpose ?? '', r.p250 ?? '', r.p1kg ?? '']
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(',')
  )
  return [header, ...lines].join('\n') + '\n'
}

function importCsv(csv, roastery) {
  const multipart = {
    file: { name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') },
  }
  if (roastery !== undefined) multipart.roastery = roastery
  return ctx.post('/api/coffee-products/import', { headers: admin(), multipart })
}

// Import exactly one NEW row over HTTP and return its catalog_id.
async function importOne(name, extra = {}, roastery) {
  const res = await importCsv(csvFor([{ name, p250: '8,0', ...extra }]), roastery)
  expect(res.status(), `import of ${name} must succeed`).toBe(201)
  const { report } = await res.json()
  const entry = report.new.find((e) => e.name === name)
  expect(entry, `import must report ${name} as new`).toBeTruthy()
  return entry.catalog_id
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

// ═══════════════════════════════════════════════════════════════════════════════
// PC-T5 — 12 §UC-PC-007 (merge tool) + §UC-PC-008 (stateless duplicates review)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 6. route guards + decision 9 (no DELETE route ever) ──────────────────────

test.describe('UC-PC-007/008 — route guards', () => {
  test('anonymous POST /:id/merge and GET /duplicates are 401', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      const m = await anon.post('/api/coffee-products/1/merge', { data: { source_id: 2 } })
      expect(m.status(), 'merge must not be reachable anonymously').toBe(401)
      const d = await anon.get('/api/coffee-products/duplicates')
      expect(d.status(), 'duplicates review must not be reachable anonymously').toBe(401)
    } finally {
      await anon.dispose()
    }
  })

  test('no standalone catalog DELETE route exists (decision 9 — the merge is the ONLY deleter)', async () => {
    // A REAL catalog row, so a hypothetical DELETE route would have a target.
    const id = await importOne(`${uniq()} Nezmazatelny`)
    const res = await ctx.delete(`/api/coffee-products/${id}`, { headers: admin() })
    expect(res.status(), 'DELETE /api/coffee-products/:id must not exist').toBe(404)
  })
})

// ── 7. merge happy path: repoint + delete, target-wins-entirely ──────────────

test.describe('UC-PC-007 — merge B into A', () => {
  test('repoints B’s snapshots to A, deletes B, leaves A byte-identical — exactly two writes, no transactions row', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const nameA = `${uniq()} Cierny Kremen`
    const nameB = `${nameA} Honey`
    const db = openDb()
    let A, B, snapA, snapB1, snapB2, before
    try {
      // A carries deliberately DIFFERENT metadata than B — target-wins-entirely
      // means none of B's fields (image included) survive anywhere.
      A = seedCatalog(db, {
        name: nameA, description1: 'profil A', roast_type: 'Light roast',
        purpose: 'Filter', price_250g: 9.5, price_1kg: 36, image: 'data:image/png;base64,PCT5A',
      })
      B = seedCatalog(db, {
        name: nameB, description1: 'profil B', roast_type: 'Dark roast',
        purpose: 'Espresso', price_250g: 7.5, image: 'data:image/png;base64,PCT5B',
      })
      const c1 = seedCycle(db, `${nameA} c1`, 'coffee')
      const c2 = seedCycle(db, `${nameA} c2`, 'coffee')
      snapA = seedSnapshot(db, c1, { name: nameA, price_250g: 9.5, source_coffee_product_id: A })
      snapB1 = seedSnapshot(db, c1, { name: nameB, price_250g: 7.5, source_coffee_product_id: B })
      snapB2 = seedSnapshot(db, c2, { name: nameB, price_250g: 7.5, source_coffee_product_id: B })

      // Non-vacuity: a submitted order against one of B's snapshots, so the
      // no-financial-event pins are proven against data that exists.
      const friend = db.prepare('SELECT id FROM friends ORDER BY id LIMIT 1').get()
      expect(friend, 'seeded target must carry at least one friend (run e2e/seed.mjs)').toBeTruthy()
      const ord = db
        .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, 'submitted', 15)")
        .run(friend.id, c1)
      db.prepare(
        "INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, '250g', 2, 7.5)"
      ).run(Number(ord.lastInsertRowid), snapB1)

      before = {
        targetRow: JSON.stringify(catalogRowById(db, A)),
        // The merge's ONLY products write is the link column of B's snapshots.
        productsMinusLink: tableSnapshot(db, 'products', ['source_coffee_product_id']),
        orderItems: tableSnapshot(db, 'order_items'),
        orders: tableSnapshot(db, 'orders'),
        transactionsCount: db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
      }
    } finally {
      db.close()
    }

    const res = await merge(A, B)
    expect(res.status()).toBe(200)
    const body = await res.json()

    // Response contract: 200 { target: <catalog row A>, repointed_snapshots: n }.
    expect(Object.keys(body).sort()).toEqual(['repointed_snapshots', 'target'])
    expect(body.repointed_snapshots).toBe(2)
    expect(body.target).toEqual(JSON.parse(before.targetRow))

    const db2 = openDb()
    try {
      // Target wins entirely — A's row is byte-identical (updated_at included).
      expect(JSON.stringify(catalogRowById(db2, A)), 'A must be byte-identical after the merge').toBe(before.targetRow)
      // B is gone — the merge is the module's only catalog-row deleter.
      expect(catalogRowById(db2, B), 'B must be deleted').toBeNull()
      // Both of B's snapshots now link to A; A's own snapshot is untouched.
      expect(productRow(db2, snapB1).source_coffee_product_id).toBe(A)
      expect(productRow(db2, snapB2).source_coffee_product_id).toBe(A)
      expect(productRow(db2, snapA).source_coffee_product_id).toBe(A)
      // No snapshot mutation beyond the link column, no order/financial event
      // (the GSO-T6 lesson: a merge is a metadata repointing).
      expect(tableSnapshot(db2, 'products', ['source_coffee_product_id']),
        'the merge writes EXACTLY source_coffee_product_id on products').toBe(before.productsMinusLink)
      expect(tableSnapshot(db2, 'order_items'), 'order_items must not move').toBe(before.orderItems)
      expect(tableSnapshot(db2, 'orders'), 'orders must not move').toBe(before.orders)
      expect(db2.prepare('SELECT COUNT(*) AS n FROM transactions').get().n,
        'a merge must never write a transactions row').toBe(before.transactionsCount)
    } finally {
      db2.close()
    }

    // Convergence per §UC-PC-007: a repeated merge of the now-deleted source is
    // a plain 404 ("either id unknown") — not an idempotent 200.
    const again = await merge(A, B)
    expect(again.status(), 'repeat merge of a deleted source is 404').toBe(404)
    const db3 = openDb()
    try {
      expect(JSON.stringify(catalogRowById(db3, A)), 'the repeat attempt writes nothing').toBe(before.targetRow)
    } finally {
      db3.close()
    }
  })
})

// ── 8. merge refusals: 409 cross-roastery, 400 self/shape, 404 ordering ──────

test.describe('UC-PC-007 — refusals', () => {
  test('cross-roastery merge is 409 field:roastery with NOTHING written (byte-compare)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const nameA = `${uniq()} Modra Hora`
    const nameB = `${nameA} Honey`
    const otherRoastery = `Praziaren ${uniq()}`
    const db = openDb()
    let A, B, before
    try {
      A = seedCatalog(db, { name: nameA, price_250g: 9 })
      B = seedCatalog(db, { name: nameB, price_250g: 8, roastery: otherRoastery })
      const c = seedCycle(db, `${nameA} c`, 'coffee')
      seedSnapshot(db, c, { name: nameB, price_250g: 8, roastery: otherRoastery, source_coffee_product_id: B })
      before = {
        catalog: tableSnapshot(db, 'coffee_products'),
        products: tableSnapshot(db, 'products'),
      }
    } finally {
      db.close()
    }

    const res = await merge(A, B)
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.field).toBe('roastery')

    const db2 = openDb()
    try {
      expect(tableSnapshot(db2, 'coffee_products'), 'a refused merge writes nothing to the catalog').toBe(before.catalog)
      expect(tableSnapshot(db2, 'products'), 'a refused merge repoints nothing').toBe(before.products)
    } finally {
      db2.close()
    }
  })

  test('self-merge is 400', async () => {
    const id = await importOne(`${uniq()} Sam So Sebou`)
    const res = await merge(id, id)
    expect(res.status()).toBe(400)
  })

  test('unknown ids are 404 — either side, before any state 4xx', async () => {
    const id = await importOne(`${uniq()} Osamely`)
    // Unknown target, real source: 404 (and the source must survive).
    expect((await merge(999999999, id)).status()).toBe(404)
    // Real target, unknown source: 404.
    expect((await merge(id, 999999999)).status()).toBe(404)
    // Both unknown: still 404, never a 409 about state that cannot be known.
    expect((await merge(999999998, 999999999)).status()).toBe(404)
  })

  test('missing or unbindable source_id is 400', async () => {
    const id = await importOne(`${uniq()} Bez Zdroja`)
    expect((await ctx.post(`/api/coffee-products/${id}/merge`, { headers: admin(), data: {} })).status(),
      'missing source_id').toBe(400)
    expect((await ctx.post(`/api/coffee-products/${id}/merge`, {
      headers: admin(), data: { source_id: { a: 1 } },
    })).status(), 'object source_id (bindValue)').toBe(400)
    expect((await ctx.post(`/api/coffee-products/${id}/merge`, {
      headers: admin(), data: { source_id: [1, 2] },
    })).status(), 'array source_id (bindValue)').toBe(400)
  })
})

// ── 9. the acceptance pin: a later import never resurrects B blindly ─────────

test.describe('UC-PC-007 — post-merge imports meet the survivor', () => {
  test('importing B’s name after the merge fuzzy-flags against A; importing A’s name exact-matches A', async () => {
    const nameA = `${uniq()} Ruzovy Bourbon`
    const nameB = `${nameA} Honey`
    // One sheet, two rows: B lands as new + pending_fuzzy against A.
    const first = await importCsv(csvFor([
      { name: nameA, p250: '9,0' },
      { name: nameB, p250: '8,0' },
    ]))
    expect(first.status()).toBe(201)
    const r1 = (await first.json()).report
    const A = r1.new.find((e) => e.name === nameA).catalog_id
    const B = r1.new.find((e) => e.name === nameB).catalog_id

    expect((await merge(A, B)).status()).toBe(200)

    // B's sheet name in a LATER fresh import: a new row is created (the names
    // genuinely differ) but it is FLAGGED against the survivor A — never a
    // blind resurrection of B, and never a candidate pointing at the dead B.
    const second = await importCsv(csvFor([{ name: nameB, p250: '8,5' }]))
    expect(second.status()).toBe(201)
    const r2 = (await second.json()).report
    const reborn = r2.new.find((e) => e.name === nameB)
    expect(reborn, 'B’s name imports as new (its identity no longer exists)').toBeTruthy()
    expect(reborn.catalog_id, 'a fresh row, never B’s id back from the dead').not.toBe(B)
    const flag = r2.pending_fuzzy.find((e) => e.catalog_id === reborn.catalog_id)
    expect(flag, 'the re-import must be fuzzy-flagged').toBeTruthy()
    expect(flag.candidate_catalog_id, 'the candidate is the SURVIVOR A').toBe(A)

    // A's own name exact-matches the survivor — nothing new is created.
    const third = await importCsv(csvFor([{ name: nameA, p250: '9,0' }]))
    expect(third.status()).toBe(201)
    const r3 = (await third.json()).report
    expect(r3.matched.some((e) => e.catalog_id === A), 'A’s name exact-matches the survivor').toBe(true)
    expect(r3.new.some((e) => e.name === nameA)).toBe(false)
  })

  test('after a merge, a /migrate re-run links a still-unlinked snapshot to the SURVIVOR (the re-runnability seam)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Zeleny Vrch`
    const variant = `${stem} Honey`
    const db = openDb()
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      seedSnapshot(db, c1, { name: stem, price_250g: 8 })
      seedSnapshot(db, c2, { name: variant, price_250g: 9 })
    } finally {
      db.close()
    }

    // First migration: two rows + a fuzzy_review pair (the PC-T4 behavior).
    expect((await migrate()).status()).toBe(200)
    const db2 = openDb()
    let A, B, c3
    try {
      A = catalogByNormalized(db2, stem.toLowerCase())[0].id
      B = catalogByNormalized(db2, variant.toLowerCase())[0].id
      c3 = seedCycle(db2, `${stem} c3`, 'coffee')
    } finally {
      db2.close()
    }

    // The admin resolves the fuzzy pair with the merge…
    expect((await merge(A, B)).status()).toBe(200)

    // …and a LATER unlinked snapshot bearing the survivor's identity is picked
    // up by the re-run and linked to A — B is never recreated.
    const db3 = openDb()
    let lateSnap
    try {
      lateSnap = seedSnapshot(db3, c3, { name: stem.toUpperCase(), price_250g: 8.5 })
    } finally {
      db3.close()
    }
    const rerun = await migrate()
    expect(rerun.status()).toBe(200)
    expect((await rerun.json()).unlinked_remaining).toBe(0)

    const db4 = openDb()
    try {
      expect(productRow(db4, lateSnap).source_coffee_product_id, 'the late snapshot links to the survivor').toBe(A)
      expect(catalogByNormalized(db4, stem.toLowerCase())).toHaveLength(1)
      expect(catalogByNormalized(db4, variant.toLowerCase()), 'B’s identity is not resurrected by the re-run').toHaveLength(0)
    } finally {
      db4.close()
    }
  })
})

// ── 10. UC-PC-008 — the stateless duplicates review ───────────────────────────

test.describe('UC-PC-008 — GET /duplicates', () => {
  test('a fuzzy pair is listed with the exact shape, in-band similarity, and the list is similarity-DESC', async () => {
    const nameA = `${uniq()} Zlaty Klas`
    const nameB = `${nameA} Honey`
    const A = await importOne(nameA)
    const B = await importOne(nameB)

    const res = await duplicates()
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['pairs'])

    const pair = body.pairs.find(
      (p) => (p.a.id === A && p.b.id === B) || (p.a.id === B && p.b.id === A)
    )
    expect(pair, 'the near-miss pair must be listed').toBeTruthy()
    expect(Object.keys(pair).sort()).toEqual(['a', 'b', 'similarity'])
    expect(Object.keys(pair.a).sort()).toEqual(['cycles_count', 'id', 'name'])
    expect(Object.keys(pair.b).sort()).toEqual(['cycles_count', 'id', 'name'])
    expect(pair.similarity).toBeGreaterThanOrEqual(0.75)
    expect(pair.similarity).toBeLessThan(1)
    // Import-created rows have no snapshots — zero cycles each.
    expect(pair.a.cycles_count).toBe(0)
    expect(pair.b.cycles_count).toBe(0)

    // Ordered by similarity DESC across the whole (shared-DB) list.
    for (let i = 1; i < body.pairs.length; i++) {
      expect(body.pairs[i - 1].similarity).toBeGreaterThanOrEqual(body.pairs[i].similarity)
    }
  })

  test('after the merge the pair disappears from the recompute (stateless resolution)', async () => {
    const nameA = `${uniq()} Biela Skala`
    const nameB = `${nameA} Honey`
    const A = await importOne(nameA)
    const B = await importOne(nameB)

    const beforeRes = await duplicates()
    const beforePairs = (await beforeRes.json()).pairs
    expect(beforePairs.some((p) => (p.a.id === A && p.b.id === B) || (p.a.id === B && p.b.id === A)),
      'non-vacuity: the pair exists before the merge').toBe(true)

    expect((await merge(A, B)).status()).toBe(200)

    const afterRes = await duplicates()
    const afterPairs = (await afterRes.json()).pairs
    expect(afterPairs.some((p) => p.a.id === B || p.b.id === B), 'the deleted row appears in no pair').toBe(false)
    expect(afterPairs.some((p) => (p.a.id === A && p.b.id === B) || (p.a.id === B && p.b.id === A))).toBe(false)
  })

  test('dissimilar names never pair; a same-name pair across DIFFERENT roasteries never pairs', async () => {
    const rnd = () => Math.random().toString(36).slice(2, 14)
    // Deliberately NO shared uniq() stem — a long common prefix would put two
    // "different" fixtures inside the fuzzy band by construction.
    const alfa = await importOne(`Alfa ${rnd()}`)
    const omega = await importOne(`Omega ${rnd()}`)
    // Near-miss names, but in two different roasteries: matching is
    // within-roastery only (resolved decision 3).
    const stem = `${uniq()} Hraniciar`
    const gor = await importOne(stem)
    const other = await importOne(`${stem} Honey`, {}, `Praziaren ${rnd()}`)

    const res = await duplicates()
    expect(res.status()).toBe(200)
    const { pairs } = await res.json()
    const joins = (x, y) => pairs.some((p) => (p.a.id === x && p.b.id === y) || (p.a.id === y && p.b.id === x))
    expect(joins(alfa, omega), 'dissimilar names must not pair').toBe(false)
    expect(joins(gor, other), 'cross-roastery near-misses must not pair').toBe(false)
  })

  test('cycles_count counts DISTINCT cycles of linked snapshots, and a retired duplicate is still listed', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const nameA = `${uniq()} Sedy Kamen`
    const nameB = `${nameA} Honey`
    const db = openDb()
    let A, B
    try {
      A = seedCatalog(db, { name: nameA, price_250g: 9 })
      // Status ANY: a retired duplicate still pollutes history until merged.
      B = seedCatalog(db, { name: nameB, price_250g: 8, status: 'retired' })
      const c1 = seedCycle(db, `${nameA} c1`, 'coffee')
      const c2 = seedCycle(db, `${nameA} c2`, 'coffee')
      // A: three snapshots across TWO distinct cycles (DISTINCT is the pin);
      // B: one snapshot in one cycle.
      seedSnapshot(db, c1, { name: nameA, price_250g: 9, source_coffee_product_id: A })
      seedSnapshot(db, c1, { name: nameA, price_250g: 9, source_coffee_product_id: A })
      seedSnapshot(db, c2, { name: nameA, price_250g: 9, source_coffee_product_id: A })
      seedSnapshot(db, c2, { name: nameB, price_250g: 8, source_coffee_product_id: B })
    } finally {
      db.close()
    }

    const res = await duplicates()
    expect(res.status()).toBe(200)
    const { pairs } = await res.json()
    const pair = pairs.find(
      (p) => (p.a.id === A && p.b.id === B) || (p.a.id === B && p.b.id === A)
    )
    expect(pair, 'a retired duplicate must still be listed (status ANY)').toBeTruthy()
    const entryA = pair.a.id === A ? pair.a : pair.b
    const entryB = pair.a.id === B ? pair.a : pair.b
    expect(entryA.cycles_count, 'A: 3 snapshots but 2 DISTINCT cycles').toBe(2)
    expect(entryB.cycles_count).toBe(1)
  })
})
