import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T7: the guest leg of the Distribution view (§UC-GSO-011).
//
//   PATCH /api/guest-order-items/:id/packed   — the per-bag checkbox for a guest
//                                               item (mirrors the friend one from
//                                               GSO-T1)
//   PATCH /api/orders/:id/packed              — the gate now counts guest items
//   GET   /api/cycles/:id/distribution        — guest items grouped per guest
//                                               under their host; a host with no
//                                               own order is still listed
//
// What carries this task:
//
//  1. **The gate is completed, not duplicated.** GSO-T1 built the "every item
//     checked before Zabaliť" rule over `order_items` only, with a comment marking
//     this UNION as the extension point. The rule becomes: at least one item across
//     own + guest, and every one of them packed. Cancelled sub-orders are excluded
//     on both sides of that sentence — they are neither bags to pack nor blockers.
//
//  2. **A host with no own order stays the pickup party** (§Edge Cases). Their only
//     stake is their colleagues' bags, and the distribution query — `FROM orders o`
//     — cannot see them at all. They are synthesised in, exactly as GSO-T6 does on
//     the admin orders tab. Such a row has NO `orders.id`, so the whole-order
//     `packed` flag has nowhere to live: the payload says `has_own_order: false` and
//     the UI offers no "Zabaliť" (a PATCH to `/api/orders/null/packed` is not a
//     thing). Their packing record is the per-bag checkboxes alone.
//
//  3. **Guest items move no money.** Guests have no `friend_id` and no balance
//     (Decision 1), so toggling a guest checkbox must write no `transactions` row —
//     the GSO-T6 rule, re-asserted on this endpoint. The ONE exception is
//     deliberate and belongs to the host, not the guest: unchecking a guest item on
//     a packed order un-packs that order, which posts the reversal of the HOST'S OWN
//     order total (the same reversal the whole-order toggle posts). The host's
//     balance must therefore net back to exactly where it started.
//
//  4. **No guest-edit-vs-packed race exists.** Guest edits are only possible while
//     the cycle is `open`; distribution happens after the lock. Nothing here defends
//     against a concurrency window that cannot open.
//
// NOTE ON RATE LIMITS: the guest submits here sit behind the shared `abuseLimiter`,
// and each host built below performs two auth calls. Run the full suite with a
// generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// OPTIONAL, strictly-extra assertion only (same rationale as
// guest-admin-view.spec.js): a GLOBAL `transactions` row count catches a row
// written with a NULL `friend_id`, which no API surface can see. NO default path.
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

// The backend keeps exactly ONE live admin session, so a UI login through the form
// invalidates a token captured earlier. Blocks that mix API fixture-building with a
// UI login re-login first.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso7_${slug}`.slice(0, 30 - suffix.length) + suffix
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

