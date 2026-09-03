import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/orders/cycle/:cycleId/friend/:friendId/pickup — the admin's correction
// of a party's pickup point (PO decision, 2026-09-02; widened to "za každých
// okolností" on 2026-09-03, which is what keyed it on (cycle, friend) instead of an
// order id).
//
// The original request: "niekedy si priatelia vyberu zly [pickup point], alebo sa
// potom zmeni a chcem mat moznost to upravit na finalny, aby sa mi lahsie
// pripravovalo balenie." Before it, `orders.pickup_location_id` / `_note` were
// WRITE-ONCE — set by the friend at submit time, with no route that could change them.
//
// The follow-up, from a screenshot: "ak priateľ neobjedná kávu a iba jeho
// neregistrovaný kolega si objedná, nie je v sumáre objednávok zobrazenie pick up
// pointu." That host has NO `orders` row, so the order-id route could not address them
// at all — yet they are the party who collects the bags.
//
// What this file pins, in order of how badly each one bites:
//
//  1. ⚠ THE TWO STORES ARE ONE DECISION. A party's pickup lives on their `orders` row
//     when one exists (ANY status) and on `guest_order_links` otherwise, and
//     `helpers/pickup.js` is the only thing that chooses. The trap this closes: the
//     orders tab lists a party with an order OR guest bags, while the Distribution
//     sheet builds its no-own-order rows from `status = 'submitted'` — so a host on a
//     DRAFT is "has an own order" to one screen and not to the other. A per-surface
//     choice of store would have written one and read back the other. There is a test
//     that reads BOTH payloads for exactly that party and demands the same answer.
//  2. ⚠ NO `transactions` ROW, EVER, and no `total`/`status`/`paid`/`packed` write —
//     the route is offered on a LOCKED, part-PAID cycle, which is the only reason that
//     matters (the GSO-T6 lesson: a stray row corrupts a real friend's balance).
//  3. ⚠ THE ONE MONEY COLUMN IT MAY MOVE is `delivery_fee`, and only when switching a
//     PACKETA order to personal pickup. That is ledger-neutral — verified here, not
//     assumed: `PATCH /orders/:id/paid` posts `roundMoney(order.total)` and
//     `helpers/packing.js` charges `-roundMoney(order.total)`, so the fee has never
//     entered `transactions`. The test switches a PAID parcel order and asserts the
//     ledger is untouched while the fee and address are gone.
//  4. ⚠ NO CYCLE-OPEN GATE, deliberately — the correction is needed exactly when the
//     cycle is locked, because that is when the admin packs. Asserted, so nobody
//     "fixes" it into a 409 later.
//  5. ⚠ EXPLICIT INTENT: exactly one of `pickup_location_id` / `pickup_location_note`.
//     `{}`, both, or neither is a 400 that writes NOTHING — a route that read "no
//     field" as "clear the column" would wipe a real pickup on a malformed body and
//     answer 200. Every refusal test reads the row back, because a status assertion
//     alone cannot see a write that happened anyway.
//  6. The unbindable-shape class (FUP-T13): `{}` / `true` / `[id]` in the id field
//     must be a 400, never a 500 with a stack in the log. The ONE-ELEMENT ARRAY is
//     the trap — `[3]` spreads to exactly one bind slot, so it is the shape that gets
//     silently ACCEPTED when the guard is missing.
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

const admin = () => ({ 'X-Admin-Token': adminToken })

