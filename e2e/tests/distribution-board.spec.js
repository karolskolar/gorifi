import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// DP-T5 — module 16 (distribution pipeline), 16 §UC-DP-010.
//
// THE BOARD SHELL: the plan header, the plan cards, the group-by segmented
// control, the stage filter, and the group headers. What is INSIDE a group is
// ~~still the shipped per-friend card (DP-T6 converts card → row)~~ — **DP-T6
// shipped the row (16 §UC-DP-011); its five columns, the nested guest mirrors and
// the expandable body are pinned in `distribution-rows.spec.js`.** This file keeps
// only the cross-spec guard at the bottom, because `guest-distribution.spec.js`
// and `item-packed.spec.js` still pass UNMODIFIED and still locate a party by
// utility class.
//
// What carries this file:
//
//  1. ⚠ **THE PLAN COMES FROM THE SERVER.** `plan[]` / `totals` are DP-T2's, and
//     the two-tone bar only adds up because `packed_count` is a SUPERSET of
//     `handed_count` (handed implies packed). The bar is therefore
//     `handed/count` + `(packed − handed)/count`, and both shares are published
//     on the DOM as `data-share` so the proportions are assertable rather than
//     eyeballed. The fixture below has one card at 100 % handed and one at 50 %
//     packed-not-handed precisely so a bar that (say) used `packed/count` for the
//     second segment would be wrong by a measurable amount.
//
//  2. ⚠ **„Odovzdať zabalené (n)" COUNTS `stage === 'packed'` ONLY.** A bag that is
//     already handed over is NOT ready — it is done. The Packeta group in the
//     fixture holds exactly one handed-over bag and nothing else, so a button that
//     counted „packed_count" (the superset) would read „(1)" and be enabled there.
//     It must read „(0)" and be DISABLED. ⚠ The click is deliberately NOT exercised:
//     DP-T7 owns the confirm modal and the POST, and this row ships the button
//     disabled-at-zero with no handler.
//
//  3. ⚠ **EMPTY GROUPS ARE A FEATURE, AND ONLY UNDER „Všetko".** A configured,
//     active pickup point with nobody on it gets a zero card and a „Nič v tejto
//     skupine." group, because the admin cannot otherwise tell „no bags there"
//     from „that point is not set up". Under any other stage filter an empty group
//     is hidden — otherwise filtering to „Odovzdané" shows a page of empty boxes.
//
//  4. ⚠ **NON-VACUITY.** Every absence assertion here is preceded by the matching
//     presence assertion on the same locator family (the focus test counts groups
//     BEFORE focusing; the filter test names a row that must stay). A selector
//     typo otherwise proves „hidden" for free.
//
//  5. ⚠ **CROSS-SPEC HYGIENE** — `pickup_locations` is GLOBAL and every active row
//     becomes a zero-count plan card and an empty group in EVERY cycle, including
//     other specs'. So this file retires its own locations in `afterAll` (the
//     DP-T2 idiom) and never asserts a TOTAL group count under „Všetko" — only
//     counts that leaked locations cannot move (a focused group, the three stage
//     groups, the single friend group, and a filter that hides everything empty).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `dp5_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `DP5 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
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

async function makeCycle(label, patch = null) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E DP5 ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  if (patch) {
    const upd = await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: patch })
    expect(upd.status(), 'cycle patch').toBe(200)
    return upd.json()
  }
  return cycle
}

