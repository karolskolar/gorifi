import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding, openMenu } from '../helpers/portal.js'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// RD-FL-7 — the subscription modal (03 §UC-FL-010) and the invite modal
// (03 §UC-FL-011), both on `NeoModal`, the invite one on `NeoCopyRow`.
//
// HERMETIC, per `portal-cycles.spec.js` / `portal-profile-modal.spec.js`: one
// friend provisioned over the admin API, signed in by seeding a REAL session
// token, and `GET /api/friends/cycles` stubbed per page — cycles are global and
// expensive, and the matrix here needs one of each type.
//
// ⚠ The SUBSCRIPTION WRITE is deliberately NOT stubbed. `PUT
// /api/subscriptions/friend/:id` is per-friend and hermetic, so the "reopening
// the modal shows the persisted state" criterion is proved against the real
// endpoint (including across a reload). Only the cycle LIST is stubbed, keyed on
// the types the view actually sent, which is what makes "the list re-filters
// without a reload" an assertion about the view rather than about the backend
// rule (which shipped long ago).

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let friend = null

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const u = uniq()
  const name = `RDFL7m ${u}`
  const username = `rdfl7m${u}`.toLowerCase().slice(0, 30)
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const first = (await auth.json()).token
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'clear forced change').toBe(200)

  const profile = await ctx.get(`/api/friends/${row.id}/profile`, {
    headers: { Authorization: `Bearer ${changed.json ? (await changed.json()).token : first}` },
    timeout: TIMEOUT,
  })
  expect(profile.status(), 'friend profile').toBe(200)
  friend = { id: row.id, name, username, ...(await profile.json()) }
})

test.afterAll(async () => { await ctx?.dispose() })

// --- fixtures ---------------------------------------------------------------

const COFFEE = `RDFL7 Káva ${uniq()}`
const BAKERY = `RDFL7 Pekáreň ${uniq()}`

const cycleRow = (over) => ({
  id: 0, name: '', status: 'open', created_at: '2026-08-01 10:00:00',
  total_friends: 12, expected_date: '29. august 2026', type: 'coffee', plan_note: null,
  hasOrder: false, orderTotal: 0, orderStatus: null, orderKilos: 0,
  orderItemCount: 0, orderPickupName: null, orderPacketa: false,
  ...over,
})

const ALL = [
  cycleRow({ id: 9401, name: COFFEE, type: 'coffee' }),
  cycleRow({ id: 9402, name: BAKERY, type: 'bakery' }),
]

/** Kill the UC-FL-007 colleague-count storm (RD-FL-6's flake). */
async function muteGuestCounts(page) {
  await page.route('**/api/guest-links/cycle/*', (route) => route.abort())
}

async function signIn(page) {
  const stored = JSON.stringify({
    friendId: friend.id, friendName: friend.name, friendUid: friend.uid,
    token: (await (await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: 'ownPass12' }, timeout: TIMEOUT,
    })).json()).token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

async function stubBalance(page) {
  await page.route('**/api/friends/*/balance', (route) =>
    route.fulfill({ json: { balance: 0, transactions: [] } })
  )
}

/**
 * Serve the cycle list the BACKEND would serve for the types the view last
 * saved — the documented rule: an empty list means "no filter", so everything
 * shows. `state.types` is updated from the real PUT the view fires, so the
 * stub can never drift ahead of what was actually sent.
 */
function stubFilteredCycles(page, state) {
  return page.route('**/api/friends/cycles*', (route) => {
    const types = state.types
    const list = !types || types.length === 0 ? ALL : ALL.filter((c) => types.includes(c.type))
    state.listCalls += 1
    return route.fulfill({ json: list })
  })
}

async function openPortal(page, { types = [] } = {}) {
  const state = { types, listCalls: 0, saved: null }
  await muteGuestCounts(page)
  await stubBalance(page)
  await stubFilteredCycles(page, state)
  // Observe (never fake) the real subscription write.
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/subscriptions\/friend\//.test(req.url())) {
      try {
        state.saved = JSON.parse(req.postData() || '{}').types
        state.types = state.saved
      } catch { /* ignore */ }
    }
  })
  await signIn(page)
  await page.goto('/')
  await expectLanding(page)
  return state
}

