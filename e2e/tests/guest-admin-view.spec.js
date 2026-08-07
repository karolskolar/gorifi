import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T6: the ADMIN side of guest sub-orders (§UC-GSO-009..010).
//
//   PATCH /api/guest-orders/:id/paid            — the money flag, ADMIN-only
//   GET   /api/guest-orders/cycle/:id/unpaid    — who has not paid yet
//   GET   /api/orders/cycle/:id                 — now carries `guest_orders`
//                                                 nested under their host
//   GET   /api/cycles                           — `unpaid_count` includes guests
//
// Three rules carry the money in this task:
//
//  1. **No `transactions` row.** The friend toggle (`PATCH /api/orders/:id/paid`)
//     writes a `payment` transaction because friends have a running balance.
//     Guests have none — they pay the admin directly (Decision 1) — so
//     `paid`/`paid_at` on `guest_orders` is the whole bookkeeping. A copy-pasted
//     transaction insert would move a real friend's balance for money that never
//     touched it, so it is asserted absent, not just "not intended".
//
//  2. **Decision 2, both directions.** `paid` is the ADMIN's flag, `delivered` the
//     HOST's. GSO-T5 pinned the host half (a host cannot write `paid`); this task
//     is the first time the other half is testable: the admin must not be able to
//     write `delivered` (nor `status`/`total`) through the paid route.
//
//  3. **`unpaid_count` must not corrupt `orders_count`.** Both come out of the same
//     aggregate query in `cycles.js`; joining the guest tables into it would
//     multiply rows and inflate the friend-order count. So `orders_count` is
//     asserted UNCHANGED while `unpaid_count` grows.
//
// This spec also re-tests GSO-T5's `DELETE` guard (409 `reason: 'paid'`) through
// the real API: until now the flag had to be pre-set by writing the server's
// SQLite file, because no HTTP setter existed.
//
// NOTE ON RATE LIMITS: the guest submits here sit behind the shared
// `abuseLimiter`. Run the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// OPTIONAL, and only ever used for a strictly-extra assertion: a GLOBAL
// `transactions` row count. The per-friend checks below already prove no balance
// moved for anybody involved, but a naive copy of the friend handler could insert
// a row with a NULL `friend_id` — a row no API surface can see. When the server's
// own SQLite file is reachable (local runs export DB_PATH, see e2e/README.md) that
// blind spot is closed too; against staging the test still runs, one assertion
// lighter. NO default path: guessing one can open a leftover database that is not
// the one under test.
const DB_PATH = process.env.DB_PATH || ''

