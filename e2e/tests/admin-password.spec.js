import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// SEC-S1: admin password stored as bcrypt + minimum length raised to 10.
// (The legacy SHA-256 → bcrypt migration-on-login is verified separately at the
// integration level; here we assert the policy gate without mutating the shared
// admin password, so the rest of the suite is unaffected.)
test.describe('Admin password policy (SEC-S1)', () => {
  test('change-password rejects a new password shorter than 10 characters', async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status()).toBe(200)
    const { token } = await login.json()

    const res = await request.post('/api/admin/change-password', {
      headers: { 'X-Admin-Token': token },
      data: { currentPassword: ADMIN_PASSWORD, newPassword: 'short1' },
    })
    expect(res.status(), 'short new password must be rejected').toBe(400)

    // Rejection must not have changed anything — the original password still works.
    const reLogin = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(reLogin.status()).toBe(200)
  })
})
