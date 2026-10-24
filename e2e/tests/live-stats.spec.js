// PO 2026-10-04 — what the coffee statistics count (live dashboard „Živý prehľad",
// the „Káva" tab, and the dashboard cycle card).
//
//  1. TIERS: friends always pay 30 % off retail; the operator buys at 30 % from 5 kg
//     (no margin), 35 % from 25 kg and 40 % from 50.0 kg (was 5→30 / 26→35 / 51→40).
//     Backend + view mirror EQUAL.
//  2. VOLUME (`volumeKg`): capsules (20pc5g) and brew bags (8pc12g) are priced per
//     pack outside the kg tiers — they are not tier volume. Physical weight
//     (`variantToKg`) is untouched for rewards / catalog / distribution.
//  3. MARGIN = value friends AND guests paid for tier-volume coffee × (1 − (1 − tier)
//     / 0.70): no capsules/brew bags. October 2026 measured 259.18 under the old
//     whole-value basis; the tier-volume value gives 255.78 (a first cut counted
//     friends only, 179.54 — corrected by the PO the same day).
//  4. AVERAGE per PERSON = tier volume / (friends + guest sub-orders), 2 decimals
//     (it was friend kilos / friends rounded to 1 decimal: 1.04 printed „1.00").
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ANALYTICS_URL = 'file://' + join(REPO_ROOT, 'backend', 'src', 'helpers', 'analytics.js')
const TIERS_URL = 'file://' + join(REPO_ROOT, 'frontend', 'src', 'lib', 'coffee-tiers.js')

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

test.describe('pure helpers (direct import — helpers/analytics.js imports nothing)', () => {
  test('the view mirror of the tiers is EQUAL to the backend', async () => {
    const backend = await import(ANALYTICS_URL)
    const view = await import(TIERS_URL)
    expect(view.COFFEE_TIERS).toEqual(backend.TIER_THRESHOLDS)
    expect(backend.TIER_THRESHOLDS).toEqual([
      { minKg: 50, discount: 0.40, label: '40%' },
      { minKg: 25, discount: 0.35, label: '35%' },
      { minKg: 5, discount: 0.30, label: '30%' },
    ])
    expect(view.TIER_30_KG).toBe(5)
    expect(view.TIER_35_KG).toBe(25)
    expect(view.TIER_40_KG).toBe(50)
  })

  test('volumeKg drops capsules and brew bags; variantToKg keeps their weight', async () => {
    const m = await import(ANALYTICS_URL)
    expect(m.volumeKg('20pc5g', 3)).toBe(0)
    expect(m.volumeKg('8pc12g', 2)).toBe(0)
    expect(m.volumeKg('1kg', 2)).toBe(2)
    expect(m.volumeKg('250g', 4)).toBe(1)
    expect(m.variantToKg('20pc5g', 3), 'physical weight unchanged').toBeCloseTo(0.3, 10)
    expect(m.variantToKg('8pc12g', 1)).toBeCloseTo(0.096, 10)
  })

  test('tiers and margin: none under 5 kg, 30 % from 5, 35 % from 25, 40 % from 50; October 2026 = 255.78', async () => {
    const m = await import(ANALYTICS_URL)
    expect(m.getTier(4.9)).toBeNull()
    expect(m.getTier(5).label).toBe('30%')
    expect(m.getTier(24.9).label).toBe('30%')
    expect(m.getTier(25).label).toBe('35%')
    expect(m.getTier(49.9).label).toBe('35%')
    expect(m.getTier(50).label, 'exactly 50.0 kg is already 40 %').toBe('40%')
    expect(m.computeMargin(100, 4.9)).toBe(0)
    expect(m.computeMargin(700, 24.9), 'the 30 % tier buys at the friends\' price — no margin').toBe(0)
    expect(m.computeMargin(700, 30)).toBeCloseTo(50, 10) // 700 × (1 − 0.65/0.70)
    // The measured case: Goriffee beans of friends (1256.77) + guests (533.70) at 51.4 kg.
    expect(Math.round(m.computeMargin(1790.47, 51.4) * 100) / 100).toBe(255.78)
  })
})

