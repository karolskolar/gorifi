import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// Print labels for the A4 8-up sheet (105 × 74.25 mm):
//
//   GET /api/cycles/:id/labels   — one row per physical sticker
//   /admin/cycle/:id/labels      — the print page those rows render into
//
// What carries this spec:
//
//  1. **No money reaches the sticker.** The labels are stuck onto bags handed out
//     in a group, so a neighbour reading someone else's sticker must not learn
//     what they paid. The endpoint builds each line field by field for exactly
//     this reason; the assertion here walks the WHOLE payload for any price-ish
//     key, so a future `SELECT oi.*` cannot reintroduce one quietly.
//
//  2. **The three kinds carry different fields**, because the artefacts differ: a
//     pickup label is read while packing (items, pickup point), a Packeta one is
//     an address label (e-mail + address, no items), a guest one is a colleague's
//     bag handed over by their host (`via`, the HOST's pickup point).
//
//  3. **A cancelled sub-order gets no sticker.** Same `guestOrderStatus()`
//     predicate the packing gate uses — a bare `<> 'cancelled'` would drop live
//     bags on a NULL status, which here means an unlabelled bag.
//
//  4. **The geometry is the point.** A label that measures right in CSS pixels but
//     wrong in millimetres prints misaligned and the whole sheet is wasted, so the
//     UI pass measures the rendered box against 105 × 74.25 mm and checks that a
//     9th label starts a second page.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// The backend keeps exactly ONE live admin session, so a UI login through the form
// invalidates a token captured earlier (the guest-distribution.spec.js rule).
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