async function makeCycle(label) {
  const name = `E2E GSO7 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
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

async function submitGuest(linkToken, items, identity) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: identity?.guest_name || 'Marek Kolega',
      guest_phone: identity?.guest_phone || '0901 234 567',
      guest_email: identity?.guest_email || 'marek@example.com',
      items,
    },
  })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function submitOwnOrder(host, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
  expect(put.status(), 'own cart').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, { headers: host.auth, data: {} })
  expect(submit.status(), 'own submit').toBe(200)
  return (await submit.json()).order
}

// ---- the endpoints under test -------------------------------------------------

async function distribution(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return (await res.json()).distribution
}

async function partyFor(cycleId, friendId) {
  const rows = await distribution(cycleId)
  return rows.find((r) => r.id === friendId)
}

function toggleGuestItem(itemId) {
  return admin(`/api/guest-order-items/${itemId}/packed`, { method: 'patch' })
}

function toggleOwnItem(itemId) {
  return admin(`/api/order-items/${itemId}/packed`, { method: 'patch' })
}

function packOrder(orderId) {
  return admin(`/api/orders/${orderId}/packed`, { method: 'patch' })
}

async function friendMoney(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  const detail = await res.json()
  // `balance` rides on the friend row of this payload, not at the top level.
  return { balance: detail.friend.balance, count: (detail.transactions || []).length }
}

// One host + open coffee cycle + TWO products + share link. `own` / `guests[].items`
// are quantities; each entry becomes its own line, on its own product — a second
// line of the same product+variant is not guaranteed to stay a separate row, and
// these tests count item rows.
async function scenario(label, { own = [], guests = [] } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label)
  const products = [
    await addProduct(cycle.id, { name: `GSO7 ${label} A ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 }),
    await addProduct(cycle.id, { name: `GSO7 ${label} B ${uniq}`, purpose: 'Filter', roast_type: 'Tmavé', price_250g: 12, price_1kg: 36 }),
  ]
  const lines = (quantities) => quantities.map((quantity, i) => ({
    product_id: products[i % products.length].id, variant: '250g', quantity,
  }))
  const link = await shareLink(host, cycle.id)

  let ownOrder = null
  if (own.length > 0) {
    ownOrder = await submitOwnOrder(host, cycle.id, lines(own))
  }

  const subOrders = []
  for (const guest of guests) {
    const created = await submitGuest(link.token, lines(guest.items), { guest_name: guest.name, guest_phone: '0901 234 567' })
    subOrders.push(created.order)
  }

  return { host, cycle, products, link, ownOrder, subOrders }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await refreshAdminToken()
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('PATCH /api/guest-order-items/:id/packed — the per-bag checkbox (UC-GSO-011)', () => {
  test('toggling a guest item persists and survives a reload', async () => {
    const { host, cycle } = await scenario('persist', {
      own: [1],
      guests: [{ name: `Marek ${uniq}`, items: [1, 2] }],
    })

    let party = await partyFor(cycle.id, host.id)
    expect(party, 'the host is listed as the pickup party').toBeTruthy()
    expect(party.guest_orders.length, 'the sub-order hangs off the host').toBe(1)
    const guestItems = party.guest_orders[0].items
    expect(guestItems.length).toBe(2)
    expect(guestItems[0].packed, 'a guest item starts unpacked').toBeFalsy()

    const patch = await toggleGuestItem(guestItems[0].id)
    expect(patch.status()).toBe(200)
    const body = await patch.json()
    expect(body.packed).toBe(1)

    // Re-read the payload — this is durable state, not a frontend ref.
    party = await partyFor(cycle.id, host.id)
    const again = party.guest_orders[0].items.find((i) => i.id === guestItems[0].id)
    expect(again.packed, 'guest packed state survives a reload').toBe(1)
    expect(party.guest_orders[0].items.find((i) => i.id === guestItems[1].id).packed, 'only the tapped item moved').toBeFalsy()

    // And it toggles back off.
    const off = await toggleGuestItem(guestItems[0].id)
    expect(off.status()).toBe(200)
    expect((await off.json()).packed).toBe(0)
    party = await partyFor(cycle.id, host.id)
    expect(party.guest_orders[0].items.find((i) => i.id === guestItems[0].id).packed).toBe(0)
  })

  test('the guest payload carries what a bag label needs (product, variant, roast, per-guest grouping)', async () => {
    const { host, cycle } = await scenario('shape', {
      own: [1],
      guests: [
        { name: `Anna ${uniq}`, items: [1] },
        { name: `Boris ${uniq}`, items: [2] },
      ],
    })

    const party = await partyFor(cycle.id, host.id)
    expect(party.has_own_order, 'the host ordered for themselves too').toBe(true)
    expect(party.guest_orders.length, 'one group per guest — bags are pre-separated').toBe(2)
    const names = party.guest_orders.map((g) => g.guest_name).sort()
    expect(names).toEqual([`Anna ${uniq}`, `Boris ${uniq}`])

    const item = party.guest_orders[0].items[0]
    for (const field of ['id', 'product_name', 'variant', 'quantity', 'packed', 'purpose', 'roast_type']) {
      expect(item, `guest item must carry ${field}`).toHaveProperty(field)
    }
    // The guest's private status URL is never published to an admin surface (GSO-T2).
    expect(party.guest_orders[0].order_token).toBeUndefined()
  })

  test('a cancelled sub-order is not a bag: it is absent from the distribution payload', async () => {
    const { host, cycle, subOrders } = await scenario('cancelled', {
      own: [1],
      guests: [
        { name: `Zive ${uniq}`, items: [1] },
        { name: `Zrusene ${uniq}`, items: [1] },
      ],
    })

    const del = await ctx.delete(`/api/guest-orders/${subOrders[1].id}`, { headers: host.auth })
    expect(del.status(), 'host soft-cancels the second sub-order').toBe(200)

    const party = await partyFor(cycle.id, host.id)
    expect(party.guest_orders.length, 'the cancelled bag is gone from distribution').toBe(1)
    expect(party.guest_orders[0].guest_name).toBe(`Zive ${uniq}`)
  })

  test('a cancelled sub-order\'s items cannot be checked off', async () => {
    const { host, cycle, subOrders } = await scenario('cancelitem', {
      own: [1],
      guests: [{ name: `Storno ${uniq}`, items: [1] }],
    })

    const before = await partyFor(cycle.id, host.id)
    const itemId = before.guest_orders[0].items[0].id

    expect((await ctx.delete(`/api/guest-orders/${subOrders[0].id}`, { headers: host.auth })).status()).toBe(200)

    const blocked = await toggleGuestItem(itemId)
    expect(blocked.status(), 'there is nothing to hand over on a cancelled sub-order').toBe(400)
  })

  test('an unknown guest item is 404', async () => {
    const res = await toggleGuestItem(99999999)
    expect(res.status()).toBe(404)
  })

  test('anonymous cannot toggle a guest item (401)', async () => {
    const res = await ctx.patch('/api/guest-order-items/1/packed')
    expect(res.status(), 'the endpoint is requireAdmin').toBe(401)
  })
})

