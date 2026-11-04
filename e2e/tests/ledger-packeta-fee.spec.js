// PO 2026-10-01 — the Packeta fee is part of a friend's debt in the LEDGER.
//
// A friend who ordered Packeta transfers goods + fee. Until this date both ledger
// legs (`PATCH /orders/:id/paid` and `helpers/packing.js`) posted `orders.total`
// alone, so marking such an order paid recorded LESS than the friend paid (the
// admin saw „+38.17 EUR" against a 41.57 EUR order). Both legs now post
// `orderLedgerAmount()` = goods + fee, every reversal negates what its leg POSTED
// (`orders.paid_amount` / `orders.packed_amount`, NULL = pre-2026-10-01 = total),
// and a Packeta → pickup switch on a PACKED order posts the fee back
// (`repriceCharge`, „Packeta zrušená").
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const FEE = 3.4
const PRICE = 19.08 // × 2 = 38.16 goods

let ctx = null
let adminToken = ''
// FUP-T27 / WA-T12: the ONE admin request path (`helpers/admin.js makeAdmin`) — re-authenticates once on a 401
// and publishes the fresh token back into `adminToken` (was a private `adminReq` copy, §5 of admin-token-retry).
const adminReq = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

let seq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++seq}`
  const username = `fee_${label.toLowerCase()}`.slice(0, 30 - suffix.length) + suffix
  const created = await adminReq('/api/friends', { method: 'post', data: { name: `Fee ${label} ${uniq}`, phone: '0900 000 001' } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await adminReq(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await adminReq(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
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
  return { id: row.id, auth: { Authorization: `Bearer ${token}` } }
}

/** An open parcel-enabled cycle with one product, and a SUBMITTED order on it. */
async function orderFor(friend, { packeta = true } = {}) {
  const c = await adminReq('/api/cycles', { method: 'post', data: { name: `E2E FEE ${uniq} ${++seq}`, type: 'coffee', status: 'open' } })
  expect(c.status(), 'cycle create').toBe(201)
  const cycle = await c.json()
  expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: FEE } })).status()).toBe(200)
  const p = await adminReq('/api/products', { method: 'post', data: { cycle_id: cycle.id, name: `Fee kava ${uniq} ${seq}`, purpose: 'Filter', price_250g: PRICE } })
  expect(p.status(), 'product').toBe(201)
  const product = await p.json()
  const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
    headers: friend.auth, data: { items: [{ product_id: product.id, variant: '250g', quantity: 2 }] }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart').toBe(200)
  const sub = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, {
    headers: friend.auth,
    data: packeta ? { use_parcel_delivery: true, packeta_address: 'Z-Box Ružinov, Bratislava' } : {},
    timeout: TIMEOUT,
  })
  expect(sub.status(), 'submit').toBe(200)
  const order = (await sub.json()).order
  expect(order.delivery_fee, 'fixture is honest about the fee').toBe(packeta ? FEE : 0)
  return { cycle, order }
}

async function ledger(friend) {
  const res = await ctx.get(`/api/transactions/friend/${friend.id}`, { headers: friend.auth, timeout: TIMEOUT })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const rows = Array.isArray(body) ? body : body.transactions || []
  const balance = Math.round(rows.reduce((s, t) => s + t.amount, 0) * 100) / 100 + 0 // + 0: no -0
  return { rows, balance }
}

const togglePaid = async (order, paid) =>
  expect((await adminReq(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid } })).status()).toBe(200)

async function pack(cycle, friend, order) {
  const dist = await (await adminReq(`/api/cycles/${cycle.id}/distribution`)).json()
  const party = dist.distribution.find((p) => p.id === friend.id)
  for (const item of party.items) {
    if (!item.packed) expect((await adminReq(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  expect((await adminReq(`/api/orders/${order.id}/packed`, { method: 'patch' })).status(), 'pack').toBe(200)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})
test.afterAll(async () => { await ctx?.dispose() })

test('paid records goods + Packeta fee, packing charges the same, the friend nets to 0', async () => {
  const friend = await makeFriend('Paid')
  const { cycle, order } = await orderFor(friend)
  const full = Math.round((order.total + FEE) * 100) / 100

  await togglePaid(order, true)
  let l = await ledger(friend)
  expect(l.rows.find((t) => t.type === 'payment').amount, 'the payment is the WHOLE transfer').toBe(full)
  expect(l.balance, 'paid before packing ⇒ the friend is in credit by the whole transfer').toBe(full)

  await pack(cycle, friend, order)
  l = await ledger(friend)
  expect(l.rows.find((t) => t.type === 'charge').amount, 'the charge is goods + fee too').toBe(-full)
  expect(l.balance, 'paid + packed Packeta order settles exactly').toBe(0)

  // Both reversals negate exactly what was posted.
  await togglePaid(order, false)
  expect((await ledger(friend)).balance).toBe(-full)
  expect((await adminReq(`/api/orders/${order.id}/packed`, { method: 'patch' })).status(), 'unpack').toBe(200)
  expect((await ledger(friend)).balance, 'pack→unpack and paid→unpaid both net to 0').toBe(0)
})

test('an order without Packeta is unchanged: goods only', async () => {
  const friend = await makeFriend('Pickup')
  const { order } = await orderFor(friend, { packeta: false })
  await togglePaid(order, true)
  const l = await ledger(friend)
  expect(l.rows.find((t) => t.type === 'payment').amount).toBe(order.total)
})

test('Packeta → pickup on a PACKED + PAID order posts the fee back; the fee stays a credit (refund owed)', async () => {
  const friend = await makeFriend('Switch')
  const { cycle, order } = await orderFor(friend)
  const full = Math.round((order.total + FEE) * 100) / 100
  await togglePaid(order, true)
  await pack(cycle, friend, order)
  expect((await ledger(friend)).balance).toBe(0)

  const loc = await adminReq('/api/pickup-locations', { method: 'post', data: { name: `Fee miesto ${uniq}`, address: 'Testovacia 1' } })
  expect(loc.status()).toBe(201)
  const res = await adminReq(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/pickup`, {
    method: 'patch', data: { pickup_location_id: (await loc.json()).id },
  })
  expect(res.status()).toBe(200)
  expect((await res.json()).parcel_fee_removed).toBe(FEE)

  let l = await ledger(friend)
  const back = l.rows.find((t) => t.note === 'Packeta zrušená')
  expect(back, 'one correction row').toBeTruthy()
  expect(back.amount).toBe(FEE)
  expect(l.balance, 'the friend paid the fee for a parcel nobody sends ⇒ credit = refund').toBe(FEE)

  // Unpack now reverses the CORRECTED charge (goods only), unpaid the posted payment.
  expect((await adminReq(`/api/orders/${order.id}/packed`, { method: 'patch' })).status()).toBe(200)
  await togglePaid(order, false)
  l = await ledger(friend)
  expect(l.balance, 'every leg reversed exactly what it posted').toBe(0)
  expect(l.rows.filter((t) => t.type === 'payment').map((t) => t.amount).sort()).toEqual([-full, full].sort())
})

test('a leg posted BEFORE 2026-10-01 (no stored amount) is reversed by the old goods-only rule', async () => {
  test.skip(!process.env.DB_PATH, 'needs DB_PATH to build a pre-migration row')
  const friend = await makeFriend('Legacy')
  const { order } = await orderFor(friend)
  await togglePaid(order, true)
  // Rewrite it into the shape the old code left: payment = total, nothing stored.
  const db = new DatabaseSync(process.env.DB_PATH)
  db.prepare("UPDATE transactions SET amount = ? WHERE order_id = ? AND type = 'payment'").run(order.total, order.id)
  db.prepare('UPDATE orders SET paid_amount = NULL WHERE id = ?').run(order.id)
  db.close()
  expect((await ledger(friend)).balance).toBe(order.total)

  await togglePaid(order, false)
  expect((await ledger(friend)).balance, 'the legacy payment is reversed exactly').toBe(0)
})
