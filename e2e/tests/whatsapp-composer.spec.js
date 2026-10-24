// Module 21 — WA-T8: the admin composer `/admin/whatsapp` (`AdminWhatsApp.vue`,
// 21 §UC-WA-009) over WA-T3/WA-T5's outbox API, + the module-16 buttons 16 left to 21
// (the board's „Správy (n vo fronte)“ / per-group „Správa skupine“; the confirm modal's
// sentence and the toast's message half are pinned in distribution-group-handover.spec.js),
// + WA-T8's two repair doors (learnings 15 §WA-T8):
//   • a `failed` row is refreshed by „Prepísať texty vo fronte“ (`/rerender`) and re-sent
//     by „Skúsiť znova“ (`/retry`) — the e-mail fallback row that failed on a bad contact;
//   • a `'test'` row stuck `released` is closed from the settings page through the hand
//     tick (`PATCH /api/notifications/:id/manual-sent`).
//
// EVIDENCE KINDS:
//   §1 UI over fixtures built through the REAL routes (friends, orders, pack, module-16
//      hand-over) — always runs. The admin logs in through the form and the API helper
//      ADOPTS the browser's token (one global admin_token row — CLAUDE.md).
//   §2 WA_HEALTH_URL-gated — the gate server's health reader is pointed at a port this
//      spec serves (whatsapp-outbox.spec.js §4's pattern): `bot_active`, the banner's
//      connected+paused branch.
//
// ⚠ WA-T9 (the stub SENDER) owns — and closed, `whatsapp-process.spec.js` §2 — „… and (with the stub sender running) to `Odoslané`
// within the poll interval“ — nothing here drains `released` rows.
// ⚠ E-mail rows settle `failed`/`not_configured` right after a release on a gate without
// Mailgun (learnings 15 §WA-T6) — the repair-door test USES that.
// ⚠ Every template / setting this spec changes is restored (whatsapp-templates.spec.js
// pins the seed byte-for-byte later in a full run).

import { test, expect, request as playwrightRequest } from '@playwright/test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD, TARGET_IS_LOCAL } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const WA_HEALTH_URL = process.env.WA_HEALTH_URL || ''
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs DB_PATH — the database the server runs on (a send behind the page’s back is the WA process’s write)'
const NEEDS_HEALTH = 'needs WA_HEALTH_URL — the SAME value the gate server was started with (e2e/README.md)'
const NEEDS_LOCAL = 'releases e-mail / WhatsApp rows — a deployment with Mailgun or a paired bot would send them. Run against the local recipe.'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The Europe/Bratislava calendar day of a SQLite UTC stamp — an independent copy.
function bratislavaDate(stamp) {
  const instant = new Date(`${String(stamp).replace(' ', 'T')}Z`)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant)
}

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

async function adminLogin(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  // ⚠ Adopt the browser's token: the form login just ROTATED the one admin_token row.
  adminToken = await page.evaluate(() => localStorage.getItem('adminToken'))
}