function transactionCountFromDb() {
  if (!DB_PATH) return null
  let db
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true })
  } catch {
    return null
  }
  try {
    return Number(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n)
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

// The backend keeps exactly ONE live admin session (a single `admin_token` row in
// `settings`, overwritten on every `/api/admin/login` — see `admin.js`), not a
// per-call bearer token. A UI test that logs in through the login FORM therefore
// invalidates whatever token an earlier `beforeAll` captured. Any block that mixes
// API fixture-building with a UI login re-logs-in via the API right before it builds
// fixtures, so it never depends on a token an intervening UI test may have replaced.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// A friend with a real per-friend Bearer session (the host identity the GSO-T2/T5
// routes require). Mirrors guest-host-view.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso6_${slug}`.slice(0, 30 - suffix.length) + suffix
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
  const name = `E2E GSO6 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type, status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  if (markup !== undefined) {
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: markup } })).status()).toBe(200)
  }
  return { ...cycle, name }
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

const IDENTITY = { guest_name: 'Marek Kolega', guest_phone: '0901 234 567', guest_email: 'marek@example.com' }

async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

// The host's own friend order, submitted through the ordinary friend API with the
// host's Bearer token — so a cycle has both kinds of order in it.
async function submitOwnOrder(host, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
  expect(put.status(), 'own cart').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, { headers: host.auth, data: {} })
  expect(submit.status(), 'own submit').toBe(200)
  return (await submit.json()).order
}

// ---- the endpoints under test -------------------------------------------------

function setPaid(guestOrderId, paid, extra = {}) {
  return admin(`/api/guest-orders/${guestOrderId}/paid`, {
    method: 'patch',
    ...(paid === undefined && Object.keys(extra).length === 0 ? {} : { data: { ...(paid === undefined ? {} : { paid }), ...extra } }),
  })
}

async function unpaidOverview(cycleId) {
  const res = await admin(`/api/guest-orders/cycle/${cycleId}/unpaid`)
  expect(res.status(), 'unpaid overview').toBe(200)
  return res.json()
}

// The host's own view — used here as an independent DB RE-READ of a sub-order,
// rather than trusting the mutation's own response shape.
async function subOrderFromHostView(host, cycleId, id) {
  const res = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'host view').toBe(200)
  return (await res.json()).guest_orders.find((o) => o.id === id)
}

async function adminOrders(cycleId) {
  const res = await admin(`/api/orders/cycle/${cycleId}`)
  expect(res.status(), 'admin orders').toBe(200)
  return res.json()
}

async function cycleRow(cycleId) {
  const res = await admin('/api/cycles')
  expect(res.status(), 'cycles list').toBe(200)
  const row = (await res.json()).find((c) => c.id === cycleId)
  expect(row, 'the cycle must be in the admin list').toBeTruthy()
  return row
}

async function friendTransactions(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  const detail = await res.json()
  return { balance: detail.balance, count: (detail.transactions || []).length }
}

async function guestStatus(linkToken, orderToken) {
  const res = await ctx.get(`/api/guest/${linkToken}/orders/${orderToken}`)
  expect(res.status(), 'guest status').toBe(200)
  return res.json()
}

// One host + open coffee cycle + one product + link, ready to submit against.
async function scenario(label, { markup, productData } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label, { markup })
  const product = await addProduct(cycle.id, {
    name: `GSO6 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30, ...productData,
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

test.describe('PATCH /api/guest-orders/:id/paid — the admin marks a guest payment (UC-GSO-009)', () => {
  test('toggles paid on and off, setting and CLEARING paid_at', async () => {
    const { host, cycle, product, link } = await scenario('toggle')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    const on = await setPaid(created.order.id, true)
    expect(on.status()).toBe(200)
    const onRow = (await on.json()).guest_order
    expect(onRow.paid).toBe(1)
    expect(onRow.paid_at, 'the timestamp is set with the flag').toBeTruthy()

    // Re-read from the DB through a different surface, not the mutation response.
    const persisted = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(persisted.paid, 'the host sees the admin flag read-only').toBe(1)
    expect(persisted.paid_at).toBeTruthy()

    const off = await setPaid(created.order.id, false)
    expect(off.status()).toBe(200)
    const offRow = (await off.json()).guest_order
    expect(offRow.paid).toBe(0)
    expect(offRow.paid_at, 'unticking CLEARS the timestamp, it does not keep a stale one').toBeNull()
    const cleared = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(cleared.paid).toBe(0)
    expect(cleared.paid_at).toBeNull()

    // A body-less PATCH toggles the current value (the UI sends the explicit
    // boolean, but the toggle semantics of the friend endpoint are preserved).
    expect((await setPaid(created.order.id, undefined)).status()).toBe(200)
    expect((await subOrderFromHostView(host, cycle.id, created.order.id)).paid).toBe(1)
  })

  test('creates NO transactions row and moves nobody\'s balance (guests have no balance account)', async () => {
    const { host, cycle, product, link } = await scenario('notx')
    // The host has their own friend order in the same cycle, so if the guest paid
    // toggle wrongly reused the friend logic there is an obvious victim: the
    // account it would credit.
    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect(created.order.total, '2 × 250g at 10').toBe(20)

    const before = await friendTransactions(host.id)
    const globalBefore = transactionCountFromDb()

    expect((await setPaid(created.order.id, true)).status()).toBe(200)
    const afterPaid = await friendTransactions(host.id)
    expect(afterPaid.count, 'no payment transaction may appear for the host').toBe(before.count)
    expect(afterPaid.balance, 'the host owes exactly what they owed before').toBe(before.balance)

    // Unticking must not write a reversal either (the friend endpoint does).
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    const afterUnpaid = await friendTransactions(host.id)
    expect(afterUnpaid.count).toBe(before.count)
    expect(afterUnpaid.balance).toBe(before.balance)

    // Extra, only when the server's DB file is reachable: no row appeared
    // ANYWHERE — including one keyed to a NULL friend_id, which no API can see.
    if (globalBefore !== null) {
      expect(transactionCountFromDb(), 'no transactions row at all for a guest payment').toBe(globalBefore)
    }

    // And the response is the sub-order shape, not the friend endpoint's
    // balance-carrying one.
    const body = await (await setPaid(created.order.id, true)).json()
    expect(body.guest_order.id).toBe(created.order.id)
    expect(body.friend_balance, 'a guest sub-order has no balance to report').toBeUndefined()
    expect(body.totals, 'the host aggregate is recomputed, as on the host mutations').toBeTruthy()
  })

  test('the admin cannot write delivered, status or total through the paid route', async () => {
    const { host, cycle, product, link } = await scenario('massassign')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }])
    expect(created.order.total).toBe(30)

    const res = await setPaid(created.order.id, true, {
      delivered: true,
      delivered_at: '2000-01-01 00:00:00',
      status: 'cancelled',
      total: 9999,
      paid_at: '2000-01-01 00:00:00',
      link_id: 999999,
      guest_name: 'Smuggled',
    })
    expect(res.status()).toBe(200)

    // DB re-read, not the response shape: only paid/paid_at may have moved.
    const row = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(row.paid).toBe(1)
    expect(row.delivered, 'delivered is the HOST\'s flag (Decision 2)').toBe(0)
    expect(row.delivered_at).toBeNull()
    expect(row.status).toBe('submitted')
    expect(row.total).toBe(30)
    expect(row.guest_name).toBe(IDENTITY.guest_name)
    expect(row.paid_at, 'the server sets the timestamp, the caller does not').not.toContain('2000')

    // The host's own tick stays authoritative across an admin paid toggle.
    expect((await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, {
      headers: host.auth, data: { delivered: true },
    })).status()).toBe(200)
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    const after = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(after.delivered, 'the admin toggling paid must not clear the hand-over').toBe(1)
    expect(after.delivered_at).toBeTruthy()
    expect(after.paid).toBe(0)
  })

  test('a sub-order that does not exist is a 404', async () => {
    expect((await setPaid(99999999, true)).status()).toBe(404)
  })

  test('a CANCELLED sub-order can still be marked and unmarked paid (refund bookkeeping)', async () => {
    // Money can genuinely arrive for an order that was then called off, and the
    // refund workflow has to be able to CLEAR the flag afterwards. Unlike
    // `delivered` (which asserts a hand-over that cannot have happened), `paid` is
    // a statement about money, so it is not gated on the status.
    const { host, cycle, product, link } = await scenario('refund')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    // The guest cancels their own sub-order (GSO-T4: an explicit empty cart).
    const cancelled = await ctx.put(`/api/guest/${link.token}/orders/${created.order.order_token}`, { data: { items: [] } })
    expect(cancelled.status(), 'the guest may still empty their own cart').toBe(200)

    const stuck = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(stuck.status).toBe('cancelled')
    expect(stuck.paid, 'paid survives the cancellation — that is the refund signal').toBe(1)

    // The admin refunds and clears the flag.
    const refunded = await setPaid(created.order.id, false)
    expect(refunded.status()).toBe(200)
    expect((await refunded.json()).guest_order.paid).toBe(0)
  })
})

