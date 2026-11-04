// Module 21 — WA-T4: 21 §UC-WA-006 (the hand-over enqueue contract module 16 calls) and
// §UC-WA-003's Decision D5 (an opted-out friend gets an e-mail row on an OPERATIONAL
// template, or nothing), as amended by „PO decisions 2026-09-19".
//
// The seam under test (`helpers/outbox.js`):
//   enqueueForHandOver({ cycleId, orderIds, guestOrderIds, handedOverAt })
//     → { queued, email, skipped, none, already, groups }
//   cancelForUnHandOver({ orderIds, guestOrderIds }) → { deleted, requeued }
// called by the THREE module-16 hand-over routes (`PATCH /orders/:id/handed-over`,
// `PATCH /guest-orders/:id/handed-over`, `POST /cycles/:id/distribution/hand-over`)
// inside their own transaction. Rows are read back through WA-T3's admin read route
// `GET /api/notifications?cycle_id=&segment_key=` (and, for the columns that route does
// not publish — `email`, `order_id` — through the served database with `DB_PATH`).
//
// THREE KINDS OF EVIDENCE, each where only it can work:
//   §1 THROWAWAY BOOTS — a child `node` imports `db/schema.js` + `helpers/outbox.js`
//      against a temp file: the one-time RE-KEY of DP-T3's legacy rows (it runs at
//      boot, and only a database that already HOLDS `loc<id>` rows can show it), the
//      two-orders-in-one-cycle ownership rule, and the `skipped` to-do that must not
//      stack — fixtures no route can build.
//   §2 HTTP on the gate server — every §UC-WA-006 acceptance criterion driven through
//      the REAL module-16 routes, fixtures through the real friend/guest/admin routes.
//   §3 DB_PATH-gated HTTP — a `sent` row (no route moves a row to `sent` before WA-T5)
//      and the `email` / `order_id` snapshots.
//
// NOTE ON RATE LIMITS: friend/admin auth sit on `authLimiter`; run with the raised
// budget (e2e/README.md).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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
const TIMEOUT = 20_000
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
// Gated on schema.js (the backend tree) — never on the file under test (learnings 15 §WA-T2).
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => pathToFileURL(join(BACKEND_SRC, rel)).href
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// 21 §UC-WA-008: the segment-key grammar, and the release's literal-placeholder test —
// INDEPENDENT copies (the spec must not import what it tests).
const GRAMMAR = /^[a-z_]+(:[A-Za-z0-9-]+)*$/
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
function probe(dbFile, body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t4-probe-'))
  const script = join(dir, 'probe.mjs')
  writeFileSync(
    script,
    `import db from '${srcUrl('db/schema.js')}';\n`
      + `import * as outbox from '${srcUrl('helpers/outbox.js')}';\n`
      + `const out = (() => {\n${body}\n})();\n`
      + `console.log('@@PROBE@@' + JSON.stringify(out));\n`
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

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t4-db-'))
  try {
    return fn(join(dir, 'wa-t4.sqlite'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A friend with two orders in one cycle + a location, stamped; shared by two probes.
const FIXTURE_JS = `
  db.run("INSERT INTO order_cycles (name, status, closes_at) VALUES ('wa-t4', 'locked', '2026-11-06')");
  const cyc = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
  const loc = db.run("INSERT INTO pickup_locations (name, address) VALUES ('Probe Miesto', 'Ulica 4')").lastInsertRowid;
  const friend = (name, phoneE164, email = null) => db.run(
    'INSERT INTO friends (cycle_id, name, access_token, phone, phone_e164, email, active, whatsapp_opt_in) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
    [cyc, name, 'acc-' + name.replace(/ /g, ''), phoneE164 ? '0905 444 001' : null, phoneE164, email]).lastInsertRowid;
  const order = (fid) => db.run(
    "INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id, total) VALUES (?, ?, 'submitted', 1, ?, 10)",
    [fid, cyc, loc]).lastInsertRowid;
  const stamp = (id) => db.run('UPDATE orders SET handed_over_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  const unstamp = (id) => db.run('UPDATE orders SET handed_over_at = NULL WHERE id = ?', [id]);
  const rows = () => db.all('SELECT channel, status, order_id, error, segment_key FROM notifications WHERE cycle_id = ? ORDER BY id', [cyc]);
  const tx = (fn) => db.transaction(fn)();
`

test.describe('WA-T4 · §1 throwaway boots', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('the boot RE-KEYS DP-T3\'s legacy rows (`loc<id>` / `packeta` / `host:<id>`) onto 21\'s grammar — dated from the party (queued) or the row (history), a deleted point keeps its group, an undatable row gets a grammatical fallback, nothing else moves, idempotent', () => {
    withTempDb((file) => {
      // Boot 1: an EMPTY outbox (the re-key finds nothing), then the legacy rows, written
      // exactly as DP-T3's hook wrote them — `body`/`phone_e164` NULL, the old keys.
      const ids = probe(file, `
        db.run("INSERT INTO order_cycles (name, status) VALUES ('legacy', 'locked')");
        const cyc = db.get('SELECT MAX(id) AS id FROM order_cycles').id;
        const loc = db.run("INSERT INTO pickup_locations (name) VALUES ('Legacy Miesto')").lastInsertRowid;
        const fid = db.run("INSERT INTO friends (cycle_id, name, access_token) VALUES (?, 'Legacy Host', 'acc-legacy')", [cyc]).lastInsertRowid;
        // 22:30 UTC on the 23rd is the 24th in Bratislava — the conversion must happen.
        const oid = db.run("INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id, handed_over_at) VALUES (?, ?, 'submitted', 1, ?, '2026-10-23 22:30:00')", [fid, cyc, loc]).lastInsertRowid;
        const link = db.run("INSERT INTO guest_order_links (token, host_friend_id, cycle_id) VALUES ('WAT4LEGACY0001', ?, ?)", [fid, cyc]).lastInsertRowid;
        const g = (tok, stamp) => db.run("INSERT INTO guest_orders (link_id, order_token, guest_name, guest_phone, handed_over_at) VALUES (?, ?, 'Hosť', '0905 000 000', ?)", [link, tok, stamp]).lastInsertRowid;
        const g1 = g('WAT4LEGORD0001', '2026-10-24 08:00:00');
        const g2 = g('WAT4LEGORD0002', null);
        const ins = (tpl, key, kind, rid, status, created, orderId, guestId) => db.run(
          'INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, status, cycle_id, order_id, guest_order_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ['whatsapp', tpl, key, kind, rid, status, cyc, orderId, guestId, created]).lastInsertRowid;
        return {
          cyc, loc, fid,
          queuedPickup: ins('pickup', 'loc' + loc, 'friend', fid, 'queued', '2026-10-20 10:00:00', oid, null),
          sentPickup: ins('pickup', 'loc' + loc, 'friend', fid, 'sent', '2026-10-20 10:00:00', oid, null),
          queuedPacketa: ins('packeta', 'packeta', 'guest', g1, 'queued', '2026-10-01 10:00:00', null, g1),
          sentHost: ins('host', 'host:' + fid, 'guest', g2, 'sent', '2026-09-01 23:30:00', null, g2),
          deletedPoint: ins('pickup', 'loc999', 'friend', 4242, 'queued', '2026-10-01 12:00:00', null, null),
          undatable: ins('host', 'host:7', 'guest', 4343, 'skipped', 'garbage', null, null),
          grammar1: ins('custom', 'all_active', 'friend', fid, 'sent', '2026-10-01 12:00:00', null, null),
          grammar2: ins('packeta', 'handed_over:packeta:2026-10-01', 'guest', g2, 'sent', '2026-10-01 12:00:00', null, g2),
        };
      `)

      const read = (f) => new DatabaseSync(f, { readOnly: true })
      const keysOf = () => {
        const db = read(file)
        try {
          return Object.fromEntries(db.prepare('SELECT id, segment_key FROM notifications ORDER BY id').all().map((r) => [r.id, r.segment_key]))
        } finally { db.close() }
      }

      // Boot 2 = the deploy's restart: the re-key runs.
      probe(file, 'return true;')
      const after = keysOf()
      expect(after[ids.queuedPickup], 'queued ⇒ the PARTY\'s stamp first (UTC 22:30 on the 23rd = the 24th)')
        .toBe(`handed_over:pickup:${ids.loc}:2026-10-24`)
      expect(after[ids.sentPickup], 'history ⇒ the ROW\'s created_at first').toBe(`handed_over:pickup:${ids.loc}:2026-10-20`)
      expect(after[ids.queuedPacketa], 'a queued guest row dates from its sub-order').toBe('handed_over:packeta:2026-10-24')
      expect(after[ids.sentHost], 'no party stamp ⇒ created_at (23:30 UTC = next day in summer)').toBe(`host_guests:${ids.fid}:2026-09-02`)
      expect(after[ids.deletedPoint], 'a point that no longer exists keeps its group (FUP-T23) — only the label is lost')
        .toBe('handed_over:pickup:999:2026-10-01')
      expect(after[ids.undatable], 'no usable date ⇒ a GRAMMATICAL fallback that keeps the group').toBe('legacy_handover:host-7')
      expect(after[ids.grammar1], 'a 21-grammar row is untouched').toBe('all_active')
      expect(after[ids.grammar2]).toBe('handed_over:packeta:2026-10-01')
      for (const [id, key] of Object.entries(after)) expect(key, `row ${id} satisfies 21's grammar`).toMatch(GRAMMAR)
      expect(Object.keys(after), 'not one row dropped').toHaveLength(8)

      // Boot 3: idempotent.
      probe(file, 'return true;')
      expect(keysOf(), 'a second boot changes nothing').toEqual(after)
    })
  })

  test('⚠ a friend with TWO orders in one cycle: ONE queued row (the index\'s own tuple), counted `already` and never thrown; un-handing the OWNING bag re-mints the row for the bag still handed over; un-handing that one leaves nothing', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const fid = friend('Dvojitý Test', '+421905444001');
      const o1 = order(fid); const o2 = order(fid);
      const r = {};
      tx(() => { stamp(o1); stamp(o2); r.enq = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o1, o2] }); });
      r.afterEnq = rows();
      tx(() => { unstamp(o1); r.cancel1 = outbox.cancelForUnHandOver({ orderIds: [o1] }); });
      r.afterCancel1 = rows();
      tx(() => { unstamp(o2); r.cancel2 = outbox.cancelForUnHandOver({ orderIds: [o2] }); });
      r.afterCancel2 = rows();
      r.o1 = o1; r.o2 = o2;
      return r;
    `))
    expect(out.enq).toMatchObject({ queued: 1, email: 0, skipped: 0, none: 0, already: 1 })
    expect(out.afterEnq).toHaveLength(1)
    expect(out.afterEnq[0]).toMatchObject({ channel: 'whatsapp', status: 'queued', order_id: out.o1 })
    expect(out.cancel1, 'the owner\'s row goes — and comes back for the bag that is still out').toEqual({ deleted: 1, requeued: 1 })
    expect(out.afterCancel1).toHaveLength(1)
    expect(out.afterCancel1[0]).toMatchObject({ status: 'queued', order_id: out.o2 })
    expect(out.cancel2).toEqual({ deleted: 1, requeued: 0 })
    expect(out.afterCancel2).toEqual([])
  })

  test('a `skipped` to-do never STACKS (hand → un-hand → hand on a number-less friend = one row), but it does not block the queued row once a number exists', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const fid = friend('Bez Čísla', null);
      const o = order(fid);
      const r = {};
      tx(() => { stamp(o); r.first = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o] }); });
      tx(() => { unstamp(o); r.cancel = outbox.cancelForUnHandOver({ orderIds: [o] }); });
      tx(() => { stamp(o); r.second = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o] }); });
      r.afterLoop = rows();
      tx(() => { unstamp(o); outbox.cancelForUnHandOver({ orderIds: [o] }); });
      db.run("UPDATE friends SET phone = '0905 444 002', phone_e164 = '+421905444002' WHERE id = ?", [fid]);
      tx(() => { stamp(o); r.withPhone = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o] }); });
      r.final = rows();
      return r;
    `))
    expect(out.first).toMatchObject({ queued: 0, skipped: 1, already: 0 })
    expect(out.cancel, 'a skipped row is history to the reversal (§UC-WA-006: queued only)').toEqual({ deleted: 0, requeued: 0 })
    expect(out.second).toMatchObject({ skipped: 0, already: 1 })
    expect(out.afterLoop).toEqual([expect.objectContaining({ channel: 'whatsapp', status: 'skipped', error: 'no_phone' })])
    expect(out.withPhone).toMatchObject({ queued: 1, already: 0 })
    expect(out.final.map((r) => r.status)).toEqual(['skipped', 'queued'])
  })

  test('an UNSHAPED e-mail is ABSENT (the `EMAIL_SHAPE` one-home rule): with a phone that did not normalise ⇒ `skipped`/`no_phone`; on an opted-out friend ⇒ no row at all', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      // A phone that did not normalise (\`phone_e164\` NULL) and an e-mail that fails the
      // mailer's shape — the via_host-checkout / admin-typed case.
      const plain = db.run("INSERT INTO friends (cycle_id, name, access_token, phone, phone_e164, email, active, whatsapp_opt_in) VALUES (?, 'Zly Mail', 'acc-zly', '123', NULL, 'nie-je-adresa', 1, 1)", [cyc]).lastInsertRowid;
      const optedOut = db.run("INSERT INTO friends (cycle_id, name, access_token, phone, phone_e164, email, active, whatsapp_opt_in) VALUES (?, 'Zly Odhlaseny', 'acc-zlyo', '0905 444 009', '+421905444009', 'a@b', 1, 0)", [cyc]).lastInsertRowid;
      const o1 = order(plain); const o2 = order(optedOut);
      const r = {};
      tx(() => { stamp(o1); stamp(o2); r.enq = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [o1, o2] }); });
      r.rows = db.all('SELECT order_id, channel, status, error, email, phone_e164 FROM notifications WHERE cycle_id = ? ORDER BY id', [cyc]);
      r.o1 = o1;
      // Non-vacuity: the SAME friend with a shaped address gets the e-mail fallback.
      r.plan = outbox.planRow({ key: 'pickup', enabled: true }, { phone_e164: null, email: ' ok@example.test ' });
      return r;
    `))
    expect(out.enq).toMatchObject({ queued: 0, email: 0, skipped: 1, none: 1 })
    expect(out.rows).toEqual([{ order_id: out.o1, channel: 'whatsapp', status: 'skipped', error: 'no_phone', email: null, phone_e164: null }])
    expect(out.plan).toMatchObject({ channel: 'email', status: 'queued', email: 'ok@example.test' })
  })

  test('the counts PARTITION the requested bags: an unknown cycle, a bag that is not handed over and a foreign id are `none`; nothing throws', () => {
    const out = withTempDb((file) => probe(file, `
      ${FIXTURE_JS}
      const fid = friend('Počty Test', '+421905444003');
      const handed = order(fid); const notHanded = order(friend('Nie Odovzdaný', '+421905444004'));
      const r = {};
      tx(() => {
        stamp(handed);
        r.mixed = outbox.enqueueForHandOver({ cycleId: cyc, orderIds: [handed, notHanded, 999999], guestOrderIds: [888888] });
        r.noCycle = outbox.enqueueForHandOver({ cycleId: 999999, orderIds: [handed] });
        r.empty = outbox.enqueueForHandOver({ cycleId: cyc });
        r.cancelNothing = outbox.cancelForUnHandOver({});
      });
      return r;
    `))
    expect(out.mixed).toMatchObject({ queued: 1, email: 0, skipped: 0, none: 3, already: 0 })
    expect(out.mixed.groups).toHaveLength(1)
    expect(out.mixed.groups[0]).toMatch(/^handed_over:pickup:\d+:\d{4}-\d{2}-\d{2}$/)
    expect(out.noCycle).toMatchObject({ queued: 0, none: 1 })
    expect(out.empty).toEqual({ queued: 0, email: 0, skipped: 0, none: 0, already: 0, groups: [] })
    expect(out.cancelNothing).toEqual({ deleted: 0, requeued: 0 })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 HTTP — the gate server, the REAL module-16 routes
// ═════════════════════════════════════════════════════════════════════════════
let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})
test.afterAll(async () => { await ctx?.dispose() })

let friendSeq = 0
async function makeFriend(label, { phone, email } = {}) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `wa4_${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  // First name = the first token, unique per run, so `{meno}`/`{host}` are assertable.
  const first = `W4${label}${uniq}${friendSeq}`
  const name = `${first} Test`
  const data = { name }
  if (phone) data.phone = phone
  if (email) data.email = email
  const created = await admin('/api/friends', { method: 'post', data })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
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
  return { id: row.id, name, first, email: email || null, auth: { Authorization: `Bearer ${token}` } }
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
async function packGuestParty(cycleId, guestOrderId) {
  const party = (await distribution(cycleId)).distribution.find((p) => p.kind === 'guest' && p.guest_order_id === guestOrderId)
  expect(party, 'the Packeta guest is its own party').toBeTruthy()
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
}
async function handOver(orderId, flag = true) {
  const res = await admin(`/api/orders/${orderId}/handed-over`, { method: 'patch', data: { handed_over: flag } })
  expect(res.status(), `hand-over ${flag}`).toBe(200)
  return res.json()
}
async function handOverGuest(guestOrderId, flag = true) {
  const res = await admin(`/api/guest-orders/${guestOrderId}/handed-over`, { method: 'patch', data: { handed_over: flag } })
  expect(res.status(), `guest hand-over ${flag}`).toBe(200)
  return res.json()
}
async function groupRows(cycleId, segmentKey) {
  const res = await admin('/api/notifications', { params: { cycle_id: String(cycleId), segment_key: segmentKey } })
  expect(res.status(), `GET /notifications ${segmentKey}`).toBe(200)
  return (await res.json()).rows
}
async function allRows(cycleId) {
  const res = await admin('/api/notifications/segments', { params: { cycle_id: String(cycleId) } })
  expect(res.status()).toBe(200)
  const out = []
  for (const g of (await res.json()).groups) {
    for (const row of await groupRows(cycleId, g.segment_key)) out.push({ ...row, segment_key: g.segment_key })
  }
  return out
}
const of = (rows, kind, id) => rows.filter((r) => r.recipient_kind === kind && r.recipient_id === id)
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

test.describe('WA-T4 · §2 21 §UC-WA-006 through the real module-16 routes', () => {
  test.describe.configure({ mode: 'serial' })
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const cycle = await admin('/api/cycles', {
      method: 'post', data: { name: `E2E WA4 ${uniq}`, type: 'coffee', status: 'open', closes_at: '2026-11-06' },
    })
    expect(cycle.status()).toBe(201)
    fx.cycle = await cycle.json()
    expect((await admin(`/api/cycles/${fx.cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.9 } })).status()).toBe(200)
    const product = await admin('/api/products', {
      method: 'post', data: { cycle_id: fx.cycle.id, name: `WA4 Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
    })
    expect(product.status()).toBe(201)
    fx.product = await product.json()
    const line = () => [{ product_id: fx.product.id, variant: '250g', quantity: 1 }]
    const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA4 Miesto ${uniq}`, address: 'Ulica WA4', for_coffee: true, for_bakery: true } })
    expect(loc.status()).toBe(201)
    fx.L = await loc.json()
    const pickup = { pickup_location_id: fx.L.id }

    fx.P = await makeFriend('Pavla', { phone: '0905 401 001' }) // pickup, the loop + sent friend
    fx.H = await makeFriend('Hana', { phone: '0905 401 002' }) // host at L
    fx.I = await makeFriend('Igor', { phone: '0905 401 003' }) // in_person
    fx.N = await makeFriend('Nora') // no phone, no e-mail
    fx.E = await makeFriend('Emil', { email: `wa4.emil.${uniq}@example.test` }) // e-mail only
    fx.O1 = await makeFriend('Oto', { phone: '0905 401 006', email: `wa4.oto.${uniq}@example.test` }) // opted out, e-mail
    fx.O2 = await makeFriend('Olga', { phone: '0905 401 007' }) // opted out, no e-mail
    fx.K = await makeFriend('Karol', { phone: '0905 401 008' }) // Packeta — template disabled
    fx.B = await makeFriend('Bulko', { phone: '0905 401 009' }) // bulk route
    fx.V = await makeFriend('Viktor', { phone: '0905 401 010' }) // host whose guest is handed over DIRECTLY

    fx.oP = await ownOrder(fx.P, fx.cycle.id, line(), pickup)
    fx.oH = await ownOrder(fx.H, fx.cycle.id, line(), pickup)
    fx.oI = await ownOrder(fx.I, fx.cycle.id, line(), { pickup_location_note: 'Osobne u mňa' })
    fx.oN = await ownOrder(fx.N, fx.cycle.id, line(), pickup)
    fx.oE = await ownOrder(fx.E, fx.cycle.id, line(), pickup)
    fx.oO1 = await ownOrder(fx.O1, fx.cycle.id, line(), pickup)
    fx.oO2 = await ownOrder(fx.O2, fx.cycle.id, line(), pickup)
    fx.oK = await ownOrder(fx.K, fx.cycle.id, line(), { use_parcel_delivery: true, packeta_address: `Z-BOX WA4 ${uniq}` })
    fx.oB = await ownOrder(fx.B, fx.cycle.id, line(), pickup)
    fx.oV = await ownOrder(fx.V, fx.cycle.id, line(), pickup)

    const link = await ctx.post(`/api/guest-links/cycle/${fx.cycle.id}`, { headers: fx.H.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(link.status())
    fx.link = (await link.json()).link
    const guest = async (data) => {
      const res = await ctx.post(`/api/guest/${fx.link.token}/orders`, { data: { items: line(), ...data }, timeout: TIMEOUT })
      expect(res.status(), 'guest submit').toBe(201)
      return (await res.json()).order
    }
    fx.G1 = await guest({ guest_name: `Gabika${uniq} Hosťová`, guest_phone: '0911 401 001' })
    fx.G2 = await guest({ guest_name: `Gejza${uniq} Hosť`, guest_phone: '0911 401 002' })
    fx.G3 = await guest({ guest_name: `Gusto${uniq} Zrušený`, guest_phone: '0911 401 003' })
    fx.GP = await guest({
      guest_name: `Gustav${uniq} Packeta`, guest_phone: '0911 401 004', guest_email: `wa4.gp.${uniq}@example.test`,
      use_parcel_delivery: true, packeta_address: `Z-BOX Hosť WA4 ${uniq}`,
    })
    expect((await admin(`/api/guest-orders/${fx.G3.id}/cancel`, { method: 'post' })).status(), 'G3 cancelled BEFORE the hand-over').toBe(200)

    const vLink = await ctx.post(`/api/guest-links/cycle/${fx.cycle.id}`, { headers: fx.V.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(vLink.status())
    const vRes = await ctx.post(`/api/guest/${(await vLink.json()).link.token}/orders`, {
      data: { items: line(), guest_name: `Vierka${uniq} Hosťová`, guest_phone: '0911 401 005' }, timeout: TIMEOUT,
    })
    expect(vRes.status(), 'V guest submit').toBe(201)
    fx.GV = (await vRes.json()).order

    for (const f of [fx.O1, fx.O2]) {
      expect((await admin(`/api/friends/${f.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status(), 'opt out').toBe(200)
    }

    for (const [f, o] of [[fx.P, fx.oP], [fx.H, fx.oH], [fx.I, fx.oI], [fx.N, fx.oN], [fx.E, fx.oE], [fx.O1, fx.oO1], [fx.O2, fx.oO2], [fx.K, fx.oK], [fx.B, fx.oB]]) {
      await packFriend(fx.cycle.id, f, o.id)
    }
    await packGuestParty(fx.cycle.id, fx.GP.id)
    // GV: ONLY the guest's items — the guest route's pack gate; V's own bag stays unpacked.
    const vParty = (await distribution(fx.cycle.id)).distribution.find((p) => p.id === fx.V.id && p.kind === 'friend')
    const gv = vParty.guest_orders.find((g) => g.id === fx.GV.id)
    for (const item of gv.items) if (!item.packed) expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  })

  test.afterAll(async () => {
    if (fx.L) {
      const res = await admin(`/api/pickup-locations/${fx.L.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('a packed PICKUP bag ⇒ exactly ONE queued whatsapp row in `handed_over:pickup:<loc>:<date>`, the friend\'s E.164 number, a body naming the location with no literal placeholder; the ledger does not move', async () => {
    const before = await ledger(fx.P.id)
    const res = await handOver(fx.oP.id)
    expect(res.queued_notifications).toBe(1)
    fx.today = bratislavaDate(res.order.handed_over_at)
    fx.pickupKey = `handed_over:pickup:${fx.L.id}:${fx.today}`
    const rows = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.P.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ template_key: 'pickup', channel: 'whatsapp', status: 'queued', phone_e164: '+421905401001', error: null })
    expect(rows[0].body).toContain(fx.L.name)
    expect(rows[0].body).toContain(fx.P.first)
    expect(rows[0].body, 'every placeholder resolved for a resolvable friend').not.toMatch(PLACEHOLDER)
    expect(await ledger(fx.P.id), '⚠ a hand-over is not a financial event').toEqual(before)
  })

  test('a HOST with two live guests + one cancelled ⇒ two `host` rows to the GUESTS\' numbers in `host_guests:<host>:<date>`, none for the cancelled; the host gets its own pickup row', async () => {
    const res = await handOver(fx.oH.id)
    expect(res.queued_notifications, 'the host + two live guests').toBe(3)
    fx.hostKey = `host_guests:${fx.H.id}:${bratislavaDate(res.order.handed_over_at)}`
    const rows = await groupRows(fx.cycle.id, fx.hostKey)
    expect(rows.map((r) => `${r.recipient_kind}:${r.recipient_id}`).sort()).toEqual([`guest:${fx.G1.id}`, `guest:${fx.G2.id}`].sort())
    expect(of(rows, 'guest', fx.G1.id)[0]).toMatchObject({ template_key: 'host', channel: 'whatsapp', status: 'queued', phone_e164: '+421911401001' })
    expect(of(rows, 'guest', fx.G2.id)[0].phone_e164).toBe('+421911401002')
    for (const r of rows) {
      expect(r.body, 'the message names the host').toContain(fx.H.first)
      expect(r.body).not.toMatch(PLACEHOLDER)
    }
    const all = await allRows(fx.cycle.id)
    expect(of(all, 'guest', fx.G3.id), 'the cancelled sub-order is messaged nowhere').toEqual([])
    expect(of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.H.id)).toHaveLength(1)
    expect(of(all, 'guest', fx.GP.id), 'the own-Packeta guest is NOT inherited by the host').toEqual([])
  })

  test('an own-Packeta GUEST ⇒ a `packeta` row in `handed_over:packeta:<date>` (its own party, never under the host)', async () => {
    const res = await handOverGuest(fx.GP.id)
    expect(res.queued_notifications).toBe(1)
    const key = `handed_over:packeta:${bratislavaDate(res.guest_order.handed_over_at)}`
    const rows = of(await groupRows(fx.cycle.id, key), 'guest', fx.GP.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ template_key: 'packeta', channel: 'whatsapp', status: 'queued', phone_e164: '+421911401004' })
    expect(rows[0].body).toContain(`Z-BOX Hosť WA4 ${uniq}`)
    expect(of(await groupRows(fx.cycle.id, fx.hostKey), 'guest', fx.GP.id)).toEqual([])
  })

  test('a via_host guest handed over DIRECTLY (`PATCH /guest-orders/:id/handed-over`) ⇒ `host` template in `host_guests:<host>:<date>`, the guest\'s own number, a rendered body; un-handing it on the same route deletes the queued row', async () => {
    const res = await handOverGuest(fx.GV.id)
    expect(res.queued_notifications).toBe(1)
    const key = `host_guests:${fx.V.id}:${bratislavaDate(res.guest_order.handed_over_at)}`
    const rows = of(await groupRows(fx.cycle.id, key), 'guest', fx.GV.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ template_key: 'host', channel: 'whatsapp', status: 'queued', phone_e164: '+421911401005' })
    expect(rows[0].body).toContain(fx.V.first)
    expect(rows[0].body).toContain(`Vierka${uniq}`)
    expect(rows[0].body).not.toMatch(PLACEHOLDER)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.V.id), 'the host\'s own bag was not handed over').toEqual([])

    const back = await handOverGuest(fx.GV.id, false)
    expect(back.dequeued_notifications).toBe(1)
    expect(of(await allRows(fx.cycle.id), 'guest', fx.GV.id)).toEqual([])
  })

  test('an `in_person` bag ⇒ NOTHING (resolved conflict 4)', async () => {
    const res = await handOver(fx.oI.id)
    expect(res.order.handed_over_at, 'non-vacuity: it WAS handed over').toBeTruthy()
    expect(res.queued_notifications).toBe(0)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.I.id)).toEqual([])
  })

  test('no phone AND no e-mail ⇒ a `skipped` whatsapp row, `error = no_phone` (the composer\'s to-do), not counted as queued', async () => {
    const res = await handOver(fx.oN.id)
    expect(res.queued_notifications, 'a to-do is not a queued message').toBe(0)
    const rows = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.N.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ channel: 'whatsapp', status: 'skipped', error: 'no_phone', phone_e164: null })
    expect(rows[0].body, 'the text is there for the admin to send by hand').toContain(fx.N.first)
  })

  test('no phone, an e-mail ⇒ an `email` row, `queued` (R5.8 fallback)', async () => {
    const res = await handOver(fx.oE.id)
    expect(res.queued_notifications).toBe(1)
    const rows = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.E.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ channel: 'email', status: 'queued', phone_e164: null, error: null })
    if (DB_PATH) {
      const row = withDb((db) => db.prepare('SELECT email, order_id FROM notifications WHERE id = ?').get(rows[0].id))
      expect(row, 'the e-mail SNAPSHOT').toEqual({ email: fx.E.email, order_id: fx.oE.id })
    }
  })

  test('D5: an OPTED-OUT friend with an e-mail ⇒ exactly one `email` row and no whatsapp row; without an e-mail ⇒ no row at all', async () => {
    const r1 = await handOver(fx.oO1.id)
    expect(r1.queued_notifications).toBe(1)
    const o1 = of(await allRows(fx.cycle.id), 'friend', fx.O1.id)
    expect(o1).toHaveLength(1)
    expect(o1[0]).toMatchObject({ channel: 'email', status: 'queued', phone_e164: null, template_key: 'pickup' })
    if (DB_PATH) {
      expect(withDb((db) => db.prepare('SELECT email FROM notifications WHERE id = ?').get(o1[0].id).email)).toBe(fx.O1.email)
    }

    const r2 = await handOver(fx.oO2.id)
    expect(r2.order.handed_over_at, 'non-vacuity: O2 WAS handed over').toBeTruthy()
    expect(r2.queued_notifications).toBe(0)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.O2.id), 'they see the stage in the app').toEqual([])
  })

  test('a DISABLED template ⇒ no row (and enabling it later back-fills nothing)', async () => {
    const off = await admin('/api/notifications/templates/packeta', { method: 'put', data: { enabled: false } })
    expect(off.status()).toBe(200)
    try {
      const res = await handOver(fx.oK.id)
      expect(res.order.handed_over_at).toBeTruthy()
      expect(res.queued_notifications).toBe(0)
    } finally {
      const on = await admin('/api/notifications/templates/packeta', { method: 'put', data: { enabled: true } })
      expect(on.status(), 'template restored').toBe(200)
      expect((await on.json()).enabled).toBe(true)
    }
    expect(of(await allRows(fx.cycle.id), 'friend', fx.K.id), 'no back-fill on enable').toEqual([])
  })

  test('hand-over → un-hand-over → hand-over ⇒ ONE queued row; the un-hand-over deletes it; `transactions` unmoved across all three', async () => {
    const before = await ledger(fx.P.id)
    const back = await handOver(fx.oP.id, false)
    expect(back.dequeued_notifications).toBe(1)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.P.id)).toEqual([])
    const again = await handOver(fx.oP.id)
    expect(again.queued_notifications).toBe(1)
    const rows = of(await allRows(fx.cycle.id), 'friend', fx.P.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('queued')
    expect(await ledger(fx.P.id)).toEqual(before)
  })

  test('the un-hand-over of a HOST deletes the guests\' queued rows too — and leaves the skipped to-do of another party alone', async () => {
    const back = await handOver(fx.oH.id, false)
    expect(back.dequeued_notifications, 'the host + both guests').toBe(3)
    const all = await allRows(fx.cycle.id)
    expect(of(all, 'guest', fx.G1.id)).toEqual([])
    expect(of(all, 'guest', fx.G2.id)).toEqual([])
    expect(of(all, 'friend', fx.H.id)).toEqual([])
    expect(of(all, 'friend', fx.N.id).map((r) => r.status), 'another party\'s rows are untouched').toEqual(['skipped'])
  })

  test('the BULK route enqueues through the same seam: the 21-grammar key, a rendered body', async () => {
    const res = await admin(`/api/cycles/${fx.cycle.id}/distribution/hand-over`, { method: 'post', data: { order_ids: [fx.oB.id], guest_order_ids: [] } })
    expect(res.status()).toBe(200)
    expect((await res.json()).queued_notifications).toBe(1)
    const rows = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.B.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ template_key: 'pickup', channel: 'whatsapp', status: 'queued', phone_e164: '+421905401009' })
    expect(rows[0].body).toContain(fx.B.first)
  })

  test('every group of the cycle is in 21\'s grammar, titled, and readable through the validated rows route', async () => {
    const res = await admin('/api/notifications/segments', { params: { cycle_id: String(fx.cycle.id) } })
    const { groups } = await res.json()
    expect(groups.length, 'non-vacuity').toBeGreaterThanOrEqual(2)
    for (const g of groups) {
      expect(g.segment_key).toMatch(GRAMMAR)
      expect(g.name, `${g.segment_key} has a title`).toBeTruthy()
    }
  })

  test('§3 · un-hand-over deletes QUEUED rows only — a `sent` row survives it, and a genuine re-hand-over queues a new one beside it', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const rows = of(await groupRows(fx.cycle.id, fx.pickupKey), 'friend', fx.P.id)
    expect(rows).toHaveLength(1)
    withDb((db) => db.prepare("UPDATE notifications SET status = 'sent', sent_at = CURRENT_TIMESTAMP, sent_via = 'bot' WHERE id = ?").run(rows[0].id))

    const back = await handOver(fx.oP.id, false)
    expect(back.dequeued_notifications, 'history is never deleted').toBe(0)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.P.id).map((r) => r.status)).toEqual(['sent'])

    const again = await handOver(fx.oP.id)
    expect(again.queued_notifications, 'a sent row does not block a new event').toBe(1)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.P.id).map((r) => r.status).sort()).toEqual(['queued', 'sent'])
    const back2 = await handOver(fx.oP.id, false)
    expect(back2.dequeued_notifications).toBe(1)
    expect(of(await allRows(fx.cycle.id), 'friend', fx.P.id).map((r) => r.status)).toEqual(['sent'])
  })
})
