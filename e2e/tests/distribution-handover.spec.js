import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// DP-T2 — module 16 (distribution pipeline), 16 §UC-DP-003 + §UC-DP-013.
//
// `GET /api/cycles/:id/distribution` grows, ADDITIVELY:
//   • per PARTY  — `phone`, `handed_over_at`, `stage`, `delivery`, `kg`
//   • per GUEST  — `handed_over_at`, `stage`, `delivery`, `kg`
//   • top level  — `plan[]`, `totals`, `locations[]`
//
// What carries this file, in the order of how badly each one bites:
//
//  1. ⚠ **ADDITIVE OR NOTHING.** `guest-distribution.spec.js` and
//     `order-pickup-edit.spec.js` read this payload and must pass UNMODIFIED. A
//     status/shape assertion in a NEW file cannot see a field that quietly changed
//     type or disappeared, so the first test here PINS every shipped key by name on
//     both a party row and a nested guest row. That is the cheap half of the net;
//     the two shipped files are the other half.
//
//  2. ⚠ **THE GUEST HALF MERGES IN JAVASCRIPT, NEVER AS A SECOND `LEFT JOIN` ON
//     `orders`.** The standing rule (CLAUDE.md §Money & data, the GSO-T6/T8 trap):
//     joining `guest_orders` onto the friend query multiplies the friend row by the
//     number of sub-orders, so `orders_count` and every SUM inflate. The fixture is
//     built so a join CANNOT hide: the host has TWO live sub-orders (plus a
//     cancelled one), so a join would list the host twice or three times, and the
//     assertions below are exactly the numbers that would move — the host appears
//     ONCE, `totals.count` is 5 not 6+, the pickup plan card counts 3 parties not 4,
//     and the host's `kg` is own+guests ONCE (a duplicated row doubles the OWN
//     grams, which is the tell that survives even a `DISTINCT`).
//
//  3. **Cycle-level totals include guests; per-friend aggregates never do.** `kg`
//     on a party is the bag the admin physically carries, so it DOES fold the
//     guests in — that is the cycle-level side of the rule, and it is asserted to
//     the gram.
//
//  4. **A dangling pickup location must not break the board.** `DELETE
//     /api/pickup-locations/:id` only soft-deletes when an `orders` row references
//     it — a party whose pickup lives on `guest_order_links` (a host with no own
//     order) is invisible to that check, so the row is really deleted and the party
//     keeps a `loc<id>` key with NO name. `helpers/delivery.js` (DP-T1) tolerates
//     that by design; this file pins that the payload does too, all the way up into
//     `plan[]` (a card with a null label, never a crash and never a dropped bag).
//
//  5. **Zero-count plan cards.** A location configured and active for this cycle's
//     type shows „0“ even with nobody on it — otherwise the admin cannot tell „no
//     bags there“ from „that point is not set up“.
//
// ⚠ ~~NO WRITER FOR `handed_over_at` EXISTS YET … so the `stage: 'handed'` cases
// stamp the column DIRECTLY through `node:sqlite` behind a `DB_PATH` skip.~~
// **SUPERSEDED BY DP-T3**, which ships the two writers. Both of those tests now
// drive `PATCH /api/orders/:id/handed-over` and
// `PATCH /api/guest-orders/:id/handed-over`, and the `DB_PATH` gate on them is
// GONE: a test that writes the column itself stopped being evidence about the
// route the moment the route existed, and the skip made it vanish SILENTLY
// whenever the variable was unset (the false-clean measured on DP-T2). The only
// `DB_PATH` use left in this file is the strictly-extra LEDGER WATERMARK of
// section 4 — an assertion that is additive to an API-level one, never the
// scenario itself.
//
// ─── DP-T3 adds section 4 below: 16 §UC-DP-004 / §UC-DP-005 / §UC-DP-008 ──────
// The two hand-over routes, the outbox counts they report, and the two rules no
// test can infer from a payload: NO `transactions` row is ever written by either
// of them, and `PATCH /api/guest-orders/:id/delivered` stays HOST-only on the
// same MIXED router. The `notifications` rows' COLUMNS (template keys, segment
// keys, `body IS NULL`) are proven in `distribution-foundation.spec.js`, which
// already owns the outbox — that table has no API, so column-level evidence needs
// the database file and belongs beside the rest of the DB_PATH-gated outbox
// assertions rather than scattered here.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
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

// ⚠ DP-T3 RETIRED `stampHandedOver()`. Nothing in this file writes
// `handed_over_at` any more — the routes do, and that is the point.

/** The admin hand-over of a friend bag. Always an EXPLICIT boolean (§UC-DP-004). */
async function handOverOrder(orderId, handedOver) {
  return admin(`/api/orders/${orderId}/handed-over`, {
    method: 'patch', data: { handed_over: handedOver },
  })
}

/** The admin hand-over of ONE guest bag (§UC-DP-005). */
async function handOverGuest(guestOrderId, handedOver) {
  return admin(`/api/guest-orders/${guestOrderId}/handed-over`, {
    method: 'patch', data: { handed_over: handedOver },
  })
}

/** The BULK hand-over of a whole group, DP-T4 / §UC-DP-006. Both arrays required. */
async function handOverBatch(cycleId, orderIds, guestOrderIds) {
  return admin(`/api/cycles/${cycleId}/distribution/hand-over`, {
    method: 'post', data: { order_ids: orderIds, guest_order_ids: guestOrderIds },
  })
}

/** The same route with a RAW body, for the shapes JSON can express and a binder must refuse. */
async function handOverBatchRaw(cycleId, raw) {
  return ctx.post(`/api/cycles/${cycleId}/distribution/hand-over`, {
    headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
    data: raw,
    timeout: TIMEOUT,
  })
}

