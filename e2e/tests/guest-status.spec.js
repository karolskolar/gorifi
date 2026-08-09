import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T4: the guest's personal status/edit URL — `GET/PUT
// /api/guest/:token/orders/:orderToken` (§UC-GSO-004) — plus the page at
// `/g/:token/o/:orderToken`.
//
// Everything here is anonymous: `ctx` carries no auth headers. The PAIR of tokens
// in the URL is the whole credential, so the two most important properties are
// (a) an order token only resolves under ITS OWN link token, and (b) the write
// half re-applies every bound and gate that the submit in GSO-T3 applies.
//
// The three lifecycle decisions this spec pins down:
//   - `cancelled` is TERMINAL (the state diagram has no cancelled → submitted
//     edge), so a PUT must not revive it → 409.
//   - empty cart ⇒ `cancelled`, total 0, and the stock it held is RELEASED.
//   - a locked cycle makes the page READ-ONLY: GET still 200s (the guest has to
//     be able to see what they ordered and pay for it), PUT 409s. That
//     asymmetry is deliberate — the product listing 410s on a locked cycle, the
//     status page must not.
//
// NOTE ON RATE LIMITS: these endpoints sit behind the shared `abuseLimiter`.
// Run the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const TOKEN_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// A friend with a real per-friend Bearer session — the host identity the
// guest-link endpoints require. Mirrors guest-order.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso4_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Peto ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
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
  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, { markup, type = 'coffee', bakeryProductIds } = {}) {
  const name = `E2E GSO4 ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type, status: 'open', ...(bakeryProductIds ? { bakery_product_ids: bakeryProductIds } : {}) },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  if (markup !== undefined) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: markup } })).status()).toBe(200)
  }
  return { ...cycle, name }
}

async function setCycleStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

const IDENTITY = { guest_name: 'Marek Hostovic', guest_phone: '0901 234 567' }

// Submit a sub-order through the GSO-T3 endpoint — the only way one is created.
async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

function statusPath(linkToken, orderToken) {
  return `/api/guest/${linkToken}/orders/${orderToken}`
}

async function getStatus(linkToken, orderToken) {
  return ctx.get(statusPath(linkToken, orderToken))
}

async function putStatus(linkToken, orderToken, data) {
  return ctx.put(statusPath(linkToken, orderToken), { data })
}

async function availability(cycleId) {
  const res = await ctx.get(`/api/products/cycle/${cycleId}/availability`)
  expect(res.status()).toBe(200)
  return await res.json()
}

async function remainingFor(cycleId, productId) {
  return (await availability(cycleId)).find((a) => a.product_id === productId)
}

// One host + open coffee cycle + one product + link, ready to submit against.
async function scenario(label, { markup, productData } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label, { markup })
  const product = await addProduct(cycle.id, {
    name: `GSO4 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30, ...productData,
  })
  const link = await shareLink(host, cycle.id)
  return { host, cycle, product, link }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('Guest status URL — GET (UC-GSO-004)', () => {
  test('returns the sub-order, its items, the flags, the cycle status and the payment info', async () => {
    const { host, cycle, product, link } = await scenario('get', { markup: 1.25 })
    const created = await submitGuest(link.token, [
      { product_id: product.id, variant: '250g', quantity: 2 },
      { product_id: product.id, variant: '1kg', quantity: 1 },
    ])

    const res = await getStatus(link.token, created.order.order_token)
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body.order.id).toBe(created.order.id)
    expect(body.order.status).toBe('submitted')
    expect(body.order.total, '2 x 12.50 + 37.50').toBe(62.5)
    expect(body.order.guest_name).toBe(IDENTITY.guest_name)
    // The flags GSO-T5 (delivered, host) and GSO-T6 (paid, admin) will toggle.
    // Until then they are displayed as 0 — this page only READS them.
    expect(body.order.paid).toBe(0)
    expect(body.order.delivered).toBe(0)
    expect(body.order.paid_at ?? null).toBeNull()
    expect(body.order.delivered_at ?? null).toBeNull()

    expect(body.cycle.id).toBe(cycle.id)
    expect(body.cycle.name).toBe(cycle.name)
    expect(body.cycle.status, 'the page needs the cycle status to decide read-only').toBe('open')
    expect(body.host.first_name, 'only the first name, as on the listing').toBe('Peto')

    const byVariant = Object.fromEntries(body.items.map((i) => [i.variant, i]))
    expect(byVariant['250g'].price, 'frozen marked-up price, not re-derived').toBe(12.5)
    expect(byVariant['250g'].quantity).toBe(2)
    expect(byVariant['250g'].product_name).toBe(product.name)
    expect(byVariant['1kg'].price).toBe(37.5)

    // Payment info so the guest can re-open the modal until it is paid
    // (Decision 1) — same reference as the confirmation screen.
    const settings = await (await ctx.get('/api/admin/payment-settings')).json()
    expect(body.payment.amount).toBe(62.5)
    expect(body.payment.reference).toBe(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    expect(body.payment.iban).toBe(settings.paymentIban)
    expect(body.payment.revolut_username).toBe(settings.paymentRevolutUsername)

    // Editable while the cycle is open — with the product grid + availability the
    // edit screen needs.
    expect(body.editable).toBe(true)
    expect(body.products.length, 'the edit grid needs the cycle products').toBeGreaterThan(0)
    expect(body.products.find((p) => p.id === product.id).price_250g, 'marked up, like the listing').toBe(12.5)
    expect(Array.isArray(body.availability)).toBe(true)

    expect(res.headers()['ratelimit-policy'] || res.headers()['ratelimit'], 'abuseLimiter must be mounted').toBeTruthy()

    // Nothing about the HOST beyond the first name leaks to the guest.
    expect(JSON.stringify(body.host)).not.toContain(host.username)
  })

  test('a valid order token does NOT resolve under a different link token', async () => {
    const a = await scenario('crossa')
    const b = await scenario('crossb')

    const orderA = await submitGuest(a.link.token, [{ product_id: a.product.id, variant: '250g', quantity: 1 }])

    // Its own link: fine.
    expect((await getStatus(a.link.token, orderA.order.order_token)).status()).toBe(200)

    // Another host's link, a real order token: must not resolve, and must not
    // leak that the order token exists.
    const crossed = await getStatus(b.link.token, orderA.order.order_token)
    expect(crossed.status(), 'the pair, not either token alone, is the credential').toBe(404)
    expect(JSON.stringify(await crossed.json())).not.toContain(orderA.order.guest_name)

    // The write half is scoped the same way.
    const crossedPut = await putStatus(b.link.token, orderA.order.order_token, {
      items: [{ product_id: b.product.id, variant: '250g', quantity: 5 }],
    })
    expect(crossedPut.status(), 'no cross-link edits').toBe(404)

    // ...and order A is untouched.
    const still = await (await getStatus(a.link.token, orderA.order.order_token)).json()
    expect(still.items.length).toBe(1)
    expect(still.order.total).toBe(10)
  })

  test('404 for an unknown order token, an unknown link token, and a blank pair', async () => {
    const { link, product } = await scenario('unknown')
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await getStatus(link.token, 'THISORDERDOESNOTEXIST')).status()).toBe(404)
    expect((await getStatus('THISLINKDOESNOTEXIST', 'THISORDERDOESNOTEXIST')).status()).toBe(404)

    const res = await getStatus(link.token, 'ZZZZZZZZZZZZZZ')
    expect(res.status()).toBe(404)
    expect((await res.json()).error, 'a Slovak explanation, not an empty body').toBeTruthy()
  })
})

