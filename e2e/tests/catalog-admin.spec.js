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

// ═══════════════════════════════════════════════════════════════════════════════
// PC-T7 — 12 §UC-PC-009: catalog CRUD routes + AdminCatalog.vue.
//
// API half first, UI half last — ⚠ ORDER IS LOAD-BEARING: there is exactly ONE
// admin token app-wide, so the first `loginAsAdminUI` below INVALIDATES the
// file-level `adminToken` minted in beforeAll. Every API-only test must be
// declared ABOVE the UI describes; every UI test adopts the browser's token
// for its own API fixture calls (the documented harness trap).
// ═══════════════════════════════════════════════════════════════════════════════

// 1×1 red PNG — passes detectImageMime's magic-byte sniff.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function getCatalog(query = '') {
  return ctx.get(`/api/coffee-products${query}`, { headers: admin() })
}

function getCatalogRow(id) {
  return ctx.get(`/api/coffee-products/${id}`, { headers: admin() })
}

function patchCatalog(id, data) {
  return ctx.patch(`/api/coffee-products/${id}`, { headers: admin(), data })
}

function uploadImage(id, buffer = PNG_1PX) {
  return ctx.post(`/api/coffee-products/${id}/image`, {
    headers: admin(),
    multipart: { image: { name: 'photo.png', mimeType: 'image/png', buffer } },
  })
}

