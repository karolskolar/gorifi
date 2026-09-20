// PC-T9 — 12 §UC-PC-006 (REWRITTEN, resolved decision 14): the MANUAL
// assignment workbench replaces the shipped PC-T4 auto-migration (its fuzzy
// suggestions merged unrelated products on staging). Three admin routes:
//   GET  /api/coffee-products/migration/pending  — one row per distinct
//        (normalized_name, roastery) over the unlinked coffee snapshots
//   POST /api/coffee-products/migration/assign   — groups → existing catalog_id
//   POST /api/coffee-products/migration/create   — ONE catalog row from the
//        newest snapshot across the selection, then link everything selected
// The shipped POST /migrate is RETIRED (404). NO similarity/fuzzy math exists
// anywhere in this flow. The migration half of this file was rewritten under
// case (a) of the e2e-immutability rule — the retired tests and the properties
// that transfer are enumerated in 12 §UC-PC-011 item 3.
//
// ⚠ This file is the module's ADMIN-surface spec. PC-T9 owns the workbench
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
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding, gotoCycle as portalGotoCycle } from '../helpers/portal.js'
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

// ── PC-T9 workbench helpers (12 §UC-PC-006) ───────────────────────────────────

function getPending() {
  return ctx.get('/api/coffee-products/migration/pending', { headers: admin() })
}

function assign(groups, catalogId, extra = {}) {
  return ctx.post('/api/coffee-products/migration/assign', {
    headers: admin(),
    data: { groups, catalog_id: catalogId, ...extra },
  })
}

function createFrom(groups) {
  return ctx.post('/api/coffee-products/migration/create', {
    headers: admin(),
    data: { groups },
  })
}

// Find OUR pending rows (the shared DB carries residue groups from other
// tests/runs — never assert global counts).
async function pendingRowsFor(stem) {
  const res = await getPending()
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(typeof body.pending_count).toBe('number')
  expect(body.pending_count).toBe(body.pending.length)
  return { body, rows: body.pending.filter((r) => r.display_name.includes(stem) || r.normalized_name.includes(stem.toLowerCase())) }
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

// ── 1. route guards + the retired /migrate ────────────────────────────────────

test.describe('UC-PC-006 — route guards + the retired endpoint', () => {
  test('anonymous calls on all three workbench routes are 401', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      expect((await anon.get('/api/coffee-products/migration/pending')).status()).toBe(401)
      expect((await anon.post('/api/coffee-products/migration/assign', { data: { groups: [], catalog_id: 1 } })).status()).toBe(401)
      expect((await anon.post('/api/coffee-products/migration/create', { data: { groups: [] } })).status()).toBe(401)
    } finally {
      await anon.dispose()
    }
  })

  test('POST /api/coffee-products/migrate is RETIRED — 404 even to an authenticated admin (resolved decision 14)', async () => {
    const res = await ctx.post('/api/coffee-products/migrate', { headers: admin() })
    expect(res.status(), 'the auto-migration is gone, no tombstone handler').toBe(404)
  })
})

// ── 2. GET /migration/pending — identity grouping, zero fuzzy ─────────────────

test.describe('UC-PC-006 — pending grouping', () => {
  test('the acceptance fixture: identical identities group into ONE row from the newest snapshot, near-names stay SEPARATE, bakery rows never appear — and NO similarity/candidate field exists anywhere', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Pink Bourbon`
    const honey = `${stem} Honey`
    const db = openDb()
    let cNewest
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, null) // NULL type COALESCEs to coffee
      cNewest = seedCycle(db, `${stem} c3`, 'coffee')
      const bk = seedCycle(db, `${stem} bakery`, 'bakery')
      seedSnapshot(db, c1, { name: stem.toUpperCase(), description1: 'stary profil', price_250g: 8 })
      // Case/whitespace/punctuation variant — SAME identity via the one
      // normalization helper (identity, not a suggestion — decision 14).
      seedSnapshot(db, c2, { name: `  ${stem}!  `, description1: 'stredny profil', price_250g: 8.5 })
      seedSnapshot(db, c2, { name: stem, price_250g: 8.7 })
      // The group's NEWEST snapshot (highest cycle_id) supplies display
      // metadata for the pending row.
      seedSnapshot(db, cNewest, {
        name: stem, description1: 'najnovsi profil', roast_type: 'Light roast', purpose: 'Filter', price_250g: 9.9,
      })
      // A near-name is its OWN pending row — never folded, never suggested.
      seedSnapshot(db, c1, { name: honey, price_250g: 9 })
      // Bakery-cycle and bakery-sourced rows are outside the candidate set.
      seedSnapshot(db, bk, { name: stem, price_250g: 5 })
      seedSnapshot(db, cNewest, { name: stem, price_250g: 5, source_bakery_product_id: 999999 })
    } finally {
      db.close()
    }

    const res = await getPending()
    expect(res.status()).toBe(200)
    const raw = await res.text()
    // Decision 14: no similarity math, no candidate suggestions — ANYWHERE in
    // the payload.
    expect(raw).not.toMatch(/similarity|candidate|fuzzy/i)
    const body = JSON.parse(raw)
    expect(Object.keys(body).sort()).toEqual(['pending', 'pending_count'])
    expect(body.pending_count).toBe(body.pending.length)

    const rows = body.pending.filter((r) => r.normalized_name.startsWith(stem.toLowerCase()))
    expect(rows, 'exactly TWO pending rows: the identity group and the near-name').toHaveLength(2)

    const main = rows.find((r) => r.normalized_name === stem.toLowerCase())
    const near = rows.find((r) => r.normalized_name === honey.toLowerCase())
    expect(main).toBeTruthy()
    expect(near).toBeTruthy()

    // The pending row shape is the UC-PC-006 contract, key-for-key.
    expect(Object.keys(main).sort()).toEqual(
      ['cycles', 'display_name', 'newest_cycle', 'normalized_name', 'purpose', 'roast_type', 'roastery', 'snapshots'])
    expect(main.display_name, 'display_name = the newest snapshot’s original casing').toBe(stem)
    expect(main.roastery).toBe('Goriffee')
    expect(main.snapshots, 'all four unlinked rows incl. the variants').toBe(4)
    expect(main.cycles, 'COUNT(DISTINCT cycle_id)').toBe(3)
    expect(main.purpose, 'from the newest snapshot').toBe('Filter')
    expect(main.roast_type).toBe('Light roast')
    expect(Object.keys(main.newest_cycle).sort()).toEqual(['created_at', 'id', 'name'])
    expect(main.newest_cycle.id).toBe(cNewest)
    expect(main.newest_cycle.name).toBe(`${stem} c3`)

    // Ordered by display_name over the normalized key: base before the
    // longer near-name.
    expect(body.pending.indexOf(main)).toBeLessThan(body.pending.indexOf(near))

    // Bakery rows contributed nothing (4 + 1 accounted for above; a bakery
    // leak would have made snapshots 5 or a third row — both asserted already).
  })

  test('pending is READ-ONLY: the GET creates no catalog row and writes nothing (byte-compare)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Iba Citanie`
    const db = openDb()
    let before
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      seedSnapshot(db, c, { name, price_250g: 8 })
      before = {
        products: tableSnapshot(db, 'products'),
        catalog: tableSnapshot(db, 'coffee_products'),
      }
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(name)
    expect(rows, 'the group is listed').toHaveLength(1)

    const db2 = openDb()
    try {
      expect(tableSnapshot(db2, 'products'), 'no products write — a catalog row exists only after an explicit create').toBe(before.products)
      expect(tableSnapshot(db2, 'coffee_products'), 'no catalog row created by a read').toBe(before.catalog)
    } finally {
      db2.close()
    }
  })

  test('same name under a different roastery is a DIFFERENT pending row (roastery is half the key)', async () => {
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

    const { rows } = await pendingRowsFor(name)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.roastery).sort()).toEqual(['Goriffee', other].sort())
    for (const r of rows) expect(r.snapshots).toBe(1)
  })
})

// ── 3. POST /migration/assign — groups → an existing catalog product ──────────