test.describe('Paid route — auth boundaries', () => {
  test('anonymous, host-token and shared-password requests are all rejected', async () => {
    const { host, cycle, product, link } = await scenario('authpaid')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const shared = { 'X-Friends-Password': process.env.FRIENDS_PASSWORD || 'e2e-friends-pass' }

    const paidPath = `/api/guest-orders/${created.order.id}/paid`
    const unpaidPath = `/api/guest-orders/cycle/${cycle.id}/unpaid`

    expect((await ctx.patch(paidPath, { data: { paid: true } })).status(), 'anonymous').toBe(401)
    expect((await ctx.get(unpaidPath)).status(), 'anonymous').toBe(401)

    // The host is NOT the money owner (Decision 2) — their own Bearer session, the
    // one that ticks `delivered` on this very row, must not reach these routes.
    expect((await ctx.patch(paidPath, { headers: host.auth, data: { paid: true } })).status(), 'host token').toBe(401)
    expect((await ctx.get(unpaidPath, { headers: host.auth })).status(), 'host token').toBe(401)

    expect((await ctx.patch(paidPath, { headers: shared, data: { paid: true } })).status(), 'shared password').toBe(401)
    expect((await ctx.get(unpaidPath, { headers: shared })).status(), 'shared password').toBe(401)

    // Nothing moved through any of those attempts.
    expect((await subOrderFromHostView(host, cycle.id, created.order.id)).paid).toBe(0)
  })
})

