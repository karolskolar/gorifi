import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding } from '../helpers/portal.js'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'
// ⚠ CROSS-TREE IMPORT, DELIBERATE — the same precedent (and the same reason) as
// `guest-payment-modal.spec.js`: `bysquare` and `qrcode` are the FRONTEND's own
// dependencies, and the point of the QR assertion below is that the bytes the
// browser painted are the bytes these libraries produce for a 2-decimal amount.
// A second copy under `e2e/` would let the two drift.
import { encode, decode, PaymentOptions, CurrencyCode, Version } from '../../frontend/node_modules/bysquare/lib/index.js'
import QRCode from '../../frontend/node_modules/qrcode/lib/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// THE PRODUCTION MONEY BUG, and the rule that closes it.
//
// Reported by a real user with a screenshot: the success modal said
// `Suma na úhradu: 26.19 EUR` and her banking app refused the Pay-by-Square QR
// with `Nesprávna suma: 26.189999999999998`. Her order was one 15.00 line and one
// 11.19 line, and in IEEE-754:
//
//     node -e "console.log(15.00 + 11.19)"   →  26.189999999999998
//
// Per-ITEM prices were already rounded (`helpers/pricing.js applyMarkup`); the SUM
// was not (`routes/orders.js`: `total += price * quantity`, then stored raw). Every
// DISPLAY hid it behind `toFixed(2)`, so the only surface that could ever show the
// defect was the one that does not format — the QR, i.e. the bank.
//
// The PO's instruction: "Všetky sumy by mali byť zaokrúhlené na 2 desatinné
// miesta." So the rule now has ONE home on each side —
// `backend/src/helpers/pricing.js roundMoney()` and `frontend/src/lib/money.js
// roundMoney()` — and this file pins it at the places where an unrounded value
// actually reaches a person: the stored order total, the ledger rows that inherit
// it, the friend's balance, and the QR payload.
//
// ⚠ WHY EVERY ASSERTION IS `toBe(round2(v))` AND NEVER `toBeCloseTo`.
// `toBeCloseTo(26.19, 2)` passes on 26.189999999999998 — it is the assertion this
// bug would have walked straight through. The check here is exact double identity:
// a value is 2-decimal iff it IS the double `Math.round(v * 100) / 100`.
//
// ⚠ NOTE ON THE BALANCE TEST. Pack-then-pay through the two toggles cannot see the
// bug at all: both post the SAME unrounded `order.total`, once negated, so they
// cancel to exactly 0 either way. The revealing shape is the real one — the admin
// records the bank transfer of the amount the friend was ASKED for (26.19) against
// a charge derived from the stored total. Pre-fix that leaves 1.78e-15 on the
// friend's balance forever.
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 20_000
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

const round2 = (v) => Math.round(v * 100) / 100

