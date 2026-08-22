// PC-T2 — 12 §UC-PC-003 (catalog-targeted, duplicate-aware, cycle-independent
// import) and §UC-PC-004 (the machine-readable import report contract).
//
// The pivot's core property, asserted rather than assumed: AN IMPORT NEVER
// TOUCHES ANY CYCLE. Every import path writes `coffee_products` rows and nothing
// else — `products` and `order_cycles` are byte-compared before/after (resolved
// decisions 11+12: cycles are frozen BY CONSTRUCTION).
//
// ⚠ Vehicle: the CSV endpoint (`POST /api/coffee-products/import`, multipart).
// The two gsheet endpoints need a live public sheet and are not e2e-exercisable
// (the recorded FUP-T15 reality). Coverage transfers because all three routes
// MUST share the same `consolidateCatalogRow`/`importRowsIntoCatalog` layer and
// the extracted parser — pinned structurally below ("one definition, one call
// site per endpoint"), plus a direct pure-function test of the extracted
// gsheet/multirow parsers (`helpers/import-parsing.js` imports NO db, so a
// direct ESM import is safe — unlike catalog.js, which catalog-foundation.spec.js
// has to sandbox behind a temp DB_PATH).
//
// ⚠ Catalog rows are GLOBAL and persist across tests on a shared DB, so every
// fixture name here is unique per test run (`uniq()`); no test may assume the
// catalog is empty.
//
// Fixtures per test, not a shared beforeAll (the GSO-T8 worker-restart lesson);
// DB-shape assertions need `DB_PATH` and self-skip without it (house convention).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Route messages, reused verbatim from the handlers (the nonstring-body-shape
// convention: copied, never re-worded).
const IMPORT_URL_REQUIRED = 'URL je povinne'
const IMPORT_URL_INVALID = 'Neplatna Google Sheets URL'

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

// Unique, normalization-stable product name prefix per call.
//
// ⚠ Residue awareness: on a long-lived DB, earlier runs of THIS file leave
// catalog rows whose names share the fixed words of a fixture ("… Pink
// Bourbon") — and those legitimately land in the fuzzy band against a new
// run's row. Tests below therefore never pin `pending_fuzzy: 0` on an import
// that CREATES rows (residue makes that flaky by design of the feature); the
// zero-pins live only on all-matched re-imports, where no fuzzy scan runs.
const uniq = () => `PCT2 ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`

// The legacy CSV column vocabulary (the parser is the EXTRACTED products.js one,
// so the aliases must keep working: Name/Description1/Popis2/Roast/Purpose/…).
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

function openDb() {
  return new DatabaseSync(DB_PATH)
}

function catalogRowByName(name) {
  const db = openDb()
  try {
    return db.prepare('SELECT * FROM coffee_products WHERE name = ?').get(name) ?? null
  } finally {
    db.close()
  }
}

function tableSnapshot(table) {
  const db = openDb()
  try {
    return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
  } finally {
    db.close()
  }
}

// ── 1. report contract + new-row creation ─────────────────────────────────────

test.describe('UC-PC-004 — the report is a machine contract', () => {
  test('a CSV import of two unknown products creates catalog rows and returns the exact report shape', async () => {
    const a = `${uniq()} Cerro Azul`
    const b = `${uniq()} Pink Bourbon`
    const res = await importCsv(csvFor([
      { name: a, desc1: 'Washed', desc2: 'kvety, med', roast: 'Light roast', purpose: 'Filter', p250: '8,9 EUR', p1kg: '35,3' },
      { name: b, desc1: 'Honey', desc2: 'jahoda', roast: 'Medium roast', purpose: 'Espresso', p250: '9.40', p1kg: '39' },
    ]))
    expect(res.status()).toBe(201)
    const body = await res.json()

    // Top level: exactly { report }, and the report's buckets are the pinned
    // vocabulary — key-for-key (listed keys stable; this is the contract the
    // future autonomous routine consumes).
    expect(Object.keys(body)).toEqual(['report'])
    const report = body.report
    expect(Object.keys(report).sort()).toEqual(
      ['matched', 'new', 'pending_fuzzy', 'price_changes', 'summary', 'unparsed'])
    expect(Object.keys(report.summary).sort()).toEqual(
      ['matched', 'new', 'pending_fuzzy', 'price_changes', 'unparsed'])

    expect(report.summary.new).toBe(2)
    expect(report.summary.matched).toBe(0)
    expect(report.summary.price_changes).toBe(0)
    expect(report.summary.unparsed).toBe(0)
    // The summary must agree with its own detail list (residue on a long-lived
    // DB can legitimately make pending_fuzzy non-zero here — see uniq()).
    expect(report.summary.pending_fuzzy).toBe(report.pending_fuzzy.length)
    expect(report.new).toHaveLength(2)
    for (const entry of report.new) {
      expect(Object.keys(entry).sort()).toEqual(['catalog_id', 'name', 'needs_image'])
      expect(entry.needs_image).toBe(true)
      expect(typeof entry.catalog_id).toBe('number')
    }
    expect(report.new.map((e) => e.name).sort()).toEqual([a, b].sort())

    // No cycle context of any kind, and no snapshot ids — imports create no
    // snapshots (§UC-PC-004: `product_id` asserted ABSENT).
    const raw = JSON.stringify(body)
    expect(raw).not.toMatch(/product_id/)
    expect(raw).not.toMatch(/cycle_id/)
  })

  test('a nameless row is reported under unparsed with a reason, never silently dropped', async () => {
    const a = `${uniq()} Sidamo`
    const res = await importCsv(csvFor([
      { name: a, purpose: 'Filter', p250: '8' },
      { name: '', desc1: 'orphan row', p250: '9' },
    ]))
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.new).toBe(1)
    expect(report.summary.unparsed).toBe(1)
    expect(report.unparsed[0].reason).toBe('missing name')
    expect(typeof report.unparsed[0].row).toBe('number')
  })
})