test.describe('UC-PC-009 — catalog CRUD (API)', () => {
  test('GET / lists an imported row with every catalog column plus cycles_count and all_time_kg', async () => {
    const name = `${uniq()} Zlaty Vrch`
    const id = await importOne(name, { purpose: 'Filter', desc1: 'Washed' })

    const res = await getCatalog()
    expect(res.status()).toBe(200)
    const rows = await res.json()
    const row = rows.find((r) => r.id === id)
    expect(row, 'the imported row appears in the list').toBeTruthy()
    expect(row.name).toBe(name)
    expect(row.normalized_name).toBe(name.toLowerCase())
    expect(row.status).toBe('available')
    expect(row.purpose).toBe('Filter')
    // The two computed columns — an import-created row has no snapshots.
    expect(row.cycles_count).toBe(0)
    expect(row.all_time_kg).toBe(0)
    // Informational-attribute columns ride along (NULL until the admin edits).
    for (const col of ['country', 'region', 'altitude', 'farm', 'variety', 'processing', 'is_new', 'curator_pick_note', 'image']) {
      expect(Object.keys(row)).toContain(col)
    }
  })

  test('GET / filters: status, purpose, q (normalized substring), roastery — and array params refuse with 400', async () => {
    const stem = uniq()
    const nameA = `${stem} Ranna Hmla`
    const nameB = `${stem} Vecerny Mrak`
    const idA = await importOne(nameA, { purpose: 'Filter' })
    const idB = await importOne(nameB, { purpose: 'Espresso' })
    await patchCatalog(idB, { status: 'retired' })

    // q — substring over normalized_name via the ONE normalizer: search with
    // diacritics/case the stored name does not carry.
    const qRes = await getCatalog(`?q=${encodeURIComponent('RANNÁ HMLA')}`)
    const qRows = await qRes.json()
    expect(qRows.some((r) => r.id === idA)).toBe(true)
    expect(qRows.some((r) => r.id === idB)).toBe(false)

    const statusRes = await getCatalog(`?status=retired&q=${encodeURIComponent(stem)}`)
    const statusRows = await statusRes.json()
    expect(statusRows.map((r) => r.id)).toEqual([idB])

    const purposeRes = await getCatalog(`?purpose=Filter&q=${encodeURIComponent(stem)}`)
    expect((await purposeRes.json()).map((r) => r.id)).toEqual([idA])

    const roasteryRes = await getCatalog(`?roastery=Goriffee&q=${encodeURIComponent(stem)}`)
    const roasteryIds = (await roasteryRes.json()).map((r) => r.id)
    expect(roasteryIds).toContain(idA)
    expect(roasteryIds).toContain(idB)

    // A repeated param arrives as an array — refuse, never coerce (FUP-T13).
    const arrayRes = await getCatalog('?status=a&status=b')
    expect(arrayRes.status()).toBe(400)
    expect((await arrayRes.json()).field).toBe('status')
  })

  test('GET /:id returns the row + availability history; unknown and non-integer ids 404', async () => {
    const name = `${uniq()} Tichy Potok`
    const id = await importOne(name)

    const res = await getCatalogRow(id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.name).toBe(name)
    expect(Array.isArray(body.history), 'detail carries the availability history').toBe(true)
    expect(body.history).toEqual([])

    expect((await getCatalogRow(99999999)).status()).toBe(404)
    expect((await ctx.get('/api/coffee-products/abc', { headers: admin() })).status()).toBe(404)
  })

  test('GET /:id history lists offering cycles with per-cycle kg; GET / computes cycles_count and all_time_kg', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Modra Lagoda`
    const id = await importOne(name)

    const db = openDb()
    let c1, c2
    try {
      c1 = seedCycle(db, `${name} c1`, 'coffee')
      c2 = seedCycle(db, `${name} c2`, 'coffee')
      const s1 = seedSnapshot(db, c1, { name, price_250g: 9, source_coffee_product_id: id })
      seedSnapshot(db, c2, { name, price_250g: 9, source_coffee_product_id: id })
      // One submitted 1kg order in c1 → all_time_kg 1, history c1 friend_kg 1.
      const friendId = Number(db
        .prepare('INSERT INTO friends (cycle_id, name, access_token, active) VALUES (?, ?, ?, 1)')
        .run(c1, `${name} F`, `${uniq()}tok${Math.random().toString(36).slice(2)}`).lastInsertRowid)
      const orderId = Number(db
        .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, 'submitted', 0)")
        .run(friendId, c1).lastInsertRowid)
      db.prepare('INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, ?, 1, 10)')
        .run(orderId, s1, '1kg')
    } finally {
      db.close()
    }

    const listRes = await getCatalog(`?q=${encodeURIComponent(name)}`)
    const row = (await listRes.json()).find((r) => r.id === id)
    expect(row.cycles_count, 'two distinct offering cycles').toBe(2)
    expect(row.all_time_kg, 'the PC-T6 seam: allTimeKgByCatalogId feeds the column').toBe(1)

    const detail = await (await getCatalogRow(id)).json()
    expect(detail.history.length).toBe(2)
    const h1 = detail.history.find((h) => h.cycle_id === c1)
    const h2 = detail.history.find((h) => h.cycle_id === c2)
    expect(h1.total_kg).toBe(1)
    expect(h1.friend_kg).toBe(1)
    expect(h2.total_kg).toBe(0)
  })

  test('PATCH edits metadata + informational attributes + is_new/curator note + prices; unknown id 404', async () => {
    const name = `${uniq()} Kamenny Dvor`
    const id = await importOne(name)

    const res = await patchCatalog(id, {
      country: 'Kolumbia',
      region: 'Huila',
      altitude: '1900 m',
      farm: 'El Paraiso',
      variety: 'Pink Bourbon',
      processing: 'Honey',
      description1: 'novy popis',
      roast_type: 'Light roast',
      purpose: 'Espresso',
      is_new: true,
      curator_pick_note: 'obľúbená káva',
      price_250g: 11.5,
      price_1kg: 39,
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.country).toBe('Kolumbia')
    expect(body.processing).toBe('Honey')
    expect(body.is_new).toBe(1)
    expect(body.curator_pick_note).toBe('obľúbená káva')
    expect(body.price_250g).toBe(11.5)

    // Persisted, not just echoed.
    const detail = await (await getCatalogRow(id)).json()
    expect(detail.region).toBe('Huila')
    expect(detail.altitude).toBe('1900 m')
    expect(detail.farm).toBe('El Paraiso')
    expect(detail.variety).toBe('Pink Bourbon')
    expect(detail.description1).toBe('novy popis')
    expect(detail.purpose).toBe('Espresso')
    expect(detail.price_1kg).toBe(39)

    expect((await patchCatalog(99999999, { country: 'X' })).status()).toBe(404)
  })

  test('PATCH rename recomputes normalized_name via the ONE helper; collision answers 409 field:name and writes nothing', async () => {
    const stem = uniq()
    const idA = await importOne(`${stem} Cierny Les`)
    const idB = await importOne(`${stem} Sivy Kamen`)

    // Rename B with diacritics/punctuation — normalized key must follow.
    const renamed = `${stem} Nová – Káva!`
    const ok = await patchCatalog(idB, { name: renamed })
    expect(ok.status()).toBe(200)
    expect((await ok.json()).normalized_name).toBe(`${stem.toLowerCase()} nova kava`)
    // Findable under the new normalized identity.
    const found = await (await getCatalog(`?q=${encodeURIComponent('nová káva')}`)).json()
    expect(found.some((r) => r.id === idB)).toBe(true)

    // Collision: rename B to A's name (same default roastery) → 409.
    const clash = await patchCatalog(idB, { name: `${stem} Cierny Les` })
    expect(clash.status()).toBe(409)
    const clashBody = await clash.json()
    expect(clashBody.field).toBe('name')
    // Nothing written — B keeps its renamed identity.
    const after = await (await getCatalogRow(idB)).json()
    expect(after.name).toBe(renamed)
    expect(after.id).not.toBe(idA)

    // A name that normalizes to '' has no identity — 400, never stored.
    const empty = await patchCatalog(idB, { name: '–––' })
    expect(empty.status()).toBe(400)
    expect((await empty.json()).field).toBe('name')
  })

  test('PATCH status: available/retired only, anything else 400; retirement touches no snapshot', async () => {
    const name = `${uniq()} Zeleny Haj`
    const id = await importOne(name)

    const bad = await patchCatalog(id, { status: 'deleted' })
    expect(bad.status()).toBe(400)
    expect((await bad.json()).field).toBe('status')

    const retired = await patchCatalog(id, { status: 'retired' })
    expect(retired.status()).toBe(200)
    expect((await retired.json()).status).toBe('retired')

    // And back — retirement is a status, not a tombstone.
    expect((await patchCatalog(id, { status: 'available' })).status()).toBe(200)
  })

  test('roastery is NOT PATCH-editable (half of the identity key), and there is NO DELETE route (decision 9)', async () => {
    const name = `${uniq()} Stara Hora`
    const id = await importOne(name)

    const res = await patchCatalog(id, { roastery: 'Ina Praziaren' })
    expect(res.status()).toBe(200)
    expect((await res.json()).roastery, 'roastery must survive a PATCH attempt').toBe('Goriffee')

    // Decision 9: no DELETE route exists on the catalog — express falls through.
    const del = await ctx.delete(`/api/coffee-products/${id}`, { headers: admin() })
    expect(del.status(), 'DELETE /api/coffee-products/:id must not exist').toBe(404)
    // The row survives the attempt.
    expect((await getCatalogRow(id)).status()).toBe(200)
  })

  test('POST /:id/image stores the sniffed data: URI; the list serves it; unknown id 404; junk bytes 400', async () => {
    const name = `${uniq()} Fotogenicka`
    const id = await importOne(name)

    const res = await uploadImage(id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.image, 'magic-byte sniffed mime, not the client label').toMatch(/^data:image\/png;base64,/)

    const listRow = (await (await getCatalog(`?q=${encodeURIComponent(name)}`)).json()).find((r) => r.id === id)
    expect(listRow.image).toMatch(/^data:image\/png;base64,/)

    expect((await uploadImage(99999999)).status()).toBe(404)

    const junk = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: admin(),
      multipart: { image: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') } },
    })
    expect(junk.status(), 'the same magic-byte validation as products.js').toBe(400)
  })

  test('route ordering: the parametric GET /:id shadows neither /duplicates nor /stats', async () => {
    const dupRes = await duplicates()
    expect(dupRes.status()).toBe(200)
    expect(Array.isArray((await dupRes.json()).pairs)).toBe(true)

    const statsRes = await ctx.get('/api/coffee-products/stats', { headers: admin() })
    expect(statsRes.status()).toBe(200)
    const statsBody = await statsRes.json()
    expect(Array.isArray(statsBody.products)).toBe(true)
    expect(statsBody.window).toBeTruthy()
  })
})

// ── UI half — AdminCatalog.vue + the CycleDetail modalError obligation ─────────
//
// ⚠ Every test here logs in through the UI FIRST and adopts the browser's token
// for its API fixture calls (ONE admin token app-wide — the documented trap).

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  return token
}

const uiHeaders = (token) => ({ 'X-Admin-Token': token })

async function uiImportOne(token, name, extra = {}) {
  const res = await ctx.post('/api/coffee-products/import', {
    headers: uiHeaders(token),
    multipart: {
      file: { name: 'catalog.csv', mimeType: 'text/csv', buffer: Buffer.from(csvFor([{ name, p250: '8,0', ...extra }]), 'utf8') },
    },
  })
  expect(res.status()).toBe(201)
  const { report } = await res.json()
  return report.new.find((e) => e.name === name).catalog_id
}

test.describe('UC-PC-009 — AdminCatalog view (UI)', () => {
  test('the admin MAIN MENU carries "Katalóg" and it lands on the catalog list', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const name = `${uniq()} Navigacna`
    await uiImportOne(token, name)

    await page.getByRole('button', { name: 'Katalóg', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/catalog/)

    await page.getByTestId('catalog-search').fill(name)
    const row = page.getByTestId('catalog-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Dostupná')).toBeVisible()
  })

  test('needs-image affordance: amber "Chýba fotka" badge + the chýba-fotka filter', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const bare = `${stem} Bez Fotky`
    const shot = `${stem} S Fotkou`
    const bareId = await uiImportOne(token, bare)
    const shotId = await uiImportOne(token, shot)
    const up = await ctx.post(`/api/coffee-products/${shotId}/image`, {
      headers: uiHeaders(token),
      multipart: { image: { name: 'p.png', mimeType: 'image/png', buffer: PNG_1PX } },
    })
    expect(up.status()).toBe(200)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(stem)
    await expect(page.getByTestId('catalog-row')).toHaveCount(2)

    const bareRow = page.getByTestId('catalog-row').filter({ hasText: bare })
    await expect(bareRow.getByText('Chýba fotka')).toBeVisible()
    const shotRow = page.getByTestId('catalog-row').filter({ hasText: shot })
    await expect(shotRow.getByText('Chýba fotka')).toHaveCount(0)

    // The filter — the report's needs_image flag made durable.
    await page.getByTestId('needs-image-filter').check()
    await expect(page.getByTestId('catalog-row')).toHaveCount(1)
    await expect(page.getByTestId('catalog-row').first()).toContainText(bare)
    void bareId
  })

  test('edit dialog: informational attributes persist; a rename collision renders the 409 IN-DIALOG', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const nameA = `${stem} Prva Kava`
    const nameB = `${stem} Druha Kava`
    await uiImportOne(token, nameA)
    await uiImportOne(token, nameB)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(stem)
    await expect(page.getByTestId('catalog-row')).toHaveCount(2)

    // Edit B: set an informational attribute and save.
    await page.getByTestId('catalog-row').filter({ hasText: nameB }).getByRole('button', { name: 'Upraviť' }).click()
    const dialog = page.getByTestId('catalog-edit-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('catalog-edit-country').fill('Etiópia')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(dialog).not.toBeVisible()

    // Persisted — reopen shows the value.
    await page.getByTestId('catalog-row').filter({ hasText: nameB }).getByRole('button', { name: 'Upraviť' }).click()
    await expect(dialog.getByTestId('catalog-edit-country')).toHaveValue('Etiópia')

    // The collision: rename B to A's name. The 409 renders INSIDE the dialog
    // (module-11 modalError — the page Alert hides behind the radix overlay),
    // and the dialog stays open.
    await dialog.getByTestId('catalog-edit-name').fill(nameA)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(dialog.getByTestId('catalog-modal-error')).toBeVisible()
    await expect(dialog.getByTestId('catalog-modal-error')).toContainText('existuje')
    await expect(dialog).toBeVisible()
  })

  test('image uploaded once via the edit dialog lands on the CATALOG row (THE image home)', async ({ page }) => {
    // ⚠ Headline-acceptance note: the friend-order-page half ("appears on a NEW
    // cycle's picker-created snapshot via the COALESCE") belongs to PC-T8 —
    // neither the picker nor the snapshot-read COALESCE exists yet (12
    // §UC-PC-012). This pins the half PC-T7 owns: one upload, stored on the
    // catalog row every future snapshot will COALESCE to.
    const token = await loginAsAdminUI(page)
    const name = `${uniq()} Portretna`
    const id = await uiImportOne(token, name)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(name)
    await page.getByTestId('catalog-row').filter({ hasText: name }).getByRole('button', { name: 'Upraviť' }).click()
    const dialog = page.getByTestId('catalog-edit-dialog')
    await dialog.getByTestId('catalog-image-input').setInputFiles({
      name: 'kava.png', mimeType: 'image/png', buffer: PNG_1PX,
    })
    await expect(dialog.getByTestId('catalog-image-preview')).toBeVisible()

    const detail = await (await ctx.get(`/api/coffee-products/${id}`, { headers: uiHeaders(token) })).json()
    expect(detail.image).toMatch(/^data:image\/png;base64,/)
  })

  test('import section drives a real CSV import and renders the UC-PC-004 report buckets incl. pending_fuzzy → merge flow', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const base = `${stem} Ruzovy Kvet`
    // Pre-existing near-name so the UI import fuzzy-flags against it.
    await uiImportOne(token, base)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-import').click()

    // CSV with one clean new row, one fuzzy near-miss and one nameless row —
    // all three buckets render from ONE 201 (a 201 is NOT "everything
    // imported": the nameless row lands in unparsed). ⚠ The clean row must NOT
    // share the uniq() stem with the fuzzy fixture — a long common prefix puts
    // two "different" names inside the fuzzy band by construction (the same
    // note as the PC-T5 dissimilar-names test).
    // Two long random tokens, no fixed word: repeated runs of THIS test leave
    // prior clean rows in the shared DB, and a fixed prefix would push two of
    // them into the fuzzy band (fixed 15 shared chars vs ~8 random = sim ≥ .75).
    const cleanName = `${Math.random().toString(36).slice(2, 14)} ${Math.random().toString(36).slice(2, 14)}`
    const csv = csvFor([
      { name: cleanName, purpose: 'Filter', p250: '9,0' },
      { name: `${base} Honey`, purpose: 'Filter', p250: '10,0' },
      { name: '', desc1: 'bez mena', p250: '5,0' },
    ])
    await page.getByTestId('import-csv-input').setInputFiles({
      name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
    })
    await page.getByTestId('import-csv-button').click()

    const report = page.getByTestId('import-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('2 nových')
    await expect(report).toContainText('1 na kontrolu')
    await expect(report).toContainText('1 nespracovaných')
    await expect(report).toContainText(cleanName)

    // The fuzzy entry: "Je to premenovaný X?" naming the CANDIDATE (the
    // pre-existing row), with a link into the merge flow.
    const fuzzy = report.getByTestId('fuzzy-entry')
    await expect(fuzzy).toHaveCount(1)
    await expect(fuzzy).toContainText(`Je to premenovaný ${base}?`)

    // The unparsed entry renders its reason string prominently (row numbers
    // count parsed records, and the UI says so).
    await expect(report.getByTestId('unparsed-entry')).toHaveCount(1)

    // The merge-flow link lands on the duplicates tab with the pair recomputed.
    // ⚠ Identified by BOTH member buttons, not by hasText: the shared DB
    // accumulates same-prefix fixtures from other tests that also clear the
    // fuzzy band, so a substring match can hit several cards.
    await fuzzy.getByTestId('fuzzy-merge-link').click()
    const pair = page.getByTestId('dup-pair')
      .filter({ has: page.getByRole('button', { name: `Ponechať „${base}“`, exact: true }) })
      .filter({ has: page.getByRole('button', { name: `Ponechať „${base} Honey“`, exact: true }) })
    await expect(pair).toHaveCount(1)
  })

  test('duplicates section merges a pair behind an INLINE confirm; the pair disappears', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const keeper = `${stem} Povodna Kava`
    const dupe = `${keeper} Honey`
    await uiImportOne(token, keeper)
    await uiImportOne(token, dupe)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-duplicates').click()
    // Identified by BOTH member buttons (see the import test's note — hasText
    // alone can match other same-prefix fixtures in the shared DB).
    const pair = page.getByTestId('dup-pair')
      .filter({ has: page.getByRole('button', { name: `Ponechať „${keeper}“`, exact: true }) })
      .filter({ has: page.getByRole('button', { name: `Ponechať „${dupe}“`, exact: true }) })
    await expect(pair).toHaveCount(1)

    // ⚠ Once "Ponechať" is clicked the card swaps its buttons for the confirm
    // row, so the has-button `pair` locator momentarily matches nothing — the
    // confirm is addressed globally (only one pendingMerge exists at a time).
    // Inline confirm — the merge must NOT fire on the first click.
    await pair.getByRole('button', { name: `Ponechať „${keeper}“`, exact: true }).click()
    const confirm = page.getByTestId('merge-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText(dupe)
    // Cancel really cancels — the buttons come back, nothing merged.
    await confirm.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByTestId('merge-confirm')).toHaveCount(0)
    await expect(pair).toHaveCount(1)

    // Now for real.
    await pair.getByRole('button', { name: `Ponechať „${keeper}“`, exact: true }).click()
    await page.getByTestId('merge-confirm').getByRole('button', { name: 'Potvrdiť' }).click()
    // The merged row is deleted, so its name can appear in NO pair.
    await expect(page.getByTestId('dup-pair').filter({ hasText: dupe })).toHaveCount(0)

    // The survivor still lists; the merged row is gone from the catalog.
    await page.getByTestId('catalog-tab-products').click()
    await page.getByTestId('catalog-search').fill(stem)
    await expect(page.getByTestId('catalog-row')).toHaveCount(1)
    await expect(page.getByTestId('catalog-row').first()).toContainText(keeper)
  })

  test('migration trigger renders the UC-PC-006 report (idempotent — safe to fire from the UI at any time)', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    await page.getByTestId('migrate-button').click()
    const report = page.getByTestId('migrate-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('Výsledok migrácie')
    await expect(report).toContainText('vytvorených')
    await expect(report).toContainText('prepojených')
  })

  test('stats tab renders the ranking with the imported product (window OMITTED for all time)', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const name = `${uniq()} Statisticka`
    await uiImportOne(token, name, { purpose: 'Filter' })

    await page.goto('/admin/catalog')

    // ⚠ The all-time load must OMIT last_n_cycles, never send it empty (the
    // route 400s on an empty value by design).
    const statsRequests = []
    page.on('request', (req) => {
      if (req.url().includes('/api/coffee-products/stats')) statsRequests.push(req.url())
    })

    await page.getByTestId('catalog-tab-stats').click()
    const table = page.getByTestId('stats-table')
    await expect(table).toBeVisible()
    const row = page.getByTestId('stats-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)

    expect(statsRequests.length).toBeGreaterThan(0)
    for (const url of statsRequests) {
      expect(url, 'all-time = the param is absent, not empty').not.toContain('last_n_cycles')
    }
  })

  test('admin-skin invariance: AdminCatalog renders ZERO Podpultovka theme classes', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto('/admin/catalog')
    await expect(page.getByTestId('catalog-table').or(page.getByText('Žiadne produkty v katalógu')).first()).toBeVisible()

    // The UC-PC-011 admin-skin assertion: none of the friends-theme scopes or
    // neo primitives may appear on an admin view (01-architecture scope rule).
    const themed = page.locator('.app, .appbar, .cartbar, .cat-tabs, .modal-layer, .tabgroup, .vbox, .stepper, .m-foot, .inp, .h-screen.hl, .catarrow')
    await expect(themed).toHaveCount(0)
  })
})

test.describe('UC-PC-005 follow-up — CycleDetail saveProduct surfaces the duplicate_in_cycle 409 in-dialog', () => {
  test('adding an exact-name duplicate into one cycle shows the 409 inside the product dialog', async ({ page }) => {
    // Review-assigned obligation (PROGRESS PC-T7 row): saveProduct used to
    // swallow ALL errors — PC-T3's deliberate 409 closed the dialog's own
    // await chain silently and the admin never learned the product was not
    // created.
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const cycleRes = await ctx.post('/api/cycles', {
      headers: uiHeaders(token),
      data: { name: `${stem} cyklus`, type: 'coffee' },
    })
    expect(cycleRes.status()).toBe(201)
    const cycleId = (await cycleRes.json()).id
    const productName = `${stem} Duplikat`
    const createRes = await ctx.post('/api/products', {
      headers: uiHeaders(token),
      data: { cycle_id: cycleId, name: productName, price_250g: 9 },
    })
    expect(createRes.status()).toBe(201)

    await page.goto(`/admin/cycle/${cycleId}`)
    await page.getByRole('button', { name: '+ Pridať produkt' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The name field is the first visible text input in the dialog (the file
    // input above it is hidden).
    await dialog.locator('input:visible').first().fill(productName)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()

    const error = dialog.getByTestId('product-modal-error')
    await expect(error, 'the 409 renders IN-DIALOG (module-11 modalError)').toBeVisible()
    await expect(error).toContainText('existuje')
    await expect(dialog, 'the dialog stays open on a failed save').toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PC-T8 — 12 §UC-PC-012 (cycle creation from the catalog picker) +
//         12 §UC-PC-013 (the per-cycle importers are RETIRED).
//
// ⚠ These describes run AFTER the PC-T7 UI describes, whose loginAsAdminUI
// calls INVALIDATE the file-level adminToken (one admin token app-wide) — so
// every API-only describe below re-mints `adminToken` in its own beforeAll,
// and every UI test adopts the browser's token, exactly as PC-T7's do.
// ═══════════════════════════════════════════════════════════════════════════════

// A second valid 1×1 PNG (different pixel ⇒ different base64), so "the
// snapshot's own image wins the COALESCE" can be asserted as an inequality.
const PNG_1PX_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/p8FQrgAAAABJRU5ErkJggg==',
  'base64'
)

async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login (the UI describes above invalidated the token)').toBe(200)
  adminToken = (await login.json()).token
}

function createCycle(data) {
  return ctx.post('/api/cycles', { headers: admin(), data })
}

async function cycleProducts(cycleId) {
  const res = await ctx.get(`/api/products/cycle/${cycleId}`)
  expect(res.status()).toBe(200)
  return res.json()
}

// A friend with real credentials + a Bearer session (the guest-link.spec.js
// makeHost pattern) — for the guest-listing COALESCE and the walkthrough.
let pct8Seq = 0
async function makeFriendSession(label) {
  const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const suffix = `_${runId}${++pct8Seq}`
  const username = `pct8_${label}`.slice(0, 30 - suffix.length) + suffix
  const created = await ctx.post('/api/friends', { headers: admin(), data: { name: `PCT8 ${label} ${runId}` } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()
  expect((await ctx.put(`/api/friends/${friend.id}/admin-username`, { headers: admin(), data: { username } })).status()).toBe(200)
  expect((await ctx.put(`/api/friends/${friend.id}/reset-password`, { headers: admin(), data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
  })
  expect(chg.status(), 'forced change cleared').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name: `PCT8 ${label} ${runId}`, token, auth: { Authorization: `Bearer ${token}` } }
}

test.describe('UC-PC-012 — the catalog picker on POST /api/cycles (API)', () => {
  test.beforeAll(refreshAdminToken)

  test('two ticked products snapshot into the cycle: linked, all six prices FROZEN from the catalog, stock_limit_g NULL', async () => {
    const stem = uniq()
    const idA = await importOne(`${stem} Vyber A`, { purpose: 'Filter', desc1: 'Washed profil' })
    const idB = await importOne(`${stem} Vyber B`, { purpose: 'Espresso' })
    // Give A the full price vocabulary so the freeze covers every column.
    const patched = await patchCatalog(idA, {
      price_150g: 5.5, price_200g: 6.5, price_250g: 8.8, price_500g: 15, price_1kg: 27.5, price_20pc5g: 7.4,
    })
    expect(patched.status()).toBe(200)
    const catalogA = await (await getCatalogRow(idA)).json()
    const catalogB = await (await getCatalogRow(idB)).json()

    const res = await createCycle({ name: `${stem} cyklus`, type: 'coffee', coffee_product_ids: [idA, idB] })
    expect(res.status()).toBe(201)
    const cycleId = (await res.json()).id

    const products = await cycleProducts(cycleId)
    expect(products.length, 'exactly the two ticked products snapshot').toBe(2)
    const snapA = products.find((p) => p.source_coffee_product_id === idA)
    const snapB = products.find((p) => p.source_coffee_product_id === idB)
    expect(snapA, 'A is linked via source_coffee_product_id').toBeTruthy()
    expect(snapB, 'B is linked via source_coffee_product_id').toBeTruthy()

    // Snapshot fields copied from the catalog — the freeze moment.
    expect(snapA.name).toBe(catalogA.name)
    expect(snapA.description1).toBe(catalogA.description1)
    expect(snapA.purpose).toBe('Filter')
    expect(snapA.roastery).toBe(catalogA.roastery)
    for (const f of ['price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g']) {
      expect(snapA[f], `${f} copied from the catalog's current price`).toBe(catalogA[f])
    }
    expect(snapB.price_250g).toBe(catalogB.price_250g)
    // Per-cycle admin concern, set later via the snapshot PATCH — never copied.
    expect(snapA.stock_limit_g).toBeNull()
    expect(snapB.stock_limit_g).toBeNull()
  })

  test('the freeze is one-way: a later catalog edit leaves the served snapshot byte-identical', async () => {
    const stem = uniq()
    const id = await importOne(`${stem} Zmrazena`, { purpose: 'Filter', p250: '9,0' })
    const res = await createCycle({ name: `${stem} freeze cyklus`, type: 'coffee', coffee_product_ids: [id] })
    expect(res.status()).toBe(201)
    const cycleId = (await res.json()).id
    const [snap] = await cycleProducts(cycleId)
    expect(snap.source_coffee_product_id).toBe(id)

    const before = JSON.stringify(await (await ctx.get(`/api/products/${snap.id}`)).json())

    // Move the catalog: price AND sheet-sourced metadata. (⚠ deliberately NOT
    // the catalog image — the UC-PC-012 COALESCE makes a catalog image visible
    // on the snapshot BY DESIGN; that is pinned separately below.)
    const edit = await patchCatalog(id, { price_250g: 99.99, description1: 'uplne novy profil' })
    expect(edit.status()).toBe(200)

    const after = JSON.stringify(await (await ctx.get(`/api/products/${snap.id}`)).json())
    expect(after, 'the snapshot is byte-identical after the catalog edit').toBe(before)
  })

  test('the freeze pin on the RAW row (DB): image and stock_limit_g stored NULL, no column moves on a catalog edit', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const id = await importOne(`${stem} Surova`, { p250: '8,5' })
    // Catalog image BEFORE the picker runs — the raw snapshot must still store NULL
    // (resolved decision 5: the read-path COALESCE carries the image, never a copy).
    const up = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: admin(),
      multipart: { image: { name: 'p.png', mimeType: 'image/png', buffer: PNG_1PX } },
    })
    expect(up.status()).toBe(200)

    const res = await createCycle({ name: `${stem} raw cyklus`, type: 'coffee', coffee_product_ids: [id] })
    expect(res.status()).toBe(201)
    const cycleId = (await res.json()).id
    const [snap] = await cycleProducts(cycleId)

    const db = openDb()
    try {
      const rawBefore = db.prepare('SELECT * FROM products WHERE id = ?').get(snap.id)
      expect(rawBefore.image, 'the raw snapshot stores image = NULL (decision 5)').toBeNull()
      expect(rawBefore.stock_limit_g).toBeNull()

      const edit = await patchCatalog(id, { price_250g: 42.42, price_1kg: 111 })
      expect(edit.status()).toBe(200)

      const rawAfter = db.prepare('SELECT * FROM products WHERE id = ?').get(snap.id)
      expect(JSON.stringify(rawAfter), 'the raw products row is byte-identical').toBe(JSON.stringify(rawBefore))
    } finally {
      db.close()
    }
  })

  test('a retired catalog product never enters a new cycle, even by hand-crafted request; unknown ids are skipped', async () => {
    const stem = uniq()
    const retiredId = await importOne(`${stem} Vyradena`)
    const okId = await importOne(`${stem} Dostupna`)
    expect((await patchCatalog(retiredId, { status: 'retired' })).status()).toBe(200)

    const res = await createCycle({
      name: `${stem} retired cyklus`, type: 'coffee',
      coffee_product_ids: [retiredId, okId, 99999999],
    })
    expect(res.status(), 'skipped exactly as the bakery loop skips inactive products — never a refusal that loses the rest').toBe(201)
    const products = await cycleProducts((await res.json()).id)
    expect(products.length).toBe(1)
    expect(products[0].source_coffee_product_id).toBe(okId)
  })

  test('coffee_product_ids is OPTIONAL: an id-less coffee POST still creates the (empty) cycle', async () => {
    const stem = uniq()
    const res = await createCycle({ name: `${stem} prazdny cyklus`, type: 'coffee' })
    expect(res.status()).toBe(201)
    expect(await cycleProducts((await res.json()).id)).toEqual([])
  })

  test('element hygiene (FUP-T13): unbindable elements are skipped, never a 500; a non-array is ignored', async () => {
    const stem = uniq()
    const okId = await importOne(`${stem} Hygiena`)
    const res = await createCycle({
      name: `${stem} hygiena cyklus`, type: 'coffee',
      coffee_product_ids: [{}, true, ['1'], null, { toString: 1 }, okId],
    })
    expect(res.status(), 'the ARRAY was checked, its ELEMENTS are too').toBe(201)
    const products = await cycleProducts((await res.json()).id)
    expect(products.length, 'only the bindable, available id snapshots').toBe(1)
    expect(products[0].source_coffee_product_id).toBe(okId)

    const nonArray = await createCycle({ name: `${stem} nonarray cyklus`, type: 'coffee', coffee_product_ids: 'abc' })
    expect(nonArray.status(), 'a non-array is ignored (Array.isArray gate)').toBe(201)
    expect(await cycleProducts((await nonArray.json()).id)).toEqual([])
  })

  test('a BAKERY cycle ignores coffee_product_ids — the bakery branch is untouched', async () => {
    const stem = uniq()
    const coffeeId = await importOne(`${stem} Kava Do Pekarne`)
    const bp = await ctx.post('/api/bakery-products', {
      headers: admin(),
      data: { name: `${stem} Makovnik`, price: 5, category: 'sladké' },
    })
    expect(bp.status()).toBe(201)
    const bpId = (await bp.json()).id

    const res = await createCycle({
      name: `${stem} bakery cyklus`, type: 'bakery',
      bakery_product_ids: [bpId], coffee_product_ids: [coffeeId],
    })
    expect(res.status()).toBe(201)
    const products = await cycleProducts((await res.json()).id)
    expect(products.length, 'the bakery snapshot flow ran exactly as before').toBe(1)
    expect(products[0].source_bakery_product_id).toBe(bpId)
    expect(products[0].source_coffee_product_id, 'coffee ids are honoured only on a coffee cycle').toBeNull()
  })
})

