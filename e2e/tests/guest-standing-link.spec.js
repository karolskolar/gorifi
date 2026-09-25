// Module 19 — the host's STANDING guest link (UC-GL-*). This is the module's own
// spec file; later GL rows extend it (19 §UC-GL-011 item 3 enumerates the
// obligations).
//
// GL-T1 — 19 §UC-GL-001 + the PO decisions of 2026-09-19 (admin read + regenerate):
//
//   • schema: `friends.guest_link_token` (ALTER, nullable) + `idx_friends_guest_link_token`
//     in its OWN try/catch, and the INERT `guest_waitlist` table + its partial unique
//     index (no writer until GL-T3 — but `waiting_count` counts real rows from day one);
//   • `backend/src/helpers/standing-link.js`, the ONE home of `uniqueGuestToken()`
//     (unique across BOTH token spaces — it replaced `guest-links.js`'s private
//     `uniqueToken()`), `ensureStandingToken`, `regenerateStandingToken`,
//     `standingUrlPath`, `currentOpenCycle()` and `waitingCount()`;
//   • host `GET /api/guest-links/standing` (the one deliberate write-in-GET, D1) and
//     `POST /api/guest-links/standing/regenerate` (no `has_orders` gate, D2);
//   • admin `GET /api/friends/:id/guest-link/standing` and `POST …/regenerate` — ONE
//     helper, TWO guards.
//
// ~~⚠ What GL-T1 does NOT do: resolve a standing token on `/g/:token`. That is GL-T2's
// `resolveEntry()`. Until it lands EVERY standing token answers the uniform 404, so
// the „old token 404s after regenerate" pin below is forward-compatible rather than
// discriminating today~~ — **GL-T2 landed it: the regenerate pin now also proves the
// NEW token resolves (200), so „old 404s" is discriminating.** The other half of the
// regenerate contract is still „nothing else moves", proven by reading the rows back.
//
// GL-T2 — 19 §UC-GL-002 (the resolver over BOTH token spaces, get-or-create of the
// per-cycle row) + §UC-GL-003 (the pre-open payload) + GuestOrder.vue's MINIMAL
// `preopen-hero` placeholder (GL-T5 replaces it and keeps the testid). Its tests are
// the `GL-T2 ·` describes at the end of this file: throwaway-boot probes that import
// `routes/guest.js`'s pure `listingResponse()`/`resolveEntry()` for the DB states the
// shared target never reaches (NO open round anywhere; no planned round), the API
// matrix against the running server, and a UI pass.
//
// GL-T4 — 19 §UC-GL-007: `GuestSteps.vue` + `GuestRoastersLine.vue` on the OPEN hero
// (compact strip, roasters row, „Viac o tom, ako to funguje" fold). Its tests are the
// `GL-T4 ·` describes at the end: real per-test fixtures, geometry + computed style,
// 320/378px, the CSP request watch, and frontend source pins.
//
// Three kinds of test:
//   §1–§2  THROWAWAY-BOOT probes (the GA-T1 / ML-T1 idiom): `schema.js` and the helper
//          are imported by a child `node` against a temp DB file, so the migration can
//          be proven on a PRE-EXISTING database and the helper can be driven with a
//          scripted RNG — neither is reachable over HTTP.
//   §3–§5  API-level against the running server, fixtures per test (never a shared
//          `beforeAll` fixture — the GSO-T8 worker-restart lesson).
//   §6     source pins over `backend/src` (comments stripped, readability-gated).
//
// NOTE ON RATE LIMITS: friend/admin auth sit on `authLimiter`; run with the raised
// budget (e2e/README.md).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { stripComments } from '../helpers/source-pins.js'
import { BANNED } from '../helpers/vocabulary.js'
import { collectAppCopy } from '../helpers/copy-sweep.js'
import { gotoCycle } from '../helpers/portal.js'

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const SCHEMA_URL = 'file://' + join(BACKEND_SRC, 'db', 'schema.js')
const HELPER_URL = 'file://' + join(BACKEND_SRC, 'helpers', 'standing-link.js')
const GUEST_ROUTES_URL = 'file://' + join(BACKEND_SRC, 'routes', 'guest.js')

// SEC-S2: the standing token comes from `generateGuestToken()` — 14 chars over the
// unambiguous CSPRNG alphabet, exactly like the per-cycle token.
const TOKEN_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{14}$/
// The uniform guest 404 (UC-GL-002 rule 1 / the shipped `resolveLink`).
const GUEST_404 = 'Tento odkaz na objednávku neexistuje'

const INDEX_NAME = 'idx_friends_guest_link_token'
const WAITLIST_INDEX = 'idx_guest_waitlist_host_e164'
const WAITLIST_COLS = [
  'id', 'host_friend_id', 'cycle_id', 'name', 'phone', 'phone_e164',
  'whatsapp_opt_in', 'created_at', 'notified_at',
]