test.describe('The whole-order gate now counts guest items (Decision 3)', () => {
  test('all own items checked but a guest item unchecked → 409; checking it → 200', async () => {
    const { host, cycle, ownOrder } = await scenario('gate', {
      own: [1, 2],
      guests: [{ name: `Kolega ${uniq}`, items: [1] }],
    })

    const party = await partyFor(cycle.id, host.id)
    expect(party.items.length, 'two own lines').toBe(2)
    for (const item of party.items) {
      expect((await toggleOwnItem(item.id)).status()).toBe(200)
    }

    // Every FRIEND item is checked — under GSO-T1's rule this would already pack.
    const blocked = await packOrder(ownOrder.id)
    expect(blocked.status(), 'the guest bag is still unpacked, so packing is refused').toBe(409)

    const guestItem = party.guest_orders[0].items[0]
    expect((await toggleGuestItem(guestItem.id)).status()).toBe(200)

    const ok = await packOrder(ownOrder.id)
    expect(ok.status(), 'with the guest bag checked too, the order packs').toBe(200)
    expect((await ok.json()).packed).toBe(1)
  })

  test('a cancelled sub-order does not block the gate', async () => {
    const { host, cycle, ownOrder, subOrders } = await scenario('gatecancel', {
      own: [1],
      guests: [
        { name: `Ostava ${uniq}`, items: [1] },
        { name: `Odchadza ${uniq}`, items: [1, 1] },
      ],
    })

    expect((await ctx.delete(`/api/guest-orders/${subOrders[1].id}`, { headers: host.auth })).status()).toBe(200)

    const party = await partyFor(cycle.id, host.id)
    for (const item of party.items) {
      expect((await toggleOwnItem(item.id)).status()).toBe(200)
    }
    for (const guest of party.guest_orders) {
      for (const item of guest.items) {
        expect((await toggleGuestItem(item.id)).status()).toBe(200)
      }
    }

    const ok = await packOrder(ownOrder.id)
    expect(ok.status(), 'the cancelled sub-order\'s kept item rows must not block packing').toBe(200)
  })

  test('an order whose only unchecked item is a guest one stays unpacked after the reload', async () => {
    const { host, cycle, ownOrder } = await scenario('nopack', {
      own: [1],
      guests: [{ name: `Cakajuci ${uniq}`, items: [1] }],
    })

    const party = await partyFor(cycle.id, host.id)
    expect((await toggleOwnItem(party.items[0].id)).status()).toBe(200)
    expect((await packOrder(ownOrder.id)).status()).toBe(409)

    const after = await partyFor(cycle.id, host.id)
    expect(after.packed, 'a refused pack leaves no partial state behind').toBeFalsy()
  })
})