test.describe('UC-PC-012 — the image COALESCE on the snapshot read paths (API)', () => {
  test.beforeAll(refreshAdminToken)

  test('a catalog image uploaded ONCE appears on the picker-created snapshot (list + detail); the snapshot\'s own image still wins', async () => {
    const stem = uniq()
    const id = await importOne(`${stem} Fotogenicka`)
    const up = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: admin(),
      multipart: { image: { name: 'kava.png', mimeType: 'image/png', buffer: PNG_1PX } },
    })
    expect(up.status()).toBe(200)
    const catalogImage = (await up.json()).image
    expect(catalogImage).toMatch(/^data:image\/png;base64,/)

    const res = await createCycle({ name: `${stem} foto cyklus`, type: 'coffee', coffee_product_ids: [id] })
    expect(res.status()).toBe(201)
    const cycleId = (await res.json()).id

    // The list read the friend order page consumes.
    const [listed] = await cycleProducts(cycleId)
    expect(listed.image, 'GET /products/cycle/:id serves COALESCE(p.image, cp.image)').toBe(catalogImage)

    // The detail read.
    const detail = await (await ctx.get(`/api/products/${listed.id}`)).json()
    expect(detail.image, 'GET /products/:id serves the same fallback').toBe(catalogImage)

    // A non-NULL snapshot image (manual upload) wins the COALESCE.
    const own = await ctx.post(`/api/products/${listed.id}/image`, {
      headers: admin(),
      multipart: { image: { name: 'own.png', mimeType: 'image/png', buffer: PNG_1PX_BLUE } },
    })
    expect(own.status()).toBe(200)
    const ownImage = (await own.json()).image
    expect(ownImage, 'the fixture really differs from the catalog image').not.toBe(catalogImage)
    const rereadList = await cycleProducts(cycleId)
    expect(rereadList[0].image, 'the snapshot\'s own image wins').toBe(ownImage)
    const rereadDetail = await (await ctx.get(`/api/products/${listed.id}`)).json()
    expect(rereadDetail.image).toBe(ownImage)
  })

  test('the GUEST product listing serves the COALESCEd image (read-only column change on the hostile route)', async () => {
    const stem = uniq()
    const id = await importOne(`${stem} Hostovska`)
    const up = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: admin(),
      multipart: { image: { name: 'g.png', mimeType: 'image/png', buffer: PNG_1PX } },
    })
    expect(up.status()).toBe(200)
    const catalogImage = (await up.json()).image

    const res = await createCycle({ name: `${stem} guest cyklus`, type: 'coffee', coffee_product_ids: [id] })
    expect(res.status()).toBe(201)
    const cycleId = (await res.json()).id
    const [snap] = await cycleProducts(cycleId)

    const host = await makeFriendSession('guestimg')
    const link = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
    expect(link.status(), 'host share link created').toBe(201)
    const token = (await link.json()).link.token
    expect(token, 'the link payload carries the share token').toBeTruthy()

    const pub = await ctx.get(`/api/guest/${token}`)
    expect(pub.status()).toBe(200)
    const body = await pub.json()
    // ⚠ Matched by SNAPSHOT id: the guest column set deliberately does not
    // publish source_coffee_product_id (its display set is fixed; the image is
    // the only column that changed).
    const product = body.products.find((p) => p.id === snap.id)
    expect(product, 'the picked product is on the guest listing').toBeTruthy()
    expect(product.image, 'the guest listing serves the catalog fallback too').toBe(catalogImage)
  })
})

