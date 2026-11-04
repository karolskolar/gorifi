// Module 21 — WA-T5: the outbox WRITE API (21 §UC-WA-008) + the waitlist compose/release
// (§UC-WA-007), as amended by „PO decisions 2026-09-19" and the WA-T5 orchestrator
// decisions (learnings 15 §WA-T5):
//
//   POST   /api/notifications/compose | release | retry | rerender   { cycle_id, segment_key }
//   PATCH  /api/notifications/:id/body          { body }
//   PATCH  /api/notifications/:id/manual-sent   { sent: true }
//   DELETE /api/notifications/:id
//   + the waitlist AUTO-COMPOSE on a cycle's transition into `open` (PO 2026-09-19)
//   + the cancelled-after-hand-over seam: `softCancelGuestOrder()` deletes the sub-order's
//     queued rows, and the release moves a row about a cancelled sub-order to
//     `skipped`/`cancelled` (DP-T3's seam, closed here)
//   + `notifications.unresolved` — the release gate's stored answer (never a rescan of a
//     rendered body: a guest named „{suma}" must not block a group).
//
// FOUR KINDS OF EVIDENCE, each where only it can work:
//   §1 THROWAWAY BOOTS — a child `node` imports `db/schema.js` + the helpers against a
//      temp file: the boot back-fill of `unresolved`, a legacy NULL-body row (no route can
//      write one any more), the release-time cancelled defence (the soft cancel now
//      deletes the row a route could have left), the waitlist compose/release on an
//      ISOLATED waitlist (the shared target's waitlist holds other specs' rows), and the
//      health reader against stub servers of its own.
//   §2 HTTP on the gate server — every §UC-WA-008 acceptance criterion through the real
//      routes, fixtures through the real friend/guest/admin/module-16 routes.
//   §3 DB_PATH-gated HTTP — the waitlist (no HTTP door can sign a guest up while rounds
//      are open, guest-waitlist.spec.js's header), the auto-compose on open, a `failed`
//      row for retry (only the WA process writes `failed`).
//   §4 WA_HEALTH_URL-gated HTTP — the `bot_active` 409 needs the GATE SERVER started with
//      `WA_HEALTH_URL` pointing at a port this spec then serves (e2e/README.md). Without
//      it the test self-skips; the connected branch of the reader is pinned in §1 anyway.
//
// NOTE ON RATE LIMITS: friend/admin auth sit on `authLimiter`; run with the raised
// budget (e2e/README.md).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'
const WA_HEALTH_URL = process.env.WA_HEALTH_URL || ''
const NEEDS_HEALTH = 'needs WA_HEALTH_URL — the SAME value the gate server was started with (e2e/README.md)'
const TIMEOUT = 20_000
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
// Gated on schema.js (the backend tree) — never on a file under test (learnings 15 §WA-T2).
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => pathToFileURL(join(BACKEND_SRC, rel)).href
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// 21 §UC-WA-008's literal-placeholder test — an INDEPENDENT copy.
const PLACEHOLDER = /\{[^{}\s]{1,40}\}/