let friendSeq = 0
async function makeFriend(label, { phone, email } = {}) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `wa8_${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `W8${label}${uniq}${friendSeq} Test`
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
  return { id: row.id, name, auth: { Authorization: `Bearer ${token}` } }
}

async function ownOrder(friend, cycleId, items, submitBody) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth, data: { items }, timeout: TIMEOUT })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, { headers: friend.auth, data: submitBody, timeout: TIMEOUT })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}
async function packFriend(cycleId, friend, orderId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status()).toBe(200)
  const party = (await res.json()).distribution.find((p) => p.id === friend.id && p.kind === 'friend')
  for (const item of party.items) if (!item.packed) expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status(), 'order packed').toBe(200)
}
async function handOver(orderId) {
  const res = await admin(`/api/orders/${orderId}/handed-over`, { method: 'patch', data: { handed_over: true } })
  expect(res.status(), 'hand-over').toBe(200)
  return res.json()
}
async function groupRows(cycleId, segmentKey) {
  const res = await admin('/api/notifications', { params: { cycle_id: String(cycleId), segment_key: segmentKey } })
  expect(res.status(), `GET /notifications ${segmentKey}`).toBe(200)
  return (await res.json()).rows
}
async function segments(cycleId) {
  const res = await admin('/api/notifications/segments', { params: { cycle_id: String(cycleId) } })
  expect(res.status()).toBe(200)
  return res.json()
}
// The composer's query, read through URL parsing (`router.replace` leaves `:` unescaped).
async function expectQuery(page, expected) {
  await expect.poll(() => {
    const url = new URL(page.url())
    return { path: url.pathname, ...Object.fromEntries(url.searchParams) }
  }).toEqual(expected)
}
const rowOf = (rows, friend) => rows.find((r) => r.recipient_kind === 'friend' && r.recipient_id === friend.id)
async function getTemplate(key) {
  const res = await admin('/api/notifications/templates')
  expect(res.status()).toBe(200)
  return (await res.json()).templates.find((t) => t.key === key)
}
async function setTemplate(key, patch) {
  const res = await admin(`/api/notifications/templates/${key}`, { method: 'put', data: patch })
  expect(res.status(), `template ${key}`).toBe(200)
  return res.json()
}
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH)
  try { return fn(db) } finally { db.close() }
}
const settings = async () => (await admin('/api/admin/settings')).json()
const putSettings = (data) => admin('/api/admin/settings', { method: 'put', data })

// A stub `gorifi-wa` health server on WA_HEALTH_URL's port (the settings spec's shape).
async function startHealthStub(payload) {
  const server = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload()))
  })
  const { port, hostname } = new URL(WA_HEALTH_URL)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(port), hostname, resolve) })
  return async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}
const CONNECTED = () => ({ state: 'connected', sender: 'stub', number: '+421000000000', qr: null, queue: { released: 0, sent_today: 0, failed: 0 } })

// ═════════════════════════════════════════════════════════════════════════════
// §1 the composer over real hand-over groups
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T8 · §1 /admin/whatsapp', () => {
  test.describe.configure({ mode: 'serial' })
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    await ensureAdmin()
    const cycle = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA8 ${uniq}`, type: 'coffee', status: 'open', closes_at: '2026-11-06' } })
    expect(cycle.status(), 'cycle create').toBe(201)
    fx.cycle = await cycle.json()
    // A round with NO message groups at all (the cycle-switch race pin).
    const empty = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA8 prázdna ${uniq}`, type: 'coffee', status: 'planned' } })
    expect(empty.status(), 'empty cycle create').toBe(201)
    fx.emptyCycle = await empty.json()
    const product = await admin('/api/products', {
      method: 'post', data: { cycle_id: fx.cycle.id, name: `WA8 Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 },
    })
    expect(product.status()).toBe(201)
    fx.product = await product.json()
    const line = () => [{ product_id: fx.product.id, variant: '250g', quantity: 1 }]
    const location = async (label) => {
      const res = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA8 ${label} ${uniq}`, address: `Ulica ${label}`, for_coffee: true, for_bakery: true } })
      expect(res.status()).toBe(201)
      return res.json()
    }
    fx.L = await location('Lúka')
    fx.M = await location('Mlyn')
    fx.K = await location('Kopec')

    fx.A = await makeFriend('Adam', { phone: '0905 801 001' })
    fx.B = await makeFriend('Beata', { phone: '0905 801 002' })
    fx.Z = await makeFriend('Zero') // no phone, no e-mail ⇒ skipped/no_phone
    fx.D = await makeFriend('Dana', { phone: '0905 801 004' })
    fx.F = await makeFriend('Fero', { phone: '0905 801 005' })
    fx.E = await makeFriend('Ema', { email: `wa8.ema.${uniq}@example.test` }) // e-mail fallback

    const orders = []
    for (const [f, loc] of [[fx.A, fx.L], [fx.B, fx.L], [fx.Z, fx.L], [fx.D, fx.M], [fx.F, fx.M], [fx.E, fx.K]]) {
      const o = await ownOrder(f, fx.cycle.id, line(), { pickup_location_id: loc.id })
      orders.push([f, o])
    }
    for (const [f, o] of orders) await packFriend(fx.cycle.id, f, o.id)
    let stamp = null
    for (const [, o] of orders) stamp = (await handOver(o.id)).order.handed_over_at
    fx.today = bratislavaDate(stamp)
    fx.keyL = `handed_over:pickup:${fx.L.id}:${fx.today}`
    fx.keyM = `handed_over:pickup:${fx.M.id}:${fx.today}`
    fx.keyK = `handed_over:pickup:${fx.K.id}:${fx.today}`
    const rowsL = await groupRows(fx.cycle.id, fx.keyL)
    expect(rowsL.map((r) => r.status).sort(), 'A, B queued + Z skipped').toEqual(['queued', 'queued', 'skipped'])
    fx.rowA = rowOf(rowsL, fx.A)
    fx.rowB = rowOf(rowsL, fx.B)
    fx.rowZ = rowOf(rowsL, fx.Z)
    expect(fx.rowZ).toMatchObject({ status: 'skipped', error: 'no_phone' })
    const rowsM = await groupRows(fx.cycle.id, fx.keyM)
    fx.rowD = rowOf(rowsM, fx.D)
    fx.rowF = rowOf(rowsM, fx.F)
    fx.rowE = rowOf(await groupRows(fx.cycle.id, fx.keyK), fx.E)
    expect(fx.rowE).toMatchObject({ status: 'queued', channel: 'email' })
  })

  test.afterAll(async () => {
    for (const loc of [fx.L, fx.M, fx.K]) {
      if (!loc || !ctx) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([200, 204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  const composerUrl = (segment) => `/admin/whatsapp?cycle=${fx.cycle.id}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}`
  const row = (page, r) => page.getByTestId(`wa-row-${r.id}`)

  test('linked from the dashboard and the settings page (and back); the cycle selector defaults to ?cycle=, else the newest locked, else the newest open; „Cez bota“ is the default tab', async ({ page }) => {
    await adminLogin(page)
    await page.getByTestId('admin-whatsapp-composer-link').click()
    await expect(page).toHaveURL(/\/admin\/whatsapp(\?|$)/)
    await expect(page.getByRole('heading', { name: 'Správy skupinám' })).toBeVisible()
    await expect(page.getByTestId('wa-composer-sub')).toHaveText('Správa sa nikdy neodošle sama. Skupinu vyberiete, text skontrolujete, odošlete jedným tlačidlom.')

    // An INDEPENDENT copy of the default rule (newest = highest id).
    const cycles = (await (await admin('/api/cycles')).json()).slice().sort((a, b) => b.id - a.id)
    const expected = (cycles.find((c) => c.status === 'locked') || cycles.find((c) => c.status === 'open') || cycles[0]).id
    await expect(page.getByTestId('wa-cycle-select')).toHaveValue(String(expected))
    await expect(page.getByTestId('wa-tab-bot')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('wa-tab-manual')).toHaveAttribute('aria-selected', 'false')

    await page.goto(composerUrl())
    await expect(page.getByTestId('wa-cycle-select')).toHaveValue(String(fx.cycle.id))
    // Changing the selector writes the query (a refresh lands on the same cycle).
    if (expected !== fx.cycle.id) {
      await page.getByTestId('wa-cycle-select').selectOption(String(expected))
      await expect(page).toHaveURL(new RegExp(`[?&]cycle=${expected}(&|$)`))
      await page.getByTestId('wa-cycle-select').selectOption(String(fx.cycle.id))
      await expect(page).toHaveURL(new RegExp(`[?&]cycle=${fx.cycle.id}(&|$)`))
    }

    await page.getByTestId('wa-settings-link').click()
    await expect(page).toHaveURL(/\/admin\/whatsapp\/settings$/)
    await page.getByTestId('wa-composer-link').click()
    await expect(page).toHaveURL(/\/admin\/whatsapp(\?|$)/)
    await page.getByTestId('wa-composer-back').click()
    await expect(page).toHaveURL(/\/admin\/dashboard$/)
  })

  test('a hand-over group renders its rows „Vo fronte“; the number-less to-do is „Bez platného čísla“, greyed at the BOTTOM; the Komu badge counts queued+released+failed', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyL))
    const group = page.getByTestId(`wa-group-${fx.keyL}`)
    await expect(group).toHaveAttribute('aria-pressed', 'true')
    await expect(group).toContainText(`${fx.L.name} — odovzdané`)
    await expect(group.getByTestId('wa-group-count')).toHaveText('2')
    // ~~„1 bez čísla“~~ → WA-T8 review: `counts.skipped` also holds cancelled / not-waiting rows.
    await expect(group.getByTestId('wa-group-skipped')).toHaveText('1 preskočené')

    await expect(page.getByTestId('wa-template-title')).toHaveText('Šablóna · Doručené na odberné miesto')
    await expect(page.getByTestId('wa-preview-title')).toHaveText('Náhľad · 3 príjemcovia')
    const rows = page.locator('[data-testid^="wa-row-"][data-status]')
    await expect(rows).toHaveCount(3)
    for (const r of [fx.rowA, fx.rowB]) {
      await expect(row(page, r).getByTestId('wa-row-badge')).toHaveText('Vo fronte')
      await expect(row(page, r).getByTestId('wa-row-body')).toHaveText(r.body)
      await expect(row(page, r)).toHaveAttribute('data-unresolved', 'false')
    }
    await expect(row(page, fx.rowA).getByTestId('wa-row-phone')).toHaveText('0905 801 001')
    await expect(rows.last(), 'skipped rows sit at the bottom').toHaveAttribute('data-testid', `wa-row-${fx.rowZ.id}`)
    await expect(row(page, fx.rowZ).getByTestId('wa-row-badge')).toHaveText('Bez platného čísla')
    await expect(row(page, fx.rowZ)).toHaveClass(/opacity-60/)
    await expect(page.getByTestId('wa-release')).toHaveText('Poslať skupine (2)')
    await expect(page.getByTestId('wa-bot-help')).toHaveText('Bot posiela s odstupom 3–10 s, max. 30 správ/hod. Pri chybe prihlásenia sa zastaví a ukáže to tu.')
    // No process on the gate's health URL ⇒ the offline banner (21 §UC-WA-012 acceptance).
    await expect(page.getByTestId('wa-offline-banner')).toHaveText('Bot je odpojený — správy zostanú vo fronte. Môžete ich poslať ručne v záložke wa.me.')
  })

  test('inline body edit of a queued row → PATCH (maxlength 1000); a blank text is refused inline and NOTHING is written', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyL))
    const a = row(page, fx.rowA)
    await a.getByTestId('wa-row-edit').click()
    const area = a.getByTestId('wa-row-textarea')
    await expect(area).toHaveAttribute('maxlength', '1000')
    await expect(area).toHaveValue(fx.rowA.body)

    await area.fill('   ')
    await a.getByTestId('wa-row-save').click()
    await expect(a.getByTestId('wa-row-error')).toHaveText('Text správy nemôže byť prázdny')
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyL), fx.A).body, 'refusal wrote nothing').toBe(fx.rowA.body)

    const next = `${fx.rowA.body} Vďaka${uniq}.`
    await area.fill(next)
    await a.getByTestId('wa-row-save').click()
    await expect(a.getByTestId('wa-row-textarea')).toHaveCount(0)
    await expect(a.getByTestId('wa-row-body')).toHaveText(next)
    const back = rowOf(await groupRows(fx.cycle.id, fx.keyL), fx.A)
    expect(back).toMatchObject({ status: 'queued', body: next, unresolved: [] })
    fx.rowA = back
  })

  test('a literal `{datum}` row is outlined from its `unresolved`, blocks „Poslať skupine“ with the inline message, NOTHING changes (read back), and the first flagged row is scrolled into view', async ({ page }) => {
    await adminLogin(page)
    await page.setViewportSize({ width: 1280, height: 420 })
    await page.goto(composerUrl(fx.keyL))
    const b = row(page, fx.rowB)
    await b.getByTestId('wa-row-edit').click()
    await b.getByTestId('wa-row-textarea').fill(`${fx.rowB.body} Uzávierka {datum}.`)
    await b.getByTestId('wa-row-save').click()
    await expect(b).toHaveAttribute('data-unresolved', 'true')
    await expect(b.getByTestId('wa-row-unresolved')).toHaveText('Doplňte {datum}')

    const before = await groupRows(fx.cycle.id, fx.keyL)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(b, 'non-vacuity: the flagged row starts OFF screen').not.toBeInViewport()
    await page.getByTestId('wa-release').click()
    await expect(page.getByTestId('wa-release-error')).toHaveText('Niektoré správy majú nevyplnené údaje — doplňte ich a skúste znova')
    await expect(b).toBeInViewport()
    expect(await groupRows(fx.cycle.id, fx.keyL), 'all-or-nothing: no row moved').toEqual(before)

    // Fixed ⇒ the outline goes.
    await b.getByTestId('wa-row-edit').click()
    await b.getByTestId('wa-row-textarea').fill(fx.rowB.body)
    await b.getByTestId('wa-row-save').click()
    await expect(b).toHaveAttribute('data-unresolved', 'false')
  })

  test('„Poslať skupine (2)“ flips both queued rows to „Uvoľnené“ (read back), with the declined toast; the skipped to-do stays', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyL))
    await page.getByTestId('wa-release').click()
    await expect(page.getByTestId('wa-toast')).toHaveText('2 správy uvoľnené — bot ich odošle s odstupom 3–10 s')
    for (const r of [fx.rowA, fx.rowB]) await expect(row(page, r).getByTestId('wa-row-badge')).toHaveText('Uvoľnené')
    await expect(row(page, fx.rowZ).getByTestId('wa-row-badge')).toHaveText('Bez platného čísla')
    await expect(page.getByTestId('wa-release')).toHaveText('Poslať skupine (0)')
    await expect(page.getByTestId('wa-release')).toBeDisabled()
    const back = await groupRows(fx.cycle.id, fx.keyL)
    expect(rowOf(back, fx.A).status).toBe('released')
    expect(rowOf(back, fx.B).status).toBe('released')
    expect(rowOf(back, fx.Z).status).toBe('skipped')
    // ⚠ WA-T9: „… and (with the stub sender running) to `Odoslané`“ — no sender here; the stub-drained twin is `whatsapp-process.spec.js` §2.
  })

  test('wa.me tab: NO wa.me href in the DOM before the click; „Otvoriť chat“ opens https://wa.me/<digits>?text=<encoded body> (noopener) composed at click time, the row reads „Otvorené ✓“ and stays so after a reload', async ({ page }) => {
    await page.addInitScript(() => {
      window.__opened = []
      window.open = (...args) => { window.__opened.push(args); return null }
    })
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyM))
    await page.getByTestId('wa-tab-manual').click()
    await expect(page.getByTestId('wa-manual-help')).toHaveText('Každý riadok otvorí chat s predvyplneným textom vo vašom WhatsAppe.')
    const d = row(page, fx.rowD)
    await expect(d.getByTestId('wa-row-open')).toHaveText('Otvoriť chat')
    await expect(page.getByTestId('wa-release'), 'no bulk button on the wa.me tab').toHaveCount(0)

    await expect(page.locator('[href*="wa.me"]')).toHaveCount(0)
    const html = await page.content()
    expect(html, 'no wa.me URL anywhere in the markup').not.toContain('https://wa.me')
    expect(html, 'the body never sits in an attribute (non-vacuity: it IS on screen as text)').toContain(fx.rowD.body.slice(0, 20))
    expect(html).not.toMatch(new RegExp(`="[^"]*${fx.rowD.body.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

    await d.getByTestId('wa-row-open').click()
    await expect(d.getByTestId('wa-row-opened')).toHaveText('Otvorené ✓')
    const opened = await page.evaluate(() => window.__opened)
    expect(opened).toEqual([[`https://wa.me/421905801004?text=${encodeURIComponent(fx.rowD.body)}`, '_blank', 'noopener,noreferrer']])
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyM), fx.D)).toMatchObject({ status: 'sent', sent_via: 'wa_me' })
    await expect(d.getByTestId('wa-row-badge')).toHaveText('Odoslané · wa.me')

    await page.reload()
    await page.getByTestId('wa-tab-manual').click()
    await expect(row(page, fx.rowD).getByTestId('wa-row-opened'), 'persisted on the row').toHaveText('Otvorené ✓')
    await expect(row(page, fx.rowD).getByTestId('wa-row-open')).toHaveCount(0)

    // A RELEASED row shows the door while the bot is not connected (the gate: no process).
    await page.getByTestId(`wa-group-${fx.keyL}`).click()
    await expect(row(page, fx.rowB).getByTestId('wa-row-open')).toBeVisible()
    await row(page, fx.rowB).getByTestId('wa-row-open').click()
    await expect(row(page, fx.rowB).getByTestId('wa-row-opened')).toHaveText('Otvorené ✓')
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyL), fx.B)).toMatchObject({ status: 'sent', sent_via: 'wa_me' })
  })

  test('the rows are RE-READ on the 5 s health tick while one is released: a send behind the page’s back flips „Uvoľnené“ to „Odoslané“ without a reload', async ({ page }) => {
    test.skip(!DB_PATH, NEEDS_DB)
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyL))
    const a = row(page, fx.rowA)
    await expect(a.getByTestId('wa-row-badge')).toHaveText('Uvoľnené')
    let navigations = 0
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1 })
    // What the `gorifi-wa` process (WA-T9) writes on a send — only it, never the API.
    const changed = withDb((db) => db.prepare(
      "UPDATE notifications SET status = 'sent', sent_via = 'bot', sent_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'released'"
    ).run(fx.rowA.id).changes)
    expect(changed, 'non-vacuity: A was released').toBe(1)
    await expect(a.getByTestId('wa-row-badge')).toHaveText('Odoslané', { timeout: 15_000 })
    expect(navigations, 'no reload').toBe(0)
  })

  test('„×“ deletes a queued row and a skipped to-do (read back); released/sent rows offer no „×“', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyM))
    await expect(row(page, fx.rowD).getByTestId('wa-row-delete'), 'a sent row has no ×').toHaveCount(0)
    await row(page, fx.rowF).getByTestId('wa-row-delete').click()
    await expect(row(page, fx.rowF)).toHaveCount(0)
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyM), fx.F), 'gone').toBeUndefined()

    await page.getByTestId(`wa-group-${fx.keyL}`).click()
    await expect(row(page, fx.rowA).getByTestId('wa-row-delete'), 'a released row has no ×').toHaveCount(0)
    await row(page, fx.rowZ).getByTestId('wa-row-delete').click()
    await expect(row(page, fx.rowZ)).toHaveCount(0)
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyL), fx.Z)).toBeUndefined()
  })

  test('Šablóna: a chip inserts at the CARET, blur saves (PUT), an unknown `{menoo}` is refused inline and not saved', async ({ page }) => {
    const before = await getTemplate('pickup')
    try {
      await adminLogin(page)
      await page.goto(composerUrl(fx.keyL))
      const area = page.getByTestId('wa-template-text')
      await expect(area).toHaveValue(before.body)
      await expect(area).toHaveAttribute('maxlength', '1000')
      await area.evaluate((el) => { el.focus(); el.setSelectionRange(5, 5) })
      await page.getByTestId('wa-placeholder-chip').filter({ hasText: '{miesto}' }).click()
      const inserted = `${before.body.slice(0, 5)}{miesto}${before.body.slice(5)}`
      await expect(area).toHaveValue(inserted)
      await expect(area, 'the chip kept the focus — nothing saved half-way').toBeFocused()

      await page.getByTestId('wa-preview-title').click() // blur
      await expect(page.getByTestId('wa-template-saved')).toHaveText('Šablóna uložená.')
      expect((await getTemplate('pickup')).body).toBe(inserted)

      await area.fill(`${inserted} {menoo}`)
      await page.getByTestId('wa-preview-title').click()
      await expect(page.getByTestId('wa-template-error')).toHaveText('Neznámy zástupný symbol {menoo} — šablóna sa neuložila.')
      expect((await getTemplate('pickup')).body, 'refused ⇒ not saved').toBe(inserted)

      // WA-T8 review: a refused edit and its message are kept PER TEMPLATE across a group
      // switch — never dropped silently.
      await page.getByTestId(`wa-computed-not_ordered:${fx.cycle.id}`).getByRole('button', { name: 'Neobjednali' }).click()
      await expect(page.getByTestId('wa-template-title')).toHaveText('Šablóna · Objednávky sa čoskoro zatvárajú')
      await expect(page.getByTestId('wa-template-error')).toHaveCount(0)
      await page.getByTestId(`wa-group-${fx.keyL}`).click()
      await expect(page.getByTestId('wa-template-error')).toHaveText('Neznámy zástupný symbol {menoo} — šablóna sa neuložila.')
      await expect(area).toHaveValue(`${inserted} {menoo}`)

      // WA-T8 re-review: reverting the draft to the SAVED text clears the refusal (it would
      // otherwise keep compose / „Prepísať texty“ blocked until a reload).
      await area.fill(inserted)
      await page.getByTestId('wa-preview-title').click() // blur
      await expect(page.getByTestId('wa-template-error')).toHaveCount(0)
      expect((await getTemplate('pickup')).body, 'nothing re-saved').toBe(inserted)
    } finally {
      await setTemplate('pickup', { body: before.body, enabled: before.enabled })
    }
  })

  test('the failed-row repair door: an e-mail row that FAILED is refreshed by „Prepísať texty vo fronte (1)“ once the contact is fixed, then „Skúsiť znova (1)“ re-releases it on the new channel', async ({ page }) => {
    test.skip(!TARGET_IS_LOCAL, NEEDS_LOCAL)
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyK))
    const e = row(page, fx.rowE)
    await expect(e.getByTestId('wa-row-phone')).toContainText('e-mail')
    await page.getByTestId('wa-release').click()
    await expect(page.getByTestId('wa-toast')).toHaveText('1 správa uvoľnená — bot ju odošle s odstupom 3–10 s')
    // No Mailgun env on the gate ⇒ the hand-off settles it `failed`/`not_configured`.
    await expect.poll(async () => rowOf(await groupRows(fx.cycle.id, fx.keyK), fx.E).status, { timeout: 10_000 }).toBe('failed')
    await page.getByTestId(`wa-group-${fx.keyK}`).click()
    await expect(e.getByTestId('wa-row-badge')).toHaveText('Chyba')
    await expect(e.getByTestId('wa-row-badge')).toHaveAttribute('title', 'not_configured')
    await expect(page.getByTestId('wa-retry')).toHaveText('Skúsiť znova (1)')
    await expect(page.getByTestId('wa-rerender')).toHaveText('Prepísať texty vo fronte (1)')

    // ⚠ WA-T8 review — the RETRY GATE: a literal the re-render writes into a FAILED row
    // (a hand-filled `{tracking}` added to the template) blocks „Skúsiť znova“ exactly like
    // the release — 409 `unresolved_placeholders`, nothing written, nothing re-sent.
    const pickup = await getTemplate('pickup')
    try {
      await setTemplate('pickup', { body: `${pickup.body} Zásielka {tracking}.` })
      await page.getByTestId('wa-rerender').click()
      await expect(e).toHaveAttribute('data-unresolved', 'true')
      await expect(e.getByTestId('wa-row-unresolved')).toHaveText('Doplňte {tracking}')
      const blocked = await groupRows(fx.cycle.id, fx.keyK)
      expect(rowOf(blocked, fx.E)).toMatchObject({ status: 'failed', unresolved: ['{tracking}'] })
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.getByTestId('wa-retry').click()
      await expect(page.getByTestId('wa-release-error')).toHaveText('Niektoré správy majú nevyplnené údaje — doplňte ich a skúste znova')
      await expect(e).toBeInViewport()
      // `released_at` unchanged ⇒ the row was never re-released, so never handed to the mailer.
      expect(await groupRows(fx.cycle.id, fx.keyK), 'all-or-nothing: nothing written').toEqual(blocked)
      const viaApi = await admin('/api/notifications/retry', { method: 'post', data: { cycle_id: fx.cycle.id, segment_key: fx.keyK } })
      expect(viaApi.status()).toBe(409)
      expect(await viaApi.json()).toMatchObject({ reason: 'unresolved_placeholders', ids: [fx.rowE.id] })
      expect(await groupRows(fx.cycle.id, fx.keyK)).toEqual(blocked)

      // The admin fills it on the row: the per-row edit takes a FAILED row (status kept).
      const filled = rowOf(blocked, fx.E).body.replace('{tracking}', 'Z 123 4567')
      await e.getByTestId('wa-row-edit').click()
      await e.getByTestId('wa-row-textarea').fill(filled)
      await e.getByTestId('wa-row-save').click()
      await expect(e).toHaveAttribute('data-unresolved', 'false')
      expect(rowOf(await groupRows(fx.cycle.id, fx.keyK), fx.E)).toMatchObject({ status: 'failed', body: filled, unresolved: [] })
    } finally {
      await setTemplate('pickup', { body: pickup.body, enabled: pickup.enabled })
    }

    // The admin fixes the contact: Ema now has a number.
    expect((await admin(`/api/friends/${fx.E.id}`, { method: 'patch', data: { phone: '0905 801 006' } })).status()).toBe(200)
    await page.getByTestId('wa-rerender').click()
    await expect(page.getByTestId('wa-rerender-note')).toHaveText('Prepísané: 1.')
    const refreshed = rowOf(await groupRows(fx.cycle.id, fx.keyK), fx.E)
    expect(refreshed, 'status KEPT, contact + channel refreshed').toMatchObject({ status: 'failed', channel: 'whatsapp', phone_e164: '+421905801006' })
    await expect(e.getByTestId('wa-row-badge')).toHaveText('Chyba')
    await expect(e.getByTestId('wa-row-phone')).not.toContainText('e-mail')

    await page.getByTestId('wa-retry').click()
    await expect(e.getByTestId('wa-row-badge')).toHaveText('Uvoľnené')
    expect(rowOf(await groupRows(fx.cycle.id, fx.keyK), fx.E)).toMatchObject({ status: 'released', channel: 'whatsapp', phone_e164: '+421905801006' })
  })

  test('compose a computed segment: disabled + hint (JS-guarded) while its template is off; enabled ⇒ „Pripraviť správy (n)“ builds the group and selects it', async ({ page }) => {
    const key = `not_ordered:${fx.cycle.id}`
    const closing = await getTemplate('closing')
    if (closing.enabled) await setTemplate('closing', { enabled: false })
    try {
      await adminLogin(page)
      const posts = []
      page.on('request', (req) => { if (req.method() === 'POST' && req.url().endsWith('/api/notifications/compose')) posts.push(req.url()) })
      await page.goto(composerUrl())
      const button = page.getByTestId(`wa-compose-${key}`)
      await expect(button).toBeDisabled()
      await expect(page.getByTestId(`wa-compose-hint-${key}`)).toHaveText('Šablóna je vypnutá — zapnite ju v Nastaveniach')
      await button.dispatchEvent('click')
      await page.waitForTimeout(300)
      expect(posts, 'a dispatched click on the disabled button posts nothing').toEqual([])

      await setTemplate('closing', { enabled: true })
      const n = (await segments(fx.cycle.id)).computed.find((c) => c.key === key).count
      expect(n, 'non-vacuity: somebody has not ordered').toBeGreaterThan(0)
      await page.reload()
      await expect(button).toHaveText(`Pripraviť správy (${n})`)
      await button.click()
      const group = page.getByTestId(`wa-group-${key}`)
      await expect(group).toHaveAttribute('aria-pressed', 'true')
      await expectQuery(page, { path: '/admin/whatsapp', cycle: String(fx.cycle.id), segment: key })
      const rows = await groupRows(fx.cycle.id, key)
      expect(rows.length, 'one row per recipient').toBe(n)
      await expect(page.locator('[data-testid^="wa-row-"][data-status]')).toHaveCount(n)
      await expect(page.getByTestId('wa-template-title')).toHaveText('Šablóna · Objednávky sa čoskoro zatvárajú')
      expect(posts).toHaveLength(1)
    } finally {
      await setTemplate('closing', { body: closing.body, enabled: closing.enabled })
    }
  })

  test('loadSeq: a SLOW group answer that lands after a faster later click never paints over it', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyK))
    await expect(row(page, fx.rowE)).toBeVisible()
    let held = 0
    await page.route((url) => url.pathname === '/api/notifications' && url.searchParams.get('segment_key') === fx.keyL, async (route) => {
      held += 1
      await new Promise((resolve) => setTimeout(resolve, 4000))
      await route.continue()
    })
    const slow = page.waitForResponse((res) => res.url().includes('/api/notifications?') && decodeURIComponent(res.url()).includes(fx.keyL))
    await page.getByTestId(`wa-group-${fx.keyL}`).click()
    await page.getByTestId(`wa-group-${fx.keyM}`).click()
    await expect(row(page, fx.rowD)).toBeVisible()
    await slow
    expect(held, 'non-vacuity: the L answer really was held').toBe(1)
    await page.waitForTimeout(500)
    // The L answer has LANDED — it must not have painted. No retry window can hide a
    // defect here: the stale paint would only get MORE visible with time.
    await expect(row(page, fx.rowA)).toHaveCount(0, { timeout: 1000 })
    await expect(row(page, fx.rowD)).toBeVisible({ timeout: 1000 })
    await expect(page.getByTestId(`wa-group-${fx.keyM}`)).toHaveAttribute('aria-pressed', 'true')
  })

  test('switching the CYCLE while a row GET is in flight: the late answer never paints under the new cycle — even one with no groups', async ({ page }) => {
    await adminLogin(page)
    let held = 0
    await page.route((url) => url.pathname === '/api/notifications' && url.searchParams.get('segment_key') === fx.keyM, async (route) => {
      held += 1
      await new Promise((resolve) => setTimeout(resolve, 4000))
      await route.continue()
    })
    const slow = page.waitForResponse((res) => res.url().includes('/api/notifications?') && decodeURIComponent(res.url()).includes(fx.keyM))
    await page.goto(composerUrl(fx.keyM))
    await expect.poll(() => held, { message: 'non-vacuity: the M answer is held' }).toBe(1)
    await page.getByTestId('wa-cycle-select').selectOption(String(fx.emptyCycle.id))
    await expect(page.getByTestId('wa-no-groups')).toBeVisible()
    await slow
    await page.waitForTimeout(500)
    // Landed — and must not have painted (no retry window can hide it: it would only grow).
    await expect(row(page, fx.rowD)).toHaveCount(0, { timeout: 1000 })
    await expect(page.locator('[data-testid^="wa-row-"][data-status]')).toHaveCount(0, { timeout: 1000 })
  })

  test('module 16 board: „Správy (n vo fronte)“ opens the composer on the cycle; per delivery group „Správa skupine“ deep-links the target’s newest hand-over day; none in the stage view', async ({ page }) => {
    await adminLogin(page)
    const queued = (await segments(fx.cycle.id)).groups.reduce((s, g) => s + g.counts.queued, 0)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    await expect(page.getByTestId('board-messages')).toHaveText(`Správy (${queued} vo fronte)`)
    await expect(page.getByTestId(`messages-group-loc${fx.M.id}`)).toHaveText('Správa skupine')
    // Every pickup-point group carries it (this parcel-off round renders no Packeta and no
    // in-person group; `groupMessageSegment()` maps `packeta` ⇒ `handed_over:packeta` and
    // gives `in_person` none — 21 resolved conflict 4).
    const pointGroups = await page.locator('[data-testid^="dist-group-loc"]').count()
    expect(pointGroups, 'non-vacuity').toBeGreaterThanOrEqual(3)
    await expect(page.locator('[data-testid^="messages-group-loc"]')).toHaveCount(pointGroups)

    await page.getByTestId(`messages-group-loc${fx.M.id}`).click()
    await expectQuery(page, { path: '/admin/whatsapp', cycle: String(fx.cycle.id), segment: `handed_over:pickup:${fx.M.id}` })
    await expect(page.getByTestId(`wa-group-${fx.keyM}`)).toHaveAttribute('aria-pressed', 'true')
    await expect(row(page, fx.rowD)).toBeVisible()

    // A target with no message group yet ⇒ no selection + the hint.
    await page.goto(composerUrl('handed_over:packeta'))
    await expect(page.getByTestId('wa-deeplink-miss')).toHaveText('Pre túto skupinu zatiaľ nie sú žiadne správy.')

    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    await page.getByTestId('board-messages').click()
    await expectQuery(page, { path: '/admin/whatsapp', cycle: String(fx.cycle.id) })
    await expect(page.getByTestId('wa-cycle-select')).toHaveValue(String(fx.cycle.id))

    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    await page.getByTestId('group-by-stage').click()
    await expect(page.getByRole('button', { name: 'Správa skupine' })).toHaveCount(0)
  })

  test('the cycle selector repaints „Komu“: an empty round shows „Zatiaľ žiadne správy vo fronte.“ and no groups; switching back restores the groups', async ({ page }) => {
    await adminLogin(page)
    await page.goto(composerUrl(fx.keyM))
    await expect(page.getByTestId(`wa-group-${fx.keyM}`)).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('wa-cycle-select').selectOption(String(fx.emptyCycle.id))
    await expect(page.getByTestId('wa-no-groups')).toHaveText('Zatiaľ žiadne správy vo fronte.')
    await expect(page.locator('[data-testid^="wa-group-handed_over"]')).toHaveCount(0)
    await page.getByTestId('wa-cycle-select').selectOption(String(fx.cycle.id))
    await expect(page.getByTestId(`wa-group-${fx.keyM}`)).toBeVisible()
    await expect(page.getByTestId('wa-no-groups')).toHaveCount(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 WA_HEALTH_URL — the bot connected
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T8 · §2 the composer against a connected bot (WA_HEALTH_URL)', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(!WA_HEALTH_URL, NEEDS_HEALTH)
  const fx = {}

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await ensureAdmin()
    const cycle = await admin('/api/cycles', { method: 'post', data: { name: `E2E WA8b ${uniq}`, type: 'coffee', status: 'open' } })
    expect(cycle.status()).toBe(201)
    fx.cycle = await cycle.json()
    const product = await admin('/api/products', { method: 'post', data: { cycle_id: fx.cycle.id, name: `WA8b Káva ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 } })
    fx.product = await product.json()
    const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `WA8b Bod ${uniq}`, address: 'Ulica', for_coffee: true, for_bakery: true } })
    fx.L = await loc.json()
    fx.R = await makeFriend('Rado', { phone: '0905 802 001' })
    const o = await ownOrder(fx.R, fx.cycle.id, [{ product_id: fx.product.id, variant: '250g', quantity: 1 }], { pickup_location_id: fx.L.id })
    await packFriend(fx.cycle.id, fx.R, o.id)
    const h = await handOver(o.id)
    fx.key = `handed_over:pickup:${fx.L.id}:${bratislavaDate(h.order.handed_over_at)}`
    expect((await admin('/api/notifications/release', { method: 'post', data: { cycle_id: fx.cycle.id, segment_key: fx.key } })).status()).toBe(200)
    fx.row = (await groupRows(fx.cycle.id, fx.key))[0]
    expect(fx.row.status).toBe('released')
    fx.paused = (await settings()).whatsappPaused
  })

  test.afterAll(async () => {
    if (!ctx) return
    if (typeof fx.paused === 'boolean') await putSettings({ whatsappPaused: fx.paused })
    // Close the released row through the product's own door (bot not connected again).
    if (fx.row) await admin(`/api/notifications/${fx.row.id}/manual-sent`, { method: 'patch', data: { sent: true } })
    if (fx.L) await admin(`/api/pickup-locations/${fx.L.id}`, { method: 'delete' })
  })

  test('connected: no banner and no „Otvoriť chat“ on a released row; paused ⇒ the banner; a tick racing a connected bot renders `bot_active` and the row stays', async ({ page }) => {
    const stop = await startHealthStub(CONNECTED)
    try {
      expect((await putSettings({ whatsappPaused: false })).status()).toBe(200)
      await adminLogin(page)
      await page.goto(`/admin/whatsapp?cycle=${fx.cycle.id}&segment=${encodeURIComponent(fx.key)}`)
      await expect(page.getByTestId(`wa-row-${fx.row.id}`)).toBeVisible()
      await page.getByTestId('wa-tab-manual').click()
      await expect(page.getByTestId('wa-offline-banner')).toHaveCount(0)
      await expect(page.getByTestId(`wa-row-${fx.row.id}`).getByTestId('wa-row-open'), 'the bot sends released rows').toHaveCount(0)

      expect((await putSettings({ whatsappPaused: true })).status()).toBe(200)
      await page.reload()
      await expect(page.getByTestId('wa-offline-banner'), 'connected but paused ⇒ the banner').toHaveText('Bot je odpojený — správy zostanú vo fronte. Môžete ich poslať ručne v záložke wa.me.')
      expect((await putSettings({ whatsappPaused: false })).status()).toBe(200)

      // The race: the PAGE still believes the bot is down, the server knows better.
      await page.route('**/api/admin/whatsapp/health', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ reachable: false, paused: false, opt_in: { on: 0, total: 0 } }),
      }))
      await page.reload()
      await page.getByTestId('wa-tab-manual').click()
      const r = page.getByTestId(`wa-row-${fx.row.id}`)
      await r.getByTestId('wa-row-open').click()
      await expect(r.getByTestId('wa-row-error')).toHaveText('Bot je pripojený — správu pošle bot')
      await expect(r.getByTestId('wa-row-badge')).toHaveText('Uvoľnené')
      expect((await groupRows(fx.cycle.id, fx.key))[0].status, 'the row stays released').toBe('released')
    } finally {
      await stop()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 the settings page's door for a stuck test row (WA-T7 review → WA-T8)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('WA-T8 · §3 a stuck `released` test row has a UI exit', () => {
  test.describe.configure({ mode: 'serial' })
  let saved = null
  test.beforeAll(async () => {
    await ensureAdmin()
    saved = await settings()
  })
  test.afterAll(async () => {
    if (saved && ctx) await putSettings({ whatsappTestPhone: saved.whatsappTestPhone, whatsappPaused: saved.whatsappPaused })
  })

  test('test_pending ⇒ „Uzavrieť čakajúcu testovaciu správu“ closes the pending row through the hand tick; the next test goes through', async ({ page }) => {
    test.skip(!TARGET_IS_LOCAL, NEEDS_LOCAL)
    await adminLogin(page)
    expect((await putSettings({ whatsappTestPhone: '0905 123 456' })).status()).toBe(200)
    const first = await admin('/api/admin/whatsapp/test', { method: 'post' })
    let stuckId = null
    if (first.status() === 201) stuckId = (await first.json()).id
    else {
      expect(first.status()).toBe(409)
      stuckId = (await first.json()).id
    }
    await page.goto('/admin/whatsapp/settings')
    await expect(page.getByTestId('wa-test-offline-hint'), 'no process on the gate').toHaveText('Bot nebeží — testovacia správa počká vo fronte, kým sa nespustí.')
    await page.getByTestId('wa-test-send').click()
    await expect(page.getByTestId('wa-test-error')).toHaveText('Predchádzajúca testovacia správa ešte nebola odoslaná')
    await page.getByTestId('wa-test-finalise').click()
    await expect(page.getByTestId('wa-test-ok')).toHaveText('Čakajúca testovacia správa je uzavretá — môžete poslať novú.')
    await expect(page.getByTestId('wa-test-finalise')).toHaveCount(0)

    await page.getByTestId('wa-test-send').click()
    await expect(page.getByTestId('wa-test-ok')).toHaveText('Testovacia správa je vo fronte — bot ju odošle na uložené číslo.')
    // Clean up the fresh one through the same door (API), so no released test row survives.
    const again = await admin('/api/admin/whatsapp/test', { method: 'post' })
    expect(again.status()).toBe(409)
    const pending = (await again.json()).id
    expect(pending).toBeGreaterThan(stuckId)
    expect((await admin(`/api/notifications/${pending}/manual-sent`, { method: 'patch', data: { sent: true } })).status()).toBe(200)
  })
})