let friendSeq = 0
async function makeFriend(label, extra = {}) {
  const suffix = `_${uniq}${++friendSeq}`
  const name = `Stitok ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, ...extra } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const username = `lbl_${slug}`.slice(0, 30 - suffix.length) + suffix
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

async function makeCycle(label, { parcel = false } = {}) {
  const name = `E2E Stitky ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  // Packeta submits are refused unless the CYCLE offers parcel delivery, so a
  // spec that wants a `packeta` label has to turn it on first.
  if (parcel) {
    const patch = await admin(`/api/cycles/${cycle.id}`, {
      method: 'patch',
      data: { parcel_enabled: true, parcel_fee: 4.5 },
    })
    expect(patch.status(), 'enable parcel delivery').toBe(200)
  }
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function submitOwnOrder(friend, cycleId, items, submitBody = {}) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, { headers: friend.auth, data: { items } })
  expect(put.status(), 'own cart').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth,
    data: submitBody,
  })
  expect(submit.status(), `own submit: ${await submit.text()}`).toBe(200)
  return (await submit.json()).order
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, items, identity) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function labelsFor(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/labels`)
  expect(res.status(), 'labels').toBe(200)
  return (await res.json()).labels
}

// Walks the whole payload for anything that smells like money. Deliberately a
// KEY-NAME scan rather than a field allow-list: the failure mode being guarded
// against is a column arriving that nobody thought about.
const PRICE_KEYS = /^(price|total|amount|delivery_fee|paid|balance|price_|.*_price)$/i
function priceKeysIn(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((entry, i) => priceKeysIn(entry, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      (PRICE_KEYS.test(key) ? [`${path}.${key}`] : []).concat(priceKeysIn(entry, `${path}.${key}`))
    )
  }
  return []
}

test.beforeAll(async ({ playwright }, testInfo) => {
  ctx = await playwrightRequest.newContext({
    baseURL: testInfo.project.use.baseURL,
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS === '1',
  })
  await refreshAdminToken()
})

test.afterAll(async () => {
  await ctx?.dispose()
})

test.describe('GET /api/cycles/:id/labels', () => {
  test('unknown cycle 404s, and the endpoint is admin-only', async () => {
    const missing = await admin('/api/cycles/99999999/labels')
    expect(missing.status()).toBe(404)

    const anonymous = await ctx.get('/api/cycles/1/labels')
    expect(anonymous.status(), 'no admin token').toBe(401)
  })

  test('three kinds, correct fields, guests after their host, no prices anywhere', async () => {
    const cycle = await makeCycle('kinds', { parcel: true })
    const coffee = await addProduct(cycle.id, {
      name: 'Ethiopia Aricha Washed', purpose: 'Filter', roast_type: 'Filter', price_250g: 12.5, price_1kg: 40,
    })
    const espresso = await addProduct(cycle.id, {
      name: 'Milkyway espresso blend', purpose: 'Espresso', roast_type: 'Espresso', price_250g: 11, price_1kg: 36,
    })

    // A pickup location so the label has a real place to print.
    const loc = await admin('/api/pickup-locations', { method: 'post', data: { name: `Neskolka ${uniq}`, address: 'Haanova 10' } })
    expect(loc.status(), 'pickup location create').toBe(201)
    const pickupLocationId = (await loc.json()).id

    // Alphabetical names, so the expected ORDER is unambiguous.
    const alica = await makeFriend('Alica', { phone: '0905 123 456', email: 'alica@example.test' })
    const bela = await makeFriend('Bela', { phone: '0918 774 201', email: 'bela@example.test' })

    // Alica: pickup, two items (one Espresso, one Filter → purpose-ranked).
    await submitOwnOrder(
      alica,
      cycle.id,
      [
        { product_id: espresso.id, variant: '250g', quantity: 3 },
        { product_id: coffee.id, variant: '1kg', quantity: 1 },
      ],
      { pickup_location_id: pickupLocationId }
    )

    // Bela: Packeta.
    await submitOwnOrder(
      bela,
      cycle.id,
      [{ product_id: coffee.id, variant: '250g', quantity: 2 }],
      { use_parcel_delivery: true, packeta_address: 'Z-BOX Trnava, Hlavná 17' }
    )

    // A guest under Alica, plus one that gets cancelled.
    const link = await shareLink(alica, cycle.id)
    const guest = await submitGuest(link.token, [{ product_id: coffee.id, variant: '250g', quantity: 1 }], {
      guest_name: 'Peter Maly', guest_phone: '0944 210 887', guest_email: 'peter@example.test',
    })
    const doomed = await submitGuest(link.token, [{ product_id: coffee.id, variant: '250g', quantity: 5 }], {
      guest_name: 'Zruseny Kolega', guest_phone: '0900 000 000',
    })

    const labels = await labelsFor(cycle.id)
    const mine = labels.filter((l) => [alica.name, bela.name, 'Peter Maly', 'Zruseny Kolega'].includes(l.name))

    // ---- the three kinds -----------------------------------------------------
    const pickup = mine.find((l) => l.name === alica.name)
    expect(pickup, 'pickup label present').toBeTruthy()
    expect(pickup.kind).toBe('pickup')
    expect(pickup.phone).toBe('0905 123 456')
    expect(pickup.place).toContain('Neskolka')
    expect(pickup.address).toBeNull()
    expect(pickup.email, 'a pickup label needs no e-mail').toBeNull()
    // Espresso before Filter — the distribution ordering, so screen and sticker agree.
    expect(pickup.items.map((i) => i.purpose)).toEqual(['Espresso', 'Filter'])
    expect(pickup.items.map((i) => i.quantity)).toEqual([3, 1])
    expect(pickup.items.map((i) => i.variant)).toEqual(['250g', '1kg'])

    const packeta = mine.find((l) => l.name === bela.name)
    expect(packeta, 'packeta label present').toBeTruthy()
    expect(packeta.kind).toBe('packeta')
    expect(packeta.email).toBe('bela@example.test')
    expect(packeta.address).toBe('Z-BOX Trnava, Hlavná 17')
    expect(packeta.items, 'an address label carries no items').toEqual([])

    const guestLabel = mine.find((l) => l.name === 'Peter Maly')
    expect(guestLabel, 'guest label present').toBeTruthy()
    expect(guestLabel.kind).toBe('guest')
    expect(guestLabel.via, 'guest label names its host').toBe(alica.name)
    expect(guestLabel.phone).toBe('0944 210 887')
    expect(guestLabel.place, "guest collects at the HOST's pickup point").toContain('Neskolka')
    expect(guestLabel.items).toHaveLength(1)

    // ---- a cancelled bag gets no sticker -------------------------------------
    // Present FIRST — otherwise "absent after cancel" would also pass if the
    // fixture had never produced a label at all, and the predicate would be
    // untested.
    expect(mine.map((l) => l.name), 'a live sub-order does get a sticker').toContain('Zruseny Kolega')
    // Cancelling a sub-order is the HOST's action, not the admin's (the route
    // resolves the caller through the share link), so it needs Alica's auth.
    const cancel = await ctx.delete(`/api/guest-orders/${doomed.order?.id ?? doomed.id}`, { headers: alica.auth })
    expect([200, 204], `cancel sub-order: ${await cancel.text()}`).toContain(cancel.status())
    const afterCancel = await labelsFor(cycle.id)
    expect(afterCancel.map((l) => l.name), 'a cancelled bag loses its sticker').not.toContain('Zruseny Kolega')

    // ---- guests sit immediately after their host -----------------------------
    const order = labels.map((l) => l.name)
    expect(order.indexOf('Peter Maly'), 'guest follows host').toBe(order.indexOf(alica.name) + 1)

    // ---- Packeta labels form the trailing block ------------------------------
    const lastPickupIdx = Math.max(...labels.map((l, i) => (l.kind === 'packeta' ? -1 : i)))
    const firstPacketaIdx = labels.findIndex((l) => l.kind === 'packeta')
    if (firstPacketaIdx !== -1) {
      expect(firstPacketaIdx, 'packeta labels come after every pickup label').toBeGreaterThan(lastPickupIdx)
    }

    // ---- NO MONEY ------------------------------------------------------------
    const leaked = priceKeysIn(labels)
    expect(leaked, `price-like keys leaked onto the sticker: ${leaked.join(', ')}`).toEqual([])
  })

  test('a friend with no phone on file yields a null phone, not a blank string', async () => {
    const cycle = await makeCycle('nophone')
    const product = await addProduct(cycle.id, { name: 'Kenya Rukira AA', purpose: 'Filter', roast_type: 'Filter', price_250g: 13 })
    const friend = await makeFriend('Nophone')
    await submitOwnOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const label = (await labelsFor(cycle.id)).find((l) => l.name === friend.name)
    expect(label).toBeTruthy()
    expect(label.phone, 'absent phone is null so the UI can omit the whole line').toBeNull()
  })
})

test.describe('the print page', () => {
  test('labels measure 105 × 74.25 mm and 9 of them span two pages', async ({ page }) => {
    // The UI login invalidates the API token captured in beforeAll.
    const cycle = await makeCycle('geometry')
    const product = await addProduct(cycle.id, { name: 'Brazil Caramelo', purpose: 'Espresso', roast_type: 'Espresso', price_250g: 10 })

    // 9 friends ⇒ 9 labels ⇒ 2 sheets, which is the pagination boundary.
    for (let i = 0; i < 9; i++) {
      const friend = await makeFriend(`Geo${i}`, { phone: `090${i} 000 00${i}` })
      await submitOwnOrder(friend, cycle.id, [{ product_id: product.id, variant: '250g', quantity: i + 1 }])
    }

    await page.goto('/admin/login')
    await page.fill('input[type="password"]', ADMIN_PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/admin\/dashboard/, { timeout: 15_000 })

    await page.goto(`/admin/cycle/${cycle.id}/labels`)
    const labels = page.locator('[data-testid="label"]')
    await expect(labels.first()).toBeVisible({ timeout: 15_000 })
    await expect(labels).toHaveCount(9)

    // 1 mm = 96/25.4 CSS px. The sticker is the one thing here that has to be
    // right in MILLIMETRES — a box that is correct in px and wrong in mm prints
    // misaligned and ruins the sheet.
    const MM = 96 / 25.4
    const box = await labels.first().boundingBox()
    expect(box.width).toBeCloseTo(105 * MM, 0)
    expect(box.height).toBeCloseTo(74.25 * MM, 0)

    // 9 labels ⇒ 2 sheets of 8.
    await expect(page.locator('[data-testid="sheet"]')).toHaveCount(2)

    // The 9th sits alone on sheet 2 — proof the grid breaks rather than overflowing.
    const sheet2 = page.locator('[data-testid="sheet"]').nth(1)
    await expect(sheet2.locator('[data-testid="label"]')).toHaveCount(1)
  })
})