test.describe('GET /api/guest-orders/cycle/:cycleId/unpaid — the money overview (UC-GSO-010)', () => {
  test('lists every unpaid guest with amount, reference, host and contact', async () => {
    const { host, cycle, product, link } = await scenario('overview', { markup: 1.25 })
    const first = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    const second = await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }], {
      guest_name: 'Jana Kolegyna', guest_phone: '0902 111 222',
    })
    const paidOne = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
      guest_name: 'Zaplatil Hned', guest_phone: '0903 000 111',
    })
    const cancelledOne = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
      guest_name: 'Zrusil To', guest_phone: '0904 000 222',
    })

    expect((await setPaid(paidOne.order.id, true)).status()).toBe(200)
    expect((await ctx.delete(`/api/guest-orders/${cancelledOne.order.id}`, { headers: host.auth })).status()).toBe(200)

    const overview = await unpaidOverview(cycle.id)
    expect(overview.cycle.id).toBe(cycle.id)
    expect(overview.cycle.name).toBe(cycle.name)

    const ids = overview.unpaid.map((row) => row.id)
    expect(ids, 'both unpaid guests are listed').toContain(first.order.id)
    expect(ids).toContain(second.order.id)
    expect(ids, 'a guest who has paid is not chased').not.toContain(paidOne.order.id)
    expect(ids, 'a cancelled sub-order owes nothing').not.toContain(cancelledOne.order.id)

    const rowA = overview.unpaid.find((row) => row.id === first.order.id)
    expect(rowA.guest_name).toBe(IDENTITY.guest_name)
    expect(rowA.total, '2 × 250g at 10 × 1.25 markup').toBe(25)
    // Contact: the phone is mandatory at submit, the e-mail optional.
    expect(rowA.guest_phone).toBe(IDENTITY.guest_phone)
    expect(rowA.guest_email).toBe(IDENTITY.guest_email)
    expect(rowA.host.id).toBe(host.id)
    expect(rowA.host.name).toBe(host.name)

    // The reference is the SAME string the guest is told to put on the payment —
    // matching a bank transfer to a sub-order is the whole point of this screen.
    const asTheGuestSeesIt = await guestStatus(link.token, first.order.order_token)
    expect(rowA.reference).toBe(asTheGuestSeesIt.payment.reference)
    expect(rowA.reference).toBe(`G${first.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)

    // The aggregate is what the admin is still owed by guests in this cycle.
    expect(overview.totals).toEqual({ count: 2, total: 25 + 37.5 })

    // The order_token is the guest's private credential and never leaks here.
    expect(JSON.stringify(overview)).not.toContain(first.order.order_token)

    // Paying the rest empties the list.
    expect((await setPaid(first.order.id, true)).status()).toBe(200)
    expect((await setPaid(second.order.id, true)).status()).toBe(200)
    const settled = await unpaidOverview(cycle.id)
    expect(settled.unpaid).toEqual([])
    expect(settled.totals).toEqual({ count: 0, total: 0 })
  })

  test('paid + cancelled sub-orders surface as a refund queue', async () => {
    const { host, cycle, product, link } = await scenario('refundqueue')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)
    expect((await ctx.put(`/api/guest/${link.token}/orders/${created.order.order_token}`, { data: { items: [] } })).status()).toBe(200)

    const overview = await unpaidOverview(cycle.id)
    expect(overview.unpaid.map((r) => r.id), 'a cancelled order is not owed for').not.toContain(created.order.id)
    // Money with no live order behind it: the admin has to give it back, and this
    // is the only screen where that state is visible at all.
    const refund = overview.refunds.find((r) => r.id === created.order.id)
    expect(refund, 'paid + cancelled is a refund, not a silent nothing').toBeTruthy()
    // Cancelling ZEROED `total` (GSO-T4/T5) — so the amount to give back has to be
    // recomputed from the KEPT item rows, which is precisely why they are kept.
    expect(refund.total, 'the stored total is zeroed by the cancellation').toBe(0)
    expect(refund.amount, 'the refundable amount, recovered from the item rows').toBe(10)
    expect(refund.reference).toBe(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    expect(refund.host.id).toBe(host.id)
    expect(overview.refund_totals).toEqual({ count: 1, total: 10 })

    // Once refunded (flag cleared) it leaves the queue — and does NOT reappear as
    // an unpaid debt, because it is cancelled.
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    const after = await unpaidOverview(cycle.id)
    expect(after.refunds).toEqual([])
    expect(after.unpaid.map((r) => r.id)).not.toContain(created.order.id)
  })

  test('a cycle that does not exist is a 404', async () => {
    expect((await admin('/api/guest-orders/cycle/99999999/unpaid')).status()).toBe(404)
  })
})

test.describe('unpaid_count in GET /api/cycles includes guest sub-orders (UC-GSO-010)', () => {
  test('guest sub-orders raise unpaid_count while orders_count stays untouched', async () => {
    // ⚠ THE JOIN TRAP: `orders_count` and `unpaid_count` come out of ONE aggregate
    // over `LEFT JOIN orders`. A second LEFT JOIN onto the guest tables multiplies
    // the rows and silently inflates `orders_count` too, which no "unpaid went up"
    // assertion would catch. So the friend-order count is pinned at every step.
    const { host, cycle, product, link } = await scenario('count', { productData: { stock_limit_g: 100000 } })
    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const baseline = await cycleRow(cycle.id)
    expect(baseline.orders_count, 'one friend order').toBe(1)
    expect(baseline.unpaid_count, 'and it is unpaid').toBe(1)

    const g1 = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const g2 = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Druhy Kolega', guest_phone: '0905 111 222',
    })

    const withGuests = await cycleRow(cycle.id)
    expect(withGuests.orders_count, 'guest sub-orders are NOT friend orders — this must not move').toBe(1)
    expect(withGuests.unpaid_count, 'one friend + two guests owe money').toBe(3)
    expect(withGuests.guest_unpaid_count, 'and the guest share is visible on its own').toBe(2)

    // Each flag flip moves unpaid_count by exactly one, and orders_count by none.
    expect((await setPaid(g1.order.id, true)).status()).toBe(200)
    let row = await cycleRow(cycle.id)
    expect(row.unpaid_count).toBe(2)
    expect(row.orders_count).toBe(1)

    const ownOrder = (await adminOrders(cycle.id)).find((o) => o.friend_id === host.id)
    expect((await admin(`/api/orders/${ownOrder.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    row = await cycleRow(cycle.id)
    expect(row.unpaid_count, 'only the second guest is left').toBe(1)
    expect(row.orders_count).toBe(1)

    // A cancelled sub-order owes nothing (consistent with helpers/stock.js).
    expect((await ctx.delete(`/api/guest-orders/${g2.order.id}`, { headers: host.auth })).status()).toBe(200)
    row = await cycleRow(cycle.id)
    expect(row.unpaid_count, 'a cancelled sub-order is not an outstanding debt').toBe(0)
    expect(row.guest_unpaid_count).toBe(0)
    expect(row.orders_count, 'still exactly the one friend order').toBe(1)

    // And the roastery breakdown (the same endpoint's other aggregate): as of GSO-T8
    // it INCLUDES guest bags, because they are bought from the same roastery and this
    // is a figure the admin orders by. Here that is 1 × 250g of friend coffee plus
    // g1's still-active 1 × 250g = 0.5 kg; g2 is cancelled and contributes nothing.
    //
    // ⚠ It must be a SUM, never a MULTIPLICATION. Pulling the guest tables into this
    // endpoint's `LEFT JOIN orders` aggregate would multiply the friend line by the
    // number of guest sub-order rows (2 here, the cancelled one included) and read
    // 0.75+; GSO-T8 therefore merges the guest half in JavaScript instead of adding a
    // join. guest-aggregation.spec.js pins the unambiguous case (1 friend + 2 × 1
    // guest kg = 3.0, where a multiplied friend line would read 4.0).
    const coffee = row.roastery_breakdown.reduce((sum, r) => sum + r.total_kg, 0)
    expect(coffee, 'friend 0.25 + active guest 0.25 — summed, not multiplied').toBe(0.5)
  })
})