async function adminReq(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: admin(),
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

/**
 * A friend with real credentials and a Bearer session — needed to submit an order and
 * to create a share link, which is what writes the two stores this route corrects.
 */
let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pick_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `Pickup ${label} ${uniq}`
  const created = await adminReq('/api/friends', { method: 'post', data: { name } })
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
  return { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, over = {}) {
  const res = await adminReq('/api/cycles', {
    method: 'post',
    data: { name: `E2E PICKUP ${label} ${uniq}`, type: 'coffee', status: 'open', ...over },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}

async function addProduct(cycleId, name) {
  const res = await adminReq('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `${name} ${uniq}`, purpose: 'Espresso', price_250g: 9.5 },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let locationSeq = 0
async function makeLocation(label, over = {}) {
  const res = await adminReq('/api/pickup-locations', {
    method: 'post',
    data: { name: `Miesto ${label} ${uniq}${++locationSeq}`, address: 'Testovacia 1', ...over },
  })
  expect(res.status(), 'pickup location create').toBe(201)
  return res.json()
}

/** A friend's own cart, saved but NOT submitted — i.e. a `draft` orders row. */
async function draftOrder(friend, cycleId, product) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth,
    data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const order = (await put.json()).order
  expect(order.status, 'fixture is honest: this really is a draft').toBe('draft')
  return order
}

/** A submitted order, with whatever pickup the friend chose. */
async function submittedOrder(friend, cycleId, product, submitBody = {}) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth,
    data: { items: [{ product_id: product.id, variant: '250g', quantity: 2 }] },
    timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth,
    data: submitBody,
    timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

/** The host's share link (`guest_order_links`) — the second pickup store. */
async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth, timeout: TIMEOUT })
  expect([200, 201], 'share link create').toContain(res.status())
  return (await res.json()).link
}

/** A colleague's sub-order through that link — no account, the token is the credential. */
async function submitGuest(linkToken, product, guestName = 'Martina Tomasova') {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: guestName,
      guest_phone: '0917 976 440',
      items: [{ product_id: product.id, variant: '250g', quantity: 3 }],
    },
    timeout: TIMEOUT,
  })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

/** The STORED row, read back through the admin listing both views actually use. */
async function listedParty(cycleId, friendId) {
  const res = await adminReq(`/api/orders/cycle/${cycleId}`)
  expect(res.status(), 'admin orders listing').toBe(200)
  const row = (await res.json()).find((o) => o.friend_id === friendId)
  expect(row, `friend ${friendId} is in the cycle listing`).toBeTruthy()
  return row
}

/** The same party as the Distribution picking sheet sees them. */
async function distributionParty(cycleId, friendId) {
  const res = await adminReq(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return (await res.json()).distribution.find((p) => p.id === friendId)
}

async function setPickup(cycleId, friendId, data) {
  return adminReq(`/api/orders/cycle/${cycleId}/friend/${friendId}/pickup`, { method: 'patch', data })
}

async function lockCycle(cycleId) {
  const res = await adminReq(`/api/cycles/${cycleId}`, { method: 'patch', data: { status: 'locked' } })
  expect(res.status(), 'lock cycle').toBe(200)
}

/** The friend's own ledger — the surface a stray `transactions` row would show up on. */
async function ledgerCount(friend) {
  const res = await ctx.get(`/api/transactions/friend/${friend.id}`, { headers: friend.auth, timeout: TIMEOUT })
  expect(res.status(), 'ledger').toBe(200)
  const body = await res.json()
  return (Array.isArray(body) ? body : body.transactions || []).length
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
// (A) what the route is FOR — a submitted order

test.describe('correcting the pickup point of a submitted order', () => {
  test('a friend who picked the wrong place is moved to the right one, note cleared', async () => {
    const friend = await makeFriend('Alica')
    const cycle = await makeCycle('A1')
    const product = await addProduct(cycle.id, 'Colombia')
    const wrong = await makeLocation('Neskolka')
    const right = await makeLocation('AdamFilo')

    await submittedOrder(friend, cycle.id, product, { pickup_location_id: wrong.id })
    expect((await listedParty(cycle.id, friend.id)).pickup_location_name).toBe(wrong.name)

    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: right.id })
    expect(res.status(), 'the correction is accepted').toBe(200)
    const body = await res.json()
    // The uniform payload both views patch their row from, plus which store took it.
    expect(body.stored_on, 'an own order exists, so that is the store').toBe('order')
    expect(body.pickup_location_id).toBe(right.id)
    expect(body.pickup_location_name, 'the joined name rides the response').toBe(right.name)
    expect(body.cleared_parcel, 'nothing to do with parcels here').toBe(false)

    const stored = await listedParty(cycle.id, friend.id)
    expect(stored.pickup_location_id).toBe(right.id)
    expect(stored.pickup_location_name).toBe(right.name)
    expect(stored.pickup_location_note, 'the old note/id cannot survive alongside').toBeFalsy()
  })

  test('a friend\'s free-text "Iné" answer is replaced by a real location', async () => {
    const friend = await makeFriend('Peta')
    const cycle = await makeCycle('A2')
    const product = await addProduct(cycle.id, 'Brazil')
    const place = await makeLocation('LegoDoma')

    // The shape the PO's screenshot is full of: a grey badge holding a sentence.
    await submittedOrder(friend, cycle.id, product, {
      pickup_location_note: 'Peta :) potvrdim este do spravy, vdaka',
    })
    expect((await listedParty(cycle.id, friend.id)).pickup_location_note).toContain('potvrdim')

    expect((await setPickup(cycle.id, friend.id, { pickup_location_id: place.id })).status()).toBe(200)

    const stored = await listedParty(cycle.id, friend.id)
    expect(stored.pickup_location_name).toBe(place.name)
    expect(stored.pickup_location_note, 'the note is cleared, not left behind the badge').toBeFalsy()
  })

  test('and the other way: a location can be replaced by a note', async () => {
    const friend = await makeFriend('Janci')
    const cycle = await makeCycle('A3')
    const product = await addProduct(cycle.id, 'Kenya')
    const place = await makeLocation('LukyHlasny')

    await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })

    const res = await setPickup(cycle.id, friend.id, { pickup_location_note: '  V domcheku alebo v petrzalke  ' })
    expect(res.status()).toBe(200)

    const stored = await listedParty(cycle.id, friend.id)
    expect(stored.pickup_location_note, 'trimmed').toBe('V domcheku alebo v petrzalke')
    expect(stored.pickup_location_id).toBeFalsy()
    expect(stored.pickup_location_name).toBeFalsy()
  })

  test('⚠ WORKS ON A LOCKED CYCLE — there is deliberately no cycle-open gate', async () => {
    const friend = await makeFriend('Eva')
    const cycle = await makeCycle('A4')
    const product = await addProduct(cycle.id, 'Peru')
    const place = await makeLocation('PoZamknuti')

    await submittedOrder(friend, cycle.id, product, { pickup_location_note: 'este nevie' })
    await lockCycle(cycle.id)

    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: place.id })
    expect(res.status(), 'packing happens AFTER the lock — this is the whole point').toBe(200)
    expect((await listedParty(cycle.id, friend.id)).pickup_location_name).toBe(place.name)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (B) ⚠ THE CASES THE FIRST VERSION REFUSED — "za každých okolností"

