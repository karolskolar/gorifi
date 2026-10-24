// Module 21 — WA-T6: the e-mail fallback `channel='email'` (21 §UC-WA-010).
//
// The ONE place the API process sends a notification itself: `helpers/outbox.js
// handOffEmailRows(ids)`, called by the release and the retry AFTER their transaction
// committed (WA-T5's seam), hands each RELEASED e-mail row to module 08's mailer
// fire-and-forget — `renderEmail({ text: body, blocks: [{ type: 'paragraph', text: body }] })`
// → `sendMail({ to: row.email, subject: 'Podpultovka · ' + template name, text, html })` —
// and the `.then` writes the result through a CONDITIONAL `UPDATE … WHERE id = ? AND
// status = 'released'`: `sent`/`email` on `{ sent: true }`, else `failed`/<the mailer's
// fixed result code>. A 0-row write (the manual tick got there first) logs ONE line.
//
// TWO KINDS OF EVIDENCE, each where only it can work:
//   §1 THROWAWAY BOOTS — a child `node` imports `db/schema.js` + `helpers/outbox.js`
//      against a temp file with NO Mailgun env: the hand-off's own contract that no
//      route can reach — a `renderEmail` throw (a blank body never passes the release
//      gate, so only a direct call can hand one over) ⇒ `failed`/`render`; the caller's
//      id list is NOT trusted (only rows that are `released` AND `email` are sent); the
//      subject; the result-code vocabulary; never an unhandled rejection.
//   §1b THE BOOT SWEEP (WA-T6 review) — `sweepInterruptedEmailRows()` directly, and a REAL
//      `node backend/src/index.js` boot over a prepared file: a `released` e-mail row at
//      boot ⇒ `failed`/`interrupted`.
//   §2 THE MAIL HARNESS (`withMailHarness`, self-skipping without `CAN_SPAWN_BACKEND`) —
//      a throwaway backend + a Mailgun stub, rows created through the REAL module-16
//      hand-over route and released / retried / ticked through the REAL module-21
//      routes: §UC-WA-010's acceptance criteria, plus (WA-T6 review) the hand tick on a
//      released E-MAIL row while the health stub reports the bot `connected`.
//
// ⚠ No test here ever sends real mail: the harness blanks the ambient `MAILGUN_*` env
// and points `MAILGUN_BASE_URL` at a 127.0.0.1 stub; the §1 probes blank it too.

import { test, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  withMailHarness, multipartFields, freePort, CAN_SPAWN_BACKEND, FAKE_MAILGUN_KEY, STUB_MAILGUN_DOMAIN,
} from '../mailgun-harness.js'
import { makeAdmin } from '../helpers/admin.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BACKEND_SRC = join(REPO_ROOT, 'backend', 'src')
// Gated on schema.js (the backend tree) — never on a file under test (learnings 15 §WA-T2).
const HAS_BACKEND_SRC = existsSync(join(BACKEND_SRC, 'db', 'schema.js'))
const NEEDS_BACKEND_SRC = 'needs the backend source beside e2e/ (skipped against a deployment)'
const srcUrl = (rel) => pathToFileURL(join(BACKEND_SRC, rel)).href
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// 21 §UC-WA-004's seed name of `pickup` — an INDEPENDENT copy (the subject is
// „Podpultovka · “ + the template's name, 21 §UC-WA-010).
const PICKUP_NAME = 'Doručené na odberné miesto'
const PICKUP_SUBJECT = `Podpultovka · ${PICKUP_NAME}`
// The mailer's fixed result vocabulary (08 / `helpers/mailer.js`) — an independent copy.
const RESULT_CODE = /^(no_recipient|not_configured|invalid_recipient|timeout|network|HTTP \d{3}|render|unknown)$/
const ALREADY_FINAL = (id) => `[outbox] email result for already-final row id=${id}`

