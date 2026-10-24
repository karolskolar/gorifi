// Module 21 — WA-T1, the FOUNDATION row: 21 §UC-WA-001 (outbox schema completion,
// phone/opt-in columns, settings seeds), §UC-WA-002 (`toE164()` adopted at EVERY phone
// writer + the one-time back-fill), §UC-WA-003 (`whatsapp_opt_in` defaults per creation
// path, the strict-boolean write surface, the profile checkbox) and Decision D6 (the
// guest checkout's consent sentence).
//
// ⚠ NOT `whatsapp-outbox.spec.js`. 21 §UC-WA-014 item 2 names that file for the
// composer/release/enqueue obligations of LATER rows (WA-T2…T8); this file is the
// schema + phone + consent foundation only, so the two never fight over one name.
//
// THREE KINDS OF EVIDENCE, each where only it can work:
//   §1 THROWAWAY BOOTS — a child `node` imports `db/schema.js` against a temp file (the
//      `distribution-foundation` / `guest-waitlist` idiom), so the MIGRATION is proven
//      on a database that already existed in the DP-T1 shape, not just on a fresh one,
//      and constraint errors are read through better-sqlite3 — the driver the routes
//      load (CLAUDE.md: node:sqlite reports different constraint codes).
//   §2 HTTP against the gate server — every writer of a phone column, read back through
//      the admin detail / the friend's own profile, and (with `DB_PATH`) the guest
//      sub-order row, which no API publishes `phone_e164` on.
//   §3 UI — the profile modal's MODULE 21 SLOT and the guest checkout sentence.
//
// NOTE ON RATE LIMITS: friend/admin auth sit on `authLimiter`; run with the raised
// budget (e2e/README.md).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { ackExplainer, expectLanding, openProfile as portalOpenProfile } from '../helpers/portal.js'
import { stripComments } from '../helpers/source-pins.js'

const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const TEMPLATE_DB = join(REPO_ROOT, 'e2e', 'fixtures', 'prod-template.sqlite')
const url = (rel) => 'file://' + join(BACKEND_SRC, rel)

// Module 21's fixed strings (21 §UC-WA-003 + D6) — reproduced, never improved.
const OPT_IN_LABEL = 'Chcem dostávať správy o objednávke cez WhatsApp'
const PRIVACY = 'Vaše číslo používame len na správy o vašej objednávke a jej odovzdaní. Súhlas môžete kedykoľvek zrušiť tu v profile.'
// PO 2026-10-22: TY-form, like the rest of the guest surface (spec 21 D6's vy-form „vám“ struck).
const GUEST_SENTENCE = 'Na toto číslo ti pošleme správu, keď bude objednávka pripravená.'
const OPT_IN_400 = { error: 'Neplatný formát údajov (súhlas so správami cez WhatsApp)', field: 'whatsapp_opt_in' }
const NO_IDENTITY_401 = 'Prihláste sa svojím menom a heslom'

// DP-T1's sixteen, then the two WA-T1 columns — the ORDER both the fresh CREATE and
// the ALTER path produce.
const NOTIFICATION_COLUMNS = [
  'id', 'channel', 'template_key', 'segment_key', 'recipient_kind', 'recipient_id',
  'phone_e164', 'body', 'status', 'cycle_id', 'order_id', 'guest_order_id',
  'created_at', 'released_at', 'sent_at', 'error', 'sent_via', 'email',
]

// The DP-T1 table VERBATIM (what every deployed database holds before WA-T1's boot).
const DP_T1_NOTIFICATIONS = `
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
    template_key TEXT NOT NULL,
    segment_key TEXT,
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('friend','guest','waitlist')),
    recipient_id INTEGER,
    phone_e164 TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','released','sent','failed','skipped')),
    cycle_id INTEGER,
    order_id INTEGER,
    guest_order_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    released_at DATETIME,
    sent_at DATETIME,
    error TEXT
  )`

// ═════════════════════════════════════════════════════════════════════════════
// The throwaway-boot probe. Importing schema.js IS a backend restart's migration run.
// ═════════════════════════════════════════════════════════════════════════════
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t1-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${url('db/schema.js')}';\n` +
      `import * as outbox from '${url('helpers/outbox.js')}';\n` +
      `import { toE164 } from '${url('helpers/phone.js')}';\n` +
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