test.describe('Guest status URL — editing while the cycle is open', () => {
  test('a PUT replaces the items, re-prices them from the snapshot and recomputes the total', async () => {
    const { cycle, product, link } = await scenario('edit', { markup: 1.25 })
    const second = await addProduct(cycle.id, { name: `GSO4 edit second ${uniq}`, purpose: 'Filter', price_250g: 20 })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect(created.order.total).toBe(12.5)

    const res = await putStatus(link.token, created.order.order_token, {
      items: [
        { product_id: product.id, variant: '1kg', quantity: 2 },
        { product_id: second.id, variant: '250g', quantity: 1 },
      ],
    })
    expect(res.status()).toBe(200)
    const body = await res.json()

    // 2 x 37.50 + 25.00 — markup re-applied at edit time, exactly as the submit
    // freezes it (a friend cart PUT re-prices the same way).
    expect(body.order.total).toBe(100)
    expect(body.order.status, 'a non-empty edit stays submitted').toBe('submitted')
    expect(body.items.length, 'the old 250g line is gone, not merged').toBe(2)
    const byProduct = Object.fromEntries(body.items.map((i) => [i.product_id, i]))
    expect(byProduct[product.id].variant).toBe('1kg')
    expect(byProduct[product.id].price).toBe(37.5)
    expect(byProduct[second.id].price).toBe(25)

    // Identity is frozen at submit time — an edit is items-only.
    expect(body.order.guest_name).toBe(IDENTITY.guest_name)
    expect(body.order.guest_phone).toBe(IDENTITY.guest_phone)
    expect(body.order.order_token, 'the same secret keeps working').toBe(created.order.order_token)

    // Persisted, and visible to the host at the new total.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.total).toBe(100)
    expect(reread.items.length).toBe(2)
  })

  test('the body cannot set paid, delivered, status, total or the identity through an edit', async () => {
    const { product, link } = await scenario('tamper', { markup: 1.25 })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const res = await putStatus(link.token, created.order.order_token, {
      paid: 1,
      delivered: 1,
      status: 'submitted',
      total: 999999,
      guest_name: 'Somebody Else',
      guest_phone: '0999 999 999',
      order_token: 'HACKEDTOKEN123',
      items: [{ product_id: product.id, variant: '250g', quantity: 1, price: 0.01 }],
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.paid, 'only the admin sets paid (GSO-T6)').toBe(0)
    expect(body.order.delivered, 'only the host sets delivered (GSO-T5)').toBe(0)
    expect(body.order.total, 'computed from the DB snapshot (10 * 1.25)').toBe(12.5)
    expect(body.items[0].price, 'the client price is ignored').toBe(12.5)
    expect(body.order.guest_name, 'the contact lead cannot be overwritten anonymously').toBe(IDENTITY.guest_name)
    expect(body.order.guest_phone).toBe(IDENTITY.guest_phone)
    expect(body.order.order_token).toBe(created.order.order_token)
  })

  test('the GSO-T3 bounds apply to the edit too — it is the same unauthenticated write', async () => {
    const { host, cycle, product, link } = await scenario('bounds')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const many = Array.from({ length: 101 }, () => ({ product_id: product.id, variant: '250g', quantity: 1 }))
    const overLines = await putStatus(link.token, created.order.order_token, { items: many })
    expect(overLines.status(), '101 lines is over the cap').toBe(400)
    expect((await overLines.json()).field).toBe('items')

    const overQty = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '1kg', quantity: 101 }],
    })
    expect(overQty.status(), '101 units on one line is over the cap').toBe(400)

    const absurd = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '1kg', quantity: 1000000000 }],
    })
    expect(absurd.status()).toBe(400)

    // An object where a variant/quantity belongs is a dropped line, never a 500.
    const evil = { toString: 1 }
    const badLine = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: evil, quantity: 1 }, { product_id: product.id, variant: '250g', quantity: 1 }],
    })
    expect(badLine.status()).toBe(200)
    expect((await badLine.json()).items.length, 'the junk line is dropped, the good one lands').toBe(1)

    // A product from another cycle cannot be reached through this token.
    const otherCycle = await makeCycle('boundsother')
    const foreign = await addProduct(otherCycle.id, { name: `GSO4 foreign ${uniq}`, purpose: 'Espresso', price_250g: 999 })
    const cross = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: foreign.id, variant: '250g', quantity: 1 }, { product_id: product.id, variant: '250g', quantity: 1 }],
    })
    expect(cross.status()).toBe(200)
    const crossBody = await cross.json()
    expect(crossBody.items.length).toBe(1)
    expect(crossBody.order.total, "the other cycle's 999 never entered the total").toBe(10)

    // Every rejected attempt left the order at its last good state.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.total).toBe(10)
    expect(reread.order.status).toBe('submitted')

    // And nothing absurd reached the host's view.
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.totals.total).toBe(10)
  })
})

