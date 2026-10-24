// Module 21 — WA-T7: the WhatsApp settings page (21 §UC-WA-012), the API under it and
// the templates card (§UC-WA-004's routes, shipped by WA-T2):
//
//   GET  /api/admin/whatsapp/health   the `gorifi-wa` health PROXY (helpers/wa-health.js,
//                                     2 s timeout) — ALWAYS 200; `{reachable:false, …}` on
//                                     any failure, else `{reachable:true, ...health, opt_in,
//                                     paused}`; never logs, never caches the QR
//   GET/PUT /api/admin/settings       + `whatsappPaused` (strict boolean ⇒ '0'|'1') and
//                                     `whatsappTestPhone` (string ≤ 32, stored as entered)
//   POST /api/admin/whatsapp/test     ONE `released` `admin` row to toE164(test phone);
//                                     400 `invalid_test_phone`, 409 `test_pending`
//   /admin/whatsapp/settings          AdminWhatsAppSettings.vue (Stav · Spárovať telefón ·
//                                     Tempo odosielania · Šablóny · „Pre správcu servera")
//
// THREE KINDS OF EVIDENCE:
//   §1 HTTP on the gate server — always runs (nothing listening on the health URL is the
//      gate recipe's state: `WA_HEALTH_URL=http://127.0.0.1:3996`, a dead port).
//   §2 WA_HEALTH_URL-gated — this spec SERVES a stub `gorifi-wa` health on the SAME port
//      the gate server was started with (whatsapp-outbox.spec.js §4's pattern). The QR log
//      sweep additionally needs SERVER_LOG.
//   §3 UI — the admin page, logged in through the form; the API helper ADOPTS the
//      browser's token (one global admin_token row — CLAUDE.md).
//
// ⚠ The real stub SENDER (rows drained `released → sent`) is WA-T9 — nothing here
// depends on it. The test-message rows this spec creates are finalised through the
// product's own door (`PATCH /api/notifications/:id/manual-sent`, allowed on a released
// row while the bot is not connected), so no `released` test row survives the spec.
//
// ⚠ Every template / setting this spec changes is restored (whatsapp-templates.spec.js
// pins the seed byte-for-byte later in a full run).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import { ADMIN_PASSWORD, TARGET_IS_LOCAL } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const WA_HEALTH_URL = process.env.WA_HEALTH_URL || ''
const SERVER_LOG = process.env.SERVER_LOG || ''
const NEEDS_HEALTH = 'needs WA_HEALTH_URL — the SAME value the gate server was started with (e2e/README.md)'
const NEEDS_LOG = 'needs SERVER_LOG=<backend log path> and WA_HEALTH_URL'
const NEEDS_LOCAL = 'creates a RELEASED WhatsApp row — a deployment with a paired bot would send it. Run against the local recipe.'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// A real 1×1 PNG, so the `<img>` genuinely loads (CSP `img-src 'self' data:`).
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// An INDEPENDENT copy of the test body's timestamp: `d. m. yyyy HH:mm`, Europe/Bratislava.
function bratislavaStamp(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]))
  return `${Number(p.day)}. ${Number(p.month)}. ${p.year} ${p.hour}:${p.minute}`
}
const TEST_BODY = /^Testovacia správa z Podpultovky · (\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2})$/u

let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })

async function ensureAdmin() {
  if (ctx) return
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
}
test.afterAll(async () => { await ctx?.dispose(); ctx = null })

const health = async () => {
  const res = await admin('/api/admin/whatsapp/health')
  expect(res.status(), 'the health proxy ALWAYS answers 200').toBe(200)
  return res.json()
}
const settings = async () => {
  const res = await admin('/api/admin/settings')
  expect(res.status()).toBe(200)
  return res.json()
}
const putSettings = (data) => admin('/api/admin/settings', { method: 'put', data })
const sendTest = () => admin('/api/admin/whatsapp/test', { method: 'post' })
// The product's own door for a released row while the bot is not connected.
const finalise = async (id) => {
  const res = await admin(`/api/notifications/${id}/manual-sent`, { method: 'patch', data: { sent: true } })
  expect(res.status(), `test row ${id} finalised through manual-sent`).toBe(200)
}
const withDb = (fn) => {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try { return fn(db) } finally { db.close() }
}
const testRows = () => withDb((db) => db.prepare("SELECT * FROM notifications WHERE template_key = 'test' ORDER BY id").all())