const boot = (dbFile) => probe(dbFile, 'return true;')

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t1-db-'))
  try {
    return fn(join(dir, 'wa-t1.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function shape(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const info = (t) => db.prepare(`PRAGMA table_info(${t})`).all()
    return {
      notificationsSql: String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get()?.sql || ''),
      notificationColumns: info('notifications').map((c) => c.name),
      friends: Object.fromEntries(info('friends').map((c) => [c.name, c])),
      guestOrders: Object.fromEntries(info('guest_orders').map((c) => [c.name, c])),
      indexes: Object.fromEntries(
        db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notifications' AND sql IS NOT NULL")
          .all().map((r) => [r.name, String(r.sql).replace(/\s+/g, ' ')])
      ),
      settings: Object.fromEntries(
        db.prepare("SELECT key, value FROM settings WHERE key IN ('whatsapp_test_phone', 'whatsapp_paused')").all().map((r) => [r.key, r.value])
      ),
    }
  } finally {
    db.close()
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 Schema — 21 §UC-WA-001, on a fresh file AND on the DP-T1 shape
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T1 · 21 §UC-WA-001 — the schema (throwaway boots)', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('a FRESH boot: the full outbox shape, the three indexes, both phone/opt-in columns, the two settings', () => {
    withTempDb((file) => {
      boot(file)
      const s = shape(file)
      expect(s.notificationColumns, 'DP-T1 sixteen + sent_via + email, in that order').toEqual(NOTIFICATION_COLUMNS)
      const sql = s.notificationsSql.replace(/\s+/g, ' ')
      expect(sql).toContain("recipient_kind IN ('friend','guest','waitlist','admin')")
      expect(sql).toContain("sent_via IN ('bot','wa_me','email')")
      expect(sql, 'segment_key stays NULLABLE (module 16 writes body/segment rows itself)').toMatch(/segment_key TEXT,/)
      expect(sql, 'body stays NULLABLE (§UC-DP-008 writes NULL)').toMatch(/body TEXT,/)
      expect(sql, 'no foreign keys (DELETE /cycles/:id must neither block nor cascade)').not.toMatch(/REFERENCES/i)

      expect(Object.keys(s.indexes).sort()).toEqual(['idx_notifications_group', 'idx_notifications_queued_once', 'idx_notifications_status'])
      expect(s.indexes.idx_notifications_status).toMatch(/ON notifications\(status\)$/)
      expect(s.indexes.idx_notifications_group).toMatch(/ON notifications\(cycle_id, segment_key\)$/)
      expect(s.indexes.idx_notifications_queued_once).toMatch(/^CREATE UNIQUE INDEX/)
      expect(s.indexes.idx_notifications_queued_once)
        .toMatch(/ON notifications\(template_key, recipient_kind, recipient_id, cycle_id\) WHERE status = 'queued'$/)

      expect(s.friends.phone_e164, 'friends.phone_e164').toBeTruthy()
      expect(s.friends.whatsapp_opt_in?.dflt_value, 'friends.whatsapp_opt_in DEFAULT 1').toBe('1')
      expect(s.guestOrders.phone_e164, 'guest_orders.phone_e164').toBeTruthy()
      expect(s.settings).toEqual({ whatsapp_test_phone: '', whatsapp_paused: '0' })
    })
  })

  test('⚠ the DP-T1 table is RECREATED in place: every row and id kept, the AUTOINCREMENT mark carried over, \'admin\' accepted; a third boot is a no-op', () => {
    withTempDb((file) => {
      boot(file)
      // Put the table back to what every deployed database holds before WA-T1.
      const db = new DatabaseSync(file)
      db.exec('DROP TABLE notifications')
      db.exec(DP_T1_NOTIFICATIONS)
      // ~~segment_key 'loc1'~~ → WA-T4: the same boot now RE-KEYS DP-T3's legacy
      // `loc<id>` rows onto 21's grammar (pinned in whatsapp-handover-enqueue.spec.js §1),
      // so a legacy key would change under this byte-for-byte claim. A 21-grammar key keeps
      // this test about the RECREATE alone.
      for (let i = 1; i <= 5; i++) {
        db.exec(
          "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, body, status, cycle_id, order_id) " +
          `VALUES ('whatsapp', 'pickup', 'handed_over:pickup:1:2026-10-24', 'friend', ${i}, ${i === 2 ? "'Ahoj'" : 'NULL'}, '${i === 3 ? 'sent' : 'queued'}', 9, ${100 + i})`
        )
      }
      db.exec('DELETE FROM notifications WHERE id = 5') // the high-water mark is now ABOVE every surviving id
      const before = db.prepare('SELECT * FROM notifications ORDER BY id').all()
      expect(() => db.exec("INSERT INTO notifications (channel, template_key, recipient_kind) VALUES ('whatsapp', 'test', 'admin')"),
        'non-vacuity: the DP-T1 CHECK really refuses admin').toThrow()
      db.close()
      expect(shape(file).notificationColumns, 'non-vacuity: the old shape').toHaveLength(16)

      boot(file)
      const s = shape(file)
      expect(s.notificationColumns).toEqual(NOTIFICATION_COLUMNS)
      expect(s.notificationsSql).toContain("'admin'")
      expect(Object.keys(s.indexes).sort(), 'indexes rebuilt after the recreate').toEqual(['idx_notifications_group', 'idx_notifications_queued_once', 'idx_notifications_status'])

      const after = new DatabaseSync(file)
      try {
        const rows = after.prepare('SELECT * FROM notifications ORDER BY id').all()
        expect(rows.map((r) => ({ ...r }))).toEqual(before.map((r) => ({ ...r, sent_via: null, email: null })))
        after.exec("INSERT INTO notifications (channel, template_key, recipient_kind, sent_via) VALUES ('whatsapp', 'test', 'admin', 'bot')")
        const fresh = after.prepare("SELECT id FROM notifications WHERE recipient_kind = 'admin'").get()
        expect(fresh.id, 'the deleted id 5 is never re-issued').toBe(6)
        expect(() => after.exec("INSERT INTO notifications (channel, template_key, recipient_kind, sent_via) VALUES ('whatsapp', 'test', 'admin', 'sms')"),
          'the sent_via CHECK bites').toThrow()
      } finally {
        after.close()
      }

      const sqlBefore = shape(file).notificationsSql
      boot(file)
      expect(shape(file).notificationsSql, 'a later boot leaves the table alone').toBe(sqlBefore)
      const count = new DatabaseSync(file, { readOnly: true })
      try {
        expect(count.prepare('SELECT COUNT(*) AS n FROM notifications').get().n).toBe(5)
      } finally {
        count.close()
      }
    })
  })

  test('⚠ the partial unique index: a 2nd QUEUED row fails (and is recognised as „already queued"), a 2nd SENT one does not — read through better-sqlite3', () => {
    const out = withTempDb((file) => probe(file, `
      const ins = (status, { tpl = 'pickup', kind = 'friend', rid = 7, cyc = 3 } = {}) => {
        try {
          db.run("INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, status, cycle_id) VALUES ('whatsapp', ?, 'loc1', ?, ?, ?, ?)", [tpl, kind, rid, status, cyc]);
          return 'ok';
        } catch (e) {
          return { code: e.code, conflict: outbox.isQueuedOnceConflict(e) };
        }
      };
      const r = {};
      r.q1 = ins('queued');
      r.q2 = ins('queued');
      r.s1 = ins('sent');
      r.s2 = ins('sent');
      r.otherCycle = ins('queued', { cyc: 4 });
      r.otherTemplate = ins('queued', { tpl: 'packeta' });
      r.otherKind = ins('queued', { kind: 'guest' });
      r.admin1 = ins('queued', { kind: 'admin', rid: null, cyc: null, tpl: 'test' });
      r.admin2 = ins('queued', { kind: 'admin', rid: null, cyc: null, tpl: 'test' });
      db.run("UPDATE notifications SET status = 'released' WHERE status = 'queued' AND recipient_kind = 'friend' AND template_key = 'pickup' AND cycle_id = 3");
      r.afterRelease = ins('queued');
      try { db.run("INSERT INTO notifications (channel, template_key, recipient_kind, sent_via) VALUES ('whatsapp', 'x', 'admin', 'sms')"); r.check = 'ok'; }
      catch (e) { r.check = { code: e.code, conflict: outbox.isQueuedOnceConflict(e) }; }
      return r;
    `))
    expect(out.q1).toBe('ok')
    expect(out.q2.code, 'the second queued row hits the partial unique index').toMatch(/^SQLITE_CONSTRAINT/)
    expect(out.q2.conflict, 'isQueuedOnceConflict recognises it').toBe(true)
    expect(out.s1).toBe('ok')
    expect(out.s2, 'a second SENT row is history, not a duplicate').toBe('ok')
    expect(out.otherCycle).toBe('ok')
    expect(out.otherTemplate).toBe('ok')
    expect(out.otherKind).toBe('ok')
    expect(out.admin1).toBe('ok')
    expect(out.admin2, 'NULL recipient/cycle never collide (the test message)').toBe('ok')
    expect(out.afterRelease, 'once released, a new queued row is a new event').toBe('ok')
    expect(out.check.code, 'non-vacuity: a CHECK failure').toMatch(/^SQLITE_CONSTRAINT/)
    expect(out.check.conflict, 'a DIFFERENT constraint is never read as „already queued"').toBe(false)
  })

  // ~~DP-T3's enqueue cannot 500 on the new index … `enqueueForHandOver([bag(o1), bag(o2)])`~~
  // → WA-T4 (21 §UC-WA-006) changed the seam's signature to IDS and keyed its pre-check
  // on the index's own tuple, so the conflict is caught BEFORE the INSERT. The claim this
  // test exists for is unchanged and re-asserted on the new signature: two orders of one
  // friend in one cycle queue ONE row, nothing throws, the stamps commit. (The ownership
  // rule on un-hand-over lives in whatsapp-handover-enqueue.spec.js §1.)
  test('⚠ the enqueue cannot 500 on the new index: a friend with TWO orders in one cycle queues ONE row and the hand-over stamp in the same transaction survives', () => {
    const out = withTempDb((file) => probe(file, `
      db.run("INSERT INTO order_cycles (name, status) VALUES ('wa-t1', 'locked')");
      const cyc = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
      const loc = db.run("INSERT INTO pickup_locations (name) VALUES ('WA-T1 Miesto')").lastInsertRowid;
      const fid = db.run("INSERT INTO friends (cycle_id, name, access_token, phone, phone_e164) VALUES (?, 'Dvojitý', 'acc-dvojity', '0905 123 456', '+421905123456')", [cyc]).lastInsertRowid;
      const o1 = db.run("INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id) VALUES (?, ?, 'submitted', 1, ?)", [fid, cyc, loc]).lastInsertRowid;
      const o2 = db.run("INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id) VALUES (?, ?, 'submitted', 1, ?)", [fid, cyc, loc]).lastInsertRowid;
      let result; let error = null;
      try {
        db.transaction(() => {
          db.run('UPDATE orders SET handed_over_at = CURRENT_TIMESTAMP WHERE id IN (?, ?)', [o1, o2]);
          result = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o1, o2] });
        })();
      } catch (e) { error = e.message; }
      return {
        result, error,
        rows: db.all('SELECT order_id, status FROM notifications WHERE cycle_id = ?', [cyc]),
        stamped: db.all('SELECT id FROM orders WHERE cycle_id = ? AND handed_over_at IS NOT NULL', [cyc]).length,
      };
    `))
    expect(out.error, 'no throw out of the hand-over transaction').toBe(null)
    expect(out.result.queued, 'ONE message queued').toBe(1)
    expect(out.result.already, 'the second bag is „already queued", counted, not queued').toBe(1)
    expect(out.rows).toHaveLength(1)
    expect(out.stamped, 'the transaction committed the stamps').toBe(2)
  })

  test('⚠ the settings seeds never overwrite the admin\'s values', () => {
    withTempDb((file) => {
      boot(file)
      const db = new DatabaseSync(file)
      db.exec("UPDATE settings SET value = '+421905000111' WHERE key = 'whatsapp_test_phone'")
      db.exec("UPDATE settings SET value = '1' WHERE key = 'whatsapp_paused'")
      db.close()
      boot(file)
      expect(shape(file).settings).toEqual({ whatsapp_test_phone: '+421905000111', whatsapp_paused: '1' })
    })
  })

  test('⚠ the ALTER + back-fill on a database that lacked the columns: existing friends read whatsapp_opt_in = 1, phone_e164 derived for both tables, NULL where it does not normalise, idempotent', () => {
    withTempDb((file) => {
      // Rows created with the columns present, then the columns taken BACK OFF — the
      // state every deployed database is in — so only the ALTERs + back-fill can restore them.
      probe(file, `
        db.run("INSERT INTO order_cycles (name, status) VALUES ('bf', 'open')");
        const cyc = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
        const mk = (n, phone) => db.run('INSERT INTO friends (cycle_id, name, access_token, phone, whatsapp_opt_in) VALUES (?, ?, ?, ?, 0)', [cyc, n, 'acc-' + n, phone]).lastInsertRowid;
        const host = mk('national', '0905 123 456');
        mk('plus', '+421 905 123 457'); mk('garbage', '123'); mk('nophone', null); mk('czech', '+420 601 234 567');
        const link = db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES ('WAT1BACKFILL01', ?, ?)", [host, cyc]).lastInsertRowid;
        const g = (tok, phone) => db.run("INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone) VALUES (?, ?, 'Hosť', ?)", [link, tok, phone]);
        g('WAT1ORD0000001', '00421905123458'); g('WAT1ORD0000002', '0000000000');
        return true;
      `)
      const db = new DatabaseSync(file)
      db.exec('ALTER TABLE friends DROP COLUMN phone_e164')
      db.exec('ALTER TABLE friends DROP COLUMN whatsapp_opt_in')
      db.exec('ALTER TABLE guest_orders DROP COLUMN phone_e164')
      db.close()
      const stripped = shape(file)
      expect(stripped.friends.whatsapp_opt_in, 'non-vacuity: the column really is gone').toBeUndefined()
      expect(stripped.guestOrders.phone_e164, 'non-vacuity').toBeUndefined()

      boot(file)
      const read = () => {
        const r = new DatabaseSync(file, { readOnly: true })
        try {
          return {
            friends: Object.fromEntries(r.prepare('SELECT name, phone, phone_e164, whatsapp_opt_in FROM friends').all().map((f) => [f.name, { ...f }])),
            guests: Object.fromEntries(r.prepare('SELECT order_token, guest_phone, phone_e164 FROM guest_orders').all().map((o) => [o.order_token, { ...o }])),
          }
        } finally {
          r.close()
        }
      }
      const a = read()
      for (const f of Object.values(a.friends)) expect(f.whatsapp_opt_in, `${f.name}: existing rows read 1 (R5.5)`).toBe(1)
      expect(a.friends.national).toMatchObject({ phone: '0905 123 456', phone_e164: '+421905123456' })
      expect(a.friends.plus.phone_e164).toBe('+421905123457')
      expect(a.friends.czech.phone_e164, '+420 stays Czech').toBe('+420601234567')
      expect(a.friends.garbage).toMatchObject({ phone: '123', phone_e164: null })
      expect(a.friends.nophone.phone_e164).toBe(null)
      expect(a.guests.WAT1ORD0000001).toMatchObject({ guest_phone: '00421905123458', phone_e164: '+421905123458' })
      expect(a.guests.WAT1ORD0000002.phone_e164, 'a non-normalising guest phone stays NULL').toBe(null)

      // Idempotent: a hand-set value is never re-derived (only NULL rows are read).
      const w = new DatabaseSync(file)
      w.exec("UPDATE friends SET phone_e164 = '+421900000000' WHERE name = 'national'")
      w.close()
      boot(file)
      const b = read()
      expect(b.friends.national.phone_e164, 'a set value is left alone').toBe('+421900000000')
      expect(b.friends.garbage.phone_e164, 'a failing row is merely re-tried').toBe(null)
    })
  })

  test('a copy of the PRODUCTION template: every friend reads whatsapp_opt_in = 1 and every phone_e164 is toE164(phone)', () => {
    test.skip(!existsSync(TEMPLATE_DB), 'no e2e/fixtures/prod-template.sqlite on this box')
    withTempDb((file) => {
      copyFileSync(TEMPLATE_DB, file)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(TEMPLATE_DB + suffix)) copyFileSync(TEMPLATE_DB + suffix, file + suffix)
      }
      const out = probe(file, `
        const friends = db.all('SELECT phone, phone_e164, whatsapp_opt_in FROM friends');
        const guests = db.all('SELECT guest_phone, phone_e164 FROM guest_orders');
        return {
          friends: friends.length,
          optedOut: friends.filter((f) => f.whatsapp_opt_in !== 1).length,
          friendMismatch: friends.filter((f) => f.phone != null && f.phone_e164 !== toE164(f.phone)).length,
          friendDerived: friends.filter((f) => f.phone_e164).length,
          guests: guests.length,
          guestMismatch: guests.filter((g) => g.phone_e164 !== toE164(g.guest_phone)).length,
          cols: db.all('PRAGMA table_info(notifications)').map((c) => c.name),
        };
      `)
      expect(out.friends, 'non-vacuity: the template has friends').toBeGreaterThan(0)
      expect(out.optedOut).toBe(0)
      expect(out.friendMismatch).toBe(0)
      expect(out.friendDerived, 'non-vacuity: the back-fill derived something').toBeGreaterThan(0)
      expect(out.guestMismatch).toBe(0)
      expect(out.cols).toEqual(NOTIFICATION_COLUMNS)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §1b Source pins — the „every writer" rules a grep can see
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T1 · 21 §UC-WA-002 — source pins', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)
  const src = (rel) => readFileSync(join(BACKEND_SRC, rel), 'utf8')

  test('`parsePhoneNumber` appears in helpers/phone.js ONLY', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const hits = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.js') && readFileSync(p, 'utf8').includes('parsePhoneNumber')) hits.push(p.slice(BACKEND_SRC.length + 1))
      }
    }
    walk(BACKEND_SRC)
    expect(hits).toEqual(['helpers/phone.js'])
  })

  test('every phone writer derives phone_e164 with toE164 (the 21 §UC-WA-002 table)', () => {
    const friends = stripComments(src('routes/friends.js'))
    expect(friends, 'admin POST /').toMatch(/INSERT INTO friends \([^)]*phone, email,\s*phone_e164, whatsapp_opt_in\)/)
    expect(friends, 'admin PATCH /:id').toMatch(/updates\.push\('phone_e164 = \?'\);\s*values\.push\(toE164\(phone \|\| null\)\)/)
    expect(friends, 'friend PATCH /:id/profile').toMatch(/UPDATE friends SET phone = \?, phone_e164 = \? WHERE id = \?/)
    expect(stripComments(src('routes/invitations.js')), 'approve').toMatch(/google_sub, google_email, phone_e164, whatsapp_opt_in\)\s*VALUES \([^)]*\?, 0\)/)
    expect(stripComments(src('routes/onboarding.js')), 'onboarding').toMatch(/password_hash, phone_e164, whatsapp_opt_in\)\s*VALUES \([^)]*\?, 0\)/)
    expect(stripComments(src('routes/guest.js')), 'guest checkout').toMatch(/delivery_fee, packeta_address, phone_e164\)/)
    // …and no route writes `phone = ` / `guest_phone` anywhere else (the enumeration).
    const writers = []
    for (const rel of ['routes/friends.js', 'routes/invitations.js', 'routes/onboarding.js', 'routes/guest.js', 'routes/guest-orders.js', 'routes/admin.js', 'routes/magic-link.js']) {
      if (!existsSync(join(BACKEND_SRC, rel))) continue
      const code = stripComments(src(rel))
      const inserts = code.match(/INSERT INTO (friends|guest_orders)\s*\([^)]*\)/g) || []
      for (const ins of inserts) if (/\bphone\b|guest_phone/.test(ins)) writers.push(`${rel}: ${/phone_e164/.test(ins) ? 'derives' : 'MISSING'}`)
    }
    expect(writers.filter((w) => w.endsWith('MISSING'))).toEqual([])
    expect(writers.length, 'non-vacuity: four INSERT writers seen').toBe(4)
  })

  test('⚠ the approve transaction still holds EXACTLY TWO writes (IA-T3)', () => {
    const code = stripComments(src('routes/invitations.js'))
    const start = code.indexOf('const approveInvitation = db.transaction(')
    expect(start, 'the transaction is found').toBeGreaterThan(0)
    const end = code.indexOf('});', start)
    const body = code.slice(start, end)
    expect(body.match(/db\.prepare\(/g) || []).toHaveLength(2)
    expect(body).toMatch(/INSERT INTO friends/)
    expect(body).toMatch(/UPDATE invitations/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 HTTP — every creation path's opt-in default, every phone writer's e164
// ═════════════════════════════════════════════════════════════════════════════
let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
let seq = 0
// Valid SK mobiles, unique per run: `0905` + six digits (pending invitations key on the phone).
const phoneBase = Number(String(Date.now()).slice(-5)) * 10
function validPhone() {
  return `0905${String((phoneBase + ++seq) % 1000000).padStart(6, '0')}`
}
const e164Of = (national) => `+421${national.slice(1)}`

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

test.afterAll(async () => { await ctx?.dispose() })

async function detail(id) {
  const res = await admin(`/api/friends/${id}/detail`)
  expect(res.status(), 'admin detail').toBe(200)
  return (await res.json()).friend
}

async function createFriend(label, extra = {}) {
  const res = await admin('/api/friends', { method: 'post', data: { name: `E2E WA1 ${label} ${uniq}${++seq}`, ...extra } })
  expect(res.status(), 'friend create').toBe(201)
  return res.json()
}

// A friend with their OWN Bearer session (the profile route's identity).
async function friendWithSession(label, { phone = validPhone() } = {}) {
  const friend = await createFriend(label, { phone })
  const suffix = `_${uniq}${++seq}`
  const username = `wa1${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const first = (await login.json()).token
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || first
  await ackExplainer(ctx, { id: friend.id, token })
  return { id: friend.id, name: friend.name, uid: friend.uid, username, token, phone, auth: { Authorization: `Bearer ${token}` } }
}

async function profileOf(f) {
  const res = await ctx.get(`/api/friends/${f.id}/profile`, { headers: f.auth })
  expect(res.status(), 'own profile').toBe(200)
  return res.json()
}

test.describe('WA-T1 · 21 §UC-WA-003 — opt-in defaults per creation path', () => {
  test('admin POST /api/friends ⇒ whatsapp_opt_in = 1 (PO 2026-09-19) and phone_e164 derived; a phone that does not normalise still 201s with NULL', async () => {
    const national = validPhone()
    const created = await createFriend('admin', { phone: `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}` })
    expect(created.whatsapp_opt_in, 'the 201 body carries it').toBe(1)
    const row = await detail(created.id)
    expect(row.whatsapp_opt_in).toBe(1)
    expect(row.phone_e164).toBe(e164Of(national))

    const odd = await createFriend('admin-odd', { phone: '123' })
    expect(odd.phone, 'the phone is stored AS ENTERED').toBe('123')
    expect(odd.phone_e164, 'normalisation never refuses a write').toBe(null)
    const none = await createFriend('admin-none')
    expect(none.phone_e164).toBe(null)
    expect(none.whatsapp_opt_in).toBe(1)
  })

  test('invitations approve ⇒ whatsapp_opt_in = 0 and phone_e164 from the applicant\'s phone', async () => {
    const inviter = await friendWithSession('inviter')
    const code = await ctx.get('/api/invitations/my-code', { headers: inviter.auth })
    expect(code.status()).toBe(200)
    const { inviteCode } = await code.json()
    const phone = validPhone()
    const reg = await ctx.post('/api/invitations/register', { data: { invite_code: inviteCode, name: `Nová WA1 ${uniq}${++seq}`, phone } })
    expect(reg.status(), 'register').toBe(201)
    const list = await admin('/api/invitations?status=pending')
    const invitation = (await list.json()).find((r) => r.phone === phone)
    expect(invitation, 'the pending invitation').toBeTruthy()
    const approved = await admin(`/api/invitations/${invitation.id}/approve`, {
      method: 'post', data: { username: `wa1appr${uniq}${++seq}`.slice(0, 30) },
    })
    expect(approved.status(), 'approve').toBe(201)
    const row = await detail((await approved.json()).friend.id)
    expect(row.whatsapp_opt_in, 'a new person is OFF until they tick it').toBe(0)
    expect(row.phone).toBe(phone)
    expect(row.phone_e164).toBe(e164Of(phone))
  })

  test('onboarding registration ⇒ whatsapp_opt_in = 0 and phone_e164 derived', async () => {
    const link = await admin('/api/onboarding-links', { method: 'post', data: { note: `WA1 onboarding ${uniq}` } })
    expect(link.status(), 'onboarding link').toBe(201)
    const { token } = await link.json()
    const phone = validPhone()
    const reg = await ctx.post(`/api/onboarding/${token}`, {
      data: { name: `Onboard WA1 ${uniq}${++seq}`, phone, username: `wa1onb${uniq}${++seq}`.slice(0, 30), password: 'onbPass12' },
    })
    expect(reg.status(), 'onboarding register').toBe(201)
    const row = await detail((await reg.json()).friendId)
    expect(row.whatsapp_opt_in).toBe(0)
    expect(row.phone_e164).toBe(e164Of(phone))
  })
})

test.describe('WA-T1 · 21 §UC-WA-002/003 — the two PATCH routes', () => {
  test('friend PATCH /:id/profile: phone ⇒ phone_e164 read back; whatsapp_opt_in flips; absent key untouched; the answer carries both', async () => {
    const f = await friendWithSession('profile')
    const res = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { phone: '0905123456' } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.phone_e164).toBe('+421905123456')
    expect(body.whatsapp_opt_in, 'admin-created ⇒ 1, untouched by a phone-only PATCH').toBe(1)
    expect((await profileOf(f)).phone_e164).toBe('+421905123456')

    const off = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { whatsapp_opt_in: false } })
    expect(off.status()).toBe(200)
    expect((await off.json()).whatsapp_opt_in).toBe(0)
    expect((await profileOf(f)).whatsapp_opt_in).toBe(0)

    const on = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { whatsapp_opt_in: true } })
    expect((await on.json()).whatsapp_opt_in).toBe(1)
    const zero = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { whatsapp_opt_in: 0 } })
    expect((await zero.json()).whatsapp_opt_in).toBe(0)
    const one = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { whatsapp_opt_in: 1 } })
    expect((await one.json()).whatsapp_opt_in).toBe(1)

    const nameOnly = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { name: `${f.name} 2` } })
    expect(nameOnly.status()).toBe(200)
    expect((await profileOf(f)).whatsapp_opt_in, 'absent key ⇒ untouched').toBe(1)

    const garbage = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { phone: '0000000000' } })
    expect(garbage.status(), 'normalisation never refuses').toBe(200)
    expect((await garbage.json()).phone_e164).toBe(null)
  })

  test('⚠ friend PATCH refuses every non-boolean opt-in with 400 {field} and writes NOTHING (the row is read back)', async () => {
    const f = await friendWithSession('profile-bad')
    const before = await profileOf(f)
    for (const value of ['yes', '1', 'true', null, [1], {}, 2, -1, '']) {
      const res = await ctx.patch(`/api/friends/${f.id}/profile`, {
        headers: f.auth, data: { name: 'Nikdy Nezapísané', phone: '0905999999', whatsapp_opt_in: value },
      })
      expect(res.status(), JSON.stringify(value)).toBe(400)
      expect(await res.json(), JSON.stringify(value)).toEqual(OPT_IN_400)
    }
    const after = await profileOf(f)
    expect(after.name, 'a refused body writes nothing — not even the valid name beside it').toBe(before.name)
    expect(after.phone).toBe(before.phone)
    expect(after.phone_e164).toBe(before.phone_e164)
    expect(after.whatsapp_opt_in).toBe(before.whatsapp_opt_in)
  })

  test('⚠ consent is the person\'s own: bare shared-password auth may NOT write whatsapp_opt_in (401, row unchanged)', async () => {
    const mode = (await (await ctx.get('/api/friends/auth-mode')).json()).authMode
    expect(mode, 'the seeded DB must be in the legacy window for this test to mean anything').not.toBe('modern')
    const victim = await friendWithSession('victim')
    const res = await ctx.patch(`/api/friends/${victim.id}/profile`, {
      headers: { 'X-Friends-Password': FRIENDS_PASSWORD }, data: { whatsapp_opt_in: false },
    })
    expect(res.status()).toBe(401)
    expect((await res.json()).error).toBe(NO_IDENTITY_401)
    expect((await profileOf(victim)).whatsapp_opt_in).toBe(1)
  })

  test('admin PATCH /:id: phone ⇒ phone_e164 (a cleared phone clears it), whatsapp_opt_in strict boolean, refusals write nothing', async () => {
    const f = await createFriend('adminpatch', { phone: validPhone() })
    const p = validPhone()
    const set = await admin(`/api/friends/${f.id}`, { method: 'patch', data: { phone: `+421 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7)}` } })
    expect(set.status()).toBe(200)
    expect((await set.json()).phone_e164).toBe(e164Of(p))

    const off = await admin(`/api/friends/${f.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })
    expect(off.status()).toBe(200)
    expect((await detail(f.id)).whatsapp_opt_in).toBe(0)

    for (const value of ['yes', null, [true], {}, 'false']) {
      const res = await admin(`/api/friends/${f.id}`, { method: 'patch', data: { name: 'Nezapísané', whatsapp_opt_in: value } })
      expect(res.status(), JSON.stringify(value)).toBe(400)
      expect(await res.json()).toEqual(OPT_IN_400)
    }
    const row = await detail(f.id)
    expect(row.name, 'the refused PATCH wrote nothing').toBe(f.name)
    expect(row.whatsapp_opt_in).toBe(0)

    const on = await admin(`/api/friends/${f.id}`, { method: 'patch', data: { whatsapp_opt_in: 1 } })
    expect((await on.json()).whatsapp_opt_in).toBe(1)

    const cleared = await admin(`/api/friends/${f.id}`, { method: 'patch', data: { phone: null } })
    expect(cleared.status()).toBe(200)
    const c = await cleared.json()
    expect(c.phone).toBe(null)
    expect(c.phone_e164, 'the derived twin follows the clear').toBe(null)
  })
})