test.describe('Money: a guest checkbox posts nothing, an auto-unpack still reverses the host\'s charge', () => {
  test('toggling guest items writes NO transactions row and moves no balance', async () => {
    const { host, cycle } = await scenario('notx', {
      own: [1],
      guests: [{ name: `Bezucet ${uniq}`, items: [1, 1] }],
    })

    const before = await friendMoney(host.id)
    const globalBefore = transactionCountFromDb()

    const party = await partyFor(cycle.id, host.id)
    for (const item of party.guest_orders[0].items) {
      expect((await toggleGuestItem(item.id)).status()).toBe(200)
      expect((await toggleGuestItem(item.id)).status()).toBe(200)
    }

    const after = await friendMoney(host.id)
    expect(after.count, 'no transaction was written for a guest bag').toBe(before.count)
    expect(after.balance, 'the host\'s balance did not move').toBeCloseTo(before.balance, 2)

    if (globalBefore !== null) {
      expect(transactionCountFromDb(), 'not even a NULL-friend_id row').toBe(globalBefore)
    }
  })

  test('unchecking a guest item on a packed order auto-unpacks it and the balance nets to zero', async () => {
    const { host, cycle, ownOrder } = await scenario('unpack', {
      own: [2],
      guests: [{ name: `Spustac ${uniq}`, items: [1] }],
    })

    const start = await friendMoney(host.id)

    const party = await partyFor(cycle.id, host.id)
    for (const item of party.items) expect((await toggleOwnItem(item.id)).status()).toBe(200)
    const guestItem = party.guest_orders[0].items[0]
    expect((await toggleGuestItem(guestItem.id)).status()).toBe(200)

    const packed = await packOrder(ownOrder.id)
    expect(packed.status()).toBe(200)
    const packedBody = await packed.json()
    expect(packedBody.packed).toBe(1)

    // Packing charges the host for their OWN order only (the guests pay the admin
    // directly — Decision 1), so the balance drops by exactly the own total.
    const charged = await friendMoney(host.id)
    expect(charged.count, 'the charge row').toBe(start.count + 1)
    expect(charged.balance).toBeCloseTo(start.balance - ownOrder.total, 2)

    // Unchecking a GUEST item un-packs the host's order — and posts the reversal of
    // the host's own total, exactly as the whole-order toggle would.
    const uncheck = await toggleGuestItem(guestItem.id)
    expect(uncheck.status()).toBe(200)
    expect((await uncheck.json()).order_packed, 'the order is no longer packed').toBe(0)

    const reversed = await friendMoney(host.id)
    expect(reversed.count, 'the reversal row').toBe(start.count + 2)
    expect(reversed.balance, 'the balance nets back to where it started').toBeCloseTo(start.balance, 2)

    const party2 = await partyFor(cycle.id, host.id)
    expect(party2.packed, 'and the payload agrees').toBeFalsy()
    expect(party2.items.every((i) => i.packed), 'own checkboxes are untouched by the auto-unpack').toBe(true)
  })
})