test.describe('UC-PC-006 — assign to an existing catalog product', () => {
  test('links every unlinked snapshot of the selection; the ONLY write is the link column (catalog row, snapshots, order_items, orders byte-identical)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const targetName = `${stem} Cielovy Produkt`
    const oldName = `${stem} Stary Nazov`
    const catalogId = await importOne(targetName, { purpose: 'Filter' })

    const db = openDb()
    let s1, s2, before
    try {
      const c1 = seedCycle(db, `${oldName} c1`, 'coffee')
      const c2 = seedCycle(db, `${oldName} c2`, 'coffee')
      s1 = seedSnapshot(db, c1, { name: oldName, description1: 'historicky popis', price_250g: 7 })
      s2 = seedSnapshot(db, c2, { name: oldName.toUpperCase(), price_250g: 7.5 })
      // Non-vacuity for the order_items pin: a real submitted order on the
      // fixture snapshot.
      const friend = db.prepare('SELECT id FROM friends ORDER BY id LIMIT 1').get()
      expect(friend, 'seeded target must carry at least one friend (run e2e/seed.mjs)').toBeTruthy()
      const ord = db
        .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, 'submitted', 14)")
        .run(friend.id, c1)
      db.prepare(
        "INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, '250g', 2, 7)"
      ).run(Number(ord.lastInsertRowid), s1)
      before = {
        products: tableSnapshot(db, 'products', ['source_coffee_product_id']),
        orderItems: tableSnapshot(db, 'order_items'),
        orders: tableSnapshot(db, 'orders'),
        catalog: tableSnapshot(db, 'coffee_products'),
      }
    } finally {
      db.close()
    }

    const { body: pendingBefore, rows } = await pendingRowsFor(oldName)
    expect(rows).toHaveLength(1)
    const group = { normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }

    const res = await assign([group], catalogId)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['groups_linked', 'linked_snapshots', 'pending_count', 'skipped'])
    expect(body.linked_snapshots).toBe(2)
    expect(body.groups_linked).toBe(1)
    expect(body.skipped).toEqual([])
    // pending_count recomputed AFTER the write — the UI drops the row from it.
    expect(body.pending_count).toBe(pendingBefore.pending_count - 1)

    const db2 = openDb()
    try {
      expect(productRow(db2, s1).source_coffee_product_id).toBe(catalogId)
      expect(productRow(db2, s2).source_coffee_product_id).toBe(catalogId)
      // The PC-T4 data-safety invariant verbatim: the link column and NOTHING
      // else — snapshot names/descriptions/prices, order_items, orders and the
      // catalog row itself (assign never refreshes metadata) are byte-identical.
      expect(tableSnapshot(db2, 'products', ['source_coffee_product_id'])).toBe(before.products)
      expect(tableSnapshot(db2, 'order_items')).toBe(before.orderItems)
      expect(tableSnapshot(db2, 'orders')).toBe(before.orders)
      expect(tableSnapshot(db2, 'coffee_products'), 'assign touches NO catalog column').toBe(before.catalog)
    } finally {
      db2.close()
    }

    // The group left the pending list.
    const { rows: after } = await pendingRowsFor(oldName)
    expect(after).toHaveLength(0)
  })

  test('re-firing the same assign converges: 200 with the group under skipped, never a 404 (GSO-T5 convergence)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const catalogId = await importOne(`${stem} Konvergentny`)
    const oldName = `${stem} Zanikla Skupina`

    const db = openDb()
    try {
      const c = seedCycle(db, `${oldName} cycle`, 'coffee')
      seedSnapshot(db, c, { name: oldName, price_250g: 8 })
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(oldName)
    const group = { normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }

    expect((await assign([group], catalogId)).status()).toBe(200)

    // Second fire: the group key is derived, not stored — "already resolved"
    // and "never existed" are indistinguishable, and the requested end state
    // already holds. Skip-and-report, never 404.
    const second = await assign([group], catalogId)
    expect(second.status()).toBe(200)
    const body = await second.json()
    expect(body.linked_snapshots).toBe(0)
    expect(body.groups_linked).toBe(0)
    expect(body.skipped).toEqual([
      { normalized_name: group.normalized_name, roastery: group.roastery, reason: 'no_unlinked_rows' },
    ])

    // A group that NEVER existed behaves identically (same indistinguishability).
    const ghost = await assign([{ normalized_name: `${stem} nikdy neexistoval`, roastery: 'Goriffee' }], catalogId)
    expect(ghost.status()).toBe(200)
    expect((await ghost.json()).skipped[0].reason).toBe('no_unlinked_rows')
  })

  test('cross-roastery assign is 409 field:roastery with NOTHING written', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const catalogId = await importOne(`${stem} Domaci`) // roastery = default Goriffee
    const other = `Praziaren ${uniq()}`
    const oldName = `${stem} Cudzi`

    const db = openDb()
    let snapId
    try {
      const c = seedCycle(db, `${oldName} cycle`, 'coffee')
      snapId = seedSnapshot(db, c, { name: oldName, price_250g: 8, roastery: other })
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(oldName)
    expect(rows).toHaveLength(1)
    const res = await assign([{ normalized_name: rows[0].normalized_name, roastery: other }], catalogId)
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.field).toBe('roastery')

    const db2 = openDb()
    try {
      expect(productRow(db2, snapId).source_coffee_product_id, 'cross-roastery identity is never crossed').toBeNull()
    } finally {
      db2.close()
    }
  })

  test('unknown catalog_id 404; malformed groups/catalog_id 400 (bindValue hygiene on every field)', async () => {
    const group = { normalized_name: 'x', roastery: 'Goriffee' }

    expect((await assign([group], 99999999)).status(), 'unknown catalog_id').toBe(404)
    expect((await assign([group], 'abc')).status(), 'non-integer catalog_id matches no row').toBe(404)

    const catalogId = await importOne(`${uniq()} Validacny Terc`)
    for (const [label, groups] of [
      ['missing groups', undefined],
      ['non-array groups', { normalized_name: 'x', roastery: 'y' }],
      ['empty groups', []],
      ['entry missing roastery', [{ normalized_name: 'x' }]],
      ['non-string normalized_name', [{ normalized_name: 123, roastery: 'Goriffee' }]],
      ['non-string roastery', [{ normalized_name: 'x', roastery: ['G'] }]],
      ['null entry', [null]],
    ]) {
      const res = await assign(groups, catalogId)
      expect(res.status(), `${label} must 400`).toBe(400)
      expect((await res.json()).field, label).toBe('groups')
    }

    for (const [label, data] of [
      ['missing catalog_id', { groups: [group] }],
      ['object catalog_id', { groups: [group], catalog_id: {} }],
      ['boolean catalog_id', { groups: [group], catalog_id: true }],
    ]) {
      const res = await ctx.post('/api/coffee-products/migration/assign', { headers: admin(), data })
      expect(res.status(), `${label} must 400`).toBe(400)
      expect((await res.json()).field, label).toBe('catalog_id')
    }
  })
})

// ── 4. POST /migration/create — ONE row from the newest snapshot ──────────────