// The Europe/Bratislava calendar day of a SQLite UTC stamp — an independent copy.
function bratislavaDate(stamp) {
  const instant = new Date(`${String(stamp).replace(' ', 'T')}Z`)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 THROWAWAY BOOTS
// ═════════════════════════════════════════════════════════════════════════════
function runProbe(dbFile, script) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t5-probe-'))
  const file = join(dir, 'probe.mjs')
  writeFileSync(file, script)
  try {
    const stdout = execFileSync(process.execPath, [file], {
      env: { ...process.env, DB_PATH: dbFile, WA_HEALTH_URL: '' },
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (!m) throw new Error(`probe produced no marker. stdout:\n${stdout}`)
    return JSON.parse(m[1])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A synchronous probe body over the DB + the module-21 helpers.
function probe(dbFile, body) {
  return runProbe(dbFile,
    `import db from '${srcUrl('db/schema.js')}';\n`
    + `import * as outbox from '${srcUrl('helpers/outbox.js')}';\n`
    + `import * as segments from '${srcUrl('helpers/segments.js')}';\n`
    + `import * as templates from '${srcUrl('helpers/templates.js')}';\n`
    + `import * as guestOrders from '${srcUrl('helpers/guest-orders.js')}';\n`
    + `const out = (() => {\n${body}\n})();\n`
    + `console.log('@@PROBE@@' + JSON.stringify(out));\n`)
}

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t5-db-'))
  try {
    return fn(join(dir, 'wa-t5.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// An open cycle, a pickup point, a friend factory, a handed-over pickup order factory.
const FIXTURE_JS = `
  db.run("INSERT INTO order_cycles (name, status, closes_at) VALUES ('wa-t5', 'open', '2026-11-06')");
  const cyc = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
  const loc = db.run("INSERT INTO pickup_locations (name, address) VALUES ('Probe Miesto', 'Ulica 5')").lastInsertRowid;
  let seq = 0;
  const friend = (name, phoneE164, extra = {}) => db.run(
    'INSERT INTO friends (cycle_id, name, access_token, phone, phone_e164, email, active, whatsapp_opt_in, guest_link_token) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)',
    [cyc, name, 'acc-' + (++seq), phoneE164 ? '0905 555 00' + seq : null, phoneE164, extra.email ?? null, extra.token ?? null]).lastInsertRowid;
  const handedOrder = (fid) => {
    const id = db.run("INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id, total, handed_over_at) VALUES (?, ?, 'submitted', 1, ?, 10, CURRENT_TIMESTAMP)", [fid, cyc, loc]).lastInsertRowid;
    return id;
  };
  const row = (id) => db.get('SELECT id, channel, status, body, unresolved, phone_e164, email, error, released_at, sent_at, sent_via, segment_key, guest_order_id FROM notifications WHERE id = ?', [id]);
  const rowsOf = (key, cycleId = cyc) => db.all('SELECT id, status, recipient_kind, recipient_id, body, unresolved, error, released_at FROM notifications WHERE segment_key = ? AND cycle_id IS ? ORDER BY id', [key, cycleId]);
  const tx = (fn) => db.transaction(fn)();
  const enable = (key, on = true) => templates.writeTemplate(key, { enabled: on });
`

test.describe('WA-T5 · §1 throwaway boots', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('the boot BACK-FILLS `unresolved` by the rescan for a row with a body (`{datum}` ⇒ blocked, clean ⇒ `[]`), leaves a NULL body NULL and an already-computed value alone; a second boot changes nothing', () => {
    withTempDb((file) => {
      const ids = probe(file, `
        const ins = (body, unresolved) => db.run(
          "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, body, unresolved, status, cycle_id) VALUES ('whatsapp', 'closing', 'not_ordered:1', 'friend', ?, ?, ?, 'queued', 1)",
          [Math.floor(Math.random() * 1e9), body, unresolved]).lastInsertRowid;
        return {
          datum: ins('Ahoj Ivo, zatvára sa {datum}. Odkaz: {odkaz}', null),
          clean: ins('Ahoj Ivo, vaša káva je tu.', null),
          legacy: ins(null, null),
          computed: ins('Ahoj {suma}, meno z hodnoty', '[]'),
        };
      `)
      probe(file, 'return true;') // the deploy's restart: the back-fill runs
      const read = () => {
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          return Object.fromEntries(db.prepare('SELECT id, unresolved FROM notifications').all().map((r) => [r.id, r.unresolved]))
        } finally { db.close() }
      }
      const after = read()
      expect(JSON.parse(after[ids.datum]), 'a literal placeholder blocks').toEqual(['{datum}', '{odkaz}'])
      expect(after[ids.clean]).toBe('[]')
      expect(after[ids.legacy], 'a NULL body stays NULL — blocked until a rerender renders it').toBeNull()
      expect(after[ids.computed], 'a value computed from template + vars is never rescanned').toBe('[]')
      probe(file, 'return true;')
      expect(read(), 'idempotent').toEqual(after)
    })
  })

  test('⚠ a LEGACY NULL-body queued row blocks the whole group (409 ids, nothing written) until a RERENDER renders it — which also fills `unresolved` and the phone snapshot; then the release goes through', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const a = friend('Adam Legacy', '+421905555001');
      const b = friend('Beata Fresh', '+421905555002');
      const oa = handedOrder(a); const ob = handedOrder(b);
      const r = {};
      tx(() => { r.enq = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [oa, ob] }); });
      const rowA = db.get('SELECT id, segment_key FROM notifications WHERE order_id = ?', [oa]);
      const rowB = db.get('SELECT id FROM notifications WHERE order_id = ?', [ob]).id;
      r.key = rowA.segment_key; r.a = rowA.id; r.b = rowB;
      r.freshB = row(rowB);
      // What DP-T3's hook wrote: no body, no snapshot, never computed.
      db.run('UPDATE notifications SET body = NULL, phone_e164 = NULL, unresolved = NULL WHERE id = ?', [rowA.id]);
      r.refused = outbox.releaseGroup({ cycleId: cyc, segmentKey: rowA.segment_key });
      r.afterRefusal = rowsOf(rowA.segment_key);
      r.rerender = outbox.rerenderGroup({ cycleId: cyc, segmentKey: rowA.segment_key });
      r.rerenderedA = row(rowA.id);
      r.released = outbox.releaseGroup({ cycleId: cyc, segmentKey: rowA.segment_key });
      r.final = rowsOf(rowA.segment_key);
      r.again = outbox.releaseGroup({ cycleId: cyc, segmentKey: rowA.segment_key });
      return r;
    `))
    expect(out.enq).toMatchObject({ queued: 2 })
    expect(out.freshB.unresolved, 'the enqueue stores the gate\'s answer at render time').toBe('[]')
    expect(out.refused).toEqual({ refused: 'unresolved_placeholders', ids: [out.a] })
    for (const r of out.afterRefusal) {
      expect(r.status, 'all-or-nothing: NOTHING released').toBe('queued')
      expect(r.released_at).toBeNull()
    }
    expect(out.rerender).toEqual({ rerendered: 2, unchanged: [] })
    expect(out.rerenderedA.body).toContain('Adam')
    expect(out.rerenderedA.body).not.toMatch(PLACEHOLDER)
    expect(out.rerenderedA.unresolved).toBe('[]')
    expect(out.rerenderedA.phone_e164, 'the snapshot refreshed').toBe('+421905555001')
    expect(out.released).toEqual({ released: 2, whatsapp: 2, email: 0, skipped: 0 })
    expect(out.final.map((r) => r.status)).toEqual(['released', 'released'])
    expect(out.final[0].released_at, 'one timestamp for the group').toBe(out.final[1].released_at)
    expect(out.again, 'a double-click is harmless').toEqual({ released: 0, whatsapp: 0, email: 0, skipped: 0 })
  })

  test('a row is releasable only with a non-blank body AND `unresolved = []`: a NULL body, a blank body, NULL / non-empty / unreadable `unresolved` each block (independently)', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const ins = (key, body, unresolved) => db.run(
        "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, phone_e164, body, unresolved, status, cycle_id) VALUES ('whatsapp', 'closing', ?, 'friend', ?, '+421905555099', ?, ?, 'queued', ?)",
        [key, Math.floor(Math.random() * 1e9), body, unresolved, cyc]).lastInsertRowid;
      const r = {};
      for (const [name, body, unresolved] of [
        ['nullBody', null, '[]'], ['blankBody', '   ', '[]'], ['nullUnresolved', 'Ahoj', null],
        ['pending', 'Ahoj {datum}', '["{datum}"]'], ['garbage', 'Ahoj', 'not json'], ['object', 'Ahoj', '{}'], ['ok', 'Ahoj', '[]'],
      ]) {
        const key = 'not_ordered:' + cyc;
        db.run('DELETE FROM notifications');
        const id = ins(key, body, unresolved);
        r[name] = { id, release: outbox.releaseGroup({ cycleId: cyc, segmentKey: key }), status: row(id).status };
      }
      return r;
    `))
    for (const name of ['nullBody', 'blankBody', 'nullUnresolved', 'pending', 'garbage', 'object']) {
      expect(out[name].release, name).toEqual({ refused: 'unresolved_placeholders', ids: [out[name].id] })
      expect(out[name].status, `${name} stays queued`).toBe('queued')
    }
    expect(out.ok.release, 'non-vacuity').toMatchObject({ released: 1 })
    expect(out.ok.status).toBe('released')
  })

  test('the cancelled-after-hand-over seam: `softCancelGuestOrder()` deletes the sub-order\'s QUEUED row (handed_over_at kept); a row that survived anyway is moved to `skipped`/`cancelled` at release — never sent, never a 409', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const host = friend('Hana Hostka', '+421905555010');
      const link = db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES ('WAT5LINK00001', ?, ?)", [host, cyc]).lastInsertRowid;
      const guest = (tok, name, phone) => db.run(
        "INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, phone_e164, total, status, handed_over_at) VALUES (?, ?, ?, '0911', ?, 10, 'submitted', CURRENT_TIMESTAMP)",
        [link, tok, name, phone]).lastInsertRowid;
      const g1 = guest('WAT5ORD000001', 'Gita Prvá', '+421911555001');
      const g2 = guest('WAT5ORD000002', 'Gusto Druhý', '+421911555002');
      const g3 = guest('WAT5ORD000003', 'Gabo Tretí', '+421911555003');
      const r = {};
      tx(() => { r.enq = outbox.enqueueForHandOver({ cycleId: cyc, guestOrderIds: [g1, g2, g3] }); });
      const key = db.get('SELECT segment_key FROM notifications WHERE guest_order_id = ?', [g1]).segment_key;
      r.key = key;
      // Door 1 — the soft cancel (all three cancel routes call it inside their tx).
      tx(() => { r.cancelled = guestOrders.softCancelGuestOrder(g2); });
      r.g2rows = db.all('SELECT id FROM notifications WHERE guest_order_id = ?', [g2]);
      r.g2stamp = db.get('SELECT handed_over_at, status FROM guest_orders WHERE id = ?', [g2]);
      tx(() => { r.cancelAgain = guestOrders.softCancelGuestOrder(g2); });
      // Door 2 — a row that survived (written before this fix): cancel g3 BEHIND the helper.
      db.run("UPDATE guest_orders SET status = 'cancelled' WHERE id = ?", [g3]);
      r.release = outbox.releaseGroup({ cycleId: cyc, segmentKey: key });
      r.rows = db.all('SELECT guest_order_id, status, error, released_at FROM notifications WHERE segment_key = ? ORDER BY guest_order_id', [key]);
      r.g1 = g1; r.g3 = g3;
      return r;
    `))
    expect(out.enq).toMatchObject({ queued: 3 })
    expect(out.key).toMatch(/^host_guests:\d+:\d{4}-\d{2}-\d{2}$/)
    expect(out.cancelled).toBe(1)
    expect(out.g2rows, 'the queued message about the cancelled bag is gone').toEqual([])
    expect(out.g2stamp.status).toBe('cancelled')
    expect(out.g2stamp.handed_over_at, 'module 14/16 policy: the stamp is NOT rewritten').toBeTruthy()
    expect(out.cancelAgain, 'idempotent').toBe(0)
    expect(out.release).toEqual({ released: 1, whatsapp: 1, email: 0, skipped: 1 })
    expect(out.rows).toEqual([
      { guest_order_id: out.g1, status: 'released', error: null, released_at: expect.any(String) },
      { guest_order_id: out.g3, status: 'skipped', error: 'cancelled', released_at: null },
    ])
  })

  test('§UC-WA-007 waitlist on an ISOLATED waitlist: compose ⇒ bodies with the host\'s first name + `/g/<guest_link_token>`, opt-in 0 never composed, no number ⇒ `skipped`/`no_phone`; a guest NAMED „{suma}" does not block; release stamps `notified_at = released_at` (D8); the segment then counts 0 and a second compose finds nobody', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const host = friend('Hedviga Hostiteľka', '+421905555020', { token: 'WAT5STANDING00001' });
      const w = (name, e164, optIn) => db.run(
        'INSERT INTO guest_waitlist (host_friend_id, cycle_id, name, phone, phone_e164, whatsapp_opt_in) VALUES (?, NULL, ?, ?, ?, ?)',
        [host, name, '0912 ' + Math.floor(Math.random() * 1e6), e164, optIn]).lastInsertRowid;
      const w1 = w('Wanda Prvá', '+421912555001', 1);
      const w2 = w('{suma} Druhá', '+421912555002', 1);
      const w3 = w('Wiktor Nesúhlas', '+421912555003', 0);
      const r = { w1, w2, w3, key: 'waitlist:' + cyc };
      r.disabled = outbox.composeSegment({ cycleId: cyc, segmentKey: r.key });
      r.rowsWhileDisabled = rowsOf(r.key).length;
      enable('waitlist');
      r.compose = outbox.composeSegment({ cycleId: cyc, segmentKey: r.key });
      r.rows = rowsOf(r.key);
      r.release = outbox.releaseGroup({ cycleId: cyc, segmentKey: r.key });
      r.waitlist = db.all('SELECT id, notified_at FROM guest_waitlist ORDER BY id');
      r.released = rowsOf(r.key);
      const seg = segments.buildSegment(cyc, r.key);
      r.segCount = seg.recipients.length; r.segOptOut = seg.excluded_opt_out;
      r.compose2 = outbox.composeSegment({ cycleId: cyc, segmentKey: r.key });
      r.rowsAfter = rowsOf(r.key).length;
      // A waitlist guest without a number: the skipped to-do, never released, never stamped.
      const w4 = w('Wilma BezČísla', null, 1);
      r.compose3 = outbox.composeSegment({ cycleId: cyc, segmentKey: r.key });
      r.w4row = db.get("SELECT status, error FROM notifications WHERE recipient_kind = 'waitlist' AND recipient_id = ?", [w4]);
      r.release3 = outbox.releaseGroup({ cycleId: cyc, segmentKey: r.key });
      r.w4stamp = db.get('SELECT notified_at FROM guest_waitlist WHERE id = ?', [w4]).notified_at;
      return r;
    `))
    expect(out.disabled, 'the seed state: waitlist disabled').toEqual({ refused: 'template_disabled' })
    expect(out.rowsWhileDisabled).toBe(0)
    expect(out.compose).toMatchObject({ segment_key: out.key, template_key: 'waitlist', queued: 2, email: 0, skipped: 0, none: 1, already: 0 })
    expect(out.rows.map((r) => r.recipient_id)).toEqual([out.w1, out.w2])
    for (const r of out.rows) {
      expect(r.body).toContain('Hedviga')
      expect(r.body).toContain('/g/WAT5STANDING00001')
      expect(r.unresolved).toBe('[]')
    }
    expect(out.rows[1].body, 'the VALUE carries braces…').toContain('Ahoj {suma},')
    expect(out.release, '…and it does not block the group').toEqual({ released: 2, whatsapp: 2, email: 0, skipped: 0 })
    const stamp = out.released[0].released_at
    expect(out.waitlist).toEqual([
      { id: out.w1, notified_at: stamp },
      { id: out.w2, notified_at: stamp },
      { id: out.w3, notified_at: null },
    ])
    expect(out.segCount, 'the segment shrinks to zero').toBe(0)
    expect(out.segOptOut).toBe(1)
    expect(out.compose2).toMatchObject({ queued: 0, none: 1, already: 0 })
    expect(out.rowsAfter, 'a second compose finds nobody').toBe(2)
    expect(out.compose3).toMatchObject({ skipped: 1 })
    expect(out.w4row).toEqual({ status: 'skipped', error: 'no_phone' })
    expect(out.release3.released).toBe(0)
    expect(out.w4stamp, 'a skipped to-do is not a sent message').toBeNull()
  })

  test('⚠ the release-time WAITLIST defence (WA-T5 review): composed in TWO rounds ⇒ releasing B then A messages nobody twice (A: `released:0`, `skipped:n`/`not_waiting`); purged / admin-deleted after compose ⇒ `skipped`/`not_waiting`; a standing-link ROTATION between compose and release ⇒ the body carries the NEW token; a host with no link any more ⇒ the literal `{odkaz}` blocks; the queued wa.me tick refuses a person no longer waiting', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      enable('waitlist');
      const host = friend('Rozália Rotujúca', '+421905555040', { token: 'WAT5STANDINGOLD01' });
      const w = (name, e164) => db.run(
        'INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, whatsapp_opt_in) VALUES (?, ?, ?, ?, 1)',
        [host, name, '0912 ' + Math.floor(Math.random() * 1e6), e164]).lastInsertRowid;
      const w1 = w('Alena Dvakrát', '+421912555041');
      const w2 = w('Bohuš Dvakrát', '+421912555042');
      db.run("INSERT INTO order_cycles (name, status) VALUES ('wa-t5 B', 'open')");
      const cycB = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
      const keyA = 'waitlist:' + cyc; const keyB = 'waitlist:' + cycB;
      const r = { w1, w2 };
      r.composeA = outbox.composeSegment({ cycleId: cyc, segmentKey: keyA });
      r.composeB = outbox.composeSegment({ cycleId: cycB, segmentKey: keyB });
      // Rotation between compose and release (helpers/standing-link.js's regenerate does this UPDATE).
      db.run("UPDATE friends SET guest_link_token = 'WAT5STANDINGNEW01' WHERE id = ?", [host]);
      r.releaseB = outbox.releaseGroup({ cycleId: cycB, segmentKey: keyB });
      r.bodiesB = rowsOf(keyB, cycB).map((x) => x.body);
      r.releaseA = outbox.releaseGroup({ cycleId: cyc, segmentKey: keyA });
      r.rowsA = rowsOf(keyA).map((x) => ({ status: x.status, error: x.error }));

      // Purge / admin delete AFTER compose.
      const w3 = w('Cyril Nakúpil', '+421912555043');
      const w4 = w('Dana Zmazaná', '+421912555044');
      db.run("INSERT INTO order_cycles (name, status) VALUES ('wa-t5 C', 'open')");
      const cycC = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
      const keyC = 'waitlist:' + cycC;
      r.composeC = outbox.composeSegment({ cycleId: cycC, segmentKey: keyC });
      db.run('DELETE FROM guest_waitlist WHERE id IN (?, ?)', [w3, w4]);
      r.releaseC = outbox.releaseGroup({ cycleId: cycC, segmentKey: keyC });
      r.rowsC = rowsOf(keyC, cycC).map((x) => ({ status: x.status, error: x.error }));

      // A host whose link is gone by release time ⇒ literal {odkaz} ⇒ the group blocks.
      const w5 = w('Eva Bezodkazu', '+421912555045');
      db.run("INSERT INTO order_cycles (name, status) VALUES ('wa-t5 D', 'open')");
      const cycD = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
      const keyD = 'waitlist:' + cycD;
      outbox.composeSegment({ cycleId: cycD, segmentKey: keyD });
      db.run('UPDATE friends SET guest_link_token = NULL WHERE id = ?', [host]);
      r.releaseD = outbox.releaseGroup({ cycleId: cycD, segmentKey: keyD });
      r.rowsD = rowsOf(keyD, cycD).map((x) => ({ status: x.status, body: x.body }));
      r.w5 = w5;

      // The queued tick: a person told in another round meanwhile.
      db.run("UPDATE friends SET guest_link_token = 'WAT5STANDINGNEW02' WHERE id = ?", [host]);
      db.run("INSERT INTO order_cycles (name, status) VALUES ('wa-t5 E', 'open')");
      const cycE = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
      const keyE = 'waitlist:' + cycE;
      outbox.composeSegment({ cycleId: cycE, segmentKey: keyE });
      const rowE = db.get("SELECT id FROM notifications WHERE segment_key = ? AND recipient_id = ?", [keyE, w5]).id;
      db.run("UPDATE guest_waitlist SET notified_at = CURRENT_TIMESTAMP WHERE id = ?", [w5]);
      r.tick = outbox.markManualSent(rowE, ['queued']);
      r.rowE = row(rowE);
      return r;
    `))
    expect(out.composeA).toMatchObject({ queued: 2 })
    expect(out.composeB, 'the partial index keys on cycle_id: both rounds hold a queued row').toMatchObject({ queued: 2 })
    expect(out.releaseB).toEqual({ released: 2, whatsapp: 2, email: 0, skipped: 0 })
    for (const body of out.bodiesB) {
      expect(body, 'the release re-rendered the standing link').toContain('/g/WAT5STANDINGNEW01')
      expect(body).not.toContain('WAT5STANDINGOLD01')
    }
    expect(out.releaseA, 'nobody is messaged twice').toEqual({ released: 0, whatsapp: 0, email: 0, skipped: 2 })
    expect(out.rowsA).toEqual([{ status: 'skipped', error: 'not_waiting' }, { status: 'skipped', error: 'not_waiting' }])
    expect(out.composeC).toMatchObject({ queued: 2 })
    expect(out.releaseC).toEqual({ released: 0, whatsapp: 0, email: 0, skipped: 2 })
    expect(out.rowsC).toEqual([{ status: 'skipped', error: 'not_waiting' }, { status: 'skipped', error: 'not_waiting' }])
    expect(out.releaseD.refused, 'a host without a link now ⇒ the group blocks').toBe('unresolved_placeholders')
    expect(out.rowsD, 'nothing written on the refusal').toEqual([{ status: 'queued', body: expect.stringContaining('/g/WAT5STANDINGNEW01') }])
    expect(out.tick).toEqual({ refused: 'not_waiting' })
    expect(out.rowE).toMatchObject({ status: 'skipped', error: 'not_waiting', sent_at: null })
  })

  test('the waitlist AUTO-COMPOSE helper is silent: a disabled template or a non-open cycle composes nothing and returns null; enabled ⇒ the same rows `compose` builds, never released', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const host = friend('Oto Otvárač', '+421905555030', { token: 'WAT5STANDING00002' });
      db.run("INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, whatsapp_opt_in) VALUES (?, 'Viera Čaká', '0912 1', '+421912555031', 1)", [host]);
      const key = 'waitlist:' + cyc;
      const r = {};
      r.disabled = outbox.composeWaitlistOnOpen(cyc, {});
      r.n0 = rowsOf(key).length;
      enable('waitlist');
      db.run("UPDATE order_cycles SET status = 'planned' WHERE id = ?", [cyc]);
      r.notOpen = outbox.composeWaitlistOnOpen(cyc, {});
      r.direct = outbox.composeSegment({ cycleId: cyc, segmentKey: key });
      r.n1 = rowsOf(key).length;
      db.run("UPDATE order_cycles SET status = 'open' WHERE id = ?", [cyc]);
      r.enabled = outbox.composeWaitlistOnOpen(cyc, {});
      r.rows = rowsOf(key).map((x) => x.status);
      r.bad = outbox.composeWaitlistOnOpen('x', {});
      return r;
    `))
    expect(out.disabled).toBeNull()
    expect(out.n0).toBe(0)
    expect(out.notOpen).toBeNull()
    expect(out.direct, 'the route\'s answer for the same state').toEqual({ refused: 'cycle_not_open' })
    expect(out.n1).toBe(0)
    expect(out.enabled).toMatchObject({ queued: 1 })
    expect(out.rows, 'composed, NEVER released').toEqual(['queued'])
    expect(out.bad).toBeNull()
  })

  test('`helpers/wa-health.js`: connected ONLY for a 200 JSON object with `state: connected`; `qr`, a 500, non-JSON, an array, a refused port and a > 2 s answer are all NOT connected; it never throws; the URL defaults to :3010', () => {
    const out = withTempDb((file) => runProbe(file, `
      import { createServer } from 'node:http';
      import * as h from '${srcUrl('helpers/wa-health.js')}';
      let mode = 'connected';
      const server = createServer((req, res) => {
        if (req.url !== '/health') { res.writeHead(404); return res.end(); }
        if (mode === 'slow') return setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"state":"connected"}'); }, 2600);
        if (mode === '500') { res.writeHead(500); return res.end('{"state":"connected"}'); }
        if (mode === 'text') { res.writeHead(200); return res.end('connected'); }
        if (mode === 'array') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('[{"state":"connected"}]'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ state: mode, qr: mode === 'qr' ? 'data:image/png;base64,QR' : undefined }));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const port = server.address().port;
      const r = {};
      process.env.WA_HEALTH_URL = '';
      r.defaultUrl = h.waHealthUrl();
      process.env.WA_HEALTH_URL = 'http://127.0.0.1:' + port + '/';
      r.url = h.waHealthUrl();
      for (const m of ['connected', 'qr', '500', 'text', 'array', 'slow']) {
        mode = m;
        const t0 = Date.now();
        r[m] = { connected: await h.botConnected(), health: await h.fetchWaHealth(), ms: Date.now() - t0 };
      }
      server.closeAllConnections?.();
      await new Promise((res) => server.close(res));
      r.refused = { connected: await h.botConnected(), health: await h.fetchWaHealth() };
      console.log('@@PROBE@@' + JSON.stringify(r));
      process.exit(0);
    `))
    expect(out.defaultUrl).toBe('http://127.0.0.1:3010/health')
    expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/)
    expect(out.connected.connected).toBe(true)
    expect(out.connected.health).toMatchObject({ reachable: true, state: 'connected' })
    expect(out.qr.connected).toBe(false)
    expect(out.qr.health.reachable).toBe(true)
    for (const m of ['500', 'text', 'array', 'slow', 'refused']) {
      expect(out[m].connected, `${m} ⇒ not connected`).toBe(false)
      expect(out[m].health, `${m} ⇒ unreachable`).toEqual({ reachable: false })
    }
    expect(out.slow.ms, 'the 2 s timeout bites (two calls)').toBeLessThan(2 * 2600)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 HTTP — the gate server
// ═════════════════════════════════════════════════════════════════════════════
let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })

