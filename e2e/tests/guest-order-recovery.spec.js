import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// Module 14 — guest order recovery (UC-GR-*). This file is the module's own spec
// file; later GR rows extend it (UC-GR-010 item 9 enumerates the obligations).
//
// GR-T7 / 14 §UC-GR-009 — the share dialog's TWO standing copy lines. The
// incident's host almost certainly regenerated the link because "Vygenerovať nový
// odkaz" read as "share with one more colleague", which silently severed every
// colleague who already held the old URL. The fix is standing copy, visible BEFORE
// the host reaches for the button:
//
//   1. `share-standing-copy` under the NeoCopyRow — one link serves ALL colleagues.
//   2. `regen-guidance` directly above the actions row — regenerate ONLY on a leak.
//
// ⚠ Both are `div.field-help`, and that is a CONSTRAINT, not a preference
// (§UC-GR-009 placement rules): `share-dialog.spec.js` pins `dialog.locator('p.sub')`
// with a single-element `toHaveText` (:239, :579), pins `subtitle.locator('b')` as a
// single element (:200) and pins the `.confirmbox` copy and its single `<b>`
// (:417-418). This row therefore edits ZERO existing spec files — the tests below
// assert the additivity directly, so a later "tidy-up" into a `p.sub` or a `<b>`
// reddens here rather than in an immutable file.
//
// Fixtures are per test, never a shared `beforeAll` (the GSO-T8 worker-restart
// lesson: Playwright re-runs `beforeAll` after a failure).
//
// NOTE ON RATE LIMITS: guest/friend/admin auth all sit behind their own buckets.
// Run with the raised budget — see e2e/README.md.

const STANDING_COPY =
  'Ten istý odkaz platí pre všetkých kolegov — každý si cez neho vytvorí vlastnú objednávku. Pre ďalšieho kolegu nevytvárajte nový odkaz.'