test.describe('GET /api/orders/cycle/:cycleId — sub-orders nested under their host (UC-GSO-009)', () => {
  test('each host order carries its guest sub-orders, with items and both flags', async () => {
    const { host, cycle, product, link } = await scenario('nested')
    const other = await makeHost('nestedother')
    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect((await ctx.patch(`/api/guest-orders/${created.order.id}/delivered`, {
      headers: host.auth, data: { delivered: true },
    })).status()).toBe(200)

    const orders = await adminOrders(cycle.id)
    const hostRow = orders.find((o) => o.friend_id === host.id)
    expect(hostRow.status).toBe('submitted')
    expect(hostRow.guest_orders.length).toBe(1)
    const sub = hostRow.guest_orders[0]
    expect(sub.guest_name).toBe(IDENTITY.guest_name)
    expect(sub.total).toBe(20)
    expect(sub.paid, 'the admin toggles this one').toBe(0)
    expect(sub.delivered, 'the host\'s tick, read-only for the admin').toBe(1)
    expect(sub.items.length).toBe(1)
    expect(sub.items[0].product_name).toBe(product.name)
    expect(sub.items[0].quantity).toBe(2)

    // A friend with no guests gets an empty array, never undefined.
    const otherRow = orders.find((o) => o.friend_id === other.id)
    expect(otherRow.guest_orders).toEqual([])

    // The host's OWN total is untouched by their guests' money (§UC-GSO-006).
    expect(hostRow.total, 'own items only: 1 × 250g at 10').toBe(10)
    // And the guest's private status token still never reaches an admin surface.
    expect(JSON.stringify(orders)).not.toContain(created.order.order_token)
  })

  test('a host with guest sub-orders but no own order is still visible', async () => {
    // §Edge Cases: "host has no own order at lock time" — their guests must not
    // vanish from the admin's orders tab just because the host ordered nothing.
    const { host, cycle, product, link } = await scenario('noown')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    const hostRow = (await adminOrders(cycle.id)).find((o) => o.friend_id === host.id)
    expect(hostRow.status, 'no own order').toBe('none')
    expect(hostRow.guest_orders.map((s) => s.id)).toEqual([created.order.id])
  })

  test('a DEACTIVATED host still carries their sub-orders (the money must not vanish)', async () => {
    // The ordinary "friend without an order" placeholders are built from ACTIVE
    // friends only, so a deactivated host needs a row of their own — their link
    // 410s for new guests, but the sub-orders already placed still have to be paid
    // for and handed over. Without that row the admin's orders tab would silently
    // lose them.
    const { host, cycle, product, link } = await scenario('deadhost')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: 0 } })).status()).toBe(200)

    const rows = await adminOrders(cycle.id)
    const hostRows = rows.filter((o) => o.friend_id === host.id)
    expect(hostRows.length, 'exactly one row for the host, never a duplicate').toBe(1)
    expect(hostRows[0].friend_name).toBe(host.name)
    expect(hostRows[0].guest_orders.map((s) => s.id)).toEqual([created.order.id])
    // The unpaid overview shows them too, flagged as an inactive host.
    const overview = await unpaidOverview(cycle.id)
    const owed = overview.unpaid.find((r) => r.id === created.order.id)
    expect(owed, 'a deactivated host\'s guest still owes the admin').toBeTruthy()
    expect(owed.host.active).toBe(0)
  })
})