// ── 2. exact match: refresh + price change reporting ─────────────────────────

test.describe('UC-PC-003 — exact match refreshes the catalog (decision 13)', () => {
  test('a changed price on re-import is applied to the catalog and reported old→new', async () => {
    const name = `${uniq()} Huila`
    const first = await importCsv(csvFor([{ name, purpose: 'Filter', p250: '8,9', p1kg: '35,3' }]))
    expect(first.status()).toBe(201)
    const firstReport = (await first.json()).report
    expect(firstReport.summary.new).toBe(1)
    const catalogId = firstReport.new[0].catalog_id

    const second = await importCsv(csvFor([{ name, purpose: 'Filter', p250: '9,4', p1kg: '35,3' }]))
    expect(second.status()).toBe(201)
    const { report } = await second.json()
    expect(report.summary).toEqual({ new: 0, matched: 1, price_changes: 1, pending_fuzzy: 0, unparsed: 0 })
    expect(report.matched).toEqual([{ catalog_id: catalogId, name }])
    expect(report.price_changes).toEqual([
      { catalog_id: catalogId, name, field: 'price_250g', old: 8.9, new: 9.4 },
    ])
  })

  test('the catalog row really carries the new current price (DB readback)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Nariño`
    await importCsv(csvFor([{ name, p250: '8,9', p1kg: '35' }]))
    await importCsv(csvFor([{ name, p250: '9,4', p1kg: '35' }]))
    const row = catalogRowByName(name)
    expect(row).not.toBeNull()
    expect(row.price_250g).toBe(9.4)
    expect(row.price_1kg).toBe(35)
  })

  test('sheet-sourced fields refresh; admin-only fields SURVIVE an import (decision 13)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Geisha`
    const created = await importCsv(csvFor([{ name, desc2: 'stary profil', roast: 'Light roast', p250: '10' }]))
    expect(created.status()).toBe(201)
    const catalogId = (await created.json()).report.new[0].catalog_id

    // Admin curation, direct on the catalog row: an informational attribute
    // (country) plus a hand-tuned status — the importer may write NEITHER.
    {
      const db = openDb()
      try {
        db.prepare("UPDATE coffee_products SET country = 'Kolumbia', is_new = 1 WHERE id = ?").run(catalogId)
      } finally {
        db.close()
      }
    }

    const res = await importCsv(csvFor([{ name, desc2: 'novy profil', roast: 'Light roast', p250: '10' }]))
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.matched).toBe(1)
    expect(report.summary.price_changes).toBe(0)

    const row = catalogRowByName(name)
    expect(row.description2, 'the sheet wins for sheet-sourced fields').toBe('novy profil')
    expect(row.country, 'admin-only fields are never importer-written').toBe('Kolumbia')
    expect(row.is_new).toBe(1)
  })

  test('an empty sheet cell never blanks a catalog value', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Yirgacheffe`
    await importCsv(csvFor([{ name, desc1: 'Washed', desc2: 'citrus', roast: 'Light roast', p250: '8' }]))
    // Same product, but the sheet now carries empty description cells.
    const res = await importCsv(csvFor([{ name, desc1: '', desc2: '', roast: 'Light roast', p250: '8' }]))
    expect(res.status()).toBe(201)
    const row = catalogRowByName(name)
    expect(row.description1).toBe('Washed')
    expect(row.description2).toBe('citrus')
  })
})

// ── 3. natural idempotency (resolved decision 12) ────────────────────────────

test.describe('UC-PC-003 rule 6 — naturally idempotent', () => {
  test('re-importing the same sheet reports 0 new / N matched / 0 price_changes', async () => {
    const a = `${uniq()} Bourbon`
    const b = `${uniq()} Caturra`
    const csv = csvFor([
      { name: a, desc1: 'x', desc2: 'y', roast: 'Light roast', purpose: 'Filter', p250: '8,9', p1kg: '35' },
      { name: b, desc1: 'z', purpose: 'Espresso', p250: '9', p1kg: '36' },
    ])
    await importCsv(csv)
    const res = await importCsv(csv)
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary).toEqual({ new: 0, matched: 2, price_changes: 0, pending_fuzzy: 0, unparsed: 0 })
  })

  test('the second identical import writes NOTHING (byte-compare, updated_at included)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const a = `${uniq()} Pacamara`
    const csv = csvFor([{ name: a, desc1: 'p', desc2: 'q', roast: 'Medium roast', purpose: 'Filter', p250: '8', p1kg: '30' }])
    await importCsv(csv)
    const before = JSON.stringify(catalogRowByName(a))
    // updated_at is second-resolution: make sure a rewrite WOULD move it.
    await new Promise((r) => setTimeout(r, 1100))
    const res = await importCsv(csv)
    expect(res.status()).toBe(201)
    expect(JSON.stringify(catalogRowByName(a)), 'row must be byte-identical after a no-op re-import').toBe(before)
  })
})

// ── 4. fuzzy near-miss: create-as-new-but-flagged (resolved decision 1) ──────

test.describe('UC-PC-003 rules 3–4 — fuzzy near-miss', () => {
  test('a near-miss name creates a NEW catalog row AND a pending_fuzzy entry naming the candidate', async () => {
    const stem = `${uniq()} Pink Bourbon`
    const first = await importCsv(csvFor([{ name: stem, purpose: 'Filter', p250: '9' }]))
    const candidateId = (await first.json()).report.new[0].catalog_id

    const res = await importCsv(csvFor([{ name: `${stem} Honey`, purpose: 'Filter', p250: '10' }]))
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.new, 'never auto-merged — the row is created').toBe(1)
    expect(report.summary.pending_fuzzy).toBe(1)
    const fuzzy = report.pending_fuzzy[0]
    expect(Object.keys(fuzzy).sort()).toEqual(
      ['candidate_catalog_id', 'candidate_name', 'catalog_id', 'name', 'similarity'])
    expect(fuzzy.catalog_id).toBe(report.new[0].catalog_id)
    expect(fuzzy.candidate_catalog_id).toBe(candidateId)
    expect(fuzzy.candidate_name).toBe(stem)
    expect(fuzzy.similarity).toBeGreaterThanOrEqual(0.75)
    expect(fuzzy.similarity).toBeLessThan(1)
  })

  test('matching is within-roastery: the same name under another roastery is new, with no fuzzy candidate across roasteries', async () => {
    const name = `${uniq()} Cerro Alto`
    await importCsv(csvFor([{ name, purpose: 'Filter', p250: '9' }])) // default roastery (Goriffee)
    // The roastery is unique per run, so ITS catalog is empty: any match or
    // fuzzy candidate could only have leaked across the roastery boundary.
    const res = await importCsv(csvFor([{ name, purpose: 'Filter', p250: '9' }]), `Praziareñ ${uniq()}`)
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.new, 'a different roastery can never match (or fuzzy-suggest) the Goriffee row').toBe(1)
    expect(report.summary.matched).toBe(0)
    expect(report.summary.pending_fuzzy).toBe(0)
  })
})

// ── 5. in-sheet duplicate (UC-PC-003 rule 5) ─────────────────────────────────

test.describe('UC-PC-003 rule 5 — duplicate rows within one sheet', () => {
  test('a later row resolving to the same catalog id is skipped and reported under unparsed', async () => {
    const name = `${uniq()} Mliečna Čokoláda`
    const res = await importCsv(csvFor([
      { name, purpose: 'Espresso', p250: '8,0' },
      // Same identity after normalization (case/diacritics/punctuation fold),
      // different price — the duplicate must write NOTHING.
      { name: name.toUpperCase() + '!', purpose: 'Espresso', p250: '99' },
    ]))
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.new).toBe(1)
    expect(report.summary.matched, 'the dup is NOT counted as matched').toBe(0)
    expect(report.summary.price_changes, 'the dup wrote no price').toBe(0)
    expect(report.summary.unparsed).toBe(1)
    expect(report.unparsed[0].reason).toBe('duplicate row in sheet')
    expect(typeof report.unparsed[0].row).toBe('number')
  })

  test('the duplicate row wrote nothing — the first row’s price stands', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Dulce`
    await importCsv(csvFor([
      { name, purpose: 'Espresso', p250: '8,0' },
      { name: `  ${name} `, purpose: 'Espresso', p250: '99' },
    ]))
    const row = catalogRowByName(name)
    expect(row.price_250g).toBe(8)
  })
})

