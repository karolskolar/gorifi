import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// SEC-S3: friend password minimum raised to 8. Admin reset-password (which sets
// a friend's password) must reject anything shorter.
test('admin reset-password rejects a friend password shorter than 8 characters', async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const adminToken = (await (await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })).json()).token

  const friend = await (await ctx.post('/api/friends', { headers: { 'X-Admin-Token': adminToken }, data: { name: `PwPolicy ${uniq}` } })).json()

  const tooShort = await ctx.put(`/api/friends/${friend.id}/reset-password`, {
    headers: { 'X-Admin-Token': adminToken }, data: { password: 'abc12' },
  })
  expect(tooShort.status(), '5-char friend password must be rejected').toBe(400)

  // A compliant password is accepted.
  const ok = await ctx.put(`/api/friends/${friend.id}/reset-password`, {
    headers: { 'X-Admin-Token': adminToken }, data: { password: 'goodPass1' },
  })
  expect(ok.status()).toBe(200)

  await ctx.dispose()
})