// A stub `gorifi-wa` health server on WA_HEALTH_URL's port. `payload()` is read per
// request so a test can move the state while the server runs; `mode` selects a failure.
async function startHealthStub(payload, { mode = 'ok', delayMs = 0 } = {}) {
  const server = createServer((req, res) => {
    const answer = () => {
      if (req.url !== '/health') { res.writeHead(404); res.end(); return }
      if (mode === 'http500') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"state":"connected"}'); return }
      if (mode === 'notjson') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('connected'); return }
      if (mode === 'array') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[1,2]'); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload()))
    }
    if (delayMs) setTimeout(answer, delayMs); else answer()
  })
  const { port, hostname } = new URL(WA_HEALTH_URL)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), hostname, resolve) })
  return async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

const CONNECTED = () => ({
  state: 'connected', sender: 'stub', number: '+421000000000',
  qr: null, queue: { released: 2, sent_today: 5, failed: 1 }, hourly_sent: 3,
  next_send_at: null, last_sent_at: '2026-10-24 12:30:00', last_error: null,
  db_path: '/tmp/x.sqlite', uptime_s: 42, version: 'stub-1',
  // Hostile echoes: the proxy's own fields must WIN over anything the process says.
  reachable: false, opt_in: 'evil', paused: 'evil',
})

