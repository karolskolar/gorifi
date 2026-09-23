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
// ⚠ What GL-T1 does NOT do: resolve a standing token on `/g/:token`. That is GL-T2's
// `resolveEntry()`. Until it lands EVERY standing token answers the uniform 404, so
// the „old token 404s after regenerate" pin below is forward-compatible rather than
// discriminating today — the discriminating half of the regenerate contract in this
// row is „nothing else moves", proven by reading the rows back.
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

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const SCHEMA_URL = 'file://' + join(BACKEND_SRC, 'db', 'schema.js')
const HELPER_URL = 'file://' + join(BACKEND_SRC, 'helpers', 'standing-link.js')

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
function probe(dbFile, body, { helper = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gl-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    "import crypto from 'node:crypto';\n" +
      `import db from '${SCHEMA_URL}';\n` +
      (helper ? `import * as sl from '${HELPER_URL}';\n` : 'const sl = null;\n') +
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
