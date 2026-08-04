import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T9: reward VOLUME credits guest kilos to the HOST (§UC-GSO-014, Decision 5
// "Host gets the kilos credit").
//
//   GET /api/analytics/rewards   — the group × cycle kilo report the admin awards
//                                  rewards/vouchers from
//
// This is a money row: the report decides who gets reward volume. Every assertion
// below is an EXACT kilo figure, never "went up" — the two failure modes that matter
// here both survive a "greater than" check:
//
//   1. UNDER-crediting: the guest kilos land nowhere (the host recruited the volume
//      and delivers it, so they are the ones owed the credit), or land in the wrong
//      group / the wrong cycle column.
//   2. DOUBLE-crediting: the same guest kilo counted twice — as the host's own and
//      again through their group, once as a root and again as its own member, or a
//      friend line multiplied by the number of sub-orders (the GSO-T6 join trap; the
//      guest half must be merged in JAVASCRIPT, never as a second JOIN).
//
// So the report is read as a whole: the per-cycle column of EVERY bucket is summed
// and compared against the cycle's independently-known guest kilos, which is what
// proves "exactly once" rather than merely "present".
//
// Bucket coverage (`rewards.js` mirrors `friends.is_root` / `root_friend_id`): a host
// who is a group ROOT, a host who is a group MEMBER, and a host who is UNASSIGNED
// (the "Ostatní" bucket) are each pinned separately — a host must not vanish because
// they are in no group, nor be counted both as a root and as a member of their own
// group.
//
// ⚠ `rewards.js` only reports LOCKED/COMPLETED coffee cycles, so every scenario locks
// its cycle at the end. Guest submits and host cancels happen while it is still open.
//
// ⚠ The "Ostatní" bucket is GLOBAL (every unassigned friend in the database), so its
// `cumulativeKg`/`memberCount` are environment-dependent and are never asserted.
// Its PER-CYCLE column for a cycle this spec created from scratch is exact, because
// only this spec's friends can have volume in it. Every group assertion works the
// same way: fresh cycle, fresh hosts, fresh group.
//
// Cross-checks against GSO-T8 come from a different route (`/api/analytics/coffee`),
// so "own + guest" is recomputed from independently-sourced halves rather than from
// the number under test: the per-FRIEND table there is own-orders-only (T8's Decision
// 4 split, which this row must NOT change — a host's reward credit does not make the
// guest's kilos part of the host's own consumption), and the per-CYCLE row there
// already counts guests once.
//
// Every host is a separate friend login — run with a generous `RATE_LIMIT_AUTH_MAX`
// / `RATE_LIMIT_ABUSE_MAX`, see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

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
  const username = `gso9_${slug}`.slice(0, 30 - suffix.length) + suffix
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
  // A brand-new friend is `is_root = 0, root_friend_id = NULL` — i.e. UNASSIGNED
  // ("Ostatní") until makeRoot()/assignTo() moves them.
  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeRoot(host) {
  const res = await admin(`/api/friend-groups/${host.id}/root-status`, { method: 'patch', data: { isRoot: true } })
  expect(res.status(), 'make root').toBe(200)
  return host
}

async function assignTo(host, root) {
  const res = await admin(`/api/friend-groups/${host.id}/assign-root`, { method: 'patch', data: { rootFriendId: root.id } })
  expect(res.status(), 'assign to root').toBe(200)
  return host
}

// markup_ratio is pinned to 1.0 so `order_items.price` / `guest_order_items.price`
// equal the product's base price. Kilos are what this row is about, but keeping the
// money exact too makes a wrong-variant slip visible.
async function makeCycle(label) {
  const name = `E2E GSO9 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.0 } })).status()).toBe(200)
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `E2E T9 ${uniq}`, price_1kg: 20, price_250g: 5, ...data },
  })
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

let guestSeq = 0
async function submitGuest(linkToken, items) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: `Kolega ${++guestSeq} ${uniq}`,
      guest_phone: '0901 234 567',
      guest_email: 'kolega@example.com',
      items,
    },
  })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function draftOwnCart(host, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
  expect(put.status(), 'own cart (draft, NOT submitted)').toBe(200)
}

async function submitOwnOrder(host, cycleId, items) {
  await draftOwnCart(host, cycleId, items)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, { headers: host.auth, data: {} })
  expect(submit.status(), 'own submit').toBe(200)
  return (await submit.json()).order
}

// ---- the endpoint under test ---------------------------------------------------

// `limit` is generous so a long-lived environment's older cycles cannot push this
// spec's freshly created ones out of the window (the route takes the newest N by id).
async function rewards() {
  const res = await admin('/api/analytics/rewards?limit=60')
  expect(res.status(), 'rewards report').toBe(200)
  return res.json()
}

function groupOf(report, root) {
  const group = report.groups.find((g) => g.rootFriend && g.rootFriend.id === root.id)
  expect(group, `group of root ${root.name}`).toBeTruthy()
  return group
}

function ostatni(report) {
  const group = report.groups.find((g) => !g.rootFriend)
  expect(group, 'the unassigned ("Ostatní") bucket').toBeTruthy()
  expect(group.label).toBe('Ostatní')
  return group
}

function col(group, cycleId) {
  const pc = group.perCycle.find((p) => p.cycleId === cycleId)
  expect(pc, `cycle ${cycleId} column of ${group.rootFriend ? group.rootFriend.name : 'Ostatní'}`).toBeTruthy()
  return pc
}

function hasCycle(report, cycleId) {
  return report.cycles.some((c) => c.id === cycleId)
}

// Every bucket's column for one cycle, summed. This is the "exactly once" probe:
// a kilo credited twice (own + group, root + member, or a multiplied friend line)
// shows up here even when each individual bucket looks plausible.
function totalAcrossBuckets(report, cycleId) {
  const sum = report.groups.reduce((acc, g) => {
    const pc = g.perCycle.find((p) => p.cycleId === cycleId)
    return acc + (pc ? pc.kg : 0)
  }, 0)
  return Math.round(sum * 1000) / 1000
}

function guestAcrossBuckets(report, cycleId) {
  const sum = report.groups.reduce((acc, g) => {
    const pc = g.perCycle.find((p) => p.cycleId === cycleId)
    return acc + (pc ? pc.guestKg : 0)
  }, 0)
  return Math.round(sum * 1000) / 1000
}

// No guest may ever surface as a member of a group — a guest is not a friend
// (Decision 4). Every guest this spec submits is named `Kolega <n> <uniq>`.
function expectNoGuestAsMember(report) {
  for (const group of report.groups) {
    for (const pc of group.perCycle) {
      expect(pc.orderedMembers.some((n) => /^Kolega /.test(n)), 'no guest in orderedMembers').toBe(false)
      expect(pc.guestOnlyMembers.some((n) => /^Kolega /.test(n)), 'no guest in guestOnlyMembers').toBe(false)
    }
  }
}

// ⚠ THE TWO LISTS. `orderedMembers` answers "who ordered" and is therefore OWN
// SUBMITTED ORDERS ONLY — the per-friend question Decision 4 / GSO-T8 fence off
// ("anything answering 'who ordered' must keep querying `orders` alone"). A host whose
// only contribution is their guests' kilos is credited the volume (Decision 5) but did
// NOT order, so they appear in `guestOnlyMembers` instead: on the screen that decides
// reward money, "Objednali: X" must not be a false statement about X, and a future
// consumer reading `orderedMembers` as "friends with a submitted order" must not be
// silently wrong. The two lists are disjoint and together account for the group's kg.
function expectMembers(cell, { ordered, guestOnly }) {
  expect([...cell.orderedMembers].sort(), 'members with an OWN submitted order').toEqual([...ordered].sort())
  expect([...cell.guestOnlyMembers].sort(), 'members whose volume is guests only').toEqual([...guestOnly].sort())
}

// ---- the independent half: GSO-T8's cycle-level route --------------------------

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

// ⚠ There is exactly ONE admin token in the whole app (`settings.admin_token`, written
// with INSERT OR REPLACE), so every admin login invalidates the previous one. The UI
// test at the bottom logs in through the browser and therefore retires this context's
// token — it runs last and re-acquires one afterwards, so no API test can be left
// holding a dead token.
async function adminLogin() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await adminLogin()
})

test.afterAll(async () => {
  await ctx?.dispose()
})

test.describe('rewards volume — a guest sub-order credits the HOST (UC-GSO-014)', () => {
  test("a host with NO own submitted order is still credited their guests' kilos", async () => {
    const host = await makeRoot(await makeHost('t1root'))
    const cycle = await makeCycle('t1')
    const product = await addProduct(cycle.id)
    const link = await shareLink(host, cycle.id)

    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 3 }])

    // An UNSUBMITTED cart must not be credited: `rewards.js` counts own orders with
    // `status = 'submitted'`, and folding guests in must not loosen that.
    await draftOwnCart(host, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 7 }])

    // While the cycle is still open it is outside the report entirely (the report is
    // about locked/completed coffee cycles) — guest kilos must not change that.
    const open = await rewards()
    expect(hasCycle(open, cycle.id), 'an OPEN cycle is not in the rewards report').toBe(false)

    await setStatus(cycle.id, 'locked')

    const report = await rewards()
    expect(hasCycle(report, cycle.id), 'the locked cycle is now reported').toBe(true)

    const group = groupOf(report, host)
    const cell = col(group, cycle.id)
    expect(cell.kg, "3 guest kg credited to the host — and NOT the 7 kg draft").toBe(3)
    expect(cell.guestKg, 'all 3 kilos come from guests').toBe(3)
    expect(group.cumulativeKg, 'a brand-new group with exactly this one cycle').toBe(3)
    expect(group.memberCount, 'the guest never becomes a group member').toBe(1)
    // The host is credited the volume but ordered nothing themselves — so they are
    // NOT in "who ordered". Their name is in the guest-volume list instead, which is
    // what keeps the group's 3 kg accounted for without claiming they ordered.
    expectMembers(cell, { ordered: [], guestOnly: [host.name] })

    // Exactly once across the whole report: nobody else has volume in this cycle.
    expect(totalAcrossBuckets(report, cycle.id), '3 kg in the report, once').toBe(3)
    expect(guestAcrossBuckets(report, cycle.id)).toBe(3)
    expectNoGuestAsMember(report)
  })

  test('own kilos and guest kilos SUM — neither half is counted twice', async () => {
    const root = await makeRoot(await makeHost('t2root'))
    const member = await assignTo(await makeHost('t2member'), root)
    const cycle = await makeCycle('t2')
    const product = await addProduct(cycle.id)
    const rootLink = await shareLink(root, cycle.id)
    const memberLink = await shareLink(member, cycle.id)

    // root:   2 kg own (2 × 1kg)   + 1 kg   guest (1 × 1kg)
    // member: 1 kg own (4 × 250g)  + 0.5 kg guest (2 sub-orders × 1 × 250g)
    // Sub-kilo variants on BOTH halves, and two sub-orders under one host.
    await submitOwnOrder(root, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await submitGuest(rootLink.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitOwnOrder(member, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 4 }])
    await submitGuest(memberLink.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await submitGuest(memberLink.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await setStatus(cycle.id, 'locked')

    const report = await rewards()
    const group = groupOf(report, root)
    const cell = col(group, cycle.id)

    // 3 kg own + 1.5 kg guest. A host's own order counted a second time would read
    // 7.5; guest kilos counted both as the host's own and again through the group
    // would read 6.0; a friend line multiplied by the two sub-orders under the
    // member would read 5.5.
    expect(cell.kg, '2 + 1 own + 1 + 0.5 guest').toBe(4.5)
    expect(cell.guestKg, 'the guest share of it').toBe(1.5)
    expect(group.cumulativeKg).toBe(4.5)
    expect(group.cumulativeGuestKg).toBe(1.5)
    expect(group.memberCount, 'root + one member — guests are not members').toBe(2)
    // Both friends ordered AND hosted, so both belong in "who ordered" and neither is
    // guest-only.
    expectMembers(cell, { ordered: [root.name, member.name], guestOnly: [] })

    // The SAME number, recomputed from two independently-sourced halves on a
    // different route: GSO-T8's per-FRIEND table is own-orders-only, and its
    // per-CYCLE row counts the cycle's guest kilos once.
    // (All the figures below are 1-decimal exact, which is the resolution that route
    // rounds kilos to.)
    const analytics = await coffeeAnalytics()
    const ownRoot = friendRow(analytics, root.id).total_kg
    const ownMember = friendRow(analytics, member.id).total_kg
    const cycleGuestKg = cycleRow(analytics, cycle.id).guest_kg
    expect(ownRoot, "the host's own 2 kg — the guest kilo is credited to them, not consumed by them").toBe(2)
    expect(ownMember).toBe(1)
    expect(cycleGuestKg, 'every guest in this cycle is hosted by this group').toBe(1.5)
    expect(cell.kg, 'own + guest, from independently sourced halves').toBe(ownRoot + ownMember + cycleGuestKg)
    expect(cell.guestKg).toBe(cycleGuestKg)

    // And GSO-T8's own numbers are untouched by this row: the cycle total already
    // included guests once and must not now be doubled.
    const row = cycleRow(analytics, cycle.id)
    expect(row.total_kg, '3 friend + 1.5 guest, counted once').toBe(4.5)
    expect(row.num_friends, 'two friends ordered; the three guests are not friends').toBe(2)
    expect(row.avg_kg_per_person, 'per-FRIEND average stays on friend kilos: 3 / 2').toBe(1.5)

    expect(totalAcrossBuckets(report, cycle.id), '4.5 in the report, once').toBe(4.5)
    expect(guestAcrossBuckets(report, cycle.id)).toBe(1.5)
    expectNoGuestAsMember(report)
  })

  test('a CANCELLED sub-order contributes zero reward volume', async () => {
    const host = await makeRoot(await makeHost('t3root'))
    const cycle = await makeCycle('t3')
    const product = await addProduct(cycle.id)
    const link = await shareLink(host, cycle.id)

    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    const doomed = await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 4 }])

    const beforeLock = await rewards()
    expect(hasCycle(beforeLock, cycle.id)).toBe(false)

    // Soft cancel through the host route (GSO-T5): the item rows SURVIVE, so only the
    // COALESCE(status,'submitted') <> 'cancelled' predicate can keep these 4 kilos out
    // of the credit. Reward volume is what a voucher is paid against.
    expect((await ctx.delete(`/api/guest-orders/${doomed.order.id}`, { headers: host.auth })).status()).toBe(200)

    await setStatus(cycle.id, 'locked')

    const report = await rewards()
    const cell = col(groupOf(report, host), cycle.id)
    expect(cell.kg, '2 own + 1 live guest kg — the cancelled 4 kg are out').toBe(3)
    expect(cell.guestKg, 'the live sub-order only').toBe(1)
    expectMembers(cell, { ordered: [host.name], guestOnly: [] })
    expect(totalAcrossBuckets(report, cycle.id)).toBe(3)

    const analytics = await coffeeAnalytics()
    expect(cycleRow(analytics, cycle.id).guest_kg, 'GSO-T8 agrees').toBe(1)
    expect(friendRow(analytics, host.id).total_kg, "the host's own kilos").toBe(2)
  })

  test('guest kilos land in the cycle they were ordered in', async () => {
    const host = await makeRoot(await makeHost('t4root'))
    const cycleX = await makeCycle('t4x')
    const cycleY = await makeCycle('t4y')
    const productX = await addProduct(cycleX.id)
    const productY = await addProduct(cycleY.id)
    const linkX = await shareLink(host, cycleX.id)
    const linkY = await shareLink(host, cycleY.id)

    // X: 1 kg own + 2 kg guest = 3.   Y: no own order + 5 kg guest = 5.
    // The totals are deliberately different: a missing cycle correlation would put
    // all 7 guest kilos in both columns.
    await submitOwnOrder(host, cycleX.id, [{ product_id: productX.id, variant: '1kg', quantity: 1 }])
    await submitGuest(linkX.token, [{ product_id: productX.id, variant: '1kg', quantity: 2 }])
    await submitGuest(linkY.token, [{ product_id: productY.id, variant: '1kg', quantity: 5 }])

    await setStatus(cycleX.id, 'locked')
    await setStatus(cycleY.id, 'completed')

    const report = await rewards()
    const group = groupOf(report, host)

    const cellX = col(group, cycleX.id)
    expect(cellX.kg, '1 own + 2 guest — NOT 8').toBe(3)
    expect(cellX.guestKg, "cycle Y's 5 kilos are not here").toBe(2)
    // The SAME friend, and the two lists differ per cycle: they ordered in X, and in Y
    // their whole contribution is their guests'.
    expectMembers(cellX, { ordered: [host.name], guestOnly: [] })

    const cellY = col(group, cycleY.id)
    expect(cellY.kg, 'guest-only cycle (and `completed` counts too)').toBe(5)
    expect(cellY.guestKg).toBe(5)
    expectMembers(cellY, { ordered: [], guestOnly: [host.name] })

    expect(group.cumulativeKg, '3 + 5 across the two cycles').toBe(8)
    expect(totalAcrossBuckets(report, cycleX.id)).toBe(3)
    expect(totalAcrossBuckets(report, cycleY.id)).toBe(5)
  })
})

test.describe('rewards volume — the bucket a host sits in (UC-GSO-014)', () => {
  test('root, member and unassigned hosts are each credited exactly once, in their own bucket', async () => {
    // Distinct powers of two (1 / 2 / 4) so ANY mis-bucketing or double count reads as
    // a number that can only come from the wrong sum.
    const root = await makeRoot(await makeHost('t5root'))
    const member = await assignTo(await makeHost('t5member'), root)
    const loner = await makeHost('t5loner') // deliberately left UNASSIGNED ("Ostatní")

    const cycle = await makeCycle('t5')
    const product = await addProduct(cycle.id)
    const rootLink = await shareLink(root, cycle.id)
    const memberLink = await shareLink(member, cycle.id)
    const lonerLink = await shareLink(loner, cycle.id)

    await submitGuest(rootLink.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(memberLink.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await submitGuest(lonerLink.token, [{ product_id: product.id, variant: '1kg', quantity: 4 }])

    await setStatus(cycle.id, 'locked')

    const report = await rewards()

    // The ROOT's group carries the root's own guest kilos AND its member's — once.
    // A root double-counted as its own member would read 2 (1 + 1) + 2 = 4.
    const group = groupOf(report, root)
    const cell = col(group, cycle.id)
    expect(cell.kg, '1 (root host) + 2 (member host) guest kg').toBe(3)
    expect(cell.guestKg).toBe(3)
    expect(group.cumulativeKg).toBe(3)
    expect(group.memberCount, 'root + member').toBe(2)
    // Neither host ordered anything themselves — all three contributions are guests'.
    expectMembers(cell, { ordered: [], guestOnly: [root.name, member.name] })
    expect(cell.guestOnlyMembers, 'the unassigned host is NOT in this group').not.toContain(loner.name)

    // The UNASSIGNED host does not vanish: their guest kilos land in "Ostatní".
    // (Only this spec's friends can have volume in this brand-new cycle, so the
    // per-cycle column is exact even though the bucket itself is global.)
    const rest = ostatni(report)
    const restCell = col(rest, cycle.id)
    expect(restCell.kg, "the unassigned host's 4 guest kg").toBe(4)
    expect(restCell.guestKg).toBe(4)
    expectMembers(restCell, { ordered: [], guestOnly: [loner.name] })
    expect(restCell.guestOnlyMembers, 'a grouped host does not leak into Ostatní').not.toContain(root.name)

    // Whole-report closure: 1 + 2 + 4 = 7 kilos exist in this cycle and appear seven
    // times over, no more, no less.
    expect(totalAcrossBuckets(report, cycle.id), '1 + 2 + 4, each once').toBe(7)
    expect(guestAcrossBuckets(report, cycle.id)).toBe(7)
    expectNoGuestAsMember(report)
  })

  test('MIXED group: "who ordered" names only the member who ordered, guest volume names the other', async () => {
    // The case the two lists exist for. One member ordered 2 kg and hosted nobody; the
    // other ordered NOTHING and brought 3 kg of guest coffee. A single list cannot say
    // this without lying about one of them — and this report decides reward money.
    const root = await makeRoot(await makeHost('t9root')) // guest volume only
    const member = await assignTo(await makeHost('t9member'), root) // own order only
    const cycle = await makeCycle('t9')
    const product = await addProduct(cycle.id)
    const rootLink = await shareLink(root, cycle.id)

    await submitGuest(rootLink.token, [{ product_id: product.id, variant: '1kg', quantity: 3 }])
    await submitOwnOrder(member, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await setStatus(cycle.id, 'locked')

    const report = await rewards()
    const group = groupOf(report, root)
    const cell = col(group, cycle.id)

    expect(cell.kg, '2 own + 3 guest').toBe(5)
    expect(cell.guestKg).toBe(3)
    expect(group.memberCount, 'two friends, whatever the guests did').toBe(2)

    // THE POINT: the admin can tell which of the two never ordered.
    expectMembers(cell, { ordered: [member.name], guestOnly: [root.name] })
    expect(cell.orderedMembers, 'the guest-only host must NOT be claimed to have ordered')
      .not.toContain(root.name)
    expect(cell.guestOnlyMembers, 'the member who ordered is not guest-only')
      .not.toContain(member.name)

    // The lists are disjoint and together explain the whole bar: 2 kg from the one who
    // ordered, 3 guest kg from the one who did not.
    expect(cell.orderedMembers.filter((n) => cell.guestOnlyMembers.includes(n)), 'disjoint').toEqual([])
    expect(cell.kg - cell.guestKg, "the ordered members' own kilos").toBe(2)
    expect(totalAcrossBuckets(report, cycle.id)).toBe(5)
    expectNoGuestAsMember(report)
  })

  test("a guest sub-order under another group's host does not leak into this group", async () => {
    const rootA = await makeRoot(await makeHost('t6roota'))
    const rootB = await makeRoot(await makeHost('t6rootb'))
    const cycle = await makeCycle('t6')
    const product = await addProduct(cycle.id)
    const linkB = await shareLink(rootB, cycle.id)

    // Group A: 1 kg of own coffee and no guests at all.
    // Group B: 5 kg of guest coffee and no own order.
    await submitOwnOrder(rootA, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(linkB.token, [{ product_id: product.id, variant: '1kg', quantity: 5 }])

    await setStatus(cycle.id, 'locked')

    const report = await rewards()

    const groupB = groupOf(report, rootB)
    const cellB = col(groupB, cycle.id)
    expect(cellB.kg, "group B's guest kilos, credited to its host").toBe(5)
    expect(cellB.guestKg).toBe(5)
    expect(groupB.cumulativeKg).toBe(5)
    expectMembers(cellB, { ordered: [], guestOnly: [rootB.name] })

    const groupA = groupOf(report, rootA)
    const cellA = col(groupA, cycle.id)
    expect(cellA.kg, "group A's own kilo only").toBe(1)
    expect(cellA.guestKg, 'group A hosted nobody').toBe(0)
    expect(groupA.cumulativeKg).toBe(1)
    expectMembers(cellA, { ordered: [rootA.name], guestOnly: [] })

    expect(totalAcrossBuckets(report, cycle.id), '1 + 5').toBe(6)
  })

  test('a DEACTIVATED host keeps the credit for kilos already bought', async () => {
    // Their own orders keep counting once deactivated (`rewards.js` reads every
    // friend row, active or not — the report is history), so the guest half must not
    // vanish either: the coffee was bought, the group's volume happened.
    const host = await makeRoot(await makeHost('t7root'))
    const cycle = await makeCycle('t7')
    const product = await addProduct(cycle.id)
    const link = await shareLink(host, cycle.id)

    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await setStatus(cycle.id, 'locked')

    const before = col(groupOf(await rewards(), host), cycle.id)
    expect(before.kg, '1 own + 2 guest').toBe(3)
    expect(before.guestKg).toBe(2)

    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const after = col(groupOf(await rewards(), host), cycle.id)
    expect(after.kg, 'deactivating the host changes no history').toBe(3)
    expect(after.guestKg).toBe(2)
    expectMembers(after, { ordered: [host.name], guestOnly: [] })
  })

  test('deleting a group ROOT does not make its ex-members\' volume disappear', async () => {
    // ⚠ `friends.root_friend_id` has NO foreign key (bare ALTER TABLE), and
    // `DELETE /api/friends/:id` really deletes the row. So deleting a root used to
    // leave its members pointing at a friend who no longer exists: they matched
    // neither the group loop nor the "unassigned" filter and dropped out of the report
    // entirely — a routine admin action silently zeroing a member's whole reward
    // volume, own kilos AND the guest kilos this row credits them. That voids this
    // row's own guarantee, so it is fixed from both ends: `rewards.js` treats an
    // unresolvable pointer as unassigned, and the delete route clears the pointers.
    const root = await makeRoot(await makeHost('t10root')) // group root, no volume of its own
    const member = await assignTo(await makeHost('t10member'), root)
    const cycle = await makeCycle('t10')
    const product = await addProduct(cycle.id)
    const memberLink = await shareLink(member, cycle.id)

    await submitOwnOrder(member, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(memberLink.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await setStatus(cycle.id, 'locked')

    const before = await rewards()
    const cellBefore = col(groupOf(before, root), cycle.id)
    expect(cellBefore.kg, '1 own + 2 guest, in the root\'s group').toBe(3)
    expect(cellBefore.guestKg).toBe(2)
    expect(totalAcrossBuckets(before, cycle.id), 'closure before the delete').toBe(3)

    // The root has no balance (nothing was packed), so the admin can delete them.
    expect((await admin(`/api/friends/${root.id}`, { method: 'delete' })).status(), 'root deleted').toBe(204)

    const after = await rewards()
    expect(after.groups.some((g) => g.rootFriend && g.rootFriend.id === root.id), 'the group is gone').toBe(false)

    // …but its member's volume is NOT. It moved to "Ostatní", intact.
    const restCell = col(ostatni(after), cycle.id)
    expect(restCell.kg, 'the same 3 kg — not 0').toBe(3)
    expect(restCell.guestKg, 'the guest half survives the reorganisation too').toBe(2)
    expectMembers(restCell, { ordered: [member.name], guestOnly: [] })

    // Whole-report closure still holds: the kilos moved bucket, none evaporated.
    expect(totalAcrossBuckets(after, cycle.id), 'closure after the delete').toBe(3)
    expect(guestAcrossBuckets(after, cycle.id)).toBe(2)

    // And the pointer itself was cleared, so the friend is genuinely unassigned rather
    // than merely rescued by the report's tolerance.
    const groups = await admin('/api/friend-groups')
    expect(groups.status()).toBe(200)
    const body = await groups.json()
    expect(body.unassigned.some((f) => f.id === member.id), 'listed as unassigned, no dangling pointer').toBe(true)
    expect(body.groups.some((g) => g.rootFriend.id === root.id), 'the group is gone here too').toBe(false)
  })
})

// The fix for the vanishing volume has TWO halves, and the API can only exercise one
// of them: with the delete route clearing the pointers, no API call leaves a dangling
// `root_friend_id` behind any more, so the report's tolerance for one is unreachable
// from outside. It still matters — every database that ran the old delete already
// CONTAINS such rows, and `root_friend_id` has no FK to stop a future writer creating
// more — so it gets the suite's established DB_PATH treatment (same rationale as
// guest-distribution.spec.js's manufactured id collision): a direct write builds the
// broken state, and the test self-skips where the DB file is not reachable.
const DB_PATH = process.env.DB_PATH || ''

test.describe('a dangling root pointer (legacy data) still lands in a bucket', () => {
  test('volume survives a root_friend_id that resolves to nothing', async () => {
    test.skip(!DB_PATH, 'requires DB_PATH to manufacture the dangling pointer')

    const root = await makeRoot(await makeHost('t11root'))
    const member = await assignTo(await makeHost('t11member'), root)
    const cycle = await makeCycle('t11')
    const product = await addProduct(cycle.id)
    const link = await shareLink(member, cycle.id)

    await submitOwnOrder(member, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await setStatus(cycle.id, 'locked')

    expect(col(groupOf(await rewards(), root), cycle.id).kg, '1 own + 2 guest').toBe(3)

    // Point the member at an id that is not a friend at all — the state the old delete
    // route left behind.
    const db = new DatabaseSync(DB_PATH)
    try {
      const orphanId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) + 1000 AS n FROM friends').get().n)
      db.prepare('UPDATE friends SET root_friend_id = ? WHERE id = ?').run(orphanId, member.id)
    } finally {
      db.close()
    }

    const after = await rewards()
    expect(col(groupOf(after, root), cycle.id).kg, 'no longer in the group').toBe(0)
    const restCell = col(ostatni(after), cycle.id)
    expect(restCell.kg, 'the volume is in "Ostatní", not gone').toBe(3)
    expect(restCell.guestKg, 'including the guest half GSO-T9 credits').toBe(2)
    expectMembers(restCell, { ordered: [member.name], guestOnly: [] })
    expect(totalAcrossBuckets(after, cycle.id), 'whole-report closure holds').toBe(3)
  })
})

test.describe('rewards volume — UI (UC-GSO-014)', () => {
  // The one UI assertion of this row. The credit itself is a backend attribution, but
  // a group's kilos can now include volume nobody in it ordered themselves, so the
  // report states the guest share instead of leaving it implicit — this pins that the
  // figure actually renders (a template typo is invisible to an API test).
  test('UI: the group total spells out how much of it came from guests', async ({ page }) => {
    const host = await makeRoot(await makeHost('t8root'))
    const cycle = await makeCycle('t8')
    const product = await addProduct(cycle.id)
    const link = await shareLink(host, cycle.id)

    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '1kg', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    await setStatus(cycle.id, 'locked')

    // No addInitScript(localStorage.clear) — it reruns on the navigation to the
    // report and wipes the just-stored admin token (item-packed.spec.js documents
    // the same trap). A fresh test context already starts with empty storage.
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await page.goto('/admin/analytics/rewards')
    const row = page.locator('div.flex.items-center.gap-3').filter({ hasText: host.name })
    await expect(row).toBeVisible()
    await expect(row, '1 own + 2 guest kg').toContainText('3.00 kg')
    await expect(row.getByTestId('group-guest-kg'), 'the guest share of the group total')
      .toHaveText(/z toho 2\.00 kg od hosti/)

    // The browser login above retired this context's admin token (one token app-wide).
    await adminLogin()
  })
})
