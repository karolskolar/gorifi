import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T8: guest kilos in CYCLE-LEVEL aggregation (§UC-GSO-013).
//
//   GET /api/analytics/live-cycle   — totals, roastery split, tier progress,
//                                     previous-cycle comparison, nudge list
//   GET /api/analytics/coffee       — per-cycle totals + margin, per-friend table
//   GET /api/cycles/:id/summary     — "Podľa produktu": THE SHEET THE ADMIN ORDERS
//                                     FROM THE ROASTERY WITH
//   GET /api/cycles                 — per-cycle `roastery_breakdown`
//
// The two admin ordering surfaces are the expensive half of this row: guest bags are
// handed over at distribution (GSO-T7) but were never in the quantities being
// bought, so the admin would UNDER-ORDER and guests would collect coffee nobody
// purchased. That is a money error, not a display one.
//
// The whole task is one distinction, straight out of Decision 4 ("Separate tables,
// not rows in `orders`"):
//
//   CYCLE-LEVEL  (kg, value, roastery split, tier, margin) → guests COUNT. That is
//                the point of the feature: the roastery bill and the tier discount
//                do not care who ordered, only how much coffee.
//   PER-FRIEND   (who ordered, how many friends ordered, the "who hasn't ordered"
//                nudge list, segmentation, the per-friend analytics table) → guests
//                are INVISIBLE. A guest is not a friend; a sub-order must never
//                inflate a friend count nor create/alter a segment.
//
// So every test here asserts BOTH halves of the same read: the total moved by an
// exact amount AND the per-friend figures did not move at all. Numbers are exact,
// never "went up" — an off-by-one join (a guest counted twice, or friend rows
// multiplied by the number of sub-orders) survives a "greater than" assertion.
//
// Two assertions carry more weight than they look:
//
//  1. **The tier tip.** `cycleLockedA` holds 25 kg of friend coffee — one kilo under
//     the 26 kg / 35% threshold — plus a 1 kg guest sub-order. A `tier.label` of
//     '35%' can therefore ONLY come from the guest kilo being counted, and the
//     margin (0 at 30%, non-zero at 35%) follows the same kilo.
//  2. **The roastery bucket.** Only default-roastery kilos count toward the tier.
//     A guest kilo of a NON-default roastery must land in `other_roastery_kg` and
//     leave `total_kg` alone — a wrong default classification would silently move
//     kilos into or out of the tier calculation.
//
// ⚠ SINGLETON SELECTION: `live-cycle` reports THE most recent open/locked coffee
// cycle. `created_at` is second-resolution, so GSO-T8 made both of that route's
// single-row picks `ORDER BY created_at DESC, id DESC` — the newest ROW wins, which
// is what makes the current cycle (and the `previous` one) deterministic instead of
// arbitrary among same-second ties. Each live-cycle test still builds its OWN cycle
// through `freshLiveCycle()` and every read asserts it got that cycle before
// asserting anything else. That holds on a fresh local DB and against a long-lived
// environment, because the cycle is created immediately before the read.
//
// ⚠ `previous` — "the most recent COMPLETED coffee cycle", the route's second
// whole-table singleton — is built INSIDE its own test for the same reason, NOT by
// the beforeAll fixture. The reasoning is at that test; the short version is that a
// fixture completed once at setup is outranked by every coffee cycle anything else
// completes afterwards, and two shipped spec files do exactly that. `cyclePrev` in
// beforeAll survives only for the coffee-analytics block, which looks its row up BY
// ID and so does not care what the singleton pick resolves to.
//
// ⚠ NEITHER singleton can be re-scoped away: `GET /api/analytics/live-cycle` takes no
// cycle parameter, so "the route picked my cycle" is a PRECONDITION of every value
// below it, not a value claim that could be narrowed to test-owned rows. (A delta form
// — "whatever cycle it picked, its totals moved by N" — is no escape either: on a
// stolen pick it passes VACUOUSLY at 0-vs-0.) What makes it safe is
// create-then-immediately-read at ONE worker.
//
// ⚠ And one worker is a DEFAULT, not a guarantee: nothing pins it. There is no
// `workers` key in `e2e/playwright.config.js`, no CI config, and `e2e/package.json`'s
// script is a bare `playwright test` — so Playwright's "50% of cores" default gives 1
// here and 2 on a 4-core box. What is true is narrower: at >1 worker these
// admin-API specs fail outright on the shared `settings.admin_token` (`admin.js` does
// `INSERT OR REPLACE … 'admin_token'`, so whichever file logs in second clobbers the
// other's token), which means the cycle-pick race is never the failure you would
// actually observe. Do not upgrade that into "the race cannot happen".
//
// ⚠ Each cycle gets its OWN host, so the per-friend analytics table can be asserted
// exactly (a shared host would sum kilos across cycles). That is 4 friend logins —
// run the suite with a generous `RATE_LIMIT_AUTH_MAX`/`RATE_LIMIT_ABUSE_MAX`, see
// e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const OTHER_ROASTERY = `E2E Ina Praziarna ${uniq}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso8_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Hostitel ${label} ${uniq}`
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