// ── 6. the frozen-cycles pin: zero writes to products / order_cycles ─────────

test.describe('UC-PC-003 rule 8 — no cycle is ever touched', () => {
  test('products and order_cycles are byte-identical before/after an import (new + matched + dup + fuzzy)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const stem = `${uniq()} Frozen`
    // Prime the catalog so the second import exercises the matched path too.
    await importCsv(csvFor([{ name: `${stem} One`, p250: '8' }]))

    const productsBefore = tableSnapshot('products')
    const cyclesBefore = tableSnapshot('order_cycles')

    const res = await importCsv(csvFor([
      { name: `${stem} One`, p250: '9' },        // matched + price change
      { name: `${stem} One Honey`, p250: '10' }, // new + fuzzy
      { name: `${stem} Two`, p250: '11' },       // new
      { name: `${stem} Two`, p250: '12' },       // in-sheet duplicate
      { name: '', p250: '13' },                  // unparsed
    ]))
    expect(res.status()).toBe(201)

    expect(tableSnapshot('products'), 'an import may not write a single products byte').toBe(productsBefore)
    expect(tableSnapshot('order_cycles'), 'an import may not write a single order_cycles byte').toBe(cyclesBefore)
  })
})

// ── 7. auth + hostile input (the FUP-T12/T15-class guards, carried from birth) ─

