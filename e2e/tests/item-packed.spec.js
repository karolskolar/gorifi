import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD, FRIEND_NAME, CYCLE_NAME } from '../fixtures.js'

// GSO-T1: per-item Distribution packing checkboxes are now persisted
// (order_items.packed) and the whole-order "Zabaliť" toggle is gated on every
// item being checked. These are backend-level assertions — deterministic on
// whatever BASE_URL points at, against the standard seed (legacy auth mode).

test.describe('Order item packed — persistence & gating', () => {
  let token
  let orderId

  async function getFriendDistribution(request) {
    const res = await request.get(`/api/cycles/${cycleId}/distribution`, {
      headers: { 'X-Admin-Token': token },
    })
    expect(res.status()).toBe(200)
    const { distribution } = await res.json()
    return distribution.find((f) => f.order_id === orderId)
  }

  let cycleId

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login should succeed with seeded password').toBe(200)
    token = (await login.json()).token
    const admin = { 'X-Admin-Token': token }

    // Locate the seeded open cycle + friend.
    const cyclesRes = await request.get('/api/cycles', { headers: admin })
    cycleId = (await cyclesRes.json()).find((c) => c.name === CYCLE_NAME).id
    const friendsRes = await request.get('/api/friends', { headers: admin })
    const friendId = (await friendsRes.json()).find((f) => f.name === FRIEND_NAME).id

    // Two products so the gate has more than one item to check off.
    const p1 = await request.post('/api/products', {
      headers: admin,
      data: { cycle_id: cycleId, name: 'GSO-T1 Coffee A', purpose: 'Espresso', price_250g: 10, price_1kg: 30 },
    })
    const p2 = await request.post('/api/products', {
      headers: admin,
      data: { cycle_id: cycleId, name: 'GSO-T1 Coffee B', purpose: 'Filter', price_250g: 12, price_1kg: 36 },
    })
    const prod1 = await p1.json()
    const prod2 = await p2.json()

    // Fill + submit the friend's order (legacy shared password).
    const fp = { 'X-Friends-Password': FRIENDS_PASSWORD }
    const put = await request.put(`/api/orders/cycle/${cycleId}/friend/${friendId}`, {
      headers: fp,
      data: {
        items: [
          { product_id: prod1.id, variant: '250g', quantity: 1 },
          { product_id: prod2.id, variant: '250g', quantity: 2 },
        ],
      },
    })
    expect(put.status()).toBe(200)
    const submit = await request.post(`/api/orders/cycle/${cycleId}/friend/${friendId}/submit`, {
      headers: fp,
      data: {},
    })
    expect(submit.status()).toBe(200)
    orderId = (await submit.json()).order.id
  })

  test('checking an item persists across a reload', async ({ request }) => {
    const admin = { 'X-Admin-Token': token }

    const friend = await getFriendDistribution(request)
    expect(friend.items.length).toBe(2)
    const target = friend.items[0]
    expect(target.packed, 'item starts unpacked').toBeFalsy()

    const patch = await request.patch(`/api/order-items/${target.id}/packed`, { headers: admin })
    expect(patch.status()).toBe(200)
    expect((await patch.json()).packed).toBe(1)

    // Reload the distribution payload — the checkbox is still checked.
    const reloaded = await getFriendDistribution(request)
    const same = reloaded.items.find((i) => i.id === target.id)
    expect(same.packed, 'packed state survives a reload').toBe(1)

    // Reset for the next test.
    await request.patch(`/api/order-items/${target.id}/packed`, { headers: admin })
  })

  test('whole-order packed is gated on all items, and unchecking un-packs', async ({ request }) => {
    const admin = { 'X-Admin-Token': token }

    let friend = await getFriendDistribution(request)
    // Clean slate: uncheck anything left checked.
    for (const it of friend.items) {
      if (it.packed) await request.patch(`/api/order-items/${it.id}/packed`, { headers: admin })
    }

    // Check only the first item, then try to pack the whole order → 409.
    friend = await getFriendDistribution(request)
    await request.patch(`/api/order-items/${friend.items[0].id}/packed`, { headers: admin })
    const blocked = await request.patch(`/api/orders/${orderId}/packed`, { headers: admin })
    expect(blocked.status(), 'packing is rejected while an item is unchecked').toBe(409)

    // Check the remaining items → whole-order pack now succeeds.
    for (const it of friend.items.slice(1)) {
      await request.patch(`/api/order-items/${it.id}/packed`, { headers: admin })
    }
    const ok = await request.patch(`/api/orders/${orderId}/packed`, { headers: admin })
    expect(ok.status()).toBe(200)
    expect((await ok.json()).packed).toBe(1)

    // Unchecking any item now auto-un-packs the order.
    const uncheck = await request.patch(`/api/order-items/${friend.items[0].id}/packed`, { headers: admin })
    expect(uncheck.status()).toBe(200)
    expect((await uncheck.json()).order_packed).toBe(0)

    // Reset for suite hygiene.
    for (const it of friend.items.slice(1)) {
      await request.patch(`/api/order-items/${it.id}/packed`, { headers: admin })
    }
  })
})
