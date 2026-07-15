import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// SEC-A1: friend auth returns an expiresAt so the frontend can drop expired
// tokens on restore (and store token-only, never the plaintext password).
test('friend auth returns a token and a future expiresAt', async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token

  const friend = await (await ctx.post('/api/friends', { headers: { 'X-Admin-Token': adminToken }, data: { name: `Session ${uniq}` } })).json()
  const username = `e2e_sess_${uniq}`
  await ctx.put(`/api/friends/${friend.id}/admin-username`, { headers: { 'X-Admin-Token': adminToken }, data: { username } })
  await ctx.put(`/api/friends/${friend.id}/reset-password`, { headers: { 'X-Admin-Token': adminToken }, data: { password: 'initPass1' } })

  const res = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(typeof body.token, 'token is a string').toBe('string')
  expect(typeof body.expiresAt, 'expiresAt is a number').toBe('number')
  expect(body.expiresAt, 'expiresAt is in the future').toBeGreaterThan(Date.now())

  await ctx.dispose()
})