test.describe('UC-PC-003 — route guards', () => {
  test('anonymous callers get 401 on all three import routes', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      for (const path of ['/api/coffee-products/import', '/api/coffee-products/import-gsheet', '/api/coffee-products/import-gsheet-multirow']) {
        const res = await anon.post(path, { data: { url: 'https://docs.google.com/spreadsheets/d/x/edit' } })
        expect(res.status(), `${path} must not be reachable anonymously`).toBe(401)
      }
    } finally {
      await anon.dispose()
    }
  })

  test('a non-string gsheet url is a clean 400 with the route’s own message, nothing echoed', async () => {
    const MALFORMED = [{ match: 1 }, ['a', 'b', 'c'], 12, true, null]
    for (const path of ['/api/coffee-products/import-gsheet', '/api/coffee-products/import-gsheet-multirow']) {
      for (const url of MALFORMED) {
        const res = await ctx.post(path, { headers: admin(), data: { url } })
        expect(res.status(), `${path} with url=${JSON.stringify(url)}`).toBe(400)
        const body = await res.json()
        expect(body.error).toBe(IMPORT_URL_REQUIRED)
        const raw = JSON.stringify(body)
        expect(raw).not.toMatch(/match is not a function/)
        expect(raw).not.toMatch(/TypeError|RangeError/)
        expect(raw).not.toMatch(/\bat\s+\S+\.js/)
      }
      // Absent url: same refusal.
      const absent = await ctx.post(path, { headers: admin(), data: {} })
      expect(absent.status()).toBe(400)
      expect((await absent.json()).error).toBe(IMPORT_URL_REQUIRED)
      // NOTHING LOOSENED: a string that is not a Sheets URL still reaches the
      // parser and is refused by the URL regex, not the guard.
      const notASheet = await ctx.post(path, { headers: admin(), data: { url: 'https://example.test/not-a-sheet' } })
      expect(notASheet.status()).toBe(400)
      expect((await notASheet.json()).error).toBe(IMPORT_URL_INVALID)
    }
  })

  test('a non-string multipart roastery is treated as absent (bindValue), not a 500', async () => {
    // multer parses fields through append-field: `roastery[a]=1` arrives as an
    // OBJECT (the FUP-T15 incident shape). It must resolve to the default
    // roastery, exactly as an absent field does.
    const name = `${uniq()} BindShape`
    const BOUNDARY = '----pct2boundary'
    const csv = csvFor([{ name, p250: '8' }])
    const body =
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="roastery[a]"\r\n\r\n1\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n${csv}\r\n--${BOUNDARY}--\r\n`
    const res = await ctx.post('/api/coffee-products/import', {
      headers: { ...admin(), 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      data: Buffer.from(body, 'utf8'),
    })
    expect(res.status()).toBe(201)
    const { report } = await res.json()
    expect(report.summary.new).toBe(1)
    // And a re-import WITHOUT any roastery field exact-matches it — proof the
    // malformed field resolved to the default roastery, not to some junk value.
    const again = await importCsv(csv)
    expect((await again.json()).report.summary.matched).toBe(1)
  })

  test('a missing file on the CSV route is a 400, not a crash', async () => {
    const res = await ctx.post('/api/coffee-products/import', {
      headers: admin(),
      multipart: { roastery: 'Goriffee' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('Ziaden subor nebol nahrany')
  })
})

// ── 8. structural pins — the seam that makes CSV coverage transfer ────────────
//
// The gsheet endpoints cannot be exercised end-to-end (live sheet required), so
// the suite pins the STRUCTURE instead (UC-PC-011 item 2): one parser home, one
// consolidation home, one call site per endpoint, and no import SQL anywhere
// outside the consolidation helper.

test.describe('UC-PC-003 — parsing extracted, consolidation shared (structural)', () => {
  const routesSrc = () => readFileSync(join(REPO_ROOT, 'backend', 'src', 'routes', 'coffee-products.js'), 'utf8')
  const productsSrc = () => readFileSync(join(REPO_ROOT, 'backend', 'src', 'routes', 'products.js'), 'utf8')
  const parsingSrc = () => readFileSync(join(REPO_ROOT, 'backend', 'src', 'helpers', 'import-parsing.js'), 'utf8')
  const consolidationSrc = () => readFileSync(join(REPO_ROOT, 'backend', 'src', 'helpers', 'catalog-import.js'), 'utf8')

  test('all three catalog routes funnel through the ONE consolidation layer', () => {
    const src = routesSrc()
    expect(src).toContain("from '../helpers/import-parsing.js'")
    expect(src).toContain("from '../helpers/catalog-import.js'")
    // Exactly three call sites — one per endpoint, nothing bespoke.
    expect((src.match(/importRowsIntoCatalog\(/g) || []).length).toBe(3)
    // No inline catalog SQL in the IMPORT half: the helper is the only
    // import-path writer. ⚠ Re-pointed for PC-T7 (e2e-immutability case (a),
    // 12 §UC-PC-009): the router now also carries the admin CRUD routes, whose
    // PATCH/image handlers legitimately UPDATE coffee_products — so the blanket
    // whole-file UPDATE ban became structurally unsatisfiable. The pinned
    // property is unchanged: everything ABOVE the PC-T7 CRUD section (all three
    // import endpoints) funnels through importRowsIntoCatalog with zero bespoke
    // catalog SQL, and catalog-row CREATION still has exactly one home (no
    // INSERT anywhere in the routes file — CRUD edits rows, never creates them).
    const crudStart = src.indexOf('Catalog CRUD (PC-T7')
    expect(crudStart, 'the PC-T7 CRUD section marker exists').toBeGreaterThan(-1)
    const importHalf = src.slice(0, crudStart)
    expect(importHalf).not.toMatch(/INSERT INTO coffee_products/)
    expect(importHalf).not.toMatch(/UPDATE coffee_products/)
    expect(src).not.toMatch(/INSERT INTO coffee_products/)
  })

  test('the parser has ONE home and products.js re-imports it (pure relocation)', () => {
    const parsing = parsingSrc()
    const products = productsSrc()
    // The moved functions are defined in the helper…
    for (const fn of ['parseMultiRowProducts', 'parsePriceString', 'isSeparatorRow', 'isProductSectionHeader']) {
      expect((parsing.match(new RegExp(`function ${fn}\\(`, 'g')) || []).length, `${fn} defined once in the helper`).toBe(1)
      expect(products).not.toMatch(new RegExp(`function ${fn}\\(`))
    }
    // …and the legacy routes consume the helper instead of their inline copies.
    expect(products).toContain("from '../helpers/import-parsing.js'")
    expect(products, 'the column-mapping loop left products.js').not.toMatch(/p\.Nazov/)
    // The one INSERT INTO coffee_products lives in the consolidation helper.
    expect((consolidationSrc().match(/INSERT INTO coffee_products/g) || []).length).toBe(1)
  })

  test('the extracted multirow parser still parses the 3-rows-per-product format (direct import)', async () => {
    // import-parsing.js deliberately imports NO db module, so a direct ESM
    // import cannot create or migrate any database.
    const mod = await import('file://' + join(REPO_ROOT, 'backend', 'src', 'helpers', 'import-parsing.js'))
    const csv = [
      'Cennik,,,,,,,,',                                  // preamble
      ',,,,,,,,',                                        // separator → products follow
      ',Test Coffee,,,,,,Filter,250g / 1kg',             // row 1: name, purpose, variant label
      ',Sladka a cista,,,,,,,"8,9 / 35,3 EUR"',          // row 2: description, price
      ',jahoda; med,,,,,,Light roast,',                  // row 3: flavor, roast
      ',,,,,,,,',
      ',Solo Price,,,,,,Espresso,250g',
      ',Popis,,,,,,,"9,9"',
      ',kakao,,,,,,Medium roast,',
    ].join('\n')
    const { products, warnings } = mod.parseMultiRowProducts(csv)
    expect(products).toHaveLength(2)
    expect(products[0].name).toBe('Test Coffee')
    expect(products[0].purpose).toBe('Filter')
    expect(products[0].price_250g).toBe(8.9)
    expect(products[0].price_1kg).toBe(35.3)
    expect(products[0].roast_type).toBe('Light roast')
    expect(products[1].name).toBe('Solo Price')
    expect(products[1].price_250g).toBe(9.9)
    expect(Array.isArray(warnings)).toBe(true)
  })

  test('the extracted CSV mappers keep the legacy aliases and price formats (direct import)', async () => {
    const mod = await import('file://' + join(REPO_ROOT, 'backend', 'src', 'helpers', 'import-parsing.js'))
    const rows = mod.parseCsvProducts('Nazov,Popis1,ChutovyProfil,Prazenie,Ucel,Cena250g,Cena1kg\nKava,Popis,Profil,Light,Filter,"8,9 EUR","35,30"\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Kava', description1: 'Popis', description2: 'Profil',
      roast_type: 'Light', purpose: 'Filter', price_250g: 8.9, price_1kg: 35.3,
    })
    // The gsheet mapper additionally honours the diacritic-free 'Chutovy profil'
    // header (the one alias the two legacy copies did NOT share).
    const gs = mod.parseGsheetCsvProducts('Name,Chutovy profil\nKava,Profil2\n')
    expect(gs[0].description2).toBe('Profil2')
    const plain = mod.parseCsvProducts('Name,Chutovy profil\nKava,Profil2\n')
    expect(plain[0].description2, 'the plain CSV mapper deliberately keeps its narrower alias set').toBe('')
  })
})

// ── 9. UC-PC-005 — the manual per-cycle POST joins the consolidation (PC-T3) ──
//
// `POST /api/products` is the ONE sanctioned add-to-an-existing-cycle path
// (resolved decision 11: it ADDS a snapshot to an open cycle, never mutates an
// existing one). For a coffee cycle it funnels through the SAME
// consolidateCatalogRow as the importers — exact match ⇒ link + decision-13
// refresh, no match ⇒ create, fuzzy near-miss ⇒ create-as-new-but-flagged —
// and the 201 keeps returning the snapshot row (byte-compatible) plus the
// UC-PC-004 `report` with exactly one row accounted for. Bakery cycles never
// touch coffee_products (brief Decision 6).

// Route message, verbatim from the spec (12 §UC-PC-005) and the handler.
const DUP_IN_CYCLE = 'Produkt už v tomto cykle existuje.'

// A real PNG's magic bytes as a data: URI — the body-image path (imageFromBody).
const PNG_DATA_URI = 'data:image/png;base64,' +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')

async function createCycle(type) {
  const res = await ctx.post('/api/cycles', {
    headers: admin(),
    data: { name: `PCT3 cyklus ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, ...(type ? { type } : {}) },
  })
  expect(res.status(), 'cycle fixture must be creatable').toBe(201)
  return (await res.json()).id
}

