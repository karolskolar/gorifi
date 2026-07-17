import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// SEC-S2: identifiers use a CSPRNG and invite codes are lengthened to 8 chars.
// Randomness can't be asserted directly, but we verify a newly-created friend's
// invite code is 8 chars from the unambiguous alphabet via /invitations/my-code.
const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

test('a new friend gets an 8-character invite code from the unambiguous alphabet', async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token

  // Create a friend, give them credentials, log in to get a token.
  const friend = await (await ctx.post('/api/friends', { headers: { 'X-Admin-Token': adminToken }, data: { name: `InviteCode ${uniq}` } })).json()
  const username = `e2e_ic_${uniq}`
  await ctx.put(`/api/friends/${friend.id}/admin-username`, { headers: { 'X-Admin-Token': adminToken }, data: { username } })
  await ctx.put(`/api/friends/${friend.id}/reset-password`, { headers: { 'X-Admin-Token': adminToken }, data: { password: 'initPass1' } })
  const login = await (await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })).json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${login.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  const token = (await chg.json()).token || login.token

  // Read the friend's own invite code.
  const res = await ctx.get(`/api/invitations/my-code?friendId=${friend.id}`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status()).toBe(200)
  const { inviteCode } = await res.json()
  expect(inviteCode, 'invite code length').toHaveLength(8)
  expect(inviteCode).toMatch(ALPHABET)

  await ctx.dispose()
})