// The HTTP describes log in lazily (each beforeAll calls this), so §1's throwaway boots
// need no server at all.
async function ensureAdmin() {
  if (ctx) return
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
}
test.afterAll(async () => { await ctx?.dispose(); ctx = null })

let friendSeq = 0
async function makeFriend(label, { phone, email, login = true } = {}) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `wa5_${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const first = `W5${label}${uniq}${friendSeq}`
  const name = `${first} Test`
  const data = { name }
  if (phone) data.phone = phone
  if (email) data.email = email
  const created = await admin('/api/friends', { method: 'post', data })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  if (!login) return { id: row.id, name, first }
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, first, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, extra = {}) {
  const res = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA5 ${label} ${uniq}`, type: 'coffee', status: 'open', ...extra } })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}
async function ownOrder(friend, cycleId, items, submitBody) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth, data: { items }, timeout: TIMEOUT })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, { headers: friend.auth, data: submitBody, timeout: TIMEOUT })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}
async function distribution(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status()).toBe(200)
  return res.json()
}
async function packFriend(cycleId, friend, orderId) {
  const party = (await distribution(cycleId)).distribution.find((p) => p.id === friend.id && p.kind === 'friend')
  for (const g of party.guest_orders) {
    for (const item of g.items) if (!item.packed) expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status(), 'order packed').toBe(200)
}
async function handOver(orderId, flag = true) {
  const res = await admin(`/api/orders/${orderId}/handed-over`, { method: 'patch', data: { handed_over: flag } })
  expect(res.status(), `hand-over ${flag}`).toBe(200)
  return res.json()
}
async function groupRows(cycleId, segmentKey) {
  const res = await admin('/api/notifications', { params: { cycle_id: String(cycleId), segment_key: segmentKey } })
  expect(res.status(), `GET /notifications ${segmentKey}`).toBe(200)
  return (await res.json()).rows
}
const of = (rows, kind, id) => rows.filter((r) => r.recipient_kind === kind && r.recipient_id === id)
const post = (path, data) => admin(`/api/notifications/${path}`, { method: 'post', data })
async function ledger(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  return { count: (body.transactions || []).length, balance: body.friend?.balance ?? body.balance }
}
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try { return fn(db) } finally { db.close() }
}
async function setTemplate(key, patch) {
  const res = await admin(`/api/notifications/templates/${key}`, { method: 'put', data: patch })
  expect(res.status(), `template ${key}`).toBe(200)
  return res.json()
}
async function getTemplate(key) {
  const res = await admin('/api/notifications/templates')
  expect(res.status()).toBe(200)
  return (await res.json()).templates.find((t) => t.key === key)
}
// Run `fn` with template `key` patched, then restore it EXACTLY (body + enabled).
async function withTemplate(key, patch, fn) {
  const before = await getTemplate(key)
  await setTemplate(key, patch)
  try {
    return await fn()
  } finally {
    const restored = await setTemplate(key, { body: before.body, enabled: before.enabled })
    expect(restored.enabled, `${key} restored`).toBe(before.enabled)
  }
}