function postProduct(cycleId, fields) {
  return ctx.post('/api/products', { headers: admin(), data: { cycle_id: cycleId, ...fields } })
}

function catalogCountByName(name) {
  const db = openDb()
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM coffee_products WHERE name = ?').get(name).n
  } finally {
    db.close()
  }
}

test.describe('UC-PC-005 — manual POST of a NEW name', () => {
  test('creates a catalog row, links the snapshot, and the 201 stays the snapshot row plus a one-row report', async () => {
    const cycleId = await createCycle()
    const name = `${uniq()} Manual Cerro`
    const res = await postProduct(cycleId, {
      name, description1: 'Washed', description2: 'kvety',
      roast_type: 'Light roast', purpose: 'Filter', price_250g: '8.9', price_1kg: 35.3,
    })
    expect(res.status()).toBe(201)
    const body = await res.json()

    // Byte-compatible snapshot row at the top level — this endpoint survives,
    // so its consumers matter (they read fields straight off the body).
    expect(typeof body.id).toBe('number')
    expect(body.cycle_id).toBe(cycleId)
    expect(body.name).toBe(name)
    expect(body.description1).toBe('Washed')

    // …plus the SAME report shape the importers return (UC-PC-004).
    expect(Object.keys(body.report).sort()).toEqual(
      ['matched', 'new', 'pending_fuzzy', 'price_changes', 'summary', 'unparsed'])
    expect(Object.keys(body.report.summary).sort()).toEqual(
      ['matched', 'new', 'pending_fuzzy', 'price_changes', 'unparsed'])
    expect(body.report.summary.new).toBe(1)
    expect(body.report.summary.matched).toBe(0)
    expect(body.report.summary.price_changes).toBe(0)
    expect(body.report.summary.unparsed).toBe(0)
    expect(body.report.new).toHaveLength(1)
    expect(Object.keys(body.report.new[0]).sort()).toEqual(['catalog_id', 'name', 'needs_image'])
    expect(body.report.new[0].name).toBe(name)
    expect(body.report.new[0].needs_image, 'no image posted ⇒ the catalog row needs one').toBe(true)

    // The snapshot is born linked to the created catalog row.
    expect(body.source_coffee_product_id).toBe(body.report.new[0].catalog_id)
  })

  test('the created catalog row carries the manual fields, with string prices parsed as numbers (DB readback)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const cycleId = await createCycle()
    const name = `${uniq()} Manual Huila`
    const res = await postProduct(cycleId, {
      name, description2: 'jahoda', roast_type: 'Medium roast', purpose: 'Espresso',
      price_250g: '9,4 EUR', price_1kg: '39',
    })
    expect(res.status()).toBe(201)
    const row = catalogRowByName(name)
    expect(row).not.toBeNull()
    expect(row.price_250g, 'a string price is a number on the catalog row').toBe(9.4)
    expect(row.price_1kg).toBe(39)
    expect(row.description2).toBe('jahoda')
    expect(row.roast_type).toBe('Medium roast')
    expect(row.purpose).toBe('Espresso')
    expect(row.status).toBe('available')
    expect(row.image).toBeNull()
  })
})

