import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T5: the host's "Objednávky kolegov" view — the enriched
// `GET /api/guest-links/cycle/:cycleId` payload (§UC-GSO-006), plus the two
// host-owned mutations on a sub-order:
//   PATCH /api/guest-orders/:id/delivered  — the hand-over checklist (§UC-GSO-007)
//   DELETE /api/guest-orders/:id           — soft-cancel while the cycle is open
//                                            (§UC-GSO-008)
//
// The load-bearing rule is Decision 2, "single-owner flags":
//   - `delivered` is HOST-only. The host toggles it; the admin will see it
//     read-only (GSO-T6).
//   - `paid` is ADMIN-only (GSO-T6). The host sees it READ-ONLY, so no route
//     added here may write it — including by mass assignment through the
//     delivered body.
// And §UC-GSO-006's money rule: the host's own payable total stays own-items
// only; guest totals are shown separately, for context.
//
// DELETE is a SOFT cancel: `status = 'cancelled'`, `total = 0`, the
// `guest_order_items` rows KEPT (they are the host's/admin's record of what was
// called off) and the stock genuinely RELEASED — the `<> 'cancelled'` predicate
// in helpers/stock.js is the mechanism, which is exactly why the rows can stay.
// The T4↔T5 handshake — the guest's own status URL then renders cancelled and
// refuses a revival — is asserted end to end below.
//
// NOTE ON RATE LIMITS: the guest half of these tests sits behind the shared
// `abuseLimiter`. Run the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// `paid` is the ADMIN's flag and its toggle arrives with GSO-T6, so there is no
// HTTP way to set it yet — but the rule "a host may not remove a sub-order the
// admin already marked paid" has to hold from the moment the removal exists, or
// GSO-T6 makes real money disappear. So the flag is pre-set straight in the
// SQLite file the server under test is using.
//
// Local runs point at it with the same DB_PATH the recipe exports for the server
// (see e2e/README.md); a remote target (staging) has no reachable file, so the one
// describe that needs it self-skips, exactly as rate-limit.spec.js does for its
// low-limit precondition.
//
// ⚠ NO default path. Guessing one (e.g. the README's /tmp/gorifi-e2e.sqlite) can
// open a leftover database from an earlier session that is NOT the one the server
// under test is using — the write then lands nowhere visible and the test fails
// for a reason that has nothing to do with the code. Explicit or skipped.
const DB_PATH = process.env.DB_PATH || ''

function openDb(options = {}) {
  return new DatabaseSync(DB_PATH, options)
}

function dbReachable() {
  if (!DB_PATH) return false
  try {
    openDb({ readOnly: true }).close()
    return true
  } catch {
    return false
  }
}