test.describe('the live dashboard, the Káva tab and the cycle card agree', () => {
  let ctx
  let adminToken = ''
  // FUP-T27 / WA-T12: the ONE admin request path (`helpers/admin.js makeAdmin`) — re-authenticates once on a 401
  // and publishes the fresh token back into `adminToken` (was a private `adminReq` copy, §5 of admin-token-retry).
  const adminReq = makeAdmin({
    ctx: () => ctx,
    token: () => adminToken,
    adopt: (t) => { adminToken = t },
    timeout: TIMEOUT,
  })
  let cycle

  test.beforeAll(async () => {
    ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
    expect(login.status()).toBe(200)
    adminToken = (await login.json()).token

    // A friend with a session.
    const username = `stats_${uniq}`.slice(0, 30)
    const f = await (await adminReq('/api/friends', { method: 'post', data: { name: `Stats ${uniq}`, phone: '0900 000 002' } })).json()
    expect((await adminReq(`/api/friends/${f.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
    expect((await adminReq(`/api/friends/${f.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
    const auth = await (await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })).json()
    const changed = await (await ctx.put(`/api/friends/${f.id}/change-password`, {
      headers: { Authorization: `Bearer ${auth.token}` }, data: { currentPassword: 'initPass1', newPassword: 'ownPass12' }, timeout: TIMEOUT,
    })).json()
    const friendAuth = { Authorization: `Bearer ${changed.token || auth.token}` }

    // The newest OPEN coffee cycle (the live dashboard's singleton), markup 1.0 so
    // the paid prices equal the catalogue numbers below.
    const c = await adminReq('/api/cycles', { method: 'post', data: { name: `E2E STATS ${uniq}`, type: 'coffee', status: 'open' } })
    expect(c.status()).toBe(201)
    cycle = await c.json()
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1 } })).status()).toBe(200)
    const prod = async (data) => {
      const r = await adminReq('/api/products', { method: 'post', data: { cycle_id: cycle.id, purpose: 'Espresso', ...data } })
      expect(r.status()).toBe(201)
      return r.json()
    }
    const beans = await prod({ name: `Stats zrnka ${uniq}`, price_1kg: 20 })
    const caps = await prod({ name: `Stats kapsule ${uniq}`, price_20pc5g: 10 })
    const bags = await prod({ name: `Stats bags ${uniq}`, price_8pc12g: 11 })

    // Friend: 30 kg of beans + 3 capsule packs + 2 brew-bag packs.
    const items = [
      { product_id: beans.id, variant: '1kg', quantity: 30 },
      { product_id: caps.id, variant: '20pc5g', quantity: 3 },
      { product_id: bags.id, variant: '8pc12g', quantity: 2 },
    ]
    expect((await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${f.id}`, { headers: friendAuth, data: { items }, timeout: TIMEOUT })).status()).toBe(200)
    expect((await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${f.id}/submit`, { headers: friendAuth, data: {}, timeout: TIMEOUT })).status()).toBe(200)

    // A guest through the friend's link: 1 kg + 1 capsule pack.
    const link = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: friendAuth, timeout: TIMEOUT })
    const token = (await link.json()).link.token
    const g = await ctx.post(`/api/guest/${token}/orders`, {
      data: { guest_name: 'Stats Host', guest_phone: '0917 000 111', items: [
        { product_id: beans.id, variant: '1kg', quantity: 1 },
        { product_id: caps.id, variant: '20pc5g', quantity: 1 },
      ] },
      timeout: TIMEOUT,
    })
    expect(g.status(), 'guest submit').toBe(201)
  })
  test.afterAll(async () => { await ctx?.dispose() })

  test('live: volume without packs, margin on friends\' beans, average per person', async () => {
    const body = await (await adminReq('/api/analytics/live-cycle')).json()
    expect(body.cycle.id, 'this file\'s cycle is the live one').toBe(cycle.id)
    const t = body.totals
    expect(t.total_kg, '30 + 1 kg — no capsules, no brew bags').toBe(31)
    expect(t.guest_kg).toBe(1)
    expect(t.tier_label).toBe('35%')
    expect(t.next_tier.minKg).toBe(50)
    // Bean value of friend (600) + guest (20) = 620 → × (1 − 0.65/0.70) = 44.29.
    expect(t.operator_margin, 'the guest kilo counts; capsules and bags do not').toBe(44.29)
    expect(t.num_friends).toBe(1)
    expect(t.num_guests).toBe(1)
    expect(t.avg_kg_per_person, '31 kg / 2 people').toBe(15.5)
    // Money stays whole: 600 + 30 + 22 (friend) + 20 + 10 (guest).
    expect(t.total_value).toBe(682)
  })

  test('the Káva tab row says the same', async () => {
    // The Káva tab lists locked/completed rounds only — lock this one (the live
    // dashboard reports locked rounds too, so the card test below is unaffected).
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    const body = await (await adminReq('/api/analytics/coffee')).json()
    const row = body.cycles.find((c) => c.id === cycle.id)
    expect(row.total_kg).toBe(31)
    expect(row.operator_margin).toBe(44.29)
    expect(row.avg_kg_per_person).toBe(15.5)
    expect(row.num_guests).toBe(1)
  })

  test('the live dashboard renders the new figures', async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    adminToken = await page.evaluate(() => localStorage.getItem('adminToken')) // the UI login rotated it
    await page.goto('/admin/analytics/live')
    await expect(page.getByTestId('live-total-kg')).toHaveText('31.00')
    await expect(page.getByTestId('live-margin')).toContainText('44.29')
    await expect(page.getByTestId('live-avg-kg')).toContainText('15.50')
    await expect(page.getByTestId('live-num-guests')).toHaveText('+ 1 hosť')
    // „40% (0.4%)" was the raw fraction printed as a percentage.
    await expect(page.getByTestId('live-tier')).toHaveText('35% zlava')
  })

  test('the dashboard cycle card counts tier volume too', async () => {
    const cycles = await (await adminReq('/api/cycles')).json()
    const row = cycles.find((c) => c.id === cycle.id)
    const total = row.roastery_breakdown.reduce((s, r) => s + r.total_kg, 0)
    expect(total, 'no capsules / brew bags on the card').toBe(31)
  })
})