/** Set the friend's stored subscription types over the real API. */
async function setTypes(types) {
  const auth = await ctx.post('/api/friends/auth', {
    data: { username: friend.username, password: 'ownPass12' }, timeout: TIMEOUT,
  })
  const token = (await auth.json()).token
  const res = await ctx.put(`/api/subscriptions/friend/${friend.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { types },
    timeout: TIMEOUT,
  })
  expect(res.status(), `set subscriptions ${JSON.stringify(types)}`).toBe(200)
}

// ⚠ `openSubs()` / `boxFor()` are GONE with the modal they drove (18 §UC-PI-016).

// ---------------------------------------------------------------------------

test.describe('PI-T3 · 18 §UC-PI-016 — the subscription filter is RETIRED from the UI', () => {
  // ⚠ WHAT WAS HERE. Two describes, NINE tests, on the „Nastavenia odberu" modal:
  // its NeoModal shell, the preset matrix, the three label click-zones, the in-place
  // re-filter, the empty save, the saving state, 320px, and its own failure surface.
  // §UC-PI-016 retires the modal and the gear that opened it — bakery is retiring, so
  // the cycle-type filter has nothing left to filter — and §UC-PI-019 item 8 replaces
  // all nine with the TWO claims that outlive them.
  //
  // The retired tests are not silently lost: every one of them was about a control
  // this row deletes. What is NOT deleted is the column, the two routes and the
  // SERVER-side filter in `GET /friends/cycles`, and that is what pin 2 measures.

  test('no „Nastavenia odberu" control on ANY of the four views, or in the drawer', async ({ page }) => {
    await openPortal(page)

    for (const path of ['/', '/moje-objednavky', '/zostatok', '/ako-to-funguje']) {
      if (page.url().replace(/^https?:\/\/[^/]+/, '') !== path) {
        await page.goto(path)
      }
      await expectLanding(page)
      // Non-vacuity: the app really rendered this view before the absences are read.
      await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', /.+/)

      await expect(page.locator('[aria-label="Nastavenia odberu"]'),
        `gear on ${path}`).toHaveCount(0)
      await expect(page.getByText('Nastavenia odberu'),
        `label on ${path}`).toHaveCount(0)
      await expect(page.locator('body'),
        `the retired help copy on ${path}`).not.toContainText('zobrazia sa všetky cykly')
    }

    // …and not hidden inside the drawer either — the one surface that can hold a
    // control without it being on the page at rest.
    await page.goto('/')
    await expectLanding(page)
    const menu = await openMenu(page)
    await expect(menu.getByText('Nastavenia odberu')).toHaveCount(0)
    await expect(menu.locator('.p2-mi'), 'non-vacuity: the drawer really rendered rows')
      .not.toHaveCount(0)
  })

  test('the endpoint SURVIVES: PUT/GET /api/subscriptions/friend/:id still answer 200', async () => {
    // §UC-PI-016: „No schema change, no route removal, no data deleted." The UI is
    // the only thing that went. A round trip through the real API, with a real friend
    // Bearer — and the value is read BACK, so a route that 200s and writes nothing
    // would still red.
    const auth = await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: 'ownPass12' }, timeout: TIMEOUT,
    })
    expect(auth.status(), 'friend login').toBe(200)
    const token = (await auth.json()).token
    const headers = { Authorization: `Bearer ${token}` }

    const put = await ctx.put(`/api/subscriptions/friend/${friend.id}`, {
      headers, data: { types: ['coffee'] }, timeout: TIMEOUT,
    })
    expect(put.status(), 'PUT /api/subscriptions/friend/:id').toBe(200)

    const get = await ctx.get(`/api/subscriptions/friend/${friend.id}`, { headers, timeout: TIMEOUT })
    expect(get.status(), 'GET /api/subscriptions/friend/:id').toBe(200)
    expect((await get.json()).types).toEqual(['coffee'])

    // Put it back, so the file leaves no global state behind (the RD-FL-2 idiom).
    expect((await ctx.put(`/api/subscriptions/friend/${friend.id}`, {
      headers, data: { types: [] }, timeout: TIMEOUT,
    })).status()).toBe(200)
  })
})


test.describe('Invite modal — NeoModal + NeoCopyRow (UC-FL-011)', () => {
  const openInvite = async (page) => {
    await page.locator('.appbar .chip.acc').click()
    const d = page.getByRole('dialog')
    await expect(d.locator('.m-title')).toHaveText('Pozvi priateľa')
    return d
  }

  test('intro copy, loading state, then the copy row; footer is "Zavrieť"', async ({ page }) => {
    await setTypes([])
    await openPortal(page)

    // Hold the fetch so "Načítavam..." is observable, per UC-FL-011.
    let release = null
    await page.route('**/api/invitations/my-code*', async (route) => {
      await new Promise((r) => { release = r })
      await route.continue()
    })

    const d = await openInvite(page)
    await expect(d.locator('.m-body > .sub').first())
      .toHaveText('Pošlite tento odkaz priateľovi. Po registrácii ho správca pridá do skupiny.')
    await expect(d.getByText('Načítavam...')).toBeVisible()
    await expect(d.locator('.copyrow')).toHaveCount(0)

    release()
    await expect(d.locator('.copyrow')).toHaveCount(1)
    await expect(d.getByText('Načítavam...')).toHaveCount(0)
    // ⚠ NeoCopyRow's value box is a `div.val`, not an input (02 §UC-DS-011).
    await expect(d.locator('.copyrow input')).toHaveCount(0)
    await expect(d.locator('.m-foot button')).toHaveText(['Zavrieť'])
  })

  test('⚠ the link is built from window.location.origin, and the clipboard gets it EXACTLY', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await setTypes([])
    await openPortal(page)
    const d = await openInvite(page)
    await expect(d.locator('.copyrow')).toHaveCount(1)

    const shown = (await d.locator('.copyrow .val').textContent()).trim()
    const origin = await page.evaluate(() => window.location.origin)
    // The prototype's `https://podpultovka.sk/invite/LEGO-9F2K` is DEMO DATA —
    // a hardcoded host would break every environment but one.
    expect(shown).toMatch(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite/[A-Z0-9-]+$`))
    expect(shown, 'no prototype host anywhere').not.toContain('podpultovka.sk')
    // The full value is always exposed, however narrow the box gets.
    await expect(d.locator('.copyrow .val')).toHaveAttribute('title', shown)

    const btn = d.locator('.copyrow button')
    await expect(btn).toHaveText('Kopírovať')
    await btn.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown)
  })

  test('the copy button flips green "Skopírované!" and comes back after 2 s', async ({ page }) => {
    await setTypes([])
    await openPortal(page)
    const d = await openInvite(page)
    const btn = d.locator('.copyrow button')
    await expect(btn).toHaveCount(1)

    await btn.click()
    await expect(btn).toHaveText('Skopírované!')
    await expect(btn).toHaveClass(/\bok\b/)
    expect(await btn.evaluate((el) => getComputedStyle(el).backgroundColor), 'the `ok` green')
      .toBe('rgb(31, 138, 91)')

    // Still green just before the window closes, back at rest after it.
    await page.waitForTimeout(1500)
    await expect(btn).toHaveText('Skopírované!')
    await expect(btn).toHaveText('Kopírovať', { timeout: 3000 })
    await expect(btn).not.toHaveClass(/\bok\b/)
  })

  test('a re-click RESTARTS the 2 s window instead of stacking timers', async ({ page }) => {
    await setTypes([])
    await openPortal(page)
    const d = await openInvite(page)
    const btn = d.locator('.copyrow button')

    await btn.click()
    await page.waitForTimeout(1500)
    await btn.click()
    // 1.5 s after the SECOND click — the first click's timer would have fired by
    // now if it had been left running (that is the prototype's leak).
    await page.waitForTimeout(1500)
    await expect(btn).toHaveText('Skopírované!')
  })

  test('no horizontal overflow at 320px, long link and all', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await setTypes([])
    await openPortal(page)
    const d = await openInvite(page)
    await expect(d.locator('.copyrow')).toHaveCount(1)
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(over, 'document must not scroll sideways').toBeLessThanOrEqual(0)
  })
})