test.describe('A PAID sub-order is frozen against item edits', () => {
  // ⚠ THE MONEY-VISIBILITY RULE, the sibling of GSO-T5's DELETE guard. `paid` says
  // "this amount arrived"; there is nowhere to record a DIFFERENT amount, so if the
  // guest could re-price their cart after being marked paid, they would owe (or be
  // owed) a difference that appears on NO admin surface: `unpaid_count` stays 0, the
  // unpaid list stays empty, and the nested row reads "90.00 EUR ✓ zaplatené".
  //
  // The rule is deliberately NARROW: a non-empty edit is refused, but the literal
  // `items: []` CANCEL stays open — it is the guest's own money, "contact the admin"
  // is real friction on an accountless surface, and a cancellation does surface, in
  // the refund queue. So: you may call the whole thing off, you may not silently
  // change what you owe.
  const editItems = (link, orderToken, items) =>
    ctx.put(`/api/guest/${link.token}/orders/${orderToken}`, { data: { items } })

  test('a non-empty edit on a paid sub-order is 409 reason: paid and changes nothing', async () => {
    const { host, cycle, product, link } = await scenario('frozen', { productData: { stock_limit_g: 100000 } })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect(created.order.total).toBe(10)
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    const res = await editItems(link, created.order.order_token, [
      { product_id: product.id, variant: '1kg', quantity: 3 },
    ])
    expect(res.status(), 'what is owed cannot change after the payment was recorded').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('paid')
    expect(body.error, 'the message points the guest at the admin').toContain('správcom')

    // DB re-read: the amount, the items and the flag are exactly as they were.
    const row = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(row.total, 'still the amount that was actually paid').toBe(10)
    expect(row.paid).toBe(1)
    expect(row.status).toBe('submitted')
    expect(row.items.length).toBe(1)
    expect(row.items[0].variant).toBe('250g')
    expect(row.items[0].quantity).toBe(1)

    // The guest's own page reports the unchanged order too.
    const status = await guestStatus(link.token, created.order.order_token)
    expect(status.order.total).toBe(10)
    expect(status.items[0].quantity).toBe(1)

    // Clearing the flag (a mis-matched payment) unfreezes the order — the guard is
    // a function of the current state, not a terminal condition.
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    const reopened = await editItems(link, created.order.order_token, [
      { product_id: product.id, variant: '1kg', quantity: 3 },
    ])
    expect(reopened.status(), 'an unpaid sub-order is editable as before').toBe(200)
    expect((await reopened.json()).order.total).toBe(90)
  })

  test('an explicit items: [] still cancels a paid sub-order, and the refund amount does not drift', async () => {
    const { host, cycle, product, link } = await scenario('paidcancel', { productData: { stock_limit_g: 100000 } })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    // Edited while still UNPAID (allowed), so the amount finally paid is 90 …
    expect((await editItems(link, created.order.order_token, [
      { product_id: product.id, variant: '1kg', quantity: 3 },
    ])).status()).toBe(200)
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    const cancelled = await editItems(link, created.order.order_token, [])
    expect(cancelled.status(), 'calling the whole thing off stays the guest\'s own decision').toBe(200)
    const payload = await cancelled.json()
    expect(payload.order.status).toBe('cancelled')
    expect(payload.order.paid, 'paid survives — it is the refund signal').toBe(1)

    // … and 90 is what the refund queue asks the admin to return: the amount cannot
    // drift away from what was paid, precisely because the edit above is now blocked
    // once `paid` is set.
    const overview = await unpaidOverview(cycle.id)
    const refund = overview.refunds.find((r) => r.id === created.order.id)
    expect(refund.amount).toBe(90)
    expect(overview.unpaid.map((r) => r.id), 'a cancelled order is not chased for money').not.toContain(created.order.id)
    expect((await subOrderFromHostView(host, cycle.id, created.order.id)).status).toBe('cancelled')
  })

  test('UI: a paid sub-order offers no edit affordance, but can still be cancelled', async ({ page }) => {
    const { product, link } = await scenario('paidui')
    const unpaidOrder = (await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])).order
    const paidOrder = (await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Zaplatena Pani', guest_phone: '0906 111 222',
    })).order
    expect((await setPaid(paidOrder.id, true)).status()).toBe(200)

    // Unpaid: the edit button is offered, as GSO-T4 shipped it.
    await page.goto(`/g/${link.token}/o/${unpaidOrder.order_token}`)
    await expect(page.getByTestId('start-edit')).toBeVisible()

    // Paid: no edit affordance — the backend would refuse it — but the page says why
    // and still offers the cancel the backend DOES accept.
    await page.goto(`/g/${link.token}/o/${paidOrder.order_token}`)
    await expect(page.getByTestId('status-paid')).toContainText('Zaplatené')
    await expect(page.getByTestId('start-edit'), 'the affordance must not lie').toHaveCount(0)
    await expect(page.getByTestId('paid-locked')).toBeVisible()
    await expect(page.getByTestId('paid-locked')).toContainText('správcom')
    await expect(page.getByTestId('cancel-order')).toBeVisible()
  })
})

test.describe('GSO-T5\'s paid-cancel guard, now through the real API', () => {
  test('a host cannot remove a sub-order the admin marked paid (409 reason: paid)', async () => {
    // GSO-T5 had to pre-set `paid` by writing the server's SQLite file, because
    // no HTTP setter existed. It does now, so the guard is exercised exactly as it
    // will be in production: admin marks paid → host tries to remove → 409.
    const { host, cycle, product, link } = await scenario('t5guard', { productData: { stock_limit_g: 1000 } })
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    const res = await ctx.delete(`/api/guest-orders/${created.order.id}`, { headers: host.auth })
    expect(res.status(), 'a paid sub-order cannot be removed by the host').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('paid')
    expect(body.error, 'the message points the host at the admin').toContain('správcom')

    // Nothing moved: still live, still owed for, stock still held.
    const row = await subOrderFromHostView(host, cycle.id, created.order.id)
    expect(row.status).toBe('submitted')
    expect(row.total).toBe(20)
    expect(row.paid).toBe(1)
    const availability = await ctx.get(`/api/products/cycle/${cycle.id}/availability`)
    expect((await availability.json()).find((a) => a.product_id === product.id).remaining_g).toBe(500)

    // Once the admin clears the flag (e.g. the payment was matched to the wrong
    // order), the removal the host asked for goes through.
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    expect((await ctx.delete(`/api/guest-orders/${created.order.id}`, { headers: host.auth })).status()).toBe(200)
    expect((await subOrderFromHostView(host, cycle.id, created.order.id)).status).toBe('cancelled')
  })
})

// ---- UI: the admin cycle detail, orders tab ----------------------------------

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