test.describe('UC-PC-013 — the per-cycle importers are retired (API)', () => {
  test.beforeAll(refreshAdminToken)

  test('the three retired routes answer 404 to an authenticated admin', async () => {
    const stem = uniq()
    const cycle = await createCycle({ name: `${stem} 404 cyklus`, type: 'coffee' })
    expect(cycle.status()).toBe(201)
    const cycleId = (await cycle.json()).id

    const csv = await ctx.post(`/api/products/import/${cycleId}`, {
      headers: admin(),
      multipart: { file: { name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Price250g\nX,9\n', 'utf8') } },
    })
    expect(csv.status(), 'POST /api/products/import/:cycleId is GONE (no tombstone handler)').toBe(404)

    for (const path of ['import-gsheet', 'import-gsheet-multirow']) {
      const res = await ctx.post(`/api/products/${path}/${cycleId}`, {
        headers: admin(),
        data: { url: 'https://docs.google.com/spreadsheets/d/x/edit' },
      })
      expect(res.status(), `POST /api/products/${path}/:cycleId is GONE`).toBe(404)
    }
  })

  test('acceptance walkthrough: import sheet into catalog → create cycle by ticking → friend orders from the snapshot → old endpoint 404', async () => {
    const stem = uniq()
    // 1. Import "the sheet" into the CATALOG (CSV is the e2e vehicle).
    const imp = await importCsv(csvFor([
      { name: `${stem} Chodba A`, purpose: 'Filter', p250: '9,5' },
      { name: `${stem} Chodba B`, purpose: 'Espresso', p250: '8,0', p1kg: '26,0' },
    ]))
    expect(imp.status()).toBe(201)
    const { report } = await imp.json()
    const ids = report.new.filter((e) => e.name.startsWith(stem)).map((e) => e.catalog_id)
    expect(ids.length).toBe(2)

    // 2. Create the cycle by ticking both.
    const cycle = await createCycle({ name: `${stem} walkthrough cyklus`, type: 'coffee', coffee_product_ids: ids })
    expect(cycle.status()).toBe(201)
    const cycleId = (await cycle.json()).id
    const products = await cycleProducts(cycleId)
    expect(products.length).toBe(2)

    // 3. A friend orders FROM THE SNAPSHOT.
    const friend = await makeFriendSession('walk')
    const snap = products.find((p) => p.price_250g !== null)
    const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
      headers: friend.auth,
      data: { items: [{ product_id: snap.id, variant: '250g', quantity: 2 }] },
    })
    expect(put.status(), 'the friend cart saves against the picker-created snapshot').toBe(200)
    const sub = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
      headers: friend.auth, data: {},
    })
    expect(sub.status(), 'the order submits').toBe(200)
    const order = await (await ctx.get(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth })).json()
    expect(order.order, 'the order exists').toBeTruthy()
    expect(order.order.total).toBeGreaterThan(0)

    // 4. The retired endpoint answers 404 for this very cycle.
    const old = await ctx.post(`/api/products/import/${cycleId}`, {
      headers: admin(),
      multipart: { file: { name: 'p.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Price250g\nX,9\n', 'utf8') } },
    })
    expect(old.status()).toBe(404)
  })
})