// ═════════════════════════════════════════════════════════════════════════════
// §1 HTTP — the proxy with no process, the settings fields, the test message
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T7 · §1 API', () => {
  test.describe.configure({ mode: 'serial' })
  let before = null
  test.beforeAll(async () => {
    await ensureAdmin()
    before = await settings()
  })
  test.afterAll(async () => {
    if (!before || !ctx) return
    const res = await putSettings({ whatsappPaused: before.whatsappPaused, whatsappTestPhone: before.whatsappTestPhone })
    expect(res.status(), 'settings restored').toBe(200)
  })

  test('anonymous ⇒ 401 on both new routes', async () => {
    const anon = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      expect((await anon.get('/api/admin/whatsapp/health')).status()).toBe(401)
      expect((await anon.post('/api/admin/whatsapp/test')).status()).toBe(401)
    } finally { await anon.dispose() }
  })

  test('no process on the health URL ⇒ 200 `{reachable:false}` + the DB-side opt-in count and pause flag, no-store', async () => {
    const res = await admin('/api/admin/whatsapp/health')
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control'] || '', 'never cached (the QR is a credential)').toContain('no-store')
    const body = await res.json()
    expect(body.reachable).toBe(false)
    for (const k of ['state', 'qr', 'number', 'queue', 'sender']) expect(body, `no process field ${k}`).not.toHaveProperty(k)
    expect(Number.isInteger(body.opt_in.on) && Number.isInteger(body.opt_in.total)).toBe(true)
    expect(body.opt_in.on).toBeLessThanOrEqual(body.opt_in.total)
    expect(typeof body.paused).toBe('boolean')
    if (DB_PATH) {
      const expected = withDb((db) => db.prepare(
        'SELECT COALESCE(SUM(whatsapp_opt_in = 1), 0) AS on_, COUNT(*) AS total FROM friends WHERE active = 1'
      ).get())
      expect(body.opt_in, 'opt-in = §UC-WA-003 count over ACTIVE friends').toEqual({ on: expected.on_, total: expected.total })
    }
  })

  test('the opt-in count moves with an active friend’s consent and with deactivation', async () => {
    const base = (await health()).opt_in
    const created = await admin('/api/friends', { method: 'post', data: { name: `WA7 Optin ${uniq}`, phone: '0905 700 001' } })
    expect(created.status()).toBe(201)
    const f = await created.json()
    try {
      expect((await health()).opt_in, 'admin-created friend is opted IN (PO 2026-09-19)').toEqual({ on: base.on + 1, total: base.total + 1 })
      expect((await admin(`/api/friends/${f.id}`, { method: 'patch', data: { whatsapp_opt_in: false } })).status()).toBe(200)
      expect((await health()).opt_in).toEqual({ on: base.on, total: base.total + 1 })
      expect((await admin(`/api/friends/${f.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)
      expect((await health()).opt_in, 'an inactive friend is not counted').toEqual(base)
    } finally {
      await admin(`/api/friends/${f.id}`, { method: 'delete' })
    }
  })

  test('settings: GET publishes both fields; `whatsappPaused` is a strict boolean ⇒ \'0\'|\'1\'', async () => {
    const s = await settings()
    expect(typeof s.whatsappPaused).toBe('boolean')
    expect(typeof s.whatsappTestPhone).toBe('string')

    for (const [value, expected] of [[true, true], [false, false], [1, true], [0, false]]) {
      const res = await putSettings({ whatsappPaused: value })
      expect(res.status(), `whatsappPaused=${JSON.stringify(value)}`).toBe(200)
      expect((await res.json()).whatsappPaused).toBe(expected)
      expect((await settings()).whatsappPaused, 'read back').toBe(expected)
      expect((await health()).paused, 'the proxy reads the same flag').toBe(expected)
    }
    if (DB_PATH) {
      await putSettings({ whatsappPaused: true })
      expect(withDb((db) => db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_paused'").get().value)).toBe('1')
      await putSettings({ whatsappPaused: false })
      expect(withDb((db) => db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_paused'").get().value)).toBe('0')
    }

    await putSettings({ whatsappPaused: true })
    for (const bad of ['true', 'yes', '1', 2, -1, null, {}, [], [true], 1.5]) {
      const res = await putSettings({ whatsappPaused: bad })
      expect(res.status(), `whatsappPaused=${JSON.stringify(bad)} ⇒ 400`).toBe(400)
      expect((await res.json()).field).toBe('whatsappPaused')
      expect((await settings()).whatsappPaused, `unchanged after ${JSON.stringify(bad)}`).toBe(true)
    }
    await putSettings({ whatsappPaused: false })
  })

  test('settings: `whatsappTestPhone` is stored AS ENTERED, ≤ 32; non-strings 400; a refusal writes NOTHING in the request', async () => {
    const entered = '0905 123 456'
    let res = await putSettings({ whatsappTestPhone: entered })
    expect(res.status()).toBe(200)
    expect((await res.json()).whatsappTestPhone).toBe(entered)
    expect((await settings()).whatsappTestPhone, 'verbatim, spaces kept').toBe(entered)

    const max = '+421 905 123 456'.padEnd(32, ' ')
    res = await putSettings({ whatsappTestPhone: max })
    expect(res.status(), '32 chars is the bound').toBe(200)
    expect((await settings()).whatsappTestPhone).toBe(max)

    res = await putSettings({ whatsappTestPhone: 'x'.repeat(33) })
    expect(res.status(), '33 chars ⇒ 400').toBe(400)
    expect((await res.json()).field).toBe('whatsappTestPhone')
    expect((await settings()).whatsappTestPhone).toBe(max)

    for (const bad of [905123456, true, {}, [], ['0905 123 456']]) {
      res = await putSettings({ whatsappTestPhone: bad })
      expect(res.status(), `whatsappTestPhone=${JSON.stringify(bad)} ⇒ 400`).toBe(400)
      expect((await settings()).whatsappTestPhone, `unchanged after ${JSON.stringify(bad)}`).toBe(max)
    }

    // The whole request is validated before ANY write (the creditor-name rule).
    const iban = (await settings()).paymentIban
    res = await putSettings({ paymentIban: `SK00WA7${uniq}`, whatsappPaused: 'yes' })
    expect(res.status()).toBe(400)
    expect((await settings()).paymentIban, 'a sibling field in a refused request is NOT written').toBe(iban)
    res = await putSettings({ paymentIban: `SK00WA7${uniq}`, whatsappTestPhone: 'x'.repeat(33) })
    expect(res.status()).toBe(400)
    expect((await settings()).paymentIban).toBe(iban)

    res = await putSettings({ whatsappTestPhone: '' })
    expect(res.status(), 'an empty string clears').toBe(200)
    expect((await settings()).whatsappTestPhone).toBe('')
    await putSettings({ whatsappTestPhone: entered })
    res = await putSettings({ whatsappTestPhone: null })
    expect(res.status(), 'null clears').toBe(200)
    expect((await settings()).whatsappTestPhone).toBe('')

    // An unrelated settings PUT leaves both WhatsApp settings alone.
    await putSettings({ whatsappTestPhone: entered, whatsappPaused: true })
    res = await putSettings({ paymentIban: iban })
    expect(res.status()).toBe(200)
    const s = await settings()
    expect([s.whatsappTestPhone, s.whatsappPaused]).toEqual([entered, true])
    await putSettings({ whatsappPaused: false })
  })

  test('test message: an unusable number ⇒ 400 `invalid_test_phone`, no row', async () => {
    const count = () => (DB_PATH ? testRows().length : null)
    const n = count()
    for (const phone of ['abc', '', '12']) {
      expect((await putSettings({ whatsappTestPhone: phone })).status()).toBe(200)
      const res = await sendTest()
      expect(res.status(), `test phone ${JSON.stringify(phone)} ⇒ 400`).toBe(400)
      expect((await res.json()).reason).toBe('invalid_test_phone')
    }
    expect(count(), 'nothing inserted').toBe(n)
  })

  test('test message: `0905 123 456` ⇒ ONE released admin row to +421905123456; a second ⇒ 409 `test_pending` until it is final', async () => {
    test.skip(!TARGET_IS_LOCAL, NEEDS_LOCAL)
    expect((await putSettings({ whatsappTestPhone: '0905 123 456' })).status()).toBe(200)
    const t0 = new Date()
    const res = await sendTest()
    expect(res.status()).toBe(201)
    const row = await res.json()
    const t1 = new Date()
    try {
      expect(row).toMatchObject({
        template_key: 'test', recipient_kind: 'admin', recipient_id: null, segment_key: 'test',
        cycle_id: null, order_id: null, guest_order_id: null, channel: 'whatsapp', status: 'released',
        phone_e164: '+421905123456', sent_at: null, sent_via: null, error: null,
      })
      expect(row.released_at, 'released_at set').toBeTruthy()
      const m = TEST_BODY.exec(row.body)
      expect(m, `body shape: ${row.body}`).not.toBeNull()
      expect([bratislavaStamp(t0), bratislavaStamp(t1)], 'Europe/Bratislava minute').toContain(m[1])

      if (DB_PATH) {
        const stored = withDb((db) => db.prepare('SELECT * FROM notifications WHERE id = ?').get(row.id))
        expect(stored).toMatchObject({
          template_key: 'test', recipient_kind: 'admin', recipient_id: null, segment_key: 'test', cycle_id: null,
          channel: 'whatsapp', status: 'released', phone_e164: '+421905123456', body: row.body, unresolved: '[]',
        })
        expect(stored.released_at).toBeTruthy()
      }

      const second = await sendTest()
      expect(second.status()).toBe(409)
      const refusal = await second.json()
      expect(refusal.reason).toBe('test_pending')
      expect(refusal.id, 'the 409 names the pending row').toBe(row.id)
      if (DB_PATH) expect(testRows().filter((r) => r.status === 'released').map((r) => r.id)).toEqual([row.id])
    } finally {
      await finalise(row.id)
    }

    // Final ⇒ the next test goes through (the 409 was about the pending row, nothing else).
    const third = await sendTest()
    expect(third.status()).toBe(201)
    const next = await third.json()
    expect(next.id).toBeGreaterThan(row.id)
    await finalise(next.id)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 WA_HEALTH_URL — the proxy against a stub `gorifi-wa` health server
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T7 · §2 health proxy against a stub (WA_HEALTH_URL)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!WA_HEALTH_URL, NEEDS_HEALTH)
  test.beforeAll(async () => { await ensureAdmin() })

  test('connected ⇒ the process fields pass through; `reachable`, `opt_in`, `paused` are the API’s own', async () => {
    const stop = await startHealthStub(CONNECTED)
    try {
      const body = await health()
      const s = await settings()
      expect(body).toMatchObject({
        reachable: true, state: 'connected', sender: 'stub', number: '+421000000000',
        queue: { released: 2, sent_today: 5, failed: 1 }, hourly_sent: 3, last_sent_at: '2026-10-24 12:30:00',
        uptime_s: 42, version: 'stub-1',
      })
      expect(body.paused, 'paused from settings, never the process').toBe(s.whatsappPaused)
      expect(typeof body.opt_in.on).toBe('number')
      expect(typeof body.opt_in.total).toBe('number')
    } finally { await stop() }
    expect((await health()).reachable, 'stub gone ⇒ unreachable again').toBe(false)
  })

  for (const mode of ['http500', 'notjson', 'array']) {
    test(`a ${mode} answer ⇒ 200 \`{reachable:false}\``, async () => {
      const stop = await startHealthStub(CONNECTED, { mode })
      try {
        const body = await health()
        expect(body.reachable).toBe(false)
        expect(body).not.toHaveProperty('state')
      } finally { await stop() }
    })
  }

  test('a process slower than 2 s ⇒ `{reachable:false}` within the timeout', async () => {
    test.setTimeout(30_000)
    const stop = await startHealthStub(CONNECTED, { delayMs: 3500 })
    try {
      const t0 = Date.now()
      const body = await health()
      const took = Date.now() - t0
      expect(body.reachable).toBe(false)
      expect(took, `answered in ${took} ms`).toBeLessThan(3400)
      expect(took, 'it did wait for the process').toBeGreaterThanOrEqual(1500)
    } finally { await stop() }
  })

  test('`state=qr`: the QR data URL passes through to the admin — and never reaches the server log', async () => {
    test.skip(!SERVER_LOG, NEEDS_LOG)
    const marker = `WA7QR${uniq}`
    const qr = `data:image/png;base64,${PNG_1PX}#${marker}`
    const stop = await startHealthStub(() => ({ state: 'qr', sender: 'whatsapp', qr, number: null, queue: { released: 0, sent_today: 0, failed: 0 } }))
    const start = (await fs.promises.stat(SERVER_LOG)).size
    try {
      const body = await health()
      expect(body.state).toBe('qr')
      expect(body.qr, 'non-vacuity: the marker really travelled through the proxy').toBe(qr)
    } finally { await stop() }
    await new Promise((r) => setTimeout(r, 400))
    const fh = await fs.promises.open(SERVER_LOG, 'r')
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - start))
    if (buf.length) await fh.read(buf, 0, buf.length, start)
    await fh.close()
    expect(buf.toString('utf8'), 'the QR is a pairing credential — never logged').not.toContain(marker)
    expect(buf.toString('utf8')).not.toContain(PNG_1PX)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 UI — /admin/whatsapp/settings
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T7 · §3 AdminWhatsAppSettings', () => {
  test.describe.configure({ mode: 'serial' })
  let saved = null
  let templatesBefore = null

  async function adminLogin(page) {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    // ⚠ Adopt the browser's token: the form login just ROTATED the one admin_token row.
    adminToken = await page.evaluate(() => localStorage.getItem('adminToken'))
  }

  test.beforeAll(async () => {
    await ensureAdmin()
    saved = await settings()
    templatesBefore = (await (await admin('/api/notifications/templates')).json()).templates
  })
  test.afterAll(async () => {
    if (!ctx) return
    await putSettings({ whatsappPaused: saved.whatsappPaused, whatsappTestPhone: saved.whatsappTestPhone })
    for (const t of templatesBefore || []) {
      const res = await admin(`/api/notifications/templates/${t.key}`, { method: 'put', data: { body: t.body, enabled: t.enabled } })
      expect(res.status(), `template ${t.key} restored`).toBe(200)
    }
  })

  test('„WhatsApp bot →“ on the settings page leads to the page; no process ⇒ `Odpojené` + `proces nebeží`, no QR card', async ({ page }) => {
    await adminLogin(page)
    await page.goto('/admin/settings')
    const link = page.getByTestId('admin-whatsapp-link')
    await expect(link).toHaveText(/WhatsApp bot →/)
    await link.click()
    await expect(page).toHaveURL(/\/admin\/whatsapp\/settings$/)
    await expect(page.getByTestId('wa-status-badge')).toHaveText('Odpojené')
    await expect(page.getByTestId('wa-state-word')).toHaveText('proces nebeží')
    await expect(page.getByTestId('wa-qr-card')).toHaveCount(0)
    await expect(page.getByTestId('wa-runbook')).toContainText('pm2 stop gorifi-wa')
    await expect(page.getByTestId('wa-runbook')).toContainText('npm update whatsapp-web.js')
    // Tempo: the documented defaults when no process reports them, and the API's count.
    await expect(page.getByTestId('wa-pace-gap')).toHaveText('3–10 s')
    await expect(page.getByTestId('wa-pace-hourly')).toHaveText('30')
    const h = await health()
    await expect(page.getByTestId('wa-opt-in')).toHaveText(`${h.opt_in.on} z ${h.opt_in.total} priateľov`)
    await expect(page.getByTestId('wa-pace-card')).toContainText('Správy sa odosielajú len ľuďom so zapnutým súhlasom v profile. Bez platného čísla sa riadok preskočí a označí.')
    // D7: no „Odpojiť/Pripojiť" in v1.
    await expect(page.getByRole('button', { name: /Odpojiť|Pripojiť/ })).toHaveCount(0)
  })

  test('the anonymous visit bounces to the admin login', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('adminToken'))
    await page.goto('/admin/whatsapp/settings')
    await expect(page).toHaveURL(/\/admin$/)
  })

  test('pause / resume writes `whatsapp_paused` (read back)', async ({ page }) => {
    await adminLogin(page)
    expect((await putSettings({ whatsappPaused: false })).status()).toBe(200)
    await page.goto('/admin/whatsapp/settings')
    const toggle = page.getByTestId('wa-pause-toggle')
    await expect(toggle).toHaveText('Pozastaviť odosielanie')
    await toggle.click()
    await expect(toggle).toHaveText('Obnoviť odosielanie')
    expect((await settings()).whatsappPaused).toBe(true)
    await page.reload()
    await expect(page.getByTestId('wa-pause-toggle')).toHaveText('Obnoviť odosielanie')
    await page.getByTestId('wa-pause-toggle').click()
    await expect(page.getByTestId('wa-pause-toggle')).toHaveText('Pozastaviť odosielanie')
    expect((await settings()).whatsappPaused).toBe(false)
  })

  test('test button: disabled until a number is SAVED (JS guard too); `abc` ⇒ the 400 inline; a valid number queues one row', async ({ page }) => {
    await adminLogin(page)
    expect((await putSettings({ whatsappTestPhone: '' })).status()).toBe(200)
    const posts = []
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/admin/whatsapp/test')) posts.push(r.url()) })
    await page.goto('/admin/whatsapp/settings')
    const input = page.getByTestId('wa-test-phone')
    const send = page.getByTestId('wa-test-send')
    await expect(input).toHaveAttribute('maxlength', '32')
    await expect(input).toHaveValue('')
    await expect(send).toBeDisabled()
    await input.fill('abc')
    await expect(send, 'typed but NOT saved').toBeDisabled()
    // A dispatched click ignores `disabled` — the handler must refuse too.
    await send.dispatchEvent('click')
    await page.waitForTimeout(300)
    expect(posts, 'no request from a disabled button').toEqual([])

    await page.getByTestId('wa-test-phone-save').click()
    await expect(send).toBeEnabled()
    expect((await settings()).whatsappTestPhone).toBe('abc')
    await send.click()
    await expect(page.getByTestId('wa-test-error')).toContainText('platné')
    expect(posts.length).toBe(1)

    await page.reload()
    await expect(page.getByTestId('wa-test-phone'), 'pre-filled from settings').toHaveValue('abc')

    if (!TARGET_IS_LOCAL) return
    await page.getByTestId('wa-test-phone').fill('0905 123 456')
    await page.getByTestId('wa-test-phone-save').click()
    await expect(page.getByTestId('wa-test-send')).toBeEnabled()
    const answer = page.waitForResponse((r) => r.url().includes('/api/admin/whatsapp/test') && r.request().method() === 'POST')
    await page.getByTestId('wa-test-send').click()
    const res = await answer
    expect(res.status()).toBe(201)
    const row = await res.json()
    try {
      expect(row).toMatchObject({ recipient_kind: 'admin', status: 'released', phone_e164: '+421905123456' })
      await expect(page.getByTestId('wa-test-ok')).toBeVisible()
    } finally {
      await finalise(row.id)
    }
  })

  test('templates: six rows, the computed sub-header, Zapnuté/Neskôr toggle, inline edit with the `{menoo}` 400 inline', async ({ page }) => {
    await adminLogin(page)
    // Start from the seed state for the two templates this test moves.
    expect((await admin('/api/notifications/templates/closing', { method: 'put', data: { enabled: false } })).status()).toBe(200)
    const list = async () => (await (await admin('/api/notifications/templates')).json()).templates
    const templates = await list()
    await page.goto('/admin/whatsapp/settings')
    for (const t of templates) {
      const row = page.getByTestId(`wa-template-${t.key}`)
      await expect(row).toContainText(t.name)
      await expect(row.getByTestId('wa-template-toggle')).toHaveText(t.enabled ? 'Zapnuté' : 'Neskôr')
      if (t.body) await expect(row.getByTestId('wa-template-body')).toHaveText(t.body)
    }
    await expect(page.locator('[data-testid^="wa-template-"][data-template-key]')).toHaveCount(6)

    const summary = (ts) => {
      const on = ts.filter((t) => t.key !== 'custom' && t.enabled).length
      const off = ts.filter((t) => t.key !== 'custom' && !t.enabled).length
      const offWord = off === 1 ? 'pripravená' : off >= 2 && off <= 4 ? 'pripravené' : 'pripravených'
      return `${on} na štart · ${off} ${offWord} · 1 vlastná`
    }
    await expect(page.getByTestId('wa-templates-summary')).toHaveText(summary(templates))

    // Toggle `closing` on, read back, sub-header recomputed; and off again.
    const closing = page.getByTestId('wa-template-closing')
    await closing.getByTestId('wa-template-toggle').click()
    await expect(closing.getByTestId('wa-template-toggle')).toHaveText('Zapnuté')
    let now = await list()
    expect(now.find((t) => t.key === 'closing').enabled).toBe(true)
    await expect(page.getByTestId('wa-templates-summary')).toHaveText(summary(now))
    await closing.getByTestId('wa-template-toggle').click()
    await expect(closing.getByTestId('wa-template-toggle')).toHaveText('Neskôr')
    now = await list()
    expect(now.find((t) => t.key === 'closing').enabled).toBe(false)

    // Inline edit: `{menoo}` ⇒ the 400 shown inline, naming the token; nothing stored.
    const original = now.find((t) => t.key === 'closing').body
    await closing.getByTestId('wa-template-edit').click()
    const area = closing.getByTestId('wa-template-textarea')
    await expect(area).toHaveAttribute('maxlength', '1000')
    await expect(area).toHaveValue(original)
    await area.fill('Ahoj {menoo}')
    await closing.getByTestId('wa-template-save').click()
    await expect(closing.getByTestId('wa-template-error')).toContainText('{menoo}')
    await expect(area, 'the editor stays open with the text').toHaveValue('Ahoj {menoo}')
    expect((await list()).find((t) => t.key === 'closing').body, 'nothing stored').toBe(original)

    // A valid edit saves, closes the editor and updates the preview.
    const edited = `Ahoj {meno}, WA7 ${uniq} {datum}`
    await area.fill(edited)
    await closing.getByTestId('wa-template-save').click()
    await expect(closing.getByTestId('wa-template-textarea')).toHaveCount(0)
    await expect(closing.getByTestId('wa-template-body')).toHaveText(edited)
    expect((await list()).find((t) => t.key === 'closing').body).toBe(edited)

    // Cancel discards.
    await closing.getByTestId('wa-template-edit').click()
    await closing.getByTestId('wa-template-textarea').fill('zahodiť')
    await closing.getByTestId('wa-template-cancel').click()
    await expect(closing.getByTestId('wa-template-body')).toHaveText(edited)
    expect((await list()).find((t) => t.key === 'closing').body).toBe(edited)
    expect((await admin('/api/notifications/templates/closing', { method: 'put', data: { body: original } })).status()).toBe(200)
  })

  test('a slow template save blocks opening ANOTHER editor (JS guard too) and closes only its own', async ({ page }) => {
    await adminLogin(page)
    const list = async () => (await (await admin('/api/notifications/templates')).json()).templates
    const original = (await list()).find((t) => t.key === 'closing').body
    let release
    const gate = new Promise((r) => { release = r })
    await page.route('**/api/notifications/templates/closing', async (route) => {
      if (route.request().method() === 'PUT') await gate
      await route.continue()
    })
    await page.goto('/admin/whatsapp/settings')
    const closing = page.getByTestId('wa-template-closing')
    const waitlist = page.getByTestId('wa-template-waitlist')
    await closing.getByTestId('wa-template-edit').click()
    await expect(closing.getByTestId('wa-template-textarea')).toHaveAttribute('aria-label', /^Text šablóny /)
    const edited = `Ahoj {meno}, WA7 slow ${uniq} {datum}`
    await closing.getByTestId('wa-template-textarea').fill(edited)
    await closing.getByTestId('wa-template-save').click()
    // While A's PUT is held: B's „Upraviť" is disabled AND a dispatched click opens nothing.
    await expect(waitlist.getByTestId('wa-template-edit')).toBeDisabled()
    await waitlist.getByTestId('wa-template-edit').dispatchEvent('click')
    await page.waitForTimeout(300)
    await expect(waitlist.getByTestId('wa-template-textarea')).toHaveCount(0)
    await expect(closing.getByTestId('wa-template-textarea'), 'A stays open while saving').toHaveValue(edited)
    release()
    await expect(closing.getByTestId('wa-template-textarea')).toHaveCount(0)
    await expect(closing.getByTestId('wa-template-body')).toHaveText(edited)
    await expect(waitlist.getByTestId('wa-template-edit')).toBeEnabled()
    // Now B opens normally.
    await waitlist.getByTestId('wa-template-edit').click()
    await expect(waitlist.getByTestId('wa-template-textarea')).toBeVisible()
    await page.unroute('**/api/notifications/templates/closing')
    expect((await admin('/api/notifications/templates/closing', { method: 'put', data: { body: original } })).status()).toBe(200)
  })

  test('health is polled every 5 s while mounted and NOT after leaving the page', async ({ page }) => {
    await adminLogin(page)
    let polls = 0
    page.on('request', (r) => { if (r.url().includes('/api/admin/whatsapp/health')) polls += 1 })
    await page.goto('/admin/whatsapp/settings')
    await expect(page.getByTestId('wa-state-word')).toBeVisible()
    await page.waitForTimeout(5800)
    expect(polls, 'mount + at least one 5 s poll').toBeGreaterThanOrEqual(2)
    expect(polls, 'not faster than every 5 s').toBeLessThanOrEqual(3)
    await page.getByTestId('wa-back').click()
    await expect(page).toHaveURL(/\/admin\/settings$/)
    const after = polls
    await page.waitForTimeout(6000)
    expect(polls, 'polling stopped on unmount').toBe(after)
  })

  test.describe('with a stub process (WA_HEALTH_URL)', () => {
    test.skip(!WA_HEALTH_URL, NEEDS_HEALTH)

    test('connected ⇒ `Pripojené`, the formatted number and counts; `state=qr` ⇒ the QR card with the `<img>`; gone ⇒ `proces nebeží`', async ({ page }) => {
      test.setTimeout(90_000)
      await adminLogin(page)
      let payload = CONNECTED()
      payload.last_error = 'Error: boom'
      payload.hourly_max = 12
      payload.pace = { min_ms: 2000, max_ms: 7000 }
      const stop = await startHealthStub(() => payload)
      let stopped = false
      try {
        await page.goto('/admin/whatsapp/settings')
        await expect(page.getByTestId('wa-status-badge')).toHaveText('Pripojené')
        await expect(page.getByTestId('wa-number')).toHaveText('+421 000 000 000')
        await expect(page.getByTestId('wa-queue')).toHaveText('2 / 5 / 1')
        await expect(page.getByTestId('wa-last-error')).toHaveText('Error: boom')
        await expect(page.getByTestId('wa-pace-gap'), 'the process-reported pace wins').toHaveText('2–7 s')
        await expect(page.getByTestId('wa-pace-hourly')).toHaveText('12')
        await expect(page.getByTestId('wa-qr-card')).toHaveCount(0)

        const qr = `data:image/png;base64,${PNG_1PX}`
        payload = { state: 'qr', sender: 'whatsapp', qr, number: null, queue: { released: 0, sent_today: 0, failed: 0 } }
        const card = page.getByTestId('wa-qr-card')
        await expect(card).toBeVisible({ timeout: 12_000 })
        await expect(page.getByTestId('wa-status-badge')).toHaveText('Odpojené')
        await expect(page.getByTestId('wa-state-word')).toHaveText('čaká na spárovanie')
        await expect(card).toContainText('Na telefóne s číslom bota: WhatsApp → Prepojené zariadenia → Prepojiť zariadenie → naskenujte.')
        await expect(card).toContainText('QR sa obnoví o ~20 s')
        await expect(page.getByTestId('wa-qr-img')).toHaveAttribute('src', qr)
        expect(await page.getByTestId('wa-qr-img').evaluate((img) => img.complete && img.naturalWidth > 0), 'the data URL loads under the CSP').toBe(true)
        expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })), 'the QR is never stored').not.toContain(PNG_1PX)

        // A non-data URL is never rendered as the QR (no external fetch from a health body).
        payload = { state: 'qr', qr: 'https://evil.example/qr.png' }
        await expect(page.getByTestId('wa-qr-img')).toHaveCount(0, { timeout: 12_000 })

        for (const [state, word] of [['starting', 'spúšťa sa'], ['disconnected', 'odpojené'], ['auth_failure', 'chyba prihlásenia'], ['paused', 'pozastavené']]) {
          payload = { state, queue: { released: 0, sent_today: 0, failed: 0 } }
          await expect(page.getByTestId('wa-state-word')).toHaveText(word, { timeout: 12_000 })
          await expect(page.getByTestId('wa-status-badge')).toHaveText('Odpojené')
        }

        await stop()
        stopped = true
        await expect(page.getByTestId('wa-state-word')).toHaveText('proces nebeží', { timeout: 12_000 })
        await expect(page.getByTestId('wa-qr-card')).toHaveCount(0)
      } finally {
        if (!stopped) await stop()
      }
    })

    test('qr ⇒ connected: the QR card goes away on the next poll; last-sent is shown in Bratislava time; no `wa-last-error` row without an error', async ({ page }) => {
      test.setTimeout(60_000)
      await adminLogin(page)
      const qr = `data:image/png;base64,${PNG_1PX}`
      let payload = { state: 'qr', sender: 'whatsapp', qr, number: null, queue: { released: 0, sent_today: 0, failed: 0 } }
      const stop = await startHealthStub(() => payload)
      try {
        await page.goto('/admin/whatsapp/settings')
        await expect(page.getByTestId('wa-qr-img')).toBeVisible()
        await expect(page.getByTestId('wa-last-error'), 'no last-error row while the bot is in the QR state').toHaveCount(0)
        payload = CONNECTED()
        await expect(page.getByTestId('wa-qr-card')).toHaveCount(0, { timeout: 12_000 })
        await expect(page.getByTestId('wa-status-badge')).toHaveText('Pripojené')
        await expect(page.getByTestId('wa-last-sent')).toHaveText(bratislavaStamp(new Date('2026-10-24T12:30:00Z')))
        await expect(page.getByTestId('wa-last-error'), 'null last_error ⇒ no row').toHaveCount(0)
        // Health-provided pace absent ⇒ the documented defaults.
        await expect(page.getByTestId('wa-pace-gap')).toHaveText('3–10 s')
        await expect(page.getByTestId('wa-pace-hourly')).toHaveText('30')
      } finally { await stop() }
    })
  })
})
