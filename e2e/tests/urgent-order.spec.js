// „Som na suchu!" (PO 2026-10-09) — the friend's urgent-delivery wish.
//
// The friend flags THEIR submitted order from the „Hotovo!" modal
// (`components/DryOrderCard.vue`, design: Claude Design „Som na suchu.html"), the server
// stores it as `orders.urgent_at` through ONE friend route
// (`PATCH /api/orders/cycle/:cycleId/friend/:friendId/urgent`), and the admin sees the
// order tinted light red with a „Na suchu" badge on the orders tab AND on /distribution.
//
// ⚠ A WISH, NOT MONEY: every toggle below is bracketed by a ledger row count — the
// route writes `urgent_at` and nothing else.
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { gotoCycle } from '../helpers/portal.js'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''
const admin = makeAdmin({ ctx: () => ctx, token: () => adminToken, adopt: (t) => { adminToken = t }, timeout: TIMEOUT })

let seq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++seq}`
  const username = `dry_${label}`.slice(0, 30 - suffix.length) + suffix
  const name = `Suchár ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
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
  const res = await admin('/api/cycles', { method: 'post', data: { name: `E2E Sucho ${label} ${uniq}`, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  const product = await admin('/api/products', {
    method: 'post', data: { cycle_id: cycle.id, name: `Sucho kava ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10 },
  })
  expect(product.status(), 'product create').toBe(201)
  if (status !== 'open') await setCycleStatus(cycle.id, status)
  return { ...cycle, product: await product.json() }
}

async function setCycleStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status(), `cycle → ${status}`).toBe(200)
}

async function saveCart(cycle, friend) {
  const res = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
    headers: friend.auth, data: { items: [{ product_id: cycle.product.id, variant: '250g', quantity: 1 }] },
  })
  expect(res.status(), 'cart saved').toBe(200)
}

async function submit(cycle, friend) {
  await saveCart(cycle, friend)
  const res = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, { headers: friend.auth, data: {} })
  expect(res.status(), 'order submitted').toBe(200)
  return (await res.json()).order
}

function setUrgent(cycle, friend, data, headers = friend.auth) {
  return ctx.patch(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/urgent`, { headers, data })
}

async function storedUrgentAt(cycle, friend) {
  const res = await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, { headers: friend.auth })
  expect(res.status()).toBe(200)
  return (await res.json()).order?.urgent_at ?? null
}

// The friend's own ledger read (a friend route — an admin token is not identity).
async function ledgerCount(friend) {
  const res = await ctx.get(`/api/transactions/friend/${friend.id}`, { headers: friend.auth })
  expect(res.status()).toBe(200)
  const body = await res.json()
  return (Array.isArray(body) ? body : body.transactions || []).length
}

async function signInAs(page, friend) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: friend.id, friendName: friend.name, token: friend.token, expiresAt: Date.now() + 86_400_000 }))
}

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  // ONE admin token app-wide: the browser's login rotated it, so adopt it.
  adminToken = await page.evaluate(() => localStorage.getItem('adminToken'))
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, timeout: TIMEOUT })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