// The seam `helpers/stock.js` built for this task: `excludeGuestOrderId`. Without
// it the sub-order being edited is counted as competing stock and blocks itself.
test.describe('Guest status URL — stock limits on edit', () => {
  test('an edit excludes the sub-order being edited, but still cannot go over the limit', async () => {
    const { cycle, product, link } = await scenario('stockedit', {
      productData: { stock_limit_g: 1000 },
    })

    // The guest takes the WHOLE limit: 4 x 250g = 1000g.
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 4 }])
    expect((await remainingFor(cycle.id, product.id)).remaining_g).toBe(0)

    // Re-PUT the very same cart. Counting this sub-order against itself would
    // make 1000 + 1000 > 1000 and refuse an edit that changes nothing.
    const same = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 4 }],
    })
    expect(same.status(), 'a sub-order must not block its own edit').toBe(200)
    expect((await same.json()).order.total).toBe(40)

    // Swapping variants inside the same limit is fine too (1 x 1kg = 1000g).
    const swapped = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '1kg', quantity: 1 }],
    })
    expect(swapped.status()).toBe(200)
    expect((await remainingFor(cycle.id, product.id)).ordered_g).toBe(1000)

    // But going OVER is still refused — the exclusion is not a bypass.
    const over = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '1kg', quantity: 2 }],
    })
    expect(over.status(), '2kg against a 1kg limit').toBe(400)
    expect((await over.json()).error).toContain('limit')

    // Refused ⇒ unchanged.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.items.length).toBe(1)
    expect(reread.items[0].variant).toBe('1kg')
    expect((await remainingFor(cycle.id, product.id)).ordered_g).toBe(1000)
  })

  test('another guest\'s items still count against an edit (only the edited one is excluded)', async () => {
    const { cycle, product, link } = await scenario('stockother', {
      productData: { stock_limit_g: 1000 },
    })

    const mine = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }], {
      guest_name: 'Zuzka', guest_phone: '0902 111 222',
    })
    expect((await remainingFor(cycle.id, product.id)).ordered_g, '250 + 750').toBe(1000)

    // 750g is still taken by the OTHER sub-order, so I can grow to 250g only.
    const over = await putStatus(link.token, mine.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 2 }],
    })
    expect(over.status(), "another guest's grams are not excluded").toBe(400)

    const fits = await putStatus(link.token, mine.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
    })
    expect(fits.status()).toBe(200)
  })
})