test.describe('⚠ every party is addressable', () => {
  test('⚠ THE REPORTED BUG: a host with NO own order, only a colleague\'s bags', async () => {
    const host = await makeFriend('Brano')
    const cycle = await makeCycle('B1')
    const product = await addProduct(cycle.id, 'HostBezObjednavky')
    const place = await makeLocation('BranoNeskolka')

    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, product)

    // The state from the screenshot: listed, "Neobjednane", guest bags underneath,
    // and — before this row — no pickup point anywhere on the screen.
    const before = await listedParty(cycle.id, host.id)
    expect(before.status, 'fixture is honest: they ordered nothing themselves').toBe('none')
    expect(before.id, 'and there is genuinely no orders row').toBeNull()
    expect(before.guest_orders.length, 'but a colleague did order through them').toBe(1)
    expect(before.pickup_location_name, 'which is exactly what was missing').toBeNull()

    const res = await setPickup(cycle.id, host.id, { pickup_location_id: place.id })
    expect(res.status(), 'the party who collects the bags must be addressable').toBe(200)
    const body = await res.json()
    expect(body.stored_on, 'no orders row ⇒ the share link is the store').toBe('guest_link')
    expect(body.pickup_location_name).toBe(place.name)

    const after = await listedParty(cycle.id, host.id)
    expect(after.pickup_location_id, 'and the listing publishes it in the same field').toBe(place.id)
    expect(after.pickup_location_name).toBe(place.name)
    expect(after.status, 'without inventing an order for them').toBe('none')
    expect(after.id).toBeNull()

    // …and the picking sheet, which is where it actually gets used.
    const party = await distributionParty(cycle.id, host.id)
    expect(party, 'they are still the pickup party').toBeTruthy()
    expect(party.has_own_order, 'still no own order').toBe(false)
    expect(party.pickup_location_name, 'the sheet now says where the bags go').toBe(place.name)
  })

  test('a DRAFT own order is editable (the old submitted-only gate is gone)', async () => {
    const friend = await makeFriend('Draft')
    const cycle = await makeCycle('B2')
    const product = await addProduct(cycle.id, 'Rozpracovana')
    const place = await makeLocation('DraftMiesto')

    const draft = await draftOrder(friend, cycle.id, product)

    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: place.id })
    expect(res.status()).toBe(200)
    expect((await res.json()).stored_on, 'a draft IS an orders row').toBe('order')

    const stored = await listedParty(cycle.id, friend.id)
    expect(stored.id, 'the same row, not a new one').toBe(draft.id)
    expect(stored.status, 'and it is still a draft — nothing was submitted for them').toBe('draft')
    expect(stored.pickup_location_name).toBe(place.name)
  })

  test('⚠ THE TWO-SURFACE TRAP: a host on a DRAFT who also has guest bags reads the SAME on both payloads', async () => {
    // This is the case that forced one shared resolver. The orders tab sees an
    // `orders` row (draft ⇒ listed), while `/distribution` starts
    // `FROM orders … WHERE status = 'submitted'` and therefore synthesises this party
    // in its no-own-order branch. Two different notions of "has an own order" — so a
    // per-surface choice of store would write to `orders` and read back the link.
    const host = await makeFriend('DraftHost')
    const cycle = await makeCycle('B3')
    const product = await addProduct(cycle.id, 'DvePlochy')
    const place = await makeLocation('JednaOdpoved')

    await draftOrder(host, cycle.id, product)
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, product)

    const res = await setPickup(cycle.id, host.id, { pickup_location_id: place.id })
    expect(res.status()).toBe(200)
    expect((await res.json()).stored_on, 'the orders row wins whenever one exists').toBe('order')

    const listed = await listedParty(cycle.id, host.id)
    const party = await distributionParty(cycle.id, host.id)
    expect(party, 'the guest bags make them a pickup party').toBeTruthy()
    expect(party.has_own_order, 'a draft is not part of the distribution').toBe(false)
    expect(listed.pickup_location_name, 'orders tab').toBe(place.name)
    expect(
      party.pickup_location_name,
      'the picking sheet must NOT read the link while the write went to the orders row'
    ).toBe(place.name)
  })

  test('404 when there is nothing to attach a pickup to (no order, no link)', async () => {
    const stranger = await makeFriend('Stranger')
    const cycle = await makeCycle('B4')

    const res = await setPickup(cycle.id, stranger.id, { pickup_location_note: 'kdekolvek' })
    expect(res.status(), 'honest, rather than a silent no-op').toBe(404)
  })

  test('404 for an unknown cycle', async () => {
    const friend = await makeFriend('NoCycle')
    const res = await setPickup(999999, friend.id, { pickup_location_note: 'kdekolvek' })
    expect(res.status()).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (C) ⚠ THE MONEY GUARANTEE

test.describe('⚠ the money guarantee', () => {
  test('total, delivery_fee, paid and status are unmoved, and NO transactions row appears', async () => {
    const friend = await makeFriend('Baska')
    const cycle = await makeCycle('C1')
    const product = await addProduct(cycle.id, 'Ethiopia')
    const first = await makeLocation('PredZmenou')
    const second = await makeLocation('PoZmene')

    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: first.id })

    // Marked paid FIRST, so the state under test is the dangerous one: real money
    // recorded against this order, on a locked cycle.
    expect((await adminReq(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    await lockCycle(cycle.id)

    const before = await listedParty(cycle.id, friend.id)
    const ledgerBefore = await ledgerCount(friend)
    expect(before.paid, 'fixture is honest: the order really is paid').toBeTruthy()
    expect(ledgerBefore, 'marking paid wrote a ledger row').toBeGreaterThan(0)

    expect((await setPickup(cycle.id, friend.id, { pickup_location_id: second.id })).status()).toBe(200)

    const after = await listedParty(cycle.id, friend.id)
    expect(after.pickup_location_name, 'the pickup really did move').toBe(second.name)
    expect(after.total, 'total').toBe(before.total)
    expect(after.delivery_fee || 0, 'delivery_fee').toBe(before.delivery_fee || 0)
    expect(after.paid, 'paid').toBe(before.paid)
    expect(after.status, 'status').toBe(before.status)
    expect(after.packeta_address || null, 'packeta_address').toBe(before.packeta_address || null)
    expect(after.packed || 0, 'packed').toBe(before.packed || 0)

    expect(
      await ledgerCount(friend),
      'a pickup correction is not a financial event — a stray transactions row would move a real balance'
    ).toBe(ledgerBefore)
  })

  test('⚠ A PAID PACKETA ORDER switches to personal pickup: fee and address gone, LEDGER UNTOUCHED', async () => {
    const friend = await makeFriend('Viktor')
    const cycle = await makeCycle('C2')
    // Parcel delivery is PATCH-only on `/api/cycles/:id` — POST ignores both fields.
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.5 } })).status()).toBe(200)
    const product = await addProduct(cycle.id, 'Guatemala')
    const place = await makeLocation('ZPacketyNaOdber')

    const order = await submittedOrder(friend, cycle.id, product, {
      use_parcel_delivery: true,
      packeta_address: 'Z-Box Petržalka, Bratislava',
    })
    expect((await adminReq(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)

    const before = await listedParty(cycle.id, friend.id)
    const ledgerBefore = await ledgerCount(friend)
    expect(before.delivery_fee, 'fixture is honest: a real parcel fee is on the order').toBe(3.5)
    expect(before.packeta_address).toBeTruthy()

    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: place.id })
    expect(res.status(), 'the PO asked for this to be possible under all circumstances').toBe(200)
    const body = await res.json()
    // Reported back, so the UI can mirror it instead of leaving the row claiming a
    // parcel it no longer has.
    expect(body.cleared_parcel).toBe(true)
    expect(body.parcel_fee_removed).toBe(3.5)

    const after = await listedParty(cycle.id, friend.id)
    expect(after.pickup_location_name).toBe(place.name)
    expect(after.packeta_address, 'a pickup and a parcel address are mutually exclusive').toBeFalsy()
    expect(after.delivery_fee || 0, 'a delivery charge for a delivery nobody makes').toBe(0)
    expect(after.total, 'the goods themselves are untouched').toBe(before.total)
    expect(after.paid, 'and it is still marked paid').toBeTruthy()

    // ⚠ THE CLAIM THAT MAKES THIS SAFE, asserted rather than assumed: neither ledger
    // leg has ever used `delivery_fee` (`paid` posts `roundMoney(order.total)`,
    // `packOrder` charges the negation), so zeroing it moves no balance.
    expect(await ledgerCount(friend), 'zeroing the fee is ledger-neutral').toBe(ledgerBefore)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (D) refusals — each one reads the row back

test.describe('refusals write nothing', () => {
  let friend
  let cycle
  let product
  let place

  test.beforeAll(async () => {
    friend = await makeFriend('Refuse')
    cycle = await makeCycle('D1')
    product = await addProduct(cycle.id, 'Rwanda')
    place = await makeLocation('Puvodne')
    await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })
  })

  test.describe('explicit intent — exactly one of the two fields', () => {
    for (const [label, data] of [
      ['an empty body', {}],
      ['both fields at once', { pickup_location_id: 1, pickup_location_note: 'aj aj' }],
      ['both explicitly null', { pickup_location_id: null, pickup_location_note: null }],
      ['an unrelated field only', { pickup_location: 5 }],
    ]) {
      test(`400 for ${label}, and the stored pickup survives`, async () => {
        const res = await setPickup(cycle.id, friend.id, data)
        expect(res.status(), `${label} must not be a write`).toBe(400)
        const stored = await listedParty(cycle.id, friend.id)
        expect(stored.pickup_location_id, 'nothing was cleared').toBe(place.id)
        expect(stored.pickup_location_name).toBe(place.name)
      })
    }
  })

  test('400 for a location id that does not exist', async () => {
    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: 999999 })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/neexistuje alebo nie je aktívne/)
    expect((await listedParty(cycle.id, friend.id)).pickup_location_id).toBe(place.id)
  })

  test('400 for a DEACTIVATED location — the dropdown never offers one, the route refuses it', async () => {
    const retired = await makeLocation('Zrusene')
    expect((await adminReq(`/api/pickup-locations/${retired.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const res = await setPickup(cycle.id, friend.id, { pickup_location_id: retired.id })
    expect(res.status()).toBe(400)
    expect((await listedParty(cycle.id, friend.id)).pickup_location_id).toBe(place.id)
  })

  // ⚠ FUP-T13 class: an unbindable body field must be a 400, never a 500 with a stack
  // in the log. `[id]` is the trap — a one-element array SPREADS to exactly the single
  // bind slot the statement wants, so it is the shape that gets silently accepted
  // when the guard is missing.
  test.describe('unbindable id shapes are 400, never 500', () => {
    for (const label of ['an object', 'a boolean', 'an array', 'a ONE-ELEMENT array', 'a NaN-ish string']) {
      test(`400 for ${label}`, async () => {
        const value = {
          'an object': {},
          'a boolean': true,
          'an array': [1, 2],
          'a ONE-ELEMENT array': [place.id],
          'a NaN-ish string': 'abc',
        }[label]
        const res = await setPickup(cycle.id, friend.id, { pickup_location_id: value })
        expect(res.status(), `${label} must not reach the binder`).toBe(400)
        const stored = await listedParty(cycle.id, friend.id)
        expect(stored.pickup_location_id, 'and it certainly must not be stored').toBe(place.id)
      })
    }
  })

  test.describe('the note field', () => {
    for (const [label, note] of [
      ['a number', 123],
      ['an object', {}],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ]) {
      test(`400 for ${label}`, async () => {
        const res = await setPickup(cycle.id, friend.id, { pickup_location_note: note })
        expect(res.status()).toBe(400)
        expect((await listedParty(cycle.id, friend.id)).pickup_location_id).toBe(place.id)
      })
    }

    test('200 at the 200-character bound, 400 one over it', async () => {
      const ok = await setPickup(cycle.id, friend.id, { pickup_location_note: 'x'.repeat(200) })
      expect(ok.status(), 'exactly at the bound').toBe(200)
      expect((await listedParty(cycle.id, friend.id)).pickup_location_note.length).toBe(200)

      const over = await setPickup(cycle.id, friend.id, { pickup_location_note: 'y'.repeat(201) })
      expect(over.status(), 'one over').toBe(400)
      expect((await over.json()).error).toMatch(/dlhá/)
      // The 200-char note from the previous step is still there — the refusal wrote
      // nothing, including nothing truncated.
      expect((await listedParty(cycle.id, friend.id)).pickup_location_note).toBe('x'.repeat(200))

      // Put the fixture back for any test that runs after this one.
      expect((await setPickup(cycle.id, friend.id, { pickup_location_id: place.id })).status()).toBe(200)
    })
  })

  test('the SAME bounds apply on the link store, not just on orders', async () => {
    // The guest_link branch is a separate UPDATE; the guards are shared, and this is
    // what proves they are not order-only.
    const host = await makeFriend('LinkBounds')
    const linkCycle = await makeCycle('D2')
    const linkProduct = await addProduct(linkCycle.id, 'LinkOvereni')
    const link = await shareLink(host, linkCycle.id)
    await submitGuest(link.token, linkProduct)

    expect((await setPickup(linkCycle.id, host.id, {})).status(), 'empty body').toBe(400)
    expect((await setPickup(linkCycle.id, host.id, { pickup_location_id: 999999 })).status(), 'unknown location').toBe(400)
    expect((await setPickup(linkCycle.id, host.id, { pickup_location_note: 'z'.repeat(201) })).status(), 'over the bound').toBe(400)
    expect((await listedParty(linkCycle.id, host.id)).pickup_location_note, 'nothing was written').toBeFalsy()

    const okRes = await setPickup(linkCycle.id, host.id, { pickup_location_note: '  Pri vrátnici  ' })
    expect(okRes.status()).toBe(200)
    expect((await okRes.json()).stored_on).toBe('guest_link')
    expect((await listedParty(linkCycle.id, host.id)).pickup_location_note, 'trimmed, on the link too').toBe('Pri vrátnici')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (E) UI — the pill IS the select, on both surfaces
//
// ⚠ Every test here logs in through the UI FIRST and adopts the browser's token for
// its fixture calls: there is ONE admin token app-wide (`INSERT OR REPLACE`), so a UI
// login invalidates a token minted earlier by `beforeAll` (the documented trap).

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  adminToken = token
  return token
}

async function openOrdersTab(page, cycleId) {
  await page.goto(`/admin/cycle/${cycleId}`)
  await page.getByRole('tab', { name: 'Objednávky' }).click()
}

test.describe('UI — the orders tab', () => {
  test('picking a place from the pill saves immediately and survives a reload', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiPick')
    const cycle = await makeCycle('E1')
    const product = await addProduct(cycle.id, 'UiKava')
    const wrong = await makeLocation('UiNeskolka')
    const right = await makeLocation('UiAdamFilo')
    await submittedOrder(friend, cycle.id, product, { pickup_location_id: wrong.id })

    await openOrdersTab(page, cycle.id)
    const pill = page.getByTestId(`pickup-select-${friend.id}`)
    await expect(pill).toBeVisible()
    // ⚠ The pill IS a `<select>` — that is the row's whole interaction budget (open,
    // pick). A badge-then-reveal build would be three interactions and hide the
    // control behind a state the admin has to discover first.
    await expect(pill).toHaveJSProperty('tagName', 'SELECT')
    await expect(pill, 'blue = a configured location, exactly as the old badge').toHaveClass(/bg-blue-50/)

    await pill.selectOption(String(right.id))
    // No Uložiť: the save is the pick. The server is the proof.
    await expect.poll(
      async () => (await listedParty(cycle.id, friend.id)).pickup_location_id,
      { message: 'the pick was persisted with no further click' }
    ).toBe(right.id)

    await page.reload()
    await page.getByRole('tab', { name: 'Objednávky' }).click()
    await expect(page.getByTestId(`pickup-select-${friend.id}`)).toHaveValue(String(right.id))
  })

  test('"Iné (poznámka)" reveals an input; saving it turns the pill grey', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiNote')
    const cycle = await makeCycle('E2')
    const product = await addProduct(cycle.id, 'UiKava2')
    const place = await makeLocation('UiLegoDoma')
    await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })

    await openOrdersTab(page, cycle.id)
    await page.getByTestId(`pickup-select-${friend.id}`).selectOption('__note_new__')

    const input = page.getByTestId(`pickup-note-input-${friend.id}`)
    await expect(input, 'and it is focused, so the admin can just type').toBeFocused()
    // Mirrors the server bound, so the field cannot compose a request the route refuses.
    await expect(input).toHaveAttribute('maxlength', '200')
    await input.fill('U mna v aute pred skolkou')
    await page.getByTestId(`pickup-note-save-${friend.id}`).click()

    const pill = page.getByTestId(`pickup-select-${friend.id}`)
    await expect(pill, 'grey = the free-text answer, same as the old badge').toHaveClass(/bg-gray-50/)
    await expect(pill).toHaveValue('__note_current__')
    await expect(pill.locator('option', { hasText: 'U mna v aute pred skolkou' })).toHaveCount(1)

    const stored = await listedParty(cycle.id, friend.id)
    expect(stored.pickup_location_note).toBe('U mna v aute pred skolkou')
    expect(stored.pickup_location_id).toBeFalsy()
  })

  test('⚠ the REPORTED row: a host with no own order gets a working picker', async ({ page }) => {
    await loginAsAdminUI(page)
    const host = await makeFriend('UiHostOnly')
    const cycle = await makeCycle('E3')
    const product = await addProduct(cycle.id, 'UiHostKava')
    const place = await makeLocation('UiHostMiesto')
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, product)

    await openOrdersTab(page, cycle.id)
    const row = page.getByRole('row').filter({ hasText: host.name })
    await expect(row.first().getByText('Neobjednane'), 'fixture is honest on screen too').toBeVisible()

    const pill = page.getByTestId(`pickup-select-${host.id}`)
    await expect(pill, 'the party who collects the bags is addressable now').toBeVisible()
    await expect(pill, 'and it starts empty — nobody has said where yet').toHaveValue('')
    await expect(pill).toHaveClass(/border-dashed/)

    await pill.selectOption(String(place.id))
    await expect.poll(async () => (await listedParty(cycle.id, host.id)).pickup_location_name).toBe(place.name)
    await expect(pill).toHaveClass(/bg-blue-50/)
  })

  test('⚠ a PACKETA row asks before switching, names the fee, and "Nie" changes nothing', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiParcel')
    const cycle = await makeCycle('E4')
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.5 } })).status()).toBe(200)
    const product = await addProduct(cycle.id, 'UiKava4')
    const place = await makeLocation('UiZPackety')
    await submittedOrder(friend, cycle.id, product, {
      use_parcel_delivery: true,
      packeta_address: 'Z-Box Ruzinov',
    })

    await openOrdersTab(page, cycle.id)
    const pill = page.getByTestId(`pickup-select-${friend.id}`)
    await expect(pill, 'red = still going out by Packeta').toHaveClass(/bg-red-50/)

    // ⚠ The ONE case that may not be silent: it clears a fee the friend may already
    // have transferred. Everything else on this control saves on the pick.
    await pill.selectOption(String(place.id))
    const confirm = page.getByTestId(`pickup-parcel-confirm-${friend.id}`)
    await expect(confirm).toBeVisible()
    await expect(confirm, 'the amount is named, not just "are you sure"').toContainText('3.50 EUR')

    await confirm.getByTestId(`pickup-parcel-no-${friend.id}`).click()
    await expect(confirm).toBeHidden()
    let stored = await listedParty(cycle.id, friend.id)
    expect(stored.delivery_fee, '"Nie" really means nothing happened').toBe(3.5)
    expect(stored.packeta_address).toBeTruthy()

    await pill.selectOption(String(place.id))
    await page.getByTestId(`pickup-parcel-yes-${friend.id}`).click()

    await expect.poll(async () => (await listedParty(cycle.id, friend.id)).pickup_location_name).toBe(place.name)
    stored = await listedParty(cycle.id, friend.id)
    expect(stored.delivery_fee || 0).toBe(0)
    expect(stored.packeta_address).toBeFalsy()
    // The row must stop rendering the parcel it no longer has.
    await expect(pill).toHaveClass(/bg-blue-50/)
  })

  test('a refused change snaps the pill back — it never claims a place that was not saved', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiFail')
    const cycle = await makeCycle('E5')
    const product = await addProduct(cycle.id, 'UiKava3')
    const from = await makeLocation('UiOdkial')
    const to = await makeLocation('UiKam')
    await submittedOrder(friend, cycle.id, product, { pickup_location_id: from.id })

    await openOrdersTab(page, cycle.id)
    // The packing sheet is read as fact; "it looked like it saved" is how a bag goes
    // to the wrong address.
    await page.route(`**/api/orders/cycle/${cycle.id}/friend/${friend.id}/pickup`, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Nepodarilo sa' }) })
    )
    await page.getByTestId(`pickup-select-${friend.id}`).selectOption(String(to.id))

    await expect(page.getByTestId(`pickup-error-${friend.id}`)).toHaveText('Nepodarilo sa')
    await expect(page.getByTestId(`pickup-select-${friend.id}`)).toHaveValue(String(from.id))
    expect((await listedParty(cycle.id, friend.id)).pickup_location_id, 'and nothing moved').toBe(from.id)
  })
})

test.describe('UI — the Distribution picking sheet', () => {
  test('the same picker works here, and PRINT falls back to the place as TEXT', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiDist')
    const cycle = await makeCycle('E6')
    const product = await addProduct(cycle.id, 'UiKava5')
    const from = await makeLocation('UiDistOd')
    const to = await makeLocation('UiDistKam')
    await submittedOrder(friend, cycle.id, product, { pickup_location_id: from.id })

    await page.goto(`/admin/cycle/${cycle.id}/distribution`)
    const pill = page.getByTestId(`dist-pickup-select-${friend.id}`)
    await expect(pill, 'this is the screen the bags are packed from').toBeVisible()

    await pill.selectOption(String(to.id))
    await expect.poll(async () => (await listedParty(cycle.id, friend.id)).pickup_location_id).toBe(to.id)

    // ⚠ A printed picking sheet must state the place as text, not render a dropdown
    // box (the same rule as the guest folds' `hidden print:flex`).
    // ⚠ The badge is located by TESTID, not by its text: the select's own hidden
    // `<option>` carries the same string, so a `getByText` here resolves to the
    // control it is supposed to prove is gone.
    const printBadge = page.getByTestId(`dist-pickup-badge-${friend.id}`)
    await expect(printBadge, 'on screen the badge yields to the control').toBeHidden()

    await page.emulateMedia({ media: 'print' })
    await expect(pill, 'the control has no business on paper').toBeHidden()
    await expect(printBadge, 'but the place is still printed, as text').toBeVisible()
    await expect(printBadge).toHaveText(to.name)
    await page.emulateMedia({ media: 'screen' })
  })

  test('⚠ a host with no own order can be given a place ON THE PICKING SHEET', async ({ page }) => {
    await loginAsAdminUI(page)
    const host = await makeFriend('UiDistHost')
    const cycle = await makeCycle('E7')
    const product = await addProduct(cycle.id, 'UiDistHostKava')
    const place = await makeLocation('UiDistHostMiesto')
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, product)

    await page.goto(`/admin/cycle/${cycle.id}/distribution`)
    const card = page.locator('.rounded-lg', { hasText: host.name }).first()
    await expect(card.getByText('Bez vlastnej objednávky'), 'the synthetic pickup party').toBeVisible()

    const pill = page.getByTestId(`dist-pickup-select-${host.id}`)
    await expect(pill, 'no own order is no longer a reason to have no control').toBeVisible()
    await pill.selectOption(String(place.id))

    await expect.poll(async () => (await distributionParty(cycle.id, host.id)).pickup_location_name).toBe(place.name)

    // And it prints, which is the point of writing it here at all.
    await page.emulateMedia({ media: 'print' })
    await expect(page.getByTestId(`dist-pickup-badge-${host.id}`)).toHaveText(place.name)
    await page.emulateMedia({ media: 'screen' })
  })
})