// Mark a sub-order paid the way GSO-T6's admin toggle will (flag + timestamp).
function markPaidInDb(guestOrderId) {
  const db = openDb()
  try {
    const result = db.prepare(
      'UPDATE guest_orders SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(guestOrderId)
    expect(Number(result.changes), 'the sub-order must exist in the DB under test').toBe(1)
  } finally {
    db.close()
  }
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// A friend with a real per-friend Bearer session — the host identity these
// endpoints require. Mirrors guest-status.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso5_${slug}`.slice(0, 30 - suffix.length) + suffix
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

async function makeCycle(label, { markup, type = 'coffee' } = {}) {
  const name = `E2E GSO5 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type, status: 'open' } })
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

// A sub-order can only be created through the public GSO-T3 submit.
async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function hostView(host, cycleId) {
  const res = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'host view').toBe(200)
  return res.json()
}

async function setDelivered(host, guestOrderId, delivered) {
  return ctx.patch(`/api/guest-orders/${guestOrderId}/delivered`, {
    headers: host.auth,
    ...(delivered === undefined ? {} : { data: { delivered } }),
  })
}

async function removeSubOrder(host, guestOrderId) {
  return ctx.delete(`/api/guest-orders/${guestOrderId}`, { headers: host.auth })
}

async function remainingFor(cycleId, productId) {
  const res = await ctx.get(`/api/products/cycle/${cycleId}/availability`)
  expect(res.status()).toBe(200)
  return (await res.json()).find((a) => a.product_id === productId)
}

// One host + open coffee cycle + one product + link, ready to submit against.
async function scenario(label, { markup, productData } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label, { markup })
  const product = await addProduct(cycle.id, {
    name: `GSO5 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30, ...productData,
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

test.describe('Host sub-order view — enriched payload (UC-GSO-006)', () => {
  test('lists every sub-order with its items, its total and both flags', async () => {
    const { host, cycle, product, link } = await scenario('payload', { markup: 1.25 })
    const second250 = await addProduct(cycle.id, {
      name: `GSO5 payload B ${uniq}`, purpose: 'Filter', price_250g: 8,
    })

    const first = await submitGuest(link.token, [
      { product_id: product.id, variant: '250g', quantity: 2 },
      { product_id: second250.id, variant: '250g', quantity: 1 },
    ])
    const second = await submitGuest(link.token, [
      { product_id: product.id, variant: '1kg', quantity: 1 },
    ], { guest_name: 'Jana Kolegyna', guest_phone: '0902 111 222', guest_email: 'jana@example.com' })

    const view = await hostView(host, cycle.id)
    expect(view.link.id, 'the GSO-T2 shape is EXTENDED, not reshaped').toBe(link.id)
    expect(view.guest_orders.length).toBe(2)

    const rowA = view.guest_orders.find((o) => o.id === first.order.id)
    const rowB = view.guest_orders.find((o) => o.id === second.order.id)

    // Identity + money the host needs to hand the bags over and know what the
    // colleagues owe.
    expect(rowA.guest_name).toBe(IDENTITY.guest_name)
    expect(rowA.guest_phone).toBe(IDENTITY.guest_phone)
    expect(rowA.status).toBe('submitted')
    expect(rowA.total, '2 × 250g at 10 × 1.25 markup + 1 × 8 × 1.25 = 25 + 10').toBe(35)
    expect(rowB.guest_email).toBe('jana@example.com')

    // Both flags start clear: `paid` is the admin's (GSO-T6), `delivered` the host's.
    expect(rowA.paid).toBe(0)
    expect(rowA.paid_at).toBeNull()
    expect(rowA.delivered).toBe(0)
    expect(rowA.delivered_at).toBeNull()

    // NEW in this task: the items of each sub-order.
    expect(rowA.items.length).toBe(2)
    const line = rowA.items.find((i) => i.product_id === product.id)
    expect(line.product_name).toBe(product.name)
    expect(line.variant).toBe('250g')
    expect(line.quantity).toBe(2)
    expect(line.price, 'the frozen marked-up unit price, as stored').toBe(12.5)
    expect(line.purpose, 'so the host sees the same grouping as everywhere else').toBe('Espresso')
    expect(rowA.items.find((i) => i.product_id === second250.id).product_name).toBe(second250.name)
    expect(rowB.items.length).toBe(1)
    expect(rowB.items[0].variant).toBe('1kg')

    // Guest totals are the host's context figure, aggregated separately.
    expect(view.totals).toEqual({ count: 2, total: 35 + 37.5 })

    // The guest's private status/edit URL stays unexposed (GSO-T2 rule).
    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain(first.order.order_token)
    expect(serialised).not.toContain(second.order.order_token)
    expect(serialised).not.toContain('order_token')
  })

  test('a cancelled sub-order still renders, but is out of the host totals', async () => {
    const { host, cycle, product, link } = await scenario('cancelrender')
    const keep = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const gone = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }])

    // The guest cancels their own (GSO-T4's empty-cart path).
    const cancelled = await ctx.put(`/api/guest/${link.token}/orders/${gone.order.order_token}`, { data: { items: [] } })
    expect(cancelled.status()).toBe(200)

    const view = await hostView(host, cycle.id)
    expect(view.guest_orders.length, 'a cancelled sub-order must render as cancelled, not vanish').toBe(2)
    const row = view.guest_orders.find((o) => o.id === gone.order.id)
    expect(row.status).toBe('cancelled')
    expect(row.total).toBe(0)
    expect(row.items.length, 'the record of what was called off survives').toBe(1)
    expect(view.totals).toEqual({ count: 1, total: 10 })
    expect(view.guest_orders.find((o) => o.id === keep.order.id).status).toBe('submitted')
  })

  test("the host's own payable total is own items only — guest sub-orders never join it", async () => {
    const { host, cycle, product, link } = await scenario('owntotal')

    // The host's own order: 1 × 1kg = 30.
    const cart = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
    })
    expect(cart.status()).toBe(200)
    const submitted = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${host.id}/submit`, {
      headers: host.auth, data: {},
    })
    expect(submitted.status()).toBe(200)
    const ownBefore = await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, { headers: host.auth })).json()
    expect(ownBefore.order.total).toBe(30)

    // Two colleagues order through the host's link.
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    const ownAfter = await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, { headers: host.auth })).json()
    expect(ownAfter.order.total, 'the host pays for their own items only (§UC-GSO-006)').toBe(30)
    expect(ownAfter.items.length, 'and their order still holds only their own lines').toBe(1)

    // The guest money is a SEPARATE figure in the same payload.
    const view = await hostView(host, cycle.id)
    expect(view.totals).toEqual({ count: 2, total: 30 })
    expect(view.totals.total, 'guest totals never absorb the host\'s own order').not.toBe(ownAfter.order.total + 30)

    // Ticking delivered / removing a sub-order must not move it either.
    const rows = view.guest_orders
    expect((await setDelivered(host, rows[0].id, true)).status()).toBe(200)
    expect((await removeSubOrder(host, rows[1].id)).status()).toBe(200)
    const ownFinal = await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, { headers: host.auth })).json()
    expect(ownFinal.order.total, 'host-side money is untouched by either host action').toBe(30)
    expect(ownFinal.order.status, 'and so is their own order state').toBe('submitted')
  })

  test('a bakery sub-order carries the variant label of every line', async () => {
    // Bakery products are snapshotted one `products` row per variant, and the
    // label is the ONLY thing distinguishing "Makovník 1ks" from "Makovník 1/2".
    // Without it the host cannot hand the right bag over.
    const bakeryName = `E2E GSO5 Makovnik ${uniq}`
    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: bakeryName, category: 'sladké', subtitle: 'domáci',
        variants: [{ label: '1ks', weight_grams: 500, price: 8 }, { label: '1/2', weight_grams: 250, price: 4.4 }],
      },
    })
    expect(bp.status()).toBe(201)
    const bakeryProduct = await bp.json()

    const host = await makeHost('bakerylabel')
    const cycleRes = await admin('/api/cycles', {
      method: 'post',
      data: {
        name: `E2E GSO5 bakerylabel ${uniq}`, type: 'bakery', status: 'open',
        bakery_product_ids: [bakeryProduct.id],
      },
    })
    expect(cycleRes.status()).toBe(201)
    const cycle = await cycleRes.json()
    const link = await shareLink(host, cycle.id)

    const listing = await (await ctx.get(`/api/guest/${link.token}`)).json()
    const half = listing.products.find((p) => p.variant_label === '1/2')
    const created = await submitGuest(link.token, [{ product_id: half.id, variant: 'unit', quantity: 2 }])

    const view = await hostView(host, cycle.id)
    const row = view.guest_orders.find((o) => o.id === created.order.id)
    expect(row.items.length).toBe(1)
    expect(row.items[0].product_name).toBe(bakeryName)
    expect(row.items[0].variant_label, 'which variant of the product was ordered').toBe('1/2')
    expect(row.items[0].variant).toBe('unit')
    expect(row.items[0].quantity).toBe(2)
  })
})

test.describe('delivered — the host-owned flag (UC-GSO-007)', () => {
  test('toggles on and off, setting and clearing delivered_at', async () => {
    const { host, cycle, product, link } = await scenario('deliv')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const on = await setDelivered(host, created.order.id, true)
    expect(on.status()).toBe(200)
    const onBody = await on.json()
    expect(onBody.guest_order.delivered).toBe(1)
    expect(onBody.guest_order.delivered_at, 'ticking stamps delivered_at').toBeTruthy()
    expect(onBody.guest_order.items.length, 'the response carries the same enriched row shape').toBe(1)

    // Persisted, and visible in the host view.
    const view = await hostView(host, cycle.id)
    const row = view.guest_orders.find((o) => o.id === created.order.id)
    expect(row.delivered).toBe(1)
    expect(row.delivered_at).toBeTruthy()

    const off = await setDelivered(host, created.order.id, false)
    expect(off.status()).toBe(200)
    const offBody = await off.json()
    expect(offBody.guest_order.delivered).toBe(0)
    expect(offBody.guest_order.delivered_at, 'unticking CLEARS delivered_at').toBeNull()

    // The guest sees the host's tick on their own status page (read-only there).
    expect((await setDelivered(host, created.order.id, true)).status()).toBe(200)
    const guestSees = await (await ctx.get(`/api/guest/${link.token}/orders/${created.order.order_token}`)).json()
    expect(guestSees.order.delivered).toBe(1)
  })

  test('stays available after the cycle is locked — hand-over happens after the lock', async () => {
    const { host, cycle, product, link } = await scenario('delivlocked')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await setCycleStatus(cycle.id, 'locked')

    const res = await setDelivered(host, created.order.id, true)
    expect(res.status(), 'the hand-over checklist is used AFTER distribution, so no cycle-open gate').toBe(200)
    expect((await res.json()).guest_order.delivered).toBe(1)
  })

  test('cannot write paid, status or total through the delivered route', async () => {
    // Decision 2: `paid` belongs to the admin (GSO-T6) and the host sees it
    // read-only. A host token must not be able to set it by any route here — and
    // `status`/`total` are server-owned everywhere.
    const { host, cycle, product, link } = await scenario('tamper')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect(created.order.total).toBe(20)

    const res = await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, {
      headers: host.auth,
      data: {
        delivered: true,
        paid: 1,
        paid_at: '2020-01-01 00:00:00',
        status: 'cancelled',
        total: 0.01,
        guest_name: 'Vlomeny Host',
        link_id: 999999,
      },
    })
    expect(res.status()).toBe(200)
    const row = (await res.json()).guest_order
    expect(row.delivered, 'the one field this route owns').toBe(1)
    expect(row.paid, 'paid is ADMIN-only — a host token can never set it').toBe(0)
    expect(row.paid_at).toBeNull()
    expect(row.status).toBe('submitted')
    expect(row.total).toBe(20)
    expect(row.guest_name).toBe(IDENTITY.guest_name)
    expect(row.link_id).toBe(link.id)

    // Re-read from the DB, not just the response body.
    const view = await hostView(host, cycle.id)
    const stored = view.guest_orders.find((o) => o.id === created.order.id)
    expect(stored.paid).toBe(0)
    expect(stored.status).toBe('submitted')
    expect(stored.total).toBe(20)
    expect(view.totals).toEqual({ count: 1, total: 20 })
  })

  test('is refused on a cancelled sub-order (409)', async () => {
    const { host, product, link } = await scenario('delivcancelled')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await removeSubOrder(host, created.order.id)).status()).toBe(200)

    const res = await setDelivered(host, created.order.id, true)
    expect(res.status(), 'a cancelled sub-order cannot be handed over').toBe(409)
    expect((await res.json()).error).toBeTruthy()
  })

  test('an unknown sub-order is a 404', async () => {
    const host = await makeHost('delivmissing')
    expect((await setDelivered(host, 99999999, true)).status()).toBe(404)
  })
})

test.describe('DELETE — the host removes a sub-order (UC-GSO-008)', () => {
  test('soft-cancels: status cancelled, total 0, item rows KEPT, stock RELEASED', async () => {
    const { host, cycle, product, link } = await scenario('del', {
      productData: { stock_limit_g: 1000 },
    })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect((await remainingFor(cycle.id, product.id)).remaining_g, '500g taken').toBe(500)

    const res = await removeSubOrder(host, created.order.id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.guest_order.status, 'DELETE is a SOFT cancel, not a row delete').toBe('cancelled')
    expect(body.guest_order.total).toBe(0)
    expect(body.guest_order.items.length, 'the host/admin record of what was called off is KEPT').toBe(1)
    expect(body.guest_order.items[0].quantity).toBe(2)
    expect(body.totals, 'the host collects nothing for it any more').toEqual({ count: 0, total: 0 })

    // The stock genuinely comes back — and because the item rows are still there,
    // this proves the release comes from the `<> 'cancelled'` predicate in
    // helpers/stock.js, not from deletion.
    const after = await remainingFor(cycle.id, product.id)
    expect(after.ordered_g).toBe(0)
    expect(after.remaining_g).toBe(1000)

    // And it is genuinely buyable again.
    const friendCart = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
    })
    expect(friendCart.status(), 'the released stock is buyable').toBe(200)
  })

  test("the guest's own status URL then renders cancelled and refuses a revival (T4↔T5)", async () => {
    const { host, product, link } = await scenario('delhandshake')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await removeSubOrder(host, created.order.id)).status()).toBe(200)

    const status = await ctx.get(`/api/guest/${link.token}/orders/${created.order.order_token}`)
    expect(status.status(), 'the guest can still read what happened').toBe(200)
    const body = await status.json()
    expect(body.order.status).toBe('cancelled')
    expect(body.order.total).toBe(0)
    expect(body.editable, 'cancelled is terminal — the page is read-only').toBe(false)
    expect(body.items.length, 'they can still see what had been ordered').toBe(1)

    // `cancelled` is terminal, so the guest cannot re-save the cart the host removed.
    const revive = await ctx.put(`/api/guest/${link.token}/orders/${created.order.order_token}`, {
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(revive.status(), 'a guest must not revive what the host removed').toBe(409)
  })

  test('is refused once the cycle is not open (409), and the sub-order survives', async () => {
    const { host, cycle, product, link } = await scenario('dellocked')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await setCycleStatus(cycle.id, 'locked')

    const res = await removeSubOrder(host, created.order.id)
    expect(res.status(), 'the task row: host removal is allowed only while the cycle is open').toBe(409)
    expect((await res.json()).error).toBeTruthy()

    const view = await hostView(host, cycle.id)
    const row = view.guest_orders.find((o) => o.id === created.order.id)
    expect(row.status, 'a refused removal changes nothing').toBe('submitted')
    expect(row.total).toBe(10)
    expect(view.totals).toEqual({ count: 1, total: 10 })
  })

  test('is idempotent: removing an already-cancelled sub-order is a 200 no-op', async () => {
    const { host, product, link } = await scenario('delidem')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await removeSubOrder(host, created.order.id)).status()).toBe(200)
    const again = await removeSubOrder(host, created.order.id)
    expect(again.status(), 'the requested end state is already the current one').toBe(200)
    const body = await again.json()
    expect(body.guest_order.status).toBe('cancelled')
    expect(body.guest_order.total).toBe(0)
    expect(body.guest_order.items.length, 'a repeated removal must not eat the record either').toBe(1)
  })

  test('an unknown sub-order is a 404', async () => {
    const host = await makeHost('delmissing')
    expect((await removeSubOrder(host, 99999999)).status()).toBe(404)
  })
})

test.describe('DELETE — a PAID sub-order is the admin\'s business', () => {
  // Needs to reach the server's SQLite file to pre-set `paid` (GSO-T6 owns the
  // only legitimate toggle and does not exist yet).
  test.skip(!dbReachable(), 'export DB_PATH (the server\'s own SQLite file) so the admin-only paid flag can be pre-set')

  test('a host cannot remove a sub-order the admin already marked paid (409)', async () => {
    // Soft-cancelling zeroes `total`, and every "not cancelled" aggregate then
    // drops the row — so money the colleague really sent would become invisible,
    // reconstructable only from the kept item rows. Under Decision 2 the host does
    // not get to unilaterally erase a paid order: money questions go to the admin,
    // exactly as the cash a guest hands the host does.
    const { host, cycle, product, link } = await scenario('delpaid', {
      productData: { stock_limit_g: 1000 },
    })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    markPaidInDb(created.order.id)

    const res = await removeSubOrder(host, created.order.id)
    expect(res.status(), 'a paid sub-order cannot be removed by the host').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('paid')
    expect(body.error, 'the message points the host at the admin').toContain('správcom')

    // Nothing moved: the order is still live, still owed-for, still counted.
    const view = await hostView(host, cycle.id)
    const row = view.guest_orders.find((o) => o.id === created.order.id)
    expect(row.status).toBe('submitted')
    expect(row.total).toBe(20)
    expect(row.paid).toBe(1)
    expect(view.totals).toEqual({ count: 1, total: 20 })
    // And the stock it holds is NOT released by a refused removal.
    expect((await remainingFor(cycle.id, product.id)).remaining_g).toBe(500)

    // The hand-over checklist is unaffected: handing a PAID order over is the
    // normal case, so the guard is scoped to the removal only.
    const delivered = await setDelivered(host, created.order.id, true)
    expect(delivered.status()).toBe(200)
    const deliveredRow = (await delivered.json()).guest_order
    expect(deliveredRow.delivered).toBe(1)
    expect(deliveredRow.paid, 'still read-only for the host').toBe(1)
    expect(deliveredRow.status).toBe('submitted')
  })
})

test.describe('Sub-order mutations — auth boundaries', () => {
  test('a foreign friend gets 403 on both delivered and delete', async () => {
    const { host, cycle, product, link } = await scenario('foreign')
    const other = await makeHost('intruder')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const patched = await setDelivered(other, created.order.id, true)
    expect(patched.status(), "another friend must not tick somebody else's hand-over").toBe(403)
    const deleted = await removeSubOrder(other, created.order.id)
    expect(deleted.status(), "another friend must not remove somebody else's sub-order").toBe(403)

    const row = (await hostView(host, cycle.id)).guest_orders.find((o) => o.id === created.order.id)
    expect(row.delivered).toBe(0)
    expect(row.status).toBe('submitted')

    // The foreign friend also cannot see the sub-order through their own view.
    const otherView = await hostView(other, cycle.id)
    expect(otherView.link).toBeNull()
    expect(otherView.guest_orders).toEqual([])
  })

  test('a row that does not exist is a 404 even for a foreign friend (no existence oracle)', async () => {
    const other = await makeHost('oracle')
    expect((await setDelivered(other, 99999999, true)).status()).toBe(404)
    expect((await removeSubOrder(other, 99999999)).status()).toBe(404)
  })

  test('anonymous requests are rejected (401)', async () => {
    const { product, link } = await scenario('anon')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, { data: { delivered: true } })).status()).toBe(401)
    expect((await ctx.delete(`/api/guest-orders/${created.order.id}`)).status()).toBe(401)
  })

  test('the shared friends password without a personal identity is rejected (401)', async () => {
    const { product, link } = await scenario('shared')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const shared = { 'X-Friends-Password': process.env.FRIENDS_PASSWORD || 'e2e-friends-pass' }

    expect((await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, { headers: shared, data: { delivered: true } })).status()).toBe(401)
    expect((await ctx.delete(`/api/guest-orders/${created.order.id}`, { headers: shared })).status()).toBe(401)

    // Sanity: the same password IS still good enough for an ordinary friend
    // endpoint, so the 401s above are this router's identity rule.
    expect((await ctx.get('/api/friends/cycles', { headers: shared })).status()).toBe(200)
  })

  test('an admin token is not a substitute for host identity', async () => {
    // GSO-T6 will mount ADMIN routes on this same /api/guest-orders prefix
    // (paid toggle, unpaid overview). These two are the HOST's, so an admin token
    // must not satisfy them — otherwise Decision 2's single ownership collapses.
    const { host, cycle, product, link } = await scenario('adminnot')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const asAdmin = { 'X-Admin-Token': adminToken }

    expect((await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, { headers: asAdmin, data: { delivered: true } })).status()).toBe(401)
    expect((await ctx.delete(`/api/guest-orders/${created.order.id}`, { headers: asAdmin })).status()).toBe(401)

    const row = (await hostView(host, cycle.id)).guest_orders.find((o) => o.id === created.order.id)
    expect(row.delivered, 'the admin never ticks the host\'s hand-over (Decision 2)').toBe(0)
    expect(row.status).toBe('submitted')
  })
})

test.describe('Regenerated link (the case GSO-T4 left open)', () => {
  test('an existing sub-order still resolves under the host\'s NEW token', async () => {
    // Regeneration keeps the link ROW (GSO-T2) and only swaps the token, so the
    // sub-orders hanging off it survive — but their status URL is built from the
    // link token, so the guest's saved URL breaks while the new one must work.
    const { host, cycle, product, link } = await scenario('regen')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const regen = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect(regen.status()).toBe(200)
    const fresh = (await regen.json()).link
    expect(fresh.id).toBe(link.id)
    expect(fresh.token).not.toBe(link.token)

    const underNew = await ctx.get(`/api/guest/${fresh.token}/orders/${created.order.order_token}`)
    expect(underNew.status(), 'same link row → the sub-order resolves under the new token').toBe(200)
    expect((await underNew.json()).order.id).toBe(created.order.id)

    const underOld = await ctx.get(`/api/guest/${link.token}/orders/${created.order.order_token}`)
    expect(underOld.status(), 'the retired token resolves nothing at all').toBe(404)

    // The host still sees the sub-order, and can still act on it.
    const view = await hostView(host, cycle.id)
    expect(view.guest_orders.length).toBe(1)
    expect((await setDelivered(host, created.order.id, true)).status()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// UI pass on the "Objednávky kolegov" section in the host's order view.
//
// FriendPortal resolves the stored session against GET /api/friends?active=true,
// which is admin-gated — an anonymous browser gets 401 (pre-existing app gap, see
// e2e/README.md), so that ONE response is stubbed. Everything under test still
// talks to the real backend with the real Bearer token.
async function signInAsHost(page, host) {
  const stored = JSON.stringify({
    friendId: host.id,
    friendName: host.name,
    token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)

  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGSO5UI', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

// A FRESH load of the order page. Deliberately not `page.reload()` on
// /cycle/:cycleId: a hard load of that route always bounces to the portal
// ("Auth will be restored by FriendPortal, redirect there" in FriendOrder's
// onMounted) — pre-existing app behaviour, the same one e2e/README.md describes.
// Going in through the portal is therefore how a real host gets here, and it is
// still a full page load, so it proves state came back from the server.
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

async function openHostOrderPage(page, host, cycle) {
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
}

test.describe('Objednávky kolegov — UI', () => {
  test('lists the colleagues, their items and a READ-ONLY paid badge', async ({ page }) => {
    const { host, cycle, product, link } = await scenario('uilist')
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }], {
      guest_name: 'Jana Kolegyna', guest_phone: '0902 111 222',
    })

    await openHostOrderPage(page, host, cycle)

    const section = page.getByTestId('guest-sub-orders')
    await expect(section).toBeVisible()
    await expect(section).toContainText(IDENTITY.guest_name)
    await expect(section).toContainText('Jana Kolegyna')
    // Items are listed, not just a total.
    await expect(section).toContainText(product.name)
    await expect(section, 'the guest aggregate is shown separately from the host total').toContainText('50')

    // `paid` is the admin's flag (GSO-T6): the host sees its state, with no control.
    await expect(section.getByTestId('guest-paid-badge').first()).toContainText('Nezaplatené')
    await expect(
      section.getByRole('button', { name: /Zaplaten/ }),
      'the host must not be offered a paid toggle'
    ).toHaveCount(0)
    await expect(section.getByRole('checkbox', { name: /Zaplaten/ })).toHaveCount(0)
  })

  test('the delivered checkbox toggles, persists across a reload and reaches the API', async ({ page }) => {
    const { host, cycle, product, link } = await scenario('uidelivered')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await openHostOrderPage(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')
    const box = section.getByTestId(`guest-delivered-${created.order.id}`)
    await expect(box).toBeVisible()
    await expect(box).not.toBeChecked()

    await box.click()
    await expect(box).toBeChecked()
    await expect
      .poll(async () => (await hostView(host, cycle.id)).guest_orders[0].delivered, { timeout: 5000 })
      .toBe(1)

    // Fresh page load: the tick must come back from the server, not from the
    // component's own state.
    await gotoCycle(page, cycle)
    await expect(page.getByTestId(`guest-delivered-${created.order.id}`), 'the tick is durable').toBeChecked()

    // And it unticks again.
    await page.getByTestId(`guest-delivered-${created.order.id}`).click()
    await expect
      .poll(async () => (await hostView(host, cycle.id)).guest_orders[0].delivered, { timeout: 5000 })
      .toBe(0)
  })

  test('a delivered tick that the server refuses reverts and reports, even when superseded', async ({ page }) => {
    // The failure mode: one shared sequence counter for the whole component meant a
    // request that was overtaken by a later one dropped its own error on the floor —
    // no revert, no message — so the checkbox kept claiming a hand-over the server
    // had refused (a 409 because the guest cancelled meanwhile, or a paid row, or a
    // dropped request). The UI must never assert state that was not persisted.
    const { host, cycle, product, link } = await scenario('uifail')
    const first = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const second = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Jana Kolegyna', guest_phone: '0902 111 222',
    })

    await signInAsHost(page, host)
    // The FIRST row's PATCH fails, and slowly — so the second row's (real, fast)
    // PATCH settles first and supersedes it.
    await page.route(`**/api/guest-orders/${first.order.id}/delivered`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Táto objednávka bola zrušená, nie je čo odovzdať.' }),
      })
    })
    await gotoCycle(page, cycle)

    const section = page.getByTestId('guest-sub-orders')
    const failing = section.getByTestId(`guest-delivered-${first.order.id}`)
    const working = section.getByTestId(`guest-delivered-${second.order.id}`)

    await failing.click()
    await working.click()

    // The row that succeeded stays ticked...
    await expect(working).toBeChecked()
    await expect
      .poll(async () => (await hostView(host, cycle.id)).guest_orders.find((o) => o.id === second.order.id).delivered)
      .toBe(1)

    // ...and the refused one comes back UNticked, with the reason on screen.
    await expect(failing, 'a refused tick must not keep claiming a hand-over').not.toBeChecked()
    await expect(section).toContainText('Táto objednávka bola zrušená')
    const rows = (await hostView(host, cycle.id)).guest_orders
    expect(rows.find((o) => o.id === first.order.id).delivered, 'nothing was persisted for it').toBe(0)
  })

  test('a failed initial load is visible, not silence that looks like "no colleagues yet"', async ({ page }) => {
    const { host, cycle } = await scenario('uiloadfail')

    await signInAsHost(page, host)
    await page.route(`**/api/guest-links/cycle/${cycle.id}`, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Nepodarilo sa načítať objednávky kolegov' }),
    }))
    await gotoCycle(page, cycle)

    const section = page.getByTestId('guest-sub-orders')
    await expect(section, 'an empty list and a failed load must not look identical').toBeVisible()
    await expect(section).toContainText('Nepodarilo sa načítať objednávky kolegov')
  })

  test('the host can remove a sub-order, and it then renders as cancelled', async ({ page }) => {
    const { host, cycle, product, link } = await scenario('uidelete')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await openHostOrderPage(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')
    await expect(section).toContainText(IDENTITY.guest_name)

    await section.getByTestId(`guest-remove-${created.order.id}`).click()
    // Removing is destructive, so it asks first.
    await section.getByRole('button', { name: 'Áno, odstrániť' }).click()

    await expect(section.getByTestId(`guest-status-${created.order.id}`)).toContainText('Zrušené')
    await expect(section, 'a removed sub-order stays visible as cancelled').toContainText(IDENTITY.guest_name)

    const view = await hostView(host, cycle.id)
    expect(view.guest_orders.find((o) => o.id === created.order.id).status).toBe('cancelled')
    expect(view.totals).toEqual({ count: 0, total: 0 })
  })
})
