import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T3: the public guest ordering surface — `GET /api/guest/:token` and
// `POST /api/guest/:token/orders` (§UC-GSO-001..003) — plus the stock-limit
// UNION over `order_items` + `guest_order_items` that makes friend and guest
// carts compete for the same `products.stock_limit_g`.
//
// Everything here is anonymous: `ctx` carries no auth headers at all, which is
// the point — a guest has no account, no session and no shared password. The
// admin/host helpers attach their own headers explicitly.
//
// NOTE ON RATE LIMITS: these endpoints sit behind the shared `abuseLimiter`
// (Decision 6), whose per-IP budget (`RATE_LIMIT_ABUSE_MAX`, default 40) is
// shared with the invite-code / onboarding specs. Run the full suite with a
// generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// SEC-S2 CSPRNG alphabet, same proxy for randomness as invite-code.spec.js /
// guest-link.spec.js: length + alphabet.
const TOKEN_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// A friend with real credentials and a per-friend Bearer session — the identity
// the host-side guest-link endpoints require (and the identity used here for the
// competing friend order in the stock tests). Mirrors guest-link.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso3_${slug}`.slice(0, 30 - suffix.length) + suffix
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

async function makeCycle(label, { markup, status, type = 'coffee', bakeryProductIds } = {}) {
  const name = `E2E GSO3 ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type, status: 'open', ...(bakeryProductIds ? { bakery_product_ids: bakeryProductIds } : {}) },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  if (markup !== undefined) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: markup } })).status()).toBe(200)
  }
  if (status && status !== 'open') {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status } })).status()).toBe(200)
  }
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

// The host shares the cycle; the returned token is the guest's whole credential.
async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

// Friend-side order (the other half of the stock UNION), as the friend themself.
async function friendCart(host, cycleId, items) {
  return ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
}
async function friendSubmit(host, cycleId) {
  return ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, { headers: host.auth, data: {} })
}

async function availability(cycleId) {
  const res = await ctx.get(`/api/products/cycle/${cycleId}/availability`)
  expect(res.status()).toBe(200)
  return await res.json()
}

const IDENTITY = { guest_name: 'Marek Hostovic', guest_phone: '0901 234 567' }

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  // Payment settings (which guests need to pay the admin — Decision 1) come from
  // the seed; this spec only ever READS them, so it never mutates a real
  // environment's IBAN and works whatever the target is configured with.
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('Guest link resolution (UC-GSO-001)', () => {
  test('a valid open link returns the cycle, the host first name and MARKED-UP products', async () => {
    const host = await makeHost('resolve')
    const cycle = await makeCycle('resolve', { markup: 1.25 })
    const coffee = await addProduct(cycle.id, { name: `Guest Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 })
    const caps = await addProduct(cycle.id, { name: `Guest Caps ${uniq}`, purpose: 'Kapsule', price_20pc5g: 8 })
    const link = await shareLink(host, cycle.id)

    const res = await ctx.get(`/api/guest/${link.token}`)
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body.cycle.id).toBe(cycle.id)
    expect(body.cycle.name).toBe(cycle.name)
    expect(body.cycle.status).toBe('open')
    // Only the host's FIRST name is published to strangers.
    expect(body.host.first_name).toBe('Peto')
    expect(JSON.stringify(body.host), 'no host phone/email/id leaks to guests').not.toContain('@')

    const gotCoffee = body.products.find((p) => p.id === coffee.id)
    const gotCaps = body.products.find((p) => p.id === caps.id)
    // Prices arrive with the cycle markup already applied, using the same
    // formula/rounding as friend orders (10 * 1.25 = 12.50, 30 * 1.25 = 37.50).
    expect(gotCoffee.price_250g).toBe(12.5)
    expect(gotCoffee.price_1kg).toBe(37.5)
    expect(gotCaps.price_20pc5g).toBe(10)

    // Decision 1 says the guest gets the IBAN — but only once they have an order
    // to pay for. The unauthenticated product listing must not carry it.
    const settings = await (await ctx.get('/api/admin/payment-settings')).json()
    expect(body.payment, 'no payment block on the listing').toBeUndefined()
    if (settings.paymentIban) {
      expect(JSON.stringify(body), 'the IBAN must not ride along on the listing').not.toContain(settings.paymentIban)
    }

    // Decision 6: the public guest endpoints are behind the abuse limiter.
    expect(res.headers()['ratelimit-policy'] || res.headers()['ratelimit'], 'abuseLimiter must be mounted').toBeTruthy()
  })

  test('410 once the host deactivates the link (existing sub-orders survive, new visits break)', async () => {
    const host = await makeHost('deact')
    const cycle = await makeCycle('deact')
    await addProduct(cycle.id, { name: `Deact Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    expect((await ctx.get(`/api/guest/${link.token}`)).status()).toBe(200)
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status()).toBe(200)

    const gone = await ctx.get(`/api/guest/${link.token}`)
    expect(gone.status()).toBe(410)
    expect((await gone.json()).error).toBeTruthy()
  })

  test('410 when the cycle is not open (locked or planned)', async () => {
    const host = await makeHost('locked')
    const cycle = await makeCycle('locked')
    await addProduct(cycle.id, { name: `Locked Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    expect((await ctx.get(`/api/guest/${link.token}`)).status()).toBe(200)

    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'locked cycle').toBe(410)

    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'planned' } })).status()).toBe(200)
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'planned cycle is not orderable either').toBe(410)
  })

  test('404 for an unknown token — distinct from 410 so the page can say the right thing', async () => {
    const res = await ctx.get('/api/guest/THISTOKENDOESNOTEXIST')
    expect(res.status()).toBe(404)
    expect((await res.json()).error).toBeTruthy()
  })
})