test.describe('UC-PC-006 — create a catalog product from a selection', () => {
  test('the acceptance fixture: ONE catalog row from the NEWEST snapshot (decision-13 fields + image), all snapshots linked, pending_count drops', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Pink Bourbon`
    const image = 'data:image/png;base64,PCT9IMG'
    const db = openDb()
    let ids, before
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      const c3 = seedCycle(db, `${stem} c3`, 'coffee')
      ids = {
        s1: seedSnapshot(db, c1, { name: stem.toUpperCase(), description1: 'stary profil', price_250g: 8 }),
        s2: seedSnapshot(db, c2, { name: `  ${stem}!  `, description1: 'stredny profil', price_250g: 8.5 }),
        s3: seedSnapshot(db, c2, { name: stem, price_250g: 8.7 }),
        // NEWEST across the selection — the catalog row is built from THIS one,
        // incl. its image (per-cycle images consolidate into the catalog image).
        s4: seedSnapshot(db, c3, {
          name: stem,
          description1: 'najnovsi profil',
          description2: 'kvety, med',
          roast_type: 'Light roast',
          purpose: 'Filter',
          price_250g: 9.9,
          price_1kg: 39,
          image,
        }),
      }
      before = {
        products: tableSnapshot(db, 'products', ['source_coffee_product_id']),
        orderItems: tableSnapshot(db, 'order_items'),
      }
    } finally {
      db.close()
    }

    const { body: pendingBefore, rows } = await pendingRowsFor(stem)
    expect(rows).toHaveLength(1)
    const group = { normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }

    const res = await createFrom([group])
    expect(res.status()).toBe(201)
    const raw = await res.text()
    expect(raw, 'decision 14 — no fuzzy anywhere in the workbench').not.toMatch(/similarity|candidate|fuzzy/i)
    const body = JSON.parse(raw)
    expect(Object.keys(body).sort()).toEqual(['catalog', 'linked_snapshots', 'pending_count', 'skipped'])
    expect(body.linked_snapshots).toBe(4)
    expect(body.skipped).toEqual([])
    expect(body.pending_count).toBe(pendingBefore.pending_count - 1)

    const cat = body.catalog
    expect(cat.name, 'original casing of the newest snapshot').toBe(stem)
    expect(cat.normalized_name).toBe(stem.toLowerCase())
    expect(cat.roastery).toBe('Goriffee')
    expect(cat.description1).toBe('najnovsi profil')
    expect(cat.description2).toBe('kvety, med')
    expect(cat.roast_type).toBe('Light roast')
    expect(cat.purpose).toBe('Filter')
    expect(cat.price_250g).toBe(9.9)
    expect(cat.price_1kg).toBe(39)
    expect(cat.image).toBe(image)
    expect(cat.status).toBe('available')
    // Informational attributes are born empty (decision 13).
    for (const col of ['country', 'region', 'altitude', 'farm', 'variety', 'processing', 'curator_pick_note']) {
      expect(cat[col], `${col} must be NULL`).toBeNull()
    }
    expect(cat.is_new).toBe(0)

    const db2 = openDb()
    try {
      // One row in the DB, matching the payload.
      const dbRows = catalogByNormalized(db2, stem.toLowerCase())
      expect(dbRows).toHaveLength(1)
      expect(dbRows[0].id).toBe(cat.id)
      // ALL selected snapshots linked; nothing but the link column moved.
      for (const sid of [ids.s1, ids.s2, ids.s3, ids.s4]) {
        expect(productRow(db2, sid).source_coffee_product_id, `snapshot ${sid} linked`).toBe(cat.id)
      }
      expect(tableSnapshot(db2, 'products', ['source_coffee_product_id'])).toBe(before.products)
      expect(tableSnapshot(db2, 'order_items')).toBe(before.orderItems)
    } finally {
      db2.close()
    }
  })

  test('same-second collision: two snapshots in ONE cycle — the higher id supplies the metadata (id DESC tiebreak)', async () => {
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

    const { rows } = await pendingRowsFor(name)
    const res = await createFrom([{ normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }])
    expect(res.status()).toBe(201)
    const cat = (await res.json()).catalog
    expect(cat.description1, 'the id DESC twin supplies the metadata').toBe('newer twin')
    expect(cat.price_250g).toBe(7.5)

    const db2 = openDb()
    try {
      expect(productRow(db2, older).source_coffee_product_id).toBe(cat.id)
      expect(productRow(db2, newer).source_coffee_product_id).toBe(cat.id)
    } finally {
      db2.close()
    }
  })

  test('a MULTI-GROUP selection makes ONE row from the newest snapshot across ALL of it and links every group; two roasteries in one selection 409', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = uniq()
    const nameA = `${stem} Alfa`
    const nameB = `${stem} Alfa Novsi`
    const db = openDb()
    let sA, sB
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      sA = seedSnapshot(db, c1, { name: nameA, description1: 'stara identita', price_250g: 7 })
      sB = seedSnapshot(db, c2, { name: nameB, description1: 'nova identita', price_250g: 9 })
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(stem)
    expect(rows).toHaveLength(2)
    const groups = rows.map((r) => ({ normalized_name: r.normalized_name, roastery: r.roastery }))

    // Cross-roastery selection refuses first (one catalog row has one roastery).
    const bad = await createFrom([groups[0], { ...groups[1], roastery: `Ina ${uniq()}` }])
    expect(bad.status()).toBe(409)
    expect((await bad.json()).field).toBe('roastery')

    const res = await createFrom(groups)
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.linked_snapshots).toBe(2)
    const cat = body.catalog
    expect(cat.name, 'newest across the WHOLE selection names the row').toBe(nameB)
    expect(cat.description1).toBe('nova identita')

    const db2 = openDb()
    try {
      expect(productRow(db2, sA).source_coffee_product_id, 'the OTHER group links to the same new row').toBe(cat.id)
      expect(productRow(db2, sB).source_coffee_product_id).toBe(cat.id)
      // Only ONE catalog row came out of the selection.
      expect(catalogByNormalized(db2, nameB.toLowerCase())).toHaveLength(1)
      expect(catalogByNormalized(db2, nameA.toLowerCase())).toHaveLength(0)
    } finally {
      db2.close()
    }
  })

  test('a key collision with an EXISTING catalog row is 409 field:name carrying the existing catalog_id — the assign hand-off — and writes NOTHING', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Existujuci Nazov`
    const existingId = await importOne(name)

    const db = openDb()
    let snapId, before
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      snapId = seedSnapshot(db, c, { name: name.toUpperCase(), price_250g: 9 })
      before = tableSnapshot(db, 'coffee_products')
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(name)
    const res = await createFrom([{ normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }])
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.field).toBe('name')
    expect(body.catalog_id, 'the 409 names the existing row so the UI can offer assign instead').toBe(existingId)

    const db2 = openDb()
    try {
      expect(tableSnapshot(db2, 'coffee_products'), 'no duplicate row, no refresh').toBe(before)
      expect(productRow(db2, snapId).source_coffee_product_id, 'the refused create links nothing').toBeNull()
    } finally {
      db2.close()
    }
  })

  test('empty/malformed selection 400; a double-fired create finds ZERO unlinked snapshots and 400s (no duplicate catalog row)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    for (const [label, groups] of [
      ['missing groups', undefined],
      ['empty groups', []],
      ['non-array groups', 'x'],
      ['entry missing normalized_name', [{ roastery: 'Goriffee' }]],
      ['non-string roastery', [{ normalized_name: 'x', roastery: 5.5 }]],
    ]) {
      const res = await ctx.post('/api/coffee-products/migration/create', {
        headers: admin(),
        data: groups === undefined ? {} : { groups },
      })
      expect(res.status(), `${label} must 400`).toBe(400)
      expect((await res.json()).field, label).toBe('groups')
    }

    const name = `${uniq()} Dvojity Vystrel`
    const db = openDb()
    try {
      const c = seedCycle(db, `${name} cycle`, 'coffee')
      seedSnapshot(db, c, { name, price_250g: 8 })
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(name)
    const group = { normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }

    expect((await createFrom([group])).status()).toBe(201)

    // The double-fire guard: the groups are already linked, the selection
    // resolves to zero unlinked snapshots — 400, never a second catalog row.
    const second = await createFrom([group])
    expect(second.status()).toBe(400)

    const db2 = openDb()
    try {
      expect(catalogByNormalized(db2, name.toLowerCase()), 'no duplicate catalog row from the double fire').toHaveLength(1)
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

  // ⚠ RETARGET, case (a) — PM decision 2026-08-23 SUPERSEDES resolved decision 9's
  // "no DELETE route ever": a real DELETE now exists (the admin asked for it for
  // mistakenly imported rows). The property this test still owns is the one that
  // matters — the merge remains the only deleter that PRESERVES the links, and a
  // delete must never strand them. The dangling-pointer and unlink assertions live
  // in the "Catalog delete (PM 2026-08-23)" describe at the end of this file.
  test('DELETE exists (PM 2026-08-23) and leaves no dangling link behind', async () => {
    const id = await importOne(`${uniq()} Zmazatelny`)
    const res = await ctx.delete(`/api/coffee-products/${id}`, { headers: admin() })
    expect(res.status(), 'DELETE /api/coffee-products/:id is a real route now').toBe(200)
    const body = await res.json()
    expect(body.deleted.id).toBe(id)
    // Gone for good: a second delete cannot find it.
    const again = await ctx.delete(`/api/coffee-products/${id}`, { headers: admin() })
    expect(again.status()).toBe(404)
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

  test('after a merge, pending still lists an unlinked group and assign links it to the SURVIVOR (the re-runnability seam, re-pointed at the workbench per UC-PC-011 item 3)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Zeleny Vrch`
    const variant = `${stem} Honey`

    // Two catalog rows (as the workbench or an import would create them)…
    const res = await importCsv(csvFor([
      { name: stem, p250: '8,0' },
      { name: variant, p250: '9,0' },
    ]))
    expect(res.status()).toBe(201)
    const r = (await res.json()).report
    const A = r.new.find((e) => e.name === stem).catalog_id
    const B = r.new.find((e) => e.name === variant).catalog_id

    // …the admin merges B into A…
    expect((await merge(A, B)).status()).toBe(200)

    // …and a LATER unlinked snapshot bearing B's retired identity surfaces in
    // the workbench, where the admin assigns it to the SURVIVOR — B is never
    // resurrected (the workbench replaces the /migrate re-run seam).
    const db = openDb()
    let lateSnap
    try {
      const c = seedCycle(db, `${stem} c3`, 'coffee')
      lateSnap = seedSnapshot(db, c, { name: variant.toUpperCase(), price_250g: 8.5 })
    } finally {
      db.close()
    }

    const { rows } = await pendingRowsFor(variant)
    expect(rows, 'the unlinked group is listed after the merge').toHaveLength(1)

    const linkRes = await assign(
      [{ normalized_name: rows[0].normalized_name, roastery: rows[0].roastery }], A)
    expect(linkRes.status()).toBe(200)
    expect((await linkRes.json()).linked_snapshots).toBe(1)

    const db2 = openDb()
    try {
      expect(productRow(db2, lateSnap).source_coffee_product_id, 'the late snapshot links to the survivor').toBe(A)
      expect(catalogByNormalized(db2, variant.toLowerCase()), 'B\u2019s identity is not resurrected').toHaveLength(0)
    } finally {
      db2.close()
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

  // ⚠ RETARGET, case (a) — the no-DELETE half is superseded by the PM's 2026-08-23
  // decision (a real DELETE exists; see the "Catalog delete" describe). The
  // roastery-immutability half is untouched and is what this test now owns.
  test('roastery is NOT PATCH-editable (half of the identity key)', async () => {
    const name = `${uniq()} Stara Hora`
    const id = await importOne(name)

    const res = await patchCatalog(id, { roastery: 'Ina Praziaren' })
    expect(res.status()).toBe(200)
    expect((await res.json()).roastery, 'roastery must survive a PATCH attempt').toBe('Goriffee')
    // The row survives a PATCH that tried to move it to another roastery.
    expect((await getCatalogRow(id)).status()).toBe(200)
  })

  // UC-PC-014 retarget (case a): the upload is stored as a content-hash FILE
  // and the column holds the URL path — the protected property (magic-byte
  // sniffing decides the type, junk bytes 400, the list serves the value) is
  // unchanged; only the stored representation moved.
  test('POST /:id/image stores a content-hash file URL; the list serves it; unknown id 404; junk bytes 400', async () => {
    const name = `${uniq()} Fotogenicka`
    const id = await importOne(name)

    const res = await uploadImage(id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.image, 'magic-byte sniffed extension, not the client label').toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/)

    const listRow = (await (await getCatalog(`?q=${encodeURIComponent(name)}`)).json()).find((r) => r.id === id)
    expect(listRow.image).toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/)

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
    // UC-PC-014 retarget (case a): stored as a file, column holds the URL.
    expect(detail.image).toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/)
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
    // ⚠ Retarget, case (a) — PC-T12 split "Nespracované riadky" (which mixed
    // skips with warnings, and the PM read it as "not imported") into red
    // skipped + amber warnings. The nameless row is a real skip.
    await expect(report).toContainText('1 preskočených')
    await expect(report).toContainText('0 upozornení')
    await expect(report).toContainText(cleanName)

    // The fuzzy entry: "Je to premenovaný X?" naming the CANDIDATE (the
    // pre-existing row), with a link into the merge flow.
    const fuzzy = report.getByTestId('fuzzy-entry')
    await expect(fuzzy).toHaveCount(1)
    await expect(fuzzy).toContainText(`Je to premenovaný ${base}?`)

    // The unparsed entry renders its reason string prominently (row numbers
    // count parsed records, and the UI says so) — under the red SKIPPED
    // heading whose copy says these rows were NOT imported (PC-T12).
    await expect(report.getByTestId('unparsed-entry')).toHaveCount(1)
    await expect(report).toContainText('Preskočené riadky (1)')
    await expect(report).toContainText('neboli importované')

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

  // (The PC-T7 "migration trigger renders the report" UI test retired with the
  // trigger itself — resolved decision 14; the workbench UI describe below is
  // its replacement, per UC-PC-011 item 3.)

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

// ── PC-T9 — the migration workbench UI (12 §UC-PC-006/009, resolved decision 14)

test.describe('UC-PC-006 — migration workbench (UI)', () => {
  test('the workbench table renders pending rows with checkboxes; assign via the searchable picker drops the row WITHOUT a reload', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const targetName = `${stem} Cielovka`
    const targetId = await uiImportOne(token, targetName)
    const oldA = `${stem} Historicka Alfa`
    const oldB = `${stem} Ina Kava`
    const db = openDb()
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      seedSnapshot(db, c1, { name: oldA, price_250g: 8 })
      seedSnapshot(db, c2, { name: oldA.toUpperCase(), price_250g: 8.5 })
      seedSnapshot(db, c1, { name: oldB, price_250g: 9 })
    } finally {
      db.close()
    }

    await page.goto('/admin/catalog')

    // ⚠ Leave a products-tab filter ON that excludes the assign target: the
    // picker must source its own UNFILTERED candidate set, never the filtered
    // `products` list (review finding, PC-T9) — otherwise a stray filter
    // silently hides valid targets.
    await page.getByTestId('catalog-search').fill('zzz-nikde-nic-nenajde')
    await expect(page.getByTestId('catalog-row')).toHaveCount(0)

    await page.getByTestId('catalog-tab-migrate').click()
    await expect(page.getByTestId('workbench-table')).toBeVisible()
    await expect(page.getByTestId('workbench-count')).toBeVisible()

    const rowA = page.getByTestId('workbench-row').filter({ hasText: oldA })
    const rowB = page.getByTestId('workbench-row').filter({ hasText: oldB })
    await expect(rowA).toHaveCount(1)
    await expect(rowB).toHaveCount(1)
    // Identity grouping on screen: the two cased variants are ONE row with
    // snapshots=2, cycles=2.
    await expect(rowA.getByTestId('workbench-snapshots')).toHaveText('2')
    await expect(rowA.getByTestId('workbench-cycles')).toHaveText('2')
    // No similarity hints, no suggested candidates anywhere in the workbench.
    await expect(page.getByTestId('workbench-table')).not.toContainText(/zhoda|%/i)

    // From here on the UI must update from the RESPONSE payload — never a
    // pending re-fetch, never a reload (the PM's step 3).
    const pendingGets = []
    page.on('request', (req) => {
      if (req.url().includes('/migration/pending')) pendingGets.push(req.url())
    })

    await rowA.getByTestId('workbench-check').check()
    await page.getByTestId('workbench-assign-button').click()
    const dialog = page.getByTestId('assign-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('assign-search').fill(targetName)
    const option = dialog.getByTestId('assign-option')
    await expect(option).toHaveCount(1)
    await option.click()
    await expect(dialog).not.toBeVisible()

    await expect(rowA, 'the resolved row disappears').toHaveCount(0)
    await expect(rowB, 'the untouched row stays').toHaveCount(1)
    expect(pendingGets, 'rows drop from the response payload, not a re-fetch').toEqual([])

    // The links really landed: the target now has two offering cycles.
    const detail = await (await ctx.get(`/api/coffee-products/${targetId}`, { headers: uiHeaders(token) })).json()
    expect(detail.history.length).toBe(2)
  })

  test('create-from-selection drops the row and the new product appears in the catalog list', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    await loginAsAdminUI(page)
    const stem = uniq()
    const oldName = `${stem} Novy Z Vyberu`
    const db = openDb()
    try {
      const c = seedCycle(db, `${stem} c1`, 'coffee')
      seedSnapshot(db, c, { name: oldName, purpose: 'Filter', price_250g: 8 })
    } finally {
      db.close()
    }

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    const row = page.getByTestId('workbench-row').filter({ hasText: oldName })
    await expect(row).toHaveCount(1)
    await row.getByTestId('workbench-check').check()
    await page.getByTestId('workbench-create-button').click()
    await expect(row, 'the resolved row disappears').toHaveCount(0)

    // "New products appearing": the catalog list carries the created row.
    await page.getByTestId('catalog-tab-products').click()
    await page.getByTestId('catalog-search').fill(oldName)
    const catRow = page.getByTestId('catalog-row').filter({ hasText: oldName })
    await expect(catRow).toHaveCount(1)
    await expect(catRow.getByText('Dostupná')).toBeVisible()
  })

  test('a create collision renders the 409 in-context and hands off to assign', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const name = `${stem} Kolizna Kava`
    await uiImportOne(token, name) // the EXISTING catalog identity
    const db = openDb()
    let snapId
    try {
      const c = seedCycle(db, `${stem} c1`, 'coffee')
      snapId = seedSnapshot(db, c, { name: name.toUpperCase(), price_250g: 8 })
    } finally {
      db.close()
    }

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    const row = page.getByTestId('workbench-row').filter({ hasText: name.toUpperCase() })
    await expect(row).toHaveCount(1)
    await row.getByTestId('workbench-check').check()
    await page.getByTestId('workbench-create-button').click()

    // The 409 renders IN-CONTEXT, offering assign instead (the admin just
    // learned why assign is the right verb).
    const err = page.getByTestId('workbench-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText('existuje')
    await err.getByTestId('workbench-assign-handoff').click()
    const dialog = page.getByTestId('assign-dialog')
    await expect(dialog).toBeVisible()
    // The hand-off SPENDS the 409's catalog_id (review finding, PC-T9): the
    // picker opens with the colliding product prefilled in the search and
    // visible as the first candidate — never blank.
    await expect(dialog.getByTestId('assign-search')).toHaveValue(name)
    const option = dialog.getByTestId('assign-option')
    await expect(option.first()).toContainText(name)
    await option.first().click()
    await expect(dialog).not.toBeVisible()
    await expect(row, 'the hand-off resolves the row').toHaveCount(0)

    // Linked to the EXISTING row — no duplicate was ever created.
    const db2 = openDb()
    try {
      expect(catalogByNormalized(db2, name.toLowerCase())).toHaveLength(1)
      expect(productRow(db2, snapId).source_coffee_product_id).toBe(catalogByNormalized(db2, name.toLowerCase())[0].id)
    } finally {
      db2.close()
    }
  })

  test('empty state: "História je zmigrovaná." once the pending list is drained', async ({ page }) => {
    const token = await loginAsAdminUI(page)

    // Drain EVERYTHING over the API (residue from earlier tests included):
    // create per group; a name collision hands off to assign — exactly the
    // workbench contract. A 400 marks a group raced away mid-loop.
    for (let guard = 0; guard < 300; guard++) {
      const res = await ctx.get('/api/coffee-products/migration/pending', { headers: uiHeaders(token) })
      expect(res.status()).toBe(200)
      const { pending } = await res.json()
      if (pending.length === 0) break
      const g = pending[0]
      const groups = [{ normalized_name: g.normalized_name, roastery: g.roastery }]
      const created = await ctx.post('/api/coffee-products/migration/create', {
        headers: uiHeaders(token), data: { groups },
      })
      if (created.status() === 201) continue
      if (created.status() === 409) {
        const body = await created.json()
        const assigned = await ctx.post('/api/coffee-products/migration/assign', {
          headers: uiHeaders(token), data: { groups, catalog_id: body.catalog_id },
        })
        expect(assigned.status()).toBe(200)
        continue
      }
      expect(created.status(), 'a drain step must create, collide, or find the group already resolved').toBe(400)
    }
    const final = await ctx.get('/api/coffee-products/migration/pending', { headers: uiHeaders(token) })
    expect((await final.json()).pending_count, 'the drain finished').toBe(0)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    await expect(page.getByTestId('workbench-empty')).toHaveText('História je zmigrovaná.')
    await expect(page.getByTestId('workbench-table')).toHaveCount(0)
  })
})

test.describe('UC-PC-005 follow-up — CycleDetail saveProduct surfaces the duplicate_in_cycle 409 in-dialog', () => {
  // ⚠ RETARGET, case (a) — PM 2026-08-23 removed the manual product dialog from
  // COFFEE cycle detail (coffee products are managed globally in Katalóg; the cycle
  // only ticks which of them it offers). Driving the 409 through that UI is
  // therefore structurally unsatisfiable. What survives and is pinned here: the
  // 409 itself still comes from the API, and the coffee cycle detail really offers
  // no manual product management. The in-dialog `modalError` surface itself is NOT
  // dead — the dialog still serves bakery cycles, which is why PC-T7's fix stays.
  test('the duplicate_in_cycle 409 still comes from the API, and coffee cycle detail offers no manual product UI', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const cycleRes = await ctx.post('/api/cycles', {
      headers: uiHeaders(token),
      data: { name: `${stem} cyklus`, type: 'coffee' },
    })
    expect(cycleRes.status()).toBe(201)
    const cycleId = (await cycleRes.json()).id
    const productName = `${stem} Duplikat`

    const first = await ctx.post('/api/products', {
      headers: uiHeaders(token),
      data: { cycle_id: cycleId, name: productName, price_250g: 9 },
    })
    expect(first.status()).toBe(201)
    const dup = await ctx.post('/api/products', {
      headers: uiHeaders(token),
      data: { cycle_id: cycleId, name: productName, price_250g: 9 },
    })
    expect(dup.status(), 'the PC-T3 guard is untouched').toBe(409)
    expect((await dup.json()).reason).toBe('duplicate_in_cycle')

    await page.goto(`/admin/cycle/${cycleId}`)
    await expect(page.getByRole('button', { name: '+ Pridať produkt' }), 'manual add is gone for coffee').toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Upraviť' }), 'no per-row edit on coffee').toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Vymazať' }), 'no per-row delete on coffee').toHaveCount(0)
    await expect(page.getByTestId('cycle-catalog-picker-open'), 'the catalog picker replaces them').toBeVisible()
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

  test('two ticked products snapshot into the cycle: linked, all seven prices FROZEN from the catalog, stock_limit_g NULL', async () => {
    const stem = uniq()
    const idA = await importOne(`${stem} Vyber A`, { purpose: 'Filter', desc1: 'Washed profil' })
    const idB = await importOne(`${stem} Vyber B`, { purpose: 'Espresso' })
    // Give A the full price vocabulary so the freeze covers every column
    // (price_8pc12g joined in PC-T12 — retarget case (a): the enumeration grew).
    const patched = await patchCatalog(idA, {
      price_150g: 5.5, price_200g: 6.5, price_250g: 8.8, price_500g: 15, price_1kg: 27.5, price_20pc5g: 7.4, price_8pc12g: 6.2,
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
    for (const f of ['price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_8pc12g']) {
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
    // UC-PC-014 retarget (case a): stored as a file, column holds the URL —
    // the COALESCE assertions below are value-agnostic and unchanged.
    expect(catalogImage).toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/)

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
    // The products tab still works (its other functions stay) — ⚠ RETARGET, case (a):
    // PM 2026-08-23 replaced the manual "+ Pridať produkt" with the catalog picker.
    await expect(page.getByTestId('cycle-catalog-picker-open')).toBeVisible()
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

    // ⚠ PI-T3 · 18 §UC-PI-019 item 3 — the cycle CARDS are retired (§UC-PI-005);
    // `helpers/portal.js gotoCycle()` is the one home of portal → order navigation.
    await portalGotoCycle(page, cycleId)

    const card = page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(card).toHaveCount(1)
    const img = card.locator('img')
    await expect(img).toBeVisible()
    await expect(img, 'the friend order page serves the catalog image via the COALESCE').toHaveAttribute('src', catalogImage)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PM 2026-08-23 — DELETE a catalog product. SUPERSEDES resolved decision 9's
// "no DELETE route ever" (retirement via status='retired' stays as the
// non-destructive option). ⚠ The invariant under test is the dangling-pointer
// rule (GSO-T9): a deleted catalog row must never leave `products` rows pointing
// at a nonexistent id — the links are cleared in the SAME transaction, and the
// snapshots keep every byte of their own data.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Catalog delete (PM 2026-08-23)', () => {
  test('deleting an unused product removes exactly that row', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const name = `${uniq()} Del Unused`
    const id = seedCatalog(db, { name })
    const before = db.prepare('SELECT COUNT(*) AS c FROM coffee_products').get().c

    const res = await request.delete(`/api/coffee-products/${id}`, { headers: admin() })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.deleted.id).toBe(id)
    expect(body.deleted.name).toBe(name)
    expect(body.unlinked_snapshots).toBe(0)

    expect(db.prepare('SELECT COUNT(*) AS c FROM coffee_products WHERE id = ?').get(id).c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS c FROM coffee_products').get().c).toBe(before - 1)
    db.close()
  })

  test('⚠ deleting a product WITH history unlinks its snapshots — never a dangling pointer, and no snapshot data moves', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const cycleId = seedCycle(db, `${uniq()} Del Cycle`, 'coffee')
    const catalogId = seedCatalog(db, { name: `${uniq()} Del WithHistory` })
    const s1 = seedSnapshot(db, cycleId, { name: 'Snap One', price_250g: 9.5, source_coffee_product_id: catalogId })
    const s2 = seedSnapshot(db, cycleId, { name: 'Snap Two', price_1kg: 33, source_coffee_product_id: catalogId })
    const rawBefore = db.prepare('SELECT * FROM products WHERE id IN (?, ?) ORDER BY id').all(s1, s2)

    const res = await request.delete(`/api/coffee-products/${catalogId}`, { headers: admin() })
    expect(res.status()).toBe(200)
    expect((await res.json()).unlinked_snapshots).toBe(2)

    // No dangling pointer anywhere in the table — the whole point.
    const dangling = db.prepare(
      `SELECT COUNT(*) AS c FROM products p
        WHERE p.source_coffee_product_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM coffee_products cp WHERE cp.id = p.source_coffee_product_id)`
    ).get().c
    expect(dangling, 'no products row may point at a deleted catalog id').toBe(0)

    // Snapshots survive byte-identical apart from the link column.
    const rawAfter = db.prepare('SELECT * FROM products WHERE id IN (?, ?) ORDER BY id').all(s1, s2)
    expect(rawAfter.length).toBe(2)
    rawAfter.forEach((row, i) => {
      expect(row.source_coffee_product_id).toBe(null)
      const { source_coffee_product_id: _a, ...afterRest } = row
      const { source_coffee_product_id: _b, ...beforeRest } = rawBefore[i]
      expect(afterRest).toEqual(beforeRest)
    })
    db.close()
  })

  test('the unlinked snapshots come back in the migration workbench', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const cycleId = seedCycle(db, `${uniq()} Del Reappear Cycle`, 'coffee')
    const productName = `${uniq()} Del Reappear`
    const catalogId = seedCatalog(db, { name: productName })
    seedSnapshot(db, cycleId, { name: productName, source_coffee_product_id: catalogId })

    const pendingBefore = await (await request.get('/api/coffee-products/migration/pending', { headers: admin() })).json()
    expect(pendingBefore.pending.some(g => g.display_name === productName)).toBe(false)

    await request.delete(`/api/coffee-products/${catalogId}`, { headers: admin() })

    const pendingAfter = await (await request.get('/api/coffee-products/migration/pending', { headers: admin() })).json()
    expect(
      pendingAfter.pending.some(g => g.display_name === productName),
      'a deleted catalog product returns its history to the workbench'
    ).toBe(true)
    db.close()
  })

  test('unknown and non-integer ids 404 without touching anything', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const before = db.prepare('SELECT COUNT(*) AS c FROM coffee_products').get().c
    for (const bad of ['99999999', 'abc', '1.5']) {
      const res = await request.delete(`/api/coffee-products/${bad}`, { headers: admin() })
      expect(res.status(), `DELETE /${bad}`).toBe(404)
    }
    expect(db.prepare('SELECT COUNT(*) AS c FROM coffee_products').get().c).toBe(before)
    db.close()
  })

  test('UI: Odstrániť asks for confirmation, then removes the row from the list', async ({ page, request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const name = `${uniq()} Del UI`
    const id = seedCatalog(db, { name })
    db.close()

    await loginAsAdminUI(page)
    await page.goto('/admin/catalog')
    await page.getByPlaceholder('Názov produktu...').fill(name)
    await expect(page.getByRole('cell', { name })).toBeVisible()

    // The dialog gates the delete: dismissing it changes nothing.
    await page.getByTestId(`catalog-delete-${id}`).click()
    const dialog = page.getByTestId('catalog-delete-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(name)
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('cell', { name })).toBeVisible()

    // Confirming removes it from the table without a reload.
    await page.getByTestId(`catalog-delete-${id}`).click()
    await page.getByTestId('catalog-delete-confirm').click()
    await expect(page.getByTestId('catalog-delete-dialog')).toBeHidden()
    await expect(page.getByRole('cell', { name })).toHaveCount(0)

    // And it is really gone from the API, not just the DOM.
    const after = await request.get('/api/coffee-products', { headers: uiHeaders(await page.evaluate(() => localStorage.getItem('adminToken'))) })
    const list = await after.json()
    expect((list.products || list).some?.(p => p.name === name) ?? false).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PM 2026-08-23 — the catalog picker must stay usable for the whole life of an
// editable cycle (add a forgotten product, drop a wrong one), the cycle detail no
// longer manages coffee products itself, and the price columns double as a
// friend-price control.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Cycle ↔ catalog reconciliation (PM 2026-08-23)', () => {
  // ⚠ ONE admin token app-wide: the UI tests above logged in through the browser
  // and invalidated the beforeAll token, so the API half re-mints it (the
  // refreshAdminToken idiom used by the other describes in this file).
  test.beforeAll(refreshAdminToken)

  test('adds, reactivates and soft-removes — order history never moves', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const keepId = seedCatalog(db, { name: `${stem} Keep`, price_250g: 7.6 })
    const addId = seedCatalog(db, { name: `${stem} Add`, price_250g: 9.9 })
    const dropId = seedCatalog(db, { name: `${stem} Drop`, price_250g: 5.5 })
    const cycleId = seedCycle(db, `${stem} Live`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(cycleId)
    db.close()

    // Start with Keep + Drop.
    let res = await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: admin(), data: { coffee_product_ids: [keepId, dropId] },
    })
    expect(res.status()).toBe(200)
    expect((await res.json()).added.length).toBe(2)

    // Swap Drop for Add — the whole point of the row: a live cycle stays editable.
    res = await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: admin(), data: { coffee_product_ids: [keepId, addId] },
    })
    const body = await res.json()
    expect(body.added.map(a => a.name)).toEqual([`${stem} Add`])
    expect(body.removed.map(r => r.name)).toEqual([`${stem} Drop`])
    expect(body.active_count).toBe(2)

    const db2 = openDb()
    // Removal is SOFT: the row survives with active = 0 (order_items keep pointing at it).
    const dropped = db2.prepare(
      'SELECT active FROM products WHERE cycle_id = ? AND source_coffee_product_id = ?'
    ).get(cycleId, dropId)
    expect(dropped.active).toBe(0)

    // Re-ticking REACTIVATES the same row — never a duplicate.
    db2.close()
    res = await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: admin(), data: { coffee_product_ids: [keepId, addId, dropId] },
    })
    const back = await res.json()
    expect(back.reactivated.map(r => r.name)).toEqual([`${stem} Drop`])
    expect(back.added).toEqual([])
    const db3 = openDb()
    expect(db3.prepare(
      'SELECT COUNT(*) AS c FROM products WHERE cycle_id = ? AND source_coffee_product_id = ?'
    ).get(cycleId, dropId).c, 'exactly one snapshot per catalog product per cycle').toBe(1)
    db3.close()
  })

  test('⚠ snapshots with no catalog link are NEVER touched by an untick', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const catId = seedCatalog(db, { name: `${stem} Linked` })
    const cycleId = seedCycle(db, `${stem} Mixed`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(cycleId)
    const manual = seedSnapshot(db, cycleId, { name: `${stem} Manual`, price_250g: 4.2 })
    db.close()

    await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: admin(), data: { coffee_product_ids: [catId] },
    })
    // An empty selection would remove every CATALOG row — the manual one must survive both.
    await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: admin(), data: { coffee_product_ids: [] },
    })

    const db2 = openDb()
    const row = db2.prepare('SELECT active, name, price_250g FROM products WHERE id = ?').get(manual)
    expect(row.active, 'an unlinked snapshot is outside the reconciliation').toBe(1)
    expect(row.price_250g).toBe(4.2)
    db2.close()
  })

  test('a locked cycle refuses (409) and a bakery cycle refuses (409); bad body 400', async ({ request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const locked = seedCycle(db, `${stem} Locked`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'locked' WHERE id = ?").run(locked)
    const bakery = seedCycle(db, `${stem} Bakery`, 'bakery')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(bakery)
    const open = seedCycle(db, `${stem} Open`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(open)
    db.close()

    let res = await request.put(`/api/cycles/${locked}/catalog-products`, { headers: admin(), data: { coffee_product_ids: [] } })
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('closed')

    res = await request.put(`/api/cycles/${bakery}/catalog-products`, { headers: admin(), data: { coffee_product_ids: [] } })
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('not_coffee')

    for (const bad of [{}, { coffee_product_ids: 'x' }, { coffee_product_ids: 5 }]) {
      res = await request.put(`/api/cycles/${open}/catalog-products`, { headers: admin(), data: bad })
      expect(res.status(), JSON.stringify(bad)).toBe(400)
    }
    res = await request.put('/api/cycles/99999999/catalog-products', { headers: admin(), data: { coffee_product_ids: [] } })
    expect(res.status()).toBe(404)
  })

  test('UI: the picker reopens on a live cycle, adds a product, and the friend-price column follows the markup', async ({ page, request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const inCycle = seedCatalog(db, { name: `${stem} VCykle`, price_250g: 8.9, purpose: 'Espresso' })
    seedCatalog(db, { name: `${stem} Zabudnuty`, price_250g: 6.0, purpose: 'Filter' })
    const cycleId = seedCycle(db, `${stem} Zivy`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open', markup_ratio = 1.0 WHERE id = ?").run(cycleId)
    db.close()
    await request.put(`/api/cycles/${cycleId}/catalog-products`, { headers: admin(), data: { coffee_product_ids: [inCycle] } })

    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycleId}`)

    // The manual add button is gone for coffee; the catalog picker is there instead.
    await expect(page.getByRole('button', { name: '+ Pridať produkt' })).toHaveCount(0)
    await expect(page.getByTestId('cycle-catalog-picker-open')).toBeVisible()
    // No per-row edit/duplicate/delete on a coffee cycle.
    await expect(page.getByRole('button', { name: 'Upraviť' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Vymazať' })).toHaveCount(0)

    // Markup 0 % ⇒ friend price equals the base, and the legend says so.
    await expect(page.getByTestId('markup-neutral-hint')).toBeVisible()
    await expect(page.getByTestId('friend-price').first()).toHaveText('8.90')

    // Add the forgotten product through the picker.
    await page.getByTestId('cycle-catalog-picker-open').click()
    const dialog = page.getByTestId('cycle-catalog-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('cycle-catalog-search').fill(`${stem} Zabudnuty`)
    await dialog.getByTestId('cycle-catalog-row').first().locator('input[type="checkbox"]').check()
    await page.getByTestId('cycle-catalog-save').click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('cell', { name: `${stem} Zabudnuty` })).toBeVisible()

    // Set a 19 % markup: the control column must follow after Uložiť.
    await page.getByTestId('markup-input').fill('19')
    await page.getByTestId('markup-save').click()
    await expect(page.getByTestId('markup-neutral-hint')).toHaveCount(0)
    await expect(page.getByTestId('friend-price').first()).toHaveText('10.59')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PC-T12 — price editing on the catalog: the seventh variant (price_8pc12g,
// Brew Bags, 8 × 12 g = 96 g), number validation on the PATCH (400 on junk —
// bindValue used to store the literal text 'abc' into a REAL column), and the
// dialog's honesty about decision 13: manual price edits live only until the
// next import.
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('PC-T12 — catalog price editing (API)', () => {
  // ⚠ ONE admin token app-wide — UI describes above invalidated the beforeAll token.
  test.beforeAll(refreshAdminToken)

  test('price_8pc12g is PATCHable and persists; the list carries the column', async () => {
    const name = `${uniq()} Brew Vrecka`
    const id = await importOne(name)
    const res = await patchCatalog(id, { price_8pc12g: 6.2 })
    expect(res.status()).toBe(200)
    expect((await res.json()).price_8pc12g).toBe(6.2)
    const detail = await (await getCatalogRow(id)).json()
    expect(detail.price_8pc12g, 'persisted, not just echoed').toBe(6.2)
  })

  test('a junk price is a 400 naming the field — never stored as text, never silently skipped', async () => {
    const name = `${uniq()} Odolna`
    const id = await importOne(name) // price_250g = 8 from the import fixture
    for (const junk of ['abc', '12abc', true, { a: 1 }, [1, 2]]) {
      const res = await patchCatalog(id, { price_250g: junk })
      expect(res.status(), `price_250g=${JSON.stringify(junk)}`).toBe(400)
      const body = await res.json()
      expect(body.field).toBe('price_250g')
      // Nothing written — the stored price survives the refusal.
      expect((await (await getCatalogRow(id)).json()).price_250g).toBe(8)
    }
  })

  test('null clears, a numeric string (comma or dot) is accepted, a number is a number', async () => {
    const name = `${uniq()} Ciselna`
    const id = await importOne(name)
    expect((await patchCatalog(id, { price_1kg: 36 })).status()).toBe(200)
    expect((await patchCatalog(id, { price_150g: '5,5' })).status()).toBe(200)
    expect((await patchCatalog(id, { price_200g: '6.5' })).status()).toBe(200)
    expect((await patchCatalog(id, { price_250g: null })).status()).toBe(200)
    const row = await (await getCatalogRow(id)).json()
    expect(row.price_1kg).toBe(36)
    expect(row.price_150g, 'decimal comma parsed like an imported price').toBe(5.5)
    expect(row.price_200g).toBe(6.5)
    expect(row.price_250g, 'explicit null clears').toBeNull()
  })
})

test.describe('PC-T12 — catalog price editing (UI)', () => {
  test('the edit dialog has all SEVEN price fields; 8ks×12g persists; the help text says imports overwrite manual prices', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const stem = uniq()
    const name = `${stem} Sedma Cena`
    await uiImportOne(token, name)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(stem)
    await expect(page.getByTestId('catalog-row')).toHaveCount(1)
    await page.getByTestId('catalog-row').getByRole('button', { name: 'Upraviť' }).click()
    const dialog = page.getByTestId('catalog-edit-dialog')
    await expect(dialog).toBeVisible()

    // The new variant's input, plus the decision-13 honesty line.
    const input = dialog.getByTestId('catalog-edit-price-8pc12g')
    await expect(input).toBeVisible()
    await expect(dialog).toContainText('import')
    await expect(dialog.getByText(/najbližš\w* import\w*/i).first()).toBeVisible()

    await input.fill('6.20')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(dialog).not.toBeVisible()

    // Persisted — reopen shows the value.
    await page.getByTestId('catalog-row').getByRole('button', { name: 'Upraviť' }).click()
    await expect(dialog.getByTestId('catalog-edit-price-8pc12g')).toHaveValue('6.2')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PC-T13 — the four PM gaps (2026-08-23): manual catalog product creation,
// split-rule declarations + their duplicates suppression, workbench
// "Ignorovať", and "Odpojiť od katalógu" (unlink). API describes first (each
// with refreshAdminToken — the UI describes above invalidated the beforeAll
// token), the UI describe last.
// ═══════════════════════════════════════════════════════════════════════════════

function createCatalogProduct(data) {
  return ctx.post('/api/coffee-products', { headers: admin(), data })
}

test.describe('PC-T13 — manual catalog product creation (API)', () => {
  test.beforeAll(refreshAdminToken)

  test('POST / creates a full catalog row: defaults, normalized identity, list shape', async () => {
    const name = `${uniq()} Rucne Pridana`
    const res = await createCatalogProduct({
      name,
      purpose: 'Filter',
      roast_type: 'Light roast',
      country: 'Etiopia',
      region: 'Yirgacheffe',
      altitude: '2100 m',
      farm: 'Idido',
      variety: 'Heirloom',
      processing: 'Washed',
      description1: 'kvetinova',
      description2: 'bergamot, citrus',
      is_new: true,
      curator_pick_note: 'aktualne nedostupny filter',
      price_150g: 6,
      price_200g: 7,
      price_250g: '8,5',
      price_500g: 15,
      price_1kg: 32,
      price_20pc5g: 9,
      price_8pc12g: 6.2,
    })
    expect(res.status()).toBe(201)
    const row = await res.json()
    expect(row.name).toBe(name)
    expect(row.normalized_name, 'the ONE normalization helper').toBe(name.toLowerCase())
    expect(row.roastery, 'roastery defaults to the is_default row').toBe('Goriffee')
    expect(row.status, 'status defaults to available').toBe('available')
    expect(row.is_new).toBe(1)
    expect(row.curator_pick_note).toBe('aktualne nedostupny filter')
    expect(row.price_250g, 'decimal comma parsed like the PATCH').toBe(8.5)
    expect(row.price_8pc12g).toBe(6.2)
    expect(row.country).toBe('Etiopia')
    expect(row.processing).toBe('Washed')
    // Born with no history — the list-shape computed columns say so.
    expect(row.cycles_count).toBe(0)
    expect(row.all_time_kg).toBe(0)

    // Persisted and listed.
    const list = await (await ctx.get(`/api/coffee-products?q=${encodeURIComponent(name)}`, { headers: admin() })).json()
    const listed = list.find((r) => r.id === row.id)
    expect(listed).toBeTruthy()
    expect(listed.cycles_count).toBe(0)
  })

  test('explicit roastery and status are honoured; junk refuses like the PATCH', async () => {
    const name = `${uniq()} Vyradena Od Zaciatku`
    const res = await createCatalogProduct({ name, status: 'retired' })
    expect(res.status()).toBe(201)
    expect((await res.json()).status).toBe('retired')

    const bad = await createCatalogProduct({ name: `${uniq()} Zly Stav`, status: 'deleted' })
    expect(bad.status()).toBe(400)
    expect((await bad.json()).field).toBe('status')

    const junkPrice = await createCatalogProduct({ name: `${uniq()} Zla Cena`, price_250g: 'abc' })
    expect(junkPrice.status(), 'the SAME price validation as the PATCH').toBe(400)
    expect((await junkPrice.json()).field).toBe('price_250g')
  })

  test('name is required — missing, empty and all-punctuation all 400 field:name', async () => {
    for (const body of [{}, { name: '' }, { name: '–––' }, { name: 123 }]) {
      const res = await createCatalogProduct(body)
      expect(res.status(), JSON.stringify(body)).toBe(400)
      expect((await res.json()).field).toBe('name')
    }
  })

  test('a name collision answers the SAME dual-layer 409 field:name as the PATCH, writing nothing', async () => {
    const name = `${uniq()} Kolizna Kava`
    expect((await createCatalogProduct({ name })).status()).toBe(201)

    // Case/diacritics variant of the same identity → 409 via the ONE normalizer.
    const clash = await createCatalogProduct({ name: `  ${name.toUpperCase()}!  ` })
    expect(clash.status()).toBe(409)
    const body = await clash.json()
    expect(body.field).toBe('name')

    // Exactly one row holds the identity.
    const list = await (await ctx.get(`/api/coffee-products?q=${encodeURIComponent(name)}`, { headers: admin() })).json()
    expect(list.filter((r) => r.normalized_name === name.toLowerCase())).toHaveLength(1)
  })
})

test.describe('PC-T13 — split declarations + duplicates suppression (API)', () => {
  test.beforeAll(refreshAdminToken)

  async function createdId(data) {
    const res = await createCatalogProduct(data)
    expect(res.status(), `create ${data.name}`).toBe(201)
    return (await res.json()).id
  }

  function declareSplit(id, sheetName) {
    return ctx.post(`/api/coffee-products/${id}/splits`, { headers: admin(), data: { sheet_name: sheetName } })
  }

  function getSplits(id) {
    return ctx.get(`/api/coffee-products/${id}/splits`, { headers: admin() })
  }

  test('declare, list with siblings, refuse duplicates, remove', async () => {
    const sheetName = `${uniq()} Peru Rieka`
    const idA = await createdId({ name: `${sheetName} Svetla`, roast_type: 'Light' })
    const idB = await createdId({ name: `${sheetName} Tmava`, roast_type: 'Dark' })

    const res = await declareSplit(idA, sheetName)
    expect(res.status()).toBe(201)
    let body = await res.json()
    expect(body.splits).toHaveLength(1)
    expect(body.splits[0].sheet_name).toBe(sheetName)
    expect(body.splits[0].normalized_name).toBe(sheetName.toLowerCase())
    expect(body.splits[0].siblings, 'no sibling yet').toEqual([])

    expect((await declareSplit(idB, sheetName)).status()).toBe(201)

    // A's listing now names B as the sibling of the shared sheet row.
    body = await (await getSplits(idA)).json()
    expect(body.splits).toHaveLength(1)
    expect(body.splits[0].siblings.map((s) => s.id)).toEqual([idB])

    // Declaring the same mapping twice refuses.
    const dup = await declareSplit(idA, `  ${sheetName.toUpperCase()} `)
    expect(dup.status(), 'same identity via the ONE normalizer').toBe(409)

    // Empty/junk sheet names refuse; unknown product 404s.
    expect((await declareSplit(idA, '–––')).status()).toBe(400)
    expect((await ctx.post('/api/coffee-products/99999999/splits', { headers: admin(), data: { sheet_name: 'X' } })).status()).toBe(404)

    // Remove A's declaration — B keeps its own.
    const splitId = body.splits[0].id
    const del = await ctx.delete(`/api/coffee-products/${idA}/splits/${splitId}`, { headers: admin() })
    expect(del.status()).toBe(200)
    expect((await del.json()).splits).toEqual([])
    const bSplits = await (await getSplits(idB)).json()
    expect(bSplits.splits).toHaveLength(1)
    expect(bSplits.splits[0].siblings).toEqual([])
  })

  test('split_of at CREATION: two products born with the same sheet row — import twice → 0 new, 0 pending_fuzzy, prices refreshed, roasts preserved', async () => {
    const sheetName = `${uniq()} Rovno Pri Vytvoreni`
    // The PM flow: both variants created in one go, each declaring the split
    // in the create call itself — no save + re-open via Upraviť.
    const idM = await createdId({
      name: `${sheetName} Medium`, roast_type: 'Medium', price_250g: 6, split_of: sheetName,
    })
    const idF = await createdId({
      // Whitespace around the value trims; identity via the ONE normalizer.
      name: `${sheetName} Full City`, roast_type: 'Full city', price_250g: 6, split_of: `  ${sheetName}  `,
    })

    // Born declared: each lists the mapping with the other as the sibling.
    const born = await (await getSplits(idM)).json()
    expect(born.splits).toHaveLength(1)
    expect(born.splits[0].normalized_name).toBe(sheetName.toLowerCase())
    expect(born.splits[0].siblings.map((s) => s.id)).toEqual([idF])

    // The same acceptance as the edit-mode path, reached purely through create.
    for (const run of [1, 2]) {
      const res = await importCsv(csvFor([{
        name: sheetName, roast: 'Medium + Full city', p250: '9', p1kg: '33',
      }]))
      expect(res.status()).toBe(201)
      const report = (await res.json()).report
      expect(report.summary.new, `run ${run}: never creates`).toBe(0)
      expect(report.summary.pending_fuzzy, `run ${run}: never flags`).toBe(0)
      expect(report.matched.map((e) => e.catalog_id).sort()).toEqual([idM, idF].sort())
    }
    const m = await (await ctx.get(`/api/coffee-products/${idM}`, { headers: admin() })).json()
    const f = await (await ctx.get(`/api/coffee-products/${idF}`, { headers: admin() })).json()
    expect(m.price_250g).toBe(9)
    expect(f.price_250g).toBe(9)
    expect(m.roast_type, 'roast stays admin-owned').toBe('Medium')
    expect(f.roast_type).toBe('Full city')
  })

  test('an empty/whitespace split_of means "no split" — 201 and no mapping row', async () => {
    for (const v of ['', '   ', '–––']) {
      const res = await createCatalogProduct({ name: `${uniq()} Bez Splitu`, split_of: v })
      expect(res.status(), `split_of=${JSON.stringify(v)}`).toBe(201)
      const id = (await res.json()).id
      expect((await (await getSplits(id)).json()).splits, 'no mapping was written').toEqual([])
    }
  })

  test('merging a split target away TRANSFERS its mappings to the survivor (deduped) — the sheet row still refreshes, creates nothing', async () => {
    const sheetA = `${uniq()} Zluceny Riadok`
    const sheetB = `${uniq()} Druhy Riadok`
    const idKeep = await createdId({ name: `${sheetA} Svetla`, roast_type: 'Light', price_250g: 5 })
    const idGone = await createdId({ name: `${sheetA} Tmava`, roast_type: 'Dark', price_250g: 5 })

    // Both are targets of sheetA; the source ALSO carries sheetB alone.
    expect((await declareSplit(idKeep, sheetA)).status()).toBe(201)
    expect((await declareSplit(idGone, sheetA)).status()).toBe(201)
    expect((await declareSplit(idGone, sheetB)).status()).toBe(201)

    // Merge the source away — before the fix, the FK CASCADE silently dropped
    // its mappings with it (sheetB would re-create as `new` on the next import).
    const merged = await merge(idKeep, idGone)
    expect(merged.status()).toBe(200)

    // The survivor carries BOTH mappings, deduped: sheetA once (it already had
    // it — the source's duplicate row must not violate the UNIQUE), sheetB
    // transferred.
    const body = await (await getSplits(idKeep)).json()
    expect(body.splits.map((s) => s.normalized_name).sort()).toEqual(
      [sheetA.toLowerCase(), sheetB.toLowerCase()].sort()
    )

    // The next import of BOTH sheet rows still refreshes the survivor and
    // creates nothing (separate imports — two different rows now share one
    // target, and within one sheet the second would read as an in-sheet dup).
    for (const [sheetName, p250] of [[sheetA, '9'], [sheetB, '8']]) {
      const res = await importCsv(csvFor([{ name: sheetName, roast: 'Whatever + Combined', p250, p1kg: '30' }]))
      expect(res.status()).toBe(201)
      const report = (await res.json()).report
      expect(report.summary.new, `${sheetName} must not re-create`).toBe(0)
      expect(report.summary.pending_fuzzy).toBe(0)
      expect(report.matched).toEqual([{ catalog_id: idKeep, name: `${sheetA} Svetla`, split: true }])
    }
    // Roast protection survives the transfer.
    const row = await (await ctx.get(`/api/coffee-products/${idKeep}`, { headers: admin() })).json()
    expect(row.roast_type).toBe('Light')
    expect(row.price_250g, 'the LAST import owns the shared target price').toBe(8)
  })

  test('split targets leave the duplicates review — against their siblings AND against the sheet name, and nothing else', async () => {
    const stem = uniq()
    const sheetName = `${stem} Brazil Caramelo`
    const idM = await createdId({ name: `${sheetName} Medium`, roast_type: 'Medium' })
    const idF = await createdId({ name: `${sheetName} Full City`, roast_type: 'Full city' })
    // A row named exactly like the sheet row, NOT itself a target.
    const idSheet = await createdId({ name: sheetName })
    // A near-name that is neither a target nor the sheet name — the control.
    const idOther = await createdId({ name: `${sheetName} Special` })

    const pairIds = (pairs) => pairs.map((p) => [p.a.id, p.b.id].sort().join('-'))
    const key = (x, y) => [x, y].sort().join('-')

    // Before any declaration the sibling pair is a fuzzy near-miss.
    let pairs = (await (await duplicates()).json()).pairs
    let idsBefore = pairIds(pairs)
    expect(idsBefore, 'precondition: the siblings fuzzy-pair before declaring').toContain(key(idM, idF))
    expect(idsBefore).toContain(key(idSheet, idM))

    expect((await declareSplit(idM, sheetName)).status()).toBe(201)
    expect((await declareSplit(idF, sheetName)).status()).toBe(201)

    pairs = (await (await duplicates()).json()).pairs
    const idsAfter = pairIds(pairs)
    // Suppressed: sibling↔sibling and target↔sheet-named row.
    expect(idsAfter, 'siblings never pair').not.toContain(key(idM, idF))
    expect(idsAfter, 'a target never pairs with the sheet-named row').not.toContain(key(idSheet, idM))
    expect(idsAfter).not.toContain(key(idSheet, idF))
    // NOT suppressed: the control still pairs — suppression is minimal.
    expect(idsAfter, 'an unrelated near-name still surfaces').toContain(key(idOther, idSheet))
    expect(idsAfter).toContain(key(idOther, idM))
  })
})

test.describe('PC-T13 — workbench Ignorovať (API)', () => {
  test.beforeAll(refreshAdminToken)

  function ignore(groups) {
    return ctx.post('/api/coffee-products/migration/ignore', { headers: admin(), data: { groups } })
  }

  function unignore(groups) {
    return ctx.post('/api/coffee-products/migration/unignore', { headers: admin(), data: { groups } })
  }

  function getIgnored() {
    return ctx.get('/api/coffee-products/migration/ignored', { headers: admin() })
  }

  test('ignoring a junk group hides it from pending, lists it under ignored, and writes ONE column only', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Nespresso Kapsule`
    const db = openDb()
    let snapA, snapB
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      snapA = seedSnapshot(db, c1, { name: stem, price_250g: 5 })
      snapB = seedSnapshot(db, c2, { name: stem, price_250g: 5 })
    } finally {
      db.close()
    }

    const { rows: before } = await pendingRowsFor(stem)
    expect(before).toHaveLength(1)

    const db2 = openDb()
    const productsBefore = tableSnapshot(db2, 'products', ['migration_ignored'])
    db2.close()

    const res = await ignore([{ normalized_name: stem.toLowerCase(), roastery: 'Goriffee' }])
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ignored_snapshots).toBe(2)
    expect(body.groups_ignored).toBe(1)
    expect(typeof body.pending_count).toBe('number')

    // Gone from pending.
    const { rows: after } = await pendingRowsFor(stem)
    expect(after).toHaveLength(0)

    // Listed under ignored, same row shape as pending.
    const ignoredBody = await (await getIgnored()).json()
    expect(Object.keys(ignoredBody).sort()).toEqual(['ignored', 'ignored_count'])
    expect(ignoredBody.ignored_count).toBe(ignoredBody.ignored.length)
    const mine = ignoredBody.ignored.find((r) => r.normalized_name === stem.toLowerCase())
    expect(mine).toBeTruthy()
    expect(mine.snapshots).toBe(2)

    // ONE column, nothing else: byte-identical apart from migration_ignored.
    const db3 = openDb()
    try {
      expect(tableSnapshot(db3, 'products', ['migration_ignored'])).toBe(productsBefore)
      for (const id of [snapA, snapB]) {
        const row = productRow(db3, id)
        expect(row.migration_ignored).toBe(1)
        expect(row.active, 'active is NEVER touched by ignore').toBe(1)
        expect(row.source_coffee_product_id).toBeNull()
      }
    } finally {
      db3.close()
    }

    // Undo: back in pending, gone from ignored.
    const undo = await unignore([{ normalized_name: stem.toLowerCase(), roastery: 'Goriffee' }])
    expect(undo.status()).toBe(200)
    expect((await undo.json()).restored_snapshots).toBe(2)
    const { rows: restored } = await pendingRowsFor(stem)
    expect(restored).toHaveLength(1)
    const ignoredAfter = await (await getIgnored()).json()
    expect(ignoredAfter.ignored.some((r) => r.normalized_name === stem.toLowerCase())).toBe(false)
  })

  test('a group whose snapshots have order_items refuses with 409 and the count — real history needs a catalog identity', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Objednana Kava`
    const db = openDb()
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const snap = seedSnapshot(db, c1, { name: stem, price_250g: 8 })
      const friendId = Number(db
        .prepare('INSERT INTO friends (cycle_id, name, access_token, active) VALUES (?, ?, ?, 1)')
        .run(c1, `${stem} F`, `${uniq()}tok${Math.random().toString(36).slice(2)}`).lastInsertRowid)
      const orderId = Number(db
        .prepare("INSERT INTO orders (friend_id, cycle_id, status, total) VALUES (?, ?, 'submitted', 0)")
        .run(friendId, c1).lastInsertRowid)
      db.prepare('INSERT INTO order_items (order_id, product_id, variant, quantity, price) VALUES (?, ?, ?, 1, 10)')
        .run(orderId, snap, '250g')
    } finally {
      db.close()
    }

    const res = await ignore([{ normalized_name: stem.toLowerCase(), roastery: 'Goriffee' }])
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.order_items).toBe(1)
    expect(body.error).toContain('objedn')

    // Nothing written — the group is still pending.
    const { rows } = await pendingRowsFor(stem)
    expect(rows).toHaveLength(1)
  })

  test('a group whose ONLY orders are GUEST order_items refuses just the same — 409, the count, zero writes', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Hostovska Kava`
    const db = openDb()
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const snap = seedSnapshot(db, c1, { name: stem, price_250g: 8 })
      // A guest sub-order referencing the snapshot — NO friend order_items.
      const hostId = Number(db
        .prepare('INSERT INTO friends (cycle_id, name, access_token, active) VALUES (?, ?, ?, 1)')
        .run(c1, `${stem} Host`, `${uniq()}tok${Math.random().toString(36).slice(2)}`).lastInsertRowid)
      const linkId = Number(db
        .prepare('INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 1)')
        .run(`${uniq()}glnk${Math.random().toString(36).slice(2)}`, hostId, c1).lastInsertRowid)
      const guestOrderId = Number(db
        .prepare("INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, total) VALUES (?, ?, 'Kolega', '0900123456', 10)")
        .run(linkId, `${uniq()}gtok${Math.random().toString(36).slice(2)}`).lastInsertRowid)
      db.prepare('INSERT INTO guest_order_items (guest_order_id, product_id, variant, quantity, price) VALUES (?, ?, ?, 1, 10)')
        .run(guestOrderId, snap, '250g')
    } finally {
      db.close()
    }

    const db2 = openDb()
    const productsBefore = tableSnapshot(db2, 'products')
    db2.close()

    const res = await ignore([{ normalized_name: stem.toLowerCase(), roastery: 'Goriffee' }])
    expect(res.status(), 'guest history is real history').toBe(409)
    const body = await res.json()
    expect(body.order_items).toBe(1)

    // Zero writes — the table is byte-identical and the group is still pending.
    const db3 = openDb()
    try {
      expect(tableSnapshot(db3, 'products')).toBe(productsBefore)
    } finally {
      db3.close()
    }
    const { rows } = await pendingRowsFor(stem)
    expect(rows).toHaveLength(1)
  })

  test('malformed selections 400; an already-resolved group is skip-and-report', async () => {
    for (const bad of [undefined, [], 'x', [{}], [{ normalized_name: 'a' }]]) {
      const res = await ignore(bad)
      expect(res.status(), JSON.stringify(bad ?? null)).toBe(400)
    }
    const res = await ignore([{ normalized_name: `${uniq().toLowerCase()} nikdy neexistoval`, roastery: 'Goriffee' }])
    expect(res.status(), 'derived keys never 404 — skip-and-report').toBe(200)
    const body = await res.json()
    expect(body.ignored_snapshots).toBe(0)
    expect(body.skipped).toHaveLength(1)
  })
})

