import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// DP-T5 — module 16 (distribution pipeline), 16 §UC-DP-010.
//
// THE BOARD SHELL: the plan header, the plan cards, the group-by segmented
// control, the stage filter, and the group headers. Everything INSIDE a group is
// still the shipped per-friend card (DP-T6 converts card → row), which is why
// `guest-distribution.spec.js` must keep passing UNMODIFIED alongside this file.
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

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

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

  test('the shipped per-friend card body is still the row (DP-T6 converts it)', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // The card locator `guest-distribution.spec.js` uses must still resolve to
    // EXACTLY ONE element — a wrapper that also carried `p-4` would break that
    // shipped file in strict mode without failing anything here.
    const card = page.locator('div.p-4', { has: page.getByRole('heading', { name: fx.b.name, exact: true }) })
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('button', { name: 'Zabaliť' })).toBeVisible()
    await expect(card.locator('[data-owner="own"]')).toHaveCount(1)
    await expect(page.getByTestId(`dist-pickup-select-${fx.b.id}`)).toBeVisible()
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
// ⚠ Not reachable from DP-T5's own screen (nothing here re-fetches after a pickup
// change); it becomes reachable with DP-T6's patch-in-place-then-re-fetch. Closed
// here because this row owns the focus. The re-fetch is driven through the ONE
// door this row already has: „Zabaliť" calls `loadData()`.
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