async function addProduct(cycleId) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId, name: `DP5 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let locationSeq = 0
async function makeLocation(label) {
  const res = await admin('/api/pickup-locations', {
    method: 'post',
    data: {
      name: `DP5 ${label} ${uniq}${++locationSeq}`, address: `Boardova ${locationSeq}`,
      for_coffee: true, for_bakery: true,
    },
  })
  expect(res.status(), 'pickup location create').toBe(201)
  return res.json()
}

async function ownOrder(friend, cycleId, items, submitBody) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth, data: submitBody, timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

async function payload(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return res.json()
}

const partyOf = (body, friendId) => body.distribution.find((p) => p.id === friendId)

/** Tick every item WITHOUT flipping the whole-order flag — i.e. open the gate. */
async function checkAllItems(cycleId, friendId) {
  const body = await payload(cycleId)
  const party = partyOf(body, friendId)
  for (const item of party.items) {
    if (item.packed) continue
    expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
}

/** Check every item, then flip the whole-order flag. */
async function packParty(cycleId, friendId, orderId) {
  await checkAllItems(cycleId, friendId)
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status()).toBe(200)
}

/** The admin's pickup correction, keyed on (cycle, friend) — never an order id. */
async function setPickup(cycleId, friendId, locationId) {
  const res = await admin(`/api/orders/cycle/${cycleId}/friend/${friendId}/pickup`, {
    method: 'patch', data: { pickup_location_id: locationId },
  })
  expect(res.status(), 'pickup correction').toBe(200)
}

async function handOverOrder(orderId) {
  const res = await admin(`/api/orders/${orderId}/handed-over`, {
    method: 'patch', data: { handed_over: true },
  })
  expect(res.status(), 'hand over').toBe(200)
}

// ⚠ ONE ADMIN TOKEN APP-WIDE (CLAUDE.md §Auth). Every `loginAsAdminUI()` mints a
// new one and INVALIDATES the API context's — so any API call made after a UI
// test in this file (the fixture teardown, notably) 401s unless the token is
// re-taken. Measured on the first red run: the location cleanup answered 401.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// The OTHER way round, and the one to use when a test drives the API and the page
// ALTERNATELY: take the token the browser is already holding instead of minting a
// new one, so the page's own requests keep working afterwards.
async function adoptBrowserToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the browser is logged in').toBeTruthy()
  adminToken = token
}

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  expect(adminToken).toBeTruthy()
})

test.afterAll(async () => { await ctx?.dispose() })

// ─────────────────────────────────────────────────────────────────────────────
// The board fixture (one cycle, four parties across three targets + one empty
// point), chosen so every derived number differs from every other:
//
//   Packeta  — friend P, 250 g, PACKED then HANDED OVER   → 1 bag, 1 packed, 1 handed
//   loc L    — friend A, 2 × 250 g, PACKED                → 2 bags, 1 packed, 0 handed
//              friend B, 1 × 1 kg,  untouched
//   loc Z    — active for coffee, nobody on it            → 0 bags
//   Osobne   — friend I, 250 g, untouched                 → 1 bag, 0 packed, 0 handed
//
//   totals: 4 balíčky · 2 zabalené · 1 odovzdaný
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T5 · 16 §UC-DP-010 — the distribution board shell', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Board', { parcel_enabled: true, parcel_fee: 3.9 })
    fx.product = await addProduct(fx.cycle.id)
    fx.L = await makeLocation('Miesto L')
    fx.Z = await makeLocation('Miesto Z')

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    fx.packeta = await makeFriend('Packeta')
    fx.packetaOrder = await ownOrder(fx.packeta, fx.cycle.id, line('250g', 1), {
      use_parcel_delivery: true, packeta_address: 'Packeta Ruzinov, Bratislava',
    })

    fx.a = await makeFriend('Ancka')
    fx.aOrder = await ownOrder(fx.a, fx.cycle.id, line('250g', 2), { pickup_location_id: fx.L.id })

    fx.b = await makeFriend('Bela')
    fx.bOrder = await ownOrder(fx.b, fx.cycle.id, line('1kg', 1), { pickup_location_id: fx.L.id })

    fx.inPerson = await makeFriend('Osobne')
    fx.inPersonOrder = await ownOrder(fx.inPerson, fx.cycle.id, line('250g', 1), {
      pickup_location_note: 'Vyzdvihnem si osobne',
    })

    // Packeta: packed AND handed over. loc L's Ancka: packed only.
    await packParty(fx.cycle.id, fx.packeta.id, fx.packetaOrder.id)
    await handOverOrder(fx.packetaOrder.id)
    await packParty(fx.cycle.id, fx.a.id, fx.aOrder.id)
  })

  // `pickup_locations` is global; a leftover active row cards up on every other
  // spec's cycle too (measured on DP-T2). Retire them.
  test.afterAll(async () => {
    await refreshAdminToken()
    for (const loc of [fx.L, fx.Z]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('the fixture is the shape the board is asserted against', async () => {
    const body = await payload(fx.cycle.id)
    expect(body.totals).toEqual({ count: 4, packed_count: 2, handed_count: 1 })
    const plan = Object.fromEntries(body.plan.map((entry) => [entry.target_key, entry]))
    expect(plan.packeta).toMatchObject({ count: 1, packed_count: 1, handed_count: 1, kg: 250 })
    expect(plan[`loc${fx.L.id}`]).toMatchObject({ count: 2, packed_count: 1, handed_count: 0, kg: 1500 })
    expect(plan[`loc${fx.Z.id}`]).toMatchObject({ count: 0, packed_count: 0, handed_count: 0 })
    expect(plan.in_person).toMatchObject({ count: 1, packed_count: 0, handed_count: 0, kg: 250 })
  })

  test('title block: the plan heading and the totals line, declined', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await expect(page.getByTestId('board-title')).toHaveText('Distribúcia plán')
    // 4 → „balíčky" (2–4), 2 → „zabalené", 1 → „odovzdaný". A single-branch
    // implementation gets at least one of these three wrong.
    await expect(page.getByTestId('board-totals'))
      .toHaveText('4 balíčky · 2 zabalené · 1 odovzdaný')
  })

  test('a plan card per target, including the active point nobody is on', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const packeta = page.getByTestId('plan-card-packeta')
    await expect(packeta).toBeVisible()
    await expect(packeta.getByTestId('plan-count-packeta')).toHaveText('1')
    await expect(packeta.getByTestId('plan-line-packeta')).toContainText('1/1 zabal.')
    await expect(packeta.getByTestId('plan-line-packeta')).toContainText('1/1 odovzd.')
    await expect(packeta.getByTestId('plan-line-packeta')).toContainText('0.25 kg')

    const loc = page.getByTestId(`plan-card-loc${fx.L.id}`)
    await expect(loc).toBeVisible()
    await expect(loc).toContainText(fx.L.name)
    await expect(loc.getByTestId(`plan-count-loc${fx.L.id}`)).toHaveText('2')
    await expect(loc.getByTestId(`plan-line-loc${fx.L.id}`)).toContainText('1/2 zabal.')
    await expect(loc.getByTestId(`plan-line-loc${fx.L.id}`)).toContainText('0/2 odovzd.')
    await expect(loc.getByTestId(`plan-line-loc${fx.L.id}`)).toContainText('1.5 kg')

    // ⚠ The point of the whole plan header: „nobody is going there" is a REAL
    // answer, and it is different from „that point is not configured".
    const zero = page.getByTestId(`plan-card-loc${fx.Z.id}`)
    await expect(zero, 'an active point with no bags still gets a card').toBeVisible()
    await expect(zero.getByTestId(`plan-count-loc${fx.Z.id}`)).toHaveText('0')

    await expect(page.getByTestId('plan-card-in_person')).toBeVisible()
    await expect(page.getByTestId('plan-count-in_person')).toHaveText('1')
  })

  test('the progress bar is two-tone: handed, then packed-not-handed', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // Packeta: 1/1 handed ⇒ the handed segment is the whole bar and the packed
    // segment is EMPTY. (`packed_count` is a superset — a second segment drawn
    // from `packed/count` would read 100 here and overflow the bar.)
    await expect(page.getByTestId('plan-bar-handed-packeta')).toHaveAttribute('data-share', '100')
    await expect(page.getByTestId('plan-bar-packed-packeta')).toHaveAttribute('data-share', '0')

    // loc L: 0/2 handed, 1/2 packed ⇒ 0 + 50.
    await expect(page.getByTestId(`plan-bar-handed-loc${fx.L.id}`)).toHaveAttribute('data-share', '0')
    await expect(page.getByTestId(`plan-bar-packed-loc${fx.L.id}`)).toHaveAttribute('data-share', '50')

    // Osobne: nothing done at all.
    await expect(page.getByTestId('plan-bar-handed-in_person')).toHaveAttribute('data-share', '0')
    await expect(page.getByTestId('plan-bar-packed-in_person')).toHaveAttribute('data-share', '0')

    // A zero-count card divides by nothing and must still render a bar at 0.
    await expect(page.getByTestId(`plan-bar-handed-loc${fx.Z.id}`)).toHaveAttribute('data-share', '0')
    await expect(page.getByTestId(`plan-bar-packed-loc${fx.Z.id}`)).toHaveAttribute('data-share', '0')
  })

  test('clicking a plan card focuses its group, clicking again releases it', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const groups = page.locator('[data-testid^="dist-group-"]')
    // ⚠ `count()` does NOT auto-wait — take it only once the board has rendered,
    // or the non-vacuity gate below measures an empty page and "proves" nothing.
    await expect(page.getByTestId('dist-group-packeta')).toBeVisible()
    // ⚠ NON-VACUITY: prove there is more than one group to hide BEFORE hiding them.
    const before = await groups.count()
    expect(before, 'more than one group before focusing').toBeGreaterThan(1)

    await page.getByTestId(`plan-card-loc${fx.L.id}`).click()
    await expect(groups, 'exactly one group survives the focus').toHaveCount(1)
    await expect(page.getByTestId(`dist-group-loc${fx.L.id}`)).toBeVisible()
    await expect(page.getByTestId(`plan-card-loc${fx.L.id}`)).toHaveAttribute('data-focused', 'true')

    await page.getByTestId(`plan-card-loc${fx.L.id}`).click()
    await expect(page.getByTestId(`plan-card-loc${fx.L.id}`)).toHaveAttribute('data-focused', 'false')
    await expect(groups).toHaveCount(before)
  })

  test('a plan card click also switches the grouping, and changing it clears the focus', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await page.getByTestId('group-by-friend').click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)

    // Clicking a card from „Podľa priateľa" must pull the grouping back to delivery.
    await page.getByTestId(`plan-card-loc${fx.L.id}`).click()
    await expect(page.getByTestId(`dist-group-loc${fx.L.id}`)).toBeVisible()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)

    // …and choosing a grouping releases the focus rather than keeping one group.
    await page.getByTestId('group-by-stage').click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(3)
    await expect(page.getByTestId(`plan-card-loc${fx.L.id}`)).toHaveAttribute('data-focused', 'false')
  })

  test('grouping: by delivery, by stage, by friend', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const heading = (name) => page.getByRole('heading', { name, exact: true })
    const inGroup = (key, name) => page.getByTestId(`dist-group-${key}`).getByRole('heading', { name, exact: true })

    // ── Podľa doručenia (the default) ──
    await expect(page.getByTestId('group-by-delivery')).toHaveAttribute('data-active', 'true')
    await expect(inGroup('packeta', fx.packeta.name)).toBeVisible()
    await expect(inGroup(`loc${fx.L.id}`, fx.a.name)).toBeVisible()
    await expect(inGroup(`loc${fx.L.id}`, fx.b.name)).toBeVisible()
    await expect(inGroup('in_person', fx.inPerson.name)).toBeVisible()
    // The empty point renders its own „nothing here" line under „Všetko".
    await expect(page.getByTestId(`dist-group-loc${fx.Z.id}`)).toBeVisible()
    await expect(page.getByTestId(`group-empty-loc${fx.Z.id}`)).toHaveText('Nič v tejto skupine.')

    // ── Podľa stavu — exactly three groups, each party in exactly one ──
    await page.getByTestId('group-by-stage').click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(3)
    await expect(inGroup('to_pack', fx.b.name)).toBeVisible()
    await expect(inGroup('to_pack', fx.inPerson.name)).toBeVisible()
    await expect(inGroup('packed', fx.a.name)).toBeVisible()
    await expect(inGroup('handed', fx.packeta.name)).toBeVisible()
    // …and NOT in another one. (`heading` above proves the name renders at all,
    // so these absences are not vacuous.)
    await expect(heading(fx.a.name)).toHaveCount(1)
    await expect(page.getByTestId('dist-group-to_pack').getByRole('heading', { name: fx.a.name, exact: true })).toHaveCount(0)
    await expect(page.getByTestId('dist-group-handed').getByRole('heading', { name: fx.a.name, exact: true })).toHaveCount(0)

    // ── Podľa priateľa — one group, „Všetci", everybody in it ──
    await page.getByTestId('group-by-friend').click()
    const all = page.getByTestId('dist-group-all')
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)
    await expect(all).toContainText('Všetci')
    for (const name of [fx.packeta.name, fx.a.name, fx.b.name, fx.inPerson.name]) {
      await expect(all.getByRole('heading', { name, exact: true })).toBeVisible()
    }
  })

  test('the stage filter applies to parties and hides the groups it empties', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await expect(page.getByTestId('stage-filter-all')).toHaveAttribute('data-active', 'true')
    // NON-VACUITY: all four are on the page before anything is filtered away.
    for (const name of [fx.packeta.name, fx.a.name, fx.b.name, fx.inPerson.name]) {
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    }

    await page.getByTestId('stage-filter-handed').click()
    await expect(page.getByRole('heading', { name: fx.packeta.name, exact: true })).toBeVisible()
    for (const name of [fx.a.name, fx.b.name, fx.inPerson.name]) {
      await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0)
    }
    // Every emptied group is GONE — including the zero-count point, which only
    // earns its „Nič v tejto skupine." line under „Všetko".
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)
    await expect(page.getByTestId('dist-group-packeta')).toBeVisible()

    await page.getByTestId('stage-filter-to_pack').click()
    await expect(page.getByRole('heading', { name: fx.b.name, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: fx.inPerson.name, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: fx.packeta.name, exact: true })).toHaveCount(0)
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(2)

    await page.getByTestId('stage-filter-all').click()
    await expect(page.getByRole('heading', { name: fx.packeta.name, exact: true })).toBeVisible()
  })

  test('group header: badge, counts, the labels placeholder, and the hand-over button', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const locKey = `loc${fx.L.id}`
    const group = page.getByTestId(`dist-group-${locKey}`)
    await expect(group.getByRole('heading', { name: fx.L.name, exact: true })).toBeVisible()
    await expect(group, 'the point’s address is the group sub-line').toContainText('Boardova')
    // 2 bags ⇒ „balíčky"; the abbreviated counts carry no declension.
    await expect(page.getByTestId(`group-badge-${locKey}`)).toHaveText('2 balíčky')
    await expect(page.getByTestId(`group-counts-${locKey}`)).toHaveText('1 zabal. · 0 odovzd.')

    await expect(page.getByTestId('group-badge-packeta')).toHaveText('1 balíček')
    await expect(page.getByTestId('group-counts-packeta')).toHaveText('1 zabal. · 1 odovzd.')

    // ⚠ The labels feature (F7) is built elsewhere and the PO has not supplied its
    // route: the button is a placeholder carrying ONE constant, and it does not
    // navigate anywhere yet.
    const labels = page.getByTestId(`labels-group-${locKey}`)
    await expect(labels).toBeVisible()
    await expect(labels).toHaveText('Štítky')
    await expect(labels).toBeDisabled()
    await expect(labels).toHaveAttribute('data-labels-route', /.+/)

    // ⚠ NO „Správa skupine" anywhere — module 21 adds it (resolved conflict 3).
    await expect(page.getByRole('button', { name: 'Správa skupine' })).toHaveCount(0)
  })

  test('„Odovzdať zabalené (n)": n is the PACKED parties, and 0 disables it', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // loc L holds one packed bag (Ancka) and one untouched one (Bela).
    const ready = page.getByTestId(`handover-group-loc${fx.L.id}`)
    await expect(ready).toHaveText('Odovzdať zabalené (1)')
    await expect(ready).toBeEnabled()

    // ⚠ Packeta's only bag is already HANDED OVER. `packed_count` includes it, so a
    // button reading the superset would say „(1)" and be clickable — re-handing a
    // bag that has left. It is done, not ready.
    const handed = page.getByTestId('handover-group-packeta')
    await expect(handed).toHaveText('Odovzdať zabalené (0)')
    await expect(handed).toBeDisabled()

    // Osobne holds one bag that is not packed yet.
    const notPacked = page.getByTestId('handover-group-in_person')
    await expect(notPacked).toHaveText('Odovzdať zabalené (0)')
    await expect(notPacked).toBeDisabled()

    // An empty group has nothing to hand over either.
    await expect(page.getByTestId(`handover-group-loc${fx.Z.id}`)).toBeDisabled()

    // Under „Podľa stavu" the „Zabalené" group's button is every packed bag in the
    // cycle — here exactly Ancka.
    await page.getByTestId('group-by-stage').click()
    await expect(page.getByTestId('handover-group-packed')).toHaveText('Odovzdať zabalené (1)')
    await expect(page.getByTestId('handover-group-packed')).toBeEnabled()
    await expect(page.getByTestId('handover-group-handed')).toBeDisabled()
    await expect(page.getByTestId('handover-group-to_pack')).toBeDisabled()
  })

  // ⚠ A focus and a stage filter select INDEPENDENTLY, so their intersection can be
  // empty. Which of the two should win is a semantics call §UC-DP-010 does not
  // settle — so the board neither guesses nor renders a toolbar over nothing: it
  // says what happened. DP-T7's confirm modal reads the same list, which is why an
  // unexplained empty view here would become an unexplained „(0)" there.
  test('a focus plus a filter can select nothing — and the board says so', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // ⚠ NON-VACUITY: there ARE parties, and this one is in the group about to be
    // focused. Without this the „no match" line below would also pass on a board
    // that simply failed to load.
    await expect(
      page.getByTestId(`dist-group-loc${fx.L.id}`).getByRole('heading', { name: fx.a.name, exact: true })
    ).toBeVisible()

    await page.getByTestId(`plan-card-loc${fx.L.id}`).click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)

    // loc L holds one packed and one to-pack bag, and NOTHING handed over.
    await page.getByTestId('stage-filter-handed').click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(0)
    await expect(page.getByTestId('board-empty'), 'the CYCLE is not empty — the view is').toHaveCount(0)
    await expect(page.getByTestId('board-no-match'))
      .toHaveText('Tomuto výberu nezodpovedá žiadny balíček. Zmeňte filter alebo zoskupenie.')

    // Releasing either half brings the board back.
    await page.getByTestId('stage-filter-all').click()
    await expect(page.getByTestId('board-no-match')).toHaveCount(0)
    await expect(page.getByTestId(`dist-group-loc${fx.L.id}`)).toBeVisible()
  })

  // ⚠ RETARGETED BY DP-T6 (16 §UC-DP-011): a group's parties are ROWS now, not
  // per-friend cards, so this pin no longer says "the card body is still the
  // placeholder". What it guards is unchanged and is the reason DP-T6 did NOT
  // retarget the two shipped specs that locate a party by utility class:
  //
  //   • `div.p-4` containing the friend's heading must resolve to EXACTLY ONE
  //     element (`guest-distribution.spec.js`, `item-packed.spec.js` — and only the
  //     FIRST of those two is retargetable at all, so the invariant had to hold);
  //   • `div.cursor-pointer` inside a party must be the ITEM rows and nothing else
  //     (`item-packed.spec.js` COUNTS them) — which is why the row's own expand
  //     affordance is a `<button>` plus a `.row-expand` class, never a third
  //     `div.cursor-pointer`;
  //   • the party's name stays an `<h3>`, because every group assertion in this
  //     file locates a row by `getByRole('heading')`.
  //
  // The row's own five columns are pinned in `distribution-rows.spec.js`; this
  // test is the cross-spec guard, kept here because it is the shape a future
  // refactor of THIS view would silently break.
  test('a row keeps the one `p-4` and the item-row class the shipped specs locate it by', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.b.id}`)
    await expect(row, 'the party is a row now (16 §UC-DP-011)').toBeVisible()

    const card = page.locator('div.p-4', { has: page.getByRole('heading', { name: fx.b.name, exact: true }) })
    await expect(card, 'a second padded wrapper would break two shipped specs').toHaveCount(1)
    await expect(card.getByRole('button', { name: 'Zabaliť' })).toBeVisible()
    await expect(card.locator('[data-owner="own"]')).toHaveCount(1)
    // ⚠ NON-VACUITY first: the row HAS one item, and that item is the only
    // `div.cursor-pointer` in it.
    await expect(card.locator('div.cursor-pointer')).toHaveCount(1)
    await expect(page.getByTestId(`dist-pickup-select-${fx.b.id}`)).toBeVisible()

    // The five columns, by the testids §UC-DP-011 names.
    await expect(row.getByTestId(`bag-who-${fx.b.id}`)).toBeVisible()
    await expect(row.getByTestId(`bag-delivery-${fx.b.id}`)).toBeVisible()
    await expect(row.getByTestId(`bag-pay-${fx.b.id}`)).toBeVisible()
    await expect(row.getByTestId(`packed-toggle-${fx.b.id}`)).toBeVisible()
    await expect(row.getByTestId(`handover-toggle-${fx.b.id}`)).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The other end of the range: a cycle with nothing in it at all.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T5 · 16 §UC-DP-010 — an empty cycle', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Prazdny')
    fx.E = await makeLocation('Miesto E')
  })

  test.afterAll(async () => {
    if (!fx.E) return
    await refreshAdminToken()
    const res = await admin(`/api/pickup-locations/${fx.E.id}`, { method: 'delete' })
    expect([204, 404], 'fixture location retired').toContain(res.status())
  })

  test('zero plan cards, zero totals, and one muted line instead of groups', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await expect(page.getByTestId('board-totals'))
      .toHaveText('0 balíčkov · 0 zabalených · 0 odovzdaných')

    // The configured point still cards up — at 0.
    await expect(page.getByTestId(`plan-card-loc${fx.E.id}`)).toBeVisible()
    await expect(page.getByTestId(`plan-count-loc${fx.E.id}`)).toHaveText('0')
    // Packeta and Osobne are not configurable places: no bag goes that way, no card.
    await expect(page.getByTestId('plan-card-packeta')).toHaveCount(0)
    await expect(page.getByTestId('plan-card-in_person')).toHaveCount(0)

    await expect(page.getByTestId('board-empty')).toHaveText('Zatiaľ nie je čo distribuovať.')
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(0)
    // The empty CYCLE is not the empty VIEW — only one of the two lines renders.
    await expect(page.getByTestId('board-no-match')).toHaveCount(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A FOCUS OUTLIVING ITS TARGET.
//
// The focus is a local `ref`; `plan[]` is the server's. Move the last party off a
// pickup point and retire the point, and the focused key is simply not in the next
// payload — the delivery branch then filters to ZERO groups while `distribution`
// is not empty. Without the guard in `loadData()` the board would sit on the „no
// match" line with no focused card left to click to release it.
//
// ⚠ ~~Not reachable from DP-T5's own screen (nothing here re-fetches after a
// pickup change); it becomes reachable with DP-T6's patch-in-place-then-re-fetch.~~
// **REACHABLE AS OF DP-T6**, which added exactly that re-fetch — the guard closed
// here is now load-bearing on the pickup path too (`distribution-rows.spec.js`
// drives the pickup change). This test keeps driving the re-fetch through
// „Zabaliť" because that door needs no location change to exercise the guard.
//
// ⚠ The API half of this test adopts the BROWSER's admin token rather than minting
// one — a fresh `/api/admin/login` would invalidate the page's own token and the
// „Zabaliť" click below would 401 instead of re-fetching.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T5 · 16 §UC-DP-010 — a focused target that leaves the plan', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    await refreshAdminToken()
    fx.cycle = await makeCycle('Fokus')
    fx.product = await addProduct(fx.cycle.id)
    fx.M = await makeLocation('Miesto M')
    fx.N = await makeLocation('Miesto N')

    const line = [{ product_id: fx.product.id, variant: '250g', quantity: 1 }]
    fx.x = await makeFriend('Xena')
    fx.xOrder = await ownOrder(fx.x, fx.cycle.id, line, { pickup_location_id: fx.M.id })
    fx.y = await makeFriend('Yveta')
    fx.yOrder = await ownOrder(fx.y, fx.cycle.id, line, { pickup_location_id: fx.N.id })

    // Every item ticked but the order NOT packed: „Zabaliť" is enabled, so the
    // test has a re-fetch it can trigger from the page.
    await checkAllItems(fx.cycle.id, fx.x.id)
  })

  test.afterAll(async () => {
    await refreshAdminToken()
    for (const loc of [fx.M, fx.N]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('the focus is released when its target is gone from the next payload', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const mCard = page.getByTestId(`plan-card-loc${fx.M.id}`)
    await expect(mCard, 'the point exists before anything moves').toBeVisible()
    await mCard.click()
    await expect(page.locator('[data-testid^="dist-group-"]')).toHaveCount(1)
    await expect(page.getByTestId(`dist-group-loc${fx.M.id}`)).toBeVisible()

    // Behind the screen's back: the last party leaves M, and M is retired. Nothing
    // references it any more, so this really deletes the row.
    await setPickup(fx.cycle.id, fx.x.id, fx.N.id)
    expect((await admin(`/api/pickup-locations/${fx.M.id}`, { method: 'delete' })).status()).toBe(204)

    // The one re-fetch this row offers. (The card is still rendered from the stale
    // payload, which is exactly the situation the guard is for.)
    await page.getByTestId(`dist-group-loc${fx.M.id}`)
      .getByRole('button', { name: 'Zabaliť', exact: true }).click()

    // ⚠ These three discriminate: without the guard `focusedTarget` stays `locM`,
    // the delivery branch yields no group at all, and the board shows „no match"
    // with N's group missing.
    await expect(page.getByTestId(`dist-group-loc${fx.N.id}`), 'the board is back').toBeVisible()
    await expect(page.getByTestId('board-no-match')).toHaveCount(0)
    await expect(mCard, 'the retired point is off the plan').toHaveCount(0)

    // …and both parties are now where they belong, under N.
    const nGroup = page.getByTestId(`dist-group-loc${fx.N.id}`)
    await expect(nGroup.getByRole('heading', { name: fx.x.name, exact: true })).toBeVisible()
    await expect(nGroup.getByRole('heading', { name: fx.y.name, exact: true })).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DP-T8 — 16 §UC-DP-014 (+ §UC-DP-010 item 1): the admin cycle header.
//
// Three things, and the third is the one that distinguishes a UX gate from a rule:
//
//  1. ⚠ **THE PLAN LINE IS NON-BLOCKING AND SUMMARY-SHAPED.** It renders on
//     `CycleDetail` for a `locked` OR `completed` cycle from the same
//     `GET /cycles/:id/distribution` the board reads, and — unlike the plan CARDS —
//     it OMITS zero-count targets. An active point nobody is on is information on
//     the board (where the admin plans) and noise in a one-line summary. The test
//     gates that absence on the payload actually carrying the zero-count entry, so
//     a selector typo cannot prove it for free.
//
//  2. ⚠ **THE GATE IS THE INTERFACE'S, NOT THE SERVER'S** (PO decision 2026-09-19,
//     §UC-DP-014). „Ukončiť objednávku" is disabled until `totals.count > 0` and
//     every party is handed over — and the API keeps accepting
//     `PATCH /cycles/:id { status: 'completed' }` with un-handed bags, because a bag
//     that will never be collected must not be able to freeze a cycle open. Both
//     halves are asserted; asserting only the button would leave the escape hatch
//     free to be "fixed" into a 409 by the next reader of this module.
//
//  3. ⚠ **THE BUTTON IS THE ONLY WRITER OF `status`.** No hand-over path writes it
//     (pinned in `distribution-handover.spec.js`), so completing a round is an
//     explicit human act on either header. And it is ledger-neutral: the snapshot
//     around the click is per-friend (`/friends/:id/detail`), never a global count.
// ─────────────────────────────────────────────────────────────────────────────
async function ledgerSnapshot(friendIds) {
  const out = {}
  for (const id of friendIds) {
    const res = await admin(`/api/friends/${id}/detail`)
    expect(res.status(), 'friend detail').toBe(200)
    const body = await res.json()
    out[id] = { count: (body.transactions || []).length, balance: body.balance }
  }
  return out
}

async function lockCycle(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status: 'locked' } })
  expect(res.status(), 'cycle lock').toBe(200)
}

test.describe('DP-T8 · 16 §UC-DP-014 — the cycle header: plan line + „Ukončiť objednávku"', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    await refreshAdminToken()
    fx.cycle = await makeCycle('Hlavicka')
    fx.product = await addProduct(fx.cycle.id)
    fx.H = await makeLocation('Miesto H')
    // Active for this cycle's type and nobody on it: a zero-count plan CARD that
    // must NOT reach the one-line summary.
    fx.Q = await makeLocation('Miesto Q')

    const line = [{ product_id: fx.product.id, variant: '250g', quantity: 1 }]
    fx.h1 = await makeFriend('Hana')
    fx.h1Order = await ownOrder(fx.h1, fx.cycle.id, line, { pickup_location_id: fx.H.id })
    fx.h2 = await makeFriend('Hugo')
    fx.h2Order = await ownOrder(fx.h2, fx.cycle.id, line, { pickup_location_note: 'Osobne' })

    // Both packed, neither handed over — the „3 z 5" state the use case describes.
    await packParty(fx.cycle.id, fx.h1.id, fx.h1Order.id)
    await packParty(fx.cycle.id, fx.h2.id, fx.h2Order.id)
    await lockCycle(fx.cycle.id)

    // A second, single-party cycle for the BOARD's copy of the button (the shared
    // header: the same gate, the same write, a different view).
    fx.solo = await makeCycle('Hlavicka Board')
    fx.soloProduct = await addProduct(fx.solo.id)
    fx.s1 = await makeFriend('Sona')
    fx.s1Order = await ownOrder(fx.s1, fx.solo.id, [
      { product_id: fx.soloProduct.id, variant: '250g', quantity: 1 },
    ], { pickup_location_id: fx.H.id })
    await packParty(fx.solo.id, fx.s1.id, fx.s1Order.id)
    await handOverOrder(fx.s1Order.id)
    await lockCycle(fx.solo.id)

    // An empty locked cycle: `totals.count === 0` must keep the button shut.
    fx.empty = await makeCycle('Hlavicka Prazdna')
    await lockCycle(fx.empty.id)
  })

  test.afterAll(async () => {
    await refreshAdminToken()
    for (const loc of [fx.H, fx.Q]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('the locked cycle header carries the plan line; zero-count targets are omitted', async ({ page }) => {
    // NON-VACUITY: the omission below only means something because the payload
    // really does carry the empty point as a plan entry.
    const body = await payload(fx.cycle.id)
    const zero = body.plan.find((entry) => entry.target_key === `loc${fx.Q.id}`)
    expect(zero, 'the empty point IS in plan[]').toMatchObject({ count: 0 })
    expect(body.totals).toEqual({ count: 2, packed_count: 2, handed_count: 0 })

    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}`)

    const planLine = page.getByTestId('cycle-plan-line')
    await expect(planLine).toBeVisible()
    await expect(planLine).toHaveText(`${fx.H.name} 1 · Osobne 1 — 0/2 odovzdaných`)
    await expect(planLine, 'a point nobody is on is not in the summary')
      .not.toContainText(fx.Q.name)
  })

  test('„Označiť ako dokončený" is gone; „Ukončiť objednávku" is disabled while a bag is out', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}`)

    await expect(page.getByRole('button', { name: 'Označiť ako dokončený' })).toHaveCount(0)
    const finish = page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })
    await expect(finish).toBeVisible()
    await expect(finish).toBeDisabled()
    await expect(finish).toHaveAttribute('title', 'Až keď je všetko odovzdané')
  })

  test('an empty locked cycle keeps the button shut and shows no plan line', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.empty.id}`)

    await expect(page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })).toBeDisabled()
    await expect(page.getByTestId('cycle-plan-line'), 'nothing to plan, nothing to say')
      .toHaveCount(0)
  })

  test('the board header: the status sub, the labels button, the same disabled gate', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await expect(page.getByTestId('board-appbar-sub')).toHaveText('· uzamknuté')
    // ⚠ SANCTIONED EDIT, delivery merge 2026-09-29: F7 (order-labels-pdf) landed, so the
    // header button is WIRED to the whole-cycle sheet; only the per-group „Štítky" stay
    // placeholders. The click itself is exercised at the end of this test.
    const labels = page.getByRole('button', { name: 'Vytlačiť štítky', exact: true })
    await expect(labels).toBeVisible()
    await expect(labels).toBeEnabled()

    const finish = page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })
    await expect(finish).toBeDisabled()
    await expect(finish).toHaveAttribute('title', 'Až keď je všetko odovzdané')

    // The same plan line as the cycle header, from the same `plan[]`.
    await expect(page.getByTestId('cycle-plan-line'))
      .toHaveText(`${fx.H.name} 1 · Osobne 1 — 0/2 odovzdaných`)

    // …and „Vytlačiť štítky" opens the whole-cycle label sheet.
    await labels.click()
    await expect(page).toHaveURL(new RegExp(`/admin/cycle/${fx.cycle.id}/labels$`))
  })

  // ⚠ RECORDED BY DP-T7, FIXED HERE (it is one token in a SHARED primitive, which
  // that row rightly declined to touch under a board row). `DialogContent.vue` is
  // what every admin modal renders through, and it carried no print rule at all —
  // so a packing sheet printed with any dialog open came out under the `bg-black/80`
  // dim layer, with the modal stamped across page one. The board is the right place
  // to pin it: this page IS the print sheet.
  test('an open dialog never reaches the printed sheet — neither its dim layer nor its box', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    await page.getByTestId(`handover-group-loc${fx.H.id}`).click()
    const dialog = page.getByTestId('handover-dialog')
    const overlay = page.locator('div.fixed.inset-0.bg-black\\/80')
    // NON-VACUITY: on screen both really are there. Without this the print
    // assertions below would pass against a typo'd selector.
    await expect(dialog).toBeVisible()
    await expect(overlay).toBeVisible()

    await page.emulateMedia({ media: 'print' })
    await expect(overlay, 'the dim layer would grey the whole sheet').toBeHidden()
    await expect(dialog, 'and the box would land on page one').toBeHidden()
    await page.emulateMedia({ media: 'screen' })

    // Leave the fixture exactly as the next test needs it: nothing handed over.
    await expect(dialog).toBeVisible()
    await page.getByTestId('handover-cancel').click()
    await expect(dialog).toBeHidden()
    expect((await payload(fx.cycle.id)).totals.handed_count, 'the dialog was cancelled').toBe(0)
  })

  // ⚠ FAIL-CLOSED, on a bar nobody would notice was lying (recorded by DP-T5). The
  // packed-not-handed segment is `packed_count − handed_count`, which is only ever
  // non-negative because the SERVER guarantees `packed_count` is a superset. The
  // payload is therefore forged here — there is no way to reach this state through
  // the API, and that is the point: if the invariant ever broke, an unclamped width
  // would be dropped silently by CSS and the bar would look merely "less packed".
  test('a payload that breaks the packed⊇handed invariant cannot produce a negative bar', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)

    await page.route(`**/api/cycles/${fx.cycle.id}/distribution`, async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      for (const entry of body.plan) {
        if (entry.target_key !== `loc${fx.H.id}`) continue
        entry.count = 2
        entry.packed_count = 0   // ← the impossible half
        entry.handed_count = 1
      }
      await route.fulfill({ response, json: body })
    })

    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    const packed = page.getByTestId(`plan-bar-packed-loc${fx.H.id}`)
    await expect(packed).toHaveAttribute('data-share', '0')
    // The honest half still renders, so the clamp is not hiding the whole bar.
    await expect(page.getByTestId(`plan-bar-handed-loc${fx.H.id}`)).toHaveAttribute('data-share', '50')
    await page.unroute(`**/api/cycles/${fx.cycle.id}/distribution`)
  })

  test('every bag handed over enables the button; the click completes the cycle, ledger untouched', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}`)
    await expect(page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })).toBeDisabled()

    await handOverOrder(fx.h1Order.id)
    await handOverOrder(fx.h2Order.id)

    const before = await ledgerSnapshot([fx.h1.id, fx.h2.id])

    await page.reload()
    const finish = page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })
    await expect(finish, 'the gate opens on the last hand-over').toBeEnabled()
    await finish.click()

    // The cycle really is completed — read back from the API, not from the badge.
    await expect(page.getByText('Dokončený', { exact: true }).first()).toBeVisible()
    const after = await admin(`/api/cycles/${fx.cycle.id}`)
    expect(after.status()).toBe(200)
    expect((await after.json()).status).toBe('completed')

    // The plan line survives the completion — the round stays readable afterwards.
    await expect(page.getByTestId('cycle-plan-line'))
      .toHaveText(`${fx.H.name} 1 · Osobne 1 — 2/2 odovzdaných`)
    // …and the button is gone: `completed` is not a state you complete again.
    await expect(page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })).toHaveCount(0)

    // Stage 3 is ledger-neutral, and so is the completion itself.
    expect(await ledgerSnapshot([fx.h1.id, fx.h2.id])).toEqual(before)
  })

  test('the board header sub reads „· ukončené" once the cycle is completed', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    await expect(page.getByTestId('board-appbar-sub')).toHaveText('· ukončené')
    await expect(page.getByTestId('cycle-plan-line'))
      .toHaveText(`${fx.H.name} 1 · Osobne 1 — 2/2 odovzdaných`)
  })

  test('the board carries the same writer: enabled there, and the click completes', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.solo.id}/distribution`)

    const finish = page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })
    await expect(finish, 'its one bag is already handed over').toBeEnabled()
    await finish.click()

    await expect(page.getByTestId('board-appbar-sub')).toHaveText('· ukončené')
    const after = await admin(`/api/cycles/${fx.solo.id}`)
    expect((await after.json()).status).toBe('completed')
  })

  // ⚠ THE STALE-MESSAGE CLASS, ONE SCOPE UP (review finding, DP-T8). `loadAll()` /
  // `loadData()` deliberately do NOT clear the page banner on success — they also
  // run on failure paths — so a completion handler that does not clear it before
  // trying leaves a red Alert standing over a cycle that IS now completed. Both
  // handlers clear it; this pins the CycleDetail one.
  test('a failed completion does not leave its banner over the successful retry', async ({ page }) => {
    await refreshAdminToken()
    const cycle = await makeCycle('Hlavicka Banner')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('Zita')
    const order = await ownOrder(friend, cycle.id, [
      { product_id: product.id, variant: '250g', quantity: 1 },
    ], { pickup_location_note: 'Osobne' })
    await packParty(cycle.id, friend.id, order.id)
    await handOverOrder(order.id)
    await lockCycle(cycle.id)

    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${cycle.id}`)

    // Exactly ONE refusal, then the real server again.
    let refuseOnce = true
    await page.route(`**/api/cycles/${cycle.id}`, async (route) => {
      if (route.request().method() === 'PATCH' && refuseOnce) {
        refuseOnce = false
        return route.fulfill({
          status: 500, contentType: 'application/json',
          body: JSON.stringify({ error: 'Servris spadol' }),
        })
      }
      await route.continue()
    })

    const finish = page.getByRole('button', { name: 'Ukončiť objednávku', exact: true })
    await expect(finish, 'its one bag is handed over').toBeEnabled()
    await finish.click()
    // NON-VACUITY: the banner really is there before the retry clears it.
    await expect(page.getByRole('alert')).toContainText('Servris spadol')

    await finish.click()
    const after = await admin(`/api/cycles/${cycle.id}`)
    expect((await after.json()).status, 'the retry went through').toBe('completed')
    await expect(page.getByRole('alert'), 'no red line over a completed cycle').toHaveCount(0)
    await page.unroute(`**/api/cycles/${cycle.id}`)
  })

  // ⚠ THE PLAN LINE IS THE SERVER'S GROUPING, NOT LOCAL KNOWLEDGE. The orders tab
  // patches a pickup change into its row in place (the 33-row table is not reloaded),
  // which is right for the row and wrong for the header: the party has just moved
  // between targets. Deleting the re-fetch leaves the line naming the target the
  // party left — so this test reads the line BEFORE and AFTER, with no reload.
  test('a pickup change on the orders tab moves the plan line without a reload', async ({ page }) => {
    await refreshAdminToken()
    const cycle = await makeCycle('Hlavicka Presun')
    const product = await addProduct(cycle.id)
    const line = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const stays = await makeFriend('Petra')
    await ownOrder(stays, cycle.id, line, { pickup_location_id: fx.H.id })
    const moves = await makeFriend('Radka')
    await ownOrder(moves, cycle.id, line, { pickup_location_note: 'Osobne' })
    await lockCycle(cycle.id)

    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycle.id}`)
    await expect(page.getByTestId('cycle-plan-line'))
      .toHaveText(`${fx.H.name} 1 · Osobne 1 — 0/2 odovzdaných`)

    await page.getByRole('tab', { name: 'Objednávky' }).click()
    await page.getByTestId(`pickup-select-${moves.id}`).selectOption(String(fx.H.id))

    await expect(page.getByTestId('cycle-plan-line'), 'the header followed the party')
      .toHaveText(`${fx.H.name} 2 — 0/2 odovzdaných`)
  })

  // ⚠⚠ THE PO'S DECISION, AND THE ONLY ASSERTION THAT SEPARATES A UX GATE FROM A
  // RULE (§UC-DP-014, PO 2026-09-19: „Server-side completion gate = NONE"). If a
  // later reader adds the 409 that looks so obviously right, this test — not a
  // comment — is what says no.
  test('the API still completes a cycle with un-handed bags (the escape hatch)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('Hlavicka Escape')
    const product = await addProduct(cycle.id)
    const friend = await makeFriend('Eva')
    await ownOrder(friend, cycle.id, [
      { product_id: product.id, variant: '250g', quantity: 1 },
    ], { pickup_location_note: 'Osobne' })
    await lockCycle(cycle.id)

    const before = await payload(cycle.id)
    expect(before.totals, 'nothing is handed over').toMatchObject({ count: 1, handed_count: 0 })

    const res = await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'completed' } })
    expect(res.status(), 'no server-side hand-over gate').toBe(200)
    expect((await res.json()).status).toBe('completed')

    // Read the row back (the refusal-test idiom, applied to a NON-refusal): the
    // cycle is completed and the bag is still out, which is exactly the state the
    // escape hatch exists to allow.
    const readBack = await admin(`/api/cycles/${cycle.id}`)
    expect((await readBack.json()).status).toBe('completed')
    const after = await payload(cycle.id)
    expect(after.totals).toMatchObject({ count: 1, handed_count: 0 })
    expect(after.distribution.find((p) => p.id === friend.id).handed_over_at).toBeNull()
  })
})