test.describe('WA-T1 · 21 §UC-WA-002 — guest checkout derives guest_orders.phone_e164', () => {
  test.skip(!DB_PATH, NEEDS_DB)

  test('a normalising phone ⇒ E.164; `0000000000` still 201s with NULL', async () => {
    const host = await friendWithSession('host')
    const cyc = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA1 ${uniq}`, type: 'coffee', status: 'open' } })
    expect(cyc.status()).toBe(201)
    const cycle = await cyc.json()
    const prod = await admin('/api/products', { method: 'post', data: { cycle_id: cycle.id, name: `WA1 káva ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 } })
    expect(prod.status()).toBe(201)
    const product = await prod.json()
    const linkRes = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect([200, 201]).toContain(linkRes.status())
    const link = (await linkRes.json()).link
    const submit = async (guest_phone) => {
      const res = await ctx.post(`/api/guest/${link.token}/orders`, {
        data: { guest_name: `Hosť WA1 ${++seq}`, guest_phone, items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
      })
      expect(res.status(), `submit ${guest_phone}`).toBe(201)
      return (await res.json()).order
    }
    const ok = await submit('0905 123 456')
    const odd = await submit('0000000000')

    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const row = (id) => db.prepare('SELECT guest_phone, phone_e164 FROM guest_orders WHERE id = ?').get(id)
      expect({ ...row(ok.id) }).toEqual({ guest_phone: '0905 123 456', phone_e164: '+421905123456' })
      expect({ ...row(odd.id) }).toEqual({ guest_phone: '0000000000', phone_e164: null })
      const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key IN ('whatsapp_test_phone', 'whatsapp_paused')").all().map((r) => [r.key, r.value]))
      expect(Object.keys(settings).sort(), 'the gate server seeded both settings').toEqual(['whatsapp_paused', 'whatsapp_test_phone'])
    } finally {
      db.close()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 UI — the profile modal's MODULE 21 SLOT, and the guest checkout sentence
// ═════════════════════════════════════════════════════════════════════════════
async function signIn(page, who) {
  const stored = JSON.stringify({
    friendId: who.id, friendName: who.name, friendUid: who.uid, token: who.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
  await page.route('**/api/guest-links/cycle/*', (route) => route.abort())
}

async function openProfileModal(page) {
  await portalOpenProfile(page)
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('profile-username')).toBeVisible() // hydrated
  return dialog
}

test.describe('WA-T1 · 21 §UC-WA-003 — the profile checkbox (UI)', () => {
  test('renders between Mobil and E-mail with the module\'s two strings, seeded from the profile; unticking + Uložiť sends ONLY that change and reads back 0', async ({ page }) => {
    const f = await friendWithSession('ui')
    await signIn(page, f)
    await page.goto('/')
    await expectLanding(page)
    const dialog = await openProfileModal(page)

    const box = dialog.getByTestId('profile-whatsapp')
    await expect(box).toHaveAttribute('role', 'checkbox')
    await expect(box).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByRole('checkbox', { name: OPT_IN_LABEL, exact: true })).toHaveCount(1)
    await expect(dialog.getByTestId('profile-whatsapp-row').locator('label span').last()).toHaveText(OPT_IN_LABEL)
    await expect(dialog.getByTestId('profile-whatsapp-help')).toHaveText(PRIVACY)
    await expect(dialog.getByTestId('profile-whatsapp-help')).toHaveClass('field-help')

    // Field order: Mobil → the slot → E-mail (18 §UC-PI-015 row 3½).
    const order = await dialog.locator('.m-body').evaluate((body) =>
      [...body.querySelectorAll('#pp-profile-phone, [data-testid="profile-whatsapp-row"], #pp-profile-email')].map((e) => e.id || e.dataset.testid))
    expect(order).toEqual(['pp-profile-phone', 'profile-whatsapp-row', 'pp-profile-email'])

    // The TEXT toggles too (the remember-me pattern).
    await dialog.getByTestId('profile-whatsapp-row').locator('label span').last().click()
    await expect(box).toHaveAttribute('aria-checked', 'false')

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/friends\/\d+\/profile$/.test(new URL(r.url()).pathname))
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    const sent = (await patch).postDataJSON()
    expect(sent, 'only the changed consent rides along, as a real boolean').toEqual({ name: f.name, whatsapp_opt_in: false })
    await expect(page.locator('.m-title', { hasText: 'Upraviť profil' }), 'the modal closed on success').toHaveCount(0)
    expect((await profileOf(f)).whatsapp_opt_in).toBe(0)

    // Re-open: seeded from the merged answer, not the stale login payload.
    const again = await openProfileModal(page)
    await expect(again.getByTestId('profile-whatsapp')).toHaveAttribute('aria-checked', 'false')
  })

  test('an untouched checkbox is NOT sent (a save from a stale seed can never withdraw consent)', async ({ page }) => {
    const f = await friendWithSession('ui-untouched')
    await signIn(page, f)
    await page.goto('/')
    await expectLanding(page)
    const dialog = await openProfileModal(page)
    await dialog.locator('#pp-profile-email').fill(`wa1-${uniq}@example.test`)
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/friends\/\d+\/profile$/.test(new URL(r.url()).pathname))
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    const sent = (await patch).postDataJSON()
    expect(Object.keys(sent).sort()).toEqual(['email', 'name'])
    expect((await profileOf(f)).whatsapp_opt_in).toBe(1)
  })
})