// markup_ratio is pinned to 1.0 so `order_items.price` / `guest_order_items.price`
// equal the product's base price and every EUR figure below is exact.
async function makeCycle(label) {
  const name = `E2E GSO8 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.0 } })).status()).toBe(200)
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, name: `E2E T8 ${uniq}`, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function setStatus(cycleId, status) {
  const res = await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })
  expect(res.status(), `cycle → ${status}`).toBe(200)
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

// ⚠ EVERY guest name this spec submits is recorded here, and the "no guest in a
// friend-shaped list" assertions below test membership of THIS SET rather than
// matching a `/^Kolega /` name pattern across the whole friends table. Nothing
// forbids a real friend from being called "Kolega …", so the pattern form was a
// value claim over rows this spec does not own: it would have gone red on somebody
// else's fixture while the endpoint was behaving perfectly.
//
// ⚠ Why the set form still witnesses the bug — and it is NOT "these are the only
// guests in the window", which is false. `analytics.friends` is not cycle-scoped at
// all (`analytics.js` takes every active friend plus every friend with an order), and
// even the nudge list sits on a route whose completed-cycle lookback is table-wide.
// The real argument is that "a guest is counted as a friend" is SYSTEMIC — it is a
// property of how the route builds friend rows, not of one fixture — so this spec's
// own guests are enough to witness it. The honest cost: a leak confined to ANOTHER
// file's guests is not caught here.
//
// ⚠ And these two lines are DOCUMENTATION OF INTENT, not a pin. In both call sites the
// same bug is caught first by a stronger neighbour (the byte-identical `not_ordered`
// snapshot; the exact per-friend row assertions), and no single-line route mutation
// was found that reds these without reddening those. They are kept because the
// Decision 4 rule they state is worth stating, not because they hold a line alone.
const guestNames = new Set()

let guestSeq = 0
async function submitGuest(linkToken, items, identity) {
  const guestName = identity?.guest_name || `Kolega ${++guestSeq} ${uniq}`
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: guestName,
      guest_phone: identity?.guest_phone || '0901 234 567',
      guest_email: identity?.guest_email || 'kolega@example.com',
      items,
    },
  })
  expect(res.status(), 'guest submit').toBe(201)
  guestNames.add(guestName)
  return res.json()
}

// The names of this spec's own guests found in a friend-shaped list. Returns the
// offending names (not a boolean) so a failure says WHICH guest leaked.
function guestsAmong(rows) {
  return rows.map((r) => r.name).filter((n) => guestNames.has(n))
}

async function submitOwnOrder(host, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
  expect(put.status(), 'own cart').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, { headers: host.auth, data: {} })
  expect(submit.status(), 'own submit').toBe(200)
  return (await submit.json()).order
}

// ---- the endpoints under test -------------------------------------------------

// Every live-cycle read re-asserts the singleton pick, so a stolen selection fails
// loudly on its own line instead of as a puzzling totals mismatch.
async function live(cycle) {
  const res = await admin('/api/analytics/live-cycle')
  expect(res.status(), 'live-cycle').toBe(200)
  const body = await res.json()
  expect(
    body.cycle && body.cycle.id,
    'live-cycle must report this test\'s own cycle (newest open/locked coffee cycle)'
  ).toBe(cycle.id)
  return body
}

async function coffeeAnalytics() {
  const res = await admin('/api/analytics/coffee')
  expect(res.status(), 'coffee analytics').toBe(200)
  return res.json()
}

function cycleRow(analytics, cycleId) {
  const row = analytics.cycles.find((c) => c.id === cycleId)
  expect(row, `cycle ${cycleId} present in analytics`).toBeTruthy()
  return row
}

function friendRow(analytics, friendId) {
  const row = analytics.friends.find((f) => f.id === friendId)
  expect(row, `friend ${friendId} present in analytics`).toBeTruthy()
  return row
}

// ---- fixtures ------------------------------------------------------------------
//
// beforeAll builds the cycles that are DONE (nothing below mutates them):
//
//   cycleOther   open      — the cross-cycle leak probe (receives a guest order)
//   cyclePrev    completed — 2 kg friend + 1 kg guest → the coffee-analytics row for
//                            a COMPLETED cycle, looked up BY ID. It is deliberately
//                            NOT the source of live-cycle's `previous` any more; that
//                            test completes its own cycle inline (see there).
//   cycleLockedA locked    — 25 kg friend + 1 kg guest → the tier tip in analytics
//   cycleLockedB locked    — 2 kg friend + 1 kg CANCELLED guest
//
// Each live-cycle test then builds its OWN open cycle via `freshLiveCycle()` and
// asserts against that. No test depends on a mutation made by an earlier test —
// which matters more than usual here: Playwright restarts the worker after a
// failure, so `beforeAll` re-runs and shared, accumulated state would turn one real
// failure into a cascade of misleading ones.

let cycleOther
let cyclePrev
let cycleLockedA
let cycleLockedB
let hostMain
let linkOther
let hostIds
let otherCycleItems

// A brand-new open coffee cycle that is THE live cycle, with `ownKg` of friend
// coffee already submitted.
//
// No wait is needed: live-cycle orders by `created_at DESC, id DESC`, so among
// cycles created in the same second (DATETIME has second resolution) the newest row
// — this one — wins deterministically. GSO-T8 added that tiebreak; before it, this
// helper had to sleep >1.2s to guarantee a distinct timestamp. `live()` still
// re-asserts the pick on its own line, so a stolen selection fails loudly instead of
// as a totals mismatch.
async function freshLiveCycle(label, ownKg) {
  const cycle = await makeCycle(label)
  const productDefault = await addProduct(cycle.id, { name: `E2E T8 default ${label} ${uniq}`, price_1kg: 20 })
  const productOther = await addProduct(cycle.id, {
    name: `E2E T8 other ${label} ${uniq}`, price_1kg: 12, roastery: OTHER_ROASTERY,
  })
  const link = await shareLink(hostMain, cycle.id)
  await submitOwnOrder(hostMain, cycle.id, [{ product_id: productDefault.id, variant: '1kg', quantity: ownKg }])
  return { cycle, productDefault, productOther, link }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  hostMain = await makeHost('main')
  const hostPrev = await makeHost('prev')
  const hostA = await makeHost('locka')
  const hostB = await makeHost('lockb')
  hostIds = { a: hostA.id, b: hostB.id, prev: hostPrev.id }

  // --- cycleOther: only ever receives a guest sub-order (leak probe) ---
  cycleOther = await makeCycle('other')
  const productOtherCycle = await addProduct(cycleOther.id, { price_1kg: 20 })
  linkOther = await shareLink(hostMain, cycleOther.id)
  otherCycleItems = [{ product_id: productOtherCycle.id, variant: '1kg', quantity: 5 }]

  // --- cyclePrev: 2 kg friend + 1 kg guest, then completed ---
  cyclePrev = await makeCycle('prev')
  const productPrev = await addProduct(cyclePrev.id, { price_1kg: 20 })
  const linkPrev = await shareLink(hostPrev, cyclePrev.id)
  await submitOwnOrder(hostPrev, cyclePrev.id, [{ product_id: productPrev.id, variant: '1kg', quantity: 2 }])
  await submitGuest(linkPrev.token, [{ product_id: productPrev.id, variant: '1kg', quantity: 1 }])
  await setStatus(cyclePrev.id, 'completed')

  // --- cycleLockedA: 25 kg friend (one kilo under the 26 kg tier) + 1 kg guest ---
  cycleLockedA = await makeCycle('locka')
  const productA = await addProduct(cycleLockedA.id, { price_1kg: 20 })
  const linkA = await shareLink(hostA, cycleLockedA.id)
  await submitOwnOrder(hostA, cycleLockedA.id, [{ product_id: productA.id, variant: '1kg', quantity: 25 }])
  await submitGuest(linkA.token, [{ product_id: productA.id, variant: '1kg', quantity: 1 }])
  await setStatus(cycleLockedA.id, 'locked')

  // --- cycleLockedB: 2 kg friend + a guest sub-order that gets cancelled ---
  cycleLockedB = await makeCycle('lockb')
  const productB = await addProduct(cycleLockedB.id, { price_1kg: 20 })
  const linkB = await shareLink(hostB, cycleLockedB.id)
  await submitOwnOrder(hostB, cycleLockedB.id, [{ product_id: productB.id, variant: '1kg', quantity: 2 }])
  const doomed = await submitGuest(linkB.token, [{ product_id: productB.id, variant: '1kg', quantity: 1 }])
  // Soft cancel through the host route (GSO-T5): item rows survive, so only the
  // status predicate can keep these kilos out of the totals.
  expect((await ctx.delete(`/api/guest-orders/${doomed.order.id}`, { headers: hostB.auth })).status()).toBe(200)
  await setStatus(cycleLockedB.id, 'locked')
})

test.afterAll(async () => {
  await ctx?.dispose()
})

test.describe('live-cycle dashboard — cycle totals include guest kilos (UC-GSO-013)', () => {
  test('a guest sub-order raises total_kg/total_value and moves tier progress', async () => {
    const { cycle, productDefault, link } = await freshLiveCycle('tier', 4)

    const before = await live(cycle)
    expect(before.totals.total_kg, '4 × 1 kg of friend coffee').toBe(4)
    expect(before.totals.total_value, '4 × 20 EUR').toBe(80)
    expect(before.totals.guest_kg, 'no guests yet').toBe(0)
    expect(before.totals.guest_value).toBe(0)
    expect(before.totals.tier_label, 'under the 5 kg / 30% threshold').toBeNull()
    expect(before.totals.next_tier.minKg).toBe(5)
    expect(before.totals.distance_to_next_tier).toBe(1)

    // PER-FRIEND snapshot: everything below must be byte-identical afterwards.
    const friendFacts = {
      num_friends: before.totals.num_friends,
      total_eligible: before.totals.total_eligible,
      avg_kg_per_person: before.totals.avg_kg_per_person,
      avg_value_per_person: before.totals.avg_value_per_person,
      not_ordered: JSON.stringify(before.not_ordered),
      potential_kg: before.potential_kg,
    }
    expect(friendFacts.num_friends, 'exactly one friend ordered').toBe(1)
    expect(friendFacts.avg_kg_per_person, '4 kg / 1 friend').toBe(4)

    await submitGuest(link.token, [{ product_id: productDefault.id, variant: '1kg', quantity: 2 }])

    const after = await live(cycle)
    // CYCLE-LEVEL: the 2 guest kilos count, and they tip the cycle over the 5 kg
    // threshold — the tier label can only change because guests are counted.
    expect(after.totals.total_kg, '4 friend + 2 guest kg').toBe(6)
    expect(after.totals.total_value, '80 + 40 EUR').toBe(120)
    expect(after.totals.guest_kg, 'the guest share, visible on its own').toBe(2)
    expect(after.totals.guest_value).toBe(40)
    expect(after.totals.tier_label, '6 kg clears the 5 kg tier').toBe('30%')
    expect(after.totals.next_tier.minKg).toBe(26)
    expect(after.totals.distance_to_next_tier, '26 − 6').toBe(20)

    // PER-FRIEND: a guest is not a friend. Nothing about the friend base moved —
    // not the count, not the averages, not one row of the nudge list.
    expect(after.totals.num_friends, 'a guest must NEVER raise the friend count').toBe(1)
    expect(after.totals.total_eligible).toBe(friendFacts.total_eligible)
    expect(after.totals.avg_kg_per_person, 'per-FRIEND average stays on friend kilos').toBe(4)
    expect(after.totals.avg_value_per_person).toBe(friendFacts.avg_value_per_person)
    expect(JSON.stringify(after.not_ordered), 'the nudge list is untouched').toBe(friendFacts.not_ordered)
    expect(after.potential_kg).toBe(friendFacts.potential_kg)

    // And the guest appears nowhere in the friend-shaped output. Scoped to the guests
    // this spec submitted (see `guestNames`) — the nudge list is every eligible friend
    // who has not ordered, i.e. an unbounded set of rows this test does not own.
    expect(guestsAmong(after.not_ordered), 'no guest in the nudge list').toEqual([])
  })

  test('a cancelled sub-order contributes nothing', async () => {
    const { cycle, productDefault, link } = await freshLiveCycle('cancel', 4)
    const before = await live(cycle)
    expect(before.totals.total_kg, '4 friend kg').toBe(4)

    const doomed = await submitGuest(link.token, [{ product_id: productDefault.id, variant: '1kg', quantity: 3 }])
    const withIt = await live(cycle)
    expect(withIt.totals.total_kg, '4 + 3').toBe(7)
    expect(withIt.totals.total_value, '80 + 60').toBe(140)
    expect(withIt.totals.guest_kg).toBe(3)
    expect(withIt.totals.tier_label, '7 kg clears the 5 kg tier').toBe('30%')

    // Cancelling KEEPS the item rows (GSO-T4), so only the
    // COALESCE(status,'submitted') <> 'cancelled' predicate can remove these kilos.
    expect((await ctx.delete(`/api/guest-orders/${doomed.order.id}`, { headers: hostMain.auth })).status()).toBe(200)

    const after = await live(cycle)
    expect(after.totals.total_kg, 'exactly back to 4 — not 7, not 5.5').toBe(4)
    expect(after.totals.total_value).toBe(80)
    expect(after.totals.guest_kg).toBe(0)
    expect(after.totals.guest_value).toBe(0)
    expect(after.totals.tier_label, 'and the tier progress rolls back with it').toBeNull()
    expect(after.totals.num_friends).toBe(1)
  })

  test('guest kilos land in the correct roastery bucket', async () => {
    // Only DEFAULT-roastery kilos count toward the tier. A guest kilo of another
    // roastery must therefore leave total_kg (and the tier) exactly where it is.
    const { cycle, productOther, link } = await freshLiveCycle('roastery', 4)
    const before = await live(cycle)
    expect(before.totals.other_roastery_kg, 'nothing non-default yet').toBe(0)
    expect(before.totals.other_roastery_value).toBe(0)

    await submitGuest(link.token, [{ product_id: productOther.id, variant: '1kg', quantity: 1 }])

    const after = await live(cycle)
    expect(after.totals.other_roastery_kg, 'the guest kilo lands in the OTHER bucket').toBe(1)
    expect(after.totals.other_roastery_value, '1 × 12 EUR').toBe(12)
    expect(after.totals.total_kg, 'a non-default kilo must NOT move the tier basis').toBe(4)
    expect(after.totals.total_value).toBe(80)
    expect(after.totals.guest_kg, 'guest_kg is the guest share OF total_kg').toBe(0)
    expect(after.totals.tier_label, 'still one kilo short of the 5 kg tier').toBeNull()
    expect(after.totals.distance_to_next_tier).toBe(1)
  })

  test("a guest sub-order in a different cycle does not leak into this cycle's totals", async () => {
    const { cycle } = await freshLiveCycle('leak', 4)
    const before = await live(cycle)
    expect(before.totals.total_kg).toBe(4)

    // 5 kg in cycleOther — enough to change every figure below if the cycle
    // correlation (guest_order_links.cycle_id) were missing.
    await submitGuest(linkOther.token, otherCycleItems)

    const after = await live(cycle)
    expect(after.totals, "this cycle's totals are untouched by another cycle").toEqual(before.totals)
  })

  test('the previous-cycle comparison counts guest kilos, but not guests as friends', async () => {
    // ⚠ THIS TEST BUILDS ITS OWN `previous` CYCLE, seconds before reading it, for the
    // same reason `freshLiveCycle()` exists one helper up. `live-cycle`'s `previous`
    // is "the most recent COMPLETED coffee cycle" over the WHOLE table — the route
    // takes no cycle parameter, so the only way to assert values for a nominated
    // cycle is to be the one that owns the pick at read time.
    //
    // The beforeAll fixture could not give that. It completes `cyclePrev` once, up to
    // four tests earlier, and every completed coffee cycle created anywhere after that
    // moment outranks it on `created_at DESC, id DESC`. Two shipped spec files do
    // exactly that today — `guest-rewards.spec.js` completes its `t4y` cycle and
    // `guest-status.spec.js` completes (then re-opens) one — and neither is guarded.
    //
    // ⚠ Be precise about WHY that was not already red, because the reason is fragile
    // rather than sound: at one worker whole FILES run in sequence and `beforeAll`
    // re-runs per file, so `cyclePrev` was always the newest completed cycle in the
    // instant it mattered. Nothing states that as a rule. Add ONE test above this one
    // that completes a coffee cycle — the same single call those two files make — and
    // the old form went red on `previous.id` with a pair of unrelated cycle ids
    // (verified by injecting exactly that test). This form passes it unchanged.
    //
    // Making the fixture "unambiguously newest" is not available: `created_at` is a
    // `DATETIME DEFAULT CURRENT_TIMESTAMP` with no API to set it, and beforeAll runs
    // before those files do. Asserting whatever `previous` happened to resolve to is
    // not available either — the exact kilos ARE the coverage. Nor is it covered
    // elsewhere: the coffee-analytics block below asserts `cyclePrev`, the beforeAll
    // fixture, by id; the `prev` cycle built here is asserted nowhere else.
    //
    // ⚠ ORDER MATTERS, and it is chosen to make the window ~ZERO. The live cycle is
    // built FIRST and `prev` is completed LAST, so `setStatus(prev, 'completed')` is
    // the last write before the read. Completing a cycle also removes it from the
    // CURRENT-cycle pick (that query is `status IN ('open','locked')`), so `prev` being
    // momentarily the newest open cycle costs nothing and the ordering is free.
    // Building `prev` first instead would leave a whole `freshLiveCycle()` call — ~8
    // requests — sitting between the completion and the read. Down from "one beforeAll
    // plus four tests", and this row exists precisely because that DISTANCE was the
    // real defect.
    //
    // `hostMain` is reused deliberately: nothing asserts hostMain's row in the
    // per-friend analytics table (only hosts a/b/prev are), so this costs no extra
    // friend login and cannot perturb the exact per-friend figures below.
    const { cycle } = await freshLiveCycle('prevcmp', 4)

    const prev = await makeCycle('prevcmp-prev')
    const productPrev = await addProduct(prev.id, { name: `E2E T8 prevcmp ${uniq}`, price_1kg: 20 })
    const linkPrev = await shareLink(hostMain, prev.id)
    await submitOwnOrder(hostMain, prev.id, [{ product_id: productPrev.id, variant: '1kg', quantity: 2 }])
    await submitGuest(linkPrev.token, [{ product_id: productPrev.id, variant: '1kg', quantity: 1 }])
    await setStatus(prev.id, 'completed')

    const body = await live(cycle)
    expect(body.previous, 'the cycle this test just completed is the most recent completed coffee cycle').toBeTruthy()
    expect(body.previous.id).toBe(prev.id)
    expect(body.previous.total_kg, '2 kg friend + 1 kg guest').toBe(3)
    expect(body.previous.total_value, '40 + 20 EUR').toBe(60)
    expect(body.previous.num_friends, 'one friend ordered — the guest is not one').toBe(1)
    expect(body.previous.avg_kg_per_person, 'per-FRIEND average stays on friend kilos').toBe(2)
    expect(body.previous.avg_value_per_person).toBe(40)
    expect(body.previous.friend_ids, 'only the host').toEqual([hostMain.id])
  })
})

test.describe('coffee analytics — cycle totals include guest kilos (UC-GSO-013)', () => {
  test('a guest kilo tips the cycle into the next tier and into a margin', async () => {
    const analytics = await coffeeAnalytics()
    const row = cycleRow(analytics, cycleLockedA.id)

    // 25 kg of friend coffee is ONE KILO under the 26 kg / 35% threshold, so a
    // '35%' tier here is only reachable with the guest kilo counted.
    expect(row.total_kg, '25 friend + 1 guest kg').toBe(26)
    expect(row.total_value, '500 + 20 EUR').toBe(520)
    expect(row.guest_kg).toBe(1)
    expect(row.guest_value).toBe(20)
    expect(row.tier.label, 'the guest kilo tipped the tier — 25 kg alone is 30%').toBe('35%')
    expect(row.tier.minKg).toBe(26)

    // margin = value × (1 − (1 − 0.35) / (1 − 0.30)); at 30% the formula yields 0,
    // so a non-zero margin is the same guest kilo showing up in the money.
    const expectedMargin = Math.round(520 * (1 - 0.65 / 0.7) * 100) / 100
    expect(expectedMargin).toBeCloseTo(37.14, 2)
    expect(row.operator_margin).toBe(expectedMargin)

    // PER-FRIEND, same payload: the friend count and the per-friend averages stay
    // on friend orders only.
    expect(row.num_friends, 'one friend ordered').toBe(1)
    expect(row.avg_kg_per_person, '25 friend kg / 1 friend — NOT 26').toBe(25)
    expect(row.avg_value_per_person).toBe(500)
  })

  test('the per-friend table stays friend-only', async () => {
    const analytics = await coffeeAnalytics()
    const host = friendRow(analytics, hostIds.a)
    expect(host.total_kg, "the host's own 25 kg — their guest's kilo is not theirs (that is GSO-T9)").toBe(25)
    expect(host.total_value).toBe(500)
    expect(host.cycles_participated).toBe(1)
    expect(host.avg_kg_per_cycle).toBe(25)

    // No guest is ever a row in the friend table. Same scoping as the nudge list
    // above: `analytics.friends` is every active friend plus every friend with an
    // order — the whole friends table, in practice.
    expect(guestsAmong(analytics.friends), 'no guest in the friend table').toEqual([])
  })

  test('a cancelled sub-order contributes nothing to a cycle total', async () => {
    const analytics = await coffeeAnalytics()
    const row = cycleRow(analytics, cycleLockedB.id)
    expect(row.total_kg, 'the 2 friend kg only — the cancelled kilo is out').toBe(2)
    expect(row.total_value).toBe(40)
    expect(row.guest_kg).toBe(0)
    expect(row.guest_value).toBe(0)
    expect(row.tier, '2 kg reaches no tier').toBeNull()
    expect(row.operator_margin).toBe(0)
    expect(row.num_friends).toBe(1)

    // The host of the cancelled sub-order: 2 kg, and no trace of the guest.
    const host = friendRow(analytics, hostIds.b)
    expect(host.total_kg).toBe(2)
  })

  test('the completed cycle counts its guest kilo too', async () => {
    const analytics = await coffeeAnalytics()
    const row = cycleRow(analytics, cyclePrev.id)
    expect(row.total_kg, '2 friend + 1 guest kg').toBe(3)
    expect(row.total_value, '40 + 20 EUR').toBe(60)
    expect(row.guest_kg).toBe(1)
    expect(row.num_friends).toBe(1)
    expect(friendRow(analytics, hostIds.prev).total_kg, 'per-friend: 2 kg').toBe(2)
  })
})

// ---- the admin's ordering surfaces --------------------------------------------
//
// A dedicated cycle per test, built by `orderingScenario()`. These stay `open` and
// are irrelevant to the singleton pick above (they run after the live-cycle block),
// so no timing gap is needed.

// ⚠ The product NAMES are chosen so alphabetical order CONTRADICTS purpose order:
// the Espresso product is "zeta…", the Filter one "alfa…". The sheet must still list
// Espresso first (purpose rank 1 before 2), so the order assertion in the merge test
// is evidence about the purpose rank rather than about the names. With names that
// happen to agree with the purposes, dropping the rank from the comparator passes
// unnoticed — verified by trying exactly that.
async function orderingScenario(label, ownQty) {
  const cycle = await makeCycle(label)
  const espresso = await addProduct(cycle.id, {
    name: `E2E T8 zeta esp ${label} ${uniq}`, purpose: 'Espresso', price_250g: 5, price_1kg: 18,
  })
  const filter = await addProduct(cycle.id, {
    name: `E2E T8 alfa fil ${label} ${uniq}`, purpose: 'Filter', price_250g: 6, roastery: OTHER_ROASTERY,
  })
  const link = await shareLink(hostMain, cycle.id)
  // ownQty 0 = no own order yet (the caller submits its own shape).
  if (ownQty > 0) {
    await submitOwnOrder(hostMain, cycle.id, [{ product_id: espresso.id, variant: '250g', quantity: ownQty }])
  }
  return { cycle, espresso, filter, link }
}

async function summaryOf(cycleId, roastery) {
  const query = roastery ? `?roastery=${encodeURIComponent(roastery)}` : ''
  const res = await admin(`/api/cycles/${cycleId}/summary${query}`)
  expect(res.status(), 'cycle summary').toBe(200)
  return res.json()
}

function summaryLines(summary, productId, variant) {
  return summary.items.filter((i) => i.product_id === productId && i.variant === variant)
}

function oneLine(summary, productId, variant) {
  const lines = summaryLines(summary, productId, variant)
  // THE POINT of an ordering sheet: a guest's 250g of X is the same line as a
  // friend's 250g of X. Two rows for one product+variant is the bug.
  expect(lines.length, `exactly one summary line for product ${productId} / ${variant}`).toBe(1)
  return lines[0]
}

async function cycleListRow(cycleId) {
  const res = await admin('/api/cycles')
  expect(res.status(), 'cycles list').toBe(200)
  const row = (await res.json()).find((c) => c.id === cycleId)
  expect(row, `cycle ${cycleId} in the list`).toBeTruthy()
  return row
}

test.describe('GET /api/cycles/:id/summary — the ordering sheet includes guest bags (UC-GSO-013)', () => {
  test('guest lines MERGE into the friend line for the same product + variant', async () => {
    const { cycle, espresso, filter, link } = await orderingScenario('sheet', 2)

    const before = await summaryOf(cycle.id)
    expect(oneLine(before, espresso.id, '250g').total_quantity, '2 × 250g of friend coffee').toBe(2)
    expect(before.totalItems).toBe(2)
    expect(before.totalPrice, '2 × 5 EUR').toBe(10)

    await submitGuest(link.token, [
      { product_id: espresso.id, variant: '250g', quantity: 3 },
      { product_id: espresso.id, variant: '1kg', quantity: 1 },
      { product_id: filter.id, variant: '250g', quantity: 2 },
    ])

    const after = await summaryOf(cycle.id)

    // Merged, not appended: ONE line carrying friend + guest quantity.
    const merged = oneLine(after, espresso.id, '250g')
    expect(merged.total_quantity, '2 friend + 3 guest').toBe(5)
    expect(merged.total_price, '5 × 5 EUR').toBe(25)
    // Product metadata survives the merge (the sheet is read by a human).
    expect(merged.purpose).toBe('Espresso')
    expect(merged.name).toBe(espresso.name)

    // A variant NO friend ordered still has to be bought — it appears as its own line.
    const guestOnly = oneLine(after, espresso.id, '1kg')
    expect(guestOnly.total_quantity, 'guest-only line').toBe(1)
    expect(guestOnly.total_price).toBe(18)
    expect(guestOnly.purpose, 'metadata comes from the same products row').toBe('Espresso')

    const other = oneLine(after, filter.id, '250g')
    expect(other.total_quantity).toBe(2)
    expect(other.total_price).toBe(12)

    expect(after.totalItems, '5 + 1 + 2 bags').toBe(8)
    expect(after.totalPrice, '25 + 18 + 12').toBe(55)

    // ROW ORDER is part of the contract: a guest-only line is appended, so the merged
    // array is re-sorted in JS and that comparator has to reproduce the SQL's
    // `ORDER BY CASE purpose … , name, variant`. Both tiebreaks are discriminating
    // here: the Espresso product is named "zeta…" and the Filter one "alfa…", so
    // Espresso coming FIRST can only be the purpose rank; and the two Espresso lines
    // are '1kg' before '250g' — SQLite's BINARY collation, '1' < '2' — which is the
    // reverse of the insertion order (the friend 250g line comes out of SQL first,
    // the guest 1kg line is appended after it).
    expect(after.items.map((i) => `${i.purpose}|${i.name}|${i.variant}`)).toEqual([
      `Espresso|${espresso.name}|1kg`,
      `Espresso|${espresso.name}|250g`,
      `Filter|${filter.name}|250g`,
    ])
  })

  test('a cancelled sub-order is not on the sheet', async () => {
    const { cycle, espresso, link } = await orderingScenario('sheetcancel', 2)
    const doomed = await submitGuest(link.token, [{ product_id: espresso.id, variant: '250g', quantity: 4 }])

    expect(oneLine(await summaryOf(cycle.id), espresso.id, '250g').total_quantity, '2 + 4').toBe(6)

    // Item rows survive a cancel (GSO-T4) — only the status predicate keeps them off
    // the sheet, and buying a called-off bag costs real money.
    expect((await ctx.delete(`/api/guest-orders/${doomed.order.id}`, { headers: hostMain.auth })).status()).toBe(200)

    const after = await summaryOf(cycle.id)
    expect(oneLine(after, espresso.id, '250g').total_quantity, 'back to the 2 friend bags').toBe(2)
    expect(after.totalItems).toBe(2)
    expect(after.totalPrice).toBe(10)
  })

  test('the roastery filter includes and excludes guest lines correctly', async () => {
    const { cycle, espresso, filter, link } = await orderingScenario('sheetfilter', 2)
    await submitGuest(link.token, [
      { product_id: espresso.id, variant: '250g', quantity: 3 },
      { product_id: filter.id, variant: '250g', quantity: 2 },
    ])

    // `_default` = the products with no roastery set (the main roastery's sheet).
    //
    // ⚠ This request 500'd before this task on ANY input: the branch built
    // `p.roastery = ""`, and an empty DOUBLE-quoted token is a quoted identifier in
    // SQLite with no string-literal fallback (`no such column: ""`). Pre-existing bug
    // on a live UI path (the "hlavná pražiareň" chip in CycleDetail), found by this
    // spec and fixed in GSO-T8 — hence the plain 200 assertion inside summaryOf().
    const defaultSheet = await summaryOf(cycle.id, '_default')
    expect(oneLine(defaultSheet, espresso.id, '250g').total_quantity, 'guest bags included').toBe(5)
    expect(summaryLines(defaultSheet, filter.id, '250g'), 'the other roastery is filtered OUT').toEqual([])
    expect(defaultSheet.totalItems).toBe(5)
    expect(defaultSheet.totalPrice).toBe(25)

    // And the named roastery's own sheet carries the guest bags of THAT roastery only.
    const otherSheet = await summaryOf(cycle.id, OTHER_ROASTERY)
    expect(oneLine(otherSheet, filter.id, '250g').total_quantity, 'guest-only line, other roastery').toBe(2)
    expect(summaryLines(otherSheet, espresso.id, '250g'), 'the default roastery is filtered OUT').toEqual([])
    expect(otherSheet.totalItems).toBe(2)
    expect(otherSheet.totalPrice).toBe(12)
  })

  test("a guest sub-order in another cycle is not on this cycle's sheet", async () => {
    const { cycle, espresso, link } = await orderingScenario('sheetleak', 2)
    await submitGuest(link.token, [{ product_id: espresso.id, variant: '250g', quantity: 1 }])
    const before = await summaryOf(cycle.id)

    await submitGuest(linkOther.token, otherCycleItems)

    const after = await summaryOf(cycle.id)
    expect(after.items, 'another cycle cannot add lines here').toEqual(before.items)
    expect(after.totalItems).toBe(before.totalItems)
    expect(after.totalPrice).toBe(before.totalPrice)
  })
})

test.describe('GET /api/cycles — roastery_breakdown includes guest bags (UC-GSO-013)', () => {
  test('guest kilos and value join the breakdown, per roastery bucket', async () => {
    const { cycle, espresso, filter, link } = await orderingScenario('breakdown', 2)
    await submitGuest(link.token, [
      { product_id: espresso.id, variant: '250g', quantity: 3 },
      { product_id: espresso.id, variant: '1kg', quantity: 1 },
      { product_id: filter.id, variant: '250g', quantity: 2 },
    ])

    const row = await cycleListRow(cycle.id)
    const buckets = Object.fromEntries(row.roastery_breakdown.map((r) => [r.name, r]))
    const otherBucket = buckets[OTHER_ROASTERY]
    const defaultBucket = row.roastery_breakdown.find((r) => r.name !== OTHER_ROASTERY)

    // default: friend 2 × 250g + guest 3 × 250g + guest 1 × 1kg = 2.25 kg → 2.3
    expect(defaultBucket.total_kg, '0.5 friend + 1.75 guest kg, rounded').toBe(2.3)
    expect(defaultBucket.total_value, '10 + 15 + 18 EUR').toBe(43)
    // other roastery: the guest's 2 × 250g only
    expect(otherBucket.total_kg).toBe(0.5)
    expect(otherBucket.total_value).toBe(12)

    expect(row.orders_count, 'still exactly the one friend order').toBe(1)
  })

  test('the breakdown SUMS the guest bags — it never multiplies the friend line', async () => {
    // ⚠ THE JOIN TRAP (GSO-T6): `orders_count`/`unpaid_count` come out of one
    // aggregate over `LEFT JOIN orders`. Pulling the guest tables in as a second
    // LEFT JOIN would multiply the friend line by the number of guest sub-order rows.
    // This scenario makes that unambiguous: 1 friend kg + 2 × 1 guest kg is 3.0 kg,
    // while a multiplied friend line would read 1 × 2 + 2 = 4.0.
    const { cycle, espresso, link } = await orderingScenario('nomultiply', 0)
    await submitOwnOrder(hostMain, cycle.id, [{ product_id: espresso.id, variant: '1kg', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: espresso.id, variant: '1kg', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: espresso.id, variant: '1kg', quantity: 1 }], {
      guest_name: `Kolega druhy ${uniq}`, guest_phone: '0905 111 222',
    })

    const row = await cycleListRow(cycle.id)
    const defaultBucket = row.roastery_breakdown.find((r) => r.name !== OTHER_ROASTERY)
    expect(defaultBucket.total_kg, '1 + 1 + 1 — NOT 4.0').toBe(3)
    expect(defaultBucket.total_value, '3 × 18 EUR — NOT 4 × 18').toBe(54)
    expect(row.orders_count, 'one friend order, whatever the guest count').toBe(1)
    expect(row.unpaid_count, 'one friend + two guests owe money (GSO-T6)').toBe(3)

    // The same sheet, same rule: one line, three kilos.
    expect(oneLine(await summaryOf(cycle.id), espresso.id, '1kg').total_quantity).toBe(3)
  })
})