// ── the LEDGER WATERMARK (strictly extra, the guest-distribution.spec.js idiom) ──
// Stage 3 is ledger-neutral by construction: `helpers/packing.js` is and stays the
// only ledger moment. A GLOBAL count would be a value claim over rows this file does
// not own (a concurrent spec's pack reddens it), so the watermark is FILTERED to the
// friend whose bag moved — the only identity a hand-over can reach — OR to the
// `order_id` that moved, which is what a copied `PATCH /orders/:id/paid` would tag.
function withDb(fn) {
  if (!DB_PATH) return null
  let db
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true })
  } catch {
    return null
  }
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function ledgerWatermark() {
  return withDb((db) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM transactions').get().n))
}

function ledgerRowsSince(watermark, friendId, orderId) {
  if (watermark === null) return null
  return withDb((db) =>
    db.prepare(
      'SELECT id, friend_id, order_id, type, amount, note FROM transactions WHERE id > ? AND (friend_id = ? OR order_id = ?)'
    ).all(watermark, Number(friendId), Number(orderId || 0))
  )
}

/** The API-level half of the same claim, which needs no DB_PATH at all. */
async function ledgerSnapshot(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  const body = await res.json()
  return { count: (body.transactions || []).length, balance: body.balance }
}

let friendSeq = 0
async function makeFriend(label, phone) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `dp2_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `DP2 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone } })
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
  return { id: row.id, name, phone: phone || null, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, patch = null) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E DP2 ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  // `parcel_enabled` / `parcel_fee` are PATCH-only on this router (POST does not
  // bind them), so a Packeta fixture has to take the second call.
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
      cycle_id: cycleId, name: `DP2 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let locationSeq = 0
async function makeLocation(label, over = {}) {
  const res = await admin('/api/pickup-locations', {
    method: 'post',
    data: {
      name: `DP2 ${label} ${uniq}${++locationSeq}`, address: `Testovacia ${locationSeq}`,
      for_coffee: true, for_bakery: true, ...over,
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

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth, timeout: TIMEOUT })
  expect([200, 201], 'share link').toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, name, phone, items) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: { guest_name: name, guest_phone: phone, items },
    timeout: TIMEOUT,
  })
  expect(res.status(), 'guest submit').toBe(201)
  return (await res.json()).order
}

async function payload(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return res.json()
}

const partyOf = (body, friendId) => body.distribution.find((p) => p.id === friendId)
const planFor = (body, key) => body.plan.find((entry) => entry.target_key === key)

async function packOrderItems(orderId, cycleId, friendId) {
  const body = await payload(cycleId)
  const party = partyOf(body, friendId)
  for (const item of party.items) {
    if (item.packed) continue
    expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  if (orderId) {
    expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status()).toBe(200)
  }
}

async function packGuestItems(cycleId, friendId, guestOrderId) {
  const body = await payload(cycleId)
  const party = partyOf(body, friendId)
  const guest = party.guest_orders.find((g) => g.id === guestOrderId)
  expect(guest, 'guest sub-order is in the payload').toBeTruthy()
  for (const item of guest.items) {
    if (item.packed) continue
    expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
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
// 1. The acceptance scenario of §UC-DP-003, built once.
//
//   Packeta   — 1 friend, own order 250 g                              →   250 g
//   loc L     — friend A (2 × 250 g = 500 g)
//             + friend B (1 × 1 kg  = 1000 g)
//             + HOST     (own 250 g + guest 500 g + guest 1000 g = 1750 g,
//                         and a CANCELLED 3000 g sub-order that counts nowhere)
//                                                                      →  3250 g
//   loc Z     — configured, active, nobody on it                       →     0 g
//   Osobne    — 1 friend, own order 250 g                              →   250 g
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T2 · 16 §UC-DP-003 — the distribution payload', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Plan', { parcel_enabled: true, parcel_fee: 3.9 })
    fx.product = await addProduct(fx.cycle.id)
    fx.L = await makeLocation('Miesto L')
    fx.Z = await makeLocation('Miesto Z')
    // active, but configured for BAKERY only — it must not card up on a coffee cycle
    fx.bakeryOnly = await makeLocation('Miesto Pekaren', { for_coffee: false })

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    fx.packeta = await makeFriend('Packeta', '0901 111 111')
    fx.packetaOrder = await ownOrder(fx.packeta, fx.cycle.id, line('250g', 1), {
      use_parcel_delivery: true, packeta_address: 'Packeta Ruzinov, Bratislava',
    })

    fx.a = await makeFriend('Ancka', '0902 222 222')
    fx.aOrder = await ownOrder(fx.a, fx.cycle.id, line('250g', 2), { pickup_location_id: fx.L.id })

    fx.b = await makeFriend('Bela', '0903 333 333')
    fx.bOrder = await ownOrder(fx.b, fx.cycle.id, line('1kg', 1), { pickup_location_id: fx.L.id })

    fx.host = await makeFriend('Hostitel', '0904 444 444')
    fx.hostOrder = await ownOrder(fx.host, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.L.id })
    const link = await shareLink(fx.host, fx.cycle.id)
    fx.guest1 = await submitGuest(link.token, `Guest Jedna ${uniq}`, '0905 555 555', line('250g', 2))
    fx.guest2 = await submitGuest(link.token, `Guest Dva ${uniq}`, '0906 666 666', line('1kg', 1))
    fx.guestX = await submitGuest(link.token, `Guest Zruseny ${uniq}`, '0907 777 777', line('1kg', 3))
    expect((await admin(`/api/guest-orders/${fx.guestX.id}/cancel`, { method: 'post' })).status()).toBe(200)

    fx.inPerson = await makeFriend('Osobne', '0908 888 888')
    fx.inPersonOrder = await ownOrder(fx.inPerson, fx.cycle.id, line('250g', 1), {
      pickup_location_note: 'Vyzdvihnem si osobne',
    })
  })

  // ⚠ CROSS-SPEC HYGIENE, and the one kind of fixture in this repo that genuinely
  // leaks. `pickup_locations` is GLOBAL, and every ACTIVE row becomes an `<option>`
  // inside the `PickupLocationPicker` that `CycleDetail.vue` renders on EVERY order
  // row of EVERY cycle. So a location left behind here lengthens the `innerText` of
  // rows that belong to other spec files — measured: `DP2 Miesto L …` turned up
  // inside `guest-admin-view.spec.js`'s host row. Friends, cycles, products and
  // orders are scoped to this file's own cycles and do not do that; locations are.
  //
  // Nothing here is needed once the file is done, so it is retired. `DELETE`
  // soft-deletes the one orders reference and really deletes the two nobody chose —
  // either way they leave the picker's active list.
  test.afterAll(async () => {
    for (const loc of [fx.L, fx.Z, fx.bakeryOnly]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('additive: every shipped key survives on a party and on a nested guest row', async () => {
    const body = await payload(fx.cycle.id)
    expect(body.cycle.id, 'the shipped envelope is unchanged').toBe(fx.cycle.id)
    expect(Array.isArray(body.distribution)).toBe(true)

    const party = partyOf(body, fx.host.id)
    expect(party, 'the host is a party').toBeTruthy()
    for (const key of [
      'id', 'name', 'order_id', 'has_own_order', 'status', 'paid', 'total', 'packed', 'packed_at',
      'pickup_location_id', 'pickup_location_note', 'pickup_location_name',
      'delivery_fee', 'packeta_address', 'balance', 'items', 'guest_orders',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(party, key), `shipped party key ${key}`).toBe(true)
    }
    expect(party.has_own_order).toBe(true)
    expect(party.order_id).toBe(fx.hostOrder.id)
    expect(party.pickup_location_id).toBe(fx.L.id)
    expect(party.pickup_location_name).toBe(fx.L.name)
    expect(Array.isArray(party.items)).toBe(true)

    const guest = party.guest_orders.find((g) => g.id === fx.guest1.id)
    expect(guest, 'the guest row is nested under its host').toBeTruthy()
    for (const key of [
      'id', 'link_id', 'guest_name', 'guest_phone', 'status', 'total', 'paid',
      'delivered', 'delivered_at', 'order_token', 'items', 'host_name',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(guest, key), `shipped guest key ${key}`).toBe(true)
    }
    expect(Array.isArray(guest.items)).toBe(true)
  })

  test('per party: phone, handed_over_at, stage, delivery, kg', async () => {
    const body = await payload(fx.cycle.id)

    const packeta = partyOf(body, fx.packeta.id)
    expect(packeta.phone, 'friends.phone reaches the board').toBe('0901 111 111')
    expect(packeta.handed_over_at, 'nothing is handed over yet').toBe(null)
    expect(packeta.stage).toBe('to_pack')
    expect(packeta.kg, '1 × 250 g').toBe(250)
    expect(packeta.delivery).toEqual({
      type: 'packeta',
      target_key: 'packeta',
      target_label: 'Packeta',
      target_detail: 'Packeta Ruzinov, Bratislava',
      phone: '0901 111 111',
    })

    const a = partyOf(body, fx.a.id)
    expect(a.phone).toBe('0902 222 222')
    expect(a.kg, '2 × 250 g').toBe(500)
    expect(a.delivery).toEqual({
      type: 'pickup',
      target_key: `loc${fx.L.id}`,
      target_label: fx.L.name,
      target_detail: fx.L.address,
      // ⚠ a pickup point is a place, not a person: `delivery.phone` is null here
      // even though the PARTY carries `friends.phone` a line above.
      phone: null,
    })

    const inPerson = partyOf(body, fx.inPerson.id)
    expect(inPerson.stage).toBe('to_pack')
    expect(inPerson.kg).toBe(250)
    expect(inPerson.delivery).toEqual({
      type: 'in_person',
      target_key: 'in_person',
      target_label: 'Osobne',
      target_detail: 'Vyzdvihnem si osobne',
      phone: null,
    })
  })

  test('per guest: handed_over_at, stage, delivery (via_host, its OWN phone) and kg', async () => {
    const body = await payload(fx.cycle.id)
    const party = partyOf(body, fx.host.id)

    expect(party.guest_orders.length, 'the cancelled sub-order is not a bag').toBe(2)
    expect(party.guest_orders.some((g) => g.id === fx.guestX.id), 'cancelled stays out').toBe(false)

    const g1 = party.guest_orders.find((g) => g.id === fx.guest1.id)
    expect(g1.handed_over_at).toBe(null)
    expect(g1.stage).toBe('to_pack')
    expect(g1.kg, '2 × 250 g').toBe(500)
    expect(g1.delivery).toEqual({
      type: 'via_host',
      target_key: `loc${fx.L.id}`,
      target_label: fx.L.name,
      // ⚠ the HOST's delivery is what a guest inherits — the call site passes
      // `{ host: party.delivery }`, which is the DP-T1 hand-off contract. Without
      // it the guest would be classified standalone and become tickable on its own.
      target_detail: `cez ${fx.host.name}`,
      // the GUEST's own number: it is the guest who is written to when the bag moves
      phone: '0905 555 555',
    })

    const g2 = party.guest_orders.find((g) => g.id === fx.guest2.id)
    expect(g2.kg, '1 × 1 kg').toBe(1000)
    expect(g2.delivery.phone).toBe('0906 666 666')
    expect(g2.delivery.target_key).toBe(`loc${fx.L.id}`)
  })

  test('the guest kilograms merge in JS — a second LEFT JOIN would corrupt every one of these', async () => {
    const body = await payload(fx.cycle.id)

    // A join onto `guest_orders` multiplies the host row by its sub-orders.
    const hostRows = body.distribution.filter((p) => p.id === fx.host.id)
    expect(hostRows.length, 'the host is ONE bag, not one per colleague').toBe(1)
    expect(body.distribution.length, '5 parties: packeta, A, B, host, in-person').toBe(5)
    expect(body.totals.count).toBe(5)

    // Own 250 g + guest 500 g + guest 1000 g. A duplicated row would double the OWN
    // grams (1750 → 2000+); the cancelled 3000 g bag counts nowhere at all.
    expect(hostRows[0].kg, 'own + live guests, each counted exactly once').toBe(1750)

    // …and the plan card counts PARTIES, so a multiplied host inflates it too.
    expect(planFor(body, `loc${fx.L.id}`).count, 'A + B + host').toBe(3)
    expect(planFor(body, `loc${fx.L.id}`).kg, '500 + 1000 + 1750').toBe(3250)
  })

  test('plan[], totals and locations[]', async () => {
    const body = await payload(fx.cycle.id)

    expect(Array.isArray(body.plan), 'plan is published').toBe(true)
    expect(body.plan.length, 'non-vacuity: the plan is not empty').toBeGreaterThan(0)

    // Only THIS cycle's parties may carry a count; other specs' active locations
    // legitimately ride along at 0, which is the zero-count rule below.
    const occupied = body.plan.filter((entry) => entry.count > 0).map((entry) => entry.target_key)
    expect(occupied).toEqual(['packeta', `loc${fx.L.id}`, 'in_person'])

    expect(planFor(body, 'packeta')).toEqual({
      target_key: 'packeta', target_label: 'Packeta', type: 'packeta',
      count: 1, packed_count: 0, handed_count: 0, kg: 250,
    })
    expect(planFor(body, 'in_person')).toEqual({
      target_key: 'in_person', target_label: 'Osobne', type: 'in_person',
      count: 1, packed_count: 0, handed_count: 0, kg: 250,
    })

    // ⚠ the zero-count card: configured, active for this cycle type, nobody on it.
    expect(planFor(body, `loc${fx.Z.id}`)).toEqual({
      target_key: `loc${fx.Z.id}`, target_label: fx.Z.name, type: 'pickup',
      count: 0, packed_count: 0, handed_count: 0, kg: 0,
    })

    // ⚠ the zero-count rule is scoped BY CYCLE TYPE — the same filter the friend's
    // picker applies. A bakery-only point is active and empty, exactly like Z, so
    // the assertion is non-vacuous against Z passing one line above.
    expect(planFor(body, `loc${fx.bakeryOnly.id}`), 'a bakery point is not on a coffee plan').toBeUndefined()
    expect(body.locations.some((row) => row.id === fx.bakeryOnly.id), 'nor in locations[]').toBe(false)

    // group order: Packeta first, pickup points by ascending id, Osobne last
    const keys = body.plan.map((entry) => entry.target_key)
    expect(keys[0]).toBe('packeta')
    expect(keys[keys.length - 1]).toBe('in_person')
    expect(keys.indexOf(`loc${fx.L.id}`)).toBeLessThan(keys.indexOf(`loc${fx.Z.id}`))

    expect(body.totals).toEqual({ count: 5, packed_count: 0, handed_count: 0 })

    expect(Array.isArray(body.locations), 'locations is published').toBe(true)
    const l = body.locations.find((row) => row.id === fx.L.id)
    const z = body.locations.find((row) => row.id === fx.Z.id)
    expect(l, 'a referenced location names itself').toEqual({ id: fx.L.id, name: fx.L.name, address: fx.L.address })
    expect(z, 'an active-but-empty location is listed too').toEqual({ id: fx.Z.id, name: fx.Z.name, address: fx.Z.address })
  })

  test('packing moves stage and the plan counts (host gate counts guest items too)', async () => {
    // Friend A: own items only.
    await packOrderItems(fx.aOrder.id, fx.cycle.id, fx.a.id)

    let body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.a.id).stage).toBe('packed')
    expect(partyOf(body, fx.b.id).stage, 'B is untouched').toBe('to_pack')
    expect(body.totals).toEqual({ count: 5, packed_count: 1, handed_count: 0 })
    expect(planFor(body, `loc${fx.L.id}`).packed_count).toBe(1)

    // The host: own items alone do NOT pack the bag — the colleague's items are in it.
    const hostParty = partyOf(body, fx.host.id)
    for (const item of hostParty.items) {
      expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
    }
    body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.host.id).stage, 'guest bags are still open').toBe('to_pack')

    // One guest bag checked off ⇒ that GUEST row is packed, the host still is not.
    await packGuestItems(fx.cycle.id, fx.host.id, fx.guest1.id)
    body = await payload(fx.cycle.id)
    let party = partyOf(body, fx.host.id)
    expect(party.guest_orders.find((g) => g.id === fx.guest1.id).stage).toBe('packed')
    expect(party.guest_orders.find((g) => g.id === fx.guest2.id).stage).toBe('to_pack')
    expect(party.stage).toBe('to_pack')

    await packGuestItems(fx.cycle.id, fx.host.id, fx.guest2.id)
    expect((await admin(`/api/orders/${fx.hostOrder.id}/packed`, { method: 'patch' })).status()).toBe(200)

    body = await payload(fx.cycle.id)
    party = partyOf(body, fx.host.id)
    expect(party.stage).toBe('packed')
    expect(body.totals).toEqual({ count: 5, packed_count: 2, handed_count: 0 })
    expect(planFor(body, `loc${fx.L.id}`).packed_count).toBe(2)
    expect(planFor(body, `loc${fx.L.id}`).handed_count).toBe(0)
  })

  // ⚠ REWRITTEN BY DP-T3 (was: two `stampHandedOver()` calls behind a `DB_PATH`
  // skip). It drives the two real routes now, so it runs on EVERY target and the
  // payload assertions below are evidence about the endpoints rather than about a
  // column this file wrote itself. The exact timestamps are gone with the direct
  // write — they are the server's `CURRENT_TIMESTAMP` — so what is pinned instead
  // is the RELATION: the payload echoes exactly what the route answered.
  test('handed_over_at moves stage to handed, on the party and on the guest', async () => {
    const handA = await handOverOrder(fx.aOrder.id, true)
    expect(handA.status(), 'a packed bag hands over').toBe(200)
    const handedA = await handA.json()
    expect(handedA.order.handed_over_at, 'the route stamps it').toBeTruthy()
    expect(handedA.order.stage).toBe('handed')

    // ⚠ ONE guest bag, through the GUEST route — §UC-DP-005 case (c), the withheld
    // bag under a host who has not been handed over. It must not touch the host.
    const handG1 = await handOverGuest(fx.guest1.id, true)
    expect(handG1.status(), 'every item of that bag is checked off').toBe(200)
    const handedG1 = await handG1.json()
    expect(handedG1.guest_order.handed_over_at).toBeTruthy()
    expect(handedG1.stage).toBe('handed')

    const body = await payload(fx.cycle.id)
    const a = partyOf(body, fx.a.id)
    expect(a.handed_over_at, 'the payload echoes the route').toBe(handedA.order.handed_over_at)
    expect(a.stage, 'handed wins over packed').toBe('handed')

    const party = partyOf(body, fx.host.id)
    const g1 = party.guest_orders.find((g) => g.id === fx.guest1.id)
    expect(g1.handed_over_at).toBe(handedG1.guest_order.handed_over_at)
    expect(g1.stage).toBe('handed')
    expect(party.stage, 'a host with an own order reads its OWN column').toBe('packed')
    expect(party.handed_over_at, 'a guest-level hand-over never stamps the host').toBe(null)

    expect(body.totals).toEqual({ count: 5, packed_count: 2, handed_count: 1 })
    const plan = planFor(body, `loc${fx.L.id}`)
    expect(plan.handed_count).toBe(1)
    expect(plan.packed_count, 'packed_count still INCLUDES the handed party').toBe(2)

    // …and back, so the serial describe leaves the cycle as it found it.
    expect((await handOverOrder(fx.aOrder.id, false)).status()).toBe(200)
    expect((await handOverGuest(fx.guest1.id, false)).status()).toBe(200)
    const after = await payload(fx.cycle.id)
    expect(partyOf(after, fx.a.id).handed_over_at, 'reversal clears it').toBe(null)
    expect(after.totals.handed_count).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The host with NO own order — the synthetic party. Its pickup lives on
//    `guest_order_links`, which `DELETE /api/pickup-locations/:id` does not look
//    at, so the location row is really gone and the key dangles.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T2 · the synthetic host: derived hand-over and a dangling location', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Dangling')
    fx.product = await addProduct(fx.cycle.id)
    fx.D = await makeLocation('Miesto D')
    // ⚠ THE NON-VACUITY WITNESS for „the deleted row is not listed" below, and it
    // has to be OUR OWN row. Gating on `locations.length > 0` instead would lean on
    // the six active points the shipped `prod-template.sqlite` happens to carry —
    // and `e2e/README.md` explicitly sanctions running with NO template, where
    // `seed.mjs` creates no pickup location at all and the first describe's cleanup
    // has already retired every point this file made. The absence assertion would
    // then pass over an EMPTY list: exactly the vacuum the rules forbid, in exactly
    // the "run the file alone on a fresh database" diagnostic they prescribe.
    fx.witness = await makeLocation('Miesto Svedok')

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    fx.host = await makeFriend('Bezobjednavky', '0909 999 999')
    const link = await shareLink(fx.host, fx.cycle.id)
    fx.g1 = await submitGuest(link.token, `Dangl Jedna ${uniq}`, '0911 111 111', line('250g', 1))
    fx.g2 = await submitGuest(link.token, `Dangl Dva ${uniq}`, '0912 222 222', line('250g', 1))
    fx.gX = await submitGuest(link.token, `Dangl Zruseny ${uniq}`, '0913 333 333', line('1kg', 2))
    expect((await admin(`/api/guest-orders/${fx.gX.id}/cancel`, { method: 'post' })).status()).toBe(200)

    // The admin sets the party's pickup — no `orders` row, so it lands on the link.
    const set = await admin(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.host.id}/pickup`, {
      method: 'patch', data: { pickup_location_id: fx.D.id },
    })
    expect(set.status(), 'pickup set on the link store').toBe(200)

    // …and now the location is deleted outright: the soft-delete check only reads
    // `orders`, and this party has none.
    expect((await admin(`/api/pickup-locations/${fx.D.id}`, { method: 'delete' })).status()).toBe(204)
  })

  // The witness is a globally visible active location like any other — retire it for
  // the same reason the first describe retires its three (see the note there).
  test.afterAll(async () => {
    if (!fx.witness) return
    const res = await admin(`/api/pickup-locations/${fx.witness.id}`, { method: 'delete' })
    expect([204, 404], 'witness location retired').toContain(res.status())
  })

  test('a dangling pickup id keeps its key and loses only its label', async () => {
    const body = await payload(fx.cycle.id)

    expect(body.distribution.length, 'exactly the synthetic host').toBe(1)
    const party = body.distribution[0]
    expect(party.id).toBe(fx.host.id)
    expect(party.has_own_order, 'no own order').toBe(false)
    expect(party.order_id).toBe(null)
    expect(party.phone).toBe('0909 999 999')
    expect(party.kg, '2 × 250 g live; the cancelled 2 kg counts nowhere').toBe(500)
    expect(party.delivery).toEqual({
      type: 'pickup',
      target_key: `loc${fx.D.id}`,
      target_label: null,
      target_detail: null,
      phone: null,
    })

    const guest = party.guest_orders.find((g) => g.id === fx.g1.id)
    expect(guest.delivery).toEqual({
      type: 'via_host',
      target_key: `loc${fx.D.id}`,
      target_label: null,
      target_detail: `cez ${fx.host.name}`,
      phone: '0911 111 111',
    })

    // the plan card renders the same nameless group rather than dropping the bag
    expect(body.plan.length, 'non-vacuity: the plan is not empty').toBeGreaterThan(0)
    const occupied = body.plan.filter((entry) => entry.count > 0)
    expect(occupied.map((e) => e.target_key)).toEqual([`loc${fx.D.id}`])
    expect(occupied[0]).toEqual({
      target_key: `loc${fx.D.id}`, target_label: null, type: 'pickup',
      count: 1, packed_count: 0, handed_count: 0, kg: 500,
    })

    // and `locations[]` cannot name a row that no longer exists
    expect(
      body.locations.some((row) => row.id === fx.witness.id),
      'non-vacuity: a live active point IS listed, so the absence below means something'
    ).toBe(true)
    expect(body.locations.some((row) => row.id === fx.D.id), 'the deleted row is not listed').toBe(false)
  })

  test('a synthetic host packs through the guest items and inherits their hand-over', async () => {
    await packGuestItems(fx.cycle.id, fx.host.id, fx.g1.id)
    let body = await payload(fx.cycle.id)
    expect(body.distribution[0].stage, 'one bag still open').toBe('to_pack')

    await packGuestItems(fx.cycle.id, fx.host.id, fx.g2.id)
    body = await payload(fx.cycle.id)
    expect(body.distribution[0].stage, 'no orders row — the union IS the gate').toBe('packed')
    expect(body.totals).toEqual({ count: 1, packed_count: 1, handed_count: 0 })
  })

  // ⚠ REWRITTEN BY DP-T3 (was: two `stampHandedOver()` calls behind a `DB_PATH`
  // skip). This is §UC-DP-005 case (b) end to end: a host with NO `orders` row has
  // no id to PATCH, so their party is handed over exactly by handing over each of
  // their guest bags — and the payload's `derivedHandedOver()` is what turns that
  // into one party stage. Now route-driven, so it runs on every target.
  test('derived handed_over_at: only when EVERY live sub-order carries one', async () => {
    const first = await handOverGuest(fx.g1.id, true)
    expect(first.status(), 'the synthetic host has no order id — the bag IS the unit').toBe(200)
    const firstStamp = (await first.json()).guest_order.handed_over_at
    expect(firstStamp).toBeTruthy()

    let body = await payload(fx.cycle.id)
    expect(body.distribution[0].handed_over_at, 'one of two is not the bag').toBe(null)
    expect(body.distribution[0].stage).toBe('packed')
    expect(body.totals.handed_count).toBe(0)

    const second = await handOverGuest(fx.g2.id, true)
    expect(second.status()).toBe(200)
    const secondStamp = (await second.json()).guest_order.handed_over_at
    expect(secondStamp).toBeTruthy()

    body = await payload(fx.cycle.id)
    const party = body.distribution[0]
    // SQLite timestamps are `YYYY-MM-DD HH:MM:SS` and sort lexicographically; the two
    // hand-overs may well land in the same second, so the claim is "the MAX", not
    // "the second one".
    const expectedMax = [firstStamp, secondStamp].sort().pop()
    expect(party.handed_over_at, 'the MAX over the live sub-orders').toBe(expectedMax)
    expect(party.stage).toBe('handed')
    expect(body.totals).toEqual({ count: 1, packed_count: 1, handed_count: 1 })
    expect(body.plan.find((e) => e.target_key === `loc${fx.D.id}`).handed_count).toBe(1)

    // ⚠ the CANCELLED sub-order was never handed over and must never have blocked
    // this — a bag nobody gives anybody cannot hold the party open forever. Handing
    // it over is refused outright, which is the other half of the same rule.
    expect(party.guest_orders.length).toBe(2)
    const cancelled = await handOverGuest(fx.gX.id, true)
    expect(cancelled.status(), 'cancelled is terminal').toBe(409)
    expect((await cancelled.json()).reason).toBe('cancelled')

    // one bag comes back ⇒ the derived party stage falls back to packed
    expect((await handOverGuest(fx.g2.id, false)).status()).toBe(200)
    body = await payload(fx.cycle.id)
    expect(body.distribution[0].handed_over_at, 'one live bag is back in hand').toBe(null)
    expect(body.distribution[0].stage).toBe('packed')
    expect((await handOverGuest(fx.g1.id, false)).status()).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. §UC-DP-013 — the route joins the admin sweep. It IS `requireAdmin` in code
//    today; what was missing is the regression net, so this is belt-and-braces
//    beside the `ADMIN_ENDPOINTS` entry in `api-security.spec.js`.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T2 · 16 §UC-DP-013 — the read stays admin-only', () => {
  test('anonymous and a wrong token are both 401', async () => {
    const anon = await ctx.get('/api/cycles/1/distribution', { timeout: TIMEOUT })
    expect(anon.status(), 'the distribution payload is not public').toBe(401)

    const wrong = await ctx.get('/api/cycles/1/distribution', {
      headers: { 'X-Admin-Token': 'not-a-real-token' }, timeout: TIMEOUT,
    })
    expect(wrong.status()).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. DP-T3 — the two hand-over WRITERS: `PATCH /api/orders/:id/handed-over`
//    (§UC-DP-004) and `PATCH /api/guest-orders/:id/handed-over` (§UC-DP-005),
//    with the outbox counts of §UC-DP-008 and the §UC-DP-009 stage echo.
//
// What carries this section, in the order of how badly each one bites:
//
//  1. ⚠ **NO `transactions` ROW, EVER.** Stage 2 (`packed`) is and stays the
//     ledger moment (`helpers/packing.js`); stage 3 is ledger-neutral by
//     construction. Pinned TWICE, and the API half needs no `DB_PATH`: the
//     friend's own `GET /api/friends/:id/detail` returns every row
//     `WHERE friend_id = ?` and its `balance`, so a copied `PATCH /orders/:id/paid`
//     reddens it immediately. The `MAX(id)` watermark on top is the strictly-extra
//     half that also sees a row tagged with the `order_id` but credited to the
//     WRONG friend — the shape an actual copy-paste of the paid handler produces.
//  2. ⚠ **`routes/guest-orders.js` is a MIXED router.** `handed_over` is
//     ADMIN-only exactly as `paid` is, and `delivered` stays HOST-only. Both
//     directions are asserted, on the same sub-order, in the same test — a guard
//     wrapped around the MOUNT would break one of the two whichever way it went.
//  3. **Idempotence is convergence, not a refusal.** A second `true` keeps the
//     FIRST timestamp (a double click or a second device converges) and enqueues
//     no second message; a second `false` is a clean 200.
//  4. **Inheritance is symmetric.** A host's hand-over stamps every LIVE
//     `via_host` sub-order with the identical timestamp and skips the cancelled
//     one; the reversal clears exactly the same set.
//  5. **`in_person` enqueues NOTHING** (module 21 defines no template for it),
//     while `pickup` and `packeta` enqueue one row for the friend. The counts are
//     in the response, so they are evidence on every target; the COLUMNS those
//     rows carry are `distribution-foundation.spec.js`'s (the outbox has no API).
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T3 · 16 §UC-DP-004/005/008 — the hand-over routes', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Odovzdanie', { parcel_enabled: true, parcel_fee: 3.9 })
    fx.product = await addProduct(fx.cycle.id)
    fx.P = await makeLocation('Miesto P')

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    // the pickup host: own order + two live guests + one cancelled
    fx.host = await makeFriend('Vydaj Hostitel', '0921 111 111')
    fx.hostOrder = await ownOrder(fx.host, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.P.id })
    const link = await shareLink(fx.host, fx.cycle.id)
    fx.g1 = await submitGuest(link.token, `Vydaj Jedna ${uniq}`, '0922 222 222', line('250g', 1))
    fx.g2 = await submitGuest(link.token, `Vydaj Dva ${uniq}`, '0923 333 333', line('250g', 1))
    fx.gX = await submitGuest(link.token, `Vydaj Zruseny ${uniq}`, '0924 444 444', line('1kg', 1))
    expect((await admin(`/api/guest-orders/${fx.gX.id}/cancel`, { method: 'post' })).status()).toBe(200)

    fx.parcel = await makeFriend('Vydaj Packeta', '0925 555 555')
    fx.parcelOrder = await ownOrder(fx.parcel, fx.cycle.id, line('250g', 1), {
      use_parcel_delivery: true, packeta_address: 'Packeta Petrzalka, Bratislava',
    })

    fx.person = await makeFriend('Vydaj Osobne', '0926 666 666')
    fx.personOrder = await ownOrder(fx.person, fx.cycle.id, line('250g', 1), {
      pickup_location_note: 'Donesiem do prace',
    })

    // a second host who never gets touched — the "nothing else moved" witness
    fx.bystander = await makeFriend('Vydaj Svedok', '0927 777 777')
    fx.bystanderOrder = await ownOrder(fx.bystander, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.P.id })
  })

  test.afterAll(async () => {
    if (!fx.P) return
    const res = await admin(`/api/pickup-locations/${fx.P.id}`, { method: 'delete' })
    expect([204, 404], 'fixture location retired').toContain(res.status())
  })

  // ── the gates, BEFORE anything is packed ──────────────────────────────────
  test('true on an unpacked submitted order ⇒ 409 not_packed, and the row is read back unchanged', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await handOverOrder(fx.hostOrder.id, true)
    expect(res.status(), 'no partial-bag hand-over (PO Q8.a)').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('not_packed')
    expect(body.error, 'the copy names the fix').toMatch(/zabalen/i)

    // ⚠ refusal tests read the row back (CLAUDE.md §Running the e2e suite).
    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at, 'a refused hand-over writes nothing').toBe(null)
    expect(party.stage).toBe('to_pack')
    expect(party.guest_orders.every((g) => g.handed_over_at === null), 'nor on the guests').toBe(true)

    expect(await ledgerSnapshot(fx.host.id), 'ledger untouched').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `a refusal wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('a guest bag with an unchecked item ⇒ 409 not_packed; a cancelled one ⇒ 409 cancelled; unknown ⇒ 404', async () => {
    const res = await handOverGuest(fx.g1.id, true)
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('not_packed')

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.guest_orders.find((g) => g.id === fx.g1.id).handed_over_at).toBe(null)

    const cancelled = await handOverGuest(fx.gX.id, true)
    expect(cancelled.status(), 'cancelled is terminal — there is nothing to give').toBe(409)
    expect((await cancelled.json()).reason).toBe('cancelled')

    const missing = await handOverGuest(99999999, true)
    expect(missing.status()).toBe(404)
  })

  test('a draft / unknown order: 400 on a non-submitted order, 404 on an unknown id', async () => {
    const missing = await handOverOrder(99999999, true)
    expect(missing.status()).toBe(404)

    // a DRAFT: the cart exists, nothing was submitted
    const drafter = await makeFriend('Vydaj Draft', '0928 888 888')
    const put = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${drafter.id}`, {
      headers: drafter.auth, data: { items: [{ product_id: fx.product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(put.status()).toBe(200)
    const draft = (await put.json()).order
    expect(draft, 'the cart PUT created a draft orders row').toBeTruthy()
    expect(draft.status, 'non-vacuity: it really is a draft').toBe('draft')

    const res = await handOverOrder(draft.id, true)
    expect(res.status(), 'a whole-order flag only means something once there IS an order').toBe(400)
    expect((await res.json()).error).toMatch(/odoslan/i)

    // …and `false` is refused on the same basis, rather than silently succeeding.
    expect((await handOverOrder(draft.id, false)).status()).toBe(400)
  })

  // ── the body contract: an EXPLICIT boolean, never a toggle ────────────────
  test('unbindable and non-boolean bodies are 400, never 500 — and write nothing', async () => {
    const raws = ['{}', 'true', 'false', `[${fx.hostOrder.id}]`, '"abc"', '[]', 'null',
      '{"handed_over":"true"}', '{"handed_over":1}', '{"handed_over":null}', '{"handed_over":[true]}']

    for (const raw of raws) {
      for (const path of [`/api/orders/${fx.hostOrder.id}/handed-over`, `/api/guest-orders/${fx.g1.id}/handed-over`]) {
        const res = await ctx.patch(path, {
          headers: { 'X-Admin-Token': adminToken, 'Content-Type': 'application/json' },
          data: raw,
          timeout: TIMEOUT,
        })
        expect(res.status(), `${path} with ${raw} must be 400`).toBe(400)
        const text = await res.text()
        expect(text, 'no internals leak').not.toMatch(/TypeError|RangeError|node_modules|at .*\.js/)
      }
    }

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at, 'not one malformed body wrote anything').toBe(null)
    expect(party.guest_orders.every((g) => g.handed_over_at === null)).toBe(true)
  })

  // ── the happy path, with inheritance and the outbox ───────────────────────
  test('a packed pickup bag hands over: guests inherit the SAME timestamp, the cancelled one is skipped', async () => {
    // pack everything: own items, both live guest bags, then the whole order
    await packGuestItems(fx.cycle.id, fx.host.id, fx.g1.id)
    await packGuestItems(fx.cycle.id, fx.host.id, fx.g2.id)
    await packOrderItems(fx.hostOrder.id, fx.cycle.id, fx.host.id)

    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await handOverOrder(fx.hostOrder.id, true)
    expect(res.status()).toBe(200)
    const body = await res.json()

    expect(body.order.id).toBe(fx.hostOrder.id)
    expect(body.order.handed_over_at, 'stamped').toBeTruthy()
    expect(body.order.packed, 'packed is untouched').toBe(1)
    expect(body.order.stage).toBe('handed')
    expect(body.cycle_stage, 'CS-T1 fills the body; until then the stub answers null').toBe(null)

    // §UC-DP-008: 1 × pickup for the friend + 1 × host per live guest = 3
    expect(body.queued_notifications, 'friend + two live guests').toBe(3)

    const guestIds = body.guests.map((g) => g.id).sort((a, b) => a - b)
    expect(guestIds, 'the cancelled sub-order is not in the bag').toEqual([fx.g1.id, fx.g2.id].sort((a, b) => a - b))
    for (const guest of body.guests) {
      expect(guest.handed_over_at, 'the IDENTICAL timestamp, bound once').toBe(body.order.handed_over_at)
      expect(guest.stage).toBe('handed')
    }

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at).toBe(body.order.handed_over_at)
    expect(party.stage).toBe('handed')
    for (const guest of party.guest_orders) {
      expect(guest.handed_over_at, 'every live bag inherited').toBe(body.order.handed_over_at)
    }

    // the cancelled sub-order, read through the host's own view (it is filtered out
    // of the distribution payload entirely)
    const hostView = await ctx.get(`/api/guest-links/cycle/${fx.cycle.id}`, { headers: fx.host.auth, timeout: TIMEOUT })
    expect(hostView.status()).toBe(200)
    const cancelledRow = (await hostView.json()).guest_orders.find((g) => g.id === fx.gX.id)
    expect(cancelledRow.status).toBe('cancelled')
    expect(cancelledRow.handed_over_at, 'a called-off bag is never handed over').toBe(null)

    // ⚠ ledger-neutral, both ways of asking
    expect(await ledgerSnapshot(fx.host.id), 'no charge, no payment, no reversal').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `hand-over wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])

    // nobody else moved
    const bystander = partyOf(await payload(fx.cycle.id), fx.bystander.id)
    expect(bystander.handed_over_at, 'another party at the same pickup point is untouched').toBe(null)
  })

  test('a second true is 200, keeps the FIRST timestamp and enqueues nothing', async () => {
    const first = partyOf(await payload(fx.cycle.id), fx.host.id).handed_over_at
    expect(first).toBeTruthy()

    const res = await handOverOrder(fx.hostOrder.id, true)
    expect(res.status(), 'a double click converges').toBe(200)
    const body = await res.json()
    expect(body.order.handed_over_at, 'the first hand-over time IS the record').toBe(first)
    expect(body.queued_notifications, 'a repeat enqueues no second message').toBe(0)
    expect(body.order.stage).toBe('handed')
  })

  test('false clears the order AND every inherited guest, and dequeues exactly its queued rows', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await handOverOrder(fx.hostOrder.id, false)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.handed_over_at, 'the mis-click case').toBe(null)
    expect(body.order.stage, 'still packed — the reversal has no packed dependency').toBe('packed')
    expect(body.dequeued_notifications, 'the three queued rows go, and only them').toBe(3)
    expect(body.guests.every((g) => g.handed_over_at === null), 'inheritance is symmetric').toBe(true)

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at).toBe(null)
    expect(party.guest_orders.every((g) => g.handed_over_at === null)).toBe(true)

    // idempotent the other way too
    const again = await handOverOrder(fx.hostOrder.id, false)
    expect(again.status()).toBe(200)
    expect((await again.json()).dequeued_notifications, 'nothing left to dequeue').toBe(0)

    expect(await ledgerSnapshot(fx.host.id), 'a reversal is not a ledger event either').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `un-hand-over wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('un-hand-over is ALWAYS allowed — even on a bag that is not packed', async () => {
    // the in-person bag was never packed; `false` on it is a clean no-op 200.
    const res = await handOverOrder(fx.personOrder.id, false)
    expect(res.status(), 'reversal has no gate of its own').toBe(200)
    const body = await res.json()
    expect(body.order.handed_over_at).toBe(null)
    expect(body.order.stage).toBe('to_pack')
  })

  // ── §UC-DP-008: which bags enqueue, and which enqueues NOTHING ────────────
  test('packeta enqueues one row; in_person enqueues NONE', async () => {
    await packOrderItems(fx.parcelOrder.id, fx.cycle.id, fx.parcel.id)
    const parcel = await handOverOrder(fx.parcelOrder.id, true)
    expect(parcel.status()).toBe(200)
    expect((await parcel.json()).queued_notifications, 'template `packeta`, one row').toBe(1)

    await packOrderItems(fx.personOrder.id, fx.cycle.id, fx.person.id)
    const person = await handOverOrder(fx.personOrder.id, true)
    expect(person.status()).toBe(200)
    const personBody = await person.json()
    expect(personBody.order.handed_over_at, 'the bag IS handed over').toBeTruthy()
    expect(
      personBody.queued_notifications,
      'module 21 defines NO template for an in-person hand-over — the admin arranges it directly'
    ).toBe(0)

    // …and the reversal of an in-person bag has nothing to delete
    const back = await handOverOrder(fx.personOrder.id, false)
    expect(back.status()).toBe(200)
    expect((await back.json()).dequeued_notifications).toBe(0)

    const parcelBack = await handOverOrder(fx.parcelOrder.id, false)
    expect((await parcelBack.json()).dequeued_notifications, 'the packeta row goes').toBe(1)
  })

  // ── §UC-DP-005: the per-bag route, and what it must NOT touch ────────────
  test('a guest hand-over never touches the host — and enqueues one `host` row', async () => {
    const hostBefore = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(hostBefore.handed_over_at, 'the host is back in hand from the reversal above').toBe(null)

    const res = await handOverGuest(fx.g1.id, true)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.guest_order.id).toBe(fx.g1.id)
    expect(body.guest_order.handed_over_at).toBeTruthy()
    expect(body.stage).toBe('handed')
    expect(body.queued_notifications, 'one `host` row for this guest').toBe(1)
    expect(body.cycle_stage).toBe(null)
    expect(body.totals, 'the shipped mutationPayload shape survives').toBeTruthy()

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at, 'a correction on ONE bag is not a hand-over of the party').toBe(null)
    expect(party.stage).toBe('packed')
    expect(party.guest_orders.find((g) => g.id === fx.g1.id).stage).toBe('handed')
    expect(party.guest_orders.find((g) => g.id === fx.g2.id).stage, 'the other bag is untouched').toBe('packed')

    // idempotent, and reversible
    const again = await handOverGuest(fx.g1.id, true)
    expect(again.status()).toBe(200)
    const againBody = await again.json()
    expect(againBody.guest_order.handed_over_at).toBe(body.guest_order.handed_over_at)
    expect(againBody.queued_notifications).toBe(0)

    const back = await handOverGuest(fx.g1.id, false)
    expect(back.status()).toBe(200)
    const backBody = await back.json()
    expect(backBody.guest_order.handed_over_at).toBe(null)
    expect(backBody.dequeued_notifications).toBe(1)
  })

  test('the host hand-over LEAVES a guest that was handed over on its own with its own stamp', async () => {
    // g2 alone first, then the whole party: the host UPDATE only touches rows whose
    // `handed_over_at IS NULL`, so g2 keeps ITS timestamp while g1 gets the host's.
    const solo = await handOverGuest(fx.g2.id, true)
    expect(solo.status()).toBe(200)
    const soloStamp = (await solo.json()).guest_order.handed_over_at

    const res = await handOverOrder(fx.hostOrder.id, true)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const g1 = body.guests.find((g) => g.id === fx.g1.id)
    const g2 = body.guests.find((g) => g.id === fx.g2.id)
    expect(g1.handed_over_at, 'a bag that had none takes the host stamp').toBe(body.order.handed_over_at)
    expect(g2.handed_over_at, 'a bag already out keeps its own first record').toBe(soloStamp)
    expect(body.queued_notifications, 'g2 already had a queued row — only the friend and g1 are new').toBe(2)

    // and the host reversal clears BOTH, because inheritance is symmetric
    const back = await handOverOrder(fx.hostOrder.id, false)
    expect(back.status()).toBe(200)
    const backBody = await back.json()
    expect(backBody.guests.every((g) => g.handed_over_at === null)).toBe(true)
    expect(backBody.dequeued_notifications, 'friend + both guest rows').toBe(3)
  })

  // ⚠ REVIEW FINDING (DP-T3): a reversal of nothing must reverse nothing. The
  // specification's un-hand-over is unconditional, and taken literally it made a
  // `false` on a host who was NEVER handed over clear every live guest's stamp and
  // delete their queued rows — so one no-op click on the host row silently undid a
  // per-bag hand-over (§UC-DP-005 case c) and destroyed a real record. The guests
  // are cleared because the HOST's hand-over is being taken back; when there is
  // none to take back, there is nothing to propagate.
  test('a no-op reversal on the host does NOT undo a guest handed over on its own', async () => {
    const start = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(start.handed_over_at, 'non-vacuity: the host is NOT handed over').toBe(null)

    const solo = await handOverGuest(fx.g2.id, true)
    expect(solo.status()).toBe(200)
    const soloStamp = (await solo.json()).guest_order.handed_over_at
    expect(soloStamp).toBeTruthy()

    const noop = await handOverOrder(fx.hostOrder.id, false)
    expect(noop.status(), 'a reversal is always allowed, even when there is nothing to reverse').toBe(200)
    const body = await noop.json()
    expect(body.guests, 'nothing was propagated').toEqual([])
    expect(body.dequeued_notifications, 'the guest\'s own queued row survives').toBe(0)

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at).toBe(null)
    expect(
      party.guest_orders.find((g) => g.id === fx.g2.id).handed_over_at,
      'the bag that really left is still recorded as gone'
    ).toBe(soloStamp)

    // clean up: a REAL reversal of that one bag, through its own route
    expect((await handOverGuest(fx.g2.id, false)).status()).toBe(200)
    const after = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(after.guest_orders.every((g) => g.handed_over_at === null)).toBe(true)
  })

  // ── the MIXED router, from both sides ─────────────────────────────────────
  test('handed_over is ADMIN-only while delivered stays HOST-only — on the same sub-order', async () => {
    // the admin route refuses the HOST's own Bearer token…
    const asHost = await ctx.patch(`/api/guest-orders/${fx.g1.id}/handed-over`, {
      headers: fx.host.auth, data: { handed_over: true }, timeout: TIMEOUT,
    })
    expect(asHost.status(), 'handed_over is admin-only exactly as paid is').toBe(401)

    // …and the host route refuses the ADMIN token, unchanged by this row.
    const asAdmin = await admin(`/api/guest-orders/${fx.g1.id}/delivered`, {
      method: 'patch', data: { delivered: true },
    })
    expect(asAdmin.status(), 'an admin token is not host identity').toBe(401)

    // the host's own delivered tick still works, and is a DIFFERENT column
    const hostTick = await ctx.patch(`/api/guest-orders/${fx.g1.id}/delivered`, {
      headers: fx.host.auth, data: { delivered: true }, timeout: TIMEOUT,
    })
    expect(hostTick.status(), 'PATCH …/delivered is undisturbed').toBe(200)
    const ticked = (await hostTick.json()).guest_order
    expect(ticked.delivered).toBe(1)
    expect(ticked.delivered_at).toBeTruthy()
    expect(ticked.handed_over_at, 'delivered is not handed_over').toBe(null)

    const untick = await ctx.patch(`/api/guest-orders/${fx.g1.id}/delivered`, {
      headers: fx.host.auth, data: { delivered: false }, timeout: TIMEOUT,
    })
    expect(untick.status()).toBe(200)
  })

  test('both routes are 401 to anonymous, to a friend Bearer and to a wrong token', async () => {
    const targets = [
      `/api/orders/${fx.hostOrder.id}/handed-over`,
      `/api/guest-orders/${fx.g1.id}/handed-over`,
    ]
    for (const path of targets) {
      const anon = await ctx.patch(path, { data: { handed_over: true }, timeout: TIMEOUT })
      expect(anon.status(), `${path} anonymous`).toBe(401)

      const friend = await ctx.patch(path, {
        headers: fx.bystander.auth, data: { handed_over: true }, timeout: TIMEOUT,
      })
      expect(friend.status(), `${path} friend Bearer`).toBe(401)

      const wrong = await ctx.patch(path, {
        headers: { 'X-Admin-Token': 'not-a-real-token' }, data: { handed_over: true }, timeout: TIMEOUT,
      })
      expect(wrong.status(), `${path} wrong admin token`).toBe(401)
    }

    // non-vacuity: nothing above changed a thing
    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.handed_over_at).toBe(null)
  })

  // ── the ledger, over the WHOLE flow ───────────────────────────────────────
  test('across every hand-over and reversal in this file, the ledger never moved', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    // ⚠ the bag is ALREADY packed here, and deliberately not re-packed:
    // `PATCH /orders/:id/packed` TOGGLES, and an un-pack posts the ledger reversal
    // — which is precisely the row this test must not see.
    const packedNow = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(packedNow.stage, 'non-vacuity: there is a packed bag to hand over').toBe('packed')

    expect((await handOverOrder(fx.hostOrder.id, true)).status()).toBe(200)
    expect((await handOverGuest(fx.g1.id, false)).status()).toBe(200)
    expect((await handOverGuest(fx.g1.id, true)).status()).toBe(200)
    expect((await handOverOrder(fx.hostOrder.id, false)).status()).toBe(200)

    expect(await ledgerSnapshot(fx.host.id), 'stage 3 is ledger-neutral by construction').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `the flow wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. DP-T4 — `POST /api/cycles/:id/distribution/hand-over`, the BULK route
//    (§UC-DP-006), plus §UC-DP-013 item 3 (it joins the admin sweep).
//
// What carries this section, in the order of how badly each one bites:
//
//  1. ⚠ **ALL-OR-NOTHING, AND THE 409 NAMES THE OFFENDERS.** The confirm dialog
//     promised „n balíčkov prejde" on a SNAPSHOT. If another device un-packed one
//     in between, a partial success would leave the toast count wrong and one bag
//     silently behind — so the whole batch aborts and the admin is told exactly
//     which id blocked it. The refusal is read back on EVERY row in the batch,
//     including the ones that were perfectly packed.
//  2. ⚠ **A REFUSED BATCH MINTS NO NOTIFICATION.** A `queued` row is not visible
//     through any API in module 16, so the proof is behavioural: hand the SAME bag
//     over afterwards through the per-bag route and require `queued_notifications:
//     1`. `enqueueForHandOver` dedupes on a `queued` row, so a row left behind by
//     the refused batch would turn that 1 into a 0. (DP-T3's lesson: a row minted
//     for something that did not happen is invisible until module 21 sends it.)
//  3. **ONE timestamp for the whole batch** — two different parties and their
//     guests all carry the identical string, because the plan card's „odovzdané"
//     bar and module 21's segments group by it.
//  4. **Already-handed ids are SKIPPED, never errors** (an idempotent re-run of a
//     group) and mint nothing.
//  5. **A guest whose host is in the same batch is stamped ONCE** — inherited by
//     the host's write, not stamped a second time by its own id, and counted once.
//  6. **No `transactions` row, ever** — the same two-sided pin as section 4.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T4 · 16 §UC-DP-006 — the bulk hand-over', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Hromadne')
    fx.product = await addProduct(fx.cycle.id)
    fx.Q = await makeLocation('Miesto Q')

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    // the host: own order + two live guests + one cancelled
    fx.host = await makeFriend('Hromada Hostitel', '0931 111 111')
    fx.hostOrder = await ownOrder(fx.host, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.Q.id })
    const link = await shareLink(fx.host, fx.cycle.id)
    fx.g1 = await submitGuest(link.token, `Hromada Jedna ${uniq}`, '0932 222 222', line('250g', 1))
    fx.g2 = await submitGuest(link.token, `Hromada Dva ${uniq}`, '0933 333 333', line('250g', 1))
    fx.gX = await submitGuest(link.token, `Hromada Zruseny ${uniq}`, '0934 444 444', line('1kg', 1))
    expect((await admin(`/api/guest-orders/${fx.gX.id}/cancel`, { method: 'post' })).status()).toBe(200)

    // a second packed party at the same point — the batch is a GROUP, not one bag
    fx.mate = await makeFriend('Hromada Druhy', '0935 555 555')
    fx.mateOrder = await ownOrder(fx.mate, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.Q.id })

    // the offender: submitted, items checked, but the whole-order gate never taken
    fx.loose = await makeFriend('Hromada Nezabaleny', '0936 666 666')
    fx.looseOrder = await ownOrder(fx.loose, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.Q.id })

    // §UC-DP-005 case (b): a host with NO own order — their party IS their guest bags
    fx.solo = await makeFriend('Hromada Bez Vlastnej', '0937 777 777')
    const soloLink = await shareLink(fx.solo, fx.cycle.id)
    fx.sg1 = await submitGuest(soloLink.token, `Hromada Solo ${uniq}`, '0938 888 888', line('250g', 1))
    expect((await admin(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.solo.id}/pickup`, {
      method: 'patch', data: { pickup_location_id: fx.Q.id },
    })).status()).toBe(200)

    // ANOTHER cycle, for the foreign-id refusal
    fx.foreignCycle = await makeCycle('Hromada Cudzi')
    fx.foreignProduct = await addProduct(fx.foreignCycle.id)
    fx.foreigner = await makeFriend('Hromada Cudzinec', '0939 999 999')
    fx.foreignOrder = await ownOrder(
      fx.foreigner, fx.foreignCycle.id,
      [{ product_id: fx.foreignProduct.id, variant: '250g', quantity: 1 }],
      { pickup_location_note: 'Inde' },
    )
    const foreignLink = await shareLink(fx.foreigner, fx.foreignCycle.id)
    fx.foreignGuest = await submitGuest(
      foreignLink.token, `Hromada Cudzi Host ${uniq}`, '0940 000 000',
      [{ product_id: fx.foreignProduct.id, variant: '250g', quantity: 1 }],
    )

    // pack: the host (own + both live guest bags), the mate, and the solo guest.
    // `loose` gets its ITEMS checked but never the whole-order gate.
    await packGuestItems(fx.cycle.id, fx.host.id, fx.g1.id)
    await packGuestItems(fx.cycle.id, fx.host.id, fx.g2.id)
    await packOrderItems(fx.hostOrder.id, fx.cycle.id, fx.host.id)
    await packOrderItems(fx.mateOrder.id, fx.cycle.id, fx.mate.id)
    await packOrderItems(null, fx.cycle.id, fx.loose.id)
    await packGuestItems(fx.cycle.id, fx.solo.id, fx.sg1.id)
  })

  test.afterAll(async () => {
    if (!fx.Q) return
    const res = await admin(`/api/pickup-locations/${fx.Q.id}`, { method: 'delete' })
    expect([204, 404], 'fixture location retired').toContain(res.status())
  })

  // ── the body contract ─────────────────────────────────────────────────────
  test('malformed bodies are 400, never 500 — and write nothing', async () => {
    const raws = [
      '{}',                                        // both arrays are REQUIRED
      `{"order_ids":[${fx.hostOrder.id}]}`,        // …both of them
      '{"guest_order_ids":[]}',
      '{"order_ids":[],"guest_order_ids":[]}',     // at least ONE id overall
      'true', '"abc"', 'null', '[]',               // not an object at all
      `[${fx.hostOrder.id}]`,                      // ⚠ a bare array body
      `{"order_ids":${fx.hostOrder.id},"guest_order_ids":[]}`,      // not an array
      `{"order_ids":{"0":${fx.hostOrder.id}},"guest_order_ids":[]}`, // nor an array-ish object
      `{"order_ids":["${fx.hostOrder.id}"],"guest_order_ids":[]}`,  // a STRING id
      '{"order_ids":[1.5],"guest_order_ids":[]}',
      '{"order_ids":[0],"guest_order_ids":[]}',
      '{"order_ids":[-1],"guest_order_ids":[]}',
      '{"order_ids":[null],"guest_order_ids":[]}',
      '{"order_ids":[true],"guest_order_ids":[]}',
      '{"order_ids":[[1]],"guest_order_ids":[]}',
      `{"order_ids":[${fx.hostOrder.id},null],"guest_order_ids":[]}`, // one bad element poisons it
      '{"order_ids":[],"guest_order_ids":["x"]}',
    ]

    // ⚠ The three JSON values body-parser's strict mode refuses before the handler
    // ever runs answer with ITS error shape, so only the status is asserted for
    // them. Everything else reaches the binder and must carry ITS reason — without
    // that, a 400 raised for some unrelated cause (a foreign id, say) would pass as
    // evidence about the binder.
    const strictRefused = new Set(['true', '"abc"', 'null'])

    for (const raw of raws) {
      const res = await handOverBatchRaw(fx.cycle.id, raw)
      expect(res.status(), `body ${raw} must be 400`).toBe(400)
      const text = await res.text()
      expect(text, 'no internals leak').not.toMatch(/TypeError|RangeError|node_modules|at .*\.js/)
      if (!strictRefused.has(raw)) {
        expect(JSON.parse(text).reason, `body ${raw} is refused by the BINDER`).toBe('invalid_ids')
      }
    }

    // …and the 501st id is refused as a whole (≤ 500 per array).
    // ⚠ NON-VACUITY: the list is one REAL id of this cycle repeated, not a range of
    // ids that happen to be foreign. With the cap deleted the binder would dedupe it
    // to a single valid id and the route would answer 409 `not_packed` (that order is
    // deliberately unpacked) — so this test fails the moment the cap stops working.
    // A range like [1..501] would have kept passing on `foreign_id` and proved
    // nothing about the cap at all.
    const tooMany = Array.from({ length: 501 }, () => fx.looseOrder.id)
    const big = await handOverBatchRaw(
      fx.cycle.id, JSON.stringify({ order_ids: tooMany, guest_order_ids: [] })
    )
    expect(big.status(), '≤ 500 elements per array').toBe(400)
    expect((await big.json()).reason, 'refused for its LENGTH, not for its contents').toBe('invalid_ids')

    // ⚠ refusal tests read the rows back
    const body = await payload(fx.cycle.id)
    for (const friend of [fx.host, fx.mate, fx.loose]) {
      expect(partyOf(body, friend.id).handed_over_at, 'not one malformed body wrote anything').toBe(null)
    }
    expect(partyOf(body, fx.host.id).guest_orders.every((g) => g.handed_over_at === null)).toBe(true)
  })

  test('an unknown cycle is 404, and the route is 401 to everyone but the admin', async () => {
    const missing = await handOverBatch(99999999, [fx.hostOrder.id], [])
    expect(missing.status()).toBe(404)

    const path = `/api/cycles/${fx.cycle.id}/distribution/hand-over`
    const data = { order_ids: [fx.hostOrder.id], guest_order_ids: [] }

    const anon = await ctx.post(path, { data, timeout: TIMEOUT })
    expect(anon.status(), 'a bulk hand-over is not public').toBe(401)

    const friend = await ctx.post(path, { headers: fx.host.auth, data, timeout: TIMEOUT })
    expect(friend.status(), 'a friend Bearer is not admin identity').toBe(401)

    const wrong = await ctx.post(path, {
      headers: { 'X-Admin-Token': 'not-a-real-token' }, data, timeout: TIMEOUT,
    })
    expect(wrong.status()).toBe(401)

    // non-vacuity: nothing above moved
    expect(partyOf(await payload(fx.cycle.id), fx.host.id).handed_over_at).toBe(null)
  })

  // ── the refusals, and the proof that they wrote nothing ───────────────────
  test('an id from ANOTHER cycle ⇒ 400 foreign_id naming it, and nothing is written', async () => {
    const res = await handOverBatch(
      fx.cycle.id, [fx.hostOrder.id, fx.foreignOrder.id], [fx.g1.id, fx.foreignGuest.id]
    )
    expect(res.status(), 'a batch is scoped to ONE cycle').toBe(400)
    const body = await res.json()
    expect(body.reason).toBe('foreign_id')
    expect(body.order_ids, 'the foreign order is named').toEqual([fx.foreignOrder.id])
    expect(body.guest_order_ids, 'and the foreign guest').toEqual([fx.foreignGuest.id])

    // an id that does not exist at all answers the same way — never an oracle
    const ghost = await handOverBatch(fx.cycle.id, [99999999], [])
    expect(ghost.status()).toBe(400)
    expect((await ghost.json()).reason).toBe('foreign_id')

    const body2 = await payload(fx.cycle.id)
    expect(partyOf(body2, fx.host.id).handed_over_at, 'the VALID half of the batch is untouched').toBe(null)
    expect(partyOf(body2, fx.host.id).guest_orders.every((g) => g.handed_over_at === null)).toBe(true)
  })

  test('one unpacked bag aborts the WHOLE batch ⇒ 409 naming it, nothing written, nothing queued', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await handOverBatch(fx.cycle.id, [fx.hostOrder.id, fx.mateOrder.id, fx.looseOrder.id], [])
    expect(res.status(), 'a partial success would leave one bag silently behind').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('not_packed')
    expect(body.order_ids, 'exactly the offender, so the admin can reload that row').toEqual([fx.looseOrder.id])
    expect(body.guest_order_ids).toEqual([])
    expect(body.error, 'the copy names the fix').toMatch(/zabalen/i)

    // ⚠ ALL THREE rows read back, not just the offender
    const after = await payload(fx.cycle.id)
    for (const friend of [fx.host, fx.mate, fx.loose]) {
      expect(partyOf(after, friend.id).handed_over_at, `${friend.name} must be untouched`).toBe(null)
    }
    expect(partyOf(after, fx.host.id).guest_orders.every((g) => g.handed_over_at === null),
      'nor did the host\'s guests inherit anything').toBe(true)
    expect(partyOf(after, fx.mate.id).packed, 'and the packed flag is not collateral').toBe(1)

    expect(await ledgerSnapshot(fx.host.id), 'a refusal is not a ledger event').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `the refused batch wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])

    // ⚠ AND IT QUEUED NOTHING. `enqueueForHandOver` dedupes on a `queued` row, so a
    // row minted by the aborted batch would make this per-bag hand-over answer 0.
    const solo = await handOverOrder(fx.mateOrder.id, true)
    expect(solo.status()).toBe(200)
    expect((await solo.json()).queued_notifications,
      'the aborted batch left no queued row behind').toBe(1)
    const back = await handOverOrder(fx.mateOrder.id, false)
    expect(back.status()).toBe(200)
    expect((await back.json()).dequeued_notifications).toBe(1)
  })

  test('a DRAFT order in the batch is an offender too — it cannot be packed at all', async () => {
    const drafter = await makeFriend('Hromada Rozpisany', '0946 666 666')
    const put = await ctx.put(`/api/orders/cycle/${fx.cycle.id}/friend/${drafter.id}`, {
      headers: drafter.auth,
      data: { items: [{ product_id: fx.product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(put.status()).toBe(200)
    const draft = (await put.json()).order
    expect(draft.status, 'non-vacuity: it really is a draft').toBe('draft')

    const res = await handOverBatch(fx.cycle.id, [fx.hostOrder.id, draft.id], [])
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('not_packed')
    expect(body.order_ids).toEqual([draft.id])

    expect(partyOf(await payload(fx.cycle.id), fx.host.id).handed_over_at,
      'and the packed bag beside it is untouched').toBe(null)
  })

  test('a cancelled guest in the batch is an offender, listed SEPARATELY', async () => {
    const only = await handOverBatch(fx.cycle.id, [], [fx.gX.id])
    expect(only.status(), 'there is nothing to give').toBe(409)
    const onlyBody = await only.json()
    expect(onlyBody.reason).toBe('cancelled')
    expect(onlyBody.cancelled_guest_order_ids).toEqual([fx.gX.id])
    expect(onlyBody.guest_order_ids, 'a called-off bag is not an unpacked one').toEqual([])

    // mixed with a genuinely unpacked bag: both lists, and the pack reason wins
    const mixed = await handOverBatch(fx.cycle.id, [fx.looseOrder.id], [fx.gX.id])
    expect(mixed.status()).toBe(409)
    const mixedBody = await mixed.json()
    expect(mixedBody.reason).toBe('not_packed')
    expect(mixedBody.order_ids).toEqual([fx.looseOrder.id])
    expect(mixedBody.cancelled_guest_order_ids).toEqual([fx.gX.id])

    const after = await payload(fx.cycle.id)
    expect(partyOf(after, fx.loose.id).handed_over_at).toBe(null)
    expect(partyOf(after, fx.host.id).handed_over_at).toBe(null)
  })

  // ── the happy path ────────────────────────────────────────────────────────
  test('two packed parties ⇒ ONE timestamp across every bag, guests inherited once', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await handOverBatch(fx.cycle.id, [fx.hostOrder.id, fx.mateOrder.id], [])
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.handed_over, 'two orders').toBe(2)
    expect(body.already_handed).toBe(0)
    expect(body.guests_inherited, 'the two LIVE guests; the cancelled one is skipped').toBe(2)
    expect(body.queued_notifications, '2 × pickup + 2 × host').toBe(4)
    expect(body.cycle_stage, 'CS-T1 fills the body; until then the stub answers null').toBe(null)

    const after = await payload(fx.cycle.id)
    const host = partyOf(after, fx.host.id)
    const mate = partyOf(after, fx.mate.id)
    expect(host.handed_over_at).toBeTruthy()
    expect(host.stage).toBe('handed')
    expect(mate.stage).toBe('handed')
    expect(mate.handed_over_at, 'ONE timestamp, read once and bound to every UPDATE')
      .toBe(host.handed_over_at)
    for (const guest of host.guest_orders) {
      expect(guest.handed_over_at, 'the guests carry the identical string').toBe(host.handed_over_at)
    }
    expect(partyOf(after, fx.loose.id).handed_over_at, 'nobody outside the batch moved').toBe(null)
    expect(partyOf(after, fx.solo.id).handed_over_at).toBe(null)

    expect(await ledgerSnapshot(fx.host.id), 'stage 3 is ledger-neutral in bulk too').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `the bulk hand-over wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('re-sending the same batch: already_handed, and NOT one new message', async () => {
    const stamp = partyOf(await payload(fx.cycle.id), fx.host.id).handed_over_at
    expect(stamp, 'non-vacuity: the group really is out').toBeTruthy()

    const res = await handOverBatch(fx.cycle.id, [fx.hostOrder.id, fx.mateOrder.id], [])
    expect(res.status(), 'an idempotent re-run of a group, not a refusal').toBe(200)
    const body = await res.json()
    expect(body.handed_over).toBe(0)
    expect(body.already_handed).toBe(2)
    expect(body.guests_inherited).toBe(0)
    expect(body.queued_notifications, 'a no-op mints nothing — DP-T3\'s lesson, in bulk').toBe(0)

    const after = await payload(fx.cycle.id)
    expect(partyOf(after, fx.host.id).handed_over_at, 'the FIRST hand-over time is the record').toBe(stamp)
    expect(partyOf(after, fx.host.id).guest_orders.every((g) => g.handed_over_at === stamp)).toBe(true)
  })

  // ⚠ REVIEW FINDING (DP-T4): the already-handed SKIP skips the ORDER, never its
  // bag. A colleague whose sub-order arrives AFTER their host's bag went out is
  // exactly the case `PATCH /orders/:id/handed-over` stamps on a repeat call — so a
  // bulk re-run of the group must stamp it too, or the two writers of this column
  // disagree and the group button silently leaves a bag behind with nothing on
  // screen to say so. Reachable because NO hand-over route has a cycle-status gate:
  // a bag can be handed over while the cycle is still open and taking orders.
  test('a re-run stamps a colleague who arrived AFTER the host bag went out', async () => {
    const mateBefore = partyOf(await payload(fx.cycle.id), fx.mate.id)
    expect(mateBefore.handed_over_at, 'non-vacuity: the mate is already handed over').toBeTruthy()
    expect(mateBefore.guest_orders.length, 'and had no colleagues at the time').toBe(0)

    const mateLink = await shareLink(fx.mate, fx.cycle.id)
    const late = await submitGuest(mateLink.token, `Hromada Neskoro ${uniq}`, '0947 777 777',
      [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])

    const res = await handOverBatch(fx.cycle.id, [fx.mateOrder.id], [])
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.handed_over, 'the order itself was already out').toBe(0)
    expect(body.already_handed).toBe(1)
    expect(body.guests_inherited, 'the late bag is stamped by the SAME re-run').toBe(1)
    expect(body.queued_notifications, 'and it is the only thing that mints a message').toBe(1)
    expect(body.handed_over_at, 'nothing took the batch stamp — the bag kept its own').toBe(null)

    const mate = partyOf(await payload(fx.cycle.id), fx.mate.id)
    const lateRow = mate.guest_orders.find((g) => g.id === late.id)
    // ⚠ This is also the one NON-FLAKY proof that the stamp is BOUND rather than
    // re-evaluated per statement: an inline `CURRENT_TIMESTAMP` here would write the
    // current second, which is minutes away from the host bag's original one. The
    // „one timestamp across the batch" assertion above cannot make that distinction,
    // because same-batch writes normally land inside the same second anyway.
    expect(lateRow.handed_over_at, 'the colleague carries the HOST bag\'s original stamp')
      .toBe(mateBefore.handed_over_at)
    expect(mate.handed_over_at, 'and the host\'s own stamp is untouched').toBe(mateBefore.handed_over_at)
    expect(lateRow.items.every((i) => !i.packed), 'inheritance has no pack gate, exactly as per bag').toBe(true)

    // the per-bag route agrees — a second re-run through EITHER writer is a no-op now
    const perBag = await handOverOrder(fx.mateOrder.id, true)
    expect(perBag.status()).toBe(200)
    expect((await perBag.json()).queued_notifications, 'nothing left to stamp').toBe(0)
  })

  test('a guest under a host in the SAME batch is stamped, counted and queued exactly once', async () => {
    // take the host's party back — the guests come with it (inheritance is symmetric)
    const reset = await handOverOrder(fx.hostOrder.id, false)
    expect(reset.status()).toBe(200)
    expect((await reset.json()).dequeued_notifications, 'friend + two guests').toBe(3)

    // ⚠ every id sent TWICE as well: a double-click on the board must not count,
    // stamp or enqueue anything twice either.
    const res = await handOverBatch(
      fx.cycle.id, [fx.hostOrder.id, fx.hostOrder.id], [fx.g1.id, fx.g1.id]
    )
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.handed_over, 'the order — the explicitly-listed guest is NOT a second unit').toBe(1)
    expect(body.guests_inherited, 'both live guests, each once').toBe(2)
    expect(body.already_handed, 'the deduped guest is not "already handed" either').toBe(0)
    expect(body.queued_notifications, 'friend + two guests — never four').toBe(3)

    const host = partyOf(await payload(fx.cycle.id), fx.host.id)
    const g1 = host.guest_orders.find((g) => g.id === fx.g1.id)
    expect(g1.handed_over_at, 'inherited once, with the host\'s stamp').toBe(host.handed_over_at)
    expect(host.guest_orders.find((g) => g.id === fx.g2.id).handed_over_at).toBe(host.handed_over_at)
  })

  test('a host with NO own order hands over through their guest ids alone', async () => {
    const soloBefore = partyOf(await payload(fx.cycle.id), fx.solo.id)
    expect(soloBefore.has_own_order, 'non-vacuity: there is no orders row to PATCH').toBe(false)
    expect(soloBefore.stage).toBe('packed')

    const res = await handOverBatch(fx.cycle.id, [], [fx.sg1.id])
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.handed_over, 'the bag IS the unit here').toBe(1)
    expect(body.guests_inherited).toBe(0)
    expect(body.queued_notifications, 'one `host` row for the guest').toBe(1)

    const solo = partyOf(await payload(fx.cycle.id), fx.solo.id)
    expect(solo.stage, 'every live sub-order carries a stamp ⇒ the party is handed').toBe('handed')
    expect(solo.guest_orders.find((g) => g.id === fx.sg1.id).handed_over_at).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. DP-T4 — §UC-DP-007: a handed-over bag cannot be un-packed or item-unchecked.
//
// Stage order is real: `handed` IMPLIES `packed`. Un-packing posts the LEDGER
// REVERSAL and re-opens the bag for changes — neither may happen to a bag that
// already left the admin's hands without the admin first taking the hand-over back
// (resolved conflict 4). Three doors reach `unpackOrder()` and all three are gated:
//
//   • `PATCH /api/orders/:id/packed`            — the whole-order toggle
//   • `PATCH /api/order-items/:id/packed`       — auto-unpack at order-items.js:40
//   • `PATCH /api/guest-order-items/:id/packed` — auto-unpack of the HOST's order
//
// ⚠ The tell that the gate is real and not cosmetic is the LEDGER: an un-pack that
// slipped through writes a `Stornované` charge. Every refusal below pins the row
// back AND the ledger, and the last test proves the normal un-pack still posts that
// row once the hand-over is taken back — the gate is a gate, not a wall.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T4 · 16 §UC-DP-007 — stage order: handed implies packed', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Poradie')
    fx.product = await addProduct(fx.cycle.id)
    fx.R = await makeLocation('Miesto R')

    const p = fx.product.id
    const line = (variant, quantity) => [{ product_id: p, variant, quantity }]

    fx.host = await makeFriend('Poradie Hostitel', '0941 111 111')
    fx.hostOrder = await ownOrder(fx.host, fx.cycle.id, line('250g', 2), { pickup_location_id: fx.R.id })
    fx.link = await shareLink(fx.host, fx.cycle.id)
    fx.gA = await submitGuest(fx.link.token, `Poradie Jedna ${uniq}`, '0942 222 222', line('250g', 1))

    // §UC-DP-005 case (b) again, because the guest-item gate has TWO predicates and
    // this party isolates the first: a guest handed over under a host with NO own
    // order has its own stamp and no `orders` row anywhere near it.
    fx.solo = await makeFriend('Poradie Bez Vlastnej', '0943 333 333')
    const soloLink = await shareLink(fx.solo, fx.cycle.id)
    fx.gB = await submitGuest(soloLink.token, `Poradie Solo ${uniq}`, '0944 444 444', line('250g', 1))

    await packGuestItems(fx.cycle.id, fx.host.id, fx.gA.id)
    await packOrderItems(fx.hostOrder.id, fx.cycle.id, fx.host.id)
    await packGuestItems(fx.cycle.id, fx.solo.id, fx.gB.id)

    // hand the host's party over THROUGH THE BULK ROUTE, and the solo bag on its own
    const bulk = await handOverBatch(fx.cycle.id, [fx.hostOrder.id], [fx.gB.id])
    expect(bulk.status(), 'fixture hand-over').toBe(200)
    expect((await bulk.json()).guests_inherited).toBe(1)
  })

  test.afterAll(async () => {
    if (!fx.R) return
    const res = await admin(`/api/pickup-locations/${fx.R.id}`, { method: 'delete' })
    expect([204, 404], 'fixture location retired').toContain(res.status())
  })

  test('un-packing a handed-over order ⇒ 409 handed_over, packed still 1, ledger unmoved', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const res = await admin(`/api/orders/${fx.hostOrder.id}/packed`, { method: 'patch' })
    expect(res.status(), 'un-packing would post the reversal on a bag that is gone').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('handed_over')
    expect(body.error, 'the copy names the fix').toMatch(/zrušte odovzdanie/i)

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.packed, 'the row is read back').toBe(1)
    expect(party.stage).toBe('handed')
    expect(party.handed_over_at).toBeTruthy()

    expect(await ledgerSnapshot(fx.host.id), 'no `Stornované` charge slipped through').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `a refused un-pack wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('un-checking an ITEM of a handed-over order ⇒ 409, and the auto-unpack is never reached', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    const item = party.items[0]
    expect(item.packed, 'non-vacuity: the item is checked').toBe(1)

    const res = await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('handed_over')

    const after = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(after.items.find((i) => i.id === item.id).packed, 'the item stays checked').toBe(1)
    expect(after.packed, 'and the order was not auto-unpacked').toBe(1)
    expect(after.stage).toBe('handed')

    expect(await ledgerSnapshot(fx.host.id), 'order-items.js:40 never ran').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `a refused item uncheck wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('un-checking a GUEST item ⇒ 409 on the guest\'s OWN stamp (a host with no own order)', async () => {
    const solo = partyOf(await payload(fx.cycle.id), fx.solo.id)
    expect(solo.has_own_order, 'non-vacuity: there is no host order to look at').toBe(false)
    const guest = solo.guest_orders.find((g) => g.id === fx.gB.id)
    expect(guest.handed_over_at, 'the bag carries its own stamp').toBeTruthy()

    const item = guest.items[0]
    expect(item.packed).toBe(1)
    const res = await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('handed_over')

    const after = partyOf(await payload(fx.cycle.id), fx.solo.id)
      .guest_orders.find((g) => g.id === fx.gB.id)
    expect(after.items.find((i) => i.id === item.id).packed, 'the item stays checked').toBe(1)
  })

  test('un-checking a guest item ⇒ 409 on the HOST\'s stamp, while CHECKING stays allowed', async () => {
    const before = await ledgerSnapshot(fx.host.id)
    const mark = ledgerWatermark()

    // a colleague who arrives AFTER the host's bag went out: the sub-order has NO
    // stamp of its own, and un-checking it would un-pack the HOST's handed-over
    // order (guest-order-items.js:61-67) — which is the second predicate.
    const late = await submitGuest(fx.link.token, `Poradie Neskoro ${uniq}`, '0945 555 555',
      [{ product_id: fx.product.id, variant: '250g', quantity: 1 }])

    let guest = partyOf(await payload(fx.cycle.id), fx.host.id).guest_orders.find((g) => g.id === late.id)
    expect(guest.handed_over_at, 'non-vacuity: THIS bag was never handed over').toBe(null)
    const item = guest.items[0]
    expect(item.packed).toBe(0)

    const check = await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })
    expect(check.status(), 'CHECKING an item is unaffected by the host being handed over').toBe(200)

    const uncheck = await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })
    expect(uncheck.status(), 'un-checking would un-pack the host\'s handed-over order').toBe(409)
    expect((await uncheck.json()).reason).toBe('handed_over')

    const after = partyOf(await payload(fx.cycle.id), fx.host.id)
    guest = after.guest_orders.find((g) => g.id === late.id)
    expect(guest.items.find((i) => i.id === item.id).packed, 'the tick survives the refusal').toBe(1)
    expect(after.packed, 'and the host is still packed').toBe(1)
    expect(after.stage).toBe('handed')

    expect(await ledgerSnapshot(fx.host.id), 'the host\'s balance never moved').toEqual(before)
    const rows = ledgerRowsSince(mark, fx.host.id, fx.hostOrder.id)
    if (rows !== null) expect(rows, `a refused guest uncheck wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('after the hand-over is taken back, the un-pack works exactly as before — reversal row and all', async () => {
    const before = await ledgerSnapshot(fx.host.id)

    const back = await handOverOrder(fx.hostOrder.id, false)
    expect(back.status()).toBe(200)
    expect((await back.json()).order.handed_over_at).toBe(null)

    const res = await admin(`/api/orders/${fx.hostOrder.id}/packed`, { method: 'patch' })
    expect(res.status(), 'the gate is a gate, not a wall').toBe(200)

    const party = partyOf(await payload(fx.cycle.id), fx.host.id)
    expect(party.packed).toBe(0)
    expect(party.stage).toBe('to_pack')

    const after = await ledgerSnapshot(fx.host.id)
    expect(after.count, 'the `Stornované` reversal is posted, exactly as today').toBe(before.count + 1)

    // …and the item toggle is open again too
    const item = party.items[0]
    const uncheck = await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })
    expect(uncheck.status()).toBe(200)
    expect((await uncheck.json()).packed).toBe(0)
  })
})
