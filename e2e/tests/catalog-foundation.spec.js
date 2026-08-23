// PC-T1 — 12 §UC-PC-001 (coffee_products schema + the snapshot link) and
// §UC-PC-002 (helpers/catalog.js normalization + fuzzy similarity).
//
// Two kinds of test live here, and the split is deliberate:
//
//  • The pure functions (normalizeProductName, normalizeRoastery, nameSimilarity,
//    FUZZY_THRESHOLD) are imported DIRECTLY from backend/src/helpers/catalog.js.
//    ⚠ This is a NEW pattern (PC-T1), not an existing precedent — every prior
//    backend-touching spec (magic-link-schema, google-auth-verifier) uses a
//    child-process probe instead. The direct import is safe HERE because: the
//    functions under test are pure; the import-time initDb() against a live gate
//    DB is idempotent try/catch-migration WAL SQLite; and the suite runs
//    --workers=1 so no parallel writer exists. A spec copying this into a
//    parallel-run context can hit SQLITE_BUSY — prefer the probe() subprocess
//    idiom there.
//    ⚠ catalog.js imports schema.js (normalizeRoastery('') resolves the
//    roasteries is_default row), and schema.js opens/migrates the DB at import
//    time. So when DB_PATH is unset the import is pointed at a THROWAWAY temp
//    file for the duration of the import, then restored — otherwise a bare
//    `npx playwright test` would silently create/migrate the dev database.
//  • The schema half boots backend/src/db/schema.js in a throwaway subprocess
//    against a temp DB file, TWICE — a second boot on an already-migrated file is
//    what makes the idempotency criterion a real test rather than a manual step.
//  • One extra assertion runs against the SHARED DB_PATH database — the database
//    the running server migrated — because that, not a fresh file, is what
//    "restart on an existing production-shaped DB" means. Self-skips without
//    DB_PATH (the established 213/214 pattern).
//
// ⚠ Driver trap (CLAUDE.md, GA-T8): node:sqlite and better-sqlite3 report
// DIFFERENT error codes for the same constraint violation. Every constraint
// assertion below matches on the MESSAGE ("UNIQUE constraint failed: …"), which
// both drivers share, never on a better-sqlite3-specific code.
//
// ⚠ Known deviation, pinned here on purpose: 12 §UC-PC-002's prose formula
// (`1 − distance / max(len_a, len_b)`) contradicts its own acceptance example —
// it yields 0.667 for ('pink bourbon', 'pink bourbon honey'), below the 0.75
// threshold the same UC requires that pair to clear. The acceptance examples are
// the contract (they are what UC-PC-003/008 build on), so nameSimilarity
// normalizes by `len_a + len_b` (0.80 / 0.52 for the two pinned pairs). See the
// header of helpers/catalog.js.

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_PATH = process.env.DB_PATH || ''
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCHEMA_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'db', 'schema.js')
const CATALOG_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'helpers', 'catalog.js')

