import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// FUP-T23 — `DELETE /api/pickup-locations/:id` and the TWO-STORE rule.
//
// The bug, reached through the public API alone (found by DP-T2, so it was
// reachable in production): the delete guarded itself with
// `SELECT COUNT(*) FROM orders WHERE pickup_location_id = ?` — `orders` ONLY. But
// `helpers/pickup.js` is the one home for WHICH ROW STORES A PARTY'S PICKUP, and
// that rule is: the `orders` row if one exists (ANY status), else the party's
// `guest_order_links` row. A host with no own order therefore kept their pickup on
// the link table, was invisible to that count, and had their pickup point DELETED
// out from under them — `loc<id>` with no row behind it, a silently dangling id.
//
// Severity is DATA LOSS, not a security hole: the route is `requireAdmin`.
//
// ⚠ WHAT MAKES THIS FILE EVIDENCE AND NOT DECORATION. The old code already passes
// the `orders` case, so a test that covers only that case proves nothing. The file
// is built as a MATCHED PAIR — the same party shape, the same assertions, differing
// ONLY in which store holds the pickup — and the link-stored half is mutation-proved
// against the shipped check (revert `pickupLocationInUse()` to the `orders`-only
// COUNT and exactly the link-stored tests redden, while the `orders` ones stay
// green). Every refusal assertion READS THE ROW BACK through
// `GET /api/pickup-locations/all`, which is the only place a soft delete and a hard
// delete can be told apart without the database file:
//
//   • hard delete → the row is GONE from `/all`
//   • soft delete → the row is in `/all` with `active: 0`, and out of the public
//     `GET /api/pickup-locations` picker list
//
// ⚠ ~~There is deliberately NO 401/403 test here: the route is already in
// `ADMIN_ENDPOINTS`.~~ **THAT CLAIM WAS FALSE** (caught in review). `/api/…
// pickup-locations` is a MIXED mount with no `requireAdmin` on the mount itself, and
// NONE of its four admin routes — the delete, the create, the update, the list-all —
// was in that sweep; the only entry for the path was the PUBLIC GET, in
// `PUBLIC_ENDPOINTS`. No live exposure (every handler carries its own guard), but an
// edit dropping one would have shipped green, and the comment advertised a net that
// did not exist. **All four are now in `ADMIN_ENDPOINTS`**, which is where the next
// person looks — so this file still writes no auth test, and now that is true.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
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

let locationSeq = 0
async function makeLocation(label) {
  const res = await admin('/api/pickup-locations', {
    method: 'post',
    data: {
      name: `FUP23 ${label} ${uniq}${++locationSeq}`, address: `Testovacia ${locationSeq}`,
      for_coffee: true, for_bakery: true,
    },
  })
  expect(res.status(), 'pickup location create').toBe(201)
  return res.json()
}

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `f23_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `FUP23 ${label} ${uniq}`
  const phone = `09${String(10 + friendSeq).slice(0, 2)} ${String(100000 + friendSeq).slice(0, 3)} ${String(100000 + friendSeq).slice(3)}`
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
  return { id: row.id, name, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E FUP23 ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}

async function addProduct(cycleId) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId, name: `FUP23 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

const line = (productId) => [{ product_id: productId, variant: '250g', quantity: 1 }]

/** A DRAFT own order — an `orders` row with `status = 'draft'`. */
async function draftOrder(friend, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  return (await put.json()).order || null
}

