import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// Phase 2 (SEC-A2/A3): friend-vs-friend object-level ownership + the forced
// password change after an admin reset (#3). Token-authenticated, deterministic.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken, ...(opts.headers || {}) },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// Create a friend with a known username + password (via admin), then log in and
// clear the forced-change flag so we get a clean, usable session token.
async function makeFriendWithLogin(label) {
  const username = `e2e_${label}_${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name: `E2E ${label} ${uniq}` } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  // Login — reset sets must_change, so this login reports mustChangePassword.
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status()).toBe(200)
  const body = await login.json()
  expect(body.mustChangePassword, 'reset should force a change').toBe(true)

  // Clear the forced flag by choosing a new password (backend skips current-pw check).
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, username, token }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('Friend object-level ownership (IDOR)', () => {
  test('a friend token cannot read another friend\'s balance / transactions / subscriptions', async () => {
    const a = await makeFriendWithLogin('a')
    const b = await makeFriendWithLogin('b')
    const authA = { headers: { Authorization: `Bearer ${a.token}` } }

    // A reading A's own data → allowed.
    expect((await ctx.get(`/api/friends/${a.id}/balance`, authA)).status(), 'own balance').toBe(200)
    expect((await ctx.get(`/api/transactions/friend/${a.id}`, authA)).status(), 'own tx').toBe(200)
    expect((await ctx.get(`/api/subscriptions/friend/${a.id}`, authA)).status(), 'own subs').toBe(200)

    // A reading B's data → forbidden.
    expect((await ctx.get(`/api/friends/${b.id}/balance`, authA)).status(), 'other balance blocked').toBe(403)
    expect((await ctx.get(`/api/transactions/friend/${b.id}`, authA)).status(), 'other tx blocked').toBe(403)
    expect((await ctx.get(`/api/subscriptions/friend/${b.id}`, authA)).status(), 'other subs blocked').toBe(403)
  })

  test('a friend token cannot modify another friend\'s subscriptions or profile', async () => {
    const a = await makeFriendWithLogin('c')
    const b = await makeFriendWithLogin('d')
    const authA = { headers: { Authorization: `Bearer ${a.token}` } }

    expect((await ctx.put(`/api/subscriptions/friend/${b.id}`, { ...authA, data: { types: ['coffee'] } })).status()).toBe(403)
    expect((await ctx.patch(`/api/friends/${b.id}/profile`, { ...authA, data: { name: 'hacked' } })).status()).toBe(403)
    // Own profile update still works.
    expect((await ctx.patch(`/api/friends/${a.id}/profile`, { ...authA, data: { name: `Renamed ${uniq}` } })).status()).toBe(200)
  })
})

test.describe('Forced password change after admin reset (#3)', () => {
  test('reset flags must-change; a fresh password clears it', async () => {
    const username = `e2e_reset_${uniq}`
    const created = await admin('/api/friends', { method: 'post', data: { name: `E2E reset ${uniq}` } })
    const friend = await created.json()
    await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })
    await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'temp1234' } })

    // First login after reset → must change.
    let login = await ctx.post('/api/friends/auth', { data: { username, password: 'temp1234' } })
    expect((await login.json()).mustChangePassword).toBe(true)
    const token = (await (await ctx.post('/api/friends/auth', { data: { username, password: 'temp1234' } })).json()).token

    // Set a new password (forced flow — no current password needed).
    const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { currentPassword: '', newPassword: 'myOwnPass9' },
    })
    expect(chg.status()).toBe(200)

    // Next login with the new password → no longer forced.
    login = await ctx.post('/api/friends/auth', { data: { username, password: 'myOwnPass9' } })
    const after = await login.json()
    expect(after.mustChangePassword).toBe(false)
    // Old temp password no longer works.
    expect((await ctx.post('/api/friends/auth', { data: { username, password: 'temp1234' } })).status()).toBe(401)
  })
})