const REGEN_GUIDANCE =
  'Nový odkaz vygenerujte len vtedy, ak sa pôvodný dostal k nesprávnym ľuďom — kolegom potom treba poslať nový.'

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// The backend keeps exactly ONE live admin session, overwritten on every
// /api/admin/login — a UI login elsewhere invalidates a token captured earlier.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// A friend with a real per-friend Bearer session — the host identity the
// guest-link routes require (the share-dialog.spec.js pattern).
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gr_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Hostitel ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()

  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label) {
  const name = `E2E GR ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

// FriendPortal resolves the stored session against GET /api/friends?active=true,
// which is admin-gated — an anonymous browser gets 401 (pre-existing app gap, see
// e2e/README.md), so that ONE response is stubbed. Everything under test still
// talks to the real backend with the real Bearer token.
async function signInAsHost(page, host) {
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: host.id, friendName: host.name, token: host.token, expiresAt: Date.now() + 864e5 }))

  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGR1', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

async function gotoPortal(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

// A hard load of /cycle/:id bounces to the portal, so a real host arrives through it.
async function gotoCycle(page, cycle) {
  await gotoPortal(page)
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

const portalCard = (page, name) =>
  page.locator('div.card.p-4', { has: page.getByRole('heading', { name, exact: true }) })

// Entry point A — the "Kolegovia" panel in FriendOrder (module 05's own).
async function openFromOrderPage(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
  await page.getByTestId('main-tab-guests').click()
  await page.getByRole('button', { name: /Zdieľať/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// Entry point B — the portal cycle card's share row. ONE shared component
// (GSO-T2), so both entry points must render the same standing copy.
async function openFromPortal(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoPortal(page)
  await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

const overflow = (page) => page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}))

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await refreshAdminToken()
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// UC-GR-009 — the share dialog's standing copy

test.describe('UC-GR-009 — share dialog standing copy', () => {
  test('link exists (order page): both lines render with the EXACT strings, as div.field-help', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('copyA')
    const cycle = await makeCycle('copyA')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)

    const standing = dialog.getByTestId('share-standing-copy')
    const guidance = dialog.getByTestId('regen-guidance')

    // ⚠ The point of line 1: the host must not read "Vygenerovať nový odkaz" as
    // "share with one more colleague" (the incident).
    await expect(standing).toBeVisible()
    await expect(standing).toHaveText(STANDING_COPY)
    await expect(guidance).toBeVisible()
    await expect(guidance).toHaveText(REGEN_GUIDANCE)

    // The primitive is mandated, not chosen — see the header note.
    for (const line of [standing, guidance]) {
      expect(await line.evaluate((el) => el.tagName)).toBe('DIV')
      expect(await line.evaluate((el) => el.className)).toBe('field-help')
      // `.field-help` is A10-covered, so no call-site line-height fix-up is
      // needed (and none may widen A10).
      expect(await line.evaluate((el) => getComputedStyle(el).lineHeight)).toBe('normal')
    }
  })

  test('link exists (portal card): the SAME two lines — one shared dialog', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('copyB')
    const cycle = await makeCycle('copyB')
    await shareLink(host, cycle.id)

    const dialog = await openFromPortal(page, host, cycle)

    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  test('placement: standing copy directly UNDER the copy row, guidance directly ABOVE the actions row', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('place')
    const cycle = await makeCycle('place')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    // Presence first, so a MISSING line fails by name instead of as a null
    // dereference inside the evaluate below.
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)

    // Structural, not merely "present somewhere": line 1 answers the copy row
    // ("this URL, for everyone"), line 2 must be read before the button it is
    // about, so it sits immediately above the actions row.
    const placement = await dialog.evaluate(() => {
      const standing = document.querySelector('[data-testid="share-standing-copy"]')
      const guidance = document.querySelector('[data-testid="regen-guidance"]')
      const actions = guidance && guidance.nextElementSibling
      return {
        prevOfStanding: standing.previousElementSibling?.className || null,
        actionsButtons: actions
          ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
          : null,
        // Reading order top-to-bottom must be copyrow → standing → guidance.
        standingBeforeGuidance:
          standing.compareDocumentPosition(guidance) === Node.DOCUMENT_POSITION_FOLLOWING,
      }
    })

    expect(placement.prevOfStanding).toContain('copyrow')
    expect(placement.standingBeforeGuidance).toBe(true)
    expect(placement.actionsButtons).toEqual(['Deaktivovať odkaz', 'Vygenerovať nový odkaz'])
  })

  test('the no-link state gains NOTHING (there is no link to mis-share yet) — and both lines arrive with the link', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('nolink')
    const cycle = await makeCycle('nolink')

    const dialog = await openFromOrderPage(page, host, cycle)

    await expect(dialog.locator('p.sub')).toHaveText('Odkaz ešte nie je vytvorený.')
    await expect(dialog.getByTestId('share-standing-copy')).toHaveCount(0)
    await expect(dialog.getByTestId('regen-guidance')).toHaveCount(0)

    // Creating the link flips the state in place — and the copy comes with it.
    await dialog.getByRole('button', { name: 'Vytvoriť odkaz' }).click()
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  test('a DEACTIVATED link still carries both lines (still the link-exists state)', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('deact')
    const cycle = await makeCycle('deact')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await dialog.getByRole('button', { name: 'Deaktivovať odkaz' }).click()
    await expect(dialog.locator('.banner.warn')).toBeVisible()

    // The URL stays on screen while deactivated, so the "one link for everyone"
    // statement stays true and must stay visible with it.
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  // ⚠ THE ADDITIVITY GUARD. `share-dialog.spec.js` must pass UNMODIFIED
  // (§UC-GR-009, UC-GR-010 item 8), so this row may not introduce a second
  // `p.sub` in the dialog, a second `<b>` in the subtitle slot, or touch the
  // `.confirmbox`. Asserted here so a later refactor toward those primitives
  // fails in THIS file instead of in an immutable one.
  test('additive against every share-dialog.spec.js pin: no new p.sub, no new subtitle <b>, confirmbox untouched', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('additive')
    const cycle = await makeCycle('additive')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.getByTestId('share-standing-copy')).toBeVisible()

    // :239/:579 — `dialog.locator('p.sub')` is asserted as a SINGLE element with
    // the no-link sentence, so the link-exists state must contain none at all.
    await expect(dialog.locator('p.sub')).toHaveCount(0)
    // :200 — `subtitle.locator('b')` is a single-element `toHaveText(cycleName)`.
    const subtitle = dialog.locator('.m-head .sub')
    await expect(subtitle.locator('b')).toHaveCount(1)
    await expect(subtitle.locator('b')).toHaveText(cycle.name)
    // Neither new line may live in the subtitle slot.
    expect(await subtitle.textContent()).not.toContain('Ten istý odkaz')
    expect(await subtitle.textContent()).not.toContain('Nový odkaz vygenerujte')

    // :417-418 — the confirmbox keeps its exact copy and its ONE `<b>`; the
    // guidance is STANDING text outside the box (visible before the click, which
    // is the whole point).
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    const box = dialog.locator('.confirmbox')
    await expect(box).toContainText('Starý odkaz prestane fungovať. Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.')
    await expect(box.locator('b')).toHaveCount(1)
    await expect(box.locator('b')).toHaveText('Starý odkaz prestane fungovať.')
    expect(await box.textContent(), 'the guidance is not inside the box').not.toContain('len vtedy')
    // …and the guidance stays on screen while the box is open.
    await expect(dialog.getByTestId('regen-guidance')).toBeVisible()
  })

  test('320px: the two lines add no horizontal overflow in any link-exists state', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('narrow')
    const cycle = await makeCycle('narrow')
    await shareLink(host, cycle.id)

    await page.setViewportSize({ width: 320, height: 900 })
    await signInAsHost(page, host)
    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('share-standing-copy')).toBeVisible()

    // ⚠ Unlike `.btn` (nowrap, so it pushes sideways instead of degrading), a
    // `.field-help` block wraps — but the em dash and the long words are worth
    // measuring against the modal's own box rather than assuming.
    const outside = () => dialog.evaluate((modal) => {
      const box = modal.getBoundingClientRect()
      return ['share-standing-copy', 'regen-guidance'].filter((id) => {
        const r = modal.querySelector(`[data-testid="${id}"]`).getBoundingClientRect()
        return r.right > box.right + 0.5 || r.left < box.left - 0.5
      })
    })

    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await outside()).toEqual([])

    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    await expect(dialog.locator('.confirmbox')).toBeVisible()
    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await outside()).toEqual([])
  })
})