test.describe('Guest submit — identity validation (Decision 7)', () => {
  let token
  let productId

  test.beforeAll(async () => {
    const host = await makeHost('identity')
    const cycle = await makeCycle('identity')
    productId = (await addProduct(cycle.id, { name: `Ident Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })).id
    token = (await shareLink(host, cycle.id)).token
  })

  const items = () => [{ product_id: productId, variant: '250g', quantity: 1 }]

  test('a missing or blank name is a 400', async () => {
    const noName = await ctx.post(`/api/guest/${token}/orders`, { data: { guest_phone: '0901234567', items: items() } })
    expect(noName.status()).toBe(400)
    expect((await noName.json()).error).toBeTruthy()

    const blank = await ctx.post(`/api/guest/${token}/orders`, { data: { guest_name: '   ', guest_phone: '0901234567', items: items() } })
    expect(blank.status(), 'whitespace is not a name').toBe(400)
  })

  test('a missing phone, or one with fewer than 9 digits, is a 400', async () => {
    const noPhone = await ctx.post(`/api/guest/${token}/orders`, { data: { guest_name: 'Marek', items: items() } })
    expect(noPhone.status()).toBe(400)

    const tooShort = await ctx.post(`/api/guest/${token}/orders`, { data: { guest_name: 'Marek', guest_phone: '0901 23', items: items() } })
    expect(tooShort.status(), '7 digits is not a mobile number').toBe(400)
    expect((await tooShort.json()).error).toBeTruthy()
  })

  test('an empty cart is a 400 (no phantom sub-orders)', async () => {
    const empty = await ctx.post(`/api/guest/${token}/orders`, { data: { ...IDENTITY, items: [] } })
    expect(empty.status()).toBe(400)

    const zeroed = await ctx.post(`/api/guest/${token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: productId, variant: '250g', quantity: 0 }] },
    })
    expect(zeroed.status(), 'quantity 0 is an empty cart').toBe(400)
  })
})

test.describe('Guest submit — success (UC-GSO-002/003)', () => {
  test('persists the sub-order with FROZEN marked-up prices and returns the order token + payment info', async () => {
    const host = await makeHost('submit')
    const cycle = await makeCycle('submit', { markup: 1.25 })
    const coffee = await addProduct(cycle.id, { name: `Submit Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 })
    const link = await shareLink(host, cycle.id)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        ...IDENTITY,
        items: [
          { product_id: coffee.id, variant: '250g', quantity: 2 },
          { product_id: coffee.id, variant: '1kg', quantity: 1 },
        ],
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()

    // 2 x 12.50 + 1 x 37.50 = 62.50 — markup frozen at submit time.
    expect(body.order.total).toBe(62.5)
    expect(body.order.status).toBe('submitted')
    expect(body.order.guest_name).toBe(IDENTITY.guest_name)
    expect(body.order.paid).toBe(0)
    expect(body.order.delivered).toBe(0)
    expect(body.order.order_token.length, 'guest status token >= 12 chars (SEC-S2)').toBeGreaterThanOrEqual(12)
    expect(body.order.order_token).toMatch(TOKEN_ALPHABET)
    expect(body.order.order_token, 'the sub-order token is its own secret').not.toBe(link.token)

    const byVariant = Object.fromEntries(body.items.map((i) => [i.variant, i]))
    expect(byVariant['250g'].price).toBe(12.5)
    expect(byVariant['250g'].quantity).toBe(2)
    expect(byVariant['1kg'].price).toBe(37.5)

    // Payment info for the confirmation screen (Decision 1).
    const settings = await (await ctx.get('/api/admin/payment-settings')).json()
    expect(body.payment.amount).toBe(62.5)
    expect(body.payment.reference).toBe(`G${body.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    expect(body.payment.iban).toBe(settings.paymentIban)
    expect(body.payment.revolut_username).toBe(settings.paymentRevolutUsername)

    // Persisted where the host can see it — and the guest's private token is NOT
    // in the host payload.
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders.length).toBe(1)
    expect(hostView.guest_orders[0].id).toBe(body.order.id)
    expect(hostView.guest_orders[0].total).toBe(62.5)
    expect(hostView.guest_orders[0].guest_phone).toBe(IDENTITY.guest_phone)
    expect(hostView.totals).toEqual({ count: 1, total: 62.5 })
    expect(JSON.stringify(hostView), 'order_token stays private to the guest').not.toContain(body.order.order_token)

    // A second guest on the same link is fine — no cap (Decision 6).
    const second = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Zuzka', guest_phone: '+421 902 111 222', guest_email: 'zuzka@example.com', items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }] },
    })
    expect(second.status()).toBe(201)
    const secondBody = await second.json()
    expect(secondBody.order.order_token).not.toBe(body.order.order_token)
    expect(secondBody.order.guest_email).toBe('zuzka@example.com')
    expect(secondBody.payment.reference).toBe(`G${secondBody.order.id} / Zuzka / ${cycle.name}`)
  })

  test('409 when the cycle locks between opening the cart and submitting', async () => {
    const host = await makeHost('race')
    const cycle = await makeCycle('lockrace')
    const coffee = await addProduct(cycle.id, { name: `Race Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    // The guest loaded the page while the cycle was open...
    expect((await ctx.get(`/api/guest/${link.token}`)).status()).toBe(200)
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }] },
    })
    expect(res.status(), 'lock race is a 409, not a 410/400').toBe(409)
    expect((await res.json()).error).toBeTruthy()

    // Nothing was written.
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders).toEqual([])
  })

  test('a deactivated link cannot be submitted through (410)', async () => {
    const host = await makeHost('deactpost')
    const cycle = await makeCycle('deactpost')
    const coffee = await addProduct(cycle.id, { name: `DeactPost Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status()).toBe(200)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }] },
    })
    expect(res.status()).toBe(410)
    expect((await ctx.post('/api/guest/THISTOKENDOESNOTEXIST/orders', { data: { ...IDENTITY, items: [] } })).status()).toBe(404)
  })
})