// ═════════════════════════════════════════════════════════════════════════════
// The throwaway-boot probe. A child `node` imports schema.js (and, when asked, the
// helper) with DB_PATH pointed at a temp file, so the SUITE's database is never
// touched. `crypto` is imported FIRST and handed to the body, so a test can script
// `crypto.randomInt` — `schema.js` calls it through the same module object at call
// time, which is the only way to force a token collision on purpose.
// ═════════════════════════════════════════════════════════════════════════════
function probe(dbFile, body, { helper = false, guest = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    "import crypto from 'node:crypto';\n" +
      `import db from '${SCHEMA_URL}';\n` +
      (helper ? `import * as sl from '${HELPER_URL}';\n` : 'const sl = null;\n') +
      // GL-T2: the guest router's pure listing core (`listingResponse`, `resolveEntry`).
      // It imports the SAME schema.js module instance, so `db` below is its database.
      (guest ? `import * as guest from '${GUEST_ROUTES_URL}';\n` : 'const guest = null;\n') +
      `const out = (() => {\n${body}\n})();\n` +
      `console.log('@@PROBE@@' + JSON.stringify(out));\n`
  )
  try {
    const stdout = execFileSync(process.execPath, [script], {
      env: { ...process.env, DB_PATH: dbFile },
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A fresh temp directory per test; the DB file inside it does not exist yet, so the
// first probe CREATES it from scratch.
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'gl-t1-db-'))
  return { file: join(dir, 'gl-t1.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const SHAPE_PROBE = `
  const indexes = (table) => db.all('PRAGMA index_list(' + JSON.stringify(table) + ')').map((i) => ({
    name: i.name,
    unique: i.unique,
    partial: i.partial,
    cols: db.all('PRAGMA index_info(' + JSON.stringify(i.name) + ')').map((c) => c.name),
    sql: (db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?", [i.name]) || {}).sql || null,
  }));
  return {
    friendsCols: db.all('PRAGMA table_info(friends)'),
    friendsIndexes: indexes('friends'),
    waitlistCols: db.all('PRAGMA table_info(guest_waitlist)'),
    waitlistIndexes: indexes('guest_waitlist'),
    waitlistFks: db.all('PRAGMA foreign_key_list(guest_waitlist)'),
  };
`

function byName(rows) {
  return Object.fromEntries(rows.map((r) => [r.name, r]))
}

function expectMigratedShape(shape, label) {
  const col = byName(shape.friendsCols).guest_link_token
  expect(col, `${label}: friends.guest_link_token exists`).toBeTruthy()
  expect(col.type, `${label}: TEXT`).toBe('TEXT')
  expect(col.notnull, `${label}: nullable — NULL means „not minted yet"`).toBe(0)
  expect(col.dflt_value, `${label}: no default (a default would mint the same token for everyone)`).toBe(null)

  const idx = byName(shape.friendsIndexes)[INDEX_NAME]
  expect(idx, `${label}: ${INDEX_NAME} exists`).toBeTruthy()
  expect(idx.unique, `${label}: the index is UNIQUE`).toBe(1)
  expect(idx.cols, `${label}: on the token column alone`).toEqual(['guest_link_token'])

  expect(shape.waitlistCols.map((c) => c.name), `${label}: guest_waitlist columns (19 §UC-GL-004)`).toEqual(WAITLIST_COLS)
  const w = byName(shape.waitlistCols)
  expect(w.host_friend_id.notnull, `${label}: host_friend_id NOT NULL`).toBe(1)
  expect(w.name.notnull, `${label}: name NOT NULL`).toBe(1)
  expect(w.phone.notnull, `${label}: phone NOT NULL`).toBe(1)
  expect(w.phone_e164.notnull, `${label}: phone_e164 nullable (NULL when it does not normalise)`).toBe(0)
  expect(w.cycle_id.notnull, `${label}: cycle_id nullable`).toBe(0)
  expect(w.whatsapp_opt_in.notnull, `${label}: whatsapp_opt_in NOT NULL`).toBe(1)
  expect(w.whatsapp_opt_in.dflt_value, `${label}: whatsapp_opt_in DEFAULT 1`).toBe('1')
  expect(w.notified_at.notnull, `${label}: notified_at nullable (module 21 writes it)`).toBe(0)

  const fks = Object.fromEntries(shape.waitlistFks.map((f) => [f.from, f]))
  expect(fks.host_friend_id?.table, `${label}: host → friends`).toBe('friends')
  expect(fks.host_friend_id?.on_delete, `${label}: a deleted host takes their rows (UC-GL-005 rule 4)`).toBe('CASCADE')
  expect(fks.cycle_id?.table, `${label}: cycle → order_cycles`).toBe('order_cycles')
  expect(fks.cycle_id?.on_delete, `${label}: a deleted cycle only forgets the purge anchor`).toBe('SET NULL')

  const widx = byName(shape.waitlistIndexes)[WAITLIST_INDEX]
  expect(widx, `${label}: ${WAITLIST_INDEX} exists`).toBeTruthy()
  expect(widx.unique, `${label}: UNIQUE`).toBe(1)
  expect(widx.partial, `${label}: PARTIAL`).toBe(1)
  expect(widx.cols, `${label}: (host, e164)`).toEqual(['host_friend_id', 'phone_e164'])
  expect(widx.sql, `${label}: WHERE phone_e164 IS NOT NULL`).toMatch(/WHERE\s+phone_e164\s+IS\s+NOT\s+NULL/i)
}

// Strip GL-T1's output back out of an already-migrated database, so the next boot
// faces exactly the pre-GL-T1 shape every production DB has. The index goes first —
// SQLite refuses to DROP COLUMN a column an index depends on.
function stripGlT1(dbFile) {
  const db = new DatabaseSync(dbFile)
  try {
    db.exec(`DROP INDEX IF EXISTS ${INDEX_NAME}`)
    db.exec('ALTER TABLE friends DROP COLUMN guest_link_token')
    db.exec('DROP TABLE IF EXISTS guest_waitlist')
  } finally {
    db.close()
  }
}

function readShapeRaw(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    return {
      friends: db.prepare('PRAGMA table_info(friends)').all().map((c) => c.name),
      indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    }
  } finally {
    db.close()
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 SCHEMA
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T1 · 19 §UC-GL-001/004 — schema', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a FRESH database gains the column, its unique index and the inert waitlist table; a second boot is a no-op', () => {
    const { file, cleanup } = tempDb()
    try {
      const first = probe(file, SHAPE_PROBE)
      expectMigratedShape(first, 'fresh boot')
      const second = probe(file, SHAPE_PROBE)
      expect(second, 'the second boot changes nothing (idempotent migrations)').toEqual(first)
    } finally {
      cleanup()
    }
  })

  test('⚠ a PRE-EXISTING database (the production case) gains all three on restart, with NO back-fill', () => {
    // ⚠ The criterion that matters: a fresh-DB-only test would still pass if the index
    // were folded into the ALTER's try/catch — on a migrated DB the ALTER throws
    // „duplicate column" and a shared catch skips the CREATE INDEX (the GA-T1 lesson).
    // Here the ALTER SUCCEEDS (the column was stripped), so that is not what this
    // proves; the SECOND boot below is — the column now exists, the ALTER throws, and
    // the index must still come back after being dropped on its own.
    const { file, cleanup } = tempDb()
    try {
      probe(file, 'return null')
      stripGlT1(file)
      const stripped = readShapeRaw(file)
      expect(stripped.friends, 'non-vacuity: the strip really removed the column').not.toContain('guest_link_token')
      expect(stripped.indexes, 'non-vacuity: … and the index').not.toContain(INDEX_NAME)
      expect(stripped.tables, 'non-vacuity: … and the table').not.toContain('guest_waitlist')

      // A friend who exists BEFORE the migration — the population prod is made of.
      const db = new DatabaseSync(file)
      db.exec("INSERT INTO order_cycles (name) VALUES ('GL-T1 pre-migration cycle')")
      const cyc = db.prepare('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').get().id
      db.prepare('INSERT INTO friends (name, cycle_id, access_token) VALUES (?, ?, ?)').run('Pre-migration host', cyc, 'gl-t1-pre')
      db.close()

      const after = probe(file, SHAPE_PROBE)
      expectMigratedShape(after, 'restart on a pre-existing DB')

      const tokens = probe(file, "return db.all('SELECT guest_link_token FROM friends').map((r) => r.guest_link_token)")
      expect(tokens.length, 'non-vacuity: the pre-migration friend is there').toBeGreaterThan(0)
      expect(tokens.every((t) => t === null), 'NO back-fill — a token is minted lazily by the first GET (D1)').toBe(true)

      // The index alone dropped, the column kept: now the ALTER throws „duplicate
      // column" on boot, and the index must STILL be recreated (its own try/catch).
      const db2 = new DatabaseSync(file)
      db2.exec(`DROP INDEX ${INDEX_NAME}`)
      db2.exec(`DROP INDEX ${WAITLIST_INDEX}`)
      db2.close()
      expect(readShapeRaw(file).indexes, 'non-vacuity: both indexes gone').not.toContain(INDEX_NAME)
      const again = probe(file, SHAPE_PROBE)
      expectMigratedShape(again, 'restart with the column present and the indexes missing')
    } finally {
      cleanup()
    }
  })

  test('the indexes do what they claim: NULL tokens coexist, a duplicate token and a duplicate (host, e164) throw', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, `
        db.run("INSERT INTO order_cycles (name, status) VALUES ('p', 'completed')");
        const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
        const mk = (n) => db.run('INSERT INTO friends (name, cycle_id, access_token) VALUES (?, ?, ?)', [n, cyc, 'acc-' + n]).lastInsertRowid;
        const a = mk('a'), b = mk('b'), c = mk('c');
        const codeOf = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code || e.message; } };
        const res = {};
        res.nullsCoexist = db.get('SELECT COUNT(*) AS n FROM friends WHERE guest_link_token IS NULL').n;
        db.run("UPDATE friends SET guest_link_token = 'AAAAAAAAAAAAAA' WHERE id = ?", [a]);
        res.dupToken = codeOf(() => db.run("UPDATE friends SET guest_link_token = 'AAAAAAAAAAAAAA' WHERE id = ?", [b]));
        const w = (host, phone, e164) => codeOf(() => db.run(
          'INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164) VALUES (?, ?, ?, ?)', [host, 'N', phone, e164]));
        res.first = w(a, '0905 123 456', '+421905123456');
        res.dupSameHost = w(a, '+421 905 123 456', '+421905123456');
        res.sameE164OtherHost = w(b, '0905 123 456', '+421905123456');
        res.nullE164a = w(a, 'nonsense', null);
        res.nullE164b = w(a, 'nonsense', null);
        res.rowsA = db.get('SELECT COUNT(*) AS n FROM guest_waitlist WHERE host_friend_id = ?', [a]).n;
        res.defaultOptIn = db.get('SELECT whatsapp_opt_in FROM guest_waitlist WHERE host_friend_id = ? LIMIT 1', [b]).whatsapp_opt_in;
        // FKs: a deleted cycle NULLs the anchor, a deleted host takes their rows.
        // ⚠ The anchor is a SEPARATE cycle: the probe friends hang off \`cyc\` through the
        // legacy \`friends.cycle_id\` FK, which itself CASCADES — deleting \`cyc\` would
        // delete friend b and take the row with it for a reason that is not this FK.
        const anchor = db.run("INSERT INTO order_cycles (name, status) VALUES ('anchor', 'completed')").lastInsertRowid;
        db.run('UPDATE guest_waitlist SET cycle_id = ? WHERE host_friend_id = ?', [anchor, b]);
        res.anchored = db.get('SELECT MAX(cycle_id) AS c FROM guest_waitlist WHERE host_friend_id = ?', [b]).c === anchor;
        db.run('DELETE FROM friends WHERE id = ?', [a]);
        res.afterHostDelete = db.get('SELECT COUNT(*) AS n FROM guest_waitlist WHERE host_friend_id = ?', [a]).n;
        db.run('DELETE FROM order_cycles WHERE id = ?', [anchor]);
        res.afterCycleDelete = db.get('SELECT COUNT(*) AS n, MAX(cycle_id) AS c FROM guest_waitlist WHERE host_friend_id = ?', [b]);
        return res;
      `)
      expect(out.nullsCoexist, 'three unminted friends coexist under the unique index').toBe(3)
      expect(out.dupToken, 'a duplicate standing token is refused by the storage layer').toMatch(/^SQLITE_CONSTRAINT/)
      expect(out.first).toBe('ok')
      expect(out.dupSameHost, 'one row per (host, phone_e164) — the GL-T3 idempotency key').toMatch(/^SQLITE_CONSTRAINT/)
      expect(out.sameE164OtherHost, 'the same person may wait on two hosts').toBe('ok')
      expect(out.nullE164a, 'the index is PARTIAL: un-normalisable phones never collide').toBe('ok')
      expect(out.nullE164b).toBe('ok')
      expect(out.rowsA).toBe(3)
      expect(out.defaultOptIn, 'DEFAULT 1 at the storage layer (the route writes 0 explicitly — PO)').toBe(1)
      expect(out.anchored, 'non-vacuity: the row really pointed at the cycle being deleted').toBe(true)
      expect(out.afterHostDelete, 'ON DELETE CASCADE from friends').toBe(0)
      expect(out.afterCycleDelete, 'ON DELETE SET NULL from order_cycles — the row survives').toEqual({ n: 1, c: null })
    } finally {
      cleanup()
    }
  })

  test('the SHARED database the running server migrated has the column, the index and the table', () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const shape = readShapeRaw(DB_PATH)
    expect(shape.friends).toContain('guest_link_token')
    expect(shape.indexes).toContain(INDEX_NAME)
    expect(shape.indexes).toContain(WAITLIST_INDEX)
    expect(shape.tables).toContain('guest_waitlist')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 THE HELPER — backend/src/helpers/standing-link.js, driven in a throwaway boot
// ═════════════════════════════════════════════════════════════════════════════

// The RNG script: `generateGuestToken()` draws 14 `randomInt(32)` values, and index
// 0/1/2 of `CODE_ALPHABET` is A/B/C — so the scripted sequence yields the tokens
// AAAA…, BBBB…, CCCC… in that order.
const SCRIPTED_RNG = `
  const script = (letters) => {
    const seq = letters.flatMap((i) => Array(14).fill(i));
    let n = 0;
    crypto.randomInt = () => { if (n >= seq.length) throw new Error('RNG script exhausted'); return seq[n++]; };
    return () => n;
  };
  const A = 'AAAAAAAAAAAAAA', B = 'BBBBBBBBBBBBBB', C = 'CCCCCCCCCCCCCC';
  db.run("INSERT INTO order_cycles (name, status) VALUES ('p', 'completed')");
  const cyc = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
  const mk = (n) => db.run('INSERT INTO friends (name, cycle_id, access_token) VALUES (?, ?, ?)', [n, cyc, 'acc-' + n]).lastInsertRowid;
`

test.describe('GL-T1 · 19 §UC-GL-001 — helpers/standing-link.js', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('⚠ uniqueGuestToken() skips a value taken in EITHER token space', () => {
    // The two spaces share one resolver from GL-T2 on (UC-GL-002 rule 1), so a value
    // must be unique across BOTH. With 70 bits of entropy no behavioural test can
    // collide by chance — the RNG is scripted instead. Each half fails a helper that
    // checks only ONE of the two tables.
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, SCRIPTED_RNG + `
        const f1 = mk('one'), f2 = mk('two');
        const res = {};
        // A taken by a STANDING token, B by a PER-CYCLE token.
        db.run('UPDATE friends SET guest_link_token = ? WHERE id = ?', [A, f1]);
        db.run('INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES (?, ?, ?)', [B, f2, cyc]);
        let drawn = script([0, 1, 2]);
        res.first = sl.uniqueGuestToken();
        res.firstDraws = drawn();
        // Swapped: A taken by a PER-CYCLE token, B by a STANDING token.
        db.run('DELETE FROM guest_order_links');
        db.run('UPDATE friends SET guest_link_token = NULL');
        db.run('INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES (?, ?, ?)', [A, f2, cyc]);
        db.run('UPDATE friends SET guest_link_token = ? WHERE id = ?', [B, f1]);
        drawn = script([0, 1, 2]);
        res.second = sl.uniqueGuestToken();
        // Nothing taken: the first draw is used as-is (no needless re-roll).
        db.run('DELETE FROM guest_order_links');
        db.run('UPDATE friends SET guest_link_token = NULL');
        drawn = script([0]);
        res.free = sl.uniqueGuestToken();
        return res;
      `, { helper: true })
      expect(out.first, 'A (standing) and B (per-cycle) both skipped').toBe('CCCCCCCCCCCCCC')
      expect(out.firstDraws, 'three tokens drawn, i.e. the retry really ran twice').toBe(42)
      expect(out.second, 'A (per-cycle) and B (standing) both skipped').toBe('CCCCCCCCCCCCCC')
      expect(out.free).toBe('AAAAAAAAAAAAAA')
    } finally {
      cleanup()
    }
  })

  test('ensureStandingToken() mints ONCE and returns a string; regenerateStandingToken() rotates in place and moves nothing else', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, SCRIPTED_RNG + `
        const f = mk('host'), other = mk('other');
        db.run('INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES (?, ?, ?, 0)', ['LINKTOKENXXXXX', f, cyc]);
        const rowOf = (id) => db.get('SELECT * FROM friends WHERE id = ?', [id]);
        const res = {};
        res.before = rowOf(f);
        script([0, 1, 2]);
        res.e1 = sl.ensureStandingToken(f);
        res.e2 = sl.ensureStandingToken(f);
        res.otherUntouched = rowOf(other).guest_link_token;
        res.r1 = sl.regenerateStandingToken(f);
        res.afterRegen = rowOf(f);
        res.e3 = sl.ensureStandingToken(f);
        res.link = db.get('SELECT token, active FROM guest_order_links WHERE host_friend_id = ?', [f]);
        res.unknownEnsure = sl.ensureStandingToken(999999);
        res.unknownRegen = sl.regenerateStandingToken(999999);
        res.unminted = db.get('SELECT COUNT(*) AS n FROM friends WHERE guest_link_token IS NULL').n;
        res.urlPath = sl.standingUrlPath(res.r1);
        res.urlPathBad = [sl.standingUrlPath(null), sl.standingUrlPath(undefined), sl.standingUrlPath(42), sl.standingUrlPath('')];
        return res;
      `, { helper: true })
      expect(out.before.guest_link_token, 'a fresh friend has no token').toBe(null)
      expect(out.e1, 'the first call mints — and returns the TOKEN STRING (the UC-GL-010 seam: standingUrlPath(ensureStandingToken(id)))').toBe('AAAAAAAAAAAAAA')
      expect(out.e2, 'the second call returns it unchanged — a read never re-mints').toBe('AAAAAAAAAAAAAA')
      expect(out.otherUntouched, 'another friend is not minted as a side effect').toBe(null)
      expect(out.r1, 'regenerate draws a fresh token').toBe('BBBBBBBBBBBBBB')
      const { guest_link_token: _a, ...restBefore } = out.before
      const { guest_link_token: _b, ...restAfter } = out.afterRegen
      expect(restAfter, 'regenerate writes ONE column of the friends row').toEqual(restBefore)
      expect(out.e3, 'ensure after regenerate returns the rotated token').toBe('BBBBBBBBBBBBBB')
      expect(out.link, 'the per-cycle link is untouched — token AND active (UC-GL-002 rule 6)').toEqual({ token: 'LINKTOKENXXXXX', active: 0 })
      expect(out.unknownEnsure, 'an unknown friend → null').toBe(null)
      expect(out.unknownRegen, 'an unknown friend → null').toBe(null)
      expect(out.unminted, '… and neither call wrote anything for it (only `other` is unminted)').toBe(1)
      expect(out.urlPath, 'the ONE composer').toBe('/g/BBBBBBBBBBBBBB')
      expect(out.urlPathBad, 'never „/g/null"').toEqual(['', '', '', ''])
    } finally {
      cleanup()
    }
  })

  test('⚠ rule 1 lives in the helper: an INACTIVE friend is never MINTED a token, but one they already hold is readable and rotatable', () => {
    // 19 §UC-GL-001 rule 1 („Minting requires an ACTIVE host"), GL-T1 review. Held at the
    // one home, so no caller — host route, admin route, module 21's `{odkaz}` — can mint
    // a door for a deactivated host: a fresh token for them is a URL that 410s for every
    // guest (UC-GL-002 rule 3). Rotating an EXISTING one stays allowed: that is
    // revocation, and it matters most for a deactivated host.
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, SCRIPTED_RNG + `
        const blank = mk('blank'), holder = mk('holder');
        db.run('UPDATE friends SET guest_link_token = ? WHERE id = ?', [A, holder]);
        db.run('UPDATE friends SET active = 0 WHERE id IN (?, ?)', [blank, holder]);
        script([1, 2]);
        const tokenOf = (id) => db.get('SELECT guest_link_token FROM friends WHERE id = ?', [id]).guest_link_token;
        const res = {};
        res.blankEnsure = sl.ensureStandingToken(blank);
        res.blankRegen = sl.regenerateStandingToken(blank);
        res.blankGet = sl.standingPayload(blank);
        res.blankPost = sl.regeneratedPayload(blank);
        res.blankAfter = tokenOf(blank);
        res.holderEnsure = sl.ensureStandingToken(holder);
        res.holderGet = sl.standingPayload(holder).payload?.standing;
        res.holderRegen = sl.regenerateStandingToken(holder);
        res.holderAfter = tokenOf(holder);
        res.refusal = sl.STANDING_REFUSALS.inactive_host;
        res.notFound = sl.STANDING_REFUSALS.not_found;
        res.unknownGet = sl.standingPayload(999999);
        // Re-activated, the blank friend mints normally — so the refusals above were
        // rule 1 and nothing else.
        db.run('UPDATE friends SET active = 1 WHERE id = ?', [blank]);
        res.reactivated = sl.standingPayload(blank).payload?.standing;
        return res;
      `, { helper: true })
      expect(out.blankEnsure, 'ensure refuses to mint for an inactive friend').toBe(null)
      expect(out.blankRegen, 'regenerate of a NULL token is a mint — refused too').toBe(null)
      expect(out.blankGet, 'the GET composer answers the refusal').toEqual({ refused: 'inactive_host' })
      expect(out.blankPost, 'the regenerate composer answers the refusal').toEqual({ refused: 'inactive_host' })
      expect(out.blankAfter, 'and nothing was written (read back)').toBe(null)
      expect(out.holderEnsure, 'an inactive friend\'s EXISTING token is still readable').toBe('AAAAAAAAAAAAAA')
      expect(out.holderGet).toEqual({ token: 'AAAAAAAAAAAAAA', url_path: '/g/AAAAAAAAAAAAAA', created: false })
      expect(out.holderRegen, 'and ROTATABLE — revocation').toBe('BBBBBBBBBBBBBB')
      expect(out.holderAfter).toBe('BBBBBBBBBBBBBB')
      expect(out.refusal, 'the 409: the per-cycle admin CREATE\'s key (`reason`, not a new `code`)').toEqual({
        status: 409,
        body: { error: 'Priateľ je deaktivovaný - stály odkaz pre hostí by nefungoval. Najprv ho aktivujte.', reason: 'inactive_host' },
      })
      expect(out.notFound).toEqual({ status: 404, body: { error: 'Priateľ nebol nájdený' } })
      expect(out.unknownGet).toEqual({ refused: 'not_found' })
      expect(out.reactivated, 'non-vacuity: re-activated, the same friend mints').toEqual({ token: 'CCCCCCCCCCCCCC', url_path: '/g/CCCCCCCCCCCCCC', created: true })
    } finally {
      cleanup()
    }
  })

  test('currentOpenCycle() is the NEWEST open cycle of ANY type, null when none, and warns on two', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, `
        const warns = [];
        console.warn = (...a) => warns.push(a.join(' '));
        const res = {};
        res.none = sl.currentOpenCycle();
        db.run("INSERT INTO order_cycles (name, status) VALUES ('planned one', 'planned')");
        db.run("INSERT INTO order_cycles (name, status) VALUES ('locked one', 'locked')");
        res.onlyClosed = sl.currentOpenCycle();
        const older = db.run("INSERT INTO order_cycles (name, status, type) VALUES ('open coffee', 'open', 'coffee')").lastInsertRowid;
        res.one = sl.currentOpenCycle();
        res.warnsAfterOne = warns.length;
        const newer = db.run("INSERT INTO order_cycles (name, status, type) VALUES ('open bakery', 'open', 'bakery')").lastInsertRowid;
        res.two = sl.currentOpenCycle();
        res.ids = { older, newer };
        res.warns = warns;
        return res;
      `, { helper: true })
      expect(out.none, 'no cycle at all').toBe(null)
      expect(out.onlyClosed, 'planned/locked are not „current"').toBe(null)
      expect(out.one).toEqual({ id: out.ids.older, name: 'open coffee', status: 'open' })
      expect(out.warnsAfterOne, 'one open cycle is the normal state — no warning').toBe(0)
      expect(out.two, 'two open ⇒ the NEWEST by id, and NO type filter (a bakery round counts)').toEqual({ id: out.ids.newer, name: 'open bakery', status: 'open' })
      expect(out.warns.length, 'exactly one warn line for the two-open state').toBe(1)
      expect(out.warns[0]).toContain('[standing-link]')
    } finally {
      cleanup()
    }
  })

  test('waitingCount() counts the host\'s OWN rows that are NOT YET NOTIFIED — the real table, inert or not', () => {
    // ⚠ `notified_at IS NULL` (GL-T1 review decision): 19's UC-GL-004 rule 4 re-arms a
    // row by resetting `notified_at` to NULL, UC-GL-010's segment is
    // `WHERE notified_at IS NULL`, and the copy is „N ľudí čaká na váš odkaz" — a
    // person already told is no longer waiting. The rows are INSERTed directly: GL-T3
    // ships the writer, module 21 the `notified_at` stamp.
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, SCRIPTED_RNG + `
        const a = mk('a'), b = mk('b'), c = mk('c');
        const w = (host, phone, e164, notified) => db.run(
          'INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, notified_at) VALUES (?, ?, ?, ?, ?)',
          [host, 'N', phone, e164, notified ? '2026-09-20 10:00:00' : null]);
        w(a, '1', '+421900000001', false);   // waiting
        w(a, '2', null, true);               // told — must NOT count
        w(a, '3', null, false);              // waiting, phone that did not normalise
        w(b, '4', '+421900000004', true);    // b's only row is told
        const before = { a: sl.waitingCount(a), b: sl.waitingCount(b), c: sl.waitingCount(c), unknown: sl.waitingCount(999999) };
        // Re-arming (UC-GL-004 rule 4's UPDATE … notified_at = NULL) brings it back.
        db.run("UPDATE guest_waitlist SET notified_at = NULL WHERE phone = '4'");
        const rearmed = sl.waitingCount(b);
        const rows = db.get('SELECT COUNT(*) AS n FROM guest_waitlist').n;
        return { before, rearmed, rows };
      `, { helper: true })
      expect(out.rows, 'non-vacuity: four rows really exist').toBe(4)
      expect(out.before, 'a: 2 waiting of 3 rows; b: its one row is told; c/unknown: none').toEqual({ a: 2, b: 0, c: 0, unknown: 0 })
      expect(out.rearmed, 're-armed ⇒ waiting again').toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3–§5 API — fixtures
// ═════════════════════════════════════════════════════════════════════════════
let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// FUP-T27 — the ONE admin request path (re-authenticates once on a 401).
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// A friend with a real per-friend Bearer session — the host identity `requireHost()`
// resolves (the guest-link.spec.js pattern, mode-agnostic). ⚠ A phone is set, the
// PI-T10 fixture fact, although no UI login happens here.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gl_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Hostiteľ ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0905 000 111' } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, status = 'open') {
  const name = `E2E GL ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, label) {
  const res = await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `GL Bean ${label} ${uniq}`, purpose: 'Espresso', price_250g: 8 },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function standing(host) {
  const res = await ctx.get('/api/guest-links/standing', { headers: host.auth })
  expect(res.status(), 'host standing GET').toBe(200)
  return res.json()
}

async function regenerate(host, data) {
  const res = await ctx.post('/api/guest-links/standing/regenerate', {
    headers: host.auth,
    ...(data !== undefined ? { data } : {}),
  })
  expect(res.status(), 'host standing regenerate').toBe(200)
  return res.json()
}

async function adminStanding(friendId) {
  const res = await admin(`/api/friends/${friendId}/guest-link/standing`)
  expect(res.status(), 'admin standing GET').toBe(200)
  return res.json()
}

async function adminRegenerate(friendId) {
  const res = await admin(`/api/friends/${friendId}/guest-link/standing/regenerate`, { method: 'post' })
  expect(res.status(), 'admin standing regenerate').toBe(200)
  return res.json()
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'per-cycle link create').toBe(201)
  return (await res.json()).link
}

let phoneSeq = 0
const phoneSeed = String(Date.now()).slice(-7)
async function submitGuest(linkToken, productId, name) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: name,
      guest_phone: `09${phoneSeed}${String(++phoneSeq).padStart(3, '0')}`,
      items: [{ product_id: productId, variant: '250g', quantity: 1 }],
    },
  })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function hostView(host, cycleId) {
  const res = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'host view').toBe(200)
  return res.json()
}

function readRows(sql, ...params) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §3 HOST routes
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T1 · 19 §UC-GL-001 — host GET /api/guest-links/standing', () => {
  test('the first GET mints (created: true), the second returns the same token (created: false) — rule 2', async () => {
    const host = await makeHost('Mint')
    const first = await standing(host)
    expect(Object.keys(first).sort(), 'the payload keys, exactly').toEqual(['current', 'standing', 'waiting_count'])
    expect(Object.keys(first.standing).sort()).toEqual(['created', 'token', 'url_path'])
    expect(first.standing.token).toMatch(TOKEN_RE)
    expect(first.standing.url_path).toBe(`/g/${first.standing.token}`)
    expect(first.standing.created, 'this call minted').toBe(true)
    expect(first.waiting_count, 'an integer count, 0 with nobody waiting').toBe(0)

    const second = await standing(host)
    expect(second.standing.token, 'a read never re-mints').toBe(first.standing.token)
    expect(second.standing.created, 'true ONLY on the call that minted').toBe(false)

    // ⚠ COUNT ONLY (UC-GL-008): the host payload carries no waitlist identities. The
    // key sets are pinned EXACTLY at every level, so a waitlist name or phone has no
    // slot to ride in — `name` exists once, and it is the CYCLE's, inside `current`
    // (UC-GL-001's own shape).
    expect(Object.keys(second).sort()).toEqual(['current', 'standing', 'waiting_count'])
    expect(Object.keys(second.standing).sort()).toEqual(['created', 'token', 'url_path'])
    if (second.current !== null) {
      expect(Object.keys(second.current).sort(), '`current` is {cycle_id, name, status}').toEqual(['cycle_id', 'name', 'status'])
    }
    const text = JSON.stringify(second)
    for (const key of ['"phone"', '"phone_e164"', '"rows"', '"host_name"', '"whatsapp_opt_in"']) {
      expect(text, `no ${key} key anywhere in the standing payload`).not.toContain(key)
    }

    if (DB_PATH) {
      const [row] = readRows('SELECT guest_link_token FROM friends WHERE id = ?', host.id)
      expect(row.guest_link_token, 'the minted token is the stored one').toBe(first.standing.token)
    }
  })

  test('`current` is the newest open cycle {cycle_id, name, status}', async () => {
    const host = await makeHost('Current')
    const cycle = await makeCycle('Current')
    const body = await standing(host)
    // ⚠ This test's cycle is the newest one on the target (it was created last), so it
    // IS „the current round" whatever else is open. The null branch needs a DB with no
    // open cycle at all and is proven in §2's throwaway boot — never by closing the
    // shared target's rounds under other spec files.
    expect(body.current).toEqual({ cycle_id: cycle.id, name: cycle.name, status: 'open' })
  })

  test('two hosts get two different tokens; each only ever sees their own', async () => {
    const a = await makeHost('TwoA')
    const b = await makeHost('TwoB')
    const ta = (await standing(a)).standing.token
    const tb = (await standing(b)).standing.token
    expect(ta).not.toBe(tb)
    expect((await standing(a)).standing.token).toBe(ta)
    expect((await standing(b)).standing.token).toBe(tb)
  })
})

test.describe('GL-T1 · 19 §UC-GL-001 — host POST /api/guest-links/standing/regenerate', () => {
  test('rotates the token in place; the next GET sees it; the old one 404s with the uniform message', async () => {
    const host = await makeHost('Regen')
    const before = (await standing(host)).standing.token
    const body = await regenerate(host)
    expect(Object.keys(body).sort(), 'the payload keys, exactly').toEqual(['regenerated', 'standing', 'waiting_count'])
    expect(Object.keys(body.standing).sort()).toEqual(['token', 'url_path'])
    expect(body.regenerated).toBe(true)
    expect(body.waiting_count).toBe(0)
    expect(body.standing.token).toMatch(TOKEN_RE)
    expect(body.standing.token, 'a NEW token').not.toBe(before)
    expect(body.standing.url_path).toBe(`/g/${body.standing.token}`)

    const after = await standing(host)
    expect(after.standing.token, 'the rotated token is the stored one').toBe(body.standing.token)
    expect(after.standing.created, 'rotation is not a mint').toBe(false)

    // Rule 3 — the old token answers a new visitor the SAME 404 as any unknown one.
    const old = await ctx.get(`/api/guest/${before}`)
    expect(old.status()).toBe(404)
    const garbage = await ctx.get('/api/guest/ZZZZZZZZZZZZZZ')
    expect(garbage.status()).toBe(404)
    const messages = new Set([(await old.json()).error, (await garbage.json()).error])
    expect([...messages], 'one message for every miss — no oracle about which space a string belongs to').toEqual([GUEST_404])

    // GL-T2 — the half that makes the 404 above DISCRIMINATING: the NEW token is a
    // working door (the listing or the pre-open page, whichever state the shared
    // target is in — both are 200), and it is never echoed back.
    const fresh = await ctx.get(`/api/guest/${body.standing.token}`)
    expect(fresh.status(), 'the rotated token resolves').toBe(200)
    expect(await fresh.text(), 'and the guest body never carries it').not.toContain(body.standing.token)
  })

  test('⚠ NOTHING ELSE MOVES: the per-cycle links (token + active), every sub-order and every order_token are byte-identical — host AND admin paths', async () => {
    const host = await makeHost('Identical')
    const open = await makeCycle('Identical A')
    const product = await addProduct(open.id, 'Identical')
    const link = await shareLink(host, open.id)
    const kept = await submitGuest(link.token, product.id, 'Kolega Prvý')
    const gone = await submitGuest(link.token, product.id, 'Kolega Druhý')
    // A CANCELLED sub-order is in the set too — „every sub-order" means every row.
    const del = await ctx.delete(`/api/guest-orders/${gone.order.id}`, { headers: host.auth })
    expect(del.status(), 'host soft-cancel').toBe(200)
    // And a DEACTIVATED per-cycle link on a second round: a regenerate that „helpfully"
    // re-armed the host's links would flip it, and only a row whose `active` is 0 can
    // show that (D4 — the per-cycle flag stays the host's own decision).
    const second = await makeCycle('Identical B')
    const off = await shareLink(host, second.id)
    const patch = await ctx.patch(`/api/guest-links/${off.id}`, { headers: host.auth, data: { active: false } })
    expect(patch.status()).toBe(200)

    const snapshot = async () => ({
      a: await hostView(host, open.id),
      b: await hostView(host, second.id),
      friend: (await (await admin(`/api/friends/${host.id}/detail`)).json()).friend,
      db: DB_PATH ? {
        links: readRows('SELECT * FROM guest_order_links WHERE host_friend_id = ? ORDER BY id', host.id),
        orders: readRows(`SELECT go.* FROM guest_orders go JOIN guest_order_links gl ON gl.id = go.link_id
                          WHERE gl.host_friend_id = ? ORDER BY go.id`, host.id),
        items: readRows(`SELECT gi.* FROM guest_order_items gi JOIN guest_orders go ON go.id = gi.guest_order_id
                         JOIN guest_order_links gl ON gl.id = go.link_id WHERE gl.host_friend_id = ? ORDER BY gi.id`, host.id),
        friendRow: readRows('SELECT * FROM friends WHERE id = ?', host.id).map(({ guest_link_token, ...rest }) => rest),
      } : null,
    })

    const s0 = await standing(host)
    const before = await snapshot()
    // Non-vacuity: the snapshot really holds what the claim is about.
    expect(before.a.link.token, 'the per-cycle link').toBe(link.token)
    expect(before.a.guest_orders.map((o) => o.order_token).sort(), 'both sub-orders, by order_token')
      .toEqual([kept.order.order_token, gone.order.order_token].sort())
    expect(before.a.guest_orders.find((o) => o.id === gone.order.id).status, 'one of them cancelled').toBe('cancelled')
    expect(before.b.link.active, 'the second link is deactivated').toBe(0)

    const viaHost = await regenerate(host)
    expect(viaHost.standing.token).not.toBe(s0.standing.token)
    expect(await snapshot(), 'host regenerate: nothing else moved').toEqual(before)

    const viaAdmin = await adminRegenerate(host.id)
    expect(viaAdmin.standing.token).not.toBe(viaHost.standing.token)
    expect(await snapshot(), 'admin regenerate: nothing else moved (one helper, two guards)').toEqual(before)

    // And the credentials still WORK — a snapshot that matched but 404'd would be
    // byte-identical and broken.
    for (const order of [kept.order, gone.order]) {
      const st = await ctx.get(`/api/guest/o/${order.order_token}`)
      expect(st.status(), `the status URL of sub-order ${order.id} still resolves`).toBe(200)
    }
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'the per-cycle listing still opens').toBe(200)
    expect((await ctx.get(`/api/guest/${off.token}`)).status(), 'the deactivated link stays deactivated').toBe(410)
  })

  test('a body can smuggle nothing: no friend_id, no token — the host is the Bearer session (SEC-A1)', async () => {
    const host = await makeHost('Smuggle')
    const victim = await makeHost('Victim')
    const victimToken = (await standing(victim)).standing.token
    const hostToken = (await standing(host)).standing.token
    const SMUGGLED = 'AAAAAAAAAAAAAA'

    const r1 = await regenerate(host, { friend_id: victim.id, host_friend_id: victim.id, token: SMUGGLED, guest_link_token: SMUGGLED })
    expect(r1.standing.token, 'a fresh token, never the body\'s').not.toBe(SMUGGLED)
    expect(r1.standing.token).not.toBe(hostToken)
    const r2 = await regenerate(host, [victim.id])
    expect(r2.standing.token).not.toBe(r1.standing.token)

    const v = await standing(victim)
    expect(v.standing.token, 'the victim\'s token is untouched (read back)').toBe(victimToken)
    expect(v.standing.created).toBe(false)
  })

  test('refusals write nothing: anonymous, admin token and shared password all 401 — read back', async () => {
    const host = await makeHost('Refuse')
    const token = (await standing(host)).standing.token
    const attempts = [
      ['anonymous', {}],
      ['admin token', { 'X-Admin-Token': adminToken }],
      ['shared password', { 'X-Friends-Password': FRIENDS_PASSWORD }],
      ['garbage Bearer', { Authorization: 'Bearer not-a-session' }],
    ]
    for (const [label, headers] of attempts) {
      const get = await ctx.get('/api/guest-links/standing', { headers })
      expect(get.status(), `GET — ${label}`).toBe(401)
      const post = await ctx.post('/api/guest-links/standing/regenerate', { headers })
      expect(post.status(), `POST regenerate — ${label}`).toBe(401)
      expect(JSON.stringify(await post.json()), `${label}: the refusal carries no token`).not.toContain(token)
    }
    const after = await standing(host)
    expect(after.standing.token, 'no refused call rotated the token').toBe(token)
    expect(after.standing.created).toBe(false)
  })

  test('rule 1 — a DEACTIVATED host can neither read nor rotate (the session dies with the flag)', async () => {
    const host = await makeHost('Inactive')
    const token = (await standing(host)).standing.token
    const off = await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })
    expect(off.status(), 'admin deactivates').toBe(200)

    expect((await ctx.get('/api/guest-links/standing', { headers: host.auth })).status()).toBe(401)
    expect((await ctx.post('/api/guest-links/standing/regenerate', { headers: host.auth })).status()).toBe(401)

    // Read back through the ADMIN route (a read — the token exists, so nothing mints).
    const back = await adminStanding(host.id)
    expect(back.standing.token, 'the refused regenerate wrote nothing').toBe(token)
    expect(back.standing.created).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §4 ADMIN routes (PO 2026-09-19: read + regenerate — one helper, two guards)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T1 · 19 PO block — admin GET/POST /api/friends/:id/guest-link/standing', () => {
  test('the admin read mints lazily like the host\'s, returns the SAME shape, and the host then sees the same token', async () => {
    const host = await makeHost('AdminRead')
    const first = await adminStanding(host.id)
    expect(Object.keys(first).sort()).toEqual(['current', 'standing', 'waiting_count'])
    expect(Object.keys(first.standing).sort()).toEqual(['created', 'token', 'url_path'])
    expect(first.standing.token).toMatch(TOKEN_RE)
    expect(first.standing.created, 'the admin read minted (the host never opened the dialog)').toBe(true)
    expect(first.standing.url_path).toBe(`/g/${first.standing.token}`)
    expect(first.waiting_count).toBe(0)

    const again = await adminStanding(host.id)
    expect(again.standing.token).toBe(first.standing.token)
    expect(again.standing.created).toBe(false)

    const hostSide = await standing(host)
    expect(hostSide.standing.token, 'ONE token per host, whichever guard read it first').toBe(first.standing.token)
    expect(hostSide.standing.created).toBe(false)
  })

  test('the admin regenerate answers the host\'s shape and the host sees the new token', async () => {
    const host = await makeHost('AdminRegen')
    const before = (await standing(host)).standing.token
    const body = await adminRegenerate(host.id)
    expect(Object.keys(body).sort()).toEqual(['regenerated', 'standing', 'waiting_count'])
    expect(Object.keys(body.standing).sort()).toEqual(['token', 'url_path'])
    expect(body.regenerated).toBe(true)
    expect(body.standing.token).toMatch(TOKEN_RE)
    expect(body.standing.token).not.toBe(before)
    expect((await standing(host)).standing.token).toBe(body.standing.token)
  })

  test('⚠ rule 1 — an INACTIVE friend with NO token is never minted one: admin GET and regenerate both 409 inactive_host, read back', async () => {
    // GL-T1 review decision (19 §UC-GL-001 rule 1, „Minting requires an ACTIVE host"),
    // the per-cycle admin CREATE's refusal: a fresh token for a deactivated host is a
    // URL that 410s for every guest. The read-back is API-only (DB_PATH adds a direct
    // one): re-activating and reading again must MINT (`created: true`), which is only
    // possible if neither refused call wrote a token.
    const host = await makeHost('AdminInactiveBlank')
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    for (const [method, path] of [
      ['get', `/api/friends/${host.id}/guest-link/standing`],
      ['post', `/api/friends/${host.id}/guest-link/standing/regenerate`],
    ]) {
      const res = await admin(path, { method })
      expect(res.status(), `${method} ${path}`).toBe(409)
      const body = await res.json()
      expect(body, 'the per-cycle admin CREATE\'s refusal shape').toEqual({
        error: 'Priateľ je deaktivovaný - stály odkaz pre hostí by nefungoval. Najprv ho aktivujte.',
        reason: 'inactive_host',
      })
    }
    if (DB_PATH) {
      const [row] = readRows('SELECT guest_link_token FROM friends WHERE id = ?', host.id)
      expect(row.guest_link_token, 'no token written (read back directly)').toBe(null)
    }

    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: true } })).status()).toBe(200)
    const after = await adminStanding(host.id)
    expect(after.standing.created, 'the first mint happens only now — the refusals wrote nothing').toBe(true)
  })

  test('a DEACTIVATED host\'s EXISTING link can still be rotated by the admin — revocation matters most there', async () => {
    // The per-cycle admin regenerate's precedent (guest-links.js: „NO `inactive_host`
    // gate … refusing it would block the admin from killing a leaked URL belonging to
    // a deactivated host"). Rule 1 refuses MINTING only (the test above); this token
    // existed before the deactivation, so reading it is not a mint and rotating it is
    // revocation. It 410s for guests from GL-T2 on (UC-GL-002 rule 3).
    const host = await makeHost('AdminInactive')
    const before = (await standing(host)).standing.token
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)
    const read = await adminStanding(host.id)
    expect(read.standing.token).toBe(before)
    const rotated = await adminRegenerate(host.id)
    expect(rotated.standing.token).not.toBe(before)
    expect((await adminStanding(host.id)).standing.token).toBe(rotated.standing.token)
  })

  test('unknown friend ⇒ 404 on both; a friend Bearer is not an admin (401) — read back', async () => {
    for (const [method, path] of [
      ['get', '/api/friends/99999991/guest-link/standing'],
      ['post', '/api/friends/99999991/guest-link/standing/regenerate'],
    ]) {
      const res = await admin(path, { method })
      expect(res.status(), `${method} ${path}`).toBe(404)
      expect((await res.json()).error).toBe('Priateľ nebol nájdený')
    }

    const host = await makeHost('AdminGuard')
    const token = (await standing(host)).standing.token
    for (const [method, path] of [
      ['get', `/api/friends/${host.id}/guest-link/standing`],
      ['post', `/api/friends/${host.id}/guest-link/standing/regenerate`],
    ]) {
      const asFriend = await ctx[method](path, { headers: host.auth })
      expect(asFriend.status(), `${method} ${path} with the host's own Bearer`).toBe(401)
      const anon = await ctx[method](path)
      expect(anon.status(), `${method} ${path} anonymously`).toBe(401)
    }
    expect((await standing(host)).standing.token, 'no refused admin call rotated it').toBe(token)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §5 WHERE THE TOKEN MAY NOT GO — guest payloads and every friend payload
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T1 · 19 §UC-GL-001 — the standing token never reaches a guest or a friend payload', () => {
  test('⚠ no /api/guest/* response carries it (the LINK_SELECT rule, invite_code\'s class)', async () => {
    const host = await makeHost('GuestLeak')
    const s = (await standing(host)).standing.token
    const cycle = await makeCycle('GuestLeak')
    const product = await addProduct(cycle.id, 'GuestLeak')
    const link = await shareLink(host, cycle.id)

    const listing = await ctx.get(`/api/guest/${link.token}`)
    expect(listing.status()).toBe(200)
    const listingText = await listing.text()
    // Non-vacuity: this IS the host's live listing.
    expect(listingText, 'the listing names the host').toContain(host.name.split(' ')[0])
    expect(listingText, 'and carries the product').toContain(product.name)

    const submit = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Kolega Tretí', guest_phone: '0905 123 999', items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(submit.status()).toBe(201)
    const submitText = await submit.text()
    const orderToken = JSON.parse(submitText).order.order_token
    const status = await ctx.get(`/api/guest/o/${orderToken}`)
    expect(status.status()).toBe(200)
    const statusText = await status.text()

    for (const [label, text] of [['listing', listingText], ['submit 201', submitText], ['status', statusText]]) {
      expect(text, `${label}: the standing token`).not.toContain(s)
      expect(text, `${label}: the column name`).not.toContain('guest_link_token')
    }
  })

  test('⚠ no friend payload carries it — the friend\'s own profile AND the admin friend surfaces (sanitizeFriend)', async () => {
    const host = await makeHost('FriendLeak')
    const s = (await standing(host)).standing.token
    expect(s, 'non-vacuity: the token exists before the reads below').toMatch(TOKEN_RE)
    if (DB_PATH) {
      const [row] = readRows('SELECT guest_link_token FROM friends WHERE id = ?', host.id)
      expect(row.guest_link_token, 'non-vacuity: `SELECT *` WOULD carry it').toBe(s)
    }

    const profile = await ctx.get(`/api/friends/${host.id}/profile`, { headers: host.auth })
    expect(profile.status()).toBe(200)
    const list = await admin('/api/friends')
    expect(list.status()).toBe(200)
    const detail = await admin(`/api/friends/${host.id}/detail`)
    expect(detail.status()).toBe(200)
    const patched = await admin(`/api/friends/${host.id}`, { method: 'patch', data: { name: host.name } })
    expect(patched.status()).toBe(200)

    const profileBody = await profile.json()
    const listRow = (await list.json()).find((f) => f.id === host.id)
    const detailBody = (await detail.json()).friend
    const patchedBody = await patched.json()
    for (const [label, body] of [
      ['GET /friends/:id/profile (the friend)', profileBody],
      ['GET /friends (admin list)', listRow],
      ['GET /friends/:id/detail (admin)', detailBody],
      ['PATCH /friends/:id (admin)', patchedBody],
    ]) {
      expect(body?.id, `${label}: non-vacuity — the real friend object`).toBe(host.id)
      expect(body, `${label}: no key`).not.toHaveProperty('guest_link_token')
      expect(JSON.stringify(body), `${label}: no value`).not.toContain(s)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §6 SOURCE PINS — backend/src
// ═════════════════════════════════════════════════════════════════════════════
function backendCode(rel) {
  return stripComments(readFileSync(join(BACKEND_SRC, rel), 'utf8'))
}

// Readability gate: the tokens must survive the strip, or an absence pin passes on
// text that was never read (the PI-T3 lesson — see helpers/source-pins.js).
function readableBackend(rel, mustContain) {
  const raw = readFileSync(join(BACKEND_SRC, rel), 'utf8')
  const src = backendCode(rel)
  expect(src.length / raw.length, `${rel}: the comment strip returned almost nothing`).toBeGreaterThan(0.05)
  for (const token of mustContain) expect(src, `${rel}: \`${token}\` must survive the strip`).toContain(token)
  return src
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.js')) out.push(p)
  }
  return out
}

test.describe('GL-T1 · source pins', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('guest-links.js lost its private uniqueToken() and mints per-cycle tokens through uniqueGuestToken()', () => {
    const src = readableBackend('routes/guest-links.js', ["router.post('/cycle/:cycleId'", "router.get('/standing'", 'uniqueGuestToken('])
    expect(src, 'no private generator left').not.toMatch(/function\s+uniqueToken\b/)
    expect(src, 'no call to it either').not.toMatch(/\buniqueToken\s*\(/)
    expect(src, 'nor the raw generator').not.toContain('generateGuestToken')
    expect(src).toMatch(/import\s*\{[^}]*\buniqueGuestToken\b[^}]*\}\s*from\s*'\.\.\/helpers\/standing-link\.js'/)
    // All FOUR per-cycle token writers of the file (host create, host regenerate,
    // admin create, admin regenerate) take their value from the shared helper.
    expect((src.match(/uniqueGuestToken\(\)/g) || []).length, 'four per-cycle token writes, all through the one helper').toBe(4)
  })

  test('the helper is the ONE writer of friends.guest_link_token, and the one generator of guest-link tokens', () => {
    const helper = readableBackend('helpers/standing-link.js', ['export function uniqueGuestToken', 'export function ensureStandingToken', 'export function regenerateStandingToken'])
    const files = walk(BACKEND_SRC)
    expect(files.length, 'non-vacuity: the walk found the backend').toBeGreaterThan(30)
    const writers = []
    const privateGenerators = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/UPDATE\s+friends\s+SET[^;`'"]*\bguest_link_token\b/i.test(code) || /INSERT\s+INTO\s+friends[^;]*\bguest_link_token\b/i.test(code)) {
        writers.push(f.slice(BACKEND_SRC.length + 1))
      }
      if (/function\s+uniqueToken\b/.test(code)) privateGenerators.push(f.slice(BACKEND_SRC.length + 1))
    }
    expect(writers, 'only helpers/standing-link.js writes the column').toEqual(['helpers/standing-link.js'])
    expect((helper.match(/UPDATE\s+friends\s+SET\s+guest_link_token/g) || []).length, 'exactly two statements: ensure + regenerate').toBe(2)
    expect(helper, 'ensure only ever fills a NULL').toMatch(/WHERE\s+id\s*=\s*\?\s+AND\s+guest_link_token\s+IS\s+NULL/)
    expect(privateGenerators, 'no private uniqueToken() anywhere').toEqual([])
  })

  test('⚠ synchronous: no async/await in the helper or the router (the GA-T8 atomicity rule)', () => {
    const helper = readableBackend('helpers/standing-link.js', ['export function currentOpenCycle', 'export function waitingCount'])
    const router = readableBackend('routes/guest-links.js', ["router.post('/standing/regenerate'"])
    for (const [rel, src] of [['helpers/standing-link.js', helper], ['routes/guest-links.js', router]]) {
      expect(src.match(/\basync\b|\bawait\b/g), `${rel}: zero concurrency keywords`).toBe(null)
    }
    // friends.js has async Google handlers of its own, so only the two admin standing
    // handlers are held to it.
    const friends = readableBackend('routes/friends.js', ["router.get('/:id/guest-link/standing'"])
    const start = friends.indexOf("router.get('/:id/guest-link/standing'")
    const end = friends.indexOf("\nrouter.", friends.indexOf("router.post('/:id/guest-link/standing/regenerate'") + 1)
    expect(start, 'the admin GET handler exists').toBeGreaterThan(-1)
    const region = friends.slice(start, end === -1 ? undefined : end)
    expect(region, 'non-vacuity: the region holds both handlers').toContain('/:id/guest-link/standing/regenerate')
    expect(region, 'both admin handlers are requireAdmin').toMatch(/router\.get\('\/:id\/guest-link\/standing',\s*requireAdmin/)
    expect(region).toMatch(/router\.post\('\/:id\/guest-link\/standing\/regenerate',\s*requireAdmin/)
    expect(region.match(/\basync\b|\bawait\b/g), 'the admin standing handlers are synchronous').toBe(null)
  })

  test('⚠ routes/guest.js LINK_SELECT does not select the standing token (same class as invite_code)', () => {
    const src = readableBackend('routes/guest.js', ['const LINK_SELECT', 'host_active'])
    const m = src.match(/const LINK_SELECT = `([\s\S]*?)`;/)
    expect(m, 'LINK_SELECT is still one template literal').toBeTruthy()
    expect(m[1], 'non-vacuity: it is the link SELECT').toContain('gl.token')
    expect(m[1]).not.toContain('guest_link_token')
    expect(m[1], 'nor a star that would sweep it in').not.toMatch(/\bf\.\*/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T2 — 19 §UC-GL-002 (resolveEntry over BOTH token spaces) + §UC-GL-003 (the
// pre-open payload) + the MINIMAL `preopen-hero` placeholder.
//
// ⚠ WHY SO MUCH OF THIS IS A PROBE. „The current round" and „the next planned round"
// are GLOBAL facts, and the shared e2e target always holds many open and planned
// cycles (every spec's `makeCycle`). So „a standing token with NO open round", „no
// planned round ⇒ `unknown`" and „a stale link with nothing open elsewhere" are
// unreachable over HTTP without closing other files' rounds under them. The probes
// import `routes/guest.js`'s pure `listingResponse()` / `resolveEntry()` against a
// throwaway database instead; the HTTP handler's own lines (the `no-store` header,
// the status/body plumbing) are pinned against the running server below.
// ═════════════════════════════════════════════════════════════════════════════

const PREOPEN_KEYS = ['host', 'next', 'page', 'preview', 'stale_cycle', 'waitlist']
// ⚠ RE-POINTED by GP-T7 (PO decision (3) 2026-09-24): + `parcel_enabled` (ADDITIVE —
// the OPEN round's `0|1` for `open_elsewhere`, `null` for every other kind: a planned
// round's flag is the column default, not a decision — orchestrator 2026-09-25).
const NEXT_KEYS = ['cycle_name', 'kind', 'opens_at', 'parcel_enabled', 'plan_note']
// UC-GL-003 rule 4 / acceptance — keys the pre-open body must NEVER carry.
const PREOPEN_FORBIDDEN_KEYS = ['iban', 'revolut_username', 'token', 'invite_code', 'availability', 'guest_link_token', 'payment', 'stock_limit_g']

// A throwaway DB with ONE anchor cycle (friends.cycle_id is the 2024 NOT NULL FK —
// learnings 11 §10: never delete the anchor, it CASCADES the friends away). The
// anchor is `completed` unless a test says otherwise, so it IS „the last round"
// until a newer locked/completed cycle exists.
const GL2_FIXTURE = (anchorStatus = 'completed') => `
  db.run("INSERT INTO order_cycles (name, status) VALUES ('anchor', '${anchorStatus}')");
  const anchor = db.get('SELECT id FROM order_cycles ORDER BY id DESC LIMIT 1').id;
  const mkF = (n, active = 1) => db.run(
    'INSERT INTO friends (name, cycle_id, access_token, active) VALUES (?, ?, ?, ?)', [n, anchor, 'acc-' + n, active]).lastInsertRowid;
  const cyc = (name, status, extra = {}) => db.run(
    'INSERT INTO order_cycles (name, status, opens_at, plan_note, markup_ratio) VALUES (?, ?, ?, ?, ?)',
    [name, status, extra.opens_at ?? null, extra.plan_note ?? null, extra.markup ?? 1.0]).lastInsertRowid;
  const links = (hostId) => db.all('SELECT id, token, cycle_id, active FROM guest_order_links WHERE host_friend_id = ? ORDER BY id', [hostId]);
  const L = (t) => guest.listingResponse(t);
`

test.describe('GL-T2 · 19 §UC-GL-003 — the pre-open payload (throwaway boot)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a STANDING token with no open round ⇒ 200 preopen; `next` walks unknown → planned_note → planned_date (earliest dated first); submit ⇒ 409 closed; nothing is created', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        const host = mkF('Janka Hostiteľová');
        const tok = sl.ensureStandingToken(host);
        const r = {};
        r.none = L(tok);
        const blank = cyc('blank', 'planned');
        r.blank = L(tok);
        db.run('DELETE FROM order_cycles WHERE id = ?', [blank]);
        cyc('note only', 'planned', { plan_note: 'po Vianociach' });
        r.note = L(tok);
        cyc('dated later', 'planned', { opens_at: '2026-11-20' });
        r.dated = L(tok);
        cyc('dated sooner', 'planned', { opens_at: '2026-11-05', plan_note: 'aj poznámka' });
        r.sooner = L(tok);
        // Neither a locked nor a completed cycle is „planned": a newer locked one changes
        // the PREVIEW, never \`next\`.
        cyc('newer locked', 'locked');
        r.afterLocked = L(tok);
        r.submit = guest.resolveEntry(tok, { forSubmit: true });
        r.links = links(host);
        r.tok = tok;
        return r;
      `, { helper: true, guest: true })

      const none = out.none
      expect(none.status).toBe(200)
      expect(Object.keys(none.body).sort(), 'the payload keys, exactly').toEqual(PREOPEN_KEYS)
      expect(none.body.page).toBe('preopen')
      expect(none.body.host, 'first name only (firstName(), the shipped rule)').toEqual({ first_name: 'Janka' })
      expect(Object.keys(none.body.next).sort()).toEqual(NEXT_KEYS)
      expect(none.body.next, 'no planned cycle at all').toEqual({ kind: 'unknown', opens_at: null, plan_note: null, cycle_name: null, parcel_enabled: null })
      expect(none.body.stale_cycle, 'a standing token is never stale (rule 6)').toBe(null)
      expect(none.body.waitlist).toEqual({ available: true })

      expect(out.blank.body.next, 'a planned cycle with neither a date nor a note is still `unknown`')
        .toEqual({ kind: 'unknown', opens_at: null, plan_note: null, cycle_name: 'blank', parcel_enabled: null })
      expect(out.note.body.next).toEqual({ kind: 'planned_note', opens_at: null, plan_note: 'po Vianociach', cycle_name: 'note only', parcel_enabled: null })
      expect(out.dated.body.next, 'a DATED planned cycle beats an undated one with a lower id')
        .toEqual({ kind: 'planned_date', opens_at: '2026-11-20', plan_note: null, cycle_name: 'dated later', parcel_enabled: null })
      expect(out.sooner.body.next, 'the EARLIEST date wins; its plan_note rides along')
        .toEqual({ kind: 'planned_date', opens_at: '2026-11-05', plan_note: 'aj poznámka', cycle_name: 'dated sooner', parcel_enabled: null })
      expect(out.afterLocked.body.next.cycle_name, 'a locked cycle is not „next"').toBe('dated sooner')
      expect(out.afterLocked.body.preview.cycle.name, '…it is the preview').toBe('newer locked')

      // SANCTIONED RETARGET (GL-T7, 19 §UC-GL-011 / 18 §UC-PI-017): the `CLOSED` text lost
      // „v tomto cykle" (PO DRAFT); status and `reason` are byte-identical.
      expect(out.submit, 'rule 5 — the lock-race contract, for the standing space too').toEqual({
        status: 409, error: 'Objednávky sú už uzavreté, objednávku už nie je možné odoslať.', reason: 'closed',
      })
      expect(out.links, 'no open round ⇒ the standing visit created NO per-cycle row').toEqual([])

      for (const r of [out.none, out.note, out.dated, out.sooner]) {
        const text = JSON.stringify(r.body)
        for (const key of PREOPEN_FORBIDDEN_KEYS) expect(text, `no "${key}" key`).not.toContain(`"${key}"`)
        expect(text, 'the standing token is never echoed back').not.toContain(out.tok)
      }
    } finally {
      cleanup()
    }
  })

  test('`preview` = the NEWEST locked/completed cycle, ≤ 12 ACTIVE products, marked up, no availability; null when no round has closed', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        const host = mkF('Peter');
        const tok = sl.ensureStandingToken(host);
        const r = {};
        r.anchorOnly = L(tok).body.preview;
        r.anchor = anchor;
        const ins = db.prepare('INSERT INTO products (cycle_id, name, purpose, price_250g, active, stock_limit_g) VALUES (?, ?, ?, ?, ?, ?)');
        // An OLDER completed cycle WITH products (lower id than the locked one below):
        // it must not win „the newest locked/completed" — and it can, if the predicate
        // or the ordering drifts, because it has something to show.
        const older = cyc('older round', 'completed');
        ins.run(older, 'ZZ older bean', 'Espresso', 8, 1, 500);
        const last = cyc('last round', 'locked', { markup: 1.25 });
        // 13 active (names chosen so the ORDER BY purpose, name is checkable) + 1 inactive.
        for (let i = 0; i < 13; i++) ins.run(last, 'Bean ' + String(i).padStart(2, '0'), i % 2 ? 'Filter' : 'Espresso', 8, 1, 1000);
        ins.run(last, 'AAA hidden', 'Espresso', 8, 0, null);
        r.body = L(tok).body;
        r.last = last;
        return r;
      `, { helper: true, guest: true })
      expect(out.anchorOnly, 'the anchor is the only closed round and it has no products').toEqual({ cycle: { id: out.anchor, name: 'anchor' }, products: [] })
      const pv = out.body.preview
      expect(pv.cycle).toEqual({ id: out.last, name: 'last round' })
      expect(pv.products.length, 'bounded — a public read of historical data').toBe(12)
      expect(pv.products.map((p) => p.name), 'never the inactive product').not.toContain('AAA hidden')
      expect(pv.products.every((p) => p.price_250g === 10), 'withMarkup(): 8 × 1.25, exactly as the live listing').toBe(true)
      const order = pv.products.map((p) => `${p.purpose}|${p.name}`)
      expect(order, 'ORDER BY p.purpose, p.name').toEqual([...order].sort())
      expect(JSON.stringify(out.body), 'no availability anywhere').not.toContain('availability')
      expect(pv.products.map((p) => p.name), 'the OLDER completed round does not leak in').not.toContain('ZZ older bean')
      // Review decision: the stock caps of a closed round are stripped (these rows DO carry
      // stock_limit_g = 1000 in the DB, so the absence is not vacuous).
      expect(pv.products.some((p) => Object.prototype.hasOwnProperty.call(p, 'stock_limit_g')), 'no stock_limit_g on a preview product').toBe(false)
      expect(pv.products.every((p) => Object.prototype.hasOwnProperty.call(p, 'price_250g')), 'non-vacuity: the rows are the priced product rows').toBe(true)

      const nullCase = tempDb()
      try {
        const none = probe(nullCase.file, GL2_FIXTURE('planned') + `
          return L(sl.ensureStandingToken(mkF('Eva'))).body;
        `, { helper: true, guest: true })
        expect(none.preview, 'no locked/completed cycle ⇒ preview null (the page hides the block)').toBe(null)
        expect(none.next.kind).toBe('unknown')
      } finally {
        nullCase.cleanup()
      }
    } finally {
      cleanup()
    }
  })
})

test.describe('GL-T2 · 19 §UC-GL-002 — resolveEntry (throwaway boot)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('standing + open ⇒ GET-OR-CREATE one per-cycle row for THE NEWEST open round; a second visit reuses it; the row\'s token is a fresh one, not the standing token', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        console.warn = () => {};
        const host = mkF('Mária');
        const tok = sl.ensureStandingToken(host);
        const o1 = cyc('open one', 'open');
        const r = {};
        const a = guest.resolveEntry(tok);
        r.a = { kind: a.kind, cycle: a.cycle?.id, link: a.link?.id, token: a.link?.token, host: a.link?.host_friend_id };
        const b = guest.resolveEntry(tok);
        r.b = { kind: b.kind, link: b.link?.id };
        r.afterTwo = links(host);
        const o2 = cyc('open two', 'open');
        const c = guest.resolveEntry(tok, { forSubmit: true });
        r.c = { kind: c.kind, cycle: c.cycle?.id };
        r.afterThree = links(host);
        r.listing = L(tok);
        r.ids = { o1, o2 };
        r.tok = tok;
        r.host = host;
        return r;
      `, { helper: true, guest: true })
      expect(out.a.kind).toBe('order')
      expect(out.a.cycle).toBe(out.ids.o1)
      expect(out.a.host, 'the row is the HOST\'s own').toBe(out.host)
      expect(out.a.token, 'a fresh per-cycle token').toMatch(TOKEN_RE)
      expect(out.a.token, '…never the standing token').not.toBe(out.tok)
      expect(out.b).toEqual({ kind: 'order', link: out.a.link })
      expect(out.afterTwo.map((l) => [l.id, l.cycle_id, l.active]), 'ONE row after two visits').toEqual([[out.a.link, out.ids.o1, 1]])
      expect(out.c, 'two open rounds ⇒ the NEWEST (rule 2), also for a submit').toEqual({ kind: 'order', cycle: out.ids.o2 })
      expect(out.afterThree.length, 'a second round gets its own row').toBe(2)
      expect(out.listing.status).toBe(200)
      expect(out.listing.body.cycle.id, 'the listing is the open round').toBe(out.ids.o2)
      const text = JSON.stringify(out.listing.body)
      expect(text, 'no `token` key in the listing').not.toContain('"token"')
      expect(text, 'no standing token').not.toContain(out.tok)
      expect(text, 'no per-cycle token either — a standing visitor never learns the per-cycle URL').not.toContain(out.afterThree[1].token)
    } finally {
      cleanup()
    }
  })

  test('⚠ the UNIQUE fallthrough: a row that appears between the SELECT and the INSERT is ADOPTED, never a 500', () => {
    // The race is unreachable under `instances: 1` (rule 8), so it is FORCED — at the
    // exact window: the resolver's FIRST (host, cycle) SELECT is made to miss, and the
    // „winner" row is inserted at that moment, so our INSERT then fails
    // `UNIQUE(host_friend_id, cycle_id)` and the resolver must fall through to the
    // re-SELECT and hand back the winner. (`db.prepare` is patched on the shared
    // dbHelpers object, which routes/guest.js reads at call time.) ⚠ A TEMP trigger
    // cannot do this: its INSERT is part of the failing statement and is rolled back
    // WITH it — measured, the first version of this test.
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        const host = mkF('Rýchla');
        const tok = sl.ensureStandingToken(host);
        const open = cyc('race', 'open');
        const realPrepare = db.prepare;
        let armed = true;
        db.prepare = (sql) => {
          if (armed && sql.includes('WHERE gl.host_friend_id = ? AND gl.cycle_id = ?')) {
            armed = false;
            return { get: (h, c) => {
              realPrepare("INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES ('WINNERWINNER22', ?, ?, 1)").run(h, c);
              return undefined;
            } };
          }
          return realPrepare(sql);
        };
        let res;
        try {
          const r = guest.resolveEntry(tok);
          res = { kind: r.kind, token: r.link?.token, status: r.status };
        } catch (e) {
          res = { threw: String(e.message) };
        }
        db.prepare = realPrepare;
        return { res, armedLeft: armed, rows: links(host) };
      `, { helper: true, guest: true })
      expect(out.armedLeft, 'non-vacuity: the forced miss really happened').toBe(false)
      expect(out.res, 'the winner is adopted').toEqual({ kind: 'order', token: 'WINNERWINNER22' })
      expect(out.rows.map((r) => r.token), 'and it is the only row').toEqual(['WINNERWINNER22'])
    } finally {
      cleanup()
    }
  })

  test('the refusals: inactive host ⇒ 410 (nothing created); deactivated round link ⇒ 410 (D4); unknown ⇒ the one 404', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        const off = mkF('Neaktívna');
        const offTok = sl.ensureStandingToken(off);
        db.run('UPDATE friends SET active = 0 WHERE id = ?', [off]);
        const on = mkF('Aktívna');
        const onTok = sl.ensureStandingToken(on);
        const open = cyc('open', 'open');
        const r = {};
        r.inactiveHost = L(offTok);
        r.inactiveHostSubmit = guest.resolveEntry(offTok, { forSubmit: true });
        r.inactiveRows = links(off);
        // The host's own row for the round, deactivated by the host (PATCH active = 0).
        db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES ('ROUNDOFFROUND2', ?, ?, 0)", [on, open]);
        r.roundOff = L(onTok);
        r.roundOffSubmit = guest.resolveEntry(onTok, { forSubmit: true });
        r.roundRows = links(on);
        r.unknown = L('ZZZZZZZZZZZZZZ');
        r.empty = L('');
        return r;
      `, { helper: true, guest: true })
      const INACTIVE = { error: 'Tento odkaz už nie je aktívny. Požiadajte kolegu o nový.', reason: 'inactive' }
      expect(out.inactiveHost).toEqual({ status: 410, body: INACTIVE })
      expect(out.inactiveHostSubmit).toEqual({ status: 410, ...INACTIVE })
      expect(out.inactiveRows, 'a deactivated host\'s standing token opens NO door and writes nothing').toEqual([])
      expect(out.roundOff, 'D4 — the round\'s own flag still decides').toEqual({ status: 410, body: INACTIVE })
      expect(out.roundOffSubmit.status).toBe(410)
      expect(out.roundRows.map((l) => [l.token, l.active]), 'and the standing visit never re-arms it').toEqual([['ROUNDOFFROUND2', 0]])
      expect(out.unknown).toEqual({ status: 404, body: { error: GUEST_404 } })
      expect(out.empty).toEqual({ status: 404, body: { error: GUEST_404 } })
    } finally {
      cleanup()
    }
  })

  test('⚠ D7 — a LEGACY token on a non-open cycle is STALE: preopen with stale_cycle, open_elsewhere when a newer round is open, and it never resolves to (or creates a row on) that round', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        console.warn = () => {};
        const host = mkF('Zuzana Stará');
        const old = cyc('old round', 'open');
        db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id, active) VALUES ('LEGACYLEGACY22', ?, ?, 1)", [host, old]);
        const r = {};
        r.open = guest.resolveEntry('LEGACYLEGACY22').kind;
        db.run("UPDATE order_cycles SET status = 'locked' WHERE id = ?", [old]);
        cyc('coming', 'planned', { opens_at: '2026-12-01' });
        r.lockedNothingOpen = L('LEGACYLEGACY22');
        const newer = cyc('new round', 'open');
        r.lockedNewerOpen = L('LEGACYLEGACY22');
        r.submit = guest.resolveEntry('LEGACYLEGACY22', { forSubmit: true });
        db.run("UPDATE order_cycles SET status = 'planned' WHERE id = ?", [old]);
        r.planned = L('LEGACYLEGACY22');
        r.rows = links(host);
        r.ids = { old, newer };
        return r;
      `, { helper: true, guest: true })
      expect(out.open, 'while its cycle is open the legacy link is the shipped order page').toBe('order')

      const a = out.lockedNothingOpen
      expect(a.status).toBe(200)
      expect(a.body.page).toBe('preopen')
      expect(a.body.stale_cycle, 'rule 6 — {id, name} only').toEqual({ id: out.ids.old, name: 'old round' })
      expect(a.body.next, 'nothing open elsewhere ⇒ the planned round, like a standing token').toEqual({ kind: 'planned_date', opens_at: '2026-12-01', plan_note: null, cycle_name: 'coming', parcel_enabled: null })
      expect(a.body.waitlist.available).toBe(true)

      const b = out.lockedNewerOpen
      expect(b.status).toBe(200)
      expect(b.body.page).toBe('preopen')
      expect(b.body.next, 'open_elsewhere: the OPEN round\'s name, no date, no note').toEqual({ kind: 'open_elsewhere', opens_at: null, plan_note: null, cycle_name: 'new round', parcel_enabled: 0 })
      expect(b.body.waitlist, 'no contacts for a round already in progress').toEqual({ available: false })
      expect(b.body.stale_cycle).toEqual({ id: out.ids.old, name: 'old round' })
      expect(JSON.stringify(b.body), 'NEVER the newer round\'s catalogue').not.toContain(`"cycle":{"id":${out.ids.newer}`)

      expect(out.submit.status, 'submit through a stale link ⇒ 409 closed').toBe(409)
      expect(out.submit.reason).toBe('closed')
      expect(out.planned.body.page, 'planned counts as not open too').toBe('preopen')
      expect(out.rows.map((r) => r.cycle_id), 'the legacy token created NOTHING on the newer round').toEqual([out.ids.old])
    } finally {
      cleanup()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T2 · API against the running server — one token/fixture per matrix row (the
// cached-410 lesson), and every write claim read back.
// ═════════════════════════════════════════════════════════════════════════════
async function adminLinksFor(cycleId, hostId) {
  const res = await admin(`/api/guest-links/cycle/${cycleId}/all`)
  expect(res.status(), 'admin link list').toBe(200)
  return (await res.json()).links.filter((l) => l.host_friend_id === hostId)
}

function sqliteTs(value) {
  // `created_at` is SQLite CURRENT_TIMESTAMP — UTC, second resolution, no zone.
  return Date.parse(String(value).replace(' ', 'T') + 'Z')
}

test.describe('GL-T2 · 19 §UC-GL-002 — the resolver matrix over HTTP', () => {
  test('standing + open round ⇒ 200 listing of THAT round, no token in the body, no-store; the host then sees a row created by the visit; a second visit adds none', async () => {
    const host = await makeHost('GoOpen')
    const s = (await standing(host)).standing.token
    // Created last ⇒ the newest open cycle on the target ⇒ „the current round".
    const cycle = await makeCycle('GoOpen')
    const product = await addProduct(cycle.id, 'GoOpen')
    expect((await adminLinksFor(cycle.id, host.id)), 'non-vacuity: no row before the visit').toEqual([])

    const before = Math.floor(Date.now() / 1000) * 1000
    const res = await ctx.get(`/api/guest/${s}`)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control'], 'rule 5 — the live listing is no-store too').toContain('no-store')
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.cycle.id, 'the open round').toBe(cycle.id)
    expect(body.products.map((p) => p.id)).toContain(product.id)
    expect(body.host.first_name, 'the host\'s first name').toBe(host.name.split(' ')[0])
    expect(body).not.toHaveProperty('page')
    expect(text, 'no `token` key anywhere').not.toContain('"token"')
    expect(text, 'the standing token is never echoed').not.toContain(s)

    const view = await hostView(host, cycle.id)
    expect(view.link, 'the host now HAS a per-cycle link for the round').toBeTruthy()
    expect(sqliteTs(view.link.created_at), 'created by the visit').toBeGreaterThanOrEqual(before)
    expect(text, 'and the listing never carried ITS token').not.toContain(view.link.token)

    expect((await ctx.get(`/api/guest/${s}`)).status()).toBe(200)
    const rows = await adminLinksFor(cycle.id, host.id)
    expect(rows.map((l) => l.id), 'a second visit creates no second row').toEqual([view.link.id])
  })

  test('standing reuses the row the HOST already created — same id, same token, same active flag', async () => {
    const host = await makeHost('GoReuse')
    const cycle = await makeCycle('GoReuse')
    await addProduct(cycle.id, 'GoReuse')
    const own = await shareLink(host, cycle.id)
    const s = (await standing(host)).standing.token
    expect((await ctx.get(`/api/guest/${s}`)).status()).toBe(200)
    const rows = await adminLinksFor(cycle.id, host.id)
    expect(rows.map((l) => [l.id, l.token, l.active])).toEqual([[own.id, own.token, 1]])
  })

  test('a sub-order submitted through the STANDING URL lands under the host\'s per-cycle row: host view, status URL, and stock (helpers/stock.js) all see it', async () => {
    const host = await makeHost('GoSubmit')
    const s = (await standing(host)).standing.token
    const cycle = await makeCycle('GoSubmit')
    const pr = await admin('/api/products', {
      method: 'post',
      data: { cycle_id: cycle.id, name: `GL2 Limited ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 1000 },
    })
    expect(pr.status()).toBe(201)
    const product = await pr.json()

    // No page load first: the SUBMIT gets-or-creates the row too.
    const created = await submitGuest(s, product.id, 'Kolega Stály')
    expect(created.status_path).toBe(`/g/o/${created.order.order_token}`)
    expect(JSON.stringify(created), 'the 201 carries no link token').not.toContain(s)

    const view = await hostView(host, cycle.id)
    expect(view.guest_orders.map((o) => o.id), 'the host view lists it').toEqual([created.order.id])
    expect((await ctx.get(`/api/guest/o/${created.order.order_token}`)).status(), 'the status URL resolves').toBe(200)

    const listing = await (await ctx.get(`/api/guest/${s}`)).json()
    const a = listing.availability.find((x) => x.product_id === product.id)
    expect(a, 'the product is stock-limited').toBeTruthy()
    expect(a.ordered_g, 'the guest grams are counted (stock UNION own+guest)').toBe(250)
    expect(a.remaining_g).toBe(750)
    // …and through the per-cycle token the host view publishes, the SAME numbers.
    const viaLink = await (await ctx.get(`/api/guest/${view.link.token}`)).json()
    expect(viaLink.availability.find((x) => x.product_id === product.id)).toEqual(a)
  })

  test('standing + the round\'s link DEACTIVATED by the host ⇒ 410 inactive (D4) — the listing and the submit, no-store, and the flag stays 0', async () => {
    const host = await makeHost('GoRoundOff')
    const cycle = await makeCycle('GoRoundOff')
    const product = await addProduct(cycle.id, 'GoRoundOff')
    const own = await shareLink(host, cycle.id)
    expect((await ctx.patch(`/api/guest-links/${own.id}`, { headers: host.auth, data: { active: false } })).status()).toBe(200)
    const s = (await standing(host)).standing.token

    const res = await ctx.get(`/api/guest/${s}`)
    expect(res.status()).toBe(410)
    expect(res.headers()['cache-control'], 'refusals are no-store too').toContain('no-store')
    expect(await res.json()).toEqual({ error: 'Tento odkaz už nie je aktívny. Požiadajte kolegu o nový.', reason: 'inactive' })
    const sub = await ctx.post(`/api/guest/${s}/orders`, {
      data: { guest_name: 'Kolega', guest_phone: '0905 111 222', items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(sub.status()).toBe(410)
    const rows = await adminLinksFor(cycle.id, host.id)
    expect(rows.map((l) => [l.id, l.active]), 'read back: still the one row, still deactivated').toEqual([[own.id, 0]])
    expect((await hostView(host, cycle.id)).guest_orders, 'and no sub-order was written').toEqual([])
  })

  test('a DEACTIVATED host\'s standing token ⇒ 410 inactive, and the visit creates no row — read back', async () => {
    const host = await makeHost('GoHostOff')
    const s = (await standing(host)).standing.token
    const cycle = await makeCycle('GoHostOff')
    await addProduct(cycle.id, 'GoHostOff')
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const res = await ctx.get(`/api/guest/${s}`)
    expect(res.status()).toBe(410)
    expect((await res.json()).reason).toBe('inactive')
    expect(await adminLinksFor(cycle.id, host.id), 'no door, no row').toEqual([])
    // Non-vacuity: re-activate and the same token opens (and only NOW creates) the row.
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: true } })).status()).toBe(200)
    expect((await ctx.get(`/api/guest/${s}`)).status()).toBe(200)
    expect((await adminLinksFor(cycle.id, host.id)).length).toBe(1)
  })

  test('⚠ D7 — a legacy link on a LOCKED cycle while a newer round is open ⇒ 200 preopen `open_elsewhere` + stale_cycle, no waitlist, no-store; it creates nothing on the newer round; submit ⇒ 409 closed', async () => {
    const host = await makeHost('GoStale')
    const old = await makeCycle('GoStale old')
    const product = await addProduct(old.id, 'GoStale')
    const link = await shareLink(host, old.id)
    expect((await admin(`/api/cycles/${old.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    const newer = await makeCycle('GoStale new')

    const res = await ctx.get(`/api/guest/${link.token}`)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toContain('no-store')
    const text = await res.text()
    const body = JSON.parse(text)
    expect(Object.keys(body).sort()).toEqual(PREOPEN_KEYS)
    expect(body.page).toBe('preopen')
    expect(body.stale_cycle).toEqual({ id: old.id, name: old.name })
    expect(body.next).toEqual({ kind: 'open_elsewhere', opens_at: null, plan_note: null, cycle_name: newer.name, parcel_enabled: 0 })
    expect(body.waitlist).toEqual({ available: false })
    expect(body.host).toEqual({ first_name: host.name.split(' ')[0] })
    for (const key of PREOPEN_FORBIDDEN_KEYS) expect(text, `no "${key}" key`).not.toContain(`"${key}"`)
    expect(text, 'the legacy token is not echoed').not.toContain(link.token)

    expect(await adminLinksFor(newer.id, host.id), 'the legacy token never resolves to — or creates a row on — the newer round').toEqual([])
    const sub = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Kolega', guest_phone: '0905 111 333', items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(sub.status()).toBe(409)
    expect((await sub.json()).reason).toBe('closed')
    // Read back: the refused submit wrote no sub-order — on the stale round or the newer one.
    const oldView = await hostView(host, old.id)
    expect(oldView.link?.id, 'non-vacuity: the host view is the legacy link').toBe(link.id)
    expect(oldView.guest_orders, 'no sub-order on the stale round').toEqual([])
    expect((await hostView(host, newer.id)).guest_orders, 'nor on the newer round').toEqual([])
  })

  test('the pre-open `preview` over HTTP: the newest closed round, ≤ 12 products, marked-up prices, no availability', async () => {
    const host = await makeHost('GoPreview')
    const cycle = await makeCycle('GoPreview')
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.25 } })).status()).toBe(200)
    for (let i = 0; i < 13; i++) await addProduct(cycle.id, `Prev${String(i).padStart(2, '0')}`)
    const link = await shareLink(host, cycle.id)
    // Locked LAST ⇒ the newest locked/completed cycle on the target ⇒ the preview.
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

    const body = await (await ctx.get(`/api/guest/${link.token}`)).json()
    expect(body.page).toBe('preopen')
    expect(body.preview.cycle).toEqual({ id: cycle.id, name: cycle.name })
    expect(body.preview.products.length).toBe(12)
    expect(body.preview.products.every((p) => p.price_250g === 10), '8 × 1.25').toBe(true)
    expect(body).not.toHaveProperty('availability')
  })

  test('uniform 404 — garbage, a RETIRED per-cycle token and a RETIRED standing token answer one message (no oracle about the space)', async () => {
    const host = await makeHost('Go404')
    const cycle = await makeCycle('Go404')
    await addProduct(cycle.id, 'Go404')
    const link = await shareLink(host, cycle.id)
    // The host's second POST on the same round regenerates the per-cycle token in place.
    const reg = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect(reg.status(), 'per-cycle regenerate').toBe(200)
    expect((await reg.json()).regenerated, 'non-vacuity: it really rotated').toBe(true)
    const oldStanding = (await standing(host)).standing.token
    const fresh = (await regenerate(host)).standing.token

    const answers = []
    for (const t of ['ZZZZZZZZZZZZZZ', link.token, oldStanding]) {
      const r = await ctx.get(`/api/guest/${t}`)
      expect(r.status(), t).toBe(404)
      expect(r.headers()['cache-control']).toContain('no-store')
      answers.push(JSON.stringify(await r.json()))
    }
    expect(new Set(answers).size, 'one body for every miss').toBe(1)
    expect(JSON.parse(answers[0])).toEqual({ error: GUEST_404 })
    // Non-vacuity: the live tokens of both spaces DO resolve.
    expect((await ctx.get(`/api/guest/${(await reg.json()).link.token}`)).status()).toBe(200)
    expect((await ctx.get(`/api/guest/${fresh}`)).status()).toBe(200)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T2 · UI — the MINIMAL `preopen-hero` placeholder (GL-T5 replaces the content
// and KEEPS the testid). The kind-specific sentences are driven by a fulfilled
// payload, because the shared target's kind is not ours to choose (see above); one
// test runs against the real server.
// ═════════════════════════════════════════════════════════════════════════════
const GL2_PHONE = { width: 378, height: 900 }
const GL2_PHONE_320 = { width: 320, height: 900 }

function preopenBody(next, extra = {}) {
  return {
    page: 'preopen',
    host: { first_name: 'Janka' },
    // GP-T7: + `parcel_enabled: null` — the server's shape (NEXT_KEYS) for a round-less `next`.
    next: { opens_at: null, plan_note: null, cycle_name: null, parcel_enabled: null, ...next },
    stale_cycle: null,
    preview: null,
    waitlist: { available: next.kind !== 'open_elsewhere' },
    ...extra,
  }
}

test.describe('GL-T2 · GuestOrder.vue — the preopen-hero placeholder', () => {
  test('a legacy link on a LOCKED cycle renders the preopen hero, NOT the dead card, and nothing orderable', async ({ page }) => {
    const host = await makeHost('UiStale')
    const cycle = await makeCycle('UiStale')
    await addProduct(cycle.id, 'UiStale')
    const link = await shareLink(host, cycle.id)
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    const api = await (await ctx.get(`/api/guest/${link.token}`)).json()
    expect(api.page, 'non-vacuity: the server answers the pre-open payload').toBe('preopen')

    await page.setViewportSize(GL2_PHONE)
    await page.goto(`/g/${link.token}`)
    const hero = page.getByTestId('preopen-hero')
    await expect(hero).toBeVisible()
    await expect(hero.locator('.badge')).toHaveText('Zatvorené')
    // Which headline depends on the shared target's state (is a newer round open?),
    // so it is read off the payload the page itself received.
    const stale = api.next.kind === 'open_elsewhere'
    await expect(hero.locator('h1')).toHaveText(stale ? 'Táto objednávka je už uzavretá' : 'Objednávky sú zatvorené')
    await expect(hero).toContainText(host.name.split(' ')[0])
    await expect(page.getByTestId('guest-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('open-checkout')).toHaveCount(0)
    await expect(page.getByTestId('cartbar')).toHaveCount(0)
    expect(await page.content(), 'the token is never composed into the DOM').not.toContain(link.token)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('the four `next` sentences: planned_date (module 17 long date), planned_note (verbatim), unknown, open_elsewhere (name twice, no gendered pronoun)', async ({ page }) => {
    await page.setViewportSize(GL2_PHONE)
    const TOKEN = 'PREOPENMOCKED2'
    const cases = [
      // GL-T5 retarget: a PAST `opens_at` — ~~GL-T5's `weeksAwayLabel()`~~ `inWeeksText()`
      // (GP-T7, PO decision (4)) adds „(o N dní/týždňov)" to a FUTURE one, so a fixed calendar date would change this sentence with the
      // wall clock. A past date omits the parenthesis (19 §UC-GL-006 item 2) and keeps
      // GL-T2's exact sentence; the parenthesis is pinned by the GL-T5 describes.
      [preopenBody({ kind: 'planned_date', opens_at: '2020-10-03', cycle_name: 'X' }), 'Objednávky sú zatvorené', 'Ďalšia objednávka sa otvorí približne 3. októbra.'],
      [preopenBody({ kind: 'planned_note', plan_note: 'po Vianociach', cycle_name: 'X' }), 'Objednávky sú zatvorené', 'Ďalšia objednávka: po Vianociach'],
      [preopenBody({ kind: 'unknown' }), 'Objednávky sú zatvorené', 'O ďalšej objednávke dáme vedieť.'],
      [preopenBody({ kind: 'open_elsewhere', cycle_name: 'Nové' }, { stale_cycle: { id: 1, name: 'Staré' } }), 'Táto objednávka je už uzavretá', 'Janka má práve otvorenú novú objednávku. Požiadajte Janka o aktuálny odkaz.'],
    ]
    for (const [body, title, sentence] of cases) {
      await page.unroute(`**/api/guest/${TOKEN}`)
      await page.route(`**/api/guest/${TOKEN}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
      await page.goto(`/g/${TOKEN}`)
      const hero = page.getByTestId('preopen-hero')
      await expect(hero.locator('h1'), body.next.kind).toHaveText(title)
      await expect(page.getByTestId('preopen-next'), body.next.kind).toHaveText(sentence)
      if (body.next.kind !== 'open_elsewhere') await expect(hero).toContainText('Janka vás pozýva do spoločnej objednávky výberovej kávy.')
      // The ONE vocabulary regex (PI-T11), rendered. ~~The guest files are not in the
      // friend source guard yet (GL-T7)~~ — they are since GL-T7 (`portal-vocabulary.spec.js`
      // §6); this rendered check stays as the composed-sentence half.
      expect(await hero.innerText(), 'no „cyklus"/„kolo" in the new guest copy').not.toMatch(BANNED)
    }
  })

  test('no horizontal overflow at 320px, for the two longest sentences and a long host name', async ({ page }) => {
    await page.setViewportSize(GL2_PHONE_320)
    const TOKEN = 'PREOPENMOCKED320'
    const longHost = { first_name: 'Alžbeta-Kristínamária Novosadová' }
    const cases = [
      // planned_date's sentence is the longest of the three non-stale variants.
      preopenBody({ kind: 'planned_date', opens_at: '2026-10-03', cycle_name: 'X' }, { host: longHost }),
      // open_elsewhere repeats the host name twice in one sentence.
      preopenBody({ kind: 'open_elsewhere', cycle_name: 'Nové' }, { host: longHost, stale_cycle: { id: 1, name: 'Staré' } }),
    ]
    for (const body of cases) {
      await page.unroute(`**/api/guest/${TOKEN}`)
      await page.route(`**/api/guest/${TOKEN}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
      await page.goto(`/g/${TOKEN}`)
      await expect(page.getByTestId('preopen-hero')).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        body.next.kind,
      ).toBeLessThanOrEqual(0)
    }
  })

  test('the dead card still renders for 404 and 410 inactive (§UC-GL-006 business rules)', async ({ page }) => {
    await page.setViewportSize(GL2_PHONE)
    await page.goto('/g/NOTAREALTOKEN22')
    await expect(page.getByTestId('guest-unavailable')).toContainText('Odkaz neexistuje')
    await expect(page.getByTestId('preopen-hero')).toHaveCount(0)

    const host = await makeHost('UiDead')
    const s = (await standing(host)).standing.token
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)
    await page.goto(`/g/${s}`)
    await expect(page.getByTestId('guest-unavailable')).toContainText('Odkaz už nie je aktívny')
    await expect(page.getByTestId('preopen-hero')).toHaveCount(0)
  })

  test('a STANDING link with an open round renders the ordinary order page (the shipped hero + cartbar)', async ({ page }) => {
    const host = await makeHost('UiOpen')
    const s = (await standing(host)).standing.token
    const cycle = await makeCycle('UiOpen')
    await addProduct(cycle.id, 'UiOpen')
    await page.setViewportSize(GL2_PHONE)
    await page.goto(`/g/${s}`)
    await expect(page.getByRole('heading', { name: cycle.name })).toBeVisible()
    await expect(page.getByTestId('open-checkout')).toBeVisible()
    await expect(page.getByTestId('preopen-hero')).toHaveCount(0)
  })
})

test.describe('GL-T2 · source pins', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('the standing lookup lives in resolveEntry (a lookup, never a SELECTed column), resolveLink is gone, and the per-cycle mint goes through uniqueGuestToken()', () => {
    const src = readableBackend('routes/guest.js', ['function resolveEntry', 'function getOrCreateCycleLink', "res.set('Cache-Control', 'no-store')"])
    expect(src, 'the replaced resolver is gone').not.toMatch(/function\s+resolveLink\b/)
    expect((src.match(/guest_link_token/g) || []).length, 'exactly ONE mention: the WHERE of the lookup').toBe(1)
    expect(src).toMatch(/SELECT id, name, active FROM friends WHERE guest_link_token = \?/)
    expect(src, 'the get-or-create INSERT takes its token from the shared helper').toMatch(/INSERT INTO guest_order_links[^;]*\)\s*\.run\(uniqueGuestToken\(\)/)
    expect(src.match(/\basync\b|\bawait\b/g), 'still zero concurrency keywords (UC-GR-011, rule 8)').toBe(null)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T4 · 19 §UC-GL-007 — the 3-step guest explainer on the OPEN hero
// ═════════════════════════════════════════════════════════════════════════════
//
// `GuestSteps.vue` (compact / full, `packeta` default OFF) + `GuestRoastersLine.vue`
// (imports `lib/roasters.js`) + the open hero's strip, roasters row and „Viac o tom,
// ako to funguje" toggle. The pre-open page's FULL mount is GL-T5's (it reuses both
// components); these tests measure the open hero only.
//
// ⚠ TWO CANON DEVIATIONS are pinned here, not merely recorded: the step dot is not
// `.mono` and the roaster badges are not `.badge`, because `guest-order-shell.spec.js`
// (UNMODIFIED, 19 §UC-GL-011 item 2) counts `hero.locator('.badge')` = 3 and resolves
// `hero.locator('.mono')` strictly. The tests below prove BOTH halves: the shipped
// counts still hold with the fold OPEN (the worst case), and the substitutes are
// computed-style-equal to the real classes, so the deviation is a selector, not pixels.
const GL4_STEPS = ['Objednáte', 'Zabalíme', 'Prevezmete']
const GL4_DETAILS = [
  'Vyberiete kávu, zadáte meno a mobil. Bez registrácie.',
  'Kávu nakúpime v pražiarni a zabalíme. Vtedy zaplatíte cez QR alebo Revolut.',
]
const GL4_TOGGLE_OPEN = 'Viac o tom, ako to funguje'
const GL4_TOGGLE_CLOSE = 'Skryť'
const GL4_ROASTERS_LIB = join(REPO_ROOT, 'frontend', 'src', 'lib', 'roasters.js')
const FRONTEND_SRC_DIR = join(REPO_ROOT, 'frontend', 'src')
const HAS_FRONTEND_SRC = existsSync(join(FRONTEND_SRC_DIR, 'views', 'GuestOrder.vue'))
const NEEDS_FRONTEND_SRC = 'needs the frontend source beside e2e/ (skipped against a deployment)'

// One hermetic OPEN link per test: its own host, cycle (Goriffee + Robo products) and
// per-cycle token. Returns what the page needs to be asserted against.
async function gl4OpenPage(page, label, viewport = GL2_PHONE, { expectedDate = null } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label)
  if (expectedDate) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { expected_date: expectedDate } })).status()).toBe(200)
  }
  for (const roastery of ['Goriffee', 'Robo']) {
    const res = await admin('/api/products', {
      method: 'post',
      data: { cycle_id: cycle.id, name: `GL4 ${roastery} ${label} ${uniq}`, purpose: 'Espresso', roastery, price_250g: 9 },
    })
    expect(res.status(), 'product create').toBe(201)
  }
  const link = await shareLink(host, cycle.id)
  await page.setViewportSize(viewport)
  await page.goto(`/g/${link.token}`)
  const hero = page.locator('.app .card.hl')
  await expect(hero.locator('h1.h-screen')).toHaveText(cycle.name)
  return { host, cycle, link, hero, first: host.name.split(' ')[0] }
}

const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('GL-T4 · 19 §UC-GL-007 — the open hero: compact strip, roasters row, toggle', () => {
  test('the compact strip sits inside the hero, BELOW the „organizuje" line and ABOVE the badge row — three titles, numbered, one glyph each, no details', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'Strip')
    const strip = hero.getByTestId('guest-steps-compact')
    await expect(strip).toHaveCount(1)
    await expect(strip.getByTestId('guest-step')).toHaveCount(3)
    await expect(strip.getByTestId('guest-step-title')).toHaveText(GL4_STEPS)
    await expect(strip.getByTestId('guest-step-n')).toHaveText(['1', '2', '3'])
    for (let i = 0; i < 3; i++) {
      // An unknown NeoIcon name renders NOTHING, silently — so each glyph is counted.
      await expect(strip.getByTestId('guest-step').nth(i).locator('svg'), `step ${i + 1} glyph`).toHaveCount(1)
    }
    await expect(strip.getByTestId('guest-step-detail'), 'compact = titles only').toHaveCount(0)

    // Order, by DOM position AND by geometry (a CSS `order` could lie about one).
    const order = await hero.evaluate((el) => {
      const sub = [...el.querySelectorAll('.sub')].find((n) => n.textContent.includes('Spoločná objednávka · organizuje'))
      const strip = el.querySelector('[data-testid="guest-steps-compact"]')
      const roasters = el.querySelector('[data-testid="guest-roasters"]')
      const badge = el.querySelector('.badge')
      const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      const r = (n) => n.getBoundingClientRect()
      return {
        found: [sub, strip, roasters, badge].every(Boolean),
        dom: [before(sub, strip), before(strip, roasters), before(roasters, badge)],
        geo: [r(sub).bottom <= r(strip).top, r(strip).bottom <= r(roasters).top, r(roasters).bottom <= r(badge).top],
        badgeText: badge.textContent.trim(),
      }
    })
    expect(order.found, 'all four landmarks are in the hero').toBe(true)
    expect(order.badgeText, 'the first `.badge` is the shipped row, not a roaster').toBe('Login netreba')
    expect(order.dom, 'organizuje → strip → roasters → badge row, in the DOM').toEqual([true, true, true])
    expect(order.geo, '…and on screen').toEqual([true, true, true])

    // Compact geometry: one ROW (same top), left to right, 34px tiles, 14px titles.
    const geo = await strip.evaluate((el) => [...el.querySelectorAll('[data-testid="guest-step"]')].map((s) => {
      const tile = s.firstElementChild.getBoundingClientRect()
      const title = s.querySelector('[data-testid="guest-step-title"]')
      return { top: Math.round(tile.top), left: tile.left, w: tile.width, h: tile.height, fs: getComputedStyle(title).fontSize }
    }))
    expect(new Set(geo.map((g) => g.top)).size, 'three columns on one row').toBe(1)
    expect(geo[0].left < geo[1].left && geo[1].left < geo[2].left).toBe(true)
    for (const g of geo) {
      expect([g.w, g.h], 'compact tile 34×34').toEqual([34, 34])
      expect(g.fs).toBe('14px')
    }
  })

  test('the toggle reveals the FULL layout under a 2px divider and flips its label; it collapses again; a reload starts collapsed (not persisted)', async ({ page }) => {
    const { hero, first } = await gl4OpenPage(page, 'Toggle')
    const toggle = hero.getByTestId('guest-steps-toggle')
    const detail = hero.getByTestId('guest-steps-detail')
    await expect(toggle).toHaveText(GL4_TOGGLE_OPEN)
    await expect(toggle).toHaveClass(/\bbtn\b/)
    await expect(toggle).toHaveClass(/\bghost\b/)
    await expect(toggle).toHaveClass(/\bsm\b/)
    await expect(toggle).toHaveCSS('color', 'rgb(255, 45, 135)')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(detail, 'collapsed by default').toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveText(GL4_TOGGLE_CLOSE)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-controls', 'guest-steps-detail')
    await expect(detail).toBeVisible()
    await expect(detail).toHaveCSS('border-top-width', '2px')
    await expect(detail.getByTestId('guest-step-title')).toHaveText(GL4_STEPS)
    // ⚠ `packeta` DEFAULTS OFF (GP-T3 flips it): step 3 ends after „Od {host}."
    await expect(detail.getByTestId('guest-step-detail')).toHaveText([...GL4_DETAILS, `Od ${first}.`])
    await expect(detail, 'no Packeta clause before module 20').not.toContainText('Packet')
    // The full layout: a vertical list, 44px tiles, 19px titles.
    const geo = await detail.evaluate((el) => [...el.querySelectorAll('[data-testid="guest-step"]')].map((s) => {
      const tile = s.firstElementChild.getBoundingClientRect()
      return { top: tile.top, left: Math.round(tile.left), w: tile.width, fs: getComputedStyle(s.querySelector('[data-testid="guest-step-title"]')).fontSize }
    }))
    expect(new Set(geo.map((g) => g.left)).size, 'one column').toBe(1)
    expect(geo[0].top < geo[1].top && geo[1].top < geo[2].top).toBe(true)
    for (const g of geo) {
      expect(g.w, 'full tile 44').toBe(44)
      expect(g.fs).toBe('19px')
    }
    // The strip stays while the detail is open (the prototype keeps both).
    await expect(hero.getByTestId('guest-steps-compact')).toBeVisible()

    await toggle.click()
    await expect(toggle).toHaveText(GL4_TOGGLE_OPEN)
    await expect(detail).toHaveCount(0)

    // Not persisted: open it, reload, it is closed again.
    await toggle.click()
    await expect(detail).toBeVisible()
    await page.reload()
    await expect(hero.getByTestId('guest-steps-toggle')).toHaveText(GL4_TOGGLE_OPEN)
    await expect(hero.getByTestId('guest-steps-detail')).toHaveCount(0)
  })

  test('the toggle is a real button: reachable by Tab and operable by both Enter and Space', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'Keys')
    const toggle = hero.getByTestId('guest-steps-toggle')
    const detail = hero.getByTestId('guest-steps-detail')
    // A native <button> gets Tab order and Enter/Space activation from the element
    // itself, not from a hand-rolled key handler — the CLAUDE.md "disabled doesn't
    // stop a dispatched click" class of gap has a keyboard-access cousin here.
    expect(await toggle.evaluate((n) => n.tagName), 'a native <button>').toBe('BUTTON')
    expect(await toggle.evaluate((n) => n.tabIndex), 'not pulled out of the tab order').toBeGreaterThanOrEqual(0)

    // Walk Tab from the top of the document until the toggle itself is the active
    // element — proves it is genuinely reachable in sequence, not merely present.
    await page.evaluate(() => document.body.focus())
    let reached = false
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await toggle.evaluate((n) => n === document.activeElement)
    }
    expect(reached, 'Tab reaches the toggle within 40 presses').toBe(true)

    await page.keyboard.press('Enter')
    await expect(toggle).toHaveText(GL4_TOGGLE_CLOSE)
    await expect(detail).toBeVisible()

    await expect(toggle, 'focus stays on the toggle after activating it').toBeFocused()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveText(GL4_TOGGLE_OPEN)
    await expect(detail).toHaveCount(0)
  })

  test('the step tile + numbered dot match the prototype: 3px ink border, radius 10, 3px 3px 0 shadow, 20px magenta dot at the top-left corner', async ({ page }) => {
    // `expectedDate` ⇒ the deadline `.mono` renders: the dot is measured AGAINST it.
    const { hero } = await gl4OpenPage(page, 'Tile', GL2_PHONE, { expectedDate: '3. október 2026' })
    await hero.getByTestId('guest-steps-toggle').click()
    for (const scope of [hero.getByTestId('guest-steps-compact'), hero.getByTestId('guest-steps-detail')]) {
      const m = await scope.getByTestId('guest-step').first().evaluate((s) => {
        const tile = s.firstElementChild
        const dot = s.querySelector('[data-testid="guest-step-n"]')
        const t = getComputedStyle(tile)
        const d = getComputedStyle(dot)
        const tr = tile.getBoundingClientRect()
        const dr = dot.getBoundingClientRect()
        return {
          border: [t.borderTopWidth, t.borderTopStyle, t.borderTopColor, t.borderTopLeftRadius],
          shadow: t.boxShadow,
          bg: t.backgroundColor,
          dot: [dr.width, dr.height, d.backgroundColor, d.borderTopWidth, d.borderTopLeftRadius, d.fontSize, d.fontWeight],
          offset: [Math.round(dr.left - tr.left), Math.round(dr.top - tr.top)],
          pos: [d.position, d.top, d.left],
          face: [d.fontFamily, parseFloat(d.letterSpacing) / parseFloat(d.fontSize)],
          realMono: (() => {
            const mono = document.querySelectorAll('.app .card.hl .mono')
            if (mono.length !== 1) return null
            const r = getComputedStyle(mono[0])
            return [r.fontFamily, parseFloat(r.letterSpacing) / parseFloat(r.fontSize)]
          })(),
          isMonoClass: dot.classList.contains('mono'),
        }
      })
      expect(m.border).toEqual(['3px', 'solid', 'rgb(10, 10, 10)', '10px'])
      expect(m.shadow).toBe('rgb(10, 10, 10) 3px 3px 0px 0px')
      expect(m.bg).toBe('rgb(255, 255, 255)')
      expect(m.dot).toEqual([20, 20, 'rgb(255, 45, 135)', '2px', '999px', '10.5px', '700'])
      // Canon `top:-9, left:-9` — measured from the tile's PADDING edge, so 3px of
      // border puts the dot 6px outside the tile's outer box.
      expect(m.pos).toEqual(['absolute', '-9px', '-9px'])
      expect(m.offset, 'the dot hangs off the tile corner').toEqual([-6, -6])
      // The canon's `.mono` face, WITHOUT the class (the shell spec's strict `.mono`) —
      // measured against the hero's OWN deadline `.mono`, so a theme change to `.mono`
      // that the scoped copy misses goes red here. letter-spacing is em-relative
      // (`.01em` at 12.5px vs 10.5px), so it is compared per em.
      expect(m.realMono, 'non-vacuity: exactly one real `.mono` (the deadline) to measure against').not.toBeNull()
      expect(m.face[0]).toBe(m.realMono[0])
      expect(m.face[1]).toBeCloseTo(m.realMono[1], 4)
      expect(m.isMonoClass).toBe(false)
    }
  })

  test('the roasters line: „Káva od [Goriffee] (pražiareň) a [Robo] (domáci pražič, SCA výbery)." — every roaster word from lib/roasters.js, badges pixel-equal to a real `.badge`', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'Roasters')
    const line = hero.getByTestId('guest-roasters')
    await expect(line).toHaveCount(1)
    const runs = await line.evaluate((el) => [...el.children].map((c) => c.textContent.trim()))
    expect(runs).toEqual(['Káva od', 'Goriffee', '(pražiareň) a', 'Robo', '(domáci pražič, SCA výbery).'])

    // The words are the LIBRARY's (one home, 18 §UC-PI-014): read it and compare.
    const lib = await import('file://' + GL4_ROASTERS_LIB)
    expect(lib.ROASTERS.map((r) => r.label)).toEqual(['Goriffee', 'Robo'])
    expect(lib.ROASTERS.map((r) => r.short)).toEqual(['pražiareň', 'domáci pražič, SCA výbery'])
    expect(runs.filter((_, i) => i % 2 === 1)).toEqual(lib.ROASTERS.map((r) => r.label))

    // Line style (canon: `.sub` 13px) and the two badges vs the hero's own real `.badge`.
    await expect(line).toHaveCSS('font-size', '13px')
    await expect(line).toHaveCSS('display', 'flex')
    const cmp = await hero.evaluate((el) => {
      const keys = ['fontFamily', 'fontWeight', 'letterSpacing', 'textTransform', 'borderTopWidth', 'borderTopStyle',
        'borderTopColor', 'borderTopLeftRadius', 'whiteSpace', 'color', 'display', 'lineHeight', 'backgroundColor']
      const pick = (n) => Object.fromEntries(keys.map((k) => [k, getComputedStyle(n)[k]]))
      const real = [...el.querySelectorAll('.badge')].find((b) => b.textContent.trim() === 'Platba prevodom')
      const mine = [...el.querySelectorAll('[data-testid="guest-roaster-badge"]')]
      return {
        real: pick(real),
        mine: mine.map(pick),
        sizes: mine.map((n) => [getComputedStyle(n).fontSize, getComputedStyle(n).paddingTop, getComputedStyle(n).paddingLeft]),
        classes: mine.map((n) => [...n.classList].filter((c) => !c.startsWith('data-'))),
        realAccO: getComputedStyle([...el.querySelectorAll('.badge.acc-o')][0]).backgroundColor,
      }
    })
    // letter-spacing is em-relative: 12px × .04 on the real badge vs 11px × .04 here.
    // backgroundColor: Goriffee is the PLAIN badge, so it must equal „Platba prevodom"'s;
    // Robo is `acc-o`, compared against the theme's real `.badge.acc-o` below.
    const { letterSpacing: realLs, backgroundColor: realBg, ...realRest } = cmp.real
    expect(realBg, 'non-vacuity: the reference badge was measured').toBeTruthy()
    for (const m of cmp.mine) {
      const { letterSpacing, backgroundColor, ...rest } = m
      expect(rest, 'same face/weight/case/border/colour/display/line-height as a theme `.badge`').toEqual(realRest)
      expect(parseFloat(letterSpacing) / 11).toBeCloseTo(parseFloat(realLs) / 12, 3)
    }
    const bgs = cmp.mine.map((m) => m.backgroundColor)
    expect(cmp.sizes, 'the prototype\'s inline 11px / 2px 7px').toEqual([['11px', '2px', '7px'], ['11px', '2px', '7px']])
    expect(bgs[0], 'Goriffee = the plain badge, measured').toBe(realBg)
    expect(bgs[1], 'Robo = the acc-o fill, identical to the theme\'s').toBe(cmp.realAccO)
    // ⚠ The deviation, pinned: NOT `.badge` (see the describe header).
    for (const c of cmp.classes) expect(c).not.toContain('badge')
    expect(cmp.classes[1]).toContain('acc-o')
  })

  test('⚠ the SHIPPED hero pins still hold with the fold OPEN: exactly three `.badge` and exactly one `.mono` (the deadline) in the hero', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'Pins', GL2_PHONE, { expectedDate: '3. október 2026' })
    await hero.getByTestId('guest-steps-toggle').click()
    // Non-vacuity: the fold IS open, so every step element this row adds is in the DOM.
    await expect(hero.getByTestId('guest-step')).toHaveCount(6)
    await expect(hero.getByTestId('guest-roaster-badge')).toHaveCount(2)
    await expect(hero.locator('.badge')).toHaveCount(3)
    await expect(hero.locator('.badge').nth(0)).toHaveText('Login netreba')
    // The shell spec resolves `hero.locator('.mono')` STRICTLY — one element or a throw.
    await expect(hero.locator('.mono')).toHaveCount(1)
    await expect(hero.locator('.mono')).toHaveText('Objednávka do: 3. október 2026')
  })
})

test.describe('GL-T4 · 19 §UC-GL-007 — phone floor, CSP, vocabulary', () => {
  for (const width of [320, 378]) {
    test(`${width}px: no horizontal overflow with the fold open, and no compact title wraps onto a second line`, async ({ page }) => {
      const { hero } = await gl4OpenPage(page, `W${width}`, { width, height: 900 }, { expectedDate: '3. október 2026' })
      await hero.getByTestId('guest-steps-toggle').click()
      await expect(hero.getByTestId('guest-steps-detail')).toBeVisible()
      expect(await hOverflow(page), 'document').toBeLessThanOrEqual(0)
      const m = await hero.evaluate((el) => {
        const heroBox = el.getBoundingClientRect()
        const outside = [...el.querySelectorAll('[data-testid^="guest-"]')].filter((n) => {
          const r = n.getBoundingClientRect()
          return r.right > heroBox.right + 0.5 || r.left < heroBox.left - 0.5
        }).map((n) => n.dataset.testid)
        const titles = [...el.querySelectorAll('[data-testid="guest-steps-compact"] [data-testid="guest-step-title"]')].map((t) => {
          const fs = parseFloat(getComputedStyle(t).fontSize)
          const range = document.createRange()
          range.selectNodeContents(t)
          // One line box per title: every client rect of its text shares one top.
          const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
          return { fs, lines: tops.size, spill: t.scrollWidth > t.clientWidth + 0.5 }
        })
        return { outside, titles }
      })
      expect(m.outside, 'nothing this row adds paints outside the hero').toEqual([])
      expect(m.titles).toHaveLength(3)
      for (const t of m.titles) {
        expect(t.fs, 'above 12px').toBeGreaterThan(12)
        expect(t.lines, 'one line').toBe(1)
        expect(t.spill, 'and it does not spill its column').toBe(false)
      }
    })
  }

  test('320px: no horizontal overflow with the fold CLOSED — the default state, and the one most specs hit', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'W320Closed', GL2_PHONE_320, { expectedDate: '3. október 2026' })
    await expect(hero.getByTestId('guest-steps-detail'), 'closed by default').toHaveCount(0)
    expect(await hOverflow(page), 'document').toBeLessThanOrEqual(0)
    const outside = await hero.evaluate((el) => {
      const heroBox = el.getBoundingClientRect()
      return [...el.querySelectorAll('[data-testid^="guest-"]')].filter((n) => {
        const r = n.getBoundingClientRect()
        return r.right > heroBox.right + 0.5 || r.left < heroBox.left - 0.5
      }).map((n) => n.dataset.testid)
    })
    expect(outside, 'nothing this row adds paints outside the hero, fold closed').toEqual([])
  })

  test('320px: a long host name wraps inside step 3\'s detail (overflow-wrap:anywhere), never out of it', async ({ page }) => {
    const host = await makeHost('LongName')
    const cycle = await makeCycle('LongName')
    await addProduct(cycle.id, 'LongName')
    const link = await shareLink(host, cycle.id)
    const body = await (await ctx.get(`/api/guest/${link.token}`)).json()
    expect(body.host?.first_name, 'non-vacuity: the payload carries the name the page interpolates').toBeTruthy()
    const LONG = 'Z'.repeat(60)
    await page.route(`**/api/guest/${link.token}`, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, host: { ...body.host, first_name: LONG } }),
    }))
    await page.setViewportSize(GL2_PHONE_320)
    await page.goto(`/g/${link.token}`)
    const hero = page.locator('.app .card.hl')
    await hero.getByTestId('guest-steps-toggle').click()
    const step3 = hero.getByTestId('guest-steps-detail').getByTestId('guest-step-detail').nth(2)
    await expect(step3).toHaveText(`Od ${LONG}.`)
    const m = await step3.evaluate((n) => {
      const box = n.closest('[data-testid="guest-steps-detail"]').getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(n)
      const rects = [...range.getClientRects()]
      return { right: Math.max(...rects.map((r) => r.right)), limit: box.right, lines: new Set(rects.map((r) => Math.round(r.top))).size }
    })
    expect(m.lines, 'it wrapped').toBeGreaterThan(1)
    expect(m.right, 'inside the detail box').toBeLessThanOrEqual(m.limit + 0.5)
    // The name is the PERSON's copy, marked for the rendered-copy sweep (FUP-T22).
    await expect(step3.locator('[data-user-copy]')).toHaveText(LONG)
  })

  test('no third-party request on load or on toggling — the glyphs are inline SVG (CSP)', async ({ page, baseURL }) => {
    const origin = new URL(baseURL || process.env.BASE_URL || 'http://localhost:3997').origin
    const external = []
    const all = []
    page.on('request', (req) => {
      const url = req.url()
      if (!/^https?:/i.test(url)) return
      all.push(url)
      if (new URL(url).origin !== origin) external.push(url)
    })
    const { hero } = await gl4OpenPage(page, 'Csp')
    await hero.getByTestId('guest-steps-toggle').click()
    await expect(hero.getByTestId('guest-steps-detail').locator('svg')).toHaveCount(3)
    await page.waitForLoadState('networkidle')
    expect(all.length, 'non-vacuity: the listener saw the page load').toBeGreaterThan(0)
    expect(external).toEqual([])
    // Every step glyph is an inline <svg>, never an <img>/background fetch.
    await expect(hero.locator('[data-testid="guest-step"] img')).toHaveCount(0)
  })

  test('the new copy carries no „cyklus"/„kolo" (the ONE regex, PI-T11)', async ({ page }) => {
    const { hero } = await gl4OpenPage(page, 'Vocab')
    await hero.getByTestId('guest-steps-toggle').click()
    const text = await hero.innerText()
    expect(text, 'non-vacuity: the swept text holds the new copy').toContain('ZABALÍME')
    expect(text).toContain('SCA výbery')
    expect(text).not.toMatch(BANNED)
  })
})

test.describe('GL-T4 · source pins — one home for the roaster words, one icon module, packeta OFF', () => {
  test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)

  const src = (rel) => {
    const raw = readFileSync(join(FRONTEND_SRC_DIR, rel), 'utf8')
    const stripped = stripComments(raw)
    expect(stripped.length, `${rel} survived the comment strip`).toBeGreaterThan(200)
    return stripped
  }

  test('GuestRoastersLine.vue IMPORTS lib/roasters.js and types none of its words', () => {
    const line = src('components/GuestRoastersLine.vue')
    expect(line).toMatch(/import\s*\{\s*ROASTERS\s*\}\s*from\s*['"][^'"]*lib\/roasters(?:\.js)?['"]/)
    expect(line, 'readability gate: the template is in the stripped text').toContain('guest-roaster-badge')
    for (const word of ['Goriffee', 'Robo', 'pražiareň', 'domáci pražič', 'SCA']) {
      expect(line, `„${word}" comes from the library, never typed here`).not.toContain(word)
    }
  })

  test('GuestSteps.vue: NeoIcon cup/box/hand, no <svg> of its own, `packeta` defaults to false; GuestOrder.vue binds it on every mount (GP-T3)', () => {
    const steps = src('components/GuestSteps.vue')
    expect(steps).toContain('NeoIcon')
    for (const name of ['cup', 'box', 'hand']) expect(steps).toContain(`icon: '${name}'`)
    expect(steps, 'no inline SVG outside the ONE icon module').not.toContain('<svg')
    expect(steps).toMatch(/packeta:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    expect(steps, 'the clause is the prototype\'s, byte for byte').toContain("', alebo si ju nechajte poslať cez Packetu.'")
    const icons = src('components/neo/icons.js')
    for (const name of ['cup', 'box', 'hand']) expect(icons).toMatch(new RegExp(`\\n\\s{2}${name}:\\s*\\{`))

    const view = src('views/GuestOrder.vue')
    expect(view, 'readability gate').toContain('guest-steps-toggle')
    // GL-T5 retarget (19 §UC-GL-006 items 2–3): the pre-open page mounts the SAME two
    // components — the „Ako to funguje" card (full) and the hero's roasters line.
    expect((view.match(/<GuestSteps\b/g) || []).length, 'compact strip + the fold + the pre-open card').toBe(3)
    // ⚠ SANCTIONED RETARGET (GP-T3, the GL-T4 seam — 19 §UC-GL-007 „module 20 flips it on
    // when `cycle.parcel_enabled`"; PROGRESS GP-T3 row). Was: „packeta stays OFF until
    // GP-T3" — `not.toMatch(/<GuestSteps[^>]*packeta/)`. Now EVERY mount (the compact
    // strip, the fold and the pre-open card) binds the ONE computed `stepsPacketa`, so no
    // mount can drift from the others; the component's default stays `false` (above).
    const mounts = view.match(/<GuestSteps\b[^>]*>/g) || []
    expect(mounts, 'all three GuestSteps mounts').toHaveLength(3)
    for (const m of mounts) expect(m, 'every mount binds the one computed').toContain(':packeta="stepsPacketa"')
    expect(view).toMatch(/const stepsPacketa = computed\(/)
    expect((view.match(/<GuestRoastersLine\b/g) || []).length, 'open hero + pre-open hero').toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T5 · 19 §UC-GL-006 — the FULL pre-open page (`GLink2 Zatvorené`, transcribed).
//
// The shared target nearly always has an open round, so the kind-specific states run
// on a FULFILLED `GET /api/guest/:token` (GL-T2's idiom) and the waitlist POST is
// fulfilled too (its server half is `guest-waitlist.spec.js`, GL-T3). One test runs
// against the real server: a legacy per-cycle token on a LOCKED cycle — pre-open on
// any target. DRAFT PO copy throughout (19 §OPEN): transcribed, never improved, and
// hoisted here so a PO edit is a two-place change (the 14-module precedent).
// ═════════════════════════════════════════════════════════════════════════════
const GL5_TICKER_CLOSED = '+++ OBJEDNÁVKY ZATVORENÉ +++ DÁME VEDIEŤ, KEĎ SA OTVORÍ +++'
const GL5_DOC_TITLE = 'Objednávky sú zatvorené – Podpultovka'
const GL5_LOCK_TITLE = 'Objednávky sú zatvorené'
const GL5_FORM = {
  title: 'Dajte mi vedieť',
  sub: 'Pošleme jednu správu, keď sa objednávka otvorí. Nič viac.',
  consent: 'Súhlasím so správou cez WhatsApp',
  button: 'Chcem vedieť, keď sa otvorí',
}
const GL5_DONE_WA = (host) => `Dáme vedieť. Keď sa objednávka otvorí, príde vám správa na WhatsApp s odkazom od ${host}.`
const GL5_DONE_NO_WA = (host) => `Dáme vedieť. Keď sa objednávka otvorí, ${host} vám pošle odkaz.`
const GL5_STORAGE_KEY = 'gorifi_guest_waitlist'

/** The local ISO date `n` calendar days from NOW (the page computes against its own clock). */
function gl5Day(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function gl5Product(id, name, extra = {}) {
  return {
    id, cycle_id: 9001, name, purpose: 'Espresso', description1: 'Brazília · natural', description2: 'čokoláda, oriešky',
    roast_type: 'espresso', roastery: 'Goriffee', price_150g: null, price_200g: null, price_250g: 9.5, price_500g: null,
    price_1kg: 32, price_20pc5g: null, price_8pc12g: null, price_unit: null, image: '/coffee-cup.png',
    weight_grams: null, composition: null, variant_label: null, source_bakery_product_id: null, source_variant_id: null,
    ...extra,
  }
}

const GL5_PREVIEW = {
  cycle: { id: 9001, name: 'Septembrová ponuka' },
  products: [
    gl5Product(91, 'Preview Alfa'),
    gl5Product(92, 'Preview Beta', { roastery: 'Robo' }),
    gl5Product(93, 'Preview Filter', { purpose: 'Filter' }),
  ],
}

function gl5Body(next = { kind: 'planned_date', opens_at: gl5Day(28), cycle_name: 'Október' }, extra = {}) {
  return preopenBody(next, { preview: GL5_PREVIEW, ...extra })
}

/**
 * Serve `body` for the listing GET of `token`, and (optionally) a scripted answer for
 * the waitlist POST. Returns the recorded POSTs + GET count.
 */
async function gl5Mock(page, token, body, { post = { status: 200, body: { success: true } }, holdPost = null } = {}) {
  const seen = { gets: 0, posts: [] }
  await page.route(`**/api/guest/${token}`, (route) => {
    seen.gets++
    const b = typeof body === 'function' ? body(seen.gets) : body
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) })
  })
  await page.route(`**/api/guest/${token}/waitlist`, async (route) => {
    const req = route.request()
    seen.posts.push({ method: req.method(), body: req.postDataJSON(), headers: req.headers() })
    if (holdPost) await holdPost
    return route.fulfill({ status: post.status, contentType: 'application/json', body: JSON.stringify(post.body) })
  })
  return seen
}

async function gl5Open(page, token, body, opts = {}, viewport = GL2_PHONE) {
  const seen = await gl5Mock(page, token, body, opts)
  await page.setViewportSize(viewport)
  await page.goto(`/g/${token}`)
  await expect(page.getByTestId('preopen-hero')).toBeVisible()
  return seen
}

// ⚠ RE-POINTED by GP-T7 (PO decision (4) 2026-09-24 — the friend register „o n dní",
// 17 O6, on the guest pre-open page too): ~~`plural.js weeksAwayLabel(days)` — past ⇒
// "", 0–6 ⇒ „už tento týždeň", else „o N týždňov"~~ is DELETED; the pre-open „(…)" is
// `lib/cycle-stages.js inWeeksText(opens_at)`, ONE home. The same 20 day offsets, now
// through the one function: today and the past ⇒ `null` (the view prints no
// parenthesis), 1–6 ⇒ days, else weeks rounded.
test.describe('GP-T7 · 19 §UC-GL-006 — the pre-open „(…)" is inWeeksText() (lib/cycle-stages.js, imported by plain node)', () => {
  test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)

  test('every branch: unparsable / past / today ⇒ null, 1–6 ⇒ „o n dni/dní", else „o N" weeks rounded; `weeksAwayLabel` is gone', async () => {
    const { inWeeksText } = await import('file://' + join(FRONTEND_SRC_DIR, 'lib', 'cycle-stages.js'))
    const plural = await import('file://' + join(FRONTEND_SRC_DIR, 'lib', 'plural.js'))
    expect(plural.weeksAwayLabel, 'no second three-branch copy in plural.js').toBeUndefined()
    const view = stripComments(readFileSync(join(FRONTEND_SRC_DIR, 'views', 'GuestOrder.vue'), 'utf8'))
    expect(view, 'readability gate').toContain('preopen-next')
    expect(view, 'the view takes the parenthesis from the ONE home').toContain('away: inWeeksText(next.opens_at)')
    expect(view).not.toMatch(/weeksAwayLabel|už tento týždeň/)
    const today = new Date(2026, 8, 25, 12, 0, 0)
    const iso = (n) => {
      const d = new Date(2026, 8, 25 + n)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    // [label, argument, expected] — five raw non-dates, then day offsets from `today`
    const raw = [null, undefined, '2026-02-30', 'zajtra', 7].map((v) => [`raw ${String(v)}`, v, null])
    const days = [
      [-1, null], [-30, null], [0, null], [1, 'o 1 deň'], [3, 'o 3 dni'], [6, 'o 6 dní'],
      [7, 'o 1 týždeň'], [10, 'o 1 týždeň'], [11, 'o 2 týždne'], [14, 'o 2 týždne'], [21, 'o 3 týždne'],
      [28, 'o 4 týždne'], [31, 'o 4 týždne'], [32, 'o 5 týždňov'], [70, 'o 10 týždňov'],
    ].map(([n, want]) => [`${n} days`, iso(n), want])
    const cases = [...raw, ...days]
    expect(cases).toHaveLength(20)
    for (const [label, arg, want] of cases) expect(inWeeksText(arg, today), label).toBe(want)
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 — the pre-open page, transcribed (mocked payload)', () => {
  test('chrome: lock chip (no text, titled), the CLOSED ticker constant, the shipped subtitle; document.title', async ({ page }) => {
    await gl5Open(page, 'GLFIVECHROME22', gl5Body())
    const app = page.locator('.app')
    const chip = app.locator('.appbar .chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveClass(/p2-lock/)
    await expect(chip).toHaveAttribute('title', GL5_LOCK_TITLE)
    await expect(chip.locator('svg'), 'the lock glyph').toHaveCount(1)
    expect((await chip.textContent()).trim(), 'the chip carries no text').toBe('')
    await expect(app.getByText('Bez účtu'), 'the open chip is gone in this state').toHaveCount(0)
    await expect(app.locator('.ticker span')).toContainText(GL5_TICKER_CLOSED)
    await expect(app.locator('.ticker span')).not.toContainText('KÁVA POD PULTOM')
    await expect(app.locator('.appbar .titles .s')).toHaveText('Objednávka cez odkaz')
    await expect(page).toHaveTitle(GL5_DOC_TITLE)
  })

  test('the hero: badge, split headline with the highlighted „zatvorené", the host sentence + date sentence with „(o 4 týždne)", then the roasters line', async ({ page }) => {
    const opens = gl5Day(28)
    await gl5Open(page, 'GLFIVEHERO2222', gl5Body({ kind: 'planned_date', opens_at: opens, cycle_name: 'Október' }))
    const hero = page.getByTestId('preopen-hero')
    await expect(hero).toHaveClass(/card/)
    await expect(hero).toHaveClass(/\bhl\b/)
    await expect(hero.locator('.badge'), 'strict: the ONE badge in the hero').toHaveText('Zatvorené')
    const h1 = hero.locator('h1.h-screen')
    await expect(h1).toHaveText('Objednávky sú zatvorené')
    await expect(h1.locator('br'), 'the prototype breaks the last word onto its own line').toHaveCount(1)
    await expect(h1.locator('.hl')).toHaveText('zatvorené')
    const day = new Date(`${opens}T00:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' })
    await expect(page.getByTestId('preopen-next')).toHaveText(`Ďalšia objednávka sa otvorí približne ${day} (o 4 týždne).`)
    await expect(page.getByTestId('preopen-next').locator('b'), 'the date is bold').toHaveText(day)
    await expect(hero.locator('b[data-user-copy]').first(), 'the host is bold and marked as person copy').toHaveText('Janka')
    await expect(hero).toContainText('Janka vás pozýva do spoločnej objednávky výberovej kávy.')
    // Order: badge → h1 → sentence → roasters line (DOM and geometry).
    const order = await hero.evaluate((el) => {
      const parts = [el.querySelector('.badge'), el.querySelector('h1'), el.querySelector('[data-testid="preopen-next"]'), el.querySelector('[data-testid="guest-roasters"]')]
      if (!parts.every(Boolean)) return null
      return parts.slice(1).map((p, i) => parts[i].getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 0.5)
    })
    expect(order, 'badge → headline → sentence → roasters, top to bottom').toEqual([true, true, true])
    await expect(hero.getByTestId('guest-roaster-badge')).toHaveText(['Goriffee', 'Robo'])
    await expect(hero.locator('.mono'), 'nothing new in the hero carries .mono (GL-T4 rule)').toHaveCount(0)
  })

  // ⚠ RE-POINTED by GP-T7 (PO decision (4)): ~~3 days ⇒ „(už tento týždeň)"~~ → „(o 3 dni)";
  // TODAY now prints no parenthesis (`inWeeksText` ⇒ null) — the sentence stays well formed.
  test('the date parenthesis: 3 days ⇒ „(o 3 dni)", 1 ⇒ „(o 1 deň)", TODAY and a PAST date ⇒ none, 10 days ⇒ „(o 1 týždeň)"', async ({ page }) => {
    const TOKEN = 'GLFIVEWEEKS222'
    for (const [n, tail] of [[3, ' (o 3 dni).'], [1, ' (o 1 deň).'], [0, '.'], [-2, '.'], [10, ' (o 1 týždeň).']]) {
      const iso = gl5Day(n)
      await page.unroute(`**/api/guest/${TOKEN}`)
      await page.unroute(`**/api/guest/${TOKEN}/waitlist`)
      await gl5Open(page, TOKEN, gl5Body({ kind: 'planned_date', opens_at: iso, cycle_name: 'X' }))
      const day = new Date(`${iso}T00:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' })
      await expect(page.getByTestId('preopen-next'), `${n} days`).toHaveText(`Ďalšia objednávka sa otvorí približne ${day}${tail}`)
      await expect(page.getByTestId('preopen-next'), `${n} days: never an empty parenthesis`).not.toContainText('()')
    }
  })

  test('a MULTILINE plan_note keeps its lines (white-space:pre-line, 17 §UC-CS-005 item 6 — the consumer\'s job)', async ({ page }) => {
    await gl5Open(page, 'GLFIVENOTEML22', gl5Body({ kind: 'planned_note', plan_note: 'po Vianociach\npresný dátum dáme vedieť', cycle_name: 'X' }))
    const note = page.getByTestId('preopen-plan-note')
    await expect(note).toHaveCSS('white-space', 'pre-line')
    expect(await note.innerText(), 'the newline survives rendering').toBe('po Vianociach\npresný dátum dáme vedieť')
    // The inline span may also wrap on width, so the pin is RELATIVE: the newline
    // must add a line box that collapsed whitespace does not have.
    const lines = await note.evaluate((el) => {
      const count = () => new Set([...el.getClientRects()].map((r) => Math.round(r.top))).size
      const kept = count()
      el.style.whiteSpace = 'normal'
      const collapsed = count()
      el.style.whiteSpace = ''
      return { kept, collapsed }
    })
    expect(lines.kept, 'the newline breaks the line').toBeGreaterThan(lines.collapsed)
  })

  test('the „Ako to funguje" card: field label + the FULL GuestSteps (three tiles WITH details, „Od {host}.")', async ({ page }) => {
    await gl5Open(page, 'GLFIVESTEPS222', gl5Body())
    const card = page.getByTestId('preopen-steps')
    await expect(card).toHaveClass(/\bcard\b/)
    await expect(card.locator('.field-lbl')).toHaveText('Ako to funguje')
    await expect(card.getByTestId('guest-step')).toHaveCount(3)
    await expect(card.getByTestId('guest-step-title')).toHaveText(GL4_STEPS)
    // ⚠ RE-POINTED by GP-T7 (PO decision (3)): ~~„Od Janka."~~ — the default body's
    // an unknown/planned `next` kind ALWAYS shows the Packeta clause (GP-T7, learnings 12 §48).
    await expect(card.getByTestId('guest-step-detail')).toHaveText([...GL4_DETAILS, 'Od Janka, alebo si ju nechajte poslať cez Packetu.'])
    const tile = await card.getByTestId('guest-step').first().evaluate((s) => {
      const r = s.firstElementChild.getBoundingClientRect()
      return [r.width, r.height]
    })
    expect(tile, 'full layout tile 44×44').toEqual([44, 44])
  })

  test('the card ORDER is the prototype\'s: hero → Ako to funguje → Dajte mi vedieť → Minulá ponuka header → faded preview', async ({ page }) => {
    await gl5Open(page, 'GLFIVEORDER222', gl5Body())
    const ids = ['preopen-hero', 'preopen-steps', 'waitlist-form', 'preopen-preview-head', 'preopen-preview']
    const tops = []
    for (const id of ids) {
      const box = await page.getByTestId(id).boundingBox()
      expect(box, `${id} renders`).not.toBeNull()
      tops.push(box.y)
    }
    for (let i = 1; i < tops.length; i++) expect(tops[i], `${ids[i - 1]} above ${ids[i]}`).toBeGreaterThan(tops[i - 1])
  })

  test('the form: copy, fields (placeholders, maxlength 120/32 mirrored, inputmode tel), consent CHECKED by default, one accent block button', async ({ page }) => {
    await gl5Open(page, 'GLFIVEFORM2222', gl5Body())
    const form = page.getByTestId('waitlist-form')
    await expect(form.locator('.display')).toHaveText(GL5_FORM.title)
    await expect(form.locator('.sub').first()).toHaveText(GL5_FORM.sub)
    const name = form.getByTestId('waitlist-name')
    const phone = form.getByTestId('waitlist-phone')
    await expect(name).toHaveAttribute('placeholder', 'Meno a priezvisko')
    await expect(name).toHaveAttribute('maxlength', '120')
    await expect(phone).toHaveAttribute('placeholder', '09xx xxx xxx')
    await expect(phone).toHaveAttribute('maxlength', '32')
    await expect(phone).toHaveAttribute('inputmode', 'tel')
    await expect(name).toHaveClass(/\binp\b/)
    await expect(phone).toHaveClass(/\binp\b/)
    // The labels NAME the inputs (a real <label for>), which is what a screen reader reads.
    await expect(form.getByLabel('Meno')).toHaveCount(1)
    await expect(form.getByLabel('Mobil')).toHaveCount(1)
    const box = form.getByRole('checkbox', { name: GL5_FORM.consent })
    await expect(box).toHaveAttribute('aria-checked', 'true')
    const btn = form.getByTestId('waitlist-submit')
    await expect(btn).toHaveText(GL5_FORM.button)
    await expect(btn).toHaveClass(/\bbtn\b/)
    await expect(btn).toHaveClass(/\baccent\b/)
    await expect(btn).toHaveClass(/\bblock\b/)
    // The three-zone label: the TEXT toggles too, exactly once.
    await form.getByText(GL5_FORM.consent, { exact: true }).click()
    await expect(box).toHaveAttribute('aria-checked', 'false')
    await box.click()
    await expect(box).toHaveAttribute('aria-checked', 'true')
  })

  test('the submit: disabled until BOTH fields hold text; posts {name, phone, whatsapp_opt_in:true} trimmed with NO auth header; the ok banner REPLACES the card; a reload keeps it', async ({ page }) => {
    const TOKEN = 'GLFIVESUBMIT22'
    const seen = await gl5Open(page, TOKEN, gl5Body())
    const form = page.getByTestId('waitlist-form')
    const btn = form.getByTestId('waitlist-submit')
    await expect(btn).toBeDisabled()
    await form.getByTestId('waitlist-name').fill('  Zuzka Hosťová  ')
    await expect(btn, 'phone still empty').toBeDisabled()
    await form.getByTestId('waitlist-phone').fill('   ')
    await expect(btn, 'whitespace is not a phone').toBeDisabled()
    await form.getByTestId('waitlist-phone').fill(' 0905 123 456 ')
    await expect(btn).toBeEnabled()
    // §UC-GL-006 acceptance: before submit the page's ONE enabled button is this one.
    await expect(page.locator('.app button:enabled')).toHaveCount(1)
    await btn.click()

    const done = page.getByTestId('waitlist-done')
    await expect(done).toHaveText(GL5_DONE_WA('Janka'))
    await expect(done).toHaveClass(/\bbanner\b/)
    await expect(done).toHaveClass(/\bok\b/)
    await expect(done.locator('b')).toHaveText('Dáme vedieť.')
    await expect(page.getByTestId('waitlist-form'), 'the card is REPLACED').toHaveCount(0)
    await expect(page.locator('.app button:enabled'), '…and after it, none').toHaveCount(0)

    expect(seen.posts.length).toBe(1)
    const [post] = seen.posts
    expect(post.method).toBe('POST')
    expect(post.body).toEqual({ name: 'Zuzka Hosťová', phone: '0905 123 456', whatsapp_opt_in: true })
    for (const h of ['x-admin-token', 'authorization', 'x-friends-password']) expect(post.headers[h], h).toBeUndefined()

    const stored = await page.evaluate((k) => localStorage.getItem(k), GL5_STORAGE_KEY)
    expect(stored, 'remembered on this device').toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('preopen-hero')).toBeVisible()
    await expect(page.getByTestId('waitlist-done')).toHaveText(GL5_DONE_WA('Janka'))
    await expect(page.getByTestId('waitlist-form')).toHaveCount(0)
    expect(seen.posts.length, 'a reload posts nothing').toBe(1)
  })

  test('consent UNTICKED ⇒ whatsapp_opt_in:false and the second banner, which does not promise WhatsApp; a reload keeps THAT banner', async ({ page }) => {
    const seen = await gl5Open(page, 'GLFIVENOWA2222', gl5Body())
    const form = page.getByTestId('waitlist-form')
    await form.getByTestId('waitlist-name').fill('Peter')
    await form.getByTestId('waitlist-phone').fill('0905123456')
    await form.getByRole('checkbox', { name: GL5_FORM.consent }).click()
    await form.getByTestId('waitlist-submit').click()
    await expect(page.getByTestId('waitlist-done')).toHaveText(GL5_DONE_NO_WA('Janka'))
    expect(seen.posts[0].body).toEqual({ name: 'Peter', phone: '0905123456', whatsapp_opt_in: false })
    await page.reload()
    await expect(page.getByTestId('waitlist-done')).toHaveText(GL5_DONE_NO_WA('Janka'))
    await expect(page.getByTestId('waitlist-done')).not.toContainText('WhatsApp')
  })

  test('the JS guard: a DISPATCHED click on the disabled button posts nothing; while PENDING the button is disabled and a second click posts nothing', async ({ page }) => {
    let release
    const hold = new Promise((r) => { release = r })
    const seen = await gl5Open(page, 'GLFIVEGUARD222', gl5Body(), { holdPost: hold })
    const form = page.getByTestId('waitlist-form')
    const btn = form.getByTestId('waitlist-submit')
    await btn.dispatchEvent('click')
    await form.getByTestId('waitlist-name').fill('Ema')
    await btn.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(seen.posts.length, 'empty phone: nothing posted').toBe(0)

    await form.getByTestId('waitlist-phone').fill('0905 111 222')
    await btn.click()
    await expect.poll(() => seen.posts.length).toBe(1)
    await expect(btn, 'pending').toBeDisabled()
    await btn.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(seen.posts.length, 'pending: no second POST').toBe(1)
    release()
    await expect(page.getByTestId('waitlist-done')).toBeVisible()
  })

  test('a server 400 renders its message in the card\'s danger banner and keeps the form (and what was typed); nothing is remembered', async ({ page }) => {
    const seen = await gl5Open(page, 'GLFIVEERR40022', gl5Body(), { post: { status: 400, body: { error: 'Telefón je príliš dlhý (max 32 znakov)', field: 'phone' } } })
    const form = page.getByTestId('waitlist-form')
    await form.getByTestId('waitlist-name').fill('Ema')
    await form.getByTestId('waitlist-phone').fill('0905 111 222')
    await form.getByTestId('waitlist-submit').click()
    const err = form.getByTestId('waitlist-error')
    await expect(err).toHaveText('Telefón je príliš dlhý (max 32 znakov)')
    await expect(form.locator('.banner.danger.slim')).toHaveCount(1)
    await expect(page.getByTestId('waitlist-done')).toHaveCount(0)
    await expect(form.getByTestId('waitlist-phone')).toHaveValue('0905 111 222')
    await expect(form.getByTestId('waitlist-submit')).toBeEnabled()
    expect(seen.posts.length).toBe(1)
    expect(await page.evaluate((k) => localStorage.getItem(k), GL5_STORAGE_KEY)).toBeNull()
  })

  test('a 409 `open` (the round opened meanwhile) RELOADS into the live page — the listing is fetched again', async ({ page }) => {
    const TOKEN = 'GLFIVEOPEN4092'
    const live = {
      cycle: { id: 1, name: 'Živá objednávka GL5', type: 'coffee', status: 'open', expected_date: null, plan_note: null },
      host: { first_name: 'Janka' },
      products: [],
      availability: [],
    }
    const seen = await gl5Open(page, TOKEN, (n) => (n === 1 ? gl5Body() : live), {
      post: { status: 409, body: { error: 'Objednávka je práve otvorená — môžete si objednať rovno.', reason: 'open' } },
    })
    const form = page.getByTestId('waitlist-form')
    await form.getByTestId('waitlist-name').fill('Ema')
    await form.getByTestId('waitlist-phone').fill('0905 111 222')
    await form.getByTestId('waitlist-submit').click()
    await expect(page.getByRole('heading', { name: 'Živá objednávka GL5' })).toBeVisible()
    await expect(page.getByTestId('preopen-hero')).toHaveCount(0)
    expect(seen.gets, 'the listing was read again').toBe(2)
  })

  test('localStorage THROWING (private mode) breaks nothing: the form renders, the submit still flips to the banner', async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('denied') }
      Storage.prototype.setItem = () => { throw new Error('denied') }
    })
    await gl5Open(page, 'GLFIVENOSTORE2', gl5Body())
    const form = page.getByTestId('waitlist-form')
    await form.getByTestId('waitlist-name').fill('Ema')
    await form.getByTestId('waitlist-phone').fill('0905 111 222')
    await form.getByTestId('waitlist-submit').click()
    await expect(page.getByTestId('waitlist-done')).toHaveText(GL5_DONE_WA('Janka'))
  })

  test('the memory is per TOKEN and per preview ROUND: another token\'s entry, a different round\'s entry and garbage all show the form', async ({ page }) => {
    const TOKEN = 'GLFIVEMEMORY22'
    await page.addInitScript(({ key, token }) => {
      // Only once per test (a reload must see what the PAGE wrote, not this seed).
      if (sessionStorage.getItem('gl5-seeded')) return
      sessionStorage.setItem('gl5-seeded', '1')
      localStorage.setItem(key, JSON.stringify({
        OTHERTOKEN2222: { at: '2026-09-01T10:00:00.000Z', whatsapp_opt_in: true, cycle_id: 9001 },
        [token]: { at: '2026-09-01T10:00:00.000Z', whatsapp_opt_in: true, cycle_id: 1234 },
      }))
    }, { key: GL5_STORAGE_KEY, token: TOKEN })
    await gl5Open(page, TOKEN, gl5Body())
    await expect(page.getByTestId('waitlist-form'), 'a different round\'s memory is stale').toBeVisible()
    await expect(page.getByTestId('waitlist-done')).toHaveCount(0)

    await page.evaluate((k) => localStorage.setItem(k, '{not json'), GL5_STORAGE_KEY)
    await page.reload()
    await expect(page.getByTestId('waitlist-form'), 'garbage in storage').toBeVisible()
  })

  test('waitlist.available FALSE (the stale link): no form, no banner — the steps card and the preview still render', async ({ page }) => {
    await gl5Open(page, 'GLFIVESTALE222', gl5Body({ kind: 'open_elsewhere', cycle_name: 'Nové' }, { stale_cycle: { id: 1, name: 'Staré' } }))
    await expect(page.getByTestId('preopen-hero').locator('h1')).toHaveText('Táto objednávka je už uzavretá')
    await expect(page.getByTestId('preopen-steps'), 'non-vacuity: the page body rendered').toBeVisible()
    await expect(page.getByTestId('preopen-preview')).toBeVisible()
    await expect(page.getByTestId('waitlist-form')).toHaveCount(0)
    await expect(page.getByTestId('waitlist-done')).toHaveCount(0)
    await expect(page.locator('.app button:enabled'), 'nothing on this page is a control').toHaveCount(0)
  })

  test('no cartbar, no checkout, no invite CTA, and the token is never composed into the DOM', async ({ page }) => {
    const TOKEN = 'GLFIVENOCART22'
    await gl5Open(page, TOKEN, gl5Body())
    await expect(page.getByTestId('waitlist-form'), 'non-vacuity').toBeVisible()
    for (const id of ['cartbar', 'open-checkout', 'cart-total', 'invite-cta', 'guest-submit']) {
      await expect(page.getByTestId(id), id).toHaveCount(0)
    }
    await expect(page.locator('.cartbar')).toHaveCount(0)
    expect(await page.content()).not.toContain(TOKEN)
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 item 5 — the faded read-only preview (GuestProductGrid `readonly`)', () => {
  test('header „Minulá ponuka · {round}" + „len na prezretie"; `.p2-ro` wrapper (opacity .55, pointer-events none, user-select none) around the tabs AND the cards', async ({ page }) => {
    await gl5Open(page, 'GLFIVEPREVIEW2', gl5Body())
    const head = page.getByTestId('preopen-preview-head')
    await expect(head.locator('.field-lbl')).toHaveText('Minulá ponuka · Septembrová ponuka')
    await expect(head.locator('.field-lbl [data-user-copy]'), 'the round name is admin-typed data').toHaveText('Septembrová ponuka')
    const ro = head.locator('.sub.mono')
    await expect(ro).toHaveText('len na prezretie')
    await expect(ro).toHaveCSS('font-size', '12px')
    const preview = page.getByTestId('preopen-preview')
    await expect(preview).toHaveClass(/\bp2-ro\b/)
    await expect(preview).toHaveCSS('opacity', '0.55')
    await expect(preview).toHaveCSS('pointer-events', 'none')
    await expect(preview).toHaveCSS('user-select', 'none')
    await expect(preview.getByTestId('purpose-tabs'), 'the shipped strip, inside the fade').toBeVisible()
    await expect(preview.locator('[data-testid^="product-"]'), 'the Espresso tab: two cards').toHaveCount(2)
    await expect(preview.getByTestId('product-91')).toContainText('Preview Alfa')
    await expect(preview.getByTestId('product-91')).toContainText('9.50 EUR')
    await expect(preview.getByTestId('product-91')).toContainText('32.00 EUR')
  })

  test('readonly: no stepper, no button, no stock bar, the photo and the tabs are not controls (nothing focusable), no lightbox', async ({ page }) => {
    await gl5Open(page, 'GLFIVEREADONLY', gl5Body(undefined, { waitlist: { available: false } }))
    const preview = page.getByTestId('preopen-preview')
    await expect(preview.locator('.vbox'), 'non-vacuity: the variant boxes render').toHaveCount(4)
    await expect(preview.locator('.vprice').first()).toHaveText('9.50 EUR')
    await expect(preview.locator('button')).toHaveCount(0)
    await expect(preview.locator('.stepper')).toHaveCount(0)
    await expect(preview.getByTestId('stock-bar')).toHaveCount(0)
    await expect(preview.locator('img'), 'non-vacuity: the photos render').toHaveCount(2)
    await expect(preview.locator('[role="button"]')).toHaveCount(0)
    await expect(preview.locator('[tabindex]:not([tabindex="-1"])'), 'no tab stop inside the preview').toHaveCount(0)
    // The photo does not open the lightbox, even on a dispatched click.
    await preview.locator('img').first().dispatchEvent('click')
    await page.waitForTimeout(200)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.app button:enabled')).toHaveCount(0)
  })

  test('preview NULL ⇒ no header and no grid; preview with ZERO products ⇒ none either (never the grid\'s empty banner)', async ({ page }) => {
    const TOKEN = 'GLFIVENOPREV22'
    await gl5Open(page, TOKEN, gl5Body(undefined, { preview: null }))
    await expect(page.getByTestId('preopen-steps'), 'non-vacuity').toBeVisible()
    await expect(page.getByTestId('preopen-preview-head')).toHaveCount(0)
    await expect(page.getByTestId('preopen-preview')).toHaveCount(0)
    await page.unroute(`**/api/guest/${TOKEN}`)
    await page.unroute(`**/api/guest/${TOKEN}/waitlist`)
    await gl5Open(page, TOKEN, gl5Body(undefined, { preview: { cycle: { id: 1, name: 'Prázdna' }, products: [] } }))
    await expect(page.getByTestId('preopen-preview-head')).toHaveCount(0)
    await expect(page.getByTestId('preopen-preview')).toHaveCount(0)
    await expect(page.locator('.app')).not.toContainText('žiadne produkty')
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 — phone floor, A12, tap targets, vocabulary', () => {
  for (const width of [320, 378]) {
    test(`${width}px: no horizontal overflow — every card, the form, the preview, a long host name and a long plan note`, async ({ page }) => {
      const longHost = { first_name: 'Alžbeta-Kristínamária Novosadová-Hrušovská' }
      await gl5Open(page, `GLFIVEWIDTH${width}`, gl5Body(undefined, { host: longHost }), {}, { width, height: 900 })
      await expect(page.getByTestId('waitlist-form')).toBeVisible()
      expect(await hOverflow(page), 'planned_date').toBeLessThanOrEqual(0)
      // The page COLUMN (the ticker's 3× repeated span is clipped by design and would
      // be a false offender); the preview's tab strip is a scroller of its own.
      const offenders = await page.evaluate((w) => [...document.querySelectorAll('[data-testid="preopen-page"] *')]
        .filter((el) => !el.closest('.cat-tabs'))
        .filter((el) => el.getBoundingClientRect().right > w + 0.5 && el.getClientRects().length)
        .map((el) => el.className || el.tagName).slice(0, 5), width)
      expect(offenders, 'nothing paints past the viewport edge').toEqual([])
    })
  }

  test('every control on the page is ≥ 44 px tall: both inputs, the consent row, the button', async ({ page }) => {
    await gl5Open(page, 'GLFIVETAP22222', gl5Body())
    const form = page.getByTestId('waitlist-form')
    for (const loc of [form.getByTestId('waitlist-name'), form.getByTestId('waitlist-phone'), form.getByTestId('waitlist-consent'), form.getByTestId('waitlist-submit')]) {
      const box = await loc.boundingBox()
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
  })

  test('A12: under `pointer: coarse` both inputs compute 16px (no iOS focus zoom); on desktop the canon 15px', async ({ browser, baseURL }) => {
    const TOKEN = 'GLFIVECOARSE22'
    const coarse = await browser.newContext({ baseURL, viewport: { width: 378, height: 800 }, hasTouch: true, isMobile: true })
    try {
      const page = await coarse.newPage()
      await gl5Open(page, TOKEN, gl5Body(), {}, { width: 378, height: 800 })
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'non-vacuity: the context IS coarse').toBe(true)
      await expect(page.getByTestId('waitlist-name')).toHaveCSS('font-size', '16px')
      await expect(page.getByTestId('waitlist-phone')).toHaveCSS('font-size', '16px')
    } finally {
      await coarse.close()
    }
  })

  test('the page\'s OWN copy carries no „cyklus"/„kolo" (the ONE regex) — every variant, the form and both banners', async ({ page }) => {
    const TOKEN = 'GLFIVEVOCAB222'
    const variants = [
      gl5Body(),
      gl5Body({ kind: 'planned_note', plan_note: 'po Vianociach', cycle_name: 'X' }),
      gl5Body({ kind: 'unknown' }),
      gl5Body({ kind: 'open_elsewhere', cycle_name: 'Nové' }, { stale_cycle: { id: 1, name: 'Staré' } }),
    ]
    for (const body of variants) {
      await page.unroute(`**/api/guest/${TOKEN}`)
      await page.unroute(`**/api/guest/${TOKEN}/waitlist`)
      await gl5Open(page, TOKEN, body)
      const copy = await page.evaluate(collectAppCopy())
      expect(copy, 'non-vacuity').toContain('AKO TO FUNGUJE')
      expect(copy, body.next.kind).not.toMatch(BANNED)
    }
    // Both success banners.
    for (const tick of [true, false]) {
      await page.evaluate((k) => localStorage.removeItem(k), GL5_STORAGE_KEY)
      await page.unroute(`**/api/guest/${TOKEN}`)
      await page.unroute(`**/api/guest/${TOKEN}/waitlist`)
      await gl5Open(page, TOKEN, gl5Body())
      const form = page.getByTestId('waitlist-form')
      await form.getByTestId('waitlist-name').fill('Ema')
      await form.getByTestId('waitlist-phone').fill('0905 111 222')
      if (!tick) await form.getByRole('checkbox', { name: GL5_FORM.consent }).click()
      await form.getByTestId('waitlist-submit').click()
      await expect(page.getByTestId('waitlist-done')).toBeVisible()
      expect(await page.evaluate(collectAppCopy())).not.toMatch(BANNED)
    }
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 — against the real server (a legacy link on a LOCKED cycle)', () => {
  test('the full page renders off the server\'s own payload: closed chrome, hero, steps, form iff waitlist.available, preview iff preview; no third-party request; token not in the DOM', async ({ page, baseURL }) => {
    const host = await makeHost('Gl5Real')
    const cycle = await makeCycle('Gl5Real')
    await addProduct(cycle.id, 'Gl5Real')
    const link = await shareLink(host, cycle.id)
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    const res = await ctx.get(`/api/guest/${link.token}`)
    expect(res.status()).toBe(200)
    const api = await res.json()
    expect(api.page, 'non-vacuity: pre-open').toBe('preopen')

    const origin = new URL(baseURL || process.env.BASE_URL || 'http://localhost:3997').origin
    const external = []
    let seen = 0
    page.on('request', (req) => {
      const url = req.url()
      if (!/^https?:/i.test(url)) return
      seen++
      if (new URL(url).origin !== origin) external.push(url)
    })
    await page.setViewportSize(GL2_PHONE)
    await page.goto(`/g/${link.token}`)
    const hero = page.getByTestId('preopen-hero')
    await expect(hero).toBeVisible()
    await expect(page.locator('.app .appbar .chip.p2-lock')).toHaveCount(1)
    await expect(page.locator('.app .ticker span')).toContainText(GL5_TICKER_CLOSED)
    await expect(page).toHaveTitle(GL5_DOC_TITLE)
    await expect(hero).toContainText(host.name.split(' ')[0])
    await expect(page.getByTestId('preopen-steps').getByTestId('guest-step')).toHaveCount(3)
    await expect(page.getByTestId('waitlist-form')).toHaveCount(api.waitlist.available ? 1 : 0)
    const hasPreview = Boolean(api.preview && api.preview.products.length)
    await expect(page.getByTestId('preopen-preview')).toHaveCount(hasPreview ? 1 : 0)
    if (hasPreview) {
      await expect(page.getByTestId('preopen-preview-head')).toContainText(`Minulá ponuka · ${api.preview.cycle.name}`)
      await expect(page.getByTestId('preopen-preview').locator('button')).toHaveCount(0)
    }
    await expect(page.getByTestId('cartbar')).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    expect(seen, 'non-vacuity: requests were observed').toBeGreaterThan(0)
    expect(external).toEqual([])
    expect(await page.content()).not.toContain(link.token)
    expect(await hOverflow(page)).toBeLessThanOrEqual(0)
  })

  test('a legacy link on a LOCKED cycle while a NEWER round is open (real server, real browser): lock chip, closed ticker, preopen-hero, the stale headline, and no waitlist form', async ({ page }) => {
    const host = await makeHost('Gl5Newer')
    const old = await makeCycle('Gl5NewerOld')
    await addProduct(old.id, 'Gl5NewerOld')
    const link = await shareLink(host, old.id)
    expect((await admin(`/api/cycles/${old.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    // A second, OPEN cycle — makeCycle defaults to status 'open' — so `openElsewhere`
    // is deterministically true regardless of what other spec files left lying open
    // (19 §UC-GL-002 rule 4, the same fixture shape as the D7 API test above).
    await makeCycle('Gl5NewerNew')
    const firstName = host.name.split(' ')[0]

    await page.setViewportSize(GL2_PHONE)
    await page.goto(`/g/${link.token}`)
    const hero = page.getByTestId('preopen-hero')
    await expect(hero).toBeVisible()
    await expect(page.locator('.app .appbar .chip.p2-lock'), 'the lock chip').toHaveCount(1)
    await expect(page.locator('.app .ticker span'), 'the closed ticker').toContainText(GL5_TICKER_CLOSED)
    await expect(hero.locator('h1'), 'the stale headline, not the planned/unknown one').toHaveText('Táto objednávka je už uzavretá')
    await expect(hero, 'the host is named twice, no gendered pronoun').toContainText(`${firstName} má práve otvorenú novú objednávku. Požiadajte ${firstName} o aktuálny odkaz.`)
    await expect(page.getByTestId('waitlist-form'), 'no form once a newer round is open').toHaveCount(0)
    await expect(page.getByTestId('waitlist-done')).toHaveCount(0)
    expect(await page.content()).not.toContain(link.token)
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 — keyboard (against the running server\'s own payload, mocked listing)', () => {
  test('Tab walks name → phone → consent → submit in order; Enter on the focused submit button submits', async ({ page }) => {
    const TOKEN = 'GLFIVEKEYBOARD'
    const seen = await gl5Open(page, TOKEN, gl5Body())
    const form = page.getByTestId('waitlist-form')
    const name = form.getByTestId('waitlist-name')
    const phone = form.getByTestId('waitlist-phone')
    const consent = form.getByRole('checkbox', { name: GL5_FORM.consent })
    const submit = form.getByTestId('waitlist-submit')

    await name.fill('Kika')
    await phone.fill('0905 123 456')
    await name.focus()
    await expect(name).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(phone, 'Tab from name lands on phone').toBeFocused()
    await page.keyboard.press('Tab')
    await expect(consent, 'Tab from phone lands on the consent checkbox').toBeFocused()
    await page.keyboard.press('Tab')
    await expect(submit, 'Tab from consent lands on the submit button').toBeFocused()

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('waitlist-done')).toBeVisible()
    expect(seen.posts.length, 'Enter on the focused button submitted exactly once').toBe(1)
    expect(seen.posts[0].body).toEqual({ name: 'Kika', phone: '0905 123 456', whatsapp_opt_in: true })
  })
})

test.describe('GL-T5 · 19 §UC-GL-006 item 5 — the faded read-only preview at 320px', () => {
  test('320px: still no steppers/buttons, the photo is not clickable (dispatched click opens no lightbox), and the tabs are not tab-stops', async ({ page }) => {
    await gl5Open(page, 'GLFIVE320READ', gl5Body(), {}, GL2_PHONE_320)
    const preview = page.getByTestId('preopen-preview')
    await expect(preview).toBeVisible()
    await expect(preview.locator('.vbox'), 'non-vacuity: the variant boxes still render').not.toHaveCount(0)
    await expect(preview.locator('button')).toHaveCount(0)
    await expect(preview.locator('.stepper')).toHaveCount(0)
    await expect(preview.getByTestId('stock-bar')).toHaveCount(0)
    await expect(preview.locator('[role="button"]')).toHaveCount(0)
    await expect(preview.locator('[tabindex]:not([tabindex="-1"])'), 'no tab stop inside the preview at 320px').toHaveCount(0)
    await preview.locator('img').first().dispatchEvent('click')
    await page.waitForTimeout(200)
    await expect(page.getByRole('dialog'), 'the photo does not open the lightbox').toHaveCount(0)
    await expect(page.locator('.app button:enabled')).toHaveCount(0)
  })
})

test.describe('GL-T5 · source pins — extend, never fork', () => {
  test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)

  const src = (rel) => {
    const raw = readFileSync(join(FRONTEND_SRC_DIR, rel), 'utf8')
    const stripped = stripComments(raw)
    expect(stripped.length, `${rel} survived the comment strip`).toBeGreaterThan(200)
    return stripped
  }

  test('GuestProductGrid gains a `readonly` Boolean prop (default false); the view mounts THAT grid twice and no second grid exists', () => {
    const grid = src('components/GuestProductGrid.vue')
    expect(grid).toMatch(/readonly:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    const view = src('views/GuestOrder.vue')
    expect((view.match(/<GuestProductGrid\b/g) || []).length, 'live grid + preview').toBe(2)
    expect(view).toMatch(/<GuestProductGrid[^>]*\breadonly\b/)
    const components = readdirSync(join(FRONTEND_SRC_DIR, 'components'))
    expect(components.filter((f) => /preview|grid/i.test(f) && f !== 'GuestProductGrid.vue'), 'no forked preview grid').toEqual([])
  })

  test('GuestBrandHeader: a `closed` Boolean picks between TWO module constants — still no free-text ticker prop', () => {
    const header = src('components/GuestBrandHeader.vue')
    expect(header).toMatch(/closed:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/)
    expect(header).toContain(`const GUEST_TICKER_CLOSED = '${GL5_TICKER_CLOSED}'`)
    expect(header).toContain("const GUEST_TICKER = '")
    expect(header, 'no ticker prop').not.toMatch(/\bticker:\s*\{/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T6 · 19 §UC-GL-008 item 1 — waitingLabel() (lib/plural.js, plain node)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('GL-T6 · 19 §UC-GL-008 — waitingLabel() (lib/plural.js, imported by plain node)', () => {
  test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)

  test('1 človek čaká / 2–4 ľudia čakajú / 5+ ľudí čaká — the verb agrees with the count; junk ⇒ 0', async () => {
    const { waitingLabel } = await import('file://' + join(FRONTEND_SRC_DIR, 'lib', 'plural.js'))
    const cases = [
      [1, '1 človek čaká na váš odkaz'],
      [2, '2 ľudia čakajú na váš odkaz'], [3, '3 ľudia čakajú na váš odkaz'], [4, '4 ľudia čakajú na váš odkaz'],
      [5, '5 ľudí čaká na váš odkaz'], [11, '11 ľudí čaká na váš odkaz'], [21, '21 ľudí čaká na váš odkaz'],
      [0, '0 ľudí čaká na váš odkaz'], [null, '0 ľudí čaká na váš odkaz'], ['x', '0 ľudí čaká na váš odkaz'],
      ['3', '3 ľudia čakajú na váš odkaz'],
    ]
    for (const [n, want] of cases) expect(waitingLabel(n), String(n)).toBe(want)
    for (const [, want] of cases) expect(BANNED.test(want), want).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T6 · 19 PO block (2026-09-19) — the admin friend detail's standing-link row
// ═════════════════════════════════════════════════════════════════════════════
// `FriendDetail.vue` (`/admin/friends/:id`, reached from AdminFriends' „Detail"):
// a read-only row + „Vygenerovať nový". ⚠ THE TOKEN NEVER REACHES THE DOM — not as
// text, not as an attribute: the URL is composed in JS at click time and handed to the
// clipboard (CycleDetail's §UC-GR-007 admin rule; a rendered token is a credential in
// every screenshot). ⚠ PO-VISIBLE FACT, pinned: the admin GET mints lazily, so OPENING
// a friend's detail gives that friend a standing token (a gradual back-fill of every
// friend the admin opens — 19 has no bulk back-fill). An INACTIVE friend with no token
// is never minted one (409 `inactive_host`); one WITH a token keeps it rotatable.
const GL6_REFUSAL = 'Priateľ je deaktivovaný - stály odkaz pre hostí by nefungoval. Najprv ho aktivujte.'
const GL6_CONFIRM = 'Starý stály odkaz prestane fungovať. Objednávky, ktoré kolegovia už vytvorili, zostanú funkčné.'

async function gl6Friend(label) {
  const name = `GL6 ${label} ${uniq}`
  const res = await admin('/api/friends', { method: 'post', data: { name, phone: '0905 000 222' } })
  expect(res.status(), 'friend create').toBe(201)
  return { ...(await res.json()), name }
}

function gl6Token(friendId) {
  return readRows('SELECT guest_link_token AS t FROM friends WHERE id = ?', friendId)[0].t
}

async function gl6AdoptUi(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  adminToken = token
}

async function gl6Detail(page, friend) {
  await page.goto(`/admin/friends/${friend.id}`)
  const row = page.getByTestId('standing-link-admin')
  await expect(row).toBeVisible()
  return row
}

test.describe('GL-T6 · 19 PO block — FriendDetail standing-link row + „Vygenerovať nový"', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('⚠ opening the detail MINTS (the PO-visible lazy back-fill); the token is never in the DOM; „Kopírovať odkaz" puts the full URL on the clipboard; a reload does not re-mint', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const friend = await gl6Friend('Mint')
    expect(gl6Token(friend.id), 'non-vacuity: nothing minted yet').toBe(null)

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const row = await gl6Detail(page, friend)
    await expect(row).toContainText('Stály odkaz pre hostí')
    const copy = row.getByTestId('standing-link-admin-copy')
    await expect(copy).toHaveText('Kopírovať odkaz')
    const token = gl6Token(friend.id)
    expect(token, 'the admin GET behind the page minted one').toMatch(TOKEN_RE)

    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html, 'the token is not rendered — text or attribute').not.toContain(token)

    await copy.click()
    await expect(copy).toHaveText('Skopírované!')
    const origin = await page.evaluate(() => window.location.origin)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/g/${token}`)
    await expect(copy).toHaveText('Kopírovať odkaz', { timeout: 5000 })

    await page.reload()
    await expect(page.getByTestId('standing-link-admin-copy')).toBeVisible()
    expect(gl6Token(friend.id), 'a read never re-mints').toBe(token)
    await expect(row.getByTestId('standing-link-admin-refused')).toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-dead')).toHaveCount(0)
  })

  test('„Vygenerovať nový": inline confirm (exact copy); „Nie" rotates nothing; „Áno, vygenerovať" rotates — the old URL 404s, the copy row hands out the NEW one, neither token in the DOM', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const friend = await gl6Friend('Regen')
    const before = (await adminStanding(friend.id)).standing.token

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const row = await gl6Detail(page, friend)
    const trigger = row.getByTestId('standing-link-admin-regen')
    await expect(trigger).toHaveText('Vygenerovať nový')
    await expect(row.getByTestId('standing-link-admin-confirm')).toHaveCount(0)
    await trigger.click()
    const confirm = row.getByTestId('standing-link-admin-confirm')
    await expect(confirm).toContainText(GL6_CONFIRM)
    await expect(trigger, 'the trigger yields to its confirmation').toHaveCount(0)

    await confirm.getByRole('button', { name: 'Nie', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    expect(gl6Token(friend.id), '„Nie" rotates nothing — read back').toBe(before)

    await row.getByTestId('standing-link-admin-regen').click()
    await row.getByTestId('standing-link-admin-confirm').getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(row.getByTestId('standing-link-admin-regenerated')).toBeVisible()
    await expect(row.getByTestId('standing-link-admin-confirm')).toHaveCount(0)
    const after = gl6Token(friend.id)
    expect(after).toMatch(TOKEN_RE)
    expect(after).not.toBe(before)
    expect((await ctx.get(`/api/guest/${before}`)).status(), 'the old URL 404s').toBe(404)

    await row.getByTestId('standing-link-admin-copy').click()
    const origin = await page.evaluate(() => window.location.origin)
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/g/${after}`)
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html).not.toContain(before)
    expect(html).not.toContain(after)
  })

  test('an INACTIVE friend with NO token: the refusal is stated, no control is offered, and NOTHING is minted — read back', async ({ page }) => {
    const friend = await gl6Friend('Inactive')
    expect((await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const row = await gl6Detail(page, friend)
    await expect(row.getByTestId('standing-link-admin-refused')).toHaveText(GL6_REFUSAL)
    await expect(row.getByTestId('standing-link-admin-copy')).toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-regen')).toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-error'), 'a refusal is not a failure').toHaveCount(0)
    expect(gl6Token(friend.id), 'the 409 minted nothing').toBe(null)
  })

  test('an INACTIVE friend WITH a token: marked as not working, still copyable, still ROTATABLE (revocation)', async ({ page }) => {
    const friend = await gl6Friend('Dead')
    const before = (await adminStanding(friend.id)).standing.token
    expect((await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    const row = await gl6Detail(page, friend)
    await expect(row.getByTestId('standing-link-admin-dead')).toBeVisible()
    await expect(row.getByTestId('standing-link-admin-copy')).toBeVisible()
    await row.getByTestId('standing-link-admin-regen').click()
    await row.getByTestId('standing-link-admin-confirm').getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(row.getByTestId('standing-link-admin-regenerated')).toBeVisible()
    expect(gl6Token(friend.id)).not.toBe(before)
  })

  test('a FAILED regenerate says so in ITS OWN sentence (not „načítať"), keeps the confirm, rotates nothing — read back', async ({ page }) => {
    const friend = await gl6Friend('RegenFail')
    const before = (await adminStanding(friend.id)).standing.token
    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)
    await page.route(`**/api/friends/${friend.id}/guest-link/standing/regenerate`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))
    const row = await gl6Detail(page, friend)
    await row.getByTestId('standing-link-admin-regen').click()
    await row.getByTestId('standing-link-admin-confirm').getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(row.getByTestId('standing-link-admin-regen-error')).toHaveText('Nový odkaz sa nepodarilo vygenerovať: Chyba servera')
    await expect(row.getByTestId('standing-link-admin-error'), 'the READ did not fail').toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-regenerated')).toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-copy'), 'the existing link stays usable').toBeVisible()
    expect(gl6Token(friend.id)).toBe(before)
  })

  test('a FAILED read is stated as a failure (not a refusal, not „no link"); the regenerate is disabled AND JS-guarded while pending — ONE POST', async ({ page }) => {
    const friend = await gl6Friend('Guard')
    await adminStanding(friend.id)
    await page.setViewportSize({ width: 1280, height: 900 })
    await gl6AdoptUi(page)

    await page.route(`**/api/friends/${friend.id}/guest-link/standing`, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))
    let row = await gl6Detail(page, friend)
    await expect(row.getByTestId('standing-link-admin-error')).toContainText('Chyba servera')
    await expect(row.getByTestId('standing-link-admin-copy')).toHaveCount(0)
    await expect(row.getByTestId('standing-link-admin-refused')).toHaveCount(0)
    await page.unroute(`**/api/friends/${friend.id}/guest-link/standing`)

    const posts = []
    await page.route(`**/api/friends/${friend.id}/guest-link/standing/regenerate`, async (route) => {
      posts.push(1)
      await new Promise((r) => setTimeout(r, 15000))
      await route.continue().catch(() => {})
    })
    row = await gl6Detail(page, friend)
    await row.getByTestId('standing-link-admin-regen').click()
    const yes = row.getByTestId('standing-link-admin-confirm').getByRole('button', { name: /Áno, vygenerovať|Generujem/ })
    await yes.click()
    await expect(yes).toHaveText('Generujem...', { timeout: 3000 })
    await expect(yes).toBeDisabled({ timeout: 3000 })
    await yes.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(posts, 'exactly ONE regenerate request').toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GL-T6b · 19 §UC-GL-008 — the HOST share dialog's standing section
// ═════════════════════════════════════════════════════════════════════════════
// `GuestShareDialog.vue` (the ONE friend-surface instance, in `FriendOrder.vue`):
// the standing section FIRST (`standing-link`: „Stály odkaz pre kolegov" +
// NeoCopyRow + the standing copy + the „kto čaká" COUNT + „Nový stály odkaz" with its
// own `standing-confirm`), then the demoted per-cycle section under „Odkaz len na
// túto objednávku" (`per-cycle-label` + `per-cycle-link`, rendered only with a
// `cycleId`). ⚠ The standing URL IS rendered (NeoCopyRow's text + `title`), exactly as
// the per-cycle one is — a host share URL by spec (§UC-GL-008 placement bullet 3),
// NOT the admin's no-token-in-DOM rule. ⚠ COUNT ONLY: the payload carries no names.
const GL6B_STANDING_COPY = 'Tento odkaz platí stále — pred otvorením objednávky, počas nej aj po nej. Kolegovia cez neho uvidia aktuálnu objednávku, alebo sa zapíšu, aby dostali správu, keď sa otvorí.'
const GL6B_URL_RE = /\/g\/[A-Z2-9]{14}$/

// The session-restore idiom (share-dialog.spec.js): a RESTORE is not a login, so
// neither the explainer gate nor the profile auto-open can raise over the landing.
async function gl6bSignIn(page, host, { share = false, viewport = { width: 378, height: 900 } } = {}) {
  await page.setViewportSize(viewport)
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: host.id, friendName: host.name, token: host.token, expiresAt: Date.now() + 864e5 }))
  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGL6B', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
  if (share) {
    await page.addInitScript(() => {
      window.__shared = []
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data) => { window.__shared.push(data); return Promise.resolve() },
      })
    })
  }
}

// The landing's cartbar icon — it exists only for the CURRENT (newest) open round,
// which every caller satisfies by creating its cycle immediately before.
async function gl6bOpen(page) {
  await page.goto('/')
  await expect(page.getByTestId('portal-landing')).toBeVisible()
  await page.locator('.app .cartbar').getByRole('button', { name: 'Zdieľať s kolegami' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

let gl6bPhoneSeq = 0
function gl6bPlant(hostId, name, { notified = null } = {}) {
  // Unique per row: (host, phone_e164) is a partial UNIQUE index (GL-T1).
  const digits = `${phoneSeed.slice(-3)}${String(++gl6bPhoneSeq).padStart(3, '0')}`
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return Number(db.prepare(
      'INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, whatsapp_opt_in, notified_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(hostId, name, `0905 ${digits}`, `+421905${digits}`, notified).lastInsertRowid)
  } finally {
    db.close()
  }
}

test.describe('GL-T6b · 19 §UC-GL-008 — the host share dialog: standing section first', () => {
  test('with an open round BOTH sections render, standing FIRST; the copy row is the standing URL (text + clipboard); exact copy; no count at 0; the per-cycle section is intact below its label', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const host = await makeHost('Gl6bOrder')
    const cycle = await makeCycle('Gl6bOrder')
    const link = await shareLink(host, cycle.id)

    const payloads = []
    await page.route('**/api/guest-links/standing', async (route) => {
      const res = await route.fetch()
      payloads.push(await res.json())
      await route.fulfill({ response: res })
    })
    await gl6bSignIn(page, host)
    const dialog = await gl6bOpen(page)

    const section = dialog.getByTestId('standing-link')
    const url = section.getByTestId('standing-link-url')
    await expect(url).toHaveText(GL6B_URL_RE)
    const standingNow = (await standing(host)).standing
    const origin = await page.evaluate(() => window.location.origin)
    await expect(url).toHaveText(`${origin}${standingNow.url_path}`)
    expect(standingNow.token, 'the standing token is not the per-cycle one').not.toBe(link.token)

    await expect(section.locator('.field-lbl')).toHaveText('Stály odkaz pre kolegov')
    await expect(section.getByTestId('standing-copy')).toHaveText(GL6B_STANDING_COPY)
    await expect(section.getByTestId('standing-copy')).toHaveClass('field-help')
    // Count 0 ⇒ NO line (non-vacuity: the section around it rendered, above).
    await expect(dialog.getByTestId('waiting-count')).toHaveCount(0)
    await expect(section.getByRole('button', { name: 'Nový stály odkaz' })).toBeVisible()

    // Order: standing section → per-cycle label → per-cycle section.
    await expect(dialog.getByTestId('per-cycle-label')).toHaveText('Odkaz len na túto objednávku')
    await expect(dialog.getByTestId('per-cycle-link').getByTestId('guest-link-url')).toHaveText(`${origin}/g/${link.token}`)
    const order = await dialog.evaluate((modal) => {
      const at = (id) => modal.querySelector(`[data-testid="${id}"]`)
      const F = Node.DOCUMENT_POSITION_FOLLOWING
      return {
        standingBeforeLabel: !!(at('standing-link').compareDocumentPosition(at('per-cycle-label')) & F),
        labelBeforeSection: !!(at('per-cycle-label').compareDocumentPosition(at('per-cycle-link')) & F),
        perCycleOutsideStanding: !at('standing-link').contains(at('per-cycle-link')),
      }
    })
    expect(order).toEqual({ standingBeforeLabel: true, labelBeforeSection: true, perCycleOutsideStanding: true })

    // The standing copy button hands out the STANDING url.
    // A name locator would stop resolving the moment the label flips — hold the node.
    const copy = section.locator('.copyrow button')
    await expect(copy).toHaveText('Kopírovať')
    await copy.click()
    await expect(copy).toHaveText('Skopírované!')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}${standingNow.url_path}`)

    // Placement constraints: no new p.sub, subtitle keeps ONE <b>, no button named /Zdieľať/ here.
    await expect(dialog.locator('p.sub')).toHaveCount(0)
    await expect(dialog.locator('.m-head .sub b')).toHaveCount(1)
    await expect(section.getByRole('button', { name: /Zdieľať/ })).toHaveCount(0)

    // COUNT ONLY — the payload the dialog read carries no names/phones/rows.
    expect(payloads.length, 'the dialog read the standing link').toBeGreaterThan(0)
    for (const body of payloads) {
      for (const k of ['name', 'phone', 'rows']) {
        expect(Object.prototype.hasOwnProperty.call(body, k), k).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(body.standing, k), `standing.${k}`).toBe(false)
      }
    }
  })

  test('the count line: absent at 0, „1 človek čaká na váš odkaz" after one signup, „2 ľudia čakajú…" after two — a notified row is not counted, and no name reaches the DOM', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const host = await makeHost('Gl6bCount')
    await makeCycle('Gl6bCount')
    await gl6bSignIn(page, host)

    let dialog = await gl6bOpen(page)
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(GL6B_URL_RE)
    await expect(dialog.getByTestId('waiting-count')).toHaveCount(0)
    await page.keyboard.press('Escape')

    const first = `Čakateľ Prvý ${uniq}`
    gl6bPlant(host.id, first)
    gl6bPlant(host.id, `Už upozornený ${uniq}`, { notified: '2026-09-01 10:00:00' })
    dialog = await gl6bOpen(page)
    const line = dialog.getByTestId('waiting-count')
    await expect(line).toHaveText('1 človek čaká na váš odkaz')
    await expect(line.locator('span.badge.acc')).toHaveText('1 človek čaká na váš odkaz')
    expect(await page.evaluate(() => document.documentElement.outerHTML), 'count only — no name').not.toContain(first)
    // Inside the standing section, under the copy text.
    expect(await dialog.evaluate((m) => m.querySelector('[data-testid="standing-link"]').contains(m.querySelector('[data-testid="waiting-count"]')))).toBe(true)
    await page.keyboard.press('Escape')

    gl6bPlant(host.id, `Čakateľ Druhý ${uniq}`)
    dialog = await gl6bOpen(page)
    await expect(dialog.getByTestId('waiting-count')).toHaveText('2 ľudia čakajú na váš odkaz')
  })

  test('„Nový stály odkaz": its OWN confirm (`standing-confirm`, not `.confirmbox`, exact copy); „Nie" rotates nothing; „Áno, vygenerovať" rotates in place — the old URL 404s, the row shows the new one; the per-cycle link is untouched', async ({ page }) => {
    const host = await makeHost('Gl6bRegen')
    const cycle = await makeCycle('Gl6bRegen')
    const link = await shareLink(host, cycle.id)
    const before = (await standing(host)).standing
    await gl6bSignIn(page, host)
    const dialog = await gl6bOpen(page)
    const section = dialog.getByTestId('standing-link')
    const origin = await page.evaluate(() => window.location.origin)
    await expect(section.getByTestId('standing-link-url')).toHaveText(`${origin}${before.url_path}`)

    const trigger = section.getByRole('button', { name: 'Nový stály odkaz' })
    await expect(dialog.getByTestId('standing-confirm')).toHaveCount(0)
    await trigger.click()
    const box = dialog.getByTestId('standing-confirm')
    await expect(box).toBeVisible()
    await expect(box).toHaveClass('standing-confirm')
    await expect(box).toContainText(GL6_CONFIRM)
    await expect(box.locator('b'), 'no bold lead — this is not the per-cycle box').toHaveCount(0)
    await expect(dialog.locator('.confirmbox'), 'the per-cycle .confirmbox stays closed').toHaveCount(0)
    await expect(trigger, 'the trigger yields to its confirmation').toHaveCount(0)
    for (const name of ['Áno, vygenerovať', 'Nie']) await expect(box.getByRole('button', { name, exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Zdieľať/ })).toHaveCount(0)

    await box.getByRole('button', { name: 'Nie', exact: true }).click()
    await expect(dialog.getByTestId('standing-confirm')).toHaveCount(0)
    expect((await standing(host)).standing.token, '„Nie" rotates nothing — read back').toBe(before.token)

    await section.getByRole('button', { name: 'Nový stály odkaz' }).click()
    await dialog.getByTestId('standing-confirm').getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(dialog.getByTestId('standing-confirm')).toHaveCount(0)
    const after = (await standing(host)).standing
    expect(after.token).not.toBe(before.token)
    await expect(section.getByTestId('standing-link-url')).toHaveText(`${origin}${after.url_path}`)
    expect((await ctx.get(`/api/guest/${before.token}`)).status(), 'the old standing URL 404s').toBe(404)
    // Nothing else moved: the per-cycle row still shows (and the server still holds) its token.
    await expect(dialog.getByTestId('guest-link-url')).toHaveText(`${origin}/g/${link.token}`)
    expect((await hostView(host, cycle.id)).link.token).toBe(link.token)
  })

  test('the two confirms never stand open together (they share „Áno, vygenerovať")', async ({ page }) => {
    const host = await makeHost('Gl6bBoth')
    const cycle = await makeCycle('Gl6bBoth')
    await shareLink(host, cycle.id)
    await gl6bSignIn(page, host)
    const dialog = await gl6bOpen(page)
    await dialog.getByRole('button', { name: 'Nový stály odkaz' }).click()
    await expect(dialog.getByTestId('standing-confirm')).toBeVisible()
    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    await expect(dialog.locator('.confirmbox')).toBeVisible()
    await expect(dialog.getByTestId('standing-confirm')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Áno, vygenerovať' })).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Nový stály odkaz' }).click()
    await expect(dialog.getByTestId('standing-confirm')).toBeVisible()
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Áno, vygenerovať' })).toHaveCount(1)
  })

  test('a FAILED regenerate says so in its own sentence, keeps the confirm and the old URL; a pending one is disabled AND JS-guarded — ONE POST', async ({ page }) => {
    const host = await makeHost('Gl6bRegenFail')
    await makeCycle('Gl6bRegenFail')
    const before = (await standing(host)).standing
    await gl6bSignIn(page, host)
    await page.route('**/api/guest-links/standing/regenerate', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))
    let dialog = await gl6bOpen(page)
    const origin = await page.evaluate(() => window.location.origin)
    await dialog.getByRole('button', { name: 'Nový stály odkaz' }).click()
    await dialog.getByTestId('standing-confirm').getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(dialog.getByTestId('standing-regen-error')).toHaveText('Nový stály odkaz sa nepodarilo vygenerovať: Chyba servera')
    await expect(dialog.getByTestId('standing-confirm'), 'the confirm stays for a retry').toBeVisible()
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(`${origin}${before.url_path}`)
    await expect(dialog.getByTestId('standing-error'), 'the READ did not fail').toHaveCount(0)
    expect((await standing(host)).standing.token).toBe(before.token)
    await page.keyboard.press('Escape')
    await page.unroute('**/api/guest-links/standing/regenerate')

    const posts = []
    await page.route('**/api/guest-links/standing/regenerate', async (route) => {
      posts.push(1)
      await new Promise((r) => setTimeout(r, 15000))
      await route.continue().catch(() => {})
    })
    dialog = await gl6bOpen(page)
    await expect(dialog.getByTestId('standing-regen-error'), 'a reopen starts clean').toHaveCount(0)
    await dialog.getByRole('button', { name: 'Nový stály odkaz' }).click()
    const yes = dialog.getByTestId('standing-confirm').getByRole('button', { name: /Áno, vygenerovať|Generujem/ })
    await yes.click()
    await expect(yes).toHaveText('Generujem...', { timeout: 3000 })
    await expect(yes).toBeDisabled({ timeout: 3000 })
    await yes.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(posts, 'exactly ONE regenerate request').toHaveLength(1)
  })

  test('a FAILED standing read is stated in the standing section; the per-cycle section still works and native share FALLS BACK to the per-cycle URL', async ({ page }) => {
    const host = await makeHost('Gl6bReadFail')
    const cycle = await makeCycle('Gl6bReadFail')
    const link = await shareLink(host, cycle.id)
    await gl6bSignIn(page, host, { share: true })
    await page.route('**/api/guest-links/standing', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chyba servera' }) }))
    const dialog = await gl6bOpen(page)
    const section = dialog.getByTestId('standing-link')
    await expect(section.getByTestId('standing-error')).toContainText('Stály odkaz sa nepodarilo načítať: Chyba servera')
    await expect(section.locator('.copyrow')).toHaveCount(0)
    await expect(section.getByRole('button', { name: 'Nový stály odkaz' })).toHaveCount(0)
    const origin = await page.evaluate(() => window.location.origin)
    await expect(dialog.getByTestId('per-cycle-link').getByTestId('guest-link-url')).toHaveText(`${origin}/g/${link.token}`)
    const share = dialog.getByRole('button', { name: 'Zdieľať odkaz' })
    await expect(share, 'ONE share button, in the per-cycle section').toHaveCount(1)
    await expect(dialog.getByTestId('per-cycle-link').getByRole('button', { name: 'Zdieľať odkaz' })).toHaveCount(1)
    await share.click()
    expect((await page.evaluate(() => window.__shared))[0].url).toBe(`${origin}/g/${link.token}`)
  })

  test('with native share: ONE „Zdieľať odkaz", in the STANDING section, sharing the standing URL (item 3)', async ({ page }) => {
    const host = await makeHost('Gl6bNative')
    const cycle = await makeCycle('Gl6bNative')
    await shareLink(host, cycle.id)
    await gl6bSignIn(page, host, { share: true })
    const dialog = await gl6bOpen(page)
    const share = dialog.getByRole('button', { name: 'Zdieľať odkaz' })
    await expect(share).toHaveCount(1)
    await expect(dialog.getByTestId('standing-link').getByRole('button', { name: 'Zdieľať odkaz' })).toHaveCount(1)
    await share.click()
    const origin = await page.evaluate(() => window.location.origin)
    expect(await page.evaluate(() => window.__shared)).toEqual([{
      title: 'Objednávka Podpultovka',
      text: `Pridajte sa k mojej objednávke - ${cycle.name}`,
      url: `${origin}${(await standing(host)).standing.url_path}`,
    }])
  })

  test('⚠ loadSeq: a SLOW standing read from a previous open cannot overwrite the reopened dialog\'s link', async ({ page }) => {
    const host = await makeHost('Gl6bSeq')
    await makeCycle('Gl6bSeq')
    const old = (await standing(host)).standing
    await gl6bSignIn(page, host)
    let calls = 0
    await page.route('**/api/guest-links/standing', async (route) => {
      calls += 1
      // Fetched NOW (so it carries the OLD token), delivered late.
      const res = await route.fetch()
      if (calls === 1) await new Promise((r) => setTimeout(r, 4000))
      await route.fulfill({ response: res }).catch(() => {})
    })
    await page.goto('/')
    await expect(page.getByTestId('portal-landing')).toBeVisible()
    const icon = page.locator('.app .cartbar').getByRole('button', { name: 'Zdieľať s kolegami' })
    await icon.click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.waitForTimeout(500) // the first GET has been fetched with the OLD token
    await page.keyboard.press('Escape')
    const fresh = (await regenerate(host)).standing
    await icon.click()
    const dialog = page.getByRole('dialog')
    const origin = await page.evaluate(() => window.location.origin)
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(`${origin}${fresh.url_path}`)
    await page.waitForTimeout(4500) // the held first response has landed by now
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(`${origin}${fresh.url_path}`, { timeout: 500 })
    expect(old.token).not.toBe(fresh.token)
  })

  test('320px: the count badge and the open standing confirm add no overflow and clip no control', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    const host = await makeHost('Gl6bNarrow')
    const cycle = await makeCycle('Gl6bNarrow')
    await shareLink(host, cycle.id)
    for (let i = 0; i < 12; i++) gl6bPlant(host.id, `Úzky ${i} ${uniq}`)
    await gl6bSignIn(page, host, { share: true, viewport: { width: 320, height: 900 } })
    const dialog = await gl6bOpen(page)
    await expect(dialog.getByTestId('waiting-count')).toHaveText('12 ľudí čaká na váš odkaz')
    await dialog.getByRole('button', { name: 'Nový stály odkaz' }).click()
    await expect(dialog.getByTestId('standing-confirm')).toBeVisible()
    const bad = await dialog.evaluate((modal) => {
      const box = modal.getBoundingClientRect()
      const out = []
      for (const el of modal.querySelectorAll('[data-testid="standing-link"] *')) {
        const r = el.getBoundingClientRect()
        if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5)) out.push(el.className || el.tagName)
      }
      for (const el of modal.querySelectorAll('.btn')) if (el.scrollWidth > el.clientWidth + 1) out.push(`min-content:${el.textContent.trim()}`)
      return out
    })
    expect(bad).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  })

  // Entry point A (05's own — share-dialog.spec.js's `openFromOrderPage`): the deep
  // link `/cycle/:id`'s Kolegovia tab opens the SAME `GuestShareDialog` instance as
  // the landing cartbar icon (entry point B, `gl6bOpen`), so it must render both
  // GL-T6b sections in the same order, not just the per-cycle one every shipped
  // Kolegovia-tab test predates this row and only ever checked.
  test('the /cycle/:id deep link\'s Kolegovia tab opens the same dialog, standing FIRST, per-cycle intact below', async ({ page }) => {
    const host = await makeHost('Gl6bDeep')
    const cycle = await makeCycle('Gl6bDeep')
    const link = await shareLink(host, cycle.id)
    await gl6bSignIn(page, host)
    await gotoCycle(page, cycle.id)
    await page.getByTestId('main-tab-guests').click()
    await page.getByRole('button', { name: /Zdieľať/ }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    const origin = await page.evaluate(() => window.location.origin)
    const standingNow = (await standing(host)).standing
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(`${origin}${standingNow.url_path}`)
    await expect(dialog.getByTestId('per-cycle-label')).toHaveText('Odkaz len na túto objednávku')
    await expect(dialog.getByTestId('per-cycle-link').getByTestId('guest-link-url')).toHaveText(`${origin}/g/${link.token}`)

    const standingFirst = await dialog.evaluate((modal) => {
      const at = (id) => modal.querySelector(`[data-testid="${id}"]`)
      return !!(at('standing-link').compareDocumentPosition(at('per-cycle-link')) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(standingFirst, 'same ordering as the landing entry point').toBe(true)
  })

  // 18 §UC-PI-019's shell rules (`NeoModal`/`use-modal-layer.js`) are pinned generically
  // elsewhere. ⚠ NOT a focus-TRAP pin: `NeoModal`'s `trapping` computed is
  // `trapFocus === null ? !closable : trapFocus` and this dialog never sets
  // `trapFocus`, so — being `closable` (the default) — it deliberately has NO trap
  // (RD-FL-2: only non-closable GATES opt in; measured live, Tab #8 here lands on
  // `<body>`, exactly as `modern-login.spec.js`'s gate spec would red if a GATE did
  // the same). What this pins instead is that GL-T6b's TWO NEW rows of controls
  // (the standing copy button + "Nový stály odkaz") sit in the tab order in the
  // right place — BETWEEN the × and the demoted per-cycle section's own three — so
  // a control Tab skips does not survive unnoticed, and that Esc still closes it.
  test('keyboard: Tab walks the standing section\'s controls, then the per-cycle section\'s, in order; Esc closes the dialog', async ({ page }) => {
    const host = await makeHost('Gl6bKbd')
    const cycle = await makeCycle('Gl6bKbd')
    await shareLink(host, cycle.id)
    await gl6bSignIn(page, host)
    const dialog = await gl6bOpen(page)
    // Both sections resolve their own async GET (`loadSeq` per §UC-GL-008's data
    // note) — wait for BOTH copy rows before walking Tab, or a slow response under
    // load makes the not-yet-rendered controls invisible to the same walk.
    await expect(dialog.getByTestId('standing-link-url')).toHaveText(GL6B_URL_RE)
    await expect(dialog.getByTestId('per-cycle-link').getByTestId('guest-link-url')).toBeVisible()

    const seen = []
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab')
      seen.push(await page.evaluate(() => {
        const el = document.activeElement
        return {
          inStanding: !!el?.closest('[data-testid="standing-link"]'),
          inPerCycle: !!el?.closest('[data-testid="per-cycle-link"]'),
          text: (el?.textContent || el?.getAttribute('aria-label') || '').trim(),
        }
      }))
    }
    // 1: the × (outside either section) · 2–3: standing (copy, regenerate) ·
    // 4–6: per-cycle (copy, deactivate, regenerate) · 7: the footer "Zavrieť".
    expect(seen[0]).toEqual({ inStanding: false, inPerCycle: false, text: 'Zatvoriť dialóg' })
    expect(seen.filter((s) => s.inStanding).map((s) => s.text)).toEqual(['Kopírovať', 'Nový stály odkaz'])
    expect(seen.filter((s) => s.inPerCycle).map((s) => s.text)).toEqual(['Kopírovať', 'Deaktivovať odkaz', 'Vygenerovať nový odkaz'])
    expect(seen[6]).toEqual({ inStanding: false, inPerCycle: false, text: 'Zavrieť' })

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

test.describe('GL-T6b/T6c · source pins — cycleId = null, one mount', () => {
  test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)

  // ~~⚠ `cycleId = null` has NO reachable UI trigger today~~ — SUPERSEDED by GL-T6c:
  // the drawer row now reaches the one dialog on the locked and closed landings with
  // `cycleId = null` (`FriendOrder.vue shareCycleId`), behaviour-pinned in
  // `portal-landing.spec.js` §3 (standing URL rendered, per-cycle label/section and
  // GET absent). These SOURCE pins stay as the component-level half: the standing read does not wait
  // on a cycle, and every per-cycle node is gated on `cycleId`.
  test('the standing read is not gated on cycleId; the per-cycle label and section are', () => {
    const raw = readFileSync(join(FRONTEND_SRC_DIR, 'components', 'GuestShareDialog.vue'), 'utf8')
    const src = stripComments(raw)
    expect(src.length, 'readability gate').toBeGreaterThan(raw.length * 0.3)
    const script = src.slice(0, src.indexOf('<template>'))
    const template = src.slice(src.indexOf('<template>'))

    const standingWatch = script.match(/watch\(\(\) => props\.open, async \(isOpen\) => \{\s*const seq = \+\+standingSeq[\s\S]*?\n\}, \{ immediate: true \}\)/)
    expect(standingWatch, 'a standing watcher of its own').not.toBeNull()
    expect(standingWatch[0]).toContain('api.getStandingGuestLink()')
    expect(standingWatch[0], 'never waits on a cycle').not.toMatch(/cycleId/)

    expect(template).toMatch(/<div\s+v-if="cycleId"[^>]*data-testid="per-cycle-label"/)
    expect(template).toMatch(/v-else-if="cycleId"[^>]*data-testid="per-cycle-link"|data-testid="per-cycle-link"[^>]*v-else-if="cycleId"/)
    // …and the standing section is not.
    const standingTag = template.match(/<div[^>]*data-testid="standing-link"[^>]*>/)
    expect(standingTag).not.toBeNull()
    expect(standingTag[0]).not.toMatch(/cycleId/)
  })

  // GL-T6c: the ONE mount (FriendOrder.vue) decides its own `cycleId` — `null` on a
  // read-only landing mount, synchronously, from the PROP (a loaded-cycle-only test
  // would hand the dialog the round's id until the order GET lands, or forever if it
  // fails — the closed landing's stubbed rounds in portal-landing §3 are that case).
  test('GL-T6c · FriendOrder binds the dialog to `shareCycleId`, null on a readonly mount', () => {
    const raw = readFileSync(join(FRONTEND_SRC_DIR, 'views', 'FriendOrder.vue'), 'utf8')
    const src = stripComments(raw)
    expect(src.length, 'readability gate').toBeGreaterThan(raw.length * 0.3)
    expect(src).toMatch(/const shareCycleId = computed\(\(\) => \(isReadonly\.value \|\| isLocked\.value \? null : activeCycleId\.value\)\)/)
    const mount = src.match(/<GuestShareDialog[\s\S]*?\/>/)
    expect(mount).not.toBeNull()
    expect(mount[0]).toContain(':cycle-id="shareCycleId"')
    expect(mount[0]).not.toContain('activeCycleId')
    expect(mount[0], 'the name goes with the id').toContain(`:cycle-name="shareCycleId ? (cycle?.name || '') : ''"`)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// GP-T7 · PO decision (3) 2026-09-24 — the pre-open „Ako to funguje" Packeta clause
// ═════════════════════════════════════════════════════════════════════════════
// `next.parcel_enabled` (ADDITIVE). ~~The card shows the clause UNLESS it is an explicit `0`.~~
// → FINAL RULE (2026-09-25, learnings 12 §48): planned/unknown kinds ALWAYS show the clause
// (a planned round's flag defaults to 0 and is not a real „off", so it is published `null`);
// `open_elsewhere` follows the OPEN round's real flag (PO: Packeta in ~all future rounds).
test.describe('GP-T7 · (3) the pre-open payload publishes the next round\'s parcel flag (throwaway boot)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a PLANNED round never publishes its flag (null, ON or OFF — the column default is not a decision); nothing planned ⇒ null; open_elsewhere carries the OPEN round\'s real flag', () => {
    const { file, cleanup } = tempDb()
    try {
      const out = probe(file, GL2_FIXTURE() + `
        const host = mkF('Janka Hostiteľová');
        const tok = sl.ensureStandingToken(host);
        const r = {};
        r.none = L(tok).body.next;
        const p = cyc('planned', 'planned', { opens_at: '2026-11-20' });
        r.off = L(tok).body.next;
        db.run('UPDATE order_cycles SET parcel_enabled = 1 WHERE id = ?', [p]);
        r.on = L(tok).body.next;
        // a legacy link on a locked round while a newer one is OPEN (D7's stale variant)
        const old = cyc('old', 'locked');
        const legacy = 'GPSEVENLEGACY2';
        db.run('INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES (?, ?, ?)', [legacy, host, old]);
        const open = cyc('open one', 'open');
        r.elsewhereOff = L(legacy).body.next;
        db.run('UPDATE order_cycles SET parcel_enabled = 1 WHERE id = ?', [open]);
        r.elsewhereOn = L(legacy).body.next;
        return r;
      `, { helper: true, guest: true })
      expect(out.none, 'no planned round ⇒ null (the card then SHOWS the clause)').toEqual({ kind: 'unknown', opens_at: null, plan_note: null, cycle_name: null, parcel_enabled: null })
      expect(out.off.parcel_enabled, 'a planned round with the column default 0 ⇒ null').toBe(null)
      expect(out.on, 'a planned round switched ON is not published either').toEqual({ kind: 'planned_date', opens_at: '2026-11-20', plan_note: null, cycle_name: 'planned', parcel_enabled: null })
      expect(out.elsewhereOff).toEqual({ kind: 'open_elsewhere', opens_at: null, plan_note: null, cycle_name: 'open one', parcel_enabled: 0 })
      expect(out.elsewhereOn.parcel_enabled, 'the open round\'s own flag').toBe(1)
      for (const n of [out.none, out.off, out.on, out.elsewhereOff, out.elsewhereOn]) {
        expect(Object.keys(n).sort()).toEqual(NEXT_KEYS)
      }
    } finally {
      cleanup()
    }
  })
})

test.describe('GP-T7 · (3) the pre-open „Ako to funguje" card ALWAYS shows the Packeta clause, except a stale link whose OPEN round has parcels off', () => {
  // Orchestrator decision 2026-09-25: a PLANNED round's `parcel_enabled` is the column
  // default 0 (never written at plan time), so it is not read — planned_date /
  // planned_note / unknown ALWAYS show the clause, even with a (stray) 0 in the payload.
  const ON = 'Od Janka, alebo si ju nechajte poslať cez Packetu.'
  const OFF = 'Od Janka.'
  const cases = [
    ['planned_date, parcel_enabled null', { kind: 'planned_date', opens_at: gl5Day(28), cycle_name: 'X', parcel_enabled: null }, ON],
    ['planned_date, a stray 0 is IGNORED', { kind: 'planned_date', opens_at: gl5Day(28), cycle_name: 'X', parcel_enabled: 0 }, ON],
    ['planned_note, a stray 0 is IGNORED', { kind: 'planned_note', plan_note: 'po Vianociach', cycle_name: 'X', parcel_enabled: 0 }, ON],
    ['unknown, nothing planned (null)', { kind: 'unknown', parcel_enabled: null }, ON],
    ['an OLDER server without the key', { kind: 'unknown', parcel_enabled: undefined }, ON],
  ]
  for (const [label, next, want] of cases) {
    test(`${label} ⇒ the clause`, async ({ page }) => {
      await gl5Open(page, 'GPSEVENSTEPS22', gl5Body(next))
      const detail = page.getByTestId('preopen-steps').getByTestId('guest-step-detail')
      await expect(detail, 'non-vacuity: three details').toHaveCount(3)
      await expect(detail.nth(2)).toHaveText(want)
    })
  }

  test('the STALE variant (open_elsewhere) follows the OPEN round\'s real flag: 0 / missing ⇒ no clause, 1 ⇒ the clause', async ({ page }) => {
    for (const [flag, want] of [[0, OFF], [undefined, OFF], [1, ON]]) {
      await page.unroute('**/api/guest/GPSEVENSTALE22')
      await page.unroute('**/api/guest/GPSEVENSTALE22/waitlist')
      await gl5Open(page, 'GPSEVENSTALE22', gl5Body({ kind: 'open_elsewhere', cycle_name: 'Nové', parcel_enabled: flag }, { stale_cycle: { id: 1, name: 'Staré' } }))
      await expect(page.getByTestId('preopen-steps').getByTestId('guest-step-detail').nth(2), String(flag)).toHaveText(want)
    }
  })

  test('source pin: ONE computed still feeds all three mounts; only open_elsewhere reads the flag', () => {
    test.skip(!HAS_FRONTEND_SRC, NEEDS_FRONTEND_SRC)
    const view = stripComments(readFileSync(join(FRONTEND_SRC_DIR, 'views', 'GuestOrder.vue'), 'utf8'))
    expect(view, 'readability gate').toContain('preopen-steps')
    expect(view).toMatch(/const stepsPacketa = computed\(\(\) => \(preopen\.value\s*\?\s*preopenParcelAllowed\(preopen\.value\.next\)\s*:\s*parcelEnabled\.value\)\)/)
    expect(view).toMatch(/function preopenParcelAllowed\(next\) \{\s*if \(next\?\.kind === 'open_elsewhere'\) return Number\(next\.parcel_enabled\) === 1\s*return true\s*\}/)
  })
})