test.describe('A host with guest bags but no own order (§Edge Cases)', () => {
  test('is still listed as the pickup party, with the guest bags and no whole-order flag', async () => {
    const { host, cycle } = await scenario('noown', {
      guests: [
        { name: `Samotar A ${uniq}`, items: [1] },
        { name: `Samotar B ${uniq}`, items: [2] },
      ],
    })

    const party = await partyFor(cycle.id, host.id)
    expect(party, 'a host whose only stake is guest bags must not vanish').toBeTruthy()
    expect(party.name).toBe(host.name)
    expect(party.order_id, 'there is no orders row to hang a packed flag on').toBeNull()
    expect(party.has_own_order).toBe(false)
    expect(party.items, 'no own items').toEqual([])
    expect(party.guest_orders.length).toBe(2)
    expect(party.guest_orders.flatMap((g) => g.items).length).toBe(2)

    // The packing record for such a host IS the per-bag checkboxes — and they work.
    for (const guest of party.guest_orders) {
      for (const item of guest.items) {
        expect((await toggleGuestItem(item.id)).status()).toBe(200)
        // No orders row, so nothing to report a whole-order flag from.
      }
    }
    const packedParty = await partyFor(cycle.id, host.id)
    expect(packedParty.guest_orders.flatMap((g) => g.items).every((i) => i.packed), 'every bag checked off').toBe(true)
    expect(packedParty.packed, 'the synthesised row never claims to be packed').toBeFalsy()
  })

  test('a host whose own order is still a DRAFT is listed the same way (a draft is not packable)', async () => {
    const { host, cycle, products } = await scenario('draft', {
      guests: [{ name: `Nedokoncene ${uniq}`, items: [1] }],
    })
    // A cart the host never submitted. Distribution only shows submitted orders, so
    // there must be no own items on the row — and no whole-order flag either, since
    // the whole-order endpoint refuses a draft (GSO-T1's `status = 'submitted'` rule).
    const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: products[0].id, variant: '250g', quantity: 1 }] },
    })
    expect(put.status(), 'draft cart').toBe(200)

    const party = await partyFor(cycle.id, host.id)
    expect(party, 'the guest bags still make them the pickup party').toBeTruthy()
    expect(party.has_own_order).toBe(false)
    expect(party.items, 'a draft cart is not part of the distribution').toEqual([])
    expect(party.guest_orders.length).toBe(1)
    expect((await toggleGuestItem(party.guest_orders[0].items[0].id)).status()).toBe(200)
  })

  test('a host with only a CANCELLED sub-order and no own order is not a pickup party at all', async () => {
    const { host, cycle, subOrders } = await scenario('noownkill', {
      guests: [{ name: `Nakoniec nie ${uniq}`, items: [1] }],
    })

    expect((await ctx.delete(`/api/guest-orders/${subOrders[0].id}`, { headers: host.auth })).status()).toBe(200)

    const party = await partyFor(cycle.id, host.id)
    expect(party, 'nothing to hand over, nothing to list').toBeFalsy()
  })
})

test.describe('Regression: a friend order with no guest sub-orders is unaffected (UC-GSO-012)', () => {
  test('gate still counts own items only and packs once they are checked', async () => {
    const { host, cycle, ownOrder } = await scenario('plain', { own: [1, 1] })

    const party = await partyFor(cycle.id, host.id)
    expect(party.guest_orders, 'always an array, even with no guests').toEqual([])
    expect(party.has_own_order).toBe(true)

    expect((await toggleOwnItem(party.items[0].id)).status()).toBe(200)
    expect((await packOrder(ownOrder.id)).status(), 'one item still unchecked').toBe(409)
    expect((await toggleOwnItem(party.items[1].id)).status()).toBe(200)
    expect((await packOrder(ownOrder.id)).status()).toBe(200)
  })
})