/** A value is "2-decimal" iff it is the very double `Math.round(v*100)/100` is. */
function expect2dp(value, label) {
  expect(typeof value, `${label} must be a number`).toBe('number')
  expect(value, `${label} = ${value} carries float noise past 2 decimals`).toBe(round2(value))
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

/**
 * A friend with real credentials and a Bearer session. Each test that touches a
 * BALANCE gets its own, because a balance is an account-wide sum — sharing one
 * friend would make "exactly 0" depend on test order.
 */
let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `money_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `Money ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
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
  return { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, over = {}) {
  const name = `E2E MONEY ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open', ...over } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

/** Parcel delivery is PATCH-only on `/api/cycles/:id` — POST ignores both fields. */
async function enableParcel(cycleId, fee) {
  const res = await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: fee } })
  expect(res.status(), 'enable parcel').toBe(200)
  return res.json()
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function cart(friend, cycleId, items) {
  const res = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(res.status(), 'cart PUT').toBe(200)
  return res.json()
}

async function submit(friend, cycleId, body = {}) {
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth, data: body, timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

async function ledger(friend) {
  const res = await ctx.get(`/api/transactions/friend/${friend.id}`, { headers: friend.auth, timeout: TIMEOUT })
  expect(res.status(), 'ledger').toBe(200)
  return res.json()
}

async function balance(friend) {
  const res = await ctx.get(`/api/friends/${friend.id}/balance`, { headers: friend.auth, timeout: TIMEOUT })
  expect(res.status(), 'balance').toBe(200)
  return (await res.json()).balance
}

/** The stored column, read straight off the file the server writes. */
function dbGet(sql, ...params) {
  const db = new DatabaseSync(DB_PATH)
  try {
    return db.prepare(sql).get(...params)
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ═══════════════════════════════════════════════════════════════════════════
// (A) the stored friend order total — the root cause

test.describe('the stored order total', () => {
  test('⚠ THE REGRESSION: 15.00 + 11.19 stores 26.19, never 26.189999999999998', async () => {
    const friend = await makeFriend('Petra')
    const cycle = await makeCycle('R1')
    const a = await addProduct(cycle.id, { name: `Colombia Sinaloa ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `Druha kava ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })

    const put = await cart(friend, cycle.id, [
      { product_id: a.id, variant: '1kg', quantity: 1 },
      { product_id: b.id, variant: '250g', quantity: 1 },
    ])

    // The two lines really are her numbers — otherwise the sum below could be
    // right for the wrong reason.
    const prices = put.items.map((i) => i.price).sort((x, y) => x - y)
    expect(prices, 'the per-item prices are hers').toEqual([11.19, 15])
    // …and this really is the shape that drifts in IEEE-754.
    expect(15.0 + 11.19, 'the raw JS sum still drifts — the fixture is honest').not.toBe(26.19)

    expect2dp(put.order.total, 'PUT order.total')
    expect(put.order.total, 'the cart PUT stores the rounded sum').toBe(26.19)

    const order = await submit(friend, cycle.id)
    expect2dp(order.total, 'submitted order.total')
    expect(order.total).toBe(26.19)

    // The wire form the frontend actually parses.
    expect(JSON.stringify({ total: order.total })).toBe('{"total":26.19}')
  })

  test('⚠ the STORED COLUMN, not just the response', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    const friend = await makeFriend('PetraDb')
    const cycle = await makeCycle('R2')
    const a = await addProduct(cycle.id, { name: `Db Sinaloa ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `Db Druha ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })
    await cart(friend, cycle.id, [
      { product_id: a.id, variant: '1kg', quantity: 1 },
      { product_id: b.id, variant: '250g', quantity: 1 },
    ])
    const order = await submit(friend, cycle.id)

    const row = dbGet('SELECT total FROM orders WHERE id = ?', order.id)
    expect2dp(row.total, 'orders.total column')
    expect(row.total).toBe(26.19)
  })

  test('a three-line cart that drifts (9.04 + 13.33 + 11.19) stores 33.56', async () => {
    const friend = await makeFriend('Drift')
    const cycle = await makeCycle('R3')
    const p = []
    for (const [i, price] of [9.04, 13.33, 11.19].entries()) {
      p.push(await addProduct(cycle.id, { name: `Drift ${i} ${uniq}`, purpose: 'Espresso', price_250g: price }))
    }
    expect(9.04 + 13.33 + 11.19, 'the fixture drifts').not.toBe(33.56)

    await cart(friend, cycle.id, p.map((x) => ({ product_id: x.id, variant: '250g', quantity: 1 })))
    const order = await submit(friend, cycle.id)
    expect2dp(order.total, 'three-line order.total')
    expect(order.total).toBe(33.56)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (B) the ledger rows that INHERIT the order total, and the balance they build

test.describe('the ledger', () => {
  /** Her order, submitted, ready to be packed and paid. */
  async function herOrder(label) {
    const friend = await makeFriend(label)
    const cycle = await makeCycle(label)
    const a = await addProduct(cycle.id, { name: `${label} A ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `${label} B ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })
    await cart(friend, cycle.id, [
      { product_id: a.id, variant: '1kg', quantity: 1 },
      { product_id: b.id, variant: '250g', quantity: 1 },
    ])
    const order = await submit(friend, cycle.id)
    return { friend, cycle, order }
  }

  /** Every item must be ticked before the whole-order pack is allowed (GSO-T1). */
  async function packAll(cycleId, orderId) {
    const dist = await admin(`/api/cycles/${cycleId}/distribution`)
    expect(dist.status()).toBe(200)
    const party = (await dist.json()).distribution.find((d) => d.order_id === orderId)
    for (const item of party.items) {
      if (!item.packed) {
        expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
      }
    }
    const packed = await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })
    expect(packed.status(), 'whole-order pack').toBe(200)
  }

  test('the packing CHARGE is a 2-decimal value', async () => {
    const { friend, cycle, order } = await herOrder('Pack')
    await packAll(cycle.id, order.id)

    const rows = await ledger(friend)
    const charge = rows.find((t) => t.type === 'charge' && t.order_id === order.id)
    expect(charge, 'a charge was posted').toBeTruthy()
    expect2dp(charge.amount, 'transactions.amount (charge)')
    expect(charge.amount).toBe(-26.19)
  })

  test('the paid-toggle PAYMENT is a 2-decimal value, and its reversal too', async () => {
    const { friend, order } = await herOrder('Paid')

    expect((await admin(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    let rows = await ledger(friend)
    let payment = rows.find((t) => t.type === 'payment' && t.order_id === order.id)
    expect2dp(payment.amount, 'transactions.amount (payment)')
    expect(payment.amount).toBe(26.19)

    expect((await admin(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: false } })).status()).toBe(200)
    rows = await ledger(friend)
    const storno = rows.filter((t) => t.type === 'payment' && t.order_id === order.id)
    expect(storno.length, 'payment + reversal').toBe(2)
    for (const row of storno) expect2dp(row.amount, 'transactions.amount (payment/storno)')
    expect(round2(storno.reduce((s, r) => s + r.amount, 0)), 'they cancel').toBe(0)
  })

  test('⚠ balance is EXACTLY 0 after packing and paying the amount she was asked for', async () => {
    const { friend, cycle, order } = await herOrder('Balance')
    expect(await balance(friend), 'clean slate').toBe(0)

    await packAll(cycle.id, order.id)
    expect(await balance(friend), 'she owes the rounded total').toBe(-26.19)

    // The admin records the bank transfer for the amount the QR asked for. This is
    // the shape the two toggles cannot see: pack+pay both post the same stored
    // total, so they cancel whether or not it was rounded.
    const paid = await admin('/api/transactions/payment', {
      method: 'post',
      data: { friend_id: friend.id, amount: 26.19, note: 'Bankovy prevod' },
    })
    expect(paid.status(), 'record payment').toBe(201)

    const after = await balance(friend)
    expect(after, `settled to exactly zero, not ${after}`).toBe(0)
    expect(Object.is(after, 0) || Object.is(after, -0), 'a true zero').toBe(true)
  })

  test('⚠ a LEGACY unrounded orders.total still posts CLEAN ledger rows', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    // ⚠ THE REASON `roundMoney` STAYS IN `packing.js` AND ON THE PAID TOGGLE.
    // Against a fresh database those two calls are no-ops — `orders.total` is now
    // written rounded, so removing them changes nothing any HTTP test can see. But
    // every database that ran the old code still HOLDS unrounded totals, and these
    // two paths are how such a row enters a friend's real balance. So the row is
    // manufactured here exactly as production has it (the same idiom
    // `guest-rewards.spec.js` uses for its dangling `root_friend_id`).
    const { friend, cycle, order } = await herOrder('Legacy')

    const db = new DatabaseSync(DB_PATH)
    try {
      db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(15.0 + 11.19, order.id)
    } finally {
      db.close()
    }
    const legacy = dbGet('SELECT total FROM orders WHERE id = ?', order.id)
    expect(legacy.total, 'the fixture really is a pre-fix row').toBe(26.189999999999998)

    await packAll(cycle.id, order.id)
    const charge = (await ledger(friend)).find((t) => t.type === 'charge' && t.order_id === order.id)
    expect2dp(charge.amount, 'charge from a legacy row')
    expect(charge.amount).toBe(-26.19)

    // Unpack — the reversal must be the mirror of what was charged, or the friend is
    // left owing (or credited) a fraction of a cent forever.
    expect((await admin(`/api/orders/${order.id}/packed`, { method: 'patch' })).status()).toBe(200)
    const storno = (await ledger(friend)).find((t) => t.type === 'charge' && t.note === 'Stornované')
    expect2dp(storno.amount, 'reversal from a legacy row')
    expect(storno.amount).toBe(26.19)

    expect((await admin(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    const payment = (await ledger(friend)).find((t) => t.type === 'payment' && t.order_id === order.id)
    expect2dp(payment.amount, 'payment from a legacy row')
    expect(payment.amount).toBe(26.19)

    expect(await balance(friend), 'the legacy row leaves no residue').toBe(26.19)
  })

  test('an admin-entered amount carrying float noise is stored rounded', async () => {
    const friend = await makeFriend('Manual')

    const pay = await admin('/api/transactions/payment', {
      method: 'post',
      data: { friend_id: friend.id, amount: 15.0 + 11.19, note: 'Prevod s sumou z QR' },
    })
    expect(pay.status()).toBe(201)
    expect2dp((await pay.json()).transaction.amount, 'payment amount')
    expect((await pay.json()).transaction.amount).toBe(26.19)

    const adj = await admin('/api/transactions/adjustment', {
      method: 'post',
      data: { friend_id: friend.id, amount: -(0.1 + 0.2), note: 'Oprava' },
    })
    expect(adj.status()).toBe(201)
    const adjustment = (await adj.json()).transaction
    expect2dp(adjustment.amount, 'adjustment amount')
    expect(adjustment.amount).toBe(-0.3)

    // …and the same rule on an EDIT of a recorded amount.
    const patched = await admin(`/api/transactions/${adjustment.id}`, {
      method: 'patch', data: { amount: 9.04 + 13.33 + 11.19 },
    })
    expect(patched.status()).toBe(200)
    expect2dp((await patched.json()).transaction.amount, 'patched amount')
    expect((await patched.json()).transaction.amount).toBe(33.56)

    expect2dp(await balance(friend), 'balance built from them')
  })

  test('a voucher cut from an order stores 2-decimal figures, and credits a 2-decimal amount', async () => {
    const { friend, cycle } = await herOrder('Voucher')

    const gen = await admin('/api/vouchers/generate', {
      method: 'post',
      data: {
        source_cycle_id: cycle.id,
        supplier_discount: 40,
        applied_discount: 30,
        friend_ids: [friend.id],
      },
    })
    expect(gen.status(), 'voucher generate').toBe(201)
    const [voucher] = (await gen.json()).vouchers
    expect(voucher, 'a voucher was cut').toBeTruthy()

    // `order_total` is copied from `orders.total`, and `retail_total` /
    // `voucher_amount` are derived from it — so one unrounded source value is
    // laundered through three stored money columns and finally into a balance.
    expect2dp(voucher.order_total, 'vouchers.order_total')
    expect(voucher.order_total).toBe(26.19)
    expect2dp(voucher.retail_total, 'vouchers.retail_total')
    expect2dp(voucher.voucher_amount, 'vouchers.voucher_amount')

    const resolved = await ctx.post(`/api/vouchers/${voucher.id}/resolve`, {
      headers: friend.auth, data: { action: 'accept' }, timeout: TIMEOUT,
    })
    expect(resolved.status(), 'accept voucher').toBe(200)

    const credit = (await ledger(friend)).find((t) => t.type === 'adjustment' && /Voucher/.test(t.note || ''))
    expect(credit, 'the credit was posted').toBeTruthy()
    expect2dp(credit.amount, 'the voucher credit in the ledger')
    expect(credit.amount).toBe(voucher.voucher_amount)
    expect2dp(await balance(friend), 'the balance it builds')
  })

  test('⚠ a voucher cut from a LEGACY order, and a LEGACY voucher_amount, both credit clean', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    // Third instance of the same structural point: `vouchers.js` reads `orders.total`
    // and then reads back its own `voucher_amount`, and BOTH are written rounded now —
    // so both rounds are no-ops on a fresh database and are untestable through HTTP
    // alone. A voucher is routinely cut from a cycle whose orders are months old, i.e.
    // from exactly the pre-fix rows this manufactures.
    const { friend, cycle, order } = await herOrder('VoucherLegacy')

    let db = new DatabaseSync(DB_PATH)
    try {
      db.prepare('UPDATE orders SET total = ? WHERE id = ?').run(15.0 + 11.19, order.id)
    } finally {
      db.close()
    }

    const gen = await admin('/api/vouchers/generate', {
      method: 'post',
      data: { source_cycle_id: cycle.id, supplier_discount: 40, applied_discount: 30, friend_ids: [friend.id] },
    })
    expect(gen.status()).toBe(201)
    const [voucher] = (await gen.json()).vouchers
    expect2dp(voucher.order_total, 'vouchers.order_total from a legacy order')
    expect(voucher.order_total).toBe(26.19)

    // Now the other half: a voucher row that itself predates the fix.
    db = new DatabaseSync(DB_PATH)
    try {
      db.prepare('UPDATE vouchers SET voucher_amount = ? WHERE id = ?').run(15.0 + 11.19, voucher.id)
    } finally {
      db.close()
    }

    const resolved = await ctx.post(`/api/vouchers/${voucher.id}/resolve`, {
      headers: friend.auth, data: { action: 'accept' }, timeout: TIMEOUT,
    })
    expect(resolved.status()).toBe(200)
    const credit = (await ledger(friend)).find((t) => t.type === 'adjustment' && /Voucher/.test(t.note || ''))
    expect2dp(credit.amount, 'the credit from a legacy voucher_amount')
    expect(credit.amount).toBe(26.19)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (C) the delivery fee — the value that drifts AFTER a correct total is stored

test.describe('the delivery fee', () => {
  test('parcel_fee, delivery_fee and the payable total the portal reports are all 2-decimal', async () => {
    const friend = await makeFriend('Fee')
    const cycle = await makeCycle('F1')
    // A 4.20 EUR fee that arrives carrying noise (1.4 + 2.8 = 4.199999999999999).
    // `orders.delivery_fee` is copied from this column on every parcel submit, so an
    // unrounded cycle fee would seed the drift into every order in the cycle.
    expect(1.4 + 2.8, 'the fee fixture drifts').not.toBe(4.2)
    const patched = await enableParcel(cycle.id, 1.4 + 2.8)
    expect2dp(patched.parcel_fee, 'order_cycles.parcel_fee')
    expect(patched.parcel_fee).toBe(4.2)

    const p = []
    for (const [i, price] of [9.04, 13.33, 11.19].entries()) {
      p.push(await addProduct(cycle.id, { name: `Fee ${i} ${uniq}`, purpose: 'Espresso', price_250g: price }))
    }
    await cart(friend, cycle.id, p.map((x) => ({ product_id: x.id, variant: '250g', quantity: 1 })))
    const order = await submit(friend, cycle.id, { use_parcel_delivery: true, packeta_address: 'Z-BOX Money 1' })

    expect2dp(order.total, 'order.total')
    expect2dp(order.delivery_fee, 'orders.delivery_fee')
    expect(order.delivery_fee).toBe(4.2)
    expect(order.total + order.delivery_fee, 'the client-side addition still drifts').not.toBe(37.76)

    // `GET /friends/cycles` reports total + fee as ONE number ("Objednané · X").
    // ⚠ The per-friend half of that payload is keyed on the `?friendId` QUERY param,
    // not on the session — without it every cycle comes back with `orderTotal: 0`.
    const res = await ctx.get(`/api/friends/cycles?friendId=${friend.id}`, { headers: friend.auth, timeout: TIMEOUT })
    expect(res.status()).toBe(200)
    const row = (await res.json()).find((c) => c.id === cycle.id)
    expect2dp(row.orderTotal, 'friends/cycles orderTotal')
    expect(row.orderTotal).toBe(37.76)
  })

  test('⚠ a LEGACY unrounded order_cycles.parcel_fee is not copied into an order', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    // The counterpart of the legacy-total test: `order_cycles.parcel_fee` is rounded
    // on write from this fix on, which makes the round on the SUBMIT path a no-op
    // against a clean column — but cycles created before it can hold anything, and
    // the submit is where that value becomes `orders.delivery_fee`, i.e. part of what
    // the QR asks for. Without this the submit-side round is untested by construction.
    const friend = await makeFriend('FeeLegacy')
    const cycle = await makeCycle('F2')
    await enableParcel(cycle.id, 4.2)

    const db = new DatabaseSync(DB_PATH)
    try {
      db.prepare('UPDATE order_cycles SET parcel_fee = ? WHERE id = ?').run(1.4 + 2.8, cycle.id)
    } finally {
      db.close()
    }
    expect(dbGet('SELECT parcel_fee FROM order_cycles WHERE id = ?', cycle.id).parcel_fee)
      .toBe(4.199999999999999)

    const p = await addProduct(cycle.id, { name: `FeeLegacy ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    await cart(friend, cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])
    const order = await submit(friend, cycle.id, { use_parcel_delivery: true, packeta_address: 'Z-BOX Legacy' })

    expect2dp(order.delivery_fee, 'orders.delivery_fee from a legacy cycle fee')
    expect(order.delivery_fee).toBe(4.2)
    expect(dbGet('SELECT delivery_fee FROM orders WHERE id = ?', order.id).delivery_fee).toBe(4.2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (D) the guest sub-order — the NON-VACUITY CONTROL
//
// `routes/guest.js` already rounded its total before this fix. If this test ever
// goes red at the same time as (A), the harness is broken, not the rounding; if it
// passes while (A) fails, the assertions provably can tell a correct value from a
// drifting one.

test.describe('the guest sub-order (control)', () => {
  test('a guest total on the same drifting shape is 2-decimal', async () => {
    const host = await makeFriend('Host')
    const cycle = await makeCycle('G1')
    const a = await addProduct(cycle.id, { name: `Guest A ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `Guest B ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })

    const share = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(share.status())
    const link = (await share.json()).link

    const placed = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: 'Kolega Kontrolny',
        guest_phone: '0901 000 111',
        items: [
          { product_id: a.id, variant: '1kg', quantity: 1 },
          { product_id: b.id, variant: '250g', quantity: 1 },
        ],
      },
      timeout: TIMEOUT,
    })
    expect(placed.status(), 'guest submit').toBe(201)
    const body = await placed.json()

    expect2dp(body.order.total, 'guest_orders.total')
    expect(body.order.total).toBe(26.19)
    // The submit response is the ONLY place the guest is told what to pay.
    expect2dp(body.payment.amount, 'guest payment.amount')
    expect(body.payment.amount).toBe(26.19)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (E) the QR — the last point where money leaves the app
//
// This is the surface the user's bank actually rejected. `bysquare` serialises the
// amount with no formatting at all, so float noise goes into the payload verbatim
// (measured) — every other surface hides it behind `toFixed(2)`.
//
// ⚠ THE BACKEND FIX DOES NOT REACH HERE, AND THAT IS THE WHOLE POINT OF THIS BLOCK.
// `FriendOrder.paymentTotal` is `cartTotal + order.delivery_fee`, and `cartTotal` is
// the CLIENT's own sum over the cart lines — it never reads `orders.total`. So a
// perfectly rounded stored total is re-derived, unrounded, one addition before the
// encode. Both tests below are shapes where that client-side arithmetic drifts:
//   • no fee at all — her exact order, 15.00 + 11.19 = 26.189999999999998
//   • with a fee    — 9.04 + 13.33 + 11.19 + 3.50 = 37.059999999999995

const IBAN = 'SK31 1200 0000 1987 4263 7541'

/**
 * Reproduces `FriendOrder.generateSuccessQr()` in Node, for a given amount.
 *
 * ⚠ SANCTIONED EDIT — 15 §UC-PL-009 item 2 (PL-T4). `variableSymbol` was `''` at both
 * friend encode sites until module 15; it is now `String(order.id)` (§UC-PL-001: a
 * friend order's variable symbol IS its order id), so this independent encode takes it
 * as a parameter. `beneficiary.name` deliberately STAYS `'Gorifi'`: `primePage()`'s
 * `payment-settings` mock below carries no creditor name, and §UC-PL-004/D3 makes
 * `creditorName || 'Gorifi'` the fallback — so that absence is now ALSO what this file
 * proves. The drifting-vs-rounded amount logic, which is what this file is about, is
 * untouched.
 */
function independentQr(amount, reference, variableSymbol) {
  const t = new Date()
  const dateStr = t.getFullYear().toString()
    + (t.getMonth() + 1).toString().padStart(2, '0')
    + t.getDate().toString().padStart(2, '0')
  const qrString = encode({
    invoiceId: '',
    payments: [{
      type: PaymentOptions.PaymentOrder,
      amount,
      currencyCode: CurrencyCode.EUR,
      paymentDueDate: dateStr,
      variableSymbol,
      constantSymbol: '',
      specificSymbol: '',
      originatorsReferenceInformation: '',
      paymentNote: reference,
      bankAccounts: [{ iban: IBAN.replace(/\s/g, ''), bic: '' }],
      beneficiary: { name: 'Gorifi', street: '', city: '' },
    }],
  }, { version: Version['1.0.0'] })
  const qr = QRCode.create(qrString, { errorCorrectionLevel: 'M' })
  const rows = []
  for (let r = 0; r < qr.modules.size; r++) {
    let line = ''
    for (let c = 0; c < qr.modules.size; c++) line += qr.modules.get(r, c) ? '1' : '0'
    rows.push(line)
  }
  return { qrString, size: qr.modules.size, matrix: rows.join('\n') }
}

/**
 * Reads the module matrix off the RENDERED PIXELS of the success modal's QR.
 * Everything is derived from the image alone — the dark bounding box, the pitch
 * from the 7-module top-left finder run, the size snapped to the legal series
 * (21 + 4k). Nothing about the expected payload leaks in.
 * (Lifted from `guest-payment-modal.spec.js`, which owns the same technique for
 * the Platba modal.)
 */
async function readModules(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('.qr img')
    if (!img) return { error: 'no img' }
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const n = img.naturalWidth
    const cv = document.createElement('canvas')
    cv.width = n
    cv.height = n
    const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0)
    const px = cx.getImageData(0, 0, n, n).data
    const dark = (x, y) => px[(y * n + x) * 4] < 128

    let minX = n, minY = n, maxX = -1, maxY = -1
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!dark(x, y)) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return { error: 'all light' }

    let run = 0
    while (dark(minX + run, minY)) run++
    const width = maxX - minX + 1
    const approx = width / (run / 7)
    let size = 21
    let best = Infinity
    for (let s = 21; s <= 177; s += 4) {
      const d = Math.abs(s - approx)
      if (d < best) { best = d; size = s }
    }
    const step = width / size
    const rows = []
    for (let r = 0; r < size; r++) {
      let line = ''
      for (let c = 0; c < size; c++) {
        line += dark(Math.round(minX + (c + 0.5) * step), Math.round(minY + (r + 0.5) * step)) ? '1' : '0'
      }
      rows.push(line)
    }
    return { size, matrix: rows.join('\n') }
  })
}