// The crux of GSO-T3: `products.stock_limit_g` was enforced in three places, all
// counting `order_items` only. Guests and friends draw from the SAME limited
// stock, so both directions have to hold.
test.describe('Stock limits UNION friend + guest items', () => {
  test('a guest order reduces what a friend can order (availability + cart PUT)', async () => {
    const host = await makeHost('stockg2f')
    const cycle = await makeCycle('stockg2f')
    const limited = await addProduct(cycle.id, {
      name: `Limited G2F ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 1000,
    })
    const link = await shareLink(host, cycle.id)

    const before = (await availability(cycle.id)).find((a) => a.product_id === limited.id)
    expect(before.ordered_g).toBe(0)
    expect(before.remaining_g).toBe(1000)

    // Guest takes 500g.
    const submitted = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: limited.id, variant: '250g', quantity: 2 }] },
    })
    expect(submitted.status()).toBe(201)

    const after = (await availability(cycle.id)).find((a) => a.product_id === limited.id)
    expect(after.ordered_g, 'guest grams count towards the limit').toBe(500)
    expect(after.remaining_g).toBe(500)

    // The friend can no longer take 750g...
    const tooMuch = await friendCart(host, cycle.id, [{ product_id: limited.id, variant: '250g', quantity: 3 }])
    expect(tooMuch.status(), 'friend cart must respect guest grams').toBe(400)
    const err = await tooMuch.json()
    expect(err.error).toContain('limit')
    expect(JSON.stringify(err.details)).toContain('500g')

    // ...but 500g exactly fits, and submitting it is allowed.
    expect((await friendCart(host, cycle.id, [{ product_id: limited.id, variant: '250g', quantity: 2 }])).status()).toBe(200)
    expect((await friendSubmit(host, cycle.id)).status()).toBe(200)

    const full = (await availability(cycle.id)).find((a) => a.product_id === limited.id)
    expect(full.ordered_g, 'friend + guest grams are both counted').toBe(1000)
    expect(full.remaining_g).toBe(0)
  })

  test('a friend order reduces what a guest can submit', async () => {
    const host = await makeHost('stockf2g')
    const cycle = await makeCycle('stockf2g')
    const limited = await addProduct(cycle.id, {
      name: `Limited F2G ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 1000,
    })
    const link = await shareLink(host, cycle.id)

    expect((await friendCart(host, cycle.id, [{ product_id: limited.id, variant: '250g', quantity: 3 }])).status()).toBe(200)
    expect((await friendSubmit(host, cycle.id)).status()).toBe(200)

    // The guest page shows what is left, so the counters can be honest.
    const view = await (await ctx.get(`/api/guest/${link.token}`)).json()
    const avail = view.availability.find((a) => a.product_id === limited.id)
    expect(avail.remaining_g).toBe(250)

    const tooMuch = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: limited.id, variant: '250g', quantity: 2 }] },
    })
    expect(tooMuch.status(), 'guest submit must respect friend grams').toBe(400)
    expect(JSON.stringify(await tooMuch.json())).toContain('250g')

    const fits = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: limited.id, variant: '250g', quantity: 1 }] },
    })
    expect(fits.status()).toBe(201)
  })

  test('the friend SUBMIT gate counts guest items too (draft filled before the guest ordered)', async () => {
    // The cart PUT and the submit are two separate gates: a draft that was legal
    // when it was saved must not slip through submit after a guest has eaten the
    // remaining stock.
    const host = await makeHost('stocksubmit')
    const cycle = await makeCycle('stocksubmit')
    const limited = await addProduct(cycle.id, {
      name: `Limited Submit ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 1000,
    })
    const link = await shareLink(host, cycle.id)

    // Draft 750g while the whole 1000g is still free — legal at PUT time.
    expect((await friendCart(host, cycle.id, [{ product_id: limited.id, variant: '250g', quantity: 3 }])).status()).toBe(200)

    // A guest then takes 500g (drafts don't count, so this is legal too).
    expect((await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: limited.id, variant: '250g', quantity: 2 }] },
    })).status()).toBe(201)

    const submit = await friendSubmit(host, cycle.id)
    expect(submit.status(), '750 + 500 > 1000 — submit must be refused').toBe(400)
    expect(JSON.stringify(await submit.json())).toContain('limit')
  })
})

// This is the app's FIRST unauthenticated write endpoint: the URL token is the
// only credential, so the request body is entirely attacker-controlled. These
// checks pin down that the server, not the client, is the source of truth for
// every field that matters — status flags, money, and the guest's own secret.
test.describe('Guest submit — tampering resistance (unauthenticated write hardening)', () => {
  test('the body cannot set paid, delivered, status, total, or its own order_token', async () => {
    const host = await makeHost('tamperflags')
    const cycle = await makeCycle('tamperflags', { markup: 1.25 })
    const coffee = await addProduct(cycle.id, { name: `TamperFlags Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        ...IDENTITY,
        paid: 1,
        delivered: 1,
        status: 'confirmed',
        total: 999999,
        order_token: 'HACKEDTOKEN123',
        items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }],
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.order.paid, 'paid stays server-default, ignoring the body').toBe(0)
    expect(body.order.delivered, 'delivered stays server-default, ignoring the body').toBe(0)
    expect(body.order.status, 'status stays submitted, ignoring the body').toBe('submitted')
    expect(body.order.total, 'total is computed from the DB snapshot (10 * 1.25), not the body').toBe(12.5)
    expect(body.order.order_token, "a guest cannot choose their own status token").not.toBe('HACKEDTOKEN123')
    expect(body.order.order_token).toMatch(TOKEN_ALPHABET)
  })

  test('line prices are taken from the server snapshot, not the request body', async () => {
    const host = await makeHost('tamperprice')
    const cycle = await makeCycle('tamperprice', { markup: 1.25 })
    const coffee = await addProduct(cycle.id, { name: `TamperPrice Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '250g', quantity: 1, price: 0.01 }] },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.items[0].price, 'the client-supplied price (0.01) is ignored; server prices at 10 * 1.25').toBe(12.5)
    expect(body.order.total).toBe(12.5)
  })

  test('negative or non-numeric quantities are dropped, not summed into the total', async () => {
    const host = await makeHost('tamperqty')
    const cycle = await makeCycle('tamperqty')
    const coffee = await addProduct(cycle.id, { name: `TamperQty Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    const res = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        ...IDENTITY,
        items: [
          { product_id: coffee.id, variant: '250g', quantity: -5 },
          { product_id: coffee.id, variant: '250g', quantity: 'abc' },
          { product_id: coffee.id, variant: '250g', quantity: 1 },
        ],
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.items.length, 'only the one genuinely positive-integer line survives').toBe(1)
    expect(body.items[0].quantity).toBe(1)
    expect(body.order.total, 'no negative or NaN contribution from the bogus lines').toBe(10)

    // Once every line is bogus, the cart is empty — a 400, not a zero-total order.
    const allBogus = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        ...IDENTITY,
        items: [
          { product_id: coffee.id, variant: '250g', quantity: -1 },
          { product_id: coffee.id, variant: '250g', quantity: 0 },
        ],
      },
    })
    expect(allBogus.status(), 'all-bogus quantities collapse to the empty-cart 400').toBe(400)
  })

  test('a product_id from a different cycle is dropped — a token cannot reach across cycles', async () => {
    const hostA = await makeHost('tamperA')
    const cycleA = await makeCycle('tamperA')
    const productA = await addProduct(cycleA.id, { name: `TamperA Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const linkA = await shareLink(hostA, cycleA.id)

    const hostB = await makeHost('tamperB')
    const cycleB = await makeCycle('tamperB')
    const productB = await addProduct(cycleB.id, { name: `TamperB Coffee ${uniq}`, purpose: 'Espresso', price_250g: 999 })

    // Cycle A's link, cycle B's product id: alone, that's an empty cart.
    const crossOnly = await ctx.post(`/api/guest/${linkA.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: productB.id, variant: '250g', quantity: 1 }] },
    })
    expect(crossOnly.status(), 'a cross-cycle line alone is an empty cart').toBe(400)

    // Mixed with one real line: the cross-cycle line is silently dropped, not priced in.
    const mixed = await ctx.post(`/api/guest/${linkA.token}/orders`, {
      data: {
        ...IDENTITY,
        items: [
          { product_id: productB.id, variant: '250g', quantity: 1 },
          { product_id: productA.id, variant: '250g', quantity: 1 },
        ],
      },
    })
    expect(mixed.status()).toBe(201)
    const body = await mixed.json()
    expect(body.items.length, 'the cross-cycle line is dropped, only the in-cycle one lands').toBe(1)
    expect(body.items[0].product_id).toBe(productA.id)
    expect(body.order.total, "cycle B's 999 price never entered the total").toBe(10)
  })

  test('an oversized item list is rejected before a single row is written', async () => {
    // The body is attacker-controlled and express.json accepts 10mb, so without a
    // row cap one unauthenticated request persists hundreds of thousands of
    // guest_order_items rows (and blocks the event loop pricing them).
    const host = await makeHost('boundsitems')
    const cycle = await makeCycle('boundsitems')
    const coffee = await addProduct(cycle.id, { name: `Bounds Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)

    const many = Array.from({ length: 101 }, () => ({ product_id: coffee.id, variant: '250g', quantity: 1 }))
    const res = await ctx.post(`/api/guest/${link.token}/orders`, { data: { ...IDENTITY, items: many } })
    expect(res.status(), '101 lines is over the cap').toBe(400)
    expect((await res.json()).error).toBeTruthy()

    // Nothing was written — not a partial order.
    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders, 'a rejected oversized cart writes nothing').toEqual([])

    // The cap is generous: a realistic 100-line cart still goes through.
    const atCap = Array.from({ length: 100 }, () => ({ product_id: coffee.id, variant: '250g', quantity: 1 }))
    const ok = await ctx.post(`/api/guest/${link.token}/orders`, { data: { ...IDENTITY, items: atCap } })
    expect(ok.status(), '100 lines is still accepted').toBe(201)
  })

  test('over-long identity strings are rejected (they land in host and admin views)', async () => {
    const host = await makeHost('boundsid')
    const cycle = await makeCycle('boundsid')
    const coffee = await addProduct(cycle.id, { name: `BoundsId Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    const items = [{ product_id: coffee.id, variant: '250g', quantity: 1 }]

    const hugeName = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'M'.repeat(121), guest_phone: '0901234567', items },
    })
    expect(hugeName.status(), 'a 121-char name is refused').toBe(400)

    const hugePhone = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Marek', guest_phone: '9'.repeat(33), items },
    })
    expect(hugePhone.status(), 'a 33-char phone is refused even though it has >= 9 digits').toBe(400)

    const hugeEmail = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, guest_email: `${'e'.repeat(160)}@example.com`, items },
    })
    expect(hugeEmail.status(), 'a 173-char e-mail is refused').toBe(400)

    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders, 'none of the oversized identities persisted').toEqual([])

    // Real-world values are comfortably inside the bounds.
    const ok = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Marek Hostovic-Dlhopriezviskovy', guest_phone: '+421 901 234 567', guest_email: 'marek.hostovic@example.com', items },
    })
    expect(ok.status()).toBe(201)
  })

  test('object-typed fields are a 400, not a 500 (no stack traces from the public endpoint)', async () => {
    // `{ toString: 1 }` makes String()/parseInt()/property-key coercion throw, so
    // an unguarded handler answers the 400-with-field contract with a 500.
    const host = await makeHost('typeguard')
    const cycle = await makeCycle('typeguard')
    const coffee = await addProduct(cycle.id, { name: `TypeGuard Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    const items = [{ product_id: coffee.id, variant: '250g', quantity: 1 }]
    const evil = { toString: 1 }

    const badName = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: evil, guest_phone: '0901234567', items },
    })
    expect(badName.status(), 'an object where a name belongs is a 400').toBe(400)
    expect((await badName.json()).field).toBe('guest_name')

    const badPhone = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Marek', guest_phone: evil, items },
    })
    expect(badPhone.status()).toBe(400)
    expect((await badPhone.json()).field).toBe('guest_phone')

    const badEmail = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, guest_email: evil, items },
    })
    expect(badEmail.status(), 'an optional field still has to be text when present').toBe(400)
    expect((await badEmail.json()).field).toBe('guest_email')

    // Object-typed variant / quantity make the line unusable, so the cart is empty.
    const badVariant = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: evil, quantity: 1 }] },
    })
    expect(badVariant.status(), 'an object variant is dropped, not a 500').toBe(400)

    const badQuantity = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '250g', quantity: evil }] },
    })
    expect(badQuantity.status(), 'an object quantity is dropped, not a 500').toBe(400)

    // Mixed with a good line, only the good one lands — and still no 500.
    const mixed = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        ...IDENTITY,
        items: [{ product_id: coffee.id, variant: evil, quantity: 1 }, ...items],
      },
    })
    expect(mixed.status()).toBe(201)
    const mixedBody = await mixed.json()
    expect(mixedBody.items.length).toBe(1)
    expect(mixedBody.order.total).toBe(10)
  })

  test('a single line cannot carry an unbounded quantity', async () => {
    // Stock-limited products are protected by the limit check, but an UNLIMITED
    // product would otherwise persist a billions-of-euro total that feeds the
    // admin views and (GSO-T8) kilos/tier progress, with no delete UI until T5.
    const host = await makeHost('qtycap')
    const cycle = await makeCycle('qtycap')
    const coffee = await addProduct(cycle.id, { name: `QtyCap Coffee ${uniq}`, purpose: 'Espresso', price_1kg: 31.94 })
    const link = await shareLink(host, cycle.id)

    const huge = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '1kg', quantity: 1000000000 }] },
    })
    expect(huge.status(), 'a billion units is refused').toBe(400)
    expect((await huge.json()).field).toBe('items')

    const over = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '1kg', quantity: 101 }] },
    })
    expect(over.status(), '101 units on one line is over the cap').toBe(400)

    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders, 'nothing absurd was persisted').toEqual([])

    // The cap is generous enough for a real cart.
    const ok = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '1kg', quantity: 100 }] },
    })
    expect(ok.status()).toBe(201)
    expect((await ok.json()).order.total).toBe(3194)
  })

  test('a deactivated HOST closes the link too (410), like a deactivated link', async () => {
    // The host is the person who hands the goods over, and every friend order path
    // refuses an inactive friend — so their link must stop taking new sub-orders
    // (and stop consuming stock) once they are deactivated.
    const host = await makeHost('hostoff')
    const cycle = await makeCycle('hostoff')
    const coffee = await addProduct(cycle.id, { name: `HostOff Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    expect((await ctx.get(`/api/guest/${link.token}`)).status()).toBe(200)

    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: 0 } })).status()).toBe(200)

    const listing = await ctx.get(`/api/guest/${link.token}`)
    expect(listing.status(), 'an inactive host closes the door').toBe(410)
    expect((await listing.json()).reason).toBe('inactive')

    const submit = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }] },
    })
    expect(submit.status()).toBe(410)
  })
})