// ---- UI ----------------------------------------------------------------------
//
// The Distribution page: guest bags grouped per guest under their host with the
// violet "Hosť • <name>" badge, per-item taps persisting, and "Zabaliť" disabled
// until EVERY own + guest checkbox is checked (matching the server's 409).
test.describe('Distribution page — guest bags under the host (UI)', () => {
  let cycleId
  let hostName
  let guestOneName
  let guestTwoName
  let soloHostName
  let soloGuestName

  test.beforeAll(async () => {
    await refreshAdminToken()

    const host = await makeHost('ui')
    const cycle = await makeCycle('ui')
    cycleId = cycle.id
    hostName = host.name
    guestOneName = `Alica ${uniq}`
    guestTwoName = `Bohus ${uniq}`

    const product = await addProduct(cycleId, {
      name: `GSO7 UI Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30,
    })
    const link = await shareLink(host, cycleId)

    await submitOwnOrder(host, cycleId, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], { guest_name: guestOneName, guest_phone: '0901 234 567' })
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], { guest_name: guestTwoName, guest_phone: '0901 234 568' })

    // A second party in the same cycle: a host with bags but no own order.
    const solo = await makeHost('uisolo')
    soloHostName = solo.name
    soloGuestName = `Cyril ${uniq}`
    const soloLink = await shareLink(solo, cycleId)
    await submitGuest(soloLink.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], { guest_name: soloGuestName, guest_phone: '0901 234 569' })
  })

  test('guest bags render per guest, taps persist, and Zabaliť waits for every checkbox', async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await page.goto(`/admin/cycle/${cycleId}/distribution`)

    const card = (name) => page.locator('div.p-4', { has: page.getByRole('heading', { name, exact: true }) })
    await expect(card(hostName)).toBeVisible()

    // One group per guest, each labelled with the violet guest badge.
    await expect(card(hostName).getByText(`Hosť • ${guestOneName}`)).toBeVisible()
    await expect(card(hostName).getByText(`Hosť • ${guestTwoName}`)).toBeVisible()

    const rows = () => card(hostName).locator('div.cursor-pointer')
    // 1 own item + 1 + 1 guest items.
    await expect(rows()).toHaveCount(3)

    // Nothing checked → the whole-order toggle is disabled.
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeDisabled()

    // Check the OWN item only: the guest bags still hold the gate closed.
    const ownRow = card(hostName).locator('[data-owner="own"]')
    await expect(ownRow).toHaveCount(1)
    await ownRow.click()
    await expect(ownRow.locator('input[type="checkbox"]')).toBeChecked()
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeDisabled()

    // Rapid taps on the two guest bags must not be dropped: the in-flight guard is
    // per item, not one shared lock (the GSO-T1 finding).
    const guestRows = card(hostName).locator('[data-owner="guest"]')
    await expect(guestRows).toHaveCount(2)
    await page.route('**/api/guest-order-items/*/packed', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.continue()
    })
    await guestRows.nth(0).click()
    await guestRows.nth(1).click()
    await expect(guestRows.nth(0).locator('input[type="checkbox"]')).toBeChecked()
    await expect(guestRows.nth(1).locator('input[type="checkbox"]')).toBeChecked()
    await page.unroute('**/api/guest-order-items/*/packed')

    // Everything checked → the gate opens.
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeEnabled()

    // Uncheck one guest bag and reload: the persisted state is what comes back.
    await guestRows.nth(1).click()
    await expect(guestRows.nth(1).locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeDisabled()

    await page.reload()
    await expect(card(hostName).locator('[data-owner="own"]').locator('input[type="checkbox"]')).toBeChecked()
    const afterReload = card(hostName).locator('[data-owner="guest"]')
    await expect(afterReload.nth(0).locator('input[type="checkbox"]')).toBeChecked()
    await expect(afterReload.nth(1).locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeDisabled()

    // Check it again and pack through the UI.
    await afterReload.nth(1).click()
    await expect(card(hostName).getByRole('button', { name: 'Zabaliť' })).toBeEnabled()
    await card(hostName).getByRole('button', { name: 'Zabaliť' }).click()
    await expect(card(hostName).getByRole('button', { name: 'Zabalené' })).toBeVisible()
  })

  test('a host with no own order is shown as the pickup party and offers no Zabaliť', async ({ page }) => {
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await page.goto(`/admin/cycle/${cycleId}/distribution`)

    const card = page.locator('div.p-4', { has: page.getByRole('heading', { name: soloHostName, exact: true }) })
    await expect(card).toBeVisible()
    await expect(card.getByText(`Hosť • ${soloGuestName}`)).toBeVisible()
    await expect(card.getByText('Bez vlastnej objednávky')).toBeVisible()

    // No orders row exists, so there is no whole-order flag to write.
    await expect(card.getByRole('button', { name: 'Zabaliť' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Zabalené' })).toHaveCount(0)

    // The bag checkbox is the packing record here, and it persists.
    const guestRow = card.locator('[data-owner="guest"]')
    await expect(guestRow).toHaveCount(1)
    await guestRow.click()
    await expect(guestRow.locator('input[type="checkbox"]')).toBeChecked()
    await page.reload()
    const reloaded = page
      .locator('div.p-4', { has: page.getByRole('heading', { name: soloHostName, exact: true }) })
      .locator('[data-owner="guest"]')
    await expect(reloaded.locator('input[type="checkbox"]')).toBeChecked()
  })
})

// ---- The id-collision case the own:/guest: key prefix exists for -----------------
//
// `order_items.id` and `guest_order_items.id` are independent AUTOINCREMENT
// sequences, so in any normal run they never collide — which means the "rapid taps
// on two bags" UI test above (distinct ids) cannot exercise the bug the implementer
// fixed by prefixing `pendingItems` / `itemKey` with `own:` / `guest:`. Proving the
// fix requires an ACTUAL numeric-id collision, which only a direct DB write can
// manufacture. This is why the test requires DB_PATH (self-skips without it) rather
// than being gated as merely "extra" like the other DB_PATH assertions in this
// suite — there is no way to build the scenario through the API.
//
// Verified against the buggy prior key (bare `item.id`, no kind prefix) with a
// temporary revert: it fails here (the guest row's tap gets silently swallowed by
// the pending-guard because `pendingItems[key]` was already set by the own row's
// in-flight request sharing the same collided key), and passes on the real
// `own:`/`guest:` keying.
test.describe('The own:/guest: key prefix (a manufactured id collision)', () => {
  test('an own item and a guest item sharing the same numeric id do not cross-affect each other', async ({ page }) => {
    test.skip(!DB_PATH, 'requires DB_PATH for a direct write to force the collision')

    await refreshAdminToken()
    const host = await makeHost('idcol')
    const cycle = await makeCycle('idcol')
    const product = await addProduct(cycle.id, { name: `GSO7 idcol ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé', price_250g: 10, price_1kg: 30 })
    const link = await shareLink(host, cycle.id)

    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], { guest_name: `IdColGuest ${uniq}` })

    const before = await partyFor(cycle.id, host.id)
    const ownItemId = before.items[0].id
    const guestItemBeforeId = before.guest_orders[0].items[0].id
    expect(ownItemId, 'sanity: the two sequences did not collide on their own').not.toBe(guestItemBeforeId)

    // Force the collision: rewrite the guest item's row id to the own item's id.
    // guest_order_items.id is not referenced as a foreign key anywhere else, so
    // rewriting the PRIMARY KEY is safe — nothing else points at this row by id.
    const db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA busy_timeout = 5000')
    // Guard against a stale row from an earlier run of this same test occupying the
    // target id in a long-lived scratch DB (this suite's own fixtures only, never a
    // real environment's data — every row here was created by makeHost()/uniq above).
    db.prepare('DELETE FROM guest_order_items WHERE id = ? AND id <> ?').run(ownItemId, guestItemBeforeId)
    db.prepare('UPDATE guest_order_items SET id = ? WHERE id = ?').run(ownItemId, guestItemBeforeId)
    db.close()

    const after = await partyFor(cycle.id, host.id)
    const guestItemId = after.guest_orders[0].items[0].id
    expect(guestItemId, 'the forced collision took').toBe(ownItemId)

    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)
    await page.goto(`/admin/cycle/${cycle.id}/distribution`)

    const card = page.locator('div.p-4', { has: page.getByRole('heading', { name: host.name, exact: true }) })
    await expect(card).toBeVisible()
    const ownRow = card.locator('[data-owner="own"]')
    const guestRow = card.locator('[data-owner="guest"]')
    await expect(ownRow).toHaveCount(1)
    await expect(guestRow).toHaveCount(1)

    // Delay both PATCHes so both same-id rows are in flight at once.
    await page.route('**/api/order-items/*/packed', async (route) => {
      await new Promise((r) => setTimeout(r, 400))
      await route.continue()
    })
    await page.route('**/api/guest-order-items/*/packed', async (route) => {
      await new Promise((r) => setTimeout(r, 400))
      await route.continue()
    })
    await ownRow.click()
    await guestRow.click()
    await expect(ownRow).toHaveAttribute('aria-busy', 'true')
    await expect(guestRow).toHaveAttribute('aria-busy', 'true')
    await expect(ownRow.locator('input[type="checkbox"]')).toBeChecked()
    await expect(guestRow.locator('input[type="checkbox"]')).toBeChecked()
    await page.unroute('**/api/order-items/*/packed')
    await page.unroute('**/api/guest-order-items/*/packed')

    // Uncheck ONLY the guest row; the own row (same numeric id) must be untouched.
    await guestRow.click()
    await expect(guestRow.locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(ownRow.locator('input[type="checkbox"]')).toBeChecked()

    await page.reload()
    const ownRowReload = page.locator('div.p-4', { has: page.getByRole('heading', { name: host.name, exact: true }) }).locator('[data-owner="own"]')
    const guestRowReload = page.locator('div.p-4', { has: page.getByRole('heading', { name: host.name, exact: true }) }).locator('[data-owner="guest"]')
    await expect(ownRowReload.locator('input[type="checkbox"]')).toBeChecked()
    await expect(guestRowReload.locator('input[type="checkbox"]')).not.toBeChecked()
  })
})
