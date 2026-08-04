import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// API-level assertions for Phase 1: server-side admin authorization, no
// credential leakage, CORS lockdown. These are deterministic and are the
// strongest evidence the security fixes hold on whatever BASE_URL points at.

const ADMIN_ENDPOINTS = [
  { method: 'get', path: '/api/friends' },
  { method: 'get', path: '/api/cycles' },
  { method: 'get', path: '/api/friends/1/detail' },
  { method: 'get', path: '/api/admin/settings' },
  { method: 'get', path: '/api/bakery-products' },
  { method: 'get', path: '/api/analytics/live-cycle' },
  { method: 'get', path: '/api/analytics/coffee' },
  { method: 'get', path: '/api/onboarding-links' },
  { method: 'get', path: '/api/roasteries' },
  { method: 'get', path: '/api/friend-groups' },
  { method: 'get', path: '/api/invitations' },
  { method: 'post', path: '/api/transactions/adjustment', data: { friend_id: 1, amount: 99999, note: 'e2e' } },
  { method: 'post', path: '/api/transactions/payment', data: { friend_id: 1, amount: 99999 } },
  { method: 'patch', path: '/api/orders/1/paid', data: { paid: true } },
  { method: 'patch', path: '/api/order-items/1/packed' },
  // GSO-T7: the guest half of the per-item Distribution checkbox.
  { method: 'patch', path: '/api/guest-order-items/1/packed' },
  // GSO-T6: the admin half of the MIXED-auth /api/guest-orders router (the host
  // half is gated by friend identity instead — see guest-host-view.spec.js).
  { method: 'patch', path: '/api/guest-orders/1/paid', data: { paid: true } },
  { method: 'get', path: '/api/guest-orders/cycle/1/unpaid' },
  { method: 'post', path: '/api/cycles', data: { name: 'evil' } },
]

const PUBLIC_ENDPOINTS = [
  '/api/health',
  '/api/friends/auth-mode',
  '/api/pickup-locations',
  '/api/admin/setup-status',
  '/api/admin/payment-settings',
]

test.describe('API security — admin authorization', () => {
  for (const ep of ADMIN_ENDPOINTS) {
    test(`${ep.method.toUpperCase()} ${ep.path} is rejected without an admin token (401)`, async ({ request }) => {
      const res = await request[ep.method](ep.path, ep.data ? { data: ep.data } : undefined)
      expect(res.status(), `${ep.path} must not be reachable anonymously`).toBe(401)
    })
  }

  for (const path of PUBLIC_ENDPOINTS) {
    test(`GET ${path} stays public (200)`, async ({ request }) => {
      const res = await request.get(path)
      expect(res.status(), `${path} should remain public`).toBe(200)
    })
  }

  test('a valid admin token unlocks admin endpoints', async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login should succeed with seeded password').toBe(200)
    const { token } = await login.json()
    expect(token).toBeTruthy()

    const res = await request.get('/api/friends', { headers: { 'X-Admin-Token': token } })
    expect(res.status()).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('a wrong admin token is rejected (401)', async ({ request }) => {
    const res = await request.get('/api/friends', { headers: { 'X-Admin-Token': 'not-a-real-token' } })
    expect(res.status()).toBe(401)
  })
})

// Friend-authenticated (non-admin) surfaces. They are NOT in ADMIN_ENDPOINTS
// because an admin token must not unlock them either: they need a per-friend
// session identity. Asserted separately so the two boundaries stay distinct.
const FRIEND_IDENTITY_ENDPOINTS = [
  { method: 'get', path: '/api/guest-links/cycle/1' },
  { method: 'post', path: '/api/guest-links/cycle/1' },
  { method: 'patch', path: '/api/guest-links/1' },
]

test.describe('API security — friend-identity authorization', () => {
  for (const ep of FRIEND_IDENTITY_ENDPOINTS) {
    test(`${ep.method.toUpperCase()} ${ep.path} needs a friend session (401 anonymously and with an admin token)`, async ({ request }) => {
      const anon = await request[ep.method](ep.path)
      expect(anon.status(), `${ep.path} must not be reachable anonymously`).toBe(401)

      const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
      const { token } = await login.json()
      const asAdmin = await request[ep.method](ep.path, { headers: { 'X-Admin-Token': token } })
      expect(asAdmin.status(), `${ep.path} is a friend surface, not an admin one`).toBe(401)
    })
  }
})

test.describe('API security — no credential leakage', () => {
  test('friend responses never expose access_token / password_hash / invite_code', async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    const { token } = await login.json()

    const res = await request.get('/api/friends', { headers: { 'X-Admin-Token': token } })
    expect(res.status()).toBe(200)
    const friends = await res.json()
    for (const f of friends) {
      expect(f, 'access_token must be stripped').not.toHaveProperty('access_token')
      expect(f, 'password_hash must be stripped').not.toHaveProperty('password_hash')
      expect(f, 'invite_code must be stripped').not.toHaveProperty('invite_code')
    }
  })
})

test.describe('API security — CORS lockdown', () => {
  test('a disallowed Origin is not reflected in Access-Control-Allow-Origin', async ({ baseURL }) => {
    // Use a bare context so no default headers interfere.
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.get(`${baseURL}/api/health`, { headers: { Origin: 'https://evil.example.com' } })
    const acao = res.headers()['access-control-allow-origin']
    expect(acao, 'evil origin must never be granted').not.toBe('https://evil.example.com')
    await ctx.dispose()
  })
})