/** Signs the friend in and stubs the two reads the success screen depends on. */
async function primePage(page, friend) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: friend.id, friendName: friend.name, token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
  // Hermetic payment settings: the QR only renders when an IBAN is configured, and
  // the test has to know which one to encode independently.
  await page.route('**/api/admin/payment-settings', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ paymentIban: IBAN, paymentRevolutUsername: '' }),
  }))
  // `[]` is a genuine "the admin configured no pickup locations", not leakage from
  // another spec — which is what decides whether the Spôsob prevzatia modal opens.
  await page.route('**/api/pickup-locations*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }))
  await page.setViewportSize({ width: 378, height: 900 })
}

/** A cold deep-link to /cycle/:id bounces to `/` — enter through the portal. */
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expectLanding(page)
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page.locator('.app .cartbar')).toBeVisible()
}

/**
 * Scans the success modal's QR and asserts it is bit-for-bit the encode of
 * `expected` — and that the DRIFTING candidate really is a different payload, so
 * the comparison cannot be vacuous.
 */
async function expectQrAmount(page, dialog, friend, cycle, expected, drifting, orderId) {
  await expect(dialog.locator('.qr img')).toBeVisible()
  const scanned = await readModules(page)
  expect(scanned.error).toBeUndefined()

  const reference = `${friend.name} / ${cycle.name}`
  // The VS is the order id at BOTH friend encode sites (15 §UC-PL-007 item 1), so the
  // same expectation serves the success modal and the shared Platba modal.
  const vs = String(orderId)
  const good = independentQr(expected, reference, vs)
  const bad = independentQr(drifting, reference, vs)

  expect(drifting, 'the drifting candidate really drifts').not.toBe(expected)
  expect(bad.qrString, 'float noise reaches the payload verbatim').not.toBe(good.qrString)
  expect(decode(bad.qrString).payments[0].amount, 'this is what the bank refused').toBe(drifting)

  expect(scanned.size, 'a real QR grid size (21 + 4k)').toBe(good.size)
  expect((scanned.size - 21) % 4).toBe(0)
  // Bit for bit ⇒ identical encoded bytes ⇒ a scanner reads exactly `good.qrString`.
  expect(scanned.matrix, 'the rendered code IS the 2-decimal encode').toBe(good.matrix)
  expect(decode(good.qrString).payments[0].amount, 'and that is the rounded amount').toBe(expected)
}