test.describe('WA-T5 · §2 21 §UC-WA-008 through the real routes', () => {
  test.describe.configure({ mode: 'serial' })
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await ensureAdmin()
    fx.cycle = await makeCycle('main', { closes_at: '2026-11-06' })
    const product = await admin('/api/products', {
      method: 'post', data: { cycle_id: fx.cycle.id, name: `WA5 Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
    })
    expect(product.status()).toBe(201)
    fx.product = await product.json()
    fx.line = () => [{ product_id: fx.product.id, variant: '250g', quantity: 1 }]
    const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA5 Miesto ${uniq}`, address: 'Ulica WA5', for_coffee: true, for_bakery: true } })
    expect(loc.status()).toBe(201)
    fx.L = await loc.json()
    const pickup = { pickup_location_id: fx.L.id }

    fx.P = await makeFriend('Pavla', { phone: '0905 501 001' })
    fx.Q = await makeFriend('Quido', { phone: '0905 501 002' })
    fx.E = await makeFriend('Emil', { email: `wa5.emil.${uniq}@example.test` })
    fx.H = await makeFriend('Hana', { phone: '0905 501 004' })
    fx.N = await makeFriend('Nikto', { phone: '0905 501 005', login: false }) // no order ⇒ not_ordered
    fx.O = await makeFriend('Oto', { phone: '0905 501 006', login: false }) // opted out, no order
    fx.oP = await ownOrder(fx.P, fx.cycle.id, fx.line(), pickup)
    fx.oQ = await ownOrder(fx.Q, fx.cycle.id, fx.line(), pickup)
    fx.oE = await ownOrder(fx.E, fx.cycle.id, fx.line(), pickup)
    fx.oH = await ownOrder(fx.H, fx.cycle.id, fx.line(), pickup)
    expect((await admin(`/api/friends/${fx.O.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status(), 'opt out').toBe(200)

    const link = await ctx.post(`/api/guest-links/cycle/${fx.cycle.id}`, { headers: fx.H.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(link.status())
    fx.link = (await link.json()).link
    const guest = async (data) => {
      const res = await ctx.post(`/api/guest/${fx.link.token}/orders`, { data: { items: fx.line(), ...data }, timeout: TIMEOUT })
      expect(res.status(), 'guest submit').toBe(201)
      return (await res.json()).order
    }
    // ⚠ A guest NAMED „{suma}": the rendered `host` body carries a literal-looking
    // placeholder that came from a VALUE — the release must not refuse it.
    fx.G1 = await guest({ guest_name: '{suma} Hosťová', guest_phone: '0911 501 001' })
    fx.G2 = await guest({ guest_name: `Gejza${uniq} Hosť`, guest_phone: '0911 501 002' })

    for (const [f, o] of [[fx.P, fx.oP], [fx.Q, fx.oQ], [fx.E, fx.oE], [fx.H, fx.oH]]) await packFriend(fx.cycle.id, f, o.id)
    for (const o of [fx.oP, fx.oQ, fx.oE]) await handOver(o.id)
    const h = await handOver(fx.oH.id)
    expect(h.queued_notifications, 'host + two guests').toBe(3)
    fx.today = bratislavaDate(h.order.handed_over_at)
    fx.pickupKey = `handed_over:pickup:${fx.L.id}:${fx.today}`
    fx.hostKey = `host_guests:${fx.H.id}:${fx.today}`
  })

  test.afterAll(async () => {
    if (fx.L) {
      const res = await admin(`/api/pickup-locations/${fx.L.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('every rendered row publishes `unresolved: []`; a guest NAMED „{suma}" has a literal-looking body and still `[]` (the gate answers from template + vars, never a rescan)', async () => {
    const pickup = await groupRows(fx.cycle.id, fx.pickupKey)
    expect(pickup.length, 'P, Q, E, H').toBeGreaterThanOrEqual(4)
    for (const r of pickup) expect(r.unresolved).toEqual([])
    const g1 = of(await groupRows(fx.cycle.id, fx.hostKey), 'guest', fx.G1.id)
    expect(g1).toHaveLength(1)
    expect(g1[0].body).toMatch(/^Ahoj \{suma\},/)
    expect(g1[0].body, 'non-vacuity: the rescan WOULD block it').toMatch(PLACEHOLDER)
    expect(g1[0].unresolved).toEqual([])
  })

  test('PATCH /:id/body: refusals write nothing (400 non-string / > 1000 / blank / array payload / bad id, 404 unknown); a body with `{datum}` is stored with `unresolved: [\'{datum}\']`', async () => {
    const row = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0]
    fx.qRow = row
    const patch = (id, data) => admin(`/api/notifications/${id}/body`, { method: 'patch', data })
    for (const [data, reason] of [
      [{ body: 42 }, 'invalid_body'], [{ body: null }, 'invalid_body'], [{}, 'invalid_body'],
      [{ body: 'x'.repeat(1001) }, 'body_too_long'], [{ body: '   ' }, 'empty_body'], [[{ body: 'x' }], 'invalid_payload'],
    ]) {
      const res = await patch(row.id, data)
      expect(res.status(), JSON.stringify(data).slice(0, 40)).toBe(400)
      expect((await res.json()).reason).toBe(reason)
    }
    expect((await patch('abc', { body: 'x' })).status()).toBe(400)
    expect((await patch(999999999, { body: 'x' })).status()).toBe(404)
    expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0], 'the row read back unchanged').toEqual(row)

    const res = await patch(row.id, { body: `${row.body} Uzávierka {datum}.` })
    expect(res.status()).toBe(200)
    const edited = await res.json()
    expect(edited).toMatchObject({ id: row.id, status: 'queued', unresolved: ['{datum}'] })
    expect(edited.body).toContain('{datum}')
  })

  test('release with ONE `{datum}` row ⇒ 409 `unresolved_placeholders` naming exactly it, and NOTHING changes (every row read back); fixed ⇒ the group releases', async () => {
    const before = await groupRows(fx.cycle.id, fx.pickupKey)
    const res = await post('release', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ reason: 'unresolved_placeholders', ids: [fx.qRow.id] })
    expect(await groupRows(fx.cycle.id, fx.pickupKey), 'all-or-nothing').toEqual(before)

    const fix = await admin(`/api/notifications/${fx.qRow.id}/body`, { method: 'patch', data: { body: fx.qRow.body } })
    expect(fix.status()).toBe(200)
    expect((await fix.json()).unresolved).toEqual([])
  })

  test('compose → release moves every row of the group to `released` (one `released_at`), touches no other group, counts whatsapp/email; a second release answers 0; the ledger does not move', async () => {
    const ledgers = [await ledger(fx.P.id), await ledger(fx.E.id)]
    const hostBefore = await groupRows(fx.cycle.id, fx.hostKey)
    const queued = (await groupRows(fx.cycle.id, fx.pickupKey)).filter((r) => r.status === 'queued')
    const res = await post('release', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ released: queued.length, email: queued.filter((r) => r.channel === 'email').length, skipped: 0 })
    expect(body.whatsapp + body.email).toBe(queued.length)
    // `counts` is read in the same synchronous handler, before the e-mail hand-off's `.then` runs.
    expect(body.counts).toMatchObject({ queued: 0, released: queued.length })
    // ~~every row reads back `released`~~ → WA-T6 (21 §UC-WA-010, learnings 15 §WA-T6): the
    // e-mail rows go to the mailer AFTER the commit; this gate has no Mailgun env, so they
    // settle `failed`/`not_configured`. The WhatsApp rows stay `released` (the API never
    // sends one). Every row still carries the release's ONE `released_at`.
    const emailIds = queued.filter((r) => r.channel === 'email').map((r) => r.id)
    await expect.poll(async () => (await groupRows(fx.cycle.id, fx.pickupKey))
      .filter((r) => emailIds.includes(r.id) && r.status === 'released').length, { timeout: 10_000 }).toBe(0)
    const after = await groupRows(fx.cycle.id, fx.pickupKey)
    for (const r of after) {
      if (r.channel === 'email') expect(r).toMatchObject({ status: 'failed', error: 'not_configured', sent_at: null })
      else expect(r.status).toBe('released')
      expect(r.released_at).toBe(after[0].released_at)
    }
    expect(of(after, 'friend', fx.E.id)[0].channel, 'non-vacuity: an e-mail row was in the group').toBe('email')
    expect(await groupRows(fx.cycle.id, fx.hostKey), 'another group is untouched').toEqual(hostBefore)

    const again = await post('release', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(again.status()).toBe(200)
    expect(await again.json()).toMatchObject({ released: 0, whatsapp: 0, email: 0 })
    expect([await ledger(fx.P.id), await ledger(fx.E.id)], '⚠ a notification is not a financial event').toEqual(ledgers)
  })

  test('the soft cancel of a HANDED-OVER guest deletes its queued row (admin cancel door); the group with the guest named „{suma}" then releases', async () => {
    const res = await admin(`/api/guest-orders/${fx.G2.id}/cancel`, { method: 'post' })
    expect(res.status()).toBe(200)
    const rows = await groupRows(fx.cycle.id, fx.hostKey)
    expect(of(rows, 'guest', fx.G2.id), 'no message about a bag nobody will receive').toEqual([])
    expect(of(rows, 'guest', fx.G1.id)).toHaveLength(1)
    if (DB_PATH) {
      expect(withDb((db) => db.prepare('SELECT handed_over_at FROM guest_orders WHERE id = ?').get(fx.G2.id).handed_over_at),
        'the stamp is not rewritten').toBeTruthy()
    }
    const rel = await post('release', { cycle_id: fx.cycle.id, segment_key: fx.hostKey })
    expect(rel.status(), 'a value with braces never blocks').toBe(200)
    expect(await rel.json()).toMatchObject({ released: 1, whatsapp: 1 })
  })

  test('PATCH /:id/manual-sent: `{sent:true}` strict; a RELEASED row with the bot unreachable ⇒ `sent`/`wa_me`; a QUEUED row ⇒ `sent`/`wa_me`; a second tick ⇒ 409 `not_pending`, row unchanged', async () => {
    const p = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.P.id)[0]
    expect(p.status).toBe('released')
    const tick = (id, data) => admin(`/api/notifications/${id}/manual-sent`, { method: 'patch', data })
    for (const data of [{ sent: 1 }, { sent: 'true' }, { sent: false }, {}, [true]]) {
      expect((await tick(p.id, data)).status(), JSON.stringify(data)).toBe(400)
    }
    expect((await tick(999999999, { sent: true })).status()).toBe(404)
    const res = await tick(p.id, { sent: true })
    expect(res.status(), 'the bot is not connected (no health endpoint is answering `connected`)').toBe(200)
    expect(await res.json()).toMatchObject({ id: p.id, status: 'sent', sent_via: 'wa_me', sent_at: expect.any(String) })

    // A fresh QUEUED row: hand over another friend.
    fx.R = await makeFriend('Rudo', { phone: '0905 501 007' })
    const oR = await ownOrder(fx.R, fx.cycle.id, fx.line(), { pickup_location_id: fx.L.id })
    await packFriend(fx.cycle.id, fx.R, oR.id)
    await handOver(oR.id)
    const r = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.R.id)[0]
    expect(r.status).toBe('queued')
    const queuedTick = await tick(r.id, { sent: true })
    expect(queuedTick.status()).toBe(200)
    const sent = await queuedTick.json()
    expect(sent).toMatchObject({ status: 'sent', sent_via: 'wa_me', released_at: null })
    const second = await tick(r.id, { sent: true })
    expect(second.status()).toBe(409)
    expect((await second.json()).reason).toBe('not_pending')
    expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.R.id)[0], 'read back unchanged').toEqual(sent)
  })

  // WA-T8 review: `editRowBody()` now admits TWO statuses (queued + failed); this pins the
  // exclusion of every other one that a group can hold at this point.
  test('PATCH /:id/body: a RELEASED and a SENT row ⇒ 409 `not_queued`, each read back unchanged (only queued + failed rows are editable — WA-T8)', async () => {
    const rows = await groupRows(fx.cycle.id, fx.pickupKey)
    const released = of(rows, 'friend', fx.Q.id)[0]
    const sent = of(rows, 'friend', fx.P.id)[0]
    expect(released.status, 'non-vacuity').toBe('released')
    expect(sent.status, 'non-vacuity (ticked by the manual-sent test)').toBe('sent')
    for (const row of [released, sent]) {
      const res = await admin(`/api/notifications/${row.id}/body`, { method: 'patch', data: { body: `Iný text ${uniq}.` } })
      expect(res.status(), `${row.status} ⇒ 409`).toBe(409)
      expect((await res.json()).reason).toBe('not_queued')
      expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', row.recipient_id)[0], `${row.status} row unchanged`).toEqual(row)
    }
  })

  test('DELETE /:id: a released row ⇒ 409 `not_queued` (read back unchanged); a queued row and a `skipped` to-do ⇒ deleted; unknown ⇒ 404; a non-id ⇒ 400', async () => {
    const q = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0]
    expect(q.status).toBe('released')
    const refused = await admin(`/api/notifications/${q.id}`, { method: 'delete' })
    expect(refused.status()).toBe(409)
    expect((await refused.json()).reason).toBe('not_queued')
    expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0]).toEqual(q)

    // A queued row + a skipped to-do (no phone, no e-mail).
    fx.S = await makeFriend('Simon', { phone: '0905 501 008' })
    fx.Z = await makeFriend('Zuzka')
    for (const f of [fx.S, fx.Z]) {
      const o = await ownOrder(f, fx.cycle.id, fx.line(), { pickup_location_id: fx.L.id })
      await packFriend(fx.cycle.id, f, o.id)
      await handOver(o.id)
    }
    const rows = await groupRows(fx.cycle.id, fx.pickupKey)
    const s = of(rows, 'friend', fx.S.id)[0]
    const z = of(rows, 'friend', fx.Z.id)[0]
    expect([s.status, z.status, z.error]).toEqual(['queued', 'skipped', 'no_phone'])
    for (const row of [s, z]) {
      const res = await admin(`/api/notifications/${row.id}`, { method: 'delete' })
      expect(res.status()).toBe(200)
      expect(await res.json()).toMatchObject({ deleted: true, id: row.id, row: null })
    }
    const left = await groupRows(fx.cycle.id, fx.pickupKey)
    expect(of(left, 'friend', fx.S.id)).toEqual([])
    expect(of(left, 'friend', fx.Z.id)).toEqual([])
    expect((await admin('/api/notifications/999999999', { method: 'delete' })).status()).toBe(404)
    expect((await admin('/api/notifications/abc', { method: 'delete' })).status()).toBe(400)
  })

  test('rerender refreshes a QUEUED row\'s body, `unresolved`, phone snapshot and channel (e-mail fallback ⇒ WhatsApp once a number exists) from the CURRENT template; released/sent rows are never touched (WA-T8: FAILED rows are refreshed too, status kept); a disabled template ⇒ 409', async () => {
    fx.T = await makeFriend('Tomas', { email: `wa5.tomas.${uniq}@example.test` })
    const oT = await ownOrder(fx.T, fx.cycle.id, fx.line(), { pickup_location_id: fx.L.id })
    await packFriend(fx.cycle.id, fx.T, oT.id)
    await handOver(oT.id)
    const before = await groupRows(fx.cycle.id, fx.pickupKey)
    const t0 = of(before, 'friend', fx.T.id)[0]
    expect(t0).toMatchObject({ channel: 'email', status: 'queued', phone_e164: null })
    // WA-T8 (learnings 15 §WA-T8 decision 1): E's e-mail row FAILED (`not_configured`, no
    // Mailgun env on the gate) at the release above — the rerender now refreshes it too.
    const failedBefore = before.filter((r) => r.status === 'failed')
    expect(failedBefore.length, 'non-vacuity: E\'s failed e-mail row').toBeGreaterThan(0)

    expect((await admin(`/api/friends/${fx.T.id}`, { method: 'patch', data: { phone: '0905 501 009' } })).status()).toBe(200)
    const stamp = `Vďaka${uniq}!`
    await withTemplate('pickup', { body: `${(await getTemplate('pickup')).body} ${stamp}` }, async () => {
      const res = await post('rerender', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
      expect(res.status()).toBe(200)
      const body = await res.json()
      // ~~`toBe(1)`~~ → WA-T8: T's queued row + the group's failed rows.
      expect(body.rerendered).toBe(1 + failedBefore.length)
      expect(body.counts.queued).toBe(1)
    })
    const after = await groupRows(fx.cycle.id, fx.pickupKey)
    const t1 = of(after, 'friend', fx.T.id)[0]
    expect(t1).toMatchObject({ id: t0.id, channel: 'whatsapp', status: 'queued', phone_e164: '+421905501009', unresolved: [] })
    expect(t1.body.endsWith(stamp)).toBe(true)
    for (const r of after.filter((x) => x.id !== t0.id)) {
      const was = before.find((x) => x.id === r.id)
      if (was.status === 'failed') {
        // ~~untouched~~ → WA-T8: re-rendered from the current template, status + error KEPT
        // (the repair door before a retry).
        expect(r).toMatchObject({ id: was.id, status: 'failed', error: was.error, channel: was.channel })
        expect(r.body.endsWith(stamp), 'refreshed from the CURRENT template').toBe(true)
        continue
      }
      expect(r, 'released / sent rows untouched').toEqual(was)
    }

    await withTemplate('pickup', { enabled: false }, async () => {
      const res = await post('rerender', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
      expect(res.status()).toBe(409)
      expect((await res.json()).reason).toBe('template_disabled')
    })
    expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.T.id)[0]).toEqual(t1)
  })

  test('retry: `failed → released` for the group (`released_at` refreshed, `error` kept); 0 is fine', async () => {
    test.skip(!DB_PATH, NEEDS_DB) // only the WA process writes `failed`
    const q = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0]
    withDb((db) => db.prepare("UPDATE notifications SET status = 'failed', error = 'not_on_whatsapp', released_at = '2026-01-01 00:00:00' WHERE id = ?").run(q.id))
    // ~~`{ released: 1, whatsapp: 1, email: 0 }` and a second retry ⇒ 0~~ → WA-T6: E's e-mail
    // row in this group is `failed`/`not_configured` since the release (no Mailgun env on the
    // gate), so a retry re-releases it too and the hand-off fails it again — the second retry
    // re-sends the e-mail rows only; the WhatsApp row (Q, now `released`) is not picked up again.
    const failedEmail = (await groupRows(fx.cycle.id, fx.pickupKey)).filter((r) => r.status === 'failed' && r.channel === 'email').length
    expect(failedEmail, 'non-vacuity: E\'s e-mail row failed at the release').toBeGreaterThan(0)
    const res = await post('retry', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ released: 1 + failedEmail, whatsapp: 1, email: failedEmail, skipped: 0 })
    const back = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.Q.id)[0]
    expect(back).toMatchObject({ status: 'released', error: 'not_on_whatsapp' })
    expect(back.released_at).not.toBe('2026-01-01 00:00:00')
    await expect.poll(async () => of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.E.id)[0].status, { timeout: 10_000 }).toBe('failed')
    const again = await post('retry', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(await again.json()).toMatchObject({ released: failedEmail, whatsapp: 0, email: failedEmail })
  })

  test('compose: a disabled template ⇒ 409 `template_disabled`; enabled ⇒ the not-ordered friend gets a queued row, the opted-out one none; idempotent; a locked cycle ⇒ 409 `cycle_not_open`; the empty `custom` ⇒ 409 `template_empty`; a hand-over key ⇒ 400 `not_composable`', async () => {
    const key = `not_ordered:${fx.cycle.id}`
    const closing = await getTemplate('closing')
    if (closing.enabled) await setTemplate('closing', { enabled: false })
    try {
      const off = await post('compose', { cycle_id: fx.cycle.id, segment_key: key })
      expect(off.status()).toBe(409)
      expect((await off.json()).reason).toBe('template_disabled')
      expect(await groupRows(fx.cycle.id, key)).toEqual([])
    } finally {
      if (closing.enabled) await setTemplate('closing', { enabled: true })
    }

    await withTemplate('closing', { enabled: true }, async () => {
      const res = await post('compose', { cycle_id: fx.cycle.id, segment_key: key })
      expect(res.status()).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({ segment_key: key, cycle_id: fx.cycle.id, template_key: 'closing' })
      expect(body.queued).toBeGreaterThanOrEqual(1)
      expect(body.counts.queued + body.counts.skipped).toBe(body.counts.total)
      const rows = await groupRows(fx.cycle.id, key)
      const n = of(rows, 'friend', fx.N.id)
      expect(n).toHaveLength(1)
      expect(n[0]).toMatchObject({ channel: 'whatsapp', status: 'queued', phone_e164: '+421905501005', unresolved: [] })
      expect(n[0].body).toContain(fx.N.first)
      expect(n[0].body, 'the closing date resolved').toContain('6. 11.')
      expect(of(rows, 'friend', fx.O.id), 'opted out ⇒ nothing for `closing` (D5 is operational-only)').toEqual([])
      expect(of(rows, 'friend', fx.P.id), 'P ordered').toEqual([])

      const again = await post('compose', { cycle_id: fx.cycle.id, segment_key: key })
      expect(again.status()).toBe(200)
      const second = await again.json()
      expect(second.queued, 'idempotent: nobody queued twice').toBe(0)
      expect(second.already).toBeGreaterThanOrEqual(body.queued)
      expect(of(await groupRows(fx.cycle.id, key), 'friend', fx.N.id)).toHaveLength(1)

      const locked = await makeCycle('locked')
      expect((await admin(`/api/cycles/${locked.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
      const notOpen = await post('compose', { cycle_id: locked.id, segment_key: `not_ordered:${locked.id}` })
      expect(notOpen.status()).toBe(409)
      expect((await notOpen.json()).reason).toBe('cycle_not_open')
      expect(await groupRows(locked.id, `not_ordered:${locked.id}`)).toEqual([])
    })

    const custom = await getTemplate('custom')
    if (!custom.body.trim()) {
      const empty = await post('compose', { cycle_id: null, segment_key: 'all_active' })
      expect(empty.status()).toBe(409)
      expect((await empty.json()).reason).toBe('template_empty')
    }
    const handOverKey = await post('compose', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey })
    expect(handOverKey.status()).toBe(400)
    expect((await handOverKey.json()).reason).toBe('not_composable')
  })

  test('a not-ordered group on a round with NO `closes_at` holds a literal `{datum}` ⇒ release 409 and every row stays queued', async () => {
    const c = await makeCycle('nodate')
    const key = `not_ordered:${c.id}`
    await withTemplate('closing', { enabled: true }, async () => {
      expect((await post('compose', { cycle_id: c.id, segment_key: key })).status()).toBe(200)
    })
    const rows = await groupRows(c.id, key)
    const n = of(rows, 'friend', fx.N.id)[0]
    expect(n.unresolved).toEqual(['{datum}'])
    expect(n.body).toContain('{datum}')
    const res = await post('release', { cycle_id: c.id, segment_key: key })
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('unresolved_placeholders')
    expect(body.ids).toContain(n.id)
    expect(await groupRows(c.id, key), 'NOTHING released').toEqual(rows)
    expect((await admin(`/api/cycles/${c.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
  })

  test('group bodies are validated: unbindable shapes ⇒ 400 (never 500), unknown cycle ⇒ 404, a key naming another cycle ⇒ 400, a key outside the grammar ⇒ 400 — on all four POST routes', async () => {
    const cases = [
      [{}, 400, 'invalid_segment_key'],
      [[1], 400, 'invalid_payload'],
      [[{ cycle_id: fx.cycle.id, segment_key: fx.pickupKey }], 400, 'invalid_payload'],
      [{ cycle_id: String(fx.cycle.id), segment_key: fx.pickupKey }, 400, 'invalid_cycle_id'],
      [{ cycle_id: 1.5, segment_key: fx.pickupKey }, 400, 'invalid_cycle_id'],
      [{ cycle_id: { id: 1 }, segment_key: fx.pickupKey }, 400, 'invalid_cycle_id'],
      [{ segment_key: fx.pickupKey }, 400, 'invalid_cycle_id'],
      [{ cycle_id: fx.cycle.id, segment_key: 'Bad Key' }, 400, 'invalid_segment_key'],
      [{ cycle_id: fx.cycle.id, segment_key: ['all_active'] }, 400, 'invalid_segment_key'],
      [{ cycle_id: fx.cycle.id, segment_key: `x${'a'.repeat(80)}` }, 400, 'invalid_segment_key'],
      [{ cycle_id: 999999999, segment_key: fx.pickupKey }, 404, 'unknown_cycle'],
      [{ cycle_id: fx.cycle.id, segment_key: `not_ordered:${fx.cycle.id + 100000}` }, 400, 'segment_cycle_mismatch'],
    ]
    for (const route of ['compose', 'release', 'retry', 'rerender']) {
      for (const [data, status, reason] of cases) {
        const res = await post(route, data)
        expect(res.status(), `${route} ${JSON.stringify(data).slice(0, 60)}`).toBe(status)
        expect((await res.json()).reason).toBe(reason)
      }
      for (const raw of ['true', '"abc"', '42']) {
        const res = await ctx.post(`/api/notifications/${route}`, {
          headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' }, data: raw, timeout: TIMEOUT,
        })
        expect(res.status(), `${route} ${raw}`).toBe(400)
      }
    }
  })

  test('anonymous AND a friend Bearer are 401 on every WA-T5 route (an admin route; a friend session is not an admin token)', async () => {
    const routes = [
      ['post', '/api/notifications/compose', { cycle_id: fx.cycle.id, segment_key: `not_ordered:${fx.cycle.id}` }],
      ['post', '/api/notifications/release', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey }],
      ['post', '/api/notifications/retry', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey }],
      ['post', '/api/notifications/rerender', { cycle_id: fx.cycle.id, segment_key: fx.pickupKey }],
      ['patch', '/api/notifications/1/body', { body: 'x' }],
      ['patch', '/api/notifications/1/manual-sent', { sent: true }],
      ['delete', '/api/notifications/1', undefined],
    ]
    for (const [method, path, data] of routes) {
      for (const headers of [{}, fx.P.auth]) {
        const res = await ctx[method](path, { headers, data, timeout: TIMEOUT })
        expect(res.status(), `${method} ${path} ${headers.Authorization ? 'friend' : 'anon'}`).toBe(401)
      }
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 DB_PATH — the waitlist over HTTP, the auto-compose on open
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T5 · §3 the waitlist through the routes (DB_PATH)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!DB_PATH, NEEDS_DB)
  const fx = {}

  // The waitlist has NO HTTP signup door while rounds are open (guest-waitlist.spec.js):
  // rows are written straight into the served database, exactly as GL-T3's signup would.
  const addWaitlist = (hostId, name, e164, optIn = 1) => withDb((db) => Number(db.prepare(
    'INSERT INTO guest_waitlist (host_friend_id, name, phone, phone_e164, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?)'
  ).run(hostId, name, `0912 ${Math.floor(Math.random() * 1e6)}`, e164, optIn).lastInsertRowid))
  const notifiedAt = (id) => withDb((db) => db.prepare('SELECT notified_at FROM guest_waitlist WHERE id = ?').get(id).notified_at)

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await ensureAdmin()
    fx.W = await makeFriend('Wera', { phone: '0905 502 001', login: false })
    const standing = await admin(`/api/friends/${fx.W.id}/guest-link/standing`)
    expect(standing.status()).toBe(200)
    fx.token = (await standing.json()).standing.token
    expect(fx.token).toBeTruthy()
    fx.cycle = await makeCycle('waitlist', { closes_at: '2026-11-06' })
  })

  test('compose `waitlist:<cycle>` ⇒ bodies with the host\'s first name + `/g/<guest_link_token>` (the FIFTH, admin-only publication surface); opt-in 0 never composed; release stamps `notified_at = released_at`; the segment then drops them', async () => {
    const w1 = addWaitlist(fx.W.id, `Wanda${uniq} Prvá`, '+421912502001')
    const w2 = addWaitlist(fx.W.id, `Wilma${uniq} Druhá`, '+421912502002')
    const w3 = addWaitlist(fx.W.id, `Wiktor${uniq} Nie`, '+421912502003', 0)
    const key = `waitlist:${fx.cycle.id}`
    await withTemplate('waitlist', { enabled: true }, async () => {
      const res = await post('compose', { cycle_id: fx.cycle.id, segment_key: key })
      expect(res.status()).toBe(200)
      let rows = await groupRows(fx.cycle.id, key)
      const mine = [w1, w2].map((id) => of(rows, 'waitlist', id)[0])
      for (const r of mine) {
        expect(r).toMatchObject({ status: 'queued', channel: 'whatsapp', template_key: 'waitlist', unresolved: [] })
        expect(r.body).toContain(fx.W.first)
        expect(r.body).toContain(`/g/${fx.token}`)
      }
      expect(of(rows, 'waitlist', w3), 'no consent ⇒ never composed').toEqual([])
      // The shared target's waitlist holds OTHER specs' rows too (some under hosts with no
      // standing link ⇒ a literal `{odkaz}`): the admin removes what is not theirs to send
      // — the product's own DELETE door — so this release measures these two rows.
      for (const r of rows.filter((x) => !mine.includes(x))) {
        expect((await admin(`/api/notifications/${r.id}`, { method: 'delete' })).status()).toBe(200)
      }
      const rel = await post('release', { cycle_id: fx.cycle.id, segment_key: key })
      expect(rel.status()).toBe(200)
      expect(await rel.json()).toMatchObject({ released: 2, whatsapp: 2, email: 0 })
      rows = await groupRows(fx.cycle.id, key)
      const stamp = of(rows, 'waitlist', w1)[0].released_at
      expect(stamp).toBeTruthy()
      expect([notifiedAt(w1), notifiedAt(w2), notifiedAt(w3)], 'D8: the API stamps at RELEASE').toEqual([stamp, stamp, null])
      const preview = await admin('/api/notifications/segments', { params: { cycle_id: String(fx.cycle.id), segment_key: key } })
      const recipients = (await preview.json()).segment.recipients
      expect(recipients.filter((r) => [w1, w2].includes(r.recipient_id)), 'the segment no longer lists them').toEqual([])
      const again = await post('compose', { cycle_id: fx.cycle.id, segment_key: key })
      expect(again.status()).toBe(200)
      const after = await groupRows(fx.cycle.id, key)
      expect(of(after, 'waitlist', w1).map((r) => r.status), 'a second compose finds nobody').toEqual(['released'])
    })
  })

  test('the cycle `status → open` PATCH AUTO-COMPOSES the waitlist group (never releases) while the template is on; with it off (the seed state) it is a silent no-op and the PATCH answers as before', async () => {
    const wOn = addWaitlist(fx.W.id, `Viola${uniq} Auto`, '+421912502010')
    const planned = async (label) => {
      const res = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA5 ${label} ${uniq}`, type: 'coffee', status: 'planned' } })
      expect(res.status()).toBe(201)
      return res.json()
    }
    const off = await planned('auto-off')
    await withTemplate('waitlist', { enabled: false }, async () => { // the seed state
      const openedOff = await admin(`/api/cycles/${off.id}`, { method: 'patch', data: { status: 'open' } })
      expect(openedOff.status()).toBe(200)
      expect((await openedOff.json()).status).toBe('open')
      expect(await groupRows(off.id, `waitlist:${off.id}`), 'template off ⇒ nothing composed').toEqual([])
    })

    const on = await planned('auto-on')
    await withTemplate('waitlist', { enabled: true }, async () => {
      const opened = await admin(`/api/cycles/${on.id}`, { method: 'patch', data: { status: 'open' } })
      expect(opened.status()).toBe(200)
      expect((await opened.json()).status).toBe('open')
      const rows = await groupRows(on.id, `waitlist:${on.id}`)
      const mine = of(rows, 'waitlist', wOn)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ status: 'queued', released_at: null })
      expect(mine[0].body).toContain(`/g/${fx.token}`)
      expect(rows.every((r) => r.status === 'queued' || r.status === 'skipped'), 'never auto-released').toBe(true)
      expect(notifiedAt(wOn), 'nothing stamped before a release').toBeNull()
      // A re-save of an already open round composes nothing new.
      const resave = await admin(`/api/cycles/${on.id}`, { method: 'patch', data: { status: 'open' } })
      expect(resave.status()).toBe(200)
      expect((await groupRows(on.id, `waitlist:${on.id}`)).length).toBe(rows.length)

      // A round CREATED open is a round opening too (learnings 15 §WA-T5).
      const direct = await makeCycle('auto-direct')
      expect(of(await groupRows(direct.id, `waitlist:${direct.id}`), 'waitlist', wOn)).toHaveLength(1)

      // ⚠ wOn is now queued in TWO rounds (the partial index keys on cycle_id). Releasing
      // one sends it; the other round's row is skipped `not_waiting` at ITS release — the
      // person is never messaged twice (WA-T5 review). Other specs' leftover rows are
      // removed through the DELETE door first (see the first test of this describe).
      for (const id of [direct.id, on.id]) {
        for (const r of (await groupRows(id, `waitlist:${id}`)).filter((x) => x.recipient_id !== wOn || x.recipient_kind !== 'waitlist')) {
          expect((await admin(`/api/notifications/${r.id}`, { method: 'delete' })).status()).toBe(200)
        }
      }
      const first = await post('release', { cycle_id: direct.id, segment_key: `waitlist:${direct.id}` })
      expect(first.status()).toBe(200)
      expect(await first.json()).toMatchObject({ released: 1, skipped: 0 })
      const second = await post('release', { cycle_id: on.id, segment_key: `waitlist:${on.id}` })
      expect(second.status()).toBe(200)
      expect(await second.json()).toMatchObject({ released: 0, whatsapp: 0, skipped: 1 })
      expect(of(await groupRows(on.id, `waitlist:${on.id}`), 'waitlist', wOn)[0]).toMatchObject({ status: 'skipped', error: 'not_waiting', released_at: null })
      expect(notifiedAt(wOn), 'stamped once, by the release that sent it').toBe(of(await groupRows(direct.id, `waitlist:${direct.id}`), 'waitlist', wOn)[0].released_at)
      expect((await admin(`/api/cycles/${direct.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    })
    for (const id of [off.id, on.id]) expect((await admin(`/api/cycles/${id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
  })

  test('a standing-link ROTATION between compose and release (the admin regenerate route) ⇒ the released body carries the NEW token, never the revoked one', async () => {
    const w = addWaitlist(fx.W.id, `Rita${uniq} Rotácia`, '+421912502030')
    const c = await makeCycle('rotation')
    const key = `waitlist:${c.id}`
    await withTemplate('waitlist', { enabled: true }, async () => {
      expect((await post('compose', { cycle_id: c.id, segment_key: key })).status()).toBe(200)
      const before = of(await groupRows(c.id, key), 'waitlist', w)[0]
      expect(before.body).toContain(`/g/${fx.token}`)
      const rotated = await admin(`/api/friends/${fx.W.id}/guest-link/standing/regenerate`, { method: 'post' })
      expect(rotated.status()).toBe(200)
      const fresh = (await rotated.json()).standing.token
      expect(fresh).not.toBe(fx.token)
      for (const r of (await groupRows(c.id, key)).filter((x) => x.id !== before.id)) {
        expect((await admin(`/api/notifications/${r.id}`, { method: 'delete' })).status()).toBe(200)
      }
      const rel = await post('release', { cycle_id: c.id, segment_key: key })
      expect(rel.status()).toBe(200)
      expect(await rel.json()).toMatchObject({ released: 1 })
      const after = of(await groupRows(c.id, key), 'waitlist', w)[0]
      expect(after.status).toBe('released')
      expect(after.body).toContain(`/g/${fresh}`)
      expect(after.body).not.toContain(fx.token)
      fx.token = fresh
    })
    expect((await admin(`/api/cycles/${c.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
  })

  test('`transactions` is untouched by compose / release / rerender / the tick (global row count)', async () => {
    const count = () => withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n)
    const before = count()
    const w = addWaitlist(fx.W.id, `Vavrinec${uniq} Ledger`, '+421912502020')
    const key = `waitlist:${fx.cycle.id}`
    await withTemplate('waitlist', { enabled: true }, async () => {
      expect((await post('compose', { cycle_id: fx.cycle.id, segment_key: key })).status()).toBe(200)
      expect((await post('rerender', { cycle_id: fx.cycle.id, segment_key: key })).status()).toBe(200)
      const row = of(await groupRows(fx.cycle.id, key), 'waitlist', w)[0]
      const tick = await admin(`/api/notifications/${row.id}/manual-sent`, { method: 'patch', data: { sent: true } })
      expect(tick.status()).toBe(200)
      expect(notifiedAt(w), 'a queued waitlist row ticked by hand is stamped too').toBe((await tick.json()).sent_at)
    })
    expect(count()).toBe(before)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §4 WA_HEALTH_URL — the `bot_active` duplicate-send guard against a live stub
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T5 · §4 `bot_active` (WA_HEALTH_URL)', () => {
  test.skip(!WA_HEALTH_URL, NEEDS_HEALTH)

  test('a RELEASED row while the health stub answers `connected` ⇒ 409 `bot_active`, row unchanged; the stub says `qr` ⇒ the tick goes through', async () => {
    test.setTimeout(120_000)
    await ensureAdmin()
    let state = 'connected'
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ state }))
    })
    const { port, hostname } = new URL(WA_HEALTH_URL)
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), hostname, resolve) })
    try {
      const cycle = await makeCycle('health', { closes_at: '2026-11-06' })
      const product = await admin('/api/products', {
        method: 'post', data: { cycle_id: cycle.id, name: `WA5H Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
      })
      const prod = await product.json()
      const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA5H Miesto ${uniq}`, for_coffee: true, for_bakery: true } })
      const L = await loc.json()
      const U = await makeFriend('Uršula', { phone: '0905 503 001' })
      const o = await ownOrder(U, cycle.id, [{ product_id: prod.id, variant: '250g', quantity: 1 }], { pickup_location_id: L.id })
      await packFriend(cycle.id, U, o.id)
      const h = await handOver(o.id)
      const key = `handed_over:pickup:${L.id}:${bratislavaDate(h.order.handed_over_at)}`
      expect((await post('release', { cycle_id: cycle.id, segment_key: key })).status()).toBe(200)
      const row = of(await groupRows(cycle.id, key), 'friend', U.id)[0]
      expect(row.status).toBe('released')

      const refused = await admin(`/api/notifications/${row.id}/manual-sent`, { method: 'patch', data: { sent: true } })
      expect(refused.status()).toBe(409)
      expect((await refused.json()).reason).toBe('bot_active')
      expect(of(await groupRows(cycle.id, key), 'friend', U.id)[0], 'read back unchanged').toEqual(row)

      state = 'qr'
      const ok = await admin(`/api/notifications/${row.id}/manual-sent`, { method: 'patch', data: { sent: true } })
      expect(ok.status()).toBe(200)
      expect(await ok.json()).toMatchObject({ status: 'sent', sent_via: 'wa_me' })
      await admin(`/api/pickup-locations/${L.id}`, { method: 'delete' })
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
