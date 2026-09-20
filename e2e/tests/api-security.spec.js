import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'
// FUP-T19: the one destructive logout case runs on a THROWAWAY backend, so the gate's
// single app-wide admin token can never be left deleted for the next spec file.
import { CAN_SPAWN_BACKEND, startBackend } from '../mailgun-harness.js'

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
  // The admin's correction of a party's pickup point (PO decision, 2026-09-02, keyed
  // on (cycle, friend) since 2026-09-03). It writes `orders` — or `guest_order_links`
  // for a host with no own order — with NO cycle-open gate, by design, since the
  // correction is needed exactly when the cycle is locked. It can also clear a parcel
  // fee, so anonymous must never reach it.
  { method: 'patch', path: '/api/orders/cycle/1/friend/1/pickup', data: { pickup_location_id: 1 } },
  // GSO-T7: the guest half of the per-item Distribution checkbox.
  { method: 'patch', path: '/api/guest-order-items/1/packed' },
  // 16 §UC-DP-003 / §UC-DP-013 item 2 (DP-T2): the distribution read. ⚠ It has
  // ALWAYS been `requireAdmin` (routes/cycles.js, the `/:id/distribution` handler) —
  // what was missing until this row is the REGRESSION NET, not the guard. It is the
  // single richest admin payload in the app: every party's name and phone number,
  // every friend's balance, and every guest sub-order INCLUDING its `order_token`
  // (published through the shared `GUEST_ORDER_FIELDS` since GR-T1). A future edit
  // that dropped the guard would hand an anonymous caller a working guest credential
  // for every bag in the cycle, so it belongs in this sweep permanently.
  { method: 'get', path: '/api/cycles/1/distribution' },
  // GSO-T6: the admin half of the MIXED-auth /api/guest-orders router (the host
  // half is gated by friend identity instead — see guest-host-view.spec.js).
  { method: 'patch', path: '/api/guest-orders/1/paid', data: { paid: true } },
  { method: 'get', path: '/api/guest-orders/cycle/1/unpaid' },
  // 14 §UC-GR-005 / §UC-GR-010 item 1 (GR-T4): the admin soft-cancel of a guest
  // sub-order — the working target for the escalation the host's DELETE names. It
  // has NO paid blockade (D4), so it is strictly more powerful than the host route
  // on the same prefix and must never be reachable without an admin token.
  { method: 'post', path: '/api/guest-orders/1/cancel' },
  // 14 §UC-GR-004 / §UC-GR-010 item 1 (GR-T3): the admin half of the now-MIXED
  // /api/guest-links router — READ every host's share link for a cycle, CREATE one
  // for a friend who has not shared yet, and REGENERATE an existing one. ⚠ The three
  // HOST routes on the same prefix stay in `FRIEND_IDENTITY_ENDPOINTS` below — the
  // two sweeps must not be merged, because the mount is BARE and each route carries
  // its own guard.
  // ⚠ D3 AMENDED (PO decision, 2026-08-31): the admin regenerate below is new, and it
  // exists because the HOST's own regenerate now refuses while live colleague orders
  // exist (409 `reason:'has_orders'`) and the share dialog escalates to the admin.
  // The surviving half of D3 still holds: there is deliberately NO admin
  // deactivate/reactivate route to add here — `active` is host-only, and the
  // regenerate route writes `token` only.
  { method: 'get', path: '/api/guest-links/cycle/1/all' },
  { method: 'post', path: '/api/guest-links/cycle/1/host/1' },
  { method: 'post', path: '/api/guest-links/cycle/1/host/1/regenerate' },
  // 07 §UC-IA-008 item 1: the approval endpoint MINTS A LOGIN for a new friend, and
  // it lives on the MIXED /api/invitations mount (GET /code/:code and POST /register
  // are public), so its guard is per-route rather than on the mount. Anonymous must
  // never reach the handler.
  { method: 'post', path: '/api/invitations/1/approve', data: { username: 'evil.admin' } },
  // 11 §UC-FC-006 / §UC-FC-008 item 2: the admin unlink of a friend's Google link.
  // ⚠ `/api/friends` is a MIXED mount (friend auth, public login-list, admin), so the
  // guard is per-route. Deliberately a DIFFERENT path from module 10's friend-owned
  // `DELETE /api/friends/:id/google-link` — never multiplexed.
  { method: 'delete', path: '/api/friends/1/google' },
  // 10 §UC-GA-010 / §UC-GA-013 obligation 1: the admin Google ALLOWLIST — who may
  // enter the admin portal with Google. All three are `requireAdmin`.
  //
  // ⚠ The two Google LOGIN endpoints (`POST /api/friends/auth/google`,
  // `POST /api/admin/google-login`) are PUBLIC and must NEVER join this list — an
  // anonymous caller has to reach them, and asserting 401 on them would pin the
  // opposite of the contract. Their anonymous behaviour is pinned in
  // `google-auth.spec.js` by MESSAGE, which is what distinguishes "the handler
  // refused you" from "the guard did".
  //
  // ⚠ `/api/admin` is a MIXED mount, so these guards are per-route. SEVEN routes on it
  // carry no `requireAdmin`, and the enumeration is exhaustive on purpose (the
  // documentation-discipline rule: a list a reader will trust must name every member) —
  // verified against `backend/src/routes/admin.js`: `GET /setup-status` (:367),
  // `POST /setup` (:373), `POST /login` (:393), `POST /verify` (:423),
  // `POST /logout` (:480), `GET /payment-settings` (:503), `POST /google-login` (:333).
  // `POST /setup` is public but SELF-LIMITING — it 400s (`Admin uz je nastaveny`) once
  // `settings('admin_password')` exists, so on any live instance it is closed, which is
  // why it is not a hole and not in this sweep.
  //
  // ⚠ `POST /api/admin/logout` is one of those seven and is
  // ABSENT FROM THIS LIST BY DECISION, not by oversight (FUP-T19): it answers an
  // idempotent 200 to everyone and deletes the session row only for the holder of
  // the CURRENT token, so a 401 assertion here would pin the opposite of its
  // contract. Its effect-level invariants — anonymous and stale callers destroy
  // nothing — are pinned in the two `FUP-T19` describes at the bottom of this file,
  // and the reasoning is repeated at the route.
  { method: 'get', path: '/api/admin/google-allowlist' },
  { method: 'post', path: '/api/admin/google-allowlist', data: { id_token: 'TEST:evil:evil@example.test' } },
  { method: 'delete', path: '/api/admin/google-allowlist', data: { email: 'evil@example.test' } },
  { method: 'post', path: '/api/cycles', data: { name: 'evil' } },
  // 12 §UC-PC-011 item 1 (PC-T2): the catalog import trio. The mount is
  // whole-mount `requireAdmin` (`app.use('/api/coffee-products', requireAdmin,
  // …)`), but the sweep still pins each route individually — a later
  // restructure that un-wraps the mount must redden here.
  { method: 'post', path: '/api/coffee-products/import' },
  { method: 'post', path: '/api/coffee-products/import-gsheet', data: { url: 'https://docs.google.com/spreadsheets/d/x/edit' } },
  { method: 'post', path: '/api/coffee-products/import-gsheet-multirow', data: { url: 'https://docs.google.com/spreadsheets/d/x/edit' } },
  // 12 §UC-PC-006 (PC-T9, resolved decision 14): the manual assignment
  // workbench. The shipped POST /migrate is RETIRED (404) — its anonymous-401
  // row retired with it, in the same change (UC-PC-011 item 1).
  { method: 'get', path: '/api/coffee-products/migration/pending' },
  { method: 'post', path: '/api/coffee-products/migration/assign', data: { groups: [], catalog_id: 1 } },
  { method: 'post', path: '/api/coffee-products/migration/create', data: { groups: [] } },
  // PC-T13 (PM 2026-08-23): workbench "Ignorovať" + undo + the ignored listing.
  { method: 'post', path: '/api/coffee-products/migration/ignore', data: { groups: [] } },
  { method: 'post', path: '/api/coffee-products/migration/unignore', data: { groups: [] } },
  { method: 'get', path: '/api/coffee-products/migration/ignored' },
  // 12 §UC-PC-007/008 (PC-T5): merge tool + stateless duplicates review.
  { method: 'post', path: '/api/coffee-products/1/merge', data: { source_id: 2 } },
  { method: 'get', path: '/api/coffee-products/duplicates' },
  // 12 §UC-PC-010 (PC-T6): cross-cycle statistics.
  { method: 'get', path: '/api/coffee-products/stats' },
  { method: 'get', path: '/api/coffee-products/1/stats' },
  // 12 §UC-PC-009 (PC-T7): catalog CRUD — completes the module's 12 admin routes.
  { method: 'get', path: '/api/coffee-products' },
  { method: 'get', path: '/api/coffee-products/1' },
  { method: 'patch', path: '/api/coffee-products/1', data: { country: 'evil' } },
  // PC-T13 (PM 2026-08-23): manual catalog create, split declarations, unlink.
  { method: 'post', path: '/api/coffee-products', data: { name: 'evil' } },
  { method: 'get', path: '/api/coffee-products/1/splits' },
  { method: 'post', path: '/api/coffee-products/1/splits', data: { sheet_name: 'evil' } },
  { method: 'delete', path: '/api/coffee-products/1/splits/1' },
  { method: 'post', path: '/api/coffee-products/1/unlink' },
  // PM 2026-08-23: a real DELETE (supersedes resolved decision 9's no-delete rule).
  { method: 'delete', path: '/api/coffee-products/1' },
  { method: 'post', path: '/api/coffee-products/1/image' },
  // 12 §UC-PC-014 (PC-T10): the one-time base64 → file conversion endpoint.
  // ⚠ GET /api/images/:filename is DELIBERATELY NOT in this sweep — it is a
  // public read (friend and guest pages render it; exposure equivalent to the
  // already-public products listing that shipped the same bytes inline). Do
  // not "fix" it in; its anonymous-200 pin lives in catalog-images.spec.js.
  { method: 'post', path: '/api/coffee-products/convert-images' },
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
  // 10 §UC-GA-004 (GA-T5) — friend-OWNED, so they belong here and NOT in
  // `ADMIN_ENDPOINTS`. The admin unlink is a deliberately different path
  // (`DELETE /api/friends/:id/google`, above) and the two are never multiplexed.
  //
  // ⚠ The two `google-link` routes pass only because the ownership guard runs BEFORE
  // the Google config guard: with the order reversed, an unconfigured deployment would
  // answer an anonymous caller 503 and this target-agnostic sweep would fail on it.
  // (`google-prompt-dismissed` has no config guard at all by design — §UC-GA-004: it
  // has no Google dependency — so the ordering argument does not apply to it.)
  { method: 'put', path: '/api/friends/1/google-link' },
  { method: 'delete', path: '/api/friends/1/google-link' },
  { method: 'post', path: '/api/friends/1/google-prompt-dismissed' },
  // GA-T11 — the FIRST password (`POST /api/friends/:id/set-password`). Friend-OWNED,
  // so it belongs here and NOT in `ADMIN_ENDPOINTS`: an admin token must not mint a
  // friend a credential through it (the admin path is `PUT /:id/reset-password`, which
  // is a different route and raises `must_change_password`).
  //
  // ⚠ It passes this target-agnostic sweep only because the ownership gate runs BEFORE
  // the modern-mode 409 — the same ordering argument the two `google-link` routes rely
  // on, and the reason the route is written in that order. With the checks reversed,
  // this sweep would see 409 on a legacy target (which the shared seed is) and 401 on
  // a modern one, i.e. it would fail for a deployment setting rather than a bug.
  { method: 'post', path: '/api/friends/1/set-password' },
]