// ═════════════════════════════════════════════════════════════════════════════
// §1 THROWAWAY BOOTS
// ═════════════════════════════════════════════════════════════════════════════
function asyncProbe(body) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-t6-probe-'))
  const file = join(dir, 'probe.mjs')
  writeFileSync(file,
    `const rejections = [];\n`
    + `process.on('unhandledRejection', (e) => { rejections.push(String(e && e.message || e)); });\n`
    + `import db from '${srcUrl('db/schema.js')}';\n`
    + `import * as outbox from '${srcUrl('helpers/outbox.js')}';\n`
    + `const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));\n`
    + `const out = await (async () => {\n${body}\n})();\n`
    + `await settle(100);\n`
    + `out.rejections = rejections;\n`
    + `console.log('@@PROBE@@' + JSON.stringify(out));\n`)
  try {
    const run = spawnSync(process.execPath, [file], {
      env: {
        ...process.env,
        DB_PATH: join(dir, 'wa-t6.sqlite'),
        WA_HEALTH_URL: '',
        // ⚠ Blanked: a probe must never inherit an operator's real Mailgun key.
        MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', MAILGUN_BASE_URL: '',
      },
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    const stdout = String(run.stdout || '')
    const m = stdout.match(/@@PROBE@@(.*)/)
    if (run.status !== 0 || !m) throw new Error(`probe failed (exit ${run.status}).\nstdout:\n${stdout}\nstderr:\n${run.stderr}`)
    // `stdout` = every log line (both streams) except the probe's own marker line.
    const logs = `${stdout.replace(/^@@PROBE@@.*$/m, '')}\n${run.stderr || ''}`
    return { ...JSON.parse(m[1]), stdout: logs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test.describe('WA-T6 · §1 throwaway boots — handOffEmailRows()', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('only rows that are RELEASED and `email` are handed to the mailer (the caller\'s list is re-read, never trusted); a blank body ⇒ `failed`/`render`; no address ⇒ `failed`/`no_recipient`; no Mailgun env ⇒ `failed`/`not_configured`; nothing else moves; no unhandled rejection', () => {
    const out = asyncProbe(`
      const ins = (channel, status, body, email, phone = null) => db.run(
        "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, body, unresolved, status, email, phone_e164, released_at) VALUES (?, 'pickup', 'probe', 'friend', 1, ?, '[]', ?, ?, ?, CASE WHEN ? = 'released' THEN CURRENT_TIMESTAMP END)",
        [channel, body, status, email, phone, status]).lastInsertRowid;
      const ids = {
        good: ins('email', 'released', 'Ahoj Probe, vaša káva je na mieste.', 'probe@example.test'),
        blank: ins('email', 'released', '   ', 'blank@example.test'),
        noAddress: ins('email', 'released', 'Ahoj bez adresy.', null),
        whatsapp: ins('whatsapp', 'released', 'Ahoj cez WhatsApp.', null, '+421905000111'),
        queuedEmail: ins('email', 'queued', 'Ahoj vo fronte.', 'q@example.test'),
        sentEmail: ins('email', 'sent', 'Ahoj odoslané.', 's@example.test'),
        failedEmail: ins('email', 'failed', 'Ahoj zlyhané.', 'f@example.test'),
      };
      db.run("UPDATE notifications SET error = 'HTTP 502' WHERE id = ?", [ids.failedEmail]);
      const before = db.all('SELECT * FROM notifications ORDER BY id');
      const handed = outbox.handOffEmailRows([
        ids.good, ids.good, ids.blank, ids.noAddress, ids.whatsapp, ids.queuedEmail, ids.sentEmail,
        ids.failedEmail, 999999, -1, 0, 1.5, '1', null,
      ]);
      // A blank body fails SYNCHRONOUSLY (renderEmail throws before any send).
      const blankAtOnce = db.get('SELECT status, error FROM notifications WHERE id = ?', [ids.blank]);
      await settle();
      const rows = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k,
        db.get('SELECT status, error, sent_at, sent_via, body, email, released_at FROM notifications WHERE id = ?', [id])]));
      return {
        ids, handed, blankAtOnce, rows,
        beforeOf: Object.fromEntries(before.map((r) => [r.id, r])),
        nonArray: [outbox.handOffEmailRows(undefined), outbox.handOffEmailRows('x'), outbox.handOffEmailRows([])],
      };
    `)
    expect(out.rejections, 'never an unhandled rejection').toEqual([])
    expect(out.handed, 'three distinct eligible rows (the duplicate id counts once)').toBe(3)
    expect(out.nonArray, 'a non-array / empty list hands over nothing and never throws').toEqual([0, 0, 0])
    expect(out.blankAtOnce, 'a renderEmail throw ⇒ failed/render, written at once').toEqual({ status: 'failed', error: 'render' })
    expect(out.rows.blank).toMatchObject({ status: 'failed', error: 'render', sent_at: null, sent_via: null })
    expect(out.rows.noAddress).toMatchObject({ status: 'failed', error: 'no_recipient', sent_at: null, sent_via: null })
    expect(out.rows.good, 'no Mailgun env ⇒ failed/not_configured, never a silent success')
      .toMatchObject({ status: 'failed', error: 'not_configured', sent_at: null, sent_via: null })
    // The rows the hand-off must NOT touch read back byte-identical.
    for (const k of ['whatsapp', 'queuedEmail', 'sentEmail', 'failedEmail']) {
      const b = out.beforeOf[out.ids[k]]
      expect(out.rows[k], `${k} untouched`).toEqual({
        status: b.status, error: b.error, sent_at: b.sent_at, sent_via: b.sent_via, body: b.body, email: b.email, released_at: b.released_at,
      })
    }
    // Non-vacuity: the untouched set really holds a released WhatsApp row and a failed e-mail row.
    expect(out.rows.whatsapp.status).toBe('released')
    expect(out.rows.failedEmail).toMatchObject({ status: 'failed', error: 'HTTP 502' })
    // The log lines (both streams, the probe's marker line excluded) carry no body text or address.
    const logs = out.stdout
    expect(logs, 'non-vacuity: the render failure was logged').toContain(`row id=${out.ids.blank} could not be rendered`)
    for (const leak of ['vaša káva je na mieste', 'probe@example.test', 'blank@example.test']) expect(logs).not.toContain(leak)
  })

  test('the subject is „Podpultovka · “ + the template name; a key outside the six (the `test` message, a stray key) ⇒ „Podpultovka“ alone (no invented copy)', () => {
    const out = asyncProbe(`
      return {
        pickup: outbox.emailSubject('pickup'),
        packeta: outbox.emailSubject('packeta'),
        host: outbox.emailSubject('host'),
        custom: outbox.emailSubject('custom'),
        test: outbox.emailSubject('test'),
        proto: outbox.emailSubject('__proto__'),
        none: outbox.emailSubject(undefined),
      };
    `)
    expect(out.pickup).toBe(PICKUP_SUBJECT)
    expect(out.packeta).toBe('Podpultovka · Odovzdané Packete')
    expect(out.host).toBe('Podpultovka · Odovzdané priateľovi')
    expect(out.custom).toBe('Podpultovka · Vlastná správa')
    expect(out.test).toBe('Podpultovka')
    expect(out.proto).toBe('Podpultovka')
    expect(out.none).toBe('Podpultovka')
  })

  test('the stored error is the mailer\'s FIXED vocabulary — any other value (server text, a key-bearing string, a non-object) ⇒ `unknown`', () => {
    const out = asyncProbe(`
      const code = outbox.emailResultError;
      return {
        notConfigured: code({ sent: false, skipped: 'not_configured' }),
        noRecipient: code({ sent: false, skipped: 'no_recipient' }),
        invalid: code({ sent: false, error: 'invalid_recipient', to: 'x' }),
        timeout: code({ sent: false, error: 'timeout' }),
        network: code({ sent: false, error: 'network' }),
        http500: code({ sent: false, error: 'HTTP 500' }),
        http401: code({ sent: false, error: 'HTTP 401' }),
        keyText: code({ sent: false, error: 'Forbidden: ${FAKE_MAILGUN_KEY}' }),
        longHttp: code({ sent: false, error: 'HTTP 5000000' }),
        nul: code(null),
        str: code('HTTP 500'),
        sentTrue: code({ sent: true }),
      };
    `)
    expect(out).toMatchObject({
      notConfigured: 'not_configured', noRecipient: 'no_recipient', invalid: 'invalid_recipient', timeout: 'timeout',
      network: 'network', http500: 'HTTP 500', http401: 'HTTP 401', keyText: 'unknown', longHttp: 'unknown',
      nul: 'unknown', str: 'unknown', sentTrue: 'unknown',
    })
    const { stdout, rejections, ...codes } = out
    expect(rejections).toEqual([])
    expect(Object.keys(codes)).toHaveLength(12)
    for (const v of Object.values(codes)) expect(v).toMatch(RESULT_CODE)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §1b THE BOOT SWEEP (WA-T6 review) — a `released` e-mail row at API boot is a send the
// previous process never finished ⇒ `failed`/`interrupted` (retryable). Pinned twice: the
// helper directly, and a REAL `node backend/src/index.js` boot over a prepared file (which
// is what proves `index.js` calls it, before it listens).
// ═════════════════════════════════════════════════════════════════════════════
const SWEEP_ROWS_JS = `
  const ins = (channel, status, error = null) => db.run(
    "INSERT INTO notifications (channel, template_key, segment_key, recipient_kind, recipient_id, body, unresolved, status, email, phone_e164, error, released_at) VALUES (?, 'pickup', 'probe', 'friend', 1, 'Ahoj.', '[]', ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    [channel, status, channel === 'email' ? 'p@example.test' : null, channel === 'whatsapp' ? '+421905000222' : null, error]).lastInsertRowid;
  const ids = {
    releasedEmail: ins('email', 'released'),
    releasedEmail2: ins('email', 'released', 'HTTP 500'),
    releasedWhatsapp: ins('whatsapp', 'released'),
    queuedEmail: ins('email', 'queued'),
    sentEmail: ins('email', 'sent'),
    failedEmail: ins('email', 'failed', 'timeout'),
  };
`

test.describe('WA-T6 · §1b the boot sweep — released e-mail rows ⇒ failed/interrupted', () => {
  test.skip(!HAS_BACKEND_SRC, NEEDS_BACKEND_SRC)

  test('sweepInterruptedEmailRows(): every RELEASED e-mail row ⇒ `failed`/`interrupted` (no age threshold); WhatsApp / queued / sent / failed rows untouched; a second call sweeps 0', () => {
    const out = asyncProbe(`${SWEEP_ROWS_JS}
      const first = outbox.sweepInterruptedEmailRows();
      const second = outbox.sweepInterruptedEmailRows();
      const rows = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, db.get('SELECT status, error FROM notifications WHERE id = ?', [id])]));
      return { first, second, rows };
    `)
    expect([out.first, out.second]).toEqual([2, 0])
    expect(out.rows).toEqual({
      releasedEmail: { status: 'failed', error: 'interrupted' },
      releasedEmail2: { status: 'failed', error: 'interrupted' },
      releasedWhatsapp: { status: 'released', error: null },
      queuedEmail: { status: 'queued', error: null },
      sentEmail: { status: 'sent', error: null },
      failedEmail: { status: 'failed', error: 'timeout' },
    })
    expect(out.stdout).toContain('[outbox] boot: 2 interrupted e-mail row(s) marked failed/interrupted')
  })

  test('a REAL API boot (`node backend/src/index.js`) sweeps before it serves: the released e-mail row reads `failed`/`interrupted` once /api/health answers', async () => {
    test.setTimeout(90_000)
    const dir = mkdtempSync(join(tmpdir(), 'wa-t6-boot-'))
    const dbFile = join(dir, 'boot.sqlite')
    const script = join(dir, 'prepare.mjs')
    writeFileSync(script, `import db from '${srcUrl('db/schema.js')}';\n${SWEEP_ROWS_JS}\nconsole.log('@@IDS@@' + JSON.stringify(ids));\n`)
    const blank = { MAILGUN_API_KEY: '', MAILGUN_DOMAIN: '', MAILGUN_BASE_URL: '', WA_HEALTH_URL: '' }
    let child
    try {
      const prep = spawnSync(process.execPath, [script], { env: { ...process.env, ...blank, DB_PATH: dbFile }, encoding: 'utf8', cwd: REPO_ROOT, timeout: 60_000 })
      const ids = JSON.parse(String(prep.stdout).match(/@@IDS@@(.*)/)[1])
      const before = new DatabaseSync(dbFile)
      expect(before.prepare('SELECT status FROM notifications WHERE id = ?').get(ids.releasedEmail).status, 'non-vacuity: released before the boot').toBe('released')
      before.close()

      const port = await freePort()
      const output = []
      child = spawn(process.execPath, [join(BACKEND_SRC, 'index.js')], {
        cwd: join(BACKEND_SRC, '..'),
        env: { ...process.env, ...blank, DB_PATH: dbFile, PORT: String(port), CORS_ORIGIN: `http://127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (c) => output.push(String(c)))
      child.stderr.on('data', (c) => output.push(String(c)))
      await expect.poll(async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status } catch { return 0 }
      }, { timeout: 30_000 }).toBe(200)

      const after = new DatabaseSync(dbFile)
      const read = (id) => after.prepare('SELECT status, error FROM notifications WHERE id = ?').get(id)
      try {
        expect({ ...read(ids.releasedEmail) }).toEqual({ status: 'failed', error: 'interrupted' })
        expect({ ...read(ids.releasedWhatsapp) }, 'the WA process owns released WhatsApp rows').toEqual({ status: 'released', error: null })
        expect({ ...read(ids.queuedEmail) }).toEqual({ status: 'queued', error: null })
      } finally { after.close() }
      const log = output.join('')
      expect(log).toContain('[outbox] boot: 2 interrupted e-mail row(s) marked failed/interrupted')
      expect(log.indexOf('[outbox] boot:'), 'the sweep runs BEFORE the server listens').toBeLessThan(log.indexOf('Server bezi na porte'))
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000); child.on('exit', () => { clearTimeout(t); resolve() }) })
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 THE MAIL HARNESS — the real routes against a throwaway backend + Mailgun stub
// ═════════════════════════════════════════════════════════════════════════════
const MAIL_ON = { MAILGUN_API_KEY: FAKE_MAILGUN_KEY, MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN }

// The harness backend inherits `process.env`; the gate's `WA_HEALTH_URL` may be a port a
// sibling spec serves. A port nobody listens on ⇒ the bot is „not connected", so the
// manual tick on a RELEASED row is allowed (§UC-WA-008) — deterministically.
async function harness(mailEnv, fn) {
  const deadHealth = `http://127.0.0.1:${await freePort()}`
  await withMailHarness({ WA_HEALTH_URL: deadHealth, ...mailEnv }, async (h) => {
    let token = h.adminToken
    const admin = makeAdmin({ ctx: () => h.ctx, token: () => token, adopt: (t) => { token = t } })
    const withDb = (f) => {
      const db = new DatabaseSync(h.backend.dbPath)
      try { return f(db) } finally { db.close() }
    }
    await fn({ ...h, admin, withDb, fx: fixtures(admin, withDb) })
  })
}

// Fixtures through the REAL admin routes; the ORDER row is written directly (a packed,
// submitted pickup bag — the friend's cart flow is not this spec's subject), and the
// hand-over that creates the notification row goes through the REAL module-16 route.
function fixtures(admin, withDb) {
  let seq = 0
  return {
    async cycle() {
      const res = await admin('/api/cycles', {
        method: 'post', data: { name: `E2E WA6 ${uniq}`, type: 'coffee', status: 'open', closes_at: '2026-11-06' },
      })
      expect(res.status(), 'cycle create').toBe(201)
      return res.json()
    },
    async location(name) {
      const res = await admin('/api/pickup-locations', { method: 'post', data: { name, address: 'Ulica WA6 1', for_coffee: true, for_bakery: true } })
      expect(res.status(), 'location create').toBe(201)
      return res.json()
    },
    async friend(label, { phone, email, optOut = false } = {}) {
      const data = { name: `W6${label}${uniq}${++seq} Test` }
      if (phone) data.phone = phone
      if (email) data.email = email
      const res = await admin('/api/friends', { method: 'post', data })
      expect(res.status(), 'friend create').toBe(201)
      const row = await res.json()
      if (optOut) {
        expect((await admin(`/api/friends/${row.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status(), 'opt out').toBe(200)
      }
      return row
    },
    // A packed, submitted pickup order at `loc`, handed over through PATCH /orders/:id/handed-over.
    async handedOver(friend, cycle, loc) {
      const orderId = withDb((db) => Number(db.prepare(
        "INSERT INTO orders (friend_id, cycle_id, status, packed, pickup_location_id, total) VALUES (?, ?, 'submitted', 1, ?, 10)",
      ).run(friend.id, cycle.id, loc.id).lastInsertRowid))
      const res = await admin(`/api/orders/${orderId}/handed-over`, { method: 'patch', data: { handed_over: true } })
      expect(res.status(), 'hand-over').toBe(200)
      const row = withDb((db) => db.prepare('SELECT * FROM notifications WHERE order_id = ?').all(orderId))
      expect(row, 'the hand-over minted exactly one row').toHaveLength(1)
      return row[0]
    },
    row(id) {
      return withDb((db) => db.prepare('SELECT * FROM notifications WHERE id = ?').get(id))
    },
    async release(cycle, segmentKey) {
      const res = await admin('/api/notifications/release', { method: 'post', data: { cycle_id: cycle.id, segment_key: segmentKey } })
      expect(res.status(), `release ${segmentKey}`).toBe(200)
      return res.json()
    },
    async retry(cycle, segmentKey) {
      const res = await admin('/api/notifications/retry', { method: 'post', data: { cycle_id: cycle.id, segment_key: segmentKey } })
      expect(res.status(), `retry ${segmentKey}`).toBe(200)
      return res.json()
    },
    async groupRows(cycle, segmentKey) {
      const res = await admin('/api/notifications', { params: { cycle_id: String(cycle.id), segment_key: segmentKey } })
      expect(res.status()).toBe(200)
      return { raw: await res.text(), rows: (await res.json()).rows }
    },
  }
}

const settleStatus = (fx, id) => expect.poll(() => fx.row(id).status, { timeout: 10_000 })
const countLines = (logs, line) => logs.split('\n').filter((l) => l.includes(line)).length

test.describe('WA-T6 · §2 21 §UC-WA-010 through the mail harness', () => {
  test.skip(!CAN_SPAWN_BACKEND, NEEDS_BACKEND_SRC)

  test('releasing a group with ONE e-mail row ⇒ exactly ONE stub request (to the snapshot address, subject „Podpultovka · {template}“, text === the row body, html = 08\'s shell with the body escaped, tracking off) and the row reads back `sent`/`email`; the WhatsApp row beside it stays `released`; a group with NO e-mail rows ⇒ ZERO requests', async () => {
    test.setTimeout(120_000)
    await harness(MAIL_ON, async ({ stub, fx, backend }) => {
      const cycle = await fx.cycle()
      const A = await fx.location(`Kaviareň & Pult ${uniq}`)
      const B = await fx.location(`WA6 Iba WhatsApp ${uniq}`)
      const E = await fx.friend('Emil', { email: `wa6.emil.${uniq}@example.test` }) // no phone ⇒ R5.8 fallback
      const W = await fx.friend('Wanda', { phone: '0905 601 001' })
      const W2 = await fx.friend('Vilo', { phone: '0905 601 002' })
      const eRow = await fx.handedOver(E, cycle, A)
      const wRow = await fx.handedOver(W, cycle, A)
      const w2Row = await fx.handedOver(W2, cycle, B)
      expect(eRow).toMatchObject({ channel: 'email', status: 'queued', email: E.email, template_key: 'pickup' })
      expect(wRow).toMatchObject({ channel: 'whatsapp', status: 'queued' })
      expect(w2Row).toMatchObject({ channel: 'whatsapp', status: 'queued' })
      expect(eRow.segment_key, 'E and W share one group').toBe(wRow.segment_key)
      expect(w2Row.segment_key, 'B is another group').not.toBe(eRow.segment_key)

      // ── a group with no e-mail rows ⇒ ZERO requests ──
      const relB = await fx.release(cycle, w2Row.segment_key)
      expect(relB).toMatchObject({ released: 1, whatsapp: 1, email: 0 })
      await new Promise((r) => setTimeout(r, 1500))
      expect(stub.requests, 'a WhatsApp-only release sends nothing through the mailer').toHaveLength(0)
      expect(fx.row(w2Row.id)).toMatchObject({ status: 'released', sent_at: null, sent_via: null, error: null })

      // ── one e-mail row ⇒ exactly ONE request ──
      const relA = await fx.release(cycle, eRow.segment_key)
      expect(relA).toMatchObject({ released: 2, whatsapp: 1, email: 1 })
      await settleStatus(fx, eRow.id).toBe('sent')
      const sent = fx.row(eRow.id)
      expect(sent).toMatchObject({ status: 'sent', sent_via: 'email', error: null, channel: 'email' })
      expect(sent.sent_at, 'sent_at stamped').toBeTruthy()
      expect(stub.requests).toHaveLength(1)
      const call = stub.requests[0]
      expect(call.url).toBe(`/v3/${STUB_MAILGUN_DOMAIN}/messages`)
      const f = multipartFields(call)
      expect(f.to).toBe(E.email)
      expect(f.subject).toBe(PICKUP_SUBJECT)
      expect(f.text, 'text === the row body, byte for byte').toBe(sent.body)
      expect(sent.body, 'non-vacuity: the body names the point').toContain(A.name)
      expect(f.html).toContain('<!DOCTYPE html>')
      expect(f.html, 'the body is ONE escaped paragraph').toContain(sent.body.replaceAll('&', '&amp;'))
      expect(f.html).not.toContain(A.name)
      expect(f.html.match(/<p /g), 'one paragraph, no other block').toHaveLength(1)
      expect(f['o:tracking-clicks']).toBe('no')
      expect(f['o:tracking-opens']).toBe('no')
      // The API never sends a WhatsApp row: W's row is the WA process's to drain.
      expect(fx.row(wRow.id)).toMatchObject({ status: 'released', sent_at: null, sent_via: null, error: null })
      // No second send creeps in.
      await new Promise((r) => setTimeout(r, 1000))
      expect(stub.requests).toHaveLength(1)
      expect(fx.row(eRow.id).status).toBe('sent')
      expect(backend.logs()).not.toContain(FAKE_MAILGUN_KEY)
    })
  })

  test('D5: an OPTED-OUT friend\'s e-mail row with the stub answering 500 ⇒ `failed`/`HTTP 500` (the key never in `error` nor any answer); RETRY re-sends it through the same hand-off ⇒ a second request and `sent`/`email` with the error cleared', async () => {
    test.setTimeout(120_000)
    await harness(MAIL_ON, async ({ stub, fx, backend }) => {
      const cycle = await fx.cycle()
      const L = await fx.location(`WA6 Odhlásený ${uniq}`)
      const O = await fx.friend('Oto', { phone: '0905 601 003', email: `wa6.oto.${uniq}@example.test`, optOut: true })
      const oRow = await fx.handedOver(O, cycle, L)
      expect(oRow, 'D5: opted out + operational template + e-mail ⇒ an e-mail row, no number')
        .toMatchObject({ channel: 'email', status: 'queued', phone_e164: null, email: O.email })

      stub.setReply({ status: 500, body: { message: `boom ${FAKE_MAILGUN_KEY}` } })
      await fx.release(cycle, oRow.segment_key)
      await settleStatus(fx, oRow.id).toBe('failed')
      const failed = fx.row(oRow.id)
      expect(failed).toMatchObject({ status: 'failed', error: 'HTTP 500', sent_at: null, sent_via: null })
      expect(stub.requests).toHaveLength(1)
      expect(multipartFields(stub.requests[0]).text).toBe(failed.body)
      const listed = await fx.groupRows(cycle, oRow.segment_key)
      expect(listed.rows.find((r) => r.id === oRow.id), 'the composer\'s feed carries the code').toMatchObject({ status: 'failed', error: 'HTTP 500' })
      expect(listed.raw, 'the key never reaches an answer').not.toContain(FAKE_MAILGUN_KEY)
      expect(failed.error).not.toContain(FAKE_MAILGUN_KEY)

      // ── retry (failed → released) re-sends ──
      stub.setReply({ status: 200, body: { id: '<retry@mg.stub.invalid>', message: 'Queued. Thank you.' } })
      const retried = await fx.retry(cycle, oRow.segment_key)
      expect(retried).toMatchObject({ released: 1, email: 1, whatsapp: 0 })
      await settleStatus(fx, oRow.id).toBe('sent')
      expect(fx.row(oRow.id)).toMatchObject({ status: 'sent', sent_via: 'email', error: null })
      expect(stub.requests, 'exactly one more request').toHaveLength(2)
      const again = multipartFields(stub.requests[1])
      expect(again.text).toBe(failed.body)
      expect(again.to).toBe(O.email)
      expect(backend.logs()).not.toContain(FAKE_MAILGUN_KEY)
    })
  })

  test('with NO Mailgun env the release makes ZERO requests and the row reads back `failed`/`not_configured` — never a silent success', async () => {
    test.setTimeout(120_000)
    await harness({}, async ({ stub, fx }) => {
      const cycle = await fx.cycle()
      const L = await fx.location(`WA6 Bez mailu ${uniq}`)
      const E = await fx.friend('Ema', { email: `wa6.ema.${uniq}@example.test` })
      const eRow = await fx.handedOver(E, cycle, L)
      expect(eRow.channel).toBe('email')
      const rel = await fx.release(cycle, eRow.segment_key)
      expect(rel).toMatchObject({ released: 1, email: 1 })
      await settleStatus(fx, eRow.id).toBe('failed')
      expect(fx.row(eRow.id)).toMatchObject({ status: 'failed', error: 'not_configured', sent_at: null, sent_via: null })
      const listed = await fx.groupRows(cycle, eRow.segment_key)
      expect(listed.rows.find((r) => r.id === eRow.id)).toMatchObject({ status: 'failed', error: 'not_configured' })
      expect(stub.requests, 'MAILGUN_BASE_URL points at the stub, and it heard nothing').toHaveLength(0)
    })
  })

  test('the hand tick is a real door for a released E-MAIL row: with the health stub answering `connected` a released WhatsApp row 409s `bot_active` but the e-mail row ticks to `sent`/`wa_me` (the WA process never drains e-mail rows)', async () => {
    test.setTimeout(120_000)
    const health = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ state: 'connected' }))
    })
    const port = await freePort()
    await new Promise((resolve, reject) => { health.once('error', reject); health.listen(port, '127.0.0.1', resolve) })
    try {
      await harness({ ...MAIL_ON, WA_HEALTH_URL: `http://127.0.0.1:${port}` }, async ({ stub, fx, admin, backend }) => {
        const cycle = await fx.cycle()
        const L = await fx.location(`WA6 Bot pripojený ${uniq}`)
        const E = await fx.friend('Elena', { email: `wa6.elena.${uniq}@example.test` })
        const W = await fx.friend('Waldo', { phone: '0905 601 004' })
        const eRow = await fx.handedOver(E, cycle, L)
        const wRow = await fx.handedOver(W, cycle, L)
        expect(eRow.segment_key).toBe(wRow.segment_key)
        stub.setReplyDelay(4000) // the e-mail send stays in flight ⇒ the row stays `released`
        expect(await fx.release(cycle, eRow.segment_key)).toMatchObject({ released: 2, whatsapp: 1, email: 1 })
        await expect.poll(() => stub.requests.length, { timeout: 5_000 }).toBe(1)
        const tick = (id) => admin(`/api/notifications/${id}/manual-sent`, { method: 'patch', data: { sent: true } })

        const wBefore = fx.row(wRow.id)
        const refused = await tick(wRow.id)
        expect(refused.status(), 'non-vacuity: the stub really reports the bot connected').toBe(409)
        expect((await refused.json()).reason).toBe('bot_active')
        expect(fx.row(wRow.id), 'read back unchanged').toEqual(wBefore)

        expect(fx.row(eRow.id).status, 'still in flight').toBe('released')
        const ok = await tick(eRow.id)
        expect(ok.status()).toBe(200)
        expect(await ok.json()).toMatchObject({ id: eRow.id, status: 'sent', sent_via: 'wa_me' })
        await expect.poll(() => countLines(backend.logs(), ALREADY_FINAL(eRow.id)), { timeout: 10_000 }).toBe(1)
        expect(fx.row(eRow.id)).toMatchObject({ status: 'sent', sent_via: 'wa_me' })
      })
    } finally {
      health.closeAllConnections?.()
      await new Promise((resolve) => health.close(resolve))
    }
  })

  test('the conditional result write LOSES to a manual tick made while the send is in flight: ONE log line, the row stays `sent`/`wa_me`', async () => {
    test.setTimeout(120_000)
    await harness(MAIL_ON, async ({ stub, fx, admin, backend }) => {
      const cycle = await fx.cycle()
      const L = await fx.location(`WA6 Súbeh ${uniq}`)
      const E = await fx.friend('Eva', { email: `wa6.eva.${uniq}@example.test` })
      const eRow = await fx.handedOver(E, cycle, L)
      stub.setReplyDelay(4000)
      await fx.release(cycle, eRow.segment_key)
      // The request is recorded at once; only the REPLY is held.
      await expect.poll(() => stub.requests.length, { timeout: 5_000 }).toBe(1)
      expect(fx.row(eRow.id).status, 'still in flight').toBe('released')
      const tick = await admin(`/api/notifications/${eRow.id}/manual-sent`, { method: 'patch', data: { sent: true } })
      expect(tick.status(), 'the bot is down ⇒ the tick on a released row is allowed').toBe(200)
      const ticked = fx.row(eRow.id)
      expect(ticked).toMatchObject({ status: 'sent', sent_via: 'wa_me' })
      expect(countLines(backend.logs(), ALREADY_FINAL(eRow.id)), 'nothing logged before the reply').toBe(0)

      await expect.poll(() => countLines(backend.logs(), ALREADY_FINAL(eRow.id)), { timeout: 10_000 }).toBe(1)
      await new Promise((r) => setTimeout(r, 500))
      expect(countLines(backend.logs(), ALREADY_FINAL(eRow.id)), 'exactly ONE line').toBe(1)
      expect(fx.row(eRow.id), 'the tick stands, byte for byte').toEqual(ticked)
      expect(stub.requests).toHaveLength(1)
    })
  })
})
