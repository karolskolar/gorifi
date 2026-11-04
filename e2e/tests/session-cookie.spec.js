// 2026-10-07 — the friend session survives a wiped localStorage.
//
// The PO had to log in again every few days although every server session was
// valid for 60 days: iOS Safari deletes a site's script-writable storage after 7
// days without a visit, and www./bare were two origins. Every login now also sets
// an HttpOnly, path-scoped cookie with the same token (`middleware/friend-auth.js`),
// `POST /api/friends/session/restore` answers it back, and `…/logout` ends it.
// The browser half below simulates the Safari wipe by clearing localStorage.
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'
import { expectLanding, expectNoLanding, logout } from '../helpers/portal.js'

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
let seq = 0
let ctx
let adminToken = ''
// FUP-T27 / WA-T12: the ONE admin request path (`helpers/admin.js makeAdmin`) — re-authenticates once on a 401
// and publishes the fresh token back into `adminToken` (was a private `adminReq` copy, §5 of admin-token-retry).
const adminReq = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status()).toBe(200)
  adminToken = (await login.json()).token
})
test.afterAll(async () => { await ctx?.dispose() })

/** A friend with a phone (no profile prompt) and a password that needs no forced change. */
async function makeFriend(label, { ackExplainer = true } = {}) {
  const username = `sc_${label.toLowerCase()}_${uniq}${++seq}`.slice(0, 30)
  const f = await (await adminReq('/api/friends', { method: 'post', data: { name: `Cookie ${label} ${uniq}`, phone: '0900 000 003' } })).json()
  expect((await adminReq(`/api/friends/${f.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await adminReq(`/api/friends/${f.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  // Clear the forced change with a throwaway context, so the friend's real password is set.
  const tmp = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const a = await (await tmp.post('/api/friends/auth', { data: { username, password: 'initPass1' } })).json()
  const ch = await tmp.put(`/api/friends/${f.id}/change-password`, {
    headers: { Authorization: `Bearer ${a.token}` }, data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
  })
  expect(ch.status()).toBe(200)
  if (ackExplainer) {
    const t = (await ch.json()).token
    await tmp.post(`/api/friends/${f.id}/explainer-seen`, { headers: { Authorization: `Bearer ${t}` } })
  }
  await tmp.dispose()
  return { id: f.id, username, password: 'ownPass12' }
}

function cookieOf(res) {
  const raw = res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value)
  return raw.find((v) => v.startsWith('pp_session=')) || null
}

test.describe('the cookie contract (API)', () => {
  test('a login sets the HttpOnly, path-scoped cookie with the SAME token and the session horizon', async () => {
    const f = await makeFriend('Attr')
    const c = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    const day = await c.post('/api/friends/auth', { data: { username: f.username, password: f.password } })
    expect(day.status()).toBe(200)
    const body = await day.json()
    const cookie = cookieOf(day)
    expect(cookie, 'Set-Cookie pp_session').toBeTruthy()
    expect(cookie).toContain(`pp_session=${body.token};`)
    expect(cookie).toMatch(/; Path=\/api\/friends\/session;/)
    expect(cookie).toMatch(/; HttpOnly/)
    expect(cookie).toMatch(/; Secure/)
    expect(cookie).toMatch(/; SameSite=Lax/)
    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1])
    expect(maxAge, 'no remember ⇒ the 24 h horizon').toBeGreaterThan(86000)
    expect(maxAge).toBeLessThanOrEqual(86400)

    const remembered = await c.post('/api/friends/auth', { data: { username: f.username, password: f.password, remember: true } })
    const maxAge60 = Number(cookieOf(remembered).match(/Max-Age=(\d+)/)[1])
    expect(maxAge60, 'remember ⇒ 60 days').toBeGreaterThan(59 * 86400)
    await c.dispose()
  })

  test('restore answers the cookie\'s session back; no cookie / logged out ⇒ 401', async () => {
    const f = await makeFriend('Restore')
    const c = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    const login = await (await c.post('/api/friends/auth', { data: { username: f.username, password: f.password, remember: true } })).json()

    const r = await c.post('/api/friends/session/restore')
    expect(r.status()).toBe(200)
    expect(r.headers()['cache-control']).toBe('no-store')
    const restored = await r.json()
    expect(restored.token, 'the SAME token — restoring mints nothing').toBe(login.token)
    expect(restored.friend).toEqual({ id: f.id, name: expect.any(String), uid: expect.any(String) })
    expect(restored.expiresAt).toBe(login.expiresAt)
    expect(Object.keys(restored).sort(), 'a restore is not a login: no explainer / forced-change fields')
      .toEqual(['expiresAt', 'friend', 'token'])

    // No cookie at all.
    const bare = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    expect((await bare.post('/api/friends/session/restore')).status()).toBe(401)
    await bare.dispose()

    // Logout ends the SESSION, not just the cookie: the Bearer token dies too.
    const out = await c.post('/api/friends/session/logout')
    expect(out.status()).toBe(200)
    expect(cookieOf(out)).toMatch(/Max-Age=0/)
    expect((await c.post('/api/friends/session/restore')).status()).toBe(401)
    const balance = await c.get(`/api/friends/${f.id}/balance`, { headers: { Authorization: `Bearer ${login.token}` } })
    expect(balance.status(), 'the logged-out token authenticates nothing').toBe(401)
    await c.dispose()
  })

  test('a forged / malformed cookie is the same 401', async () => {
    const c = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
    for (const v of ['0'.repeat(64), 'abc', `${'a'.repeat(64)}; x=1`]) {
      const r = await c.post('/api/friends/session/restore', { headers: { Cookie: `pp_session=${v}` } })
      expect(r.status(), v).toBe(401)
    }
    await c.dispose()
  })
})

test.describe('the browser: a wiped localStorage is restored, not logged out', () => {
  test('login → localStorage wiped (the Safari 7-day cap) → reload lands on the portal', async ({ page }) => {
    const f = await makeFriend('Wipe')
    // Log in through the page's own request context — it shares the browser's cookie jar.
    const res = await page.request.post('/api/friends/auth', { data: { username: f.username, password: f.password, remember: true } })
    expect(res.status()).toBe(200)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expectLanding(page)
    await expect(page).toHaveURL(/\/$/)
    // …and the restored payload was written back for the next load.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gorifi_friend_auth') || 'null'))
    expect(stored?.friendId).toBe(f.id)
  })

  test('⚠ a cookie restore is NOT a login: an unacknowledged explainer does not open', async ({ page }) => {
    const f = await makeFriend('NotLogin', { ackExplainer: false })
    expect((await page.request.post('/api/friends/auth', { data: { username: f.username, password: f.password } })).status()).toBe(200)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expectLanding(page)
    await expect(page, 'restored straight onto the current state').toHaveURL(/\/$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('logout clears the cookie: a reload afterwards shows the login card', async ({ page }) => {
    const f = await makeFriend('Out')
    expect((await page.request.post('/api/friends/auth', { data: { username: f.username, password: f.password, remember: true } })).status()).toBe(200)
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await expectLanding(page)
    await logout(page)
    await expect.poll(async () => (await page.context().cookies()).filter((c) => c.name === 'pp_session').length,
      { message: 'the server cleared the cookie' }).toBe(0)
    await page.reload()
    await expectNoLanding(page)
  })
})