test.describe('UC-PC-005 — manual POST of a KNOWN name', () => {
  test('links to the EXISTING catalog row — no new catalog row — and the manual price refreshes the catalog like an imported one', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Manual Geisha`
    // The catalog knows the product from an import…
    const imported = await importCsv(csvFor([{ name, purpose: 'Filter', p250: '8,9', p1kg: '35' }]))
    const catalogId = (await imported.json()).report.new[0].catalog_id

    // …and the manual POST (a mid-cycle addition) exact-matches it.
    const cycleId = await createCycle()
    const res = await postProduct(cycleId, { name, purpose: 'Filter', price_250g: '9.4', price_1kg: '35' })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.report.summary).toEqual({ new: 0, matched: 1, price_changes: 1, pending_fuzzy: 0, unparsed: 0 })
    expect(body.report.matched).toEqual([{ catalog_id: catalogId, name }])
    expect(body.report.price_changes).toEqual([
      { catalog_id: catalogId, name, field: 'price_250g', old: 8.9, new: 9.4 },
    ])
    expect(body.source_coffee_product_id).toBe(catalogId)

    expect(catalogCountByName(name), 'exactly one catalog row — matched, never duplicated').toBe(1)
    expect(catalogRowByName(name).price_250g, 'the manual price IS the current sell price').toBe(9.4)
  })
})

test.describe('UC-PC-005 — duplicate_in_cycle', () => {
  test('a repeated exact-name POST into the SAME cycle is refused with 409 and the pinned body', async () => {
    const cycleId = await createCycle()
    const name = `${uniq()} Manual Dulce`
    expect((await postProduct(cycleId, { name, price_250g: '8' })).status()).toBe(201)

    const res = await postProduct(cycleId, { name, price_250g: '99' })
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body).toEqual({ error: DUP_IN_CYCLE, reason: 'duplicate_in_cycle' })

    // The one-normalizer rule: a case/punctuation variant of the same identity
    // is the same duplicate.
    const variant = await postProduct(cycleId, { name: name.toUpperCase() + '!', price_250g: '99' })
    expect(variant.status()).toBe(409)
    expect((await variant.json()).reason).toBe('duplicate_in_cycle')

    // The same name into a DIFFERENT cycle is the legitimate mid-cycle path.
    const otherCycle = await createCycle()
    expect((await postProduct(otherCycle, { name, price_250g: '8' })).status()).toBe(201)
  })

  test('the 409 writes NOTHING — catalog and products byte-identical, no decision-13 refresh (byte-compare)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const cycleId = await createCycle()
    const name = `${uniq()} Manual Frozen`
    await postProduct(cycleId, { name, description2: 'stary profil', price_250g: '8' })

    const catalogBefore = tableSnapshot('coffee_products')
    const productsBefore = tableSnapshot('products')
    // A different price + description: a leak through the refresh path would
    // move the catalog row even though the POST was refused.
    const res = await postProduct(cycleId, { name, description2: 'novy profil', price_250g: '99' })
    expect(res.status()).toBe(409)
    expect(tableSnapshot('coffee_products'), 'the refused POST may not write a single catalog byte').toBe(catalogBefore)
    expect(tableSnapshot('products'), 'the refused POST may not write a single products byte').toBe(productsBefore)
  })
})

test.describe('UC-PC-005 — bakery-cycle exemption (brief Decision 6)', () => {
  test('a bakery-cycle POST returns the plain snapshot row: no report, no link, and no 409 on repeat', async () => {
    const cycleId = await createCycle('bakery')
    const name = `${uniq()} Makovnik`
    const res = await postProduct(cycleId, { name, price_250g: '4' })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.report, 'bakery rows are never consolidated — no report').toBeUndefined()
    expect(body.source_coffee_product_id).toBeNull()

    // The duplicate guard is catalog-borne, so it must not leak into bakery:
    // a repeated POST keeps today's behavior (a second row).
    const again = await postProduct(cycleId, { name, price_250g: '4' })
    expect(again.status(), 'bakery cycles keep the pre-PC-T3 duplicate behavior').toBe(201)
  })

  test('a bakery-cycle POST leaves coffee_products byte-identical (byte-compare)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const cycleId = await createCycle('bakery')
    const before = tableSnapshot('coffee_products')
    const res = await postProduct(cycleId, { name: `${uniq()} Orechovnik`, price_250g: '4' })
    expect(res.status()).toBe(201)
    expect(tableSnapshot('coffee_products'), 'a bakery POST may not touch the coffee catalog').toBe(before)
  })
})

test.describe('UC-PC-005 — fuzzy near-miss via manual POST', () => {
  test('a near-miss name is created AND flagged, exactly like an imported one', async () => {
    const stem = `${uniq()} Manual Pink Bourbon`
    const first = await importCsv(csvFor([{ name: stem, purpose: 'Filter', p250: '9' }]))
    const candidateId = (await first.json()).report.new[0].catalog_id

    const cycleId = await createCycle()
    const res = await postProduct(cycleId, { name: `${stem} Honey`, purpose: 'Filter', price_250g: '10' })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.report.summary.new, 'never auto-merged — the row is created').toBe(1)
    expect(body.report.summary.pending_fuzzy).toBe(1)
    const fuzzy = body.report.pending_fuzzy[0]
    expect(Object.keys(fuzzy).sort()).toEqual(
      ['candidate_catalog_id', 'candidate_name', 'catalog_id', 'name', 'similarity'])
    expect(fuzzy.catalog_id).toBe(body.report.new[0].catalog_id)
    expect(fuzzy.candidate_catalog_id).toBe(candidateId)
    expect(body.source_coffee_product_id, 'the snapshot links to the NEW row, not the candidate').toBe(body.report.new[0].catalog_id)
  })
})

test.describe('UC-PC-005 — image dual-store', () => {
  test('an image on a CREATING POST lands on the snapshot AND the new catalog row; needs_image is false', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const cycleId = await createCycle()
    const name = `${uniq()} Manual Foto`
    const res = await postProduct(cycleId, { name, price_250g: '8', image: PNG_DATA_URI })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.image, 'existing behavior: the snapshot keeps its own image').toBe(PNG_DATA_URI)
    expect(body.report.new[0].needs_image).toBe(false)
    expect(catalogRowByName(name).image, 'the friction win: the next cycle reuses this image').toBe(PNG_DATA_URI)
  })

  test('an image on a MATCHING POST stays on the snapshot only — image is admin-only on the catalog (decision 13)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const name = `${uniq()} Manual Bez Fotky`
    await importCsv(csvFor([{ name, p250: '8' }])) // catalog row, image NULL
    const cycleId = await createCycle()
    const res = await postProduct(cycleId, { name, price_250g: '8', image: PNG_DATA_URI })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.report.summary.matched).toBe(1)
    expect(body.image).toBe(PNG_DATA_URI)
    expect(catalogRowByName(name).image, 'a match never writes the catalog image').toBeNull()
  })
})

test.describe('UC-PC-005 — guards and structure', () => {
  test('the existing cycle_id/name 400 still fires first', async () => {
    const res = await ctx.post('/api/products', { headers: admin(), data: { name: 'no cycle' } })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe('cycle_id a nazov su povinne')
  })

  test('the manual POST funnels through the ONE consolidation layer (structural)', () => {
    const src = readFileSync(join(REPO_ROOT, 'backend', 'src', 'routes', 'products.js'), 'utf8')
    expect(src).toContain("from '../helpers/catalog-import.js'")
    // Exactly one consolidation call site — the manual POST; the legacy
    // per-cycle importers stay catalog-blind until they retire (PC-T8).
    expect((src.match(/consolidateCatalogRow\(/g) || []).length).toBe(1)
    // No inline catalog SQL: the helper stays the only coffee_products writer.
    expect(src).not.toMatch(/INSERT INTO coffee_products/)
    expect(src).not.toMatch(/UPDATE coffee_products/)
  })
})