test.describe('Guest status URL — cancelling (empty cart ⇒ cancelled)', () => {
  test('an empty cart cancels the sub-order, zeroes the total and RELEASES its stock', async () => {
    const { host, cycle, product, link } = await scenario('cancel', {
      productData: { stock_limit_g: 1000 },
    })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect((await remainingFor(cycle.id, product.id)).remaining_g).toBe(500)

    const res = await putStatus(link.token, created.order.order_token, { items: [] })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.status, 'the task row: empty cart ⇒ cancelled').toBe('cancelled')
    expect(body.order.total, 'a cancelled sub-order owes nothing').toBe(0)
    // The lines are KEPT: they are the host's and the admin's record of what was
    // ordered and then called off, and the `cancelled` status — which GSO-T7/T8/T9
    // must filter on regardless — is what excludes the sub-order everywhere.
    expect(body.items.length, 'the record of what was cancelled survives').toBe(1)
    expect(body.items[0].quantity).toBe(2)
    expect(body.editable, 'cancelled is terminal — the page goes read-only').toBe(false)

    // The whole point of cancelling: the stock it held comes back, so somebody
    // else can buy it. The item rows are still there, so this ALSO proves the
    // release comes from the `<> 'cancelled'` status predicate in helpers/stock.js
    // and not from the rows having been deleted.
    const after = await remainingFor(cycle.id, product.id)
    expect(after.ordered_g, 'the 500g is released').toBe(0)
    expect(after.remaining_g).toBe(1000)

    // A friend can now take the whole limit.
    const friendCart = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
    })
    expect(friendCart.status(), 'the released stock is genuinely buyable').toBe(200)

    // The host's view no longer counts it towards the payable total.
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    const listed = hostView.guest_orders.find((o) => o.id === created.order.id)
    expect(listed.status).toBe('cancelled')
    expect(listed.total).toBe(0)
    // GSO-T2 already filters cancelled sub-orders out of the host's totals — this
    // is the first task that can actually produce one, so pin the contract down.
    expect(hostView.totals, 'a cancelled sub-order is not part of what the host collects')
      .toEqual({ count: 0, total: 0 })
  })

  // Cancelling is IRREVERSIBLE, so ONLY an expressed intent to empty the cart may
  // trigger it. Everything below used to answer 200 + destroy the sub-order (rows
  // deleted, and `cancelled` is terminal, so the guest could not even re-save the
  // same cart) — on the app's only unauthenticated write.
  test('a malformed PUT is a non-destructive 400, never a cancellation', async () => {
    const { product, link } = await scenario('malformed')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const path = statusPath(link.token, created.order.order_token)

    // No `items` key at all.
    const noKey = await ctx.put(path, { data: {} })
    expect(noKey.status(), '{} must not be read as "empty the cart"').toBe(400)
    expect((await noKey.json()).field).toBe('items')

    // No body at all — what a proxy that strips bodies, or a wrong content-type,
    // produces.
    expect((await ctx.put(path)).status(), 'a bodyless PUT must not destroy anything').toBe(400)

    // `items` present but not an array.
    for (const items of ['250g', { 0: { product_id: product.id, variant: '250g', quantity: 1 } }, 5, null, true]) {
      const res = await ctx.put(path, { data: { items } })
      expect(res.status(), `items: ${JSON.stringify(items)} is not a cart`).toBe(400)
    }

    // A non-empty array where nothing survives pricing: lines WERE sent, so
    // deleting the order is not what the caller meant.
    const allBogus = await putStatus(link.token, created.order.order_token, {
      items: [
        { product_id: product.id, variant: '250g', quantity: 0 },
        { product_id: product.id, variant: '250g', quantity: -3 },
        { product_id: product.id, variant: 'zzz', quantity: 2 },
        { product_id: product.id, variant: '250g', quantity: true },
      ],
    })
    expect(allBogus.status(), 'lines sent, none priceable ⇒ refuse, do not destroy').toBe(400)
    expect((await allBogus.json()).field).toBe('items')

    // After every one of those, the sub-order is exactly as it was — and still
    // editable, which the terminal `cancelled` state would have prevented forever.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.status).toBe('submitted')
    expect(reread.order.total).toBe(10)
    expect(reread.items.length).toBe(1)
    expect(reread.editable).toBe(true)

    // Only a literal `items: []` cancels.
    const explicit = await putStatus(link.token, created.order.order_token, { items: [] })
    expect(explicit.status()).toBe(200)
    expect((await explicit.json()).order.status).toBe('cancelled')
  })

  test('cancelled is TERMINAL — a PUT cannot revive it (409)', async () => {
    // The lifecycle diagram has submitted → cancelled → [*] and no edge back.
    // GSO-T5's host-delete produces the same state, so this also protects a
    // sub-order the host deliberately removed.
    const { product, link } = await scenario('terminal')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await putStatus(link.token, created.order.order_token, { items: [] })).status()).toBe(200)

    const revive = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
    })
    expect(revive.status(), 'a cancelled sub-order stays cancelled').toBe(409)
    const err = await revive.json()
    expect(err.error, 'a Slovak explanation the page can show').toBeTruthy()
    expect(err.reason).toBe('cancelled')

    // Not even an empty-cart PUT (which would otherwise be a no-op cancel).
    expect((await putStatus(link.token, created.order.order_token, { items: [] })).status()).toBe(409)

    // GET still works — the guest can see that it was cancelled.
    const res = await getStatus(link.token, created.order.order_token)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.status).toBe('cancelled')
    expect(body.order.total).toBe(0)
    expect(body.editable).toBe(false)
    expect(body.items.length, 'and what was cancelled is still on the record').toBe(1)
  })
})