// ═══════════════════════════════════════════════════════════════════════════
// 1. The route
// ═══════════════════════════════════════════════════════════════════════════
test.describe('PATCH …/urgent — the one writer of orders.urgent_at', () => {
  let cycle, friend, other, drafter
  test.beforeAll(async () => {
    cycle = await makeCycle('api')
    friend = await makeFriend('api')
    other = await makeFriend('cudzi')
    drafter = await makeFriend('draft')
    await submit(cycle, friend)
    await saveCart(cycle, drafter)
  })

  test('flag → a timestamp; flag again → the SAME timestamp; unflag → null — and no ledger row', async () => {
    const ledgerBefore = await ledgerCount(friend)
    expect(await storedUrgentAt(cycle, friend), 'starts unflagged').toBeNull()

    const on = await setUrgent(cycle, friend, { urgent: true })
    expect(on.status()).toBe(200)
    const first = (await on.json()).order.urgent_at
    expect(first, 'a timestamp is stored').toBeTruthy()
    expect(await storedUrgentAt(cycle, friend)).toBe(first)

    const again = await setUrgent(cycle, friend, { urgent: true })
    expect(again.status()).toBe(200)
    expect((await again.json()).order.urgent_at, 're-flagging keeps the FIRST moment').toBe(first)

    const off = await setUrgent(cycle, friend, { urgent: false })
    expect(off.status()).toBe(200)
    expect((await off.json()).order.urgent_at).toBeNull()
    expect(await storedUrgentAt(cycle, friend)).toBeNull()

    expect(await ledgerCount(friend), 'a wish is not money').toBe(ledgerBefore)
  })

  test('urgent is a STRICT boolean — every other shape is a 400 and writes nothing', async () => {
    expect((await setUrgent(cycle, friend, { urgent: true })).status()).toBe(200)
    const stored = await storedUrgentAt(cycle, friend)
    for (const data of [{}, { urgent: 1 }, { urgent: 'true' }, { urgent: null }, [true], 'abc', true]) {
      const res = await setUrgent(cycle, friend, data)
      expect(res.status(), `body ${JSON.stringify(data)}`).toBe(400)
    }
    expect(await storedUrgentAt(cycle, friend), 'the refused bodies left the flag alone').toBe(stored)
    expect((await setUrgent(cycle, friend, { urgent: false })).status()).toBe(200)
  })

  test('only the order’s own friend may flag it (SEC-A3), and never anonymously', async () => {
    const foreign = await setUrgent(cycle, friend, { urgent: true }, other.auth)
    expect(foreign.status(), 'another friend’s session').toBe(403)
    const anon = await setUrgent(cycle, friend, { urgent: true }, {})
    expect(anon.status(), 'no credential at all').toBe(401)
    const asAdmin = await setUrgent(cycle, friend, { urgent: true }, { 'X-Admin-Token': adminToken })
    expect(asAdmin.status(), 'an admin token is not friend identity').toBe(401)
    expect(await storedUrgentAt(cycle, friend), 'none of them wrote').toBeNull()
  })

  test('a DRAFT is not an order yet, and no order at all is not one either (409)', async () => {
    const draft = await setUrgent(cycle, drafter, { urgent: true })
    expect(draft.status()).toBe(409)
    expect((await draft.json()).reason).toBe('not_submitted')
    expect(await storedUrgentAt(cycle, drafter)).toBeNull()

    const none = await setUrgent(cycle, other, { urgent: true })
    expect(none.status()).toBe(409)
    expect((await none.json()).reason).toBe('not_submitted')
  })

  test('a LOCKED round still accepts it; a COMPLETED one is history (409)', async () => {
    const c = await makeCycle('stavy')
    const f = await makeFriend('stavy')
    await submit(c, f)
    await setCycleStatus(c.id, 'locked')
    expect((await setUrgent(c, f, { urgent: true })).status(), 'locked: the admin is still packing').toBe(200)

    await setCycleStatus(c.id, 'completed')
    const done = await setUrgent(c, f, { urgent: false })
    expect(done.status()).toBe(409)
    expect((await done.json()).reason).toBe('cycle_closed')
    expect(await storedUrgentAt(c, f), 'the completed round kept its flag').toBeTruthy()
  })

  test('the admin payloads carry it: the orders tab and /distribution', async () => {
    expect((await setUrgent(cycle, friend, { urgent: true })).status()).toBe(200)

    const orders = await admin(`/api/orders/cycle/${cycle.id}`)
    expect(orders.status()).toBe(200)
    const row = (await orders.json()).find((o) => o.friend_id === friend.id)
    expect(row.urgent_at, 'orders tab row').toBeTruthy()

    const dist = await admin(`/api/cycles/${cycle.id}/distribution`)
    expect(dist.status()).toBe(200)
    const body = await dist.json()
    const parties = Array.isArray(body) ? body : body.distribution || body.parties || []
    const party = parties.find((p) => p.kind === 'friend' && p.id === friend.id)
    expect(party, 'the friend is a distribution party').toBeTruthy()
    expect(party.urgent_at, 'distribution party').toBeTruthy()

    expect((await setUrgent(cycle, friend, { urgent: false })).status()).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. The friend's „Hotovo!" card
// ═══════════════════════════════════════════════════════════════════════════
test.describe('„Hotovo!" — the „Som na suchu!" card', () => {
  let cycle, friend
  test.beforeAll(async () => {
    cycle = await makeCycle('ui')
    friend = await makeFriend('ui')
    await saveCart(cycle, friend)
  })

  test('send → the card asks; „Som na suchu!" records the wish; „Zrušiť" takes it back', async ({ page }) => {
    // `[]` = no pickup points, so „Odoslať" lands straight on „Hotovo!" (payment-links idiom).
    await page.route('**/api/pickup-locations*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await signInAs(page, friend)
    await gotoCycle(page, cycle.id)
    await page.locator('.app .cartbar').getByRole('button', { name: 'Odoslať' }).click()

    const d = page.getByRole('dialog')
    await expect(d).toContainText('Hotovo!')
    const card = d.getByTestId('dry-card')
    await expect(card).toHaveAttribute('data-on', 'false')
    await expect(card).toContainText('Dochádza vám káva?')

    await card.getByRole('button', { name: 'Som na suchu!' }).click()
    await expect(card).toHaveAttribute('data-on', 'true')
    await expect(card).toContainText('Ste na suchu — beriem na vedomie.')
    expect(await storedUrgentAt(cycle, friend), 'the server has it, not only the screen').toBeTruthy()

    await card.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(card).toHaveAttribute('data-on', 'false')
    expect(await storedUrgentAt(cycle, friend)).toBeNull()
  })

  test('a refused request leaves the card unflagged and says so', async ({ page }) => {
    await page.route('**/api/pickup-locations*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.route('**/urgent', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Chyba servera"}' }))
    await signInAs(page, friend)
    await gotoCycle(page, cycle.id)
    await page.locator('.app .cartbar').getByRole('button', { name: /Odoslať|Aktualizovať/ }).click()

    const card = page.getByRole('dialog').getByTestId('dry-card')
    await card.getByRole('button', { name: 'Som na suchu!' }).click()
    await expect(card.getByRole('alert')).toBeVisible()
    await expect(card, 'no optimistic „beriem na vedomie"').toHaveAttribute('data-on', 'false')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. The admin sees it: light red + „Na suchu"
// ═══════════════════════════════════════════════════════════════════════════
test.describe('admin — the urgent order stands out', () => {
  let cycle, dry, calm
  test.beforeAll(async () => {
    cycle = await makeCycle('admin')
    dry = await makeFriend('nasuchu')
    calm = await makeFriend('pokoj')
    await submit(cycle, dry)
    await submit(cycle, calm)
    expect((await setUrgent(cycle, dry, { urgent: true })).status()).toBe(200)
  })

  test('orders tab: the urgent row is tinted and badged, the calm one is not', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    const urgentRow = page.locator('tr[data-urgent="true"]')
    await expect(urgentRow).toHaveCount(1)
    await expect(urgentRow).toContainText(dry.name)
    await expect(urgentRow).toHaveClass(/bg-red-50/)
    await expect(page.getByTestId(`urgent-badge-${dry.id}`)).toHaveText('Na suchu')

    const calmRow = page.locator('tr').filter({ hasText: calm.name }).first()
    await expect(calmRow).toHaveAttribute('data-urgent', 'false')
    await expect(page.getByTestId(`urgent-badge-${calm.id}`)).toHaveCount(0)
  })

  test('/distribution: the urgent bag is tinted and badged, the calm one is not', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycle.id}/distribution`)

    const urgentBag = page.getByTestId(`bag-row-${dry.id}`)
    await expect(urgentBag).toHaveAttribute('data-urgent', 'true')
    await expect(urgentBag).toHaveClass(/bg-red-50/)
    await expect(page.getByTestId(`bag-urgent-badge-${dry.id}`)).toHaveText('Na suchu')

    await expect(page.getByTestId(`bag-row-${calm.id}`)).toHaveAttribute('data-urgent', 'false')
    await expect(page.getByTestId(`bag-urgent-badge-${calm.id}`)).toHaveCount(0)
  })
})
