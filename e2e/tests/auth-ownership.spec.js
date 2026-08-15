import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'

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
    // 11 §UC-FC-009 extended this route with phone/email — the ownership wall
    // must cover the new fields too, and the refusal must write NOTHING.
    const attack = await ctx.patch(`/api/friends/${b.id}/profile`, {
      ...authA,
      data: { name: 'hacked', phone: '0900666666', email: 'hacked@evil.test' },
    })
    expect(attack.status()).toBe(403)
    const bRow = (await (await admin('/api/friends')).json()).find((f) => f.id === b.id)
    expect(bRow.phone, 'cross-friend PATCH must not write phone').toBeNull()
    expect(bRow.email, 'cross-friend PATCH must not write email').toBeNull()
    // Own profile update still works — including the UC-FC-009 fields.
    const own = await ctx.patch(`/api/friends/${a.id}/profile`, {
      ...authA,
      data: { name: `Renamed ${uniq}`, phone: '0900777777', email: `own-${uniq}@example.test` },
    })
    expect(own.status()).toBe(200)
    expect((await own.json()).email).toBe(`own-${uniq}@example.test`)
  })

  // ⚠ The legacy shared-password window (auth_mode !== 'modern') deliberately
  // resolves NO friend identity, so `requireFriendOwner` lets any holder of the
  // shared password PATCH any friend's profile. 11 §UC-FC-009 adds a NARROWER
  // gate over the contact half only: module 09 resolves a recovery request by
  // `lower(trim(email))` with "exactly one active match", so an address planted
  // on a victim with none of their own would survive the flip to 'modern' and
  // become an account-takeover seam — a blast radius that outlives the window.
  // `name` keeps module 03's shipped behaviour, which is what makes this a gate
  // and not a re-authorization of the whole route.
  test('legacy shared-password auth may rename, but may NOT write phone/email', async () => {
    const victim = await makeFriendWithLogin('sp')
    const shared = { headers: { 'X-Friends-Password': FRIENDS_PASSWORD } }

    // Non-vacuity: with auth_mode 'modern' the 401s below would be
    // `requireFriendOwner`'s, and this test would prove nothing.
    const mode = (await (await ctx.get('/api/friends/auth-mode')).json()).authMode
    expect(mode, 'the seeded DB must be in the legacy window for this test to mean anything').not.toBe('modern')

    const planted = `planted-${uniq}@evil.test`
    const email = await ctx.patch(`/api/friends/${victim.id}/profile`, { ...shared, data: { email: planted } })
    expect(email.status(), 'shared-password email write').toBe(401)
    expect((await email.json()).error).toBe('Prihláste sa svojím menom a heslom')

    const phone = await ctx.patch(`/api/friends/${victim.id}/profile`, { ...shared, data: { phone: '0900666666' } })
    expect(phone.status(), 'shared-password phone write').toBe(401)

    // Clearing is a write too — the gate keys on the field being PRESENT.
    const clear = await ctx.patch(`/api/friends/${victim.id}/profile`, { ...shared, data: { email: null } })
    expect(clear.status(), 'shared-password email clear').toBe(401)

    // The name half is untouched by the gate (module 03 behaviour).
    const renamed = `Shared rename ${uniq}`
    const rename = await ctx.patch(`/api/friends/${victim.id}/profile`, { ...shared, data: { name: renamed } })
    expect(rename.status(), 'shared-password rename still allowed').toBe(200)

    const row = (await (await admin('/api/friends')).json()).find((f) => f.id === victim.id)
    expect(row.email, 'no address may be planted').toBeNull()
    expect(row.phone, 'no phone may be planted').toBeNull()
    expect(row.name, 'the rename half really ran (non-vacuity)').toBe(renamed)
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