// PRE-EXISTING bypass, closed here because it defeats the very gate this row
// makes guest-aware: the friend cart PUT priced ANY unrecognised variant at the
// 250g price, while helpers/stock.js scores an unknown variant 0 g — so real
// goods could be bought without touching products.stock_limit_g.
test.describe('Friend cart — unpriceable variants cannot bypass stock limits', () => {
  test('an unknown variant is dropped instead of being priced at the 250g price', async () => {
    const host = await makeHost('badvariant')
    const cycle = await makeCycle('badvariant')
    const limited = await addProduct(cycle.id, {
      name: `BadVariant Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 1000,
    })

    // 20 x a made-up variant: used to be a 200 EUR order weighing 0 g.
    const bogus = await friendCart(host, cycle.id, [{ product_id: limited.id, variant: 'zzz', quantity: 20 }])
    expect(bogus.status()).toBe(200)
    const bogusBody = await bogus.json()
    expect(bogusBody.items, 'the unpriceable line is not persisted').toEqual([])
    expect(bogusBody.order, 'an all-bogus cart leaves no order behind').toBeNull()

    // Mixed with a real line, only the real line survives and is charged.
    const mixed = await friendCart(host, cycle.id, [
      { product_id: limited.id, variant: 'zzz', quantity: 20 },
      { product_id: limited.id, variant: '250g', quantity: 1 },
    ])
    expect(mixed.status()).toBe(200)
    const mixedBody = await mixed.json()
    expect(mixedBody.items.length).toBe(1)
    expect(mixedBody.items[0].variant).toBe('250g')
    expect(mixedBody.order.total, 'the 20 bogus units are not charged').toBe(10)

    expect((await friendSubmit(host, cycle.id)).status()).toBe(200)

    // And the stock ledger matches what was actually sold: 250 g, not 250 g of
    // tracked coffee plus 5 kg of untracked coffee.
    const avail = (await availability(cycle.id)).find((a) => a.product_id === limited.id)
    expect(avail.ordered_g).toBe(250)
    expect(avail.remaining_g).toBe(750)
  })

  test('a prototype-key variant cannot nullify the stock limit (NaN defeats the comparison)', async () => {
    // The gram lookup used to be `VARIANT_GRAMS[variant] || 0`, so a prototype key
    // resolved to a truthy FUNCTION: grams became NaN, `NaN > stock_limit_g` is
    // false, and the limit reported "no violation" for that product. One junk line
    // beside legitimate ones sold 10 kg against a 2 kg cap — and the junk line is
    // dropped by the pricing loop, so nothing suspicious remains in the order.
    const host = await makeHost('protokey')
    const cycle = await makeCycle('protokey')
    const limited = await addProduct(cycle.id, {
      name: `ProtoKey Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30, stock_limit_g: 2000,
    })
    const link = await shareLink(host, cycle.id)

    for (const key of ['constructor', 'valueOf', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await friendCart(host, cycle.id, [
        { product_id: limited.id, variant: '1kg', quantity: 10 },
        { product_id: limited.id, variant: key, quantity: 1 },
      ])
      expect(res.status(), `10kg over a 2kg limit must be refused even next to a '${key}' line`).toBe(400)
      expect((await res.json()).error).toContain('limit')
    }

    // The limit still lets a legitimate cart through, and the ledger is exact:
    // 2 x 1kg fits precisely, the junk line adds nothing.
    const ok = await friendCart(host, cycle.id, [
      { product_id: limited.id, variant: '1kg', quantity: 2 },
      { product_id: limited.id, variant: 'constructor', quantity: 1 },
    ])
    expect(ok.status()).toBe(200)
    const okBody = await ok.json()
    expect(okBody.items.length, 'the prototype-key line is not persisted').toBe(1)
    expect(okBody.order.total).toBe(60)
    expect((await friendSubmit(host, cycle.id)).status()).toBe(200)

    const avail = (await availability(cycle.id)).find((a) => a.product_id === limited.id)
    expect(avail.ordered_g, 'exactly the 2kg that was really sold').toBe(2000)
    expect(avail.remaining_g).toBe(0)

    // And the ledger is real, not cosmetic: a guest can no longer take anything.
    const guest = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: limited.id, variant: '250g', quantity: 1 }] },
    })
    expect(guest.status(), 'the stock is genuinely gone').toBe(400)
    expect((await guest.json()).error).toContain('limit')
  })

  test("the bakery 'unit' variant is still priceable (zero-gram is not unpriceable)", async () => {
    const bakeryName = `E2E GSO3 Strudla ${uniq}`
    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: { name: bakeryName, category: 'slané', variants: [{ label: '1ks', weight_grams: 400, price: 6 }] },
    })
    expect(bp.status()).toBe(201)
    const bakeryProduct = await bp.json()

    const host = await makeHost('bakeryunit')
    const cycle = await makeCycle('bakeryunit', { markup: 1.5, type: 'bakery', bakeryProductIds: [bakeryProduct.id] })
    const products = await (await admin(`/api/products/cycle/${cycle.id}`)).json()
    expect(products.length).toBe(1)

    const put = await friendCart(host, cycle.id, [{ product_id: products[0].id, variant: 'unit', quantity: 2 }])
    expect(put.status()).toBe(200)
    const body = await put.json()
    expect(body.items.length, "'unit' must keep working — bakery ordering depends on it").toBe(1)
    expect(body.items[0].price, 'priced from price_unit x markup (6 * 1.5)').toBe(9)
    expect(body.order.total).toBe(18)
    expect((await friendSubmit(host, cycle.id)).status()).toBe(200)
  })
})