test.describe('Admin cycle detail UI — nested sub-orders (UC-GSO-009..010)', () => {
  let ui

  test.beforeAll(async () => {
    const built = await scenario('ui')
    await submitOwnOrder(built.host, built.cycle.id, [{ product_id: built.product.id, variant: '250g', quantity: 1 }])
    const guestA = await submitGuest(built.link.token, [{ product_id: built.product.id, variant: '250g', quantity: 2 }])
    const guestB = await submitGuest(built.link.token, [{ product_id: built.product.id, variant: '1kg', quantity: 1 }], {
      guest_name: 'Jana UI', guest_phone: '0902 333 444',
    })
    // The host has handed guest B's bag over — the admin must see that, read-only.
    expect((await ctx.patch(`/api/guest-orders/${guestB.order.id}/delivered`, {
      headers: built.host.auth, data: { delivered: true },
    })).status()).toBe(200)
    // A third guest with TWO product lines — the one that proves the expanded
    // sub-order renders one row per product rather than a single run-on line.
    const guestC = await submitGuest(built.link.token, [
      { product_id: built.product.id, variant: '250g', quantity: 3 },
      { product_id: built.product.id, variant: '1kg', quantity: 1 },
    ], { guest_name: 'Zuzka UI', guest_phone: '0903 555 666' })
    ui = { ...built, guestA: guestA.order, guestB: guestB.order, guestC: guestC.order }
  })

  test('sub-orders nest under the host with a guest badge, a paid toggle and a read-only delivered state', async ({ page }) => {
    await loginAsAdminUI(page)

    await page.goto(`/admin/cycle/${ui.cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    // The host's own order row is there, and both sub-orders hang off it.
    await expect(page.getByRole('cell', { name: ui.host.name, exact: true })).toBeVisible()
    const rowA = page.locator(`[data-testid="guest-suborder-${ui.guestA.id}"]`)
    const rowB = page.locator(`[data-testid="guest-suborder-${ui.guestB.id}"]`)
    await expect(rowA).toBeVisible()
    await expect(rowB).toBeVisible()

    // The badge names the host who invited them ("Hosť • pozval Peto").
    await expect(rowA).toContainText('Hosť')
    await expect(rowA).toContainText('pozval Peto')
    await expect(rowA).toContainText(IDENTITY.guest_name)
    await expect(rowA).toContainText('20.00 EUR')

    // Delivered is READ-ONLY for the admin: a state, not a control.
    await expect(rowB.getByTestId(`guest-delivered-state-${ui.guestB.id}`)).toContainText('Odovzdané')
    await expect(rowA.getByTestId(`guest-delivered-state-${ui.guestA.id}`)).toContainText('Neodovzdané')
    await expect(rowA.locator('input[type="checkbox"]'), 'no delivered control on the admin side').toHaveCount(0)
    // Exactly two controls: the expand chevron (view-only) and the paid toggle
    // (the admin's one flag). `delivered` stays a rendered state, never a control.
    await expect(rowA.locator('button')).toHaveCount(2)
    await expect(rowA.getByTestId(`guest-expand-${ui.guestA.id}`)).toBeVisible()
    await expect(rowA.getByTestId(`guest-paid-toggle-${ui.guestA.id}`)).toBeVisible()

    // The paid toggle persists across a reload (it is server state, not a ref).
    const paidToggle = rowA.getByTestId(`guest-paid-toggle-${ui.guestA.id}`)
    await expect(paidToggle).toHaveAttribute('aria-pressed', 'false')
    await paidToggle.click()
    await expect(paidToggle).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await page.getByRole('tab', { name: 'Objednávky' }).click()
    await expect(page.locator(`[data-testid="guest-paid-toggle-${ui.guestA.id}"]`)).toHaveAttribute('aria-pressed', 'true')

    // The unpaid overview lists the one guest who still owes money, with the
    // reference the admin matches the bank transfer by.
    const overview = page.getByTestId('guest-unpaid-overview')
    await expect(overview).toBeVisible()
    await expect(overview).toContainText('Jana UI')
    await expect(overview).toContainText(`G${ui.guestB.id} / Jana UI / ${ui.cycle.name}`)
    await expect(overview).toContainText(ui.host.name)
    await expect(overview).toContainText('0902 333 444')
    await expect(overview, 'the guest who has now paid is off the list').not.toContainText(IDENTITY.guest_name)

    // Unticking puts them back on it.
    await page.locator(`[data-testid="guest-paid-toggle-${ui.guestA.id}"]`).click()
    await expect(overview).toContainText(IDENTITY.guest_name)
  })

  // A host can have several colleagues under them, so the admin checks one bag
  // list at a time — the same collapse/expand affordance the host's own order has.
  // Independence matters: `expandedGuestOrders` is keyed by `guest_orders.id`, a
  // sequence of its own, so a shared key with `orders.id` would make one chevron
  // silently open somebody else's list.
  test('each guest sub-order expands independently, one product per row', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${ui.cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    const itemsA = page.getByTestId(`guest-suborder-items-${ui.guestA.id}`)
    const itemsC = page.getByTestId(`guest-suborder-items-${ui.guestC.id}`)

    // Collapsed by default: the header row carries a count, not the products. The
    // count is of LINES (2 here, from 3 + 1 pieces) — it labels the list about to
    // be expanded, so it must match the number of rows that appear.
    await expect(itemsC).toHaveCount(0)
    await expect(page.getByTestId(`guest-suborder-${ui.guestC.id}`)).toContainText('2 položky')

    await page.getByTestId(`guest-expand-${ui.guestC.id}`).click()
    await expect(itemsC).toBeVisible()

    // One row per product line, in the same format as the host's own items.
    const lines = itemsC.locator('div.flex.justify-between')
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0)).toContainText(`${ui.product.name} (250g)`)
    await expect(lines.nth(0)).toContainText('3 ×')
    await expect(lines.nth(1)).toContainText(`${ui.product.name} (1kg)`)

    // Expanding one guest neither expands nor collapses their neighbour.
    await expect(itemsA).toHaveCount(0)
    await page.getByTestId(`guest-expand-${ui.guestA.id}`).click()
    await expect(itemsA).toBeVisible()
    await expect(itemsC, 'the first list stays open').toBeVisible()

    await page.getByTestId(`guest-expand-${ui.guestC.id}`).click()
    await expect(itemsC, 'and collapses back on its own').toHaveCount(0)
    await expect(itemsA).toBeVisible()
  })
})

// The guest-unpaid Card sits ABOVE the orders tab's v-if/v-else-if/v-else chain
// (empty state / product view / friend view) — see the comment at its call site in
// CycleDetail.vue. An earlier version had it INSIDE the chain, which silently broke
// BOTH order tables whenever the card was shown. An API test cannot see this: the
// payloads it would check are identical either way, only the DOM breaks. So this is
// asserted directly in the browser, across all three states the chain can be in.
test.describe('Admin cycle detail UI — the guest card must not break the order tables', () => {
  // All three fixtures are built via the API up front, BEFORE any test logs in
  // through the UI form — see refreshAdminToken(): a UI login overwrites the one
  // live admin session, so building fixtures lazily inside a later test body would
  // race against an earlier test's UI login and 401.
  let noSubmitCycle, noGuests, cardUp

  test.beforeAll(async () => {
    await refreshAdminToken()

    noSubmitCycle = await makeCycle('nosubmit')

    noGuests = await scenario('noguests')
    await submitOwnOrder(noGuests.host, noGuests.cycle.id, [{ product_id: noGuests.product.id, variant: '250g', quantity: 1 }])

    cardUp = await scenario('cardup')
    await submitOwnOrder(cardUp.host, cardUp.cycle.id, [{ product_id: cardUp.product.id, variant: '250g', quantity: 1 }])
    cardUp.guest = (await submitGuest(cardUp.link.token, [{ product_id: cardUp.product.id, variant: '250g', quantity: 1 }])).order
  })

  // NOTE: `orders.length === 0` (the literal "Zatiaľ žiadne objednávky" branch) means
  // zero ACTIVE FRIENDS EXIST AT ALL, not "nobody in this cycle has ordered yet" —
  // `orders` carries one row per active friend (status 'none' included), scoped by
  // cycle. A shared, already-seeded server always has active friends, so that branch
  // is unreachable here; the meaningful "nothing submitted yet" state is a cycle with
  // zero SUBMITTED orders, which still renders the (empty) table scaffold below.
  test('a fresh cycle with nothing submitted yet: no card, empty table scaffold still renders', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${noSubmitCycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    await expect(page.getByTestId('guest-unpaid-overview'), 'nobody to chase, so no card').toHaveCount(0)
    // No view toggle either — with nothing submitted there is nothing to switch between.
    await expect(page.getByRole('button', { name: 'Podľa produktu' })).toHaveCount(0)

    // The friend-view table (the v-else branch) still renders its scaffold — headers
    // and an empty total row — rather than erroring or vanishing.
    await expect(page.getByRole('columnheader', { name: 'Priateľ' })).toBeVisible()
    await expect(page.getByRole('row', { name: /Celkom/ })).toBeVisible()
    await expect(page.locator('[data-testid^="guest-suborder-"]')).toHaveCount(0)
  })

  test('orders with no guest sub-orders: card absent, both views still render', async ({ page }) => {
    const { host, cycle, product } = noGuests
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    await expect(page.getByTestId('guest-unpaid-overview'), 'nobody to chase, so no card').toHaveCount(0)

    // Friend view (default): the host's own row, no violet guest rows.
    await expect(page.getByRole('columnheader', { name: 'Priateľ' })).toBeVisible()
    await expect(page.getByRole('cell', { name: host.name, exact: true })).toBeVisible()
    await expect(page.locator('[data-testid^="guest-suborder-"]')).toHaveCount(0)

    // Product view renders too — the toggle and the table are not casualties of a
    // chain the card never joins in this state, but worth pinning anyway.
    await page.getByRole('button', { name: 'Podľa produktu' }).click()
    await expect(page.getByRole('columnheader', { name: 'Produkt' })).toBeVisible()
    await expect(page.getByRole('cell', { name: product.name })).toBeVisible()
  })

  test('orders WITH unpaid guest sub-orders: card visible, BOTH order tables still render', async ({ page }) => {
    // The exact shape that broke before the fix: the card's v-if is true.
    const { cycle, product, guest } = cardUp
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${cycle.id}`)
    await page.getByRole('tab', { name: 'Objednávky' }).click()

    const overview = page.getByTestId('guest-unpaid-overview')
    await expect(overview, 'the card is showing — this is the state that used to break the chain').toBeVisible()

    // Friend view renders with the card up: host row + nested guest sub-order.
    await expect(page.getByRole('columnheader', { name: 'Priateľ' })).toBeVisible()
    await expect(page.locator(`[data-testid="guest-suborder-${guest.id}"]`)).toBeVisible()

    // Switching to product view with the card STILL up is the exact regression:
    // an independent v-if ahead of the chain used to swallow the v-else-if/v-else
    // links, so this table silently stopped rendering whenever the card showed.
    await page.getByRole('button', { name: 'Podľa produktu' }).click()
    await expect(overview, 'the card does not depend on which order view is active').toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'Produkt' })).toBeVisible()
    await expect(page.getByRole('cell', { name: product.name })).toBeVisible()

    // And back to friend view — still up, still rendering, on the same load.
    await page.getByRole('button', { name: 'Podľa priateľa' }).click()
    await expect(page.getByRole('columnheader', { name: 'Priateľ' })).toBeVisible()
    await expect(page.locator(`[data-testid="guest-suborder-${guest.id}"]`)).toBeVisible()
  })
})
