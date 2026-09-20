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
// ⚠ NO WRITER FOR `handed_over_at` EXISTS YET. `PATCH /orders/:id/handed-over` and
// `PATCH /guest-orders/:id/handed-over` are DP-T3's. So the `stage: 'handed'` and
// `handed_count` cases here stamp the column DIRECTLY through `node:sqlite`, which
// needs `DB_PATH` pointed at the server's database and therefore carries the
// documented skip (the `distribution-foundation.spec.js` / `guest-admin-view.spec.js`
// idiom). ⚠ DP-T3 MUST REWRITE those two tests to drive the real routes — left as
// direct writes they stop being evidence about the endpoint the moment one exists.

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

/** ⚠ TEMPORARY — DP-T3 replaces every call with the real admin route. */
function stampHandedOver(table, id, when) {
  const db = new DatabaseSync(DB_PATH)
  try {
    // `table` is a literal from this file only; `id` is bound.
    db.prepare(`UPDATE ${table} SET handed_over_at = ? WHERE id = ?`).run(when, Number(id))
  } finally {
    db.close()
  }
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

  test('handed_over_at moves stage to handed, on the party and on the guest', async () => {
    // ⚠ DP-T3: rewrite this to drive PATCH /api/orders/:id/handed-over.
    test.skip(!DB_PATH, 'needs DB_PATH pointed at the server database (the documented skip)')

    stampHandedOver('orders', fx.aOrder.id, '2026-09-20 10:00:00')
    stampHandedOver('guest_orders', fx.guest1.id, '2026-09-20 10:05:00')

    const body = await payload(fx.cycle.id)
    const a = partyOf(body, fx.a.id)
    expect(a.handed_over_at).toBe('2026-09-20 10:00:00')
    expect(a.stage, 'handed wins over packed').toBe('handed')

    const party = partyOf(body, fx.host.id)
    const g1 = party.guest_orders.find((g) => g.id === fx.guest1.id)
    expect(g1.handed_over_at).toBe('2026-09-20 10:05:00')
    expect(g1.stage).toBe('handed')
    expect(party.stage, 'a host with an own order reads its OWN column').toBe('packed')
    expect(party.handed_over_at).toBe(null)

    expect(body.totals).toEqual({ count: 5, packed_count: 2, handed_count: 1 })
    const plan = planFor(body, `loc${fx.L.id}`)
    expect(plan.handed_count).toBe(1)
    expect(plan.packed_count, 'packed_count still INCLUDES the handed party').toBe(2)
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

  test('derived handed_over_at: only when EVERY live sub-order carries one', async () => {
    // ⚠ DP-T3: rewrite this to drive PATCH /api/guest-orders/:id/handed-over.
    test.skip(!DB_PATH, 'needs DB_PATH pointed at the server database (the documented skip)')

    stampHandedOver('guest_orders', fx.g1.id, '2026-09-20 11:00:00')
    let body = await payload(fx.cycle.id)
    expect(body.distribution[0].handed_over_at, 'one of two is not the bag').toBe(null)
    expect(body.distribution[0].stage).toBe('packed')
    expect(body.totals.handed_count).toBe(0)

    stampHandedOver('guest_orders', fx.g2.id, '2026-09-20 11:30:00')
    body = await payload(fx.cycle.id)
    const party = body.distribution[0]
    expect(party.handed_over_at, 'the MAX over the live sub-orders').toBe('2026-09-20 11:30:00')
    expect(party.stage).toBe('handed')
    expect(body.totals).toEqual({ count: 1, packed_count: 1, handed_count: 1 })
    expect(body.plan.find((e) => e.target_key === `loc${fx.D.id}`).handed_count).toBe(1)

    // ⚠ the CANCELLED sub-order was never stamped and must never have blocked this.
    expect(party.guest_orders.length).toBe(2)
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