async function submittedOrder(friend, cycleId, items, submitBody) {
  await draftOrder(friend, cycleId, items)
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

/** The admin's „set this party's pickup point" route — keyed on (cycle, friend). */
async function setPickup(cycleId, friendId, locationId) {
  const res = await admin(`/api/orders/cycle/${cycleId}/friend/${friendId}/pickup`, {
    method: 'patch', data: { pickup_location_id: locationId },
  })
  expect(res.status(), 'pickup set').toBe(200)
  return res.json()
}

/** The admin list, which is the only one that can see an inactive row. */
async function allLocations() {
  const res = await admin('/api/pickup-locations/all')
  expect(res.status(), 'all locations').toBe(200)
  return res.json()
}

async function publicLocations() {
  const res = await ctx.get('/api/pickup-locations?type=coffee', { timeout: TIMEOUT })
  expect(res.status(), 'public locations').toBe(200)
  return res.json()
}

/**
 * The delete, plus the read-back that says WHICH of the two things happened. Both
 * outcomes answer 204, so the status alone is not evidence of either.
 */
async function deleteAndReadBack(locationId) {
  const res = await admin(`/api/pickup-locations/${locationId}`, { method: 'delete' })
  expect(res.status(), 'delete answers 204 either way').toBe(204)
  const rows = await allLocations()
  // NON-VACUITY: `/all` is not empty, so "not in this list" is a real absence and
  // not a list that failed to load.
  expect(rows.length, 'non-vacuity: /all returned rows').toBeGreaterThan(0)
  return rows.find((row) => row.id === locationId) || null
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
// 1. The baseline nobody disputed: a point nobody chose is really deleted.
//    Without this, "soft delete" below would be indistinguishable from "the route
//    never deletes anything".
// ─────────────────────────────────────────────────────────────────────────────
test.describe('FUP-T23 · an UNREFERENCED point is hard-deleted', () => {
  test('nobody points at it, so the row is gone', async () => {
    const loc = await makeLocation('Nikoho')
    expect((await allLocations()).some((row) => row.id === loc.id), 'it exists first').toBe(true)

    expect(await deleteAndReadBack(loc.id), 'the row is really gone').toBe(null)

    // …and a second delete is a plain 404, which is what "gone" means here.
    const again = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
    expect(again.status(), 'already gone').toBe(404)
  })

  test('a point a party CHOSE and then LEFT is unreferenced again', async () => {
    const cycle = await makeCycle('Odisiel')
    const product = await addProduct(cycle.id)
    const loc = await makeLocation('Opusteny')
    const other = await makeLocation('Nahradne')
    const friend = await makeFriend('Odchodca')
    await submittedOrder(friend, cycle.id, line(product.id), { pickup_location_id: loc.id })

    // Move them off it — now nothing in EITHER store names it.
    await setPickup(cycle.id, friend.id, other.id)

    expect(await deleteAndReadBack(loc.id), 'nothing references it any more').toBe(null)

    // housekeeping: `pickup_locations` is GLOBAL and every active row lengthens the
    // picker on every other spec's order rows.
    expect([204, 404]).toContain((await admin(`/api/pickup-locations/${other.id}`, { method: 'delete' })).status())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE MATCHED PAIR. Same question, same assertions, two stores.
//
//    (a) a friend with a SUBMITTED own order    → `orders`             (worked)
//    (b) a friend with a DRAFT own order        → `orders`, any status (worked)
//    (c) a HOST WITH NO OWN ORDER               → `guest_order_links`  (THE BUG)
//
//    (c) is the whole row. It is written to be byte-for-byte the same claim as (a)
//    so that "it behaves exactly as an `orders`-referenced one does" is asserted
//    rather than asserted-about.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('FUP-T23 · a REFERENCED point is soft-deleted — from EITHER store', () => {
  // ⚠ THE NON-VACUITY WITNESS for „gone from the active picker list" below, and it
  // has to be OUR OWN row: `e2e/README.md` sanctions running with no template, where
  // `seed.mjs` creates no pickup location at all — the absence assertion would then
  // pass over an EMPTY list. (The same witness rule `distribution-handover.spec.js`
  // records for `locations[]`.)
  let witness = null

  test.beforeAll(async () => { witness = await makeLocation('Svedok') })

  test.afterAll(async () => {
    if (!witness) return
    const res = await admin(`/api/pickup-locations/${witness.id}`, { method: 'delete' })
    expect([204, 404], 'witness retired').toContain(res.status())
  })

  /** The claim, stated once, so the three cases cannot drift apart. */
  async function expectSoftDeleted(loc) {
    const row = await deleteAndReadBack(loc.id)
    expect(row, 'the row SURVIVES the delete').toBeTruthy()
    expect(row.active, 'soft-deleted: deactivated, not destroyed').toBe(0)
    expect(row.name, 'it still names itself, so the party badge stays readable').toBe(loc.name)

    // …and it has left the pickers, which is the whole point of the soft delete.
    const listed = await publicLocations()
    expect(
      listed.some((r) => r.id === witness.id),
      'non-vacuity: a live active point IS listed, so the absence below means something'
    ).toBe(true)
    expect(listed.some((r) => r.id === loc.id), 'gone from the active picker list').toBe(false)
  }

  test('(a) a SUBMITTED own order holds it — `orders`', async () => {
    const cycle = await makeCycle('Odoslana')
    const product = await addProduct(cycle.id)
    const loc = await makeLocation('Miesto Odoslana')
    const friend = await makeFriend('Odoslal')
    await submittedOrder(friend, cycle.id, line(product.id), { pickup_location_id: loc.id })

    await expectSoftDeleted(loc)
  })

  test('(b) a DRAFT own order holds it — `orders`, ANY status', async () => {
    const cycle = await makeCycle('Rozpracovana')
    const product = await addProduct(cycle.id)
    const loc = await makeLocation('Miesto Rozpracovana')
    const friend = await makeFriend('Rozpracoval')
    await draftOrder(friend, cycle.id, line(product.id))

    // `pickupTargetFor()` has NO status filter, so the draft's `orders` row is the
    // store — the admin can set a pickup on it and this delete must see it.
    const target = await setPickup(cycle.id, friend.id, loc.id)
    expect(target.pickup_location_id, 'the pickup landed').toBe(loc.id)

    await expectSoftDeleted(loc)
  })

  // ⚠ THE MUTATION-PROVED ONE. Revert `pickupLocationInUse()` to the shipped
  // `SELECT COUNT(*) FROM orders …` and THIS test — and only the link-stored ones —
  // goes red with `the row SURVIVES the delete`, because the row is really deleted.
  test('(c) a HOST WITH NO OWN ORDER holds it — `guest_order_links`', async () => {
    const cycle = await makeCycle('Bezobjednavky')
    const product = await addProduct(cycle.id)
    const loc = await makeLocation('Miesto Hostitela')

    const host = await makeFriend('Hostitel')
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, `FUP23 Host ${uniq}`, '0911 111 111', line(product.id))

    // No `orders` row anywhere for this friend in this cycle — the pickup can only
    // land on the link.
    const body = await admin(`/api/cycles/${cycle.id}/distribution`)
    expect(body.status()).toBe(200)
    const party = (await body.json()).distribution.find((p) => p.id === host.id)
    expect(party, 'the synthetic host is a party').toBeTruthy()
    expect(party.has_own_order, 'THE PRECONDITION: no own order').toBe(false)
    expect(party.order_id).toBe(null)

    const stored = await setPickup(cycle.id, host.id, loc.id)
    expect(stored.pickup_location_id, 'the pickup landed on the link store').toBe(loc.id)

    await expectSoftDeleted(loc)
  })

  // The consequence the party actually feels, and the reason this is DATA LOSS
  // rather than tidiness: after the delete the board must still NAME the place.
  // With the bug, `target_label` came back `null` here.
  test('(c) the party keeps a NAMED pickup point after the delete', async () => {
    const cycle = await makeCycle('Stitok')
    const product = await addProduct(cycle.id)
    const loc = await makeLocation('Miesto Stitok')

    const host = await makeFriend('Stitkar')
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, `FUP23 Stitok ${uniq}`, '0912 222 222', line(product.id))
    await setPickup(cycle.id, host.id, loc.id)

    expect((await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })).status()).toBe(204)

    const res = await admin(`/api/cycles/${cycle.id}/distribution`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const party = body.distribution.find((p) => p.id === host.id)
    expect(party.delivery).toEqual({
      type: 'pickup',
      target_key: `loc${loc.id}`,
      target_label: loc.name,
      target_detail: loc.address,
      phone: null,
    })
    const card = body.plan.find((entry) => entry.target_key === `loc${loc.id}`)
    expect(card, 'the group is still carded').toBeTruthy()
    expect(card.target_label, 'and it is still named').toBe(loc.name)
    // `locations[]` is REFERENCE-driven, not active-driven, so a retired-but-chosen
    // point is still published for the board's own lookups.
    expect(body.locations.some((row) => row.id === loc.id), 'still named in locations[]').toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. The seam the fix has to hold open: `helpers/pickup.js` answers this question
//    and the route states the rule ZERO times. The check below is the machine-
//    readable half of that — a second COUNT reintroduced at the call site is
//    exactly how this bug came back the first time.
// ─────────────────────────────────────────────────────────────────────────────
test.describe('FUP-T23 · the ONE HOME, mechanically', () => {
  test('the route contains no pickup-reference query of its own', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const path = fileURLToPath(new URL('../../backend/src/routes/pickup-locations.js', import.meta.url))
    // Runs only where the backend source sits beside `e2e/` (the `MAILGUN_*` /
    // `startBackend` precedent); against a deployed target there is no file to read.
    test.skip(!existsSync(path), 'backend source is not beside e2e/ (deployed target)')

    const src = readFileSync(path, 'utf8')
    // NON-VACUITY: we are reading the right file.
    expect(src).toContain('pickupLocationInUse')
    // The rule is not restated here, in either store.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code, 'no hand-written reference COUNT at the call site').not.toMatch(/pickup_location_id\s*=\s*\?/)
    expect(code, 'the link store is not queried here either').not.toMatch(/guest_order_links/)
  })
})