// ── PC-T8 UI half — the picker in the new-cycle dialog; no import section ──────

test.describe('UC-PC-012/013 — admin UI (picker + retired import section)', () => {
  test('the new-cycle dialog pre-ticks ALL available catalog products, never lists a retired one, and unticking keeps a product out', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const nameA = `${stem} Tick A`
    const nameB = `${stem} Tick B`
    const nameR = `${stem} Tick Vyradena`
    const idA = await uiImportOne(token, nameA)
    const idB = await uiImportOne(token, nameB)
    const idR = await uiImportOne(token, nameR)
    const retire = await ctx.patch(`/api/coffee-products/${idR}`, { headers: uiHeaders(token), data: { status: 'retired' } })
    expect(retire.status()).toBe(200)

    await page.goto('/admin/dashboard')
    await page.getByRole('button', { name: '+ Nový cyklus' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const cycleName = `${stem} UI cyklus`
    await dialog.locator('#cycleName').fill(cycleName)

    // Coffee is the default type; the picker renders over the catalog.
    const picker = dialog.getByTestId('coffee-picker')
    await expect(picker).toBeVisible()
    await picker.getByTestId('coffee-picker-search').fill(stem)
    const rows = picker.getByTestId('coffee-picker-row')
    await expect(rows, 'retired products are not listed at all').toHaveCount(2)
    await expect(rows.filter({ hasText: nameR })).toHaveCount(0)
    // Default: all available products PRE-TICKED (tick-and-go).
    await expect(rows.filter({ hasText: nameA }).locator('input[type="checkbox"]')).toBeChecked()
    await expect(rows.filter({ hasText: nameB }).locator('input[type="checkbox"]')).toBeChecked()

    // Untick B and create.
    await rows.filter({ hasText: nameB }).locator('input[type="checkbox"]').uncheck()
    await dialog.getByRole('button', { name: 'Vytvoriť' }).click()
    await expect(dialog).not.toBeVisible()

    const cycles = await (await ctx.get('/api/cycles', { headers: uiHeaders(token) })).json()
    const created = cycles.find((c) => c.name === cycleName)
    expect(created, 'the cycle was created').toBeTruthy()
    const products = await cycleProducts(created.id)
    const sources = products.map((p) => p.source_coffee_product_id)
    expect(sources).toContain(idA)
    expect(sources, 'the unticked product stays out').not.toContain(idB)
    expect(sources).not.toContain(idR)
  })

  test('CycleDetail renders its products tab with NO import section (UC-PC-013)', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const cycle = await ctx.post('/api/cycles', {
      headers: uiHeaders(token),
      data: { name: `${stem} detail cyklus`, type: 'coffee' },
    })
    expect(cycle.status()).toBe(201)
    const cycleId = (await cycle.json()).id

    await page.goto(`/admin/cycle/${cycleId}`)
    // The products tab still works (its other functions stay)…
    await expect(page.getByRole('button', { name: '+ Pridať produkt' })).toBeVisible()
    // …but the whole import section is GONE.
    await expect(page.getByText('Import produktov')).toHaveCount(0)
    await expect(page.getByText('Z Google Sheets')).toHaveCount(0)
    await expect(page.getByText('Z CSV súboru')).toHaveCount(0)
  })

  test('the friend order page lists the picked product WITH the catalog image (the acceptance\'s friend half, in the UI)', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const name = `${stem} Vitrina`
    const id = await uiImportOne(token, name)
    const up = await ctx.post(`/api/coffee-products/${id}/image`, {
      headers: uiHeaders(token),
      multipart: { image: { name: 'v.png', mimeType: 'image/png', buffer: PNG_1PX } },
    })
    expect(up.status()).toBe(200)
    const catalogImage = (await up.json()).image

    const cycleName = `${stem} vitrina cyklus`
    const cycle = await ctx.post('/api/cycles', {
      headers: uiHeaders(token),
      data: { name: cycleName, type: 'coffee', coffee_product_ids: [id] },
    })
    expect(cycle.status()).toBe(201)
    const cycleId = (await cycle.json()).id

    // Friend session via localStorage (the order-product-card.spec.js pattern —
    // a cold deep-link to /cycle/:id bounces, so enter via the portal card).
    // ⚠ makeFriendSession uses the ADMIN token — re-mint it under the UI login.
    adminToken = token
    const friend = await makeFriendSession('vitrina')
    const stored = JSON.stringify({
      friendId: friend.id,
      friendName: friend.name,
      token: friend.token,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    })
    await page.addInitScript((value) => {
      localStorage.clear()
      localStorage.setItem('gorifi_friend_auth', value)
    }, stored)

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await page.getByRole('heading', { name: cycleName, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/cycle/${cycleId}$`))

    const card = page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(card).toHaveCount(1)
    const img = card.locator('img')
    await expect(img).toBeVisible()
    await expect(img, 'the friend order page serves the catalog image via the COALESCE').toHaveAttribute('src', catalogImage)
  })
})