test.describe('API security — friend-identity authorization', () => {
  // ⚠ ONE admin login for the whole describe, deliberately. `POST /api/admin/login`
  // sits on `authLimiter` (20/window by default) and so, since GA-T5, does
  // `PUT /api/friends/:id/google-link` — a per-test login would spend two slots of that
  // bucket per endpoint and, against a target on the DEFAULT limit, start answering
  // **429 where this file asserts 401**. That failure reads exactly like an
  // authorization regression, which is the worst way for a budget problem to surface.
  let adminToken
  test.beforeAll(async ({ playwright }, testInfo) => {
    const ctx = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })
    try {
      const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
      expect(login.status(), 'admin login for the friend-identity sweep').toBe(200)
      adminToken = (await login.json()).token
    } finally {
      await ctx.dispose()
    }
  })

  for (const ep of FRIEND_IDENTITY_ENDPOINTS) {
    test(`${ep.method.toUpperCase()} ${ep.path} needs a friend session (401 anonymously and with an admin token)`, async ({ request }) => {
      const anon = await request[ep.method](ep.path)
      expect(anon.status(), `${ep.path} must not be reachable anonymously`).toBe(401)

      const asAdmin = await request[ep.method](ep.path, { headers: { 'X-Admin-Token': adminToken } })
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

// ═════════════════════════════════════════════════════════════════════════════
// FUP-T19 — `POST /api/admin/logout`
//
// ⚠⚠ THIS ROUTE IS PUBLIC ON PURPOSE AND MUST NOT JOIN `ADMIN_ENDPOINTS` ABOVE.
// The sweep asserts 401-without-a-token; this route deliberately answers 200 to
// everyone, so listing it there would pin the OPPOSITE of its contract. Its real
// invariant is not the status code but the EFFECT: without the current token,
// nothing is deleted. That is what this describe pins, and it is the reason the
// omission above is a decision rather than an oversight (the WHY is also recorded
// at the route itself, in `backend/src/routes/admin.js`).
//
// ⚠ WHY NOT `requireAdmin`: `AdminDashboard.vue:173` calls `api.logout()` with NO
// try/catch, and `api.js`'s `request()` throws on a non-ok response — a 401 would
// abort before `localStorage.removeItem('adminToken')` and before the redirect,
// leaving an admin holding a stale token stuck on a dead dashboard with no way to
// log out. A stale token is routine since module 10: `POST /api/admin/google-login`
// rotates THE ONE app-wide token, so a second browser holding the previous one is
// exactly this case. An idempotent 200 (the GSO-T5 convergence idiom) closes the
// unauthenticated denial AND lets the stale client finish its own cleanup.
//
// ⚠ THE DESTRUCTIVE HALF RUNS ON A THROWAWAY BACKEND, and that is structural, not a
// preference: there is ONE `admin_token` row app-wide, so a successful logout on the
// shared gate would invalidate the token every other spec file captured — the IA trap
// GA-T10 documents. On a throwaway backend the deletion dies with the process, so this
// file can never leave the gate's admin session destroyed. The two NON-destructive
// cases (anonymous, stale) are safe anywhere and therefore run against whatever
// `BASE_URL` points at, which is where they are worth the most.
// ═════════════════════════════════════════════════════════════════════════════

const LOGOUT_OK = { success: true }

test.describe('API security — POST /api/admin/logout is public but not destructive (FUP-T19)', () => {
  test('an ANONYMOUS logout is a 200 no-op — the admin session survives it', async ({ request }) => {
    const login = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'admin login for the anonymous-logout probe').toBe(200)
    const { token } = await login.json()

    // The `request` fixture carries no default headers (`playwright.config.js` sets
    // none), so this call is genuinely anonymous — the same shape as every
    // `ADMIN_ENDPOINTS` probe above, which is exactly what makes them comparable.
    const res = await request.post('/api/admin/logout')
    expect(res.status(), 'the route stays publicly callable').toBe(200)
    expect(await res.json(), 'and its body is unchanged').toEqual(LOGOUT_OK)

    // ⚠ THE ACTUAL SECURITY FIX, and it needs more than a status code: the session
    // the anonymous caller tried to end must still be usable.
    const after = await request.get('/api/friends', { headers: { 'X-Admin-Token': token } })
    expect(after.status(), 'an anonymous POST must not end the admin session').toBe(200)
  })

  test('a STALE token (rotated out by a later login) logs out nothing — the live session survives', async ({ request }) => {
    const first = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(first.status()).toBe(200)
    const stale = (await first.json()).token

    // The rotation module 10 made routine: a second mint replaces the one row.
    const second = await request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(second.status()).toBe(200)
    const live = (await second.json()).token
    expect(live, 'the second login really did rotate the token').not.toBe(stale)
    expect((await request.get('/api/friends', { headers: { 'X-Admin-Token': stale } })).status(),
      'non-vacuity: the stale token is genuinely dead').toBe(401)

    const res = await request.post('/api/admin/logout', { headers: { 'X-Admin-Token': stale } })
    expect(res.status(), 'the stale client still gets its 200 and can finish its cleanup').toBe(200)
    expect(await res.json()).toEqual(LOGOUT_OK)

    const after = await request.get('/api/friends', { headers: { 'X-Admin-Token': live } })
    expect(after.status(), 'a stale token must not end somebody else’s session').toBe(200)

    const garbage = await request.post('/api/admin/logout', { headers: { 'X-Admin-Token': 'not-a-real-token' } })
    expect(garbage.status(), 'a garbage token is the same no-op').toBe(200)
    expect(await garbage.json()).toEqual(LOGOUT_OK)
    expect((await request.get('/api/friends', { headers: { 'X-Admin-Token': live } })).status(),
      'and it leaves the live session alone too').toBe(200)
  })
})

test.describe('API security — logout WITH the current token really logs out (FUP-T19)', () => {
  test('the current token deletes the row; a second logout is still 200; a fresh login recovers', async () => {
    test.skip(!CAN_SPAWN_BACKEND, 'needs the backend source beside e2e/ (skipped against a deployment)')
    let backend
    let ctx
    try {
      backend = await startBackend({})
      ctx = await playwrightRequest.newContext({ baseURL: backend.baseUrl })
      const readToken = () => {
        const db = new DatabaseSync(backend.dbPath)
        try {
          return db.prepare("SELECT value FROM settings WHERE key = 'admin_token'").get()
        } finally {
          db.close()
        }
      }

      const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
      expect(login.status(), 'harness admin login (did seed.mjs run?)').toBe(200)
      const token = (await login.json()).token
      expect(readToken(), 'the session row exists before we touch it').toBeTruthy()

      // Non-vacuity for the two no-op cases above, read off the row itself rather
      // than off a status code: neither an anonymous nor a stale caller may delete it.
      expect((await ctx.post('/api/admin/logout')).status()).toBe(200)
      expect((await ctx.post('/api/admin/logout', { headers: { 'X-Admin-Token': 'wrong' } })).status()).toBe(200)
      expect(readToken(), 'the row survived both refused logouts').toBeTruthy()
      expect((await ctx.get('/api/friends', { headers: { 'X-Admin-Token': token } })).status()).toBe(200)

      // …and the holder of the CURRENT token really does end the session.
      const out = await ctx.post('/api/admin/logout', { headers: { 'X-Admin-Token': token } })
      expect(out.status()).toBe(200)
      expect(await out.json()).toEqual(LOGOUT_OK)
      expect(readToken(), 'the session row is gone').toBeUndefined()
      expect((await ctx.get('/api/friends', { headers: { 'X-Admin-Token': token } })).status(),
        'and the token it destroyed no longer opens anything').toBe(401)

      // Idempotence (GSO-T5): logging out twice is not an error, and the client that
      // already lost its session still gets a clean answer.
      const again = await ctx.post('/api/admin/logout', { headers: { 'X-Admin-Token': token } })
      expect(again.status()).toBe(200)
      expect(await again.json()).toEqual(LOGOUT_OK)
      expect(readToken()).toBeUndefined()

      // The way back is unaffected: password login mints a new session.
      const relogin = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
      expect(relogin.status(), 'logging out did not break logging back in').toBe(200)
      expect((await ctx.get('/api/friends', { headers: { 'X-Admin-Token': (await relogin.json()).token } })).status()).toBe(200)
    } finally {
      await ctx?.dispose()
      await backend?.stop()
    }
  })
})