test.describe('Guest ordering UI (/g/:token)', () => {
  test('a guest builds a cart, is blocked until name + mobile are valid, and lands on the confirmation', async ({ page }) => {
    const host = await makeHost('ui')
    const cycle = await makeCycle('ui', { markup: 1.25 })
    const coffee = await addProduct(cycle.id, { name: `UI Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 })
    const link = await shareLink(host, cycle.id)

    // The copy buttons at the end write to the clipboard.
    await page.context().grantPermissions(['clipboard-write'])

    // No login, no stubs, no localStorage seeding: the page is genuinely public.
    await page.goto(`/g/${link.token}`)

    await expect(page.getByText(cycle.name)).toBeVisible()
    await expect(page.getByText('Peto', { exact: false }).first(), 'the host is named').toBeVisible()
    await expect(page.getByText(`UI Coffee ${uniq}`)).toBeVisible()
    await expect(page.getByText('12.50', { exact: false }).first(), 'marked-up price on the card').toBeVisible()

    // Add 2 x 250g.
    const card = page.getByTestId(`product-${coffee.id}`)
    await card.getByTestId('inc-250g').click()
    await card.getByTestId('inc-250g').click()
    await expect(page.getByTestId('cart-total')).toContainText('25.00')

    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Submitting with nothing filled in is refused client-side.
    await dialog.getByTestId('guest-submit').click()
    await expect(dialog.getByTestId('checkout-error')).toBeVisible()

    // A too-short number is refused as well.
    await dialog.getByTestId('guest-name').fill('Marek')
    await dialog.getByTestId('guest-phone').fill('0901 23')
    await dialog.getByTestId('guest-submit').click()
    await expect(dialog.getByTestId('checkout-error')).toBeVisible()

    await dialog.getByTestId('guest-phone').fill('0901 234 567')
    await dialog.getByTestId('guest-submit').click()

    // Confirmation: the personal status URL on the card, the payment reference in
    // the Platba modal.
    const confirmation = page.getByTestId('guest-confirmation')
    await expect(confirmation).toBeVisible()

    // §UC-GSO-003: the confirmation opens the shared PaymentModal straight away.
    const paymentDialog = page.getByRole('dialog')
    await expect(paymentDialog, 'the payment modal opens on confirmation').toContainText('Platba')

    const hostView = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(hostView.guest_orders.length, 'the order reached the backend').toBe(1)
    const sub = hostView.guest_orders[0]
    expect(sub.total).toBe(25)
    expect(sub.guest_name).toBe('Marek')
    expect(sub.guest_phone).toBe('0901 234 567')

    // 06 §UC-GX-011 item 2 (resolved conflict #4): the payment reference no longer
    // sits on the confirmation card — it lives ONLY inside the Platba modal, so it
    // is asserted within the auto-opened dialog, before closing it.
    await expect(paymentDialog.getByTestId('payment-reference')).toContainText(`G${sub.id} / Marek / ${cycle.name}`)

    // Close it to get back to the card (a modal is inert-behind by design).
    await paymentDialog.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 06 §UC-GX-011 item 3: the status URL is a `NeoCopyRow`, not an `<input>` —
    // the value is the row's text.
    const statusUrl = (await page.getByTestId('guest-status-url').locator('.val').textContent()).trim()
    expect(statusUrl).toMatch(new RegExp(`/g/${link.token}/o/[A-Z2-9]{12,}$`))

    // ...and the same URL is kept in localStorage so the guest can find it again.
    const stored = await page.evaluate(() => localStorage.getItem('gorifi_guest_orders'))
    expect(stored, 'status URL persisted for a return visit').toContain(statusUrl.split('/o/')[1])

    // 06 §UC-GX-011 item 4: both copy buttons must CONFIRM the copy — the status URL
    // is the guest's only route back to their order, so silent feedback is not
    // acceptable — and the confirmation is per-ROW, not shared. The two rows now
    // live on different layers (the status URL on the page, the reference inside the
    // modal), so the independence is checked with both mounted: `NeoModal` teleports
    // to `<body>` and leaves the confirmation card in the DOM behind its scrim. The
    // label is "Skopírované!" with the exclamation mark (resolved conflict #6), and
    // the buttons are addressed through their rows — the standalone
    // `copy-status-url` / `copy-reference` testids retired with the old markup.
    await page.getByRole('button', { name: 'Zaplatiť', exact: true }).click()
    const reopened = page.getByRole('dialog')
    const copyReference = reopened.getByTestId('payment-reference').getByRole('button')
    const copyStatusUrl = page.getByTestId('guest-status-url').getByRole('button')

    await copyReference.click()
    await expect(copyReference).toHaveText('Skopírované!')
    await expect(copyStatusUrl, 'only the clicked row confirms').toHaveText('Kopírovať')

    await reopened.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await copyStatusUrl.click()
    await expect(copyStatusUrl).toHaveText('Skopírované!')
  })

  test('a bakery cycle groups the variants of one product into a single card', async ({ page }) => {
    const bakeryName = `E2E GSO3 Makovnik ${uniq}`
    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: bakeryName, category: 'sladké', subtitle: 'domáci',
        variants: [{ label: '1ks', weight_grams: 500, price: 8 }, { label: '1/2', weight_grams: 250, price: 4.4 }],
      },
    })
    expect(bp.status()).toBe(201)
    const bakeryProduct = await bp.json()

    const host = await makeHost('uibakery')
    const cycle = await makeCycle('uibakery', { markup: 1.5, type: 'bakery', bakeryProductIds: [bakeryProduct.id] })
    const link = await shareLink(host, cycle.id)

    const view = await (await ctx.get(`/api/guest/${link.token}`)).json()
    expect(view.products.length, 'one products row per bakery variant').toBe(2)
    const whole = view.products.find((p) => p.variant_label === '1ks')
    expect(whole.price_unit, 'bakery unit price is marked up too (8 * 1.5)').toBe(12)
    expect(whole.source_bakery_product_id).toBe(bakeryProduct.id)

    await page.goto(`/g/${link.token}`)
    // Located by name, not by row id: which variant row seeds the grouped card is
    // an ordering detail, and there must be exactly ONE card for the product.
    const card = page.locator('[data-testid^="product-"]', { hasText: bakeryName })
    await expect(card, 'both variants live in one card').toHaveCount(1)
    await expect(card).toContainText('1ks')
    await expect(card).toContainText('1/2')
    await expect(card).toContainText('12.00')
    await expect(card).toContainText('6.60')

    await card.getByTestId(`inc-unit-${whole.id}`).click()
    await expect(page.getByTestId('cart-total')).toContainText('12.00')
  })

  test('a dead link shows a Slovak explanation instead of an empty page', async ({ page }) => {
    const host = await makeHost('uidead')
    const cycle = await makeCycle('uidead')
    await addProduct(cycle.id, { name: `Dead Coffee ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const link = await shareLink(host, cycle.id)
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status()).toBe(200)

    await page.goto(`/g/${link.token}`)
    await expect(page.getByTestId('guest-unavailable')).toBeVisible()
    await expect(page.getByTestId('open-checkout')).toHaveCount(0)
  })
})