test.describe('WA-T1 · 21 §UC-WA-003 — the profile checkbox, an opted-out friend (UI)', () => {
  test('a friend stored at 0 opens UNTICKED after a fresh load; the keyboard and the box each toggle exactly once; re-ticking sends `true` and survives a reload', async ({ page }) => {
    const f = await friendWithSession('ui-optout')
    const off = await ctx.patch(`/api/friends/${f.id}/profile`, { headers: f.auth, data: { name: f.name, whatsapp_opt_in: false } })
    expect(off.status(), 'seed the opt-out').toBe(200)
    expect((await profileOf(f)).whatsapp_opt_in).toBe(0)

    await signIn(page, f)
    await page.goto('/')
    await expectLanding(page)
    let dialog = await openProfileModal(page)
    const box = dialog.getByTestId('profile-whatsapp')
    await expect(box).toHaveAttribute('aria-checked', 'false')

    // Keyboard: focus the checkbox, Space ticks it.
    await box.focus()
    await page.keyboard.press('Space')
    await expect(box).toHaveAttribute('aria-checked', 'true')
    // A direct click on the box is ONE toggle (the label must not double it).
    await box.click()
    await expect(box).toHaveAttribute('aria-checked', 'false')
    await box.click()
    await expect(box).toHaveAttribute('aria-checked', 'true')

    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && /\/api\/friends\/\d+\/profile$/.test(new URL(r.url()).pathname))
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    expect((await patch).postDataJSON()).toEqual({ name: f.name, whatsapp_opt_in: true })
    await expect(page.locator('.m-title', { hasText: 'Upraviť profil' })).toHaveCount(0)
    expect((await profileOf(f)).whatsapp_opt_in).toBe(1)

    await page.reload()
    await expectLanding(page)
    dialog = await openProfileModal(page)
    await expect(dialog.getByTestId('profile-whatsapp')).toHaveAttribute('aria-checked', 'true')
  })
})

test.describe('WA-T1 · 21 D6 — the guest checkout consent sentence (UI)', () => {
  test('one `.field-help` under Mobil, verbatim, inside the phone field', async ({ page }) => {
    const host = await friendWithSession('guestui')
    const cyc = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA1 UI ${uniq}`, type: 'coffee', status: 'open' } })
    const cycle = await cyc.json()
    const prod = await admin('/api/products', { method: 'post', data: { cycle_id: cycle.id, name: `WA1 UI káva ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 } })
    const product = await prod.json()
    const link = (await (await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()).link

    await page.goto(`/g/${link.token}`)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')
    const help = dialog.getByTestId('guest-phone-help')
    await expect(help).toHaveText(GUEST_SENTENCE)
    await expect(help).toHaveClass('field-help')
    // It lives in the Mobil wrapper, directly after the input.
    const prev = await help.evaluate((el) => el.previousElementSibling?.getAttribute('data-testid'))
    expect(prev).toBe('guest-phone')
  })
})