test.describe('Guest status URL — read-only after the cycle locks', () => {
  test('GET still renders a locked sub-order (the guest must be able to see it and pay) but PUT 409s', async () => {
    const { cycle, product, link } = await scenario('locked', { markup: 1.25 })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    await setCycleStatus(cycle.id, 'locked')

    // The product LISTING is 410 on a locked cycle (GSO-T3) — the status page
    // must NOT inherit that, or the guest loses sight of what they owe.
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'listing closes').toBe(410)

    const res = await getStatus(link.token, created.order.order_token)
    expect(res.status(), 'the status page stays readable after the lock').toBe(200)
    const body = await res.json()
    expect(body.order.total).toBe(25)
    expect(body.cycle.status).toBe('locked')
    expect(body.editable, 'read-only').toBe(false)
    expect(body.payment.amount, 'they still have to pay it').toBe(25)
    expect(body.payment.reference).toBe(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    expect(body.products ?? null, 'a locked cycle publishes no orderable product list').toBeNull()

    const put = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 5 }],
    })
    expect(put.status(), 'edits end at the lock').toBe(409)
    expect((await put.json()).reason).toBe('closed')

    // Not even an empty-cart cancel: distribution starts after the lock.
    expect((await putStatus(link.token, created.order.order_token, { items: [] })).status()).toBe(409)

    // Unchanged.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.total).toBe(25)
    expect(reread.items.length).toBe(1)
    expect(reread.items[0].quantity).toBe(2)
  })

  test('a completed cycle is read-only too, and a re-opened one is editable again', async () => {
    const { cycle, product, link } = await scenario('reopen')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await setCycleStatus(cycle.id, 'completed')
    const done = await getStatus(link.token, created.order.order_token)
    expect(done.status()).toBe(200)
    expect((await done.json()).editable).toBe(false)
    expect((await putStatus(link.token, created.order.order_token, { items: [] })).status()).toBe(409)

    await setCycleStatus(cycle.id, 'open')
    expect((await (await getStatus(link.token, created.order.order_token)).json()).editable).toBe(true)
    expect((await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 2 },
      ],
    })).status()).toBe(200)
  })

  test('a deactivated link keeps the status page readable (existing sub-orders survive) but stops edits', async () => {
    // §Edge Cases: "Host deactivates link → existing sub-orders survive; only new
    // visits break." The guest still owes money and still needs the reference —
    // but the host has closed the door, so writing is over.
    const { host, product, link } = await scenario('deact')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status(), 'deactivate').toBe(200)
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'new visits break').toBe(410)

    const res = await getStatus(link.token, created.order.order_token)
    expect(res.status(), 'the guest keeps their receipt').toBe(200)
    const body = await res.json()
    expect(body.order.total).toBe(10)
    expect(body.payment.reference).toBeTruthy()
    expect(body.editable, 'the door is closed for writes').toBe(false)

    const put = await putStatus(link.token, created.order.order_token, {
      items: [{ product_id: product.id, variant: '250g', quantity: 2 }],
    })
    expect(put.status(), 'the same 410 the submit path gives for a dead link').toBe(410)
    expect((await put.json()).reason).toBe('inactive')

    // Reactivating restores editing.
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth, data: { active: 1 } })).status()).toBe(200)
    expect((await (await getStatus(link.token, created.order.order_token)).json()).editable).toBe(true)
  })
})

