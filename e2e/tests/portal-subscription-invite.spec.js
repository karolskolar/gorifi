import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

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

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

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
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
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

const openSubs = async (page) => {
  await page.locator('.app [aria-label="Nastavenia odberu"]').click()
  const d = page.getByRole('dialog')
  await expect(d.locator('.m-title')).toHaveText('Nastavenia odberu')
  return d
}

const boxFor = (dialog, label) => dialog.getByRole('checkbox', { name: label })

// ---------------------------------------------------------------------------

test.describe('Subscription modal — the prototype shell (UC-FL-010)', () => {
  test('title, intro, two card rows, help text, footer — on NeoModal, not radix', async ({ page }) => {
    await openPortal(page)
    const d = await openSubs(page)

    await expect(d).toHaveClass(/\bmodal\b/)
    await expect(d).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('.modal-layer')).toHaveCount(1)

    await expect(d.locator('.m-body > .sub')).toHaveText('Vyberte, ktoré typy objednávok chcete vidieť:')
    await expect(d.locator('.field-help')).toHaveText('Ak nevyberiete nič, zobrazia sa všetky cykly.')

    // One `<label class="card flat">` per type, prototype geometry
    // (`portal.jsx:153`): 12px 14px padding, flex, 12px gap, cursor pointer.
    const rows = d.locator('label.card.flat')
    await expect(rows).toHaveCount(2)
    for (const [i, text] of [[0, 'Káva'], [1, 'Pekáreň']]) {
      const row = rows.nth(i)
      // The bold label span — `portal.jsx:155` renders `fontWeight: 700`.
      const lbl = row.locator('> span').last()
      await expect(lbl).toHaveText(text)
      expect(await lbl.evaluate((el) => getComputedStyle(el).fontWeight), `${text} is bold`).toBe('700')
      const box = await row.evaluate((el) => {
        const s = getComputedStyle(el)
        return { display: s.display, gap: s.columnGap, pad: s.padding, cursor: s.cursor }
      })
      expect(box, JSON.stringify(box)).toEqual({
        display: 'flex', gap: '12px', pad: '12px 14px', cursor: 'pointer',
      })
      // The house checkbox, NOT a native input.
      await expect(row.locator('.cbox[role=checkbox]')).toHaveCount(1)
      await expect(row.locator('input')).toHaveCount(0)
    }

    // ⚠ Default MAGENTA. The green `ok` variant is reserved for hand-over
    // semantics (02 §UC-DS-009) and must not appear here.
    await expect(d.locator('.cbox.ok')).toHaveCount(0)
    const fill = await boxFor(d, 'Káva').evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(fill, 'checked fill is --accent magenta').toBe('rgb(255, 45, 135)')

    await expect(d.locator('.m-foot button')).toHaveText(['Zrušiť', 'Uložiť'])
  })

  test('preset matrix: an empty list checks BOTH; stored types check per type', async ({ page }) => {
    // Empty ⇒ both (the backend rule "no filter" rendered as "everything on").
    await setTypes([])
    let state = await openPortal(page)
    let d = await openSubs(page)
    await expect(boxFor(d, 'Káva')).toHaveAttribute('aria-checked', 'true')
    await expect(boxFor(d, 'Pekáreň')).toHaveAttribute('aria-checked', 'true')
    await d.getByRole('button', { name: 'Zrušiť' }).click()

    // Stored ['coffee'] ⇒ coffee on, bakery off.
    await setTypes(['coffee'])
    state = await openPortal(page, { types: ['coffee'] })
    d = await openSubs(page)
    await expect(boxFor(d, 'Káva')).toHaveAttribute('aria-checked', 'true')
    await expect(boxFor(d, 'Pekáreň')).toHaveAttribute('aria-checked', 'false')
    await d.getByRole('button', { name: 'Zrušiť' }).click()

    // Stored ['bakery'] ⇒ the mirror image.
    await setTypes(['bakery'])
    await openPortal(page, { types: ['bakery'] })
    d = await openSubs(page)
    await expect(boxFor(d, 'Káva')).toHaveAttribute('aria-checked', 'false')
    await expect(boxFor(d, 'Pekáreň')).toHaveAttribute('aria-checked', 'true')
    expect(state.saved, 'nothing was written by merely looking').toBeNull()
  })

  test('⚠ the WHOLE label surface toggles — box, text and padding — exactly once each', async ({ page }) => {
    // The acceptance criterion, and the one thing that cannot be assumed: a
    // `<label>` forwards clicks only to LABELABLE elements, and NeoCheckbox is a
    // `span[role=checkbox]`. Each zone therefore has its own handler, and the
    // failure mode of getting that wrong is a DOUBLE toggle (the label catching
    // the click the box already handled), which looks like "nothing happens".
    await setTypes([])
    await openPortal(page)
    const d = await openSubs(page)
    const box = boxFor(d, 'Káva')
    const row = d.locator('label.card.flat').first()

    const checked = () => box.getAttribute('aria-checked')
    expect(await checked()).toBe('true')

    // 1. the box itself
    await box.click()
    expect(await checked(), 'clicking the box toggles once').toBe('false')

    // 2. the bold text
    await row.getByText('Káva').click()
    expect(await checked(), 'clicking the text toggles once, not twice').toBe('true')

    // 3. the padding / gap — the label element itself. Clicked near its right
    //    edge, which is label surface and nothing else.
    const w = (await row.boundingBox()).width
    await row.click({ position: { x: w - 6, y: 22 } })
    expect(await checked(), 'clicking the padding toggles once').toBe('false')

    // Keyboard still works (the ARIA layer, 02 §UC-DS-009).
    await box.press(' ')
    expect(await checked(), 'Space toggles').toBe('true')
  })

  test('saving re-filters the cycle list IN PLACE — no reload, no navigation', async ({ page }) => {
    await setTypes([])
    const state = await openPortal(page)
    // A marker on the window object: it survives a re-render, never a reload.
    await page.evaluate(() => { window.__rdfl7 = 'alive' })

    await expect(page.getByText(COFFEE)).toBeVisible()
    await expect(page.getByText(BAKERY)).toBeVisible()
    const before = state.listCalls

    const d = await openSubs(page)
    await boxFor(d, 'Pekáreň').click()
    await d.getByRole('button', { name: 'Uložiť' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText(BAKERY), 'the bakery cycle is filtered out').toHaveCount(0)
    await expect(page.getByText(COFFEE)).toBeVisible()

    expect(state.saved, 'the two booleans became `types`').toEqual(['coffee'])
    expect(state.listCalls, 'saveSubscriptions re-ran loadCycles()').toBeGreaterThan(before)
    expect(await page.evaluate(() => window.__rdfl7), 'the page never reloaded').toBe('alive')

    // Persisted for real, and the modal presets from the persisted value on the
    // next visit (fresh mount, real `GET /api/subscriptions/friend/:id`).
    const auth = await ctx.post('/api/friends/auth', {
      data: { username: friend.username, password: 'ownPass12' }, timeout: TIMEOUT,
    })
    const stored = await ctx.get(`/api/subscriptions/friend/${friend.id}`, {
      headers: { Authorization: `Bearer ${(await auth.json()).token}` },
      timeout: TIMEOUT,
    })
    expect((await stored.json()).types).toEqual(['coffee'])

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    const reopened = await openSubs(page)
    await expect(boxFor(reopened, 'Káva')).toHaveAttribute('aria-checked', 'true')
    await expect(boxFor(reopened, 'Pekáreň')).toHaveAttribute('aria-checked', 'false')
  })

  test('unchecking BOTH saves [] and every cycle comes back', async ({ page }) => {
    await setTypes(['coffee'])
    const state = await openPortal(page, { types: ['coffee'] })
    await expect(page.getByText(BAKERY)).toHaveCount(0)

    const d = await openSubs(page)
    await boxFor(d, 'Káva').click()
    await d.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    expect(state.saved, 'neither box ⇒ an EMPTY list, not a missing field').toEqual([])
    await expect(page.getByText(COFFEE)).toBeVisible()
    await expect(page.getByText(BAKERY), 'no filter ⇒ everything shows').toBeVisible()
  })

  test('while saving: "Ukladám..." and both footer buttons disabled', async ({ page }) => {
    await setTypes([])
    await openPortal(page)
    // Hold the write open so the in-flight state is observable.
    let release = null
    await page.route('**/api/subscriptions/friend/*', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      await new Promise((r) => { release = r })
      await route.fulfill({ json: { types: ['coffee'] } })
    })

    const d = await openSubs(page)
    await boxFor(d, 'Pekáreň').click()
    await d.getByRole('button', { name: 'Uložiť' }).click()

    const foot = d.locator('.m-foot button')
    await expect(foot.nth(1)).toHaveText('Ukladám...')
    await expect(foot.nth(0)).toBeDisabled()
    await expect(foot.nth(1)).toBeDisabled()
    release()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await setTypes([])
    await openPortal(page)
    await openSubs(page)
    const over = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(over, 'document must not scroll sideways').toBeLessThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------

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