test.describe('PC-T13 — Odpojiť od katalógu (unlink, API)', () => {
  test.beforeAll(refreshAdminToken)

  function unlink(id) {
    return ctx.post(`/api/coffee-products/${id}/unlink`, { headers: admin() })
  }

  test('unlink returns the history to the workbench; the catalog row SURVIVES byte-identically', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Peach Please`
    const db = openDb()
    let catId, snapA, snapB
    try {
      catId = seedCatalog(db, {
        name: stem, description1: 'kuratorsky popis', image: '/api/images/deadbeefdeadbeefdeadbeefdeadbeef.png',
        purpose: 'Filter', price_250g: 9,
      })
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      const c2 = seedCycle(db, `${stem} c2`, 'coffee')
      snapA = seedSnapshot(db, c1, { name: stem, price_250g: 9, source_coffee_product_id: catId })
      snapB = seedSnapshot(db, c2, { name: stem, price_250g: 9.5, source_coffee_product_id: catId })
    } finally {
      db.close()
    }

    const db2 = openDb()
    const catBefore = JSON.stringify(catalogRowById(db2, catId))
    const productsBefore = tableSnapshot(db2, 'products', ['source_coffee_product_id'])
    db2.close()

    const res = await unlink(catId)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.unlinked_snapshots).toBe(2)

    const db3 = openDb()
    try {
      // The catalog row is untouched — photo and curation stay (the whole
      // difference from delete).
      expect(JSON.stringify(catalogRowById(db3, catId))).toBe(catBefore)
      // Only the link column moved on the snapshots.
      expect(tableSnapshot(db3, 'products', ['source_coffee_product_id'])).toBe(productsBefore)
      expect(productRow(db3, snapA).source_coffee_product_id).toBeNull()
      expect(productRow(db3, snapB).source_coffee_product_id).toBeNull()
    } finally {
      db3.close()
    }

    // The history is back in the workbench.
    const { rows } = await pendingRowsFor(stem)
    expect(rows).toHaveLength(1)
    expect(rows[0].snapshots).toBe(2)

    // Idempotent second call converges on 0.
    const again = await unlink(catId)
    expect(again.status()).toBe(200)
    expect((await again.json()).unlinked_snapshots).toBe(0)
  })

  test('unknown and non-integer ids 404; a product with no history unlinks 0', async () => {
    expect((await unlink(99999999)).status()).toBe(404)
    expect((await ctx.post('/api/coffee-products/abc/unlink', { headers: admin() })).status()).toBe(404)

    const name = `${uniq()} Bez Historie`
    const created = await createCatalogProduct({ name })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id
    const res = await unlink(id)
    expect(res.status()).toBe(200)
    expect((await res.json()).unlinked_snapshots).toBe(0)
    // Still there.
    expect((await ctx.get(`/api/coffee-products/${id}`, { headers: admin() })).status()).toBe(200)
  })
})

test.describe('PC-T13 — AdminCatalog view (UI)', () => {
  test('"+ Nový produkt" creates a catalog product from the dialog — split declarable AT BIRTH', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const name = `${uniq()} Nova Rucna`
    const sheetName = `${name} Riadok`

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-create-button').click()
    const dialog = page.getByTestId('catalog-edit-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Nový produkt')

    await dialog.getByTestId('catalog-edit-name').fill(name)
    await dialog.getByTestId('catalog-edit-price-8pc12g').fill('6.20')
    // The PM flow: the split is the reason the product exists — declared here,
    // not via a save + re-open through Upraviť.
    await dialog.getByTestId('create-split-of').fill(sheetName)
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(dialog).not.toBeVisible()

    await page.getByTestId('catalog-search').fill(name)
    const row = page.getByTestId('catalog-row').filter({ hasText: name })
    await expect(row).toHaveCount(1)
    await expect(row.getByText('Dostupná')).toBeVisible()

    // The mapping was written with the create (same transaction server-side).
    const list = await (await ctx.get(`/api/coffee-products?q=${encodeURIComponent(name)}`, { headers: uiHeaders(token) })).json()
    const created = list.find((r) => r.name === name)
    expect(created).toBeTruthy()
    const splits = await (await ctx.get(`/api/coffee-products/${created.id}/splits`, { headers: uiHeaders(token) })).json()
    expect(splits.splits.map((s) => s.sheet_name)).toEqual([sheetName])
  })

  test('workbench: Ignorovať hides a junk group into the Ignorované fold; Vrátiť restores it', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    await loginAsAdminUI(page)
    const stem = `${uniq()} Sekcia Hlavicka`
    const db = openDb()
    try {
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      seedSnapshot(db, c1, { name: stem, price_250g: 5 })
    } finally {
      db.close()
    }

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-tab-migrate').click()
    const row = page.getByTestId('workbench-row').filter({ hasText: stem })
    await expect(row).toHaveCount(1)
    await row.getByTestId('workbench-check').check()
    await page.getByTestId('workbench-ignore-button').click()
    await expect(row).toHaveCount(0)

    // The fold names the count and offers the undo.
    const fold = page.getByTestId('ignored-fold')
    await expect(fold).toBeVisible()
    await fold.click()
    const ignoredRow = page.getByTestId('ignored-row').filter({ hasText: stem })
    await expect(ignoredRow).toHaveCount(1)
    await ignoredRow.getByTestId('ignored-restore').click()
    await expect(ignoredRow).toHaveCount(0)
    await expect(page.getByTestId('workbench-row').filter({ hasText: stem })).toHaveCount(1)
  })

  test('Odpojiť od katalógu: inline confirm names the cycle count, the history returns to Migrácia', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const token = await loginAsAdminUI(page)
    const stem = `${uniq()} Odpojitelna`
    const db = openDb()
    let catId
    try {
      catId = seedCatalog(db, { name: stem, price_250g: 9 })
      const c1 = seedCycle(db, `${stem} c1`, 'coffee')
      seedSnapshot(db, c1, { name: stem, price_250g: 9, source_coffee_product_id: catId })
    } finally {
      db.close()
    }

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(stem)
    const row = page.getByTestId('catalog-row').filter({ hasText: stem })
    await expect(row).toHaveCount(1)
    await row.getByTestId('catalog-unlink').click()
    const confirm = row.getByTestId('unlink-confirm')
    await expect(confirm).toBeVisible()
    await expect(confirm, 'the confirm names how many cycles return').toContainText('1')
    await confirm.getByRole('button', { name: 'Potvrdiť' }).click()
    await expect(row.getByTestId('unlink-confirm')).toHaveCount(0)

    // The catalog row survives; the history is back in the workbench.
    const detail = await ctx.get(`/api/coffee-products/${catId}`, { headers: uiHeaders(token) })
    expect(detail.status()).toBe(200)
    await page.getByTestId('catalog-tab-migrate').click()
    await expect(page.getByTestId('workbench-row').filter({ hasText: stem })).toHaveCount(1)
  })

  test('edit dialog: split declaration section — declare, see the sibling, remove', async ({ page }) => {
    const token = await loginAsAdminUI(page)
    const sheetName = `${uniq()} Riadok Sheetu`
    const mk = (n, roast) => ctx.post('/api/coffee-products', { headers: uiHeaders(token), data: { name: n, roast_type: roast } })
    const resA = await mk(`${sheetName} Svetla`, 'Light')
    expect(resA.status()).toBe(201)
    const idB = (await (await mk(`${sheetName} Tmava`, 'Dark')).json()).id
    const declared = await ctx.post(`/api/coffee-products/${idB}/splits`, {
      headers: uiHeaders(token), data: { sheet_name: sheetName },
    })
    expect(declared.status()).toBe(201)

    await page.goto('/admin/catalog')
    await page.getByTestId('catalog-search').fill(`${sheetName} Svetla`)
    await page.getByTestId('catalog-row').getByRole('button', { name: 'Upraviť' }).click()
    const dialog = page.getByTestId('catalog-edit-dialog')
    await expect(dialog).toBeVisible()

    // Declare through the dialog.
    await dialog.getByTestId('split-sheet-name').fill(sheetName)
    await dialog.getByTestId('split-declare').click()
    const entry = dialog.getByTestId('split-entry')
    await expect(entry).toHaveCount(1)
    await expect(entry, 'the sibling set is visible').toContainText(`${sheetName} Tmava`)

    // Remove it again.
    await entry.getByTestId('split-remove').click()
    await expect(dialog.getByTestId('split-entry')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(dialog).not.toBeVisible()

    // Fix 4 (review): the "old combined row" hint. A product named exactly like
    // the declared sheet row stops being refreshed by the import — its edit
    // dialog must say so and point at „Vyradená“. (Tmava still declares the row.)
    const resC = await mk(sheetName, null)
    expect(resC.status()).toBe(201)
    await page.getByTestId('catalog-search').fill(sheetName)
    await page.getByTestId('catalog-row').filter({ hasText: sheetName }).first()
      .getByRole('button', { name: 'Upraviť' }).click()
    await expect(dialog).toBeVisible()
    const hint = dialog.getByTestId('split-identity-hint')
    await expect(hint).toBeVisible()
    await expect(hint, 'names the variants').toContainText(`${sheetName} Tmava`)
    await expect(hint, 'points at retirement').toContainText('Vyradená')
    // And the variants themselves carry NO such hint — their identity is not a
    // split key.
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await page.getByTestId('catalog-search').fill(`${sheetName} Tmava`)
    await page.getByTestId('catalog-row').getByRole('button', { name: 'Upraviť' }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('split-entry')).toHaveCount(1)
    await expect(dialog.getByTestId('split-identity-hint')).toHaveCount(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PM 2026-08-26 — REGRESSION FIX: the per-cycle stock limit had no editor for
// coffee cycles after the manual product dialog went bakery-only, even though
// `helpers/stock.js` still enforced it and the friend card still rendered it.
// The limit is CYCLE-scoped, so it lives on the snapshot row, not the catalog.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Stock limit per cycle product (PM 2026-08-26)', () => {
  test.beforeAll(refreshAdminToken)

  test('the coffee product table sets, changes and clears the limit; the friend availability follows', async ({ page, request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const catalogId = seedCatalog(db, { name: `${stem} Robo Special`, purpose: 'Filter', price_250g: 9, price_1kg: 34 })
    const cycleId = seedCycle(db, `${stem} Limitovany`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(cycleId)
    db.close()
    // ⚠ ONE admin token app-wide: seed with the BROWSER's token, after the UI login.
    const token = await loginAsAdminUI(page)
    await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: uiHeaders(token), data: { coffee_product_ids: [catalogId] },
    })
    const listed = await (await request.get(`/api/products/cycle/${cycleId}`)).json()
    const snapshotId = listed[0].id
    expect(listed[0].stock_limit_g, 'a picker-created snapshot starts unlimited').toBeFalsy()
    await page.goto(`/admin/cycle/${cycleId}`)

    // Set 2 kg.
    await page.getByTestId(`stock-limit-input-${snapshotId}`).fill('2000')
    await page.getByTestId(`stock-limit-save-${snapshotId}`).click()
    await expect(page.getByText('max 2 kg')).toBeVisible()

    // The gate the limit exists for: availability now reports it.
    const avail = await (await request.get(`/api/products/cycle/${cycleId}/availability`, { headers: uiHeaders(token) })).json()
    const row = (avail.products || avail)[String(snapshotId)] || (avail.products || avail).find?.(p => p.id === snapshotId)
    expect(JSON.stringify(avail), 'the limit reaches the availability endpoint the friend card reads').toContain('2000')

    // Clearing it means unlimited again (NULL, not 0).
    await page.getByTestId(`stock-limit-input-${snapshotId}`).fill('')
    await page.getByTestId(`stock-limit-save-${snapshotId}`).click()
    await expect(page.getByText('max 2 kg')).toHaveCount(0)
    const db2 = openDb()
    expect(db2.prepare('SELECT stock_limit_g FROM products WHERE id = ?').get(snapshotId).stock_limit_g).toBe(null)
    db2.close()
  })

  test('junk input is refused in-row and writes nothing', async ({ page, request }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const db = openDb()
    const stem = uniq()
    const catalogId = seedCatalog(db, { name: `${stem} Junk Limit`, purpose: 'Filter', price_250g: 9 })
    const cycleId = seedCycle(db, `${stem} JunkCycle`, 'coffee')
    db.prepare("UPDATE order_cycles SET status = 'open' WHERE id = ?").run(cycleId)
    db.close()
    const token = await loginAsAdminUI(page)
    await request.put(`/api/cycles/${cycleId}/catalog-products`, {
      headers: uiHeaders(token), data: { coffee_product_ids: [catalogId] },
    })
    const snapshotId = (await (await request.get(`/api/products/cycle/${cycleId}`)).json())[0].id
    await page.goto(`/admin/cycle/${cycleId}`)
    await page.getByTestId(`stock-limit-input-${snapshotId}`).fill('-5')
    await page.getByTestId(`stock-limit-save-${snapshotId}`).click()
    await expect(page.getByTestId(`stock-limit-error-${snapshotId}`)).toBeVisible()
    const db2 = openDb()
    expect(db2.prepare('SELECT stock_limit_g FROM products WHERE id = ?').get(snapshotId).stock_limit_g).toBeFalsy()
    db2.close()
  })
})