test.describe('Guest status UI (/g/:token/o/:orderToken)', () => {
  test('the page shows the items, the total and the payment button, and the modal carries the right reference', async ({ page }) => {
    const { cycle, product, link } = await scenario('uiview', { markup: 1.25 })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    await page.context().grantPermissions(['clipboard-write'])
    // Genuinely public: no login, no stubs, no localStorage seeding.
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    const status = page.getByTestId('guest-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText(cycle.name)
    await expect(status).toContainText(IDENTITY.guest_name)
    await expect(status).toContainText(product.name)
    await expect(page.getByTestId('status-total')).toContainText('25.00')

    // The flags GSO-T5/T6 will drive are displayed, and read 'unpaid' for now.
    await expect(page.getByTestId('status-paid')).toContainText('Nezaplatené')

    // "Zaplatiť" re-opens the shared PaymentModal until the sub-order is paid.
    await page.getByTestId('open-payment').click()
    const modal = page.getByRole('dialog')
    await expect(modal).toContainText('Platba')
    await expect(modal, 'the exact amount to transfer').toContainText('25.00')
    // ⚠ 06 §UC-GX-011 item 2 (resolved conflict #4), status half: the payment
    // reference no longer sits on the status card — it lives ONLY inside the Platba
    // modal, so the modal is opened FIRST and the reference asserted within it.
    await expect(modal.getByTestId('payment-reference')).toContainText(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    // A rendered QR is separately the evidence that the reference was accepted into
    // the Pay by Square payload: a payload `encode()` rejects shows "Nepodarilo sa"
    // instead of an image.
    await expect(modal.getByAltText('Pay by Square QR')).toBeVisible()
    await expect(modal).not.toContainText('Nepodarilo sa')
    await expect(modal.getByRole('link', { name: /Revolut/ }), 'Revolut alternative').toBeVisible()
    await modal.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('the guest edits the cart through the shared product grid and the new total persists', async ({ page }) => {
    const { host, cycle, product, link } = await scenario('uiedit', { markup: 1.25 })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('status-total')).toContainText('12.50')

    await page.getByTestId('start-edit').click()

    // Same grid as `/g/:token`, pre-seeded with what was already ordered.
    const card = page.getByTestId(`product-${product.id}`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('qty-250g'), 'the existing line is in the cart').toHaveText('1')

    await card.getByTestId('inc-250g').click()
    await card.getByTestId('inc-1kg').click()
    await expect(page.getByTestId('edit-total')).toContainText('62.50')

    await page.getByTestId('save-edit').click()

    await expect(page.getByTestId('status-total')).toContainText('62.50')
    await expect(page.getByTestId('start-edit'), 'back on the read view').toBeVisible()

    // Persisted server-side, and visible to the host.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.total).toBe(62.5)
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders.find((o) => o.id === created.order.id).total).toBe(62.5)

    // A reload shows the same thing (the page reads the server, not a cache).
    await page.reload()
    await expect(page.getByTestId('status-total')).toContainText('62.50')
  })

  // The extracted `GuestProductGrid` has TWO consumers now. Bakery variant
  // grouping is covered on `/g/:token` by guest-order.spec.js; this is the second
  // consumer, and grouping is exactly what the extraction could have broken.
  test('the edit screen groups a bakery product\'s variants into a single card', async ({ page }) => {
    const bakeryName = `E2E GSO4 Makovnik ${uniq}`
    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: bakeryName, category: 'sladké', subtitle: 'domáci',
        variants: [{ label: '1ks', weight_grams: 500, price: 8 }, { label: '1/2', weight_grams: 250, price: 4.4 }],
      },
    })
    expect(bp.status()).toBe(201)
    const bakeryProduct = await bp.json()

    const host = await makeHost('uieditbakery')
    const cycle = await makeCycle('uieditbakery', { markup: 1.5, type: 'bakery', bakeryProductIds: [bakeryProduct.id] })
    const link = await shareLink(host, cycle.id)

    const listing = await (await ctx.get(`/api/guest/${link.token}`)).json()
    const whole = listing.products.find((p) => p.variant_label === '1ks')
    const half = listing.products.find((p) => p.variant_label === '1/2')
    expect(whole.price_unit, 'marked up (8 * 1.5)').toBe(12)
    expect(half.price_unit).toBe(6.6)

    const created = await submitGuest(link.token, [{ product_id: whole.id, variant: 'unit', quantity: 1 }])

    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('status-total')).toContainText('12.00')
    await page.getByTestId('start-edit').click()

    // Located by name, not by row id: which variant row seeds the grouped card is
    // an ordering detail, and there must be exactly ONE card for the product.
    const card = page.locator('[data-testid^="product-"]', { hasText: bakeryName })
    await expect(card, 'both bakery variants live in one card on the edit screen').toHaveCount(1)
    await expect(card).toContainText('1ks')
    await expect(card).toContainText('1/2')
    await expect(card).toContainText('12.00')
    await expect(card).toContainText('6.60')

    // The already-ordered variant is pre-seeded; the other one starts at zero.
    await expect(card.getByTestId(`qty-unit-${whole.id}`)).toHaveText('1')
    await expect(card.getByTestId(`qty-unit-${half.id}`)).toHaveText('0')

    await card.getByTestId(`inc-unit-${half.id}`).click()
    await expect(page.getByTestId('edit-total')).toContainText('18.60')

    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-total')).toContainText('18.60')

    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.total).toBe(18.6)
    expect(reread.items.length, 'one line per bakery variant, as on the ordering screen').toBe(2)
  })

  test('cancelling asks for confirmation, then shows the terminal cancelled state', async ({ page }) => {
    const { product, link } = await scenario('uicancel')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await page.getByTestId('cancel-order').click()

    // Destructive and irreversible, so it is confirmed rather than immediate.
    const confirm = page.getByTestId('confirm-cancel-order')
    await expect(confirm).toBeVisible()
    await confirm.click()

    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    await expect(page.getByTestId('start-edit'), 'cancelled is terminal — no way back').toHaveCount(0)
    await expect(page.getByTestId('open-payment'), 'nothing left to pay').toHaveCount(0)
    // The lines are kept as the record of what was called off, but no total is
    // shown against them — a cancelled sub-order owes nothing.
    await expect(page.getByTestId('status-item')).toHaveCount(1)
    await expect(page.getByText('Zrušené položky')).toBeVisible()
    await expect(page.getByTestId('status-total')).toHaveCount(0)

    expect((await (await getStatus(link.token, created.order.order_token)).json()).order.status).toBe('cancelled')

    // A fresh visit to a cancelled sub-order renders the same terminal state.
    await page.reload()
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
  })

  test('a locked cycle renders the order read-only, with the payment button still there', async ({ page }) => {
    const { cycle, product, link } = await scenario('uilocked')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }])
    await setCycleStatus(cycle.id, 'locked')

    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('guest-status')).toBeVisible()
    await expect(page.getByTestId('status-total')).toContainText('30.00')
    await expect(page.getByTestId('status-readonly')).toBeVisible()
    await expect(page.getByTestId('start-edit'), 'edits end at the lock').toHaveCount(0)
    await expect(page.getByTestId('open-payment'), 'but it still has to be paid').toBeVisible()
  })

  test('an unknown status URL shows a Slovak explanation instead of an empty page', async ({ page }) => {
    const { link } = await scenario('uinotfound')
    await page.goto(`/g/${link.token}/o/THISORDERDOESNOTEXIST`)
    await expect(page.getByTestId('guest-status-unavailable')).toBeVisible()
    await expect(page.getByTestId('guest-status')).toHaveCount(0)
  })
})