test.describe('the Pay-by-Square QR', () => {
  test('⚠ THE REPORTED FAILURE: her QR carries 26.19, not 26.189999999999998', async ({ page }) => {
    const friend = await makeFriend('Qr1')
    const cycle = await makeCycle('Q1')
    const a = await addProduct(cycle.id, { name: `Qr Sinaloa ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `Qr Druha ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })
    const { order } = await cart(friend, cycle.id, [
      { product_id: a.id, variant: '1kg', quantity: 1 },
      { product_id: b.id, variant: '250g', quantity: 1 },
    ])

    await primePage(page, friend)
    await gotoCycle(page, cycle)

    // No locations + no parcel ⇒ no Spôsob prevzatia modal; Odoslať lands straight
    // on Hotovo! (order-modals.spec.js §A pins that routing).
    await page.locator('.app .cartbar').getByRole('button', { name: 'Odoslať' }).click()
    const d = page.getByRole('dialog')
    await expect(d).toContainText('Hotovo!')

    // The DISPLAYED sum was always right — `toFixed(2)` hid the defect, which is
    // exactly how this reached production. Asserting it is the control, not the find.
    await expect(d.locator('.banner.ok.slim b.mono')).toHaveText('26.19 EUR')

    await expectQrAmount(page, d, friend, cycle, 26.19, 15.0 + 11.19, order.id)
  })

  test('⚠ the shared PaymentModal rounds its own payload, on the same order', async ({ page }) => {
    // `PaymentModal.vue` is a SECOND encode of the same money, reached from the cart
    // bar's "Zaplatiť" once the order is submitted — and it is reused by the two guest
    // screens too. `FriendOrder` hands it `:amount="paymentTotal"`, the UNROUNDED
    // browser sum (see the comment on that computed), so this is the one route on
    // which the component's own `roundMoney` is load-bearing and provable.
    const friend = await makeFriend('Qr3')
    const cycle = await makeCycle('Q3')
    const a = await addProduct(cycle.id, { name: `Qr3 Sinaloa ${uniq}`, purpose: 'Espresso', price_1kg: 15.0 })
    const b = await addProduct(cycle.id, { name: `Qr3 Druha ${uniq}`, purpose: 'Espresso', price_250g: 11.19 })
    const { order } = await cart(friend, cycle.id, [
      { product_id: a.id, variant: '1kg', quantity: 1 },
      { product_id: b.id, variant: '250g', quantity: 1 },
    ])

    await primePage(page, friend)
    await gotoCycle(page, cycle)
    await page.locator('.app .cartbar').getByRole('button', { name: 'Odoslať' }).click()
    await expect(page.getByRole('dialog')).toContainText('Hotovo!')
    // ⚠ Every close route on the success modal lands on the PORTAL (order-modals.spec
    // §D), so the order screen has to be re-entered through the cycle card — a direct
    // goto would bounce off FriendOrder's session restore.
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click()
    await gotoCycle(page, cycle)

    // A submitted order with payment settings ⇒ "Zaplatiť" appears in the cart bar.
    await page.locator('.app .cartbar').getByRole('button', { name: 'Zaplatiť' }).click()
    const d = page.getByRole('dialog')
    await expect(d.locator('.m-title')).toHaveText('Platba')
    await expect(d).toContainText('26.19 EUR')

    await expectQrAmount(page, d, friend, cycle, 26.19, 15.0 + 11.19, order.id)
  })

  test('⚠ the DELIVERY-FEE addition cannot re-introduce the drift', async ({ page }) => {
    const friend = await makeFriend('Qr2')
    const cycle = await makeCycle('Q2')
    await enableParcel(cycle.id, 3.5)
    const p = []
    for (const [i, price] of [9.04, 13.33, 11.19].entries()) {
      p.push(await addProduct(cycle.id, { name: `Qr2 ${i} ${uniq}`, purpose: 'Espresso', price_250g: price }))
    }
    const { order } = await cart(friend, cycle.id, p.map((x) => ({ product_id: x.id, variant: '250g', quantity: 1 })))

    await primePage(page, friend)
    await gotoCycle(page, cycle)

    await page.locator('.app .cartbar').getByRole('button', { name: 'Odoslať' }).click()
    const d = page.getByRole('dialog')
    await d.locator('#fo-packeta-address').fill('Z-BOX Money QR')
    await d.getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(d).toContainText('Hotovo!')
    await expect(d.locator('.banner.ok.slim b.mono')).toHaveText('37.06 EUR')

    await expectQrAmount(page, d, friend, cycle, 37.06, 9.04 + 13.33 + 11.19 + 3.5, order.id)
  })
})