// ─── the throwaway-boot probe (magic-link-schema.spec.js pattern) ────────────
// Runs a small ESM script in a child `node` with DB_PATH pointed at a temp file,
// so importing schema.js creates/migrates THAT database and never touches the
// suite's. Output is fished out by marker so any boot logging is ignored.
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${SCHEMA_URL}';\n` +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SCHEMA_PROBE = `
  return {
    catalogSql: (db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='coffee_products'") || {}).sql || null,
    catalogCols: db.all('PRAGMA table_info(coffee_products)'),
    catalogIndexes: db.all('PRAGMA index_list(coffee_products)').map((i) => ({
      unique: i.unique,
      cols: db.all('PRAGMA index_info(' + JSON.stringify(i.name) + ')').map((c) => c.name),
    })),
    productsCols: db.all('PRAGMA table_info(products)').map((c) => c.name),
    sourceIdx: db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_products_source_coffee'") || null,
  };
`

// ─── the direct import of the pure functions ─────────────────────────────────
// Import once per worker. schema.js resolves DB_PATH at module-init only, so
// pointing the env at a temp file for the duration of the import (and restoring
// it after) is sufficient — and when DB_PATH IS set, the shared database is the
// right target: its roasteries table is the one normalizeRoastery must resolve.
let catalog
let importTmpDir = null

test.beforeAll(async () => {
  const prev = process.env.DB_PATH
  if (!prev) {
    importTmpDir = mkdtempSync(join(tmpdir(), 'pc-t1-import-'))
    process.env.DB_PATH = join(importTmpDir, 'catalog-import.sqlite')
  }
  try {
    catalog = await import(CATALOG_URL)
  } finally {
    if (!prev) delete process.env.DB_PATH
  }
})

test.afterAll(() => {
  if (importTmpDir) rmSync(importTmpDir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-PC-002 — normalizeProductName: the identity key
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-PC-002 normalizeProductName', () => {
  test('the three pinned spec examples hold', () => {
    const { normalizeProductName } = catalog
    // en dash, doubled spaces, leading/trailing whitespace
    expect(normalizeProductName('  Pink  Bourbon – Honey ')).toBe('pink bourbon honey')
    // pure case-fold
    expect(normalizeProductName('CERRO AZUL')).toBe('cerro azul')
    // diacritics stripped via NFD + combining-mark removal, punctuation folded
    expect(normalizeProductName('Mliečna Čokoláda!')).toBe('mliecna cokolada')
  })

  test('empty / whitespace-only input normalizes to the empty string (no identity, never match)', () => {
    const { normalizeProductName } = catalog
    expect(normalizeProductName('')).toBe('')
    expect(normalizeProductName('   ')).toBe('')
    expect(normalizeProductName('\t\n')).toBe('')
    // punctuation-only collapses to nothing too — there is no [a-z0-9] left
    expect(normalizeProductName('–—!?')).toBe('')
  })

  test('digits survive, runs of non-alphanumerics become ONE space, and the pipeline is idempotent', () => {
    const { normalizeProductName } = catalog
    expect(normalizeProductName('Ethiopia Sidamo G1 (250g)')).toBe('ethiopia sidamo g1 250g')
    // several punctuation chars in a row = a single separator, not several
    expect(normalizeProductName('A -–- B')).toBe('a b')
    // already-normalized input passes through unchanged — nameSimilarity relies
    // on being able to re-normalize defensively without drift
    expect(normalizeProductName('pink bourbon honey')).toBe('pink bourbon honey')
    expect(normalizeProductName(normalizeProductName('Mliečna Čokoláda!'))).toBe('mliecna cokolada')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-PC-002 — normalizeRoastery: trim, or the is_default roastery
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-PC-002 normalizeRoastery', () => {
  test('non-empty input is trimmed verbatim (never case-folded — roastery is a display name)', () => {
    const { normalizeRoastery } = catalog
    expect(normalizeRoastery('  Goriffee ')).toBe('Goriffee')
    expect(normalizeRoastery('Dioso')).toBe('Dioso')
    // NOT lowercased and NOT run through normalizeProductName
    expect(normalizeRoastery(' Käffee & Co. ')).toBe('Käffee & Co.')
  })

  test("empty / whitespace / missing input resolves the roasteries table's is_default row (seeded 'Goriffee')", () => {
    const { normalizeRoastery } = catalog
    expect(normalizeRoastery('')).toBe('Goriffee')
    expect(normalizeRoastery('   ')).toBe('Goriffee')
    expect(normalizeRoastery(undefined)).toBe('Goriffee')
    expect(normalizeRoastery(null)).toBe('Goriffee')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-PC-002 — nameSimilarity + FUZZY_THRESHOLD: the fuzzy band
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-PC-002 nameSimilarity and the fuzzy band', () => {
  test('FUZZY_THRESHOLD is the exported named constant 0.75', () => {
    expect(catalog.FUZZY_THRESHOLD).toBe(0.75)
  })

  test("('pink bourbon', 'pink bourbon honey') lands INSIDE the fuzzy band [0.75, 1)", () => {
    const { nameSimilarity, FUZZY_THRESHOLD } = catalog
    const sim = nameSimilarity('pink bourbon', 'pink bourbon honey')
    expect(sim, 'at or above the threshold').toBeGreaterThanOrEqual(FUZZY_THRESHOLD)
    expect(sim, 'strictly below 1 — a near-miss, not an exact match').toBeLessThan(1)
  })

  test("('pink bourbon', 'ethiopia sidamo') falls BELOW the band", () => {
    const { nameSimilarity, FUZZY_THRESHOLD } = catalog
    expect(nameSimilarity('pink bourbon', 'ethiopia sidamo')).toBeLessThan(FUZZY_THRESHOLD)
  })

  test('equal normalized names score EXACTLY 1, and 1 is never "fuzzy"', () => {
    const { nameSimilarity, FUZZY_THRESHOLD } = catalog
    const sim = nameSimilarity('pink bourbon', 'pink bourbon')
    expect(sim).toBe(1)
    // The band predicate every consumer applies: FUZZY_THRESHOLD ≤ s < 1.
    // An exact match must fail it — auto-link, never pending review.
    expect(sim >= FUZZY_THRESHOLD && sim < 1, 'exact match is not a fuzzy near-miss').toBe(false)
  })

  test('similarity is symmetric and a one-letter typo is a near-miss', () => {
    const { nameSimilarity, FUZZY_THRESHOLD } = catalog
    const ab = nameSimilarity('cerro azul', 'cero azul')
    expect(ab).toBe(nameSimilarity('cero azul', 'cerro azul'))
    expect(ab, 'the typo case the review queue exists for').toBeGreaterThanOrEqual(FUZZY_THRESHOLD)
    expect(ab).toBeLessThan(1)
  })

  test("'' means no identity: the empty string never matches anything, itself included", () => {
    const { nameSimilarity, FUZZY_THRESHOLD } = catalog
    expect(nameSimilarity('', 'pink bourbon')).toBeLessThan(FUZZY_THRESHOLD)
    expect(nameSimilarity('pink bourbon', '')).toBeLessThan(FUZZY_THRESHOLD)
    // '' vs '' must NOT score 1 — callers treat '' as "never match" and a 0/0
    // NaN here would fail closed in some comparisons and open in others.
    expect(nameSimilarity('', '')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UC-PC-001 — schema: coffee_products + products.source_coffee_product_id
// ─────────────────────────────────────────────────────────────────────────────
test.describe('UC-PC-001 schema', () => {
  test('a fresh boot creates coffee_products, the column and the index — and a SECOND boot on the same file is a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const first = probe(dbFile, SCHEMA_PROBE)

      // — the table itself —
      expect(first.catalogSql, 'coffee_products exists').toBeTruthy()
      expect(first.catalogSql, 'AUTOINCREMENT primary key').toContain('AUTOINCREMENT')

      const cols = Object.fromEntries(first.catalogCols.map((c) => [c.name, c]))
      expect(Object.keys(cols).sort(), 'exactly the specified columns — no flavor_chips (resolved decision 10)').toEqual(
        [
          'id', 'name', 'normalized_name', 'roastery',
          'country', 'region', 'altitude', 'farm', 'variety', 'processing',
          'description1', 'description2', 'roast_type', 'purpose',
          'is_new', 'curator_pick_note', 'image', 'status',
          // price_8pc12g joined in PC-T12 (Brew Bags, 8 × 12 g) — retarget case (a).
          'price_150g', 'price_200g', 'price_250g', 'price_500g', 'price_1kg', 'price_20pc5g', 'price_8pc12g',
          'created_at', 'updated_at',
        ].sort()
      )
      expect(cols.name.notnull, 'name NOT NULL').toBe(1)
      expect(cols.normalized_name.notnull, 'normalized_name NOT NULL').toBe(1)
      expect(cols.roastery.notnull, 'roastery NOT NULL').toBe(1)
      expect(cols.roastery.dflt_value, "roastery defaults to 'Goriffee'").toContain('Goriffee')
      expect(cols.status.notnull, 'status NOT NULL').toBe(1)
      expect(cols.status.dflt_value, "status defaults to 'available'").toContain('available')
      expect(first.catalogSql, 'status vocabulary is CHECK-pinned').toMatch(/CHECK\s*\(\s*status IN \('available'\s*,\s*'retired'\)\s*\)/)

      // — UNIQUE(normalized_name, roastery) INSIDE the CREATE TABLE (the GA-T5
      //   lesson: never a separately-created UNIQUE index in a swallowing
      //   try/catch — the table-level constraint cannot be silently skipped) —
      expect(first.catalogSql, 'the UNIQUE lives in the CREATE TABLE').toMatch(/UNIQUE\s*\(\s*normalized_name\s*,\s*roastery\s*\)/)
      const uniquePair = first.catalogIndexes.some(
        (i) => i.unique === 1 && i.cols.join(',') === 'normalized_name,roastery'
      )
      expect(uniquePair, 'UNIQUE(normalized_name, roastery) is enforced').toBe(true)

      // — the ONLY change to an existing table + the stats-join index —
      expect(first.productsCols, 'products gained source_coffee_product_id').toContain('source_coffee_product_id')
      expect(first.sourceIdx, 'idx_products_source_coffee exists').toBeTruthy()

      // — IDEMPOTENCY: boot #2 on the very same file must not throw, and must not
      //   double up the ALTER-added column. —
      const second = probe(dbFile, SCHEMA_PROBE)
      expect(
        second.productsCols.filter((c) => c === 'source_coffee_product_id').length,
        'exactly one source_coffee_product_id column after the second boot'
      ).toBe(1)
      expect(second.catalogCols.map((c) => c.name), 'coffee_products unchanged by the second boot').toEqual(
        first.catalogCols.map((c) => c.name)
      )
      expect(second.sourceIdx, 'index survives the second boot').toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('two rows with equal (normalized_name, roastery) violate the UNIQUE; a different roastery is fine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pc-t1-db-'))
    const dbFile = join(dir, 'probe.sqlite')
    try {
      const out = probe(
        dbFile,
        `
        const res = {};
        db.run("INSERT INTO coffee_products (name, normalized_name) VALUES ('Pink Bourbon', 'pink bourbon')");
        const row = db.get("SELECT roastery, status, is_new FROM coffee_products WHERE normalized_name = 'pink bourbon'");
        res.defaults = row;
        try {
          db.run("INSERT INTO coffee_products (name, normalized_name, roastery) VALUES ('PINK BOURBON', 'pink bourbon', 'Goriffee')");
          res.duplicate = 'accepted';
        } catch (e) { res.duplicate = e.message; }
        // same normalized name under ANOTHER roastery is a DIFFERENT product
        db.run("INSERT INTO coffee_products (name, normalized_name, roastery) VALUES ('Pink Bourbon', 'pink bourbon', 'Dioso')");
        res.count = db.get('SELECT COUNT(*) AS c FROM coffee_products').c;
        try {
          db.run("INSERT INTO coffee_products (name, normalized_name, status) VALUES ('X', 'x', 'discontinued')");
          res.badStatus = 'accepted';
        } catch (e) { res.badStatus = e.message; }
        return res;
      `
      )
      // seeded defaults: roastery 'Goriffee', status 'available', is_new 0
      expect(out.defaults).toEqual({ roastery: 'Goriffee', status: 'available', is_new: 0 })
      // ⚠ message match, never a driver-specific error CODE (node:sqlite and
      // better-sqlite3 disagree on codes for the same violation).
      expect(out.duplicate, 'duplicate (normalized_name, roastery) rejected by the UNIQUE').toMatch(
        /UNIQUE constraint failed: coffee_products\.normalized_name, coffee_products\.roastery/
      )
      expect(out.count, 'the cross-roastery row was accepted').toBe(2)
      expect(out.badStatus, 'the status CHECK rejects values outside the vocabulary').toMatch(/CHECK constraint failed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the migration ran on the PRE-EXISTING shared database, not just on a fresh file', () => {
    test.skip(!DB_PATH, 'requires DB_PATH to inspect the database the running server migrated')
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coffee_products'").get()
      expect(t, 'coffee_products created on an existing DB by restart').toBeTruthy()
      const col = db.prepare('PRAGMA table_info(products)').all().filter((c) => c.name === 'source_coffee_product_id')
      expect(col.length, 'products.source_coffee_product_id added exactly once').toBe(1)
      const idx = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_products_source_coffee'")
        .get()
      expect(idx, 'idx_products_source_coffee exists on the shared DB').toBeTruthy()
    } finally {
      db.close()
    }
  })
})
