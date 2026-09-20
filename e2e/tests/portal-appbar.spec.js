import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding, logout, openInvite, openMenu, openProfile, expectChromeName } from '../helpers/portal.js'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FL-3 — the authenticated portal appbar (03 §UC-FL-004) and the restyled
// balance card (03 §UC-FL-005), plus the two obligations RD-DS-5 deliberately
// deferred to its first real consumer:
//
//   1. the POSITIVE `#after-titles` / `titlesAction` path of BrandChrome
//      (02 §UC-DS-006 acceptance criteria) — RD-DS-5 could only assert the
//      no-op case, because no shipped view opted in;
//   2. the newly-surfaced authenticated error banner (an RD-FL-1 residual:
//      `error` had four writers that all run while authenticated and no branch
//      that could render it).
//
// ⚠ HERMETIC, per RD-FL-2's idiom (`modern-login.spec.js`): this file never
// writes global server state. It provisions its own friend over the admin API,
// signs the browser in by seeding `localStorage.gorifi_friend_auth` with a REAL
// session token (see `e2e/README.md` §"Friend-portal UI specs and the
// friends-list stub"), and stubs only the responses a given test needs to pin —
// i.e. the balance, where a specific money state is under test. The friends
// list is NOT stubbed: this view no longer reads the admin-gated
// `GET /api/friends?active=true` at all.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let friend = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

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

  const username = `rdfl3_${uniq}`.slice(0, 30)
  const name = `RDFL3 Tester ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()

  // An admin reset raises must_change_password; clear it so the portal is not
  // gated by the forced-change modal (UC-FL-012 is modern-login.spec.js's job).
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token

  const profile = await ctx.get(`/api/friends/${row.id}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT,
  })
  expect(profile.status(), 'friend profile').toBe(200)
  const full = await profile.json()

  friend = { id: row.id, name, username, token, uid: full.uid }
  // ⚠ The appbar NEVER renders the uid (FUP-T20 removed the last on-screen
  // consumer; §UC-PI-003 removed the name too). It is fetched so the absence pins
  // below can be non-vacuous — asserting „the bar does not contain X" is worth
  // nothing when X is the empty string.
  expect(friend.uid, 'a real uid is needed for the absence pin to mean anything').toBeTruthy()
})

test.afterAll(async () => { await ctx?.dispose() })

/**
 * Sign the browser in the way "remember me" does. NOTHING is stubbed here:
 * the restore path builds `currentFriend` from the stored entry and hydrates it
 * over `GET /api/friends/:id/profile` (owner-token gated), and the login-name
 * dropdown reads the PUBLIC `GET /api/friends/login-list`. Cycles, balance,
 * profile and invite code all talk to the real backend with the real token.
 *
 * ⚠ Do not re-add a `**\/api/friends?active=true` stub here. That endpoint is
 * admin-gated and this view stopped calling it — see `e2e/README.md`
 * §"Friend-portal UI specs and the friends-list stub".
 */
async function signIn(page) {
  const stored = JSON.stringify({
    friendId: friend.id,
    friendName: friend.name,
    friendUid: friend.uid,
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

/** Serve a fixed balance so the three money states are deterministic. */
async function stubBalance(page, balance) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance, transactions: [] }),
  }))
}

async function openPortal(page) {
  await page.goto('/')
  await expectLanding(page)
}

// ---------------------------------------------------------------------------

// ⚠ REWRITTEN BY PI-T2 — 18 §UC-PI-019 item 7, case (a) of the immutability rule.
//
// 03 §UC-FL-004's appbar (name → profile · pencil · Pozvať · logout glyph) is
// SUPERSEDED by 18 §UC-PI-003 (menu · wordmark + VIEW SUBTITLE · Pozvať · lock
// chip). Four of this file's controls therefore no longer exist, and the tests
// that pinned them are re-pointed at the mandated structure rather than deleted:
//
//   · „renders the four controls"            → the four SLOTS of §UC-PI-003, plus
//                                              absence pins for the three retired
//                                              controls (item 7's requirement)
//   · the two PENCIL tests (:181, :208)      → ONE `profile-pencil` count-0 pin
//   · „name and pencil open the profile…"    → the drawer helpers (items 4, 5)
//   · the `.titles` role/tabindex/aria-label
//     /Enter/Space describe                  → INVERTED. §UC-PI-003: „`titlesAction`
//                                              is empty in every state — `.titles`
//                                              carries no role, no tabindex, no
//                                              aria-label". The login-state opt-out
//                                              test at :348 becomes the general rule.
//   · the `'ČLENSKÝ OKRUH'` ticker pin       → the THREE state tickers.
//
// The PROTECTED PROPERTIES are all kept and several are now asserted in both
// directions: exactly one `.chip.acc`; the chip's accessible name is its visible
// text and not its `title`; no user identifier anywhere in the bar; the bar does
// not overflow at 320 px; and — new, because the controls moved rather than
// vanished — every retired control is pinned ABSENT, so „it was removed" cannot be
// confused with „the test stopped looking".

/** A cycle row shaped like `GET /friends/cycles` publishes one (portal-shell idiom). */
const cycleRow = (over) => ({
  id: 80_000 + (over.n || 0), name: `PI2 Appbar ${over.n || 0}`, status: 'planned',
  created_at: over.created_at || `2026-09-0${(over.n || 1) % 9 + 1} 10:00:00`,
  total_friends: 0, expected_date: null, type: 'coffee', plan_note: null,
  opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
  hasOrder: false, orderTotal: 0, orderStatus: null, orderKilos: 0, orderItemCount: 0,
  orderPickupName: null, orderPacketa: false, orderPaid: false, orderHandedOver: false,
  ...over,
})

/**
 * Serve a fixed cycles payload so the landing STATE — which the ticker, the lock
 * chip and the subtitle are all functions of — is deterministic.
 *
 * ⚠ It waits for the response before asserting. `cycles` starts EMPTY on a
 * restore, so the pre-load state is `closed`: a `closed` expectation that fired
 * early would pass for entirely the wrong reason (the PI-T1 lesson). The `open`
 * and `locked` rows are what make the set discriminating, since neither is the
 * pre-load value.
 */
async function openPortalWith(page, cycles) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(cycles),
  }))
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto('/')
  await served
  await expectLanding(page)
}

test.describe('Portal appbar — menu · wordmark + view subtitle · Pozvať · lock (18 §UC-PI-003)', () => {
  test('renders the THREE slots with the prototype structure', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // #leading — the hamburger. Icon-only, so it carries the accessible name.
    const menu = page.locator('.appbar [aria-label="Menu"]')
    await expect(menu).toHaveClass(/p2-icobtn/)
    await expect(menu.locator('svg')).toHaveCount(1)
    await expect(menu).toHaveAttribute('role', 'button')
    await expect(menu).toHaveAttribute('tabindex', '0')

    // .titles — the wordmark plus the VIEW SUBTITLE. The name is gone from here
    // (§UC-PI-003; it lives in the drawer header now) and so is the uid.
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')
    await expect(page.locator('.appbar')).not.toContainText(friend.name)
    await expect(page.locator('.appbar')).not.toContainText(friend.uid)

    // The rotated magenta chip carries the invite glyph AND the visible label —
    // its accessible name is that text, not an aria-label contradicting it.
    const chip = page.locator('.appbar .chip.acc')
    await expect(chip).toHaveText('Pozvať')
    await expect(chip.locator('svg')).toHaveCount(1)
    await expect(chip).toHaveCSS('background-color', 'rgb(255, 45, 135)')
    const transform = await chip.evaluate((el) => getComputedStyle(el).transform)
    expect(transform, 'the chip is rotated -2deg').toMatch(/^matrix\(/)
    expect(transform).not.toBe('none')
    // ⚠ EXACTLY ONE `.chip.acc` in the bar — the shipped locator every other spec
    // uses for „Pozvať". The lock chip is `.chip.p2-lock`, never `.acc`.
    await expect(page.locator('.appbar .chip.acc')).toHaveCount(1)

    // "Label in name": the chip's `title` must not displace its visible text.
    await expect(page.getByRole('button', { name: 'Pozvať', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Pozvi priateľa' })).toHaveCount(0)

    await expect(page.locator('.hazard')).toBeVisible()
  })

  test('⚠ the three RETIRED controls are absent, not merely unasserted', async ({ page }) => {
    // §UC-PI-019 item 7: „add absence pins for pencil, logout glyph, `.titles[role]`".
    // This is the half that makes the rewrite above honest — every one of these
    // used to be pinned PRESENT in this very file.
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    await expect(page.locator('.appbar [data-testid="profile-pencil"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="profile-pencil"]')).toHaveCount(0)
    await expect(page.locator('.appbar span[aria-label="Odhlásiť sa"]')).toHaveCount(0)
    await expect(page.locator('.appbar .titles[role]')).toHaveCount(0)
    await expect(page.locator('.appbar .titles[tabindex]')).toHaveCount(0)
    await expect(page.locator('.appbar .titles[aria-label]')).toHaveCount(0)
    // …and no control in the bar answers to the profile action any more.
    await expect(page.getByRole('button', { name: 'Upraviť profil' })).toHaveCount(0)

    // Non-vacuity: the bar IS rendered and IS operable — three of these absence
    // assertions would also pass against a page with no appbar at all.
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar [aria-label="Menu"]')).toHaveCount(1)
  })

  test('the three state tickers, the lock chip and the subtitle follow the round', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)

    // OPEN — no lock chip.
    await openPortalWith(page, [cycleRow({ n: 2, status: 'open', closes_at: '2026-09-12' })])
    await expect(page.locator('.ticker')).toContainText('+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++')
    await expect(page.locator('.appbar .chip.p2-lock')).toHaveCount(0)
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')

    // LOCKED with the friend's own order ⇒ „Vaša objednávka".
    await page.unroute('**/api/friends/cycles*')
    await openPortalWith(page, [cycleRow({ n: 3, status: 'locked', hasOrder: true })])
    await expect(page.locator('.ticker')).toContainText('+++ OBJEDNÁVKY UZAMKNUTÉ +++ KÁVA JE NA CESTE +++')
    await expect(page.locator('.appbar .titles .s')).toHaveText('Vaša objednávka')
    const lock = page.locator('.appbar .chip.p2-lock')
    await expect(lock).toHaveCount(1)
    await expect(lock).toHaveAttribute('title', 'Objednávky sú uzamknuté')
    // Decorative: the state is spoken by the landing banner, never twice.
    await expect(lock).toHaveAttribute('aria-hidden', 'true')
    await expect(lock).not.toHaveClass(/acc/)
    await expect(page.locator('.appbar .chip.acc')).toHaveCount(1)

    // LOCKED with NO order of the friend's own ⇒ back to „Aktuálna ponuka".
    await page.unroute('**/api/friends/cycles*')
    await openPortalWith(page, [cycleRow({ n: 4, status: 'locked', hasOrder: false })])
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')

    // CLOSED, with the next round four weeks out. ⚠ The ticker is asserted from
    // `textContent`, and `.ticker` is `text-transform:uppercase` — so the string
    // has to be built uppercase in JS. A lower-case source would render identically
    // on screen and fail here, which is exactly the point.
    const in4 = new Date(Date.now() + 28 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    await page.unroute('**/api/friends/cycles*')
    await openPortalWith(page, [
      cycleRow({ n: 5, status: 'completed' }),
      cycleRow({ n: 6, status: 'planned', opens_at: in4 }),
    ])
    await expect(page.locator('.ticker')).toContainText('+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIA OBJEDNÁVKA O 4 TÝŽDNE +++')
    const closedLock = page.locator('.appbar .chip.p2-lock')
    await expect(closedLock).toHaveCount(1)
    await expect(closedLock).toHaveAttribute('title', 'Objednávky sú zatvorené')

    // …and CLOSED with nothing planned falls back to „DÁME VEDIEŤ" — the branch a
    // single closed fixture would never reach.
    await page.unroute('**/api/friends/cycles*')
    await openPortalWith(page, [cycleRow({ n: 7, status: 'completed' })])
    await expect(page.locator('.ticker')).toContainText('+++ OBJEDNÁVKY ZATVORENÉ +++ ĎALŠIA OBJEDNÁVKA DÁME VEDIEŤ +++')
    // ⚠ Vocabulary rule (§UC-PI-017): the prototype's „ĎALŠIE KOLO" is rewritten.
    await expect(page.locator('.ticker')).not.toContainText('KOLO')
  })

  test('the subtitle names the VIEW on each of the four routes', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    for (const [path, subtitle] of [
      ['/moje-objednavky', 'Moje objednávky'],
      ['/zostatok', 'Zostatok a platby'],
      ['/ako-to-funguje', 'Ako to funguje'],
      ['/', 'Aktuálna ponuka'],
    ]) {
      await page.goto(path)
      await expectLanding(page)
      await expect(page.locator('.appbar .titles .s'), path).toHaveText(subtitle)
    }
  })

  test('⚠ the explainer swaps the hamburger for a BACK chevron', async ({ page }) => {
    // §UC-PI-003 `#leading` (prototype `portal2.jsx`:309): there is no menu button
    // in the explainer view, and the chevron goes to `/`.
    await signIn(page)
    await stubBalance(page, 0)
    await page.goto('/ako-to-funguje')
    await expectLanding(page)

    await expect(page.locator('.appbar [aria-label="Menu"]')).toHaveCount(0)
    const back = page.locator('.appbar [aria-label="Späť"]')
    await expect(back).toHaveCount(1)
    // ⚠ BOTH classes: §UC-PI-003 names „the existing `span.back`", the prototype
    // renders a `p2-icobtn`. The second is what carries the 44×44 hit target
    // (UC-DS-005) — a bare `.back` is an 20px glyph with `opacity:.9` and no box.
    await expect(back).toHaveClass(/\bback\b/)
    await expect(back).toHaveClass(/\bp2-icobtn\b/)
    const backBox = await back.boundingBox()
    expect(Math.round(backBox.width), 'the back chevron keeps a 44px hit target').toBe(44)
    expect(Math.round(backBox.height)).toBe(44)
    await back.click()
    await expect(page).toHaveURL(/\/$/)
    // …and the hamburger is back, so the swap is a swap and not a one-way loss.
    await expect(page.locator('.appbar [aria-label="Menu"]')).toHaveCount(1)
  })

  test('the menu opens the drawer; the chip opens invite; the drawer opens profile and logs out', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // Menu → the drawer, a dialog of its own.
    await openMenu(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Chip → invite modal (real `GET /invitations/my-code`).
    await openInvite(page)
    const invite = page.getByRole('dialog')
    // ⚠ RD-FL-7: the bespoke readonly `<Input>` + copy button became `NeoCopyRow`
    // (02 §UC-DS-011), whose value box is a `div.copyrow > .val`.
    await expect(invite.locator('.copyrow .val')).toHaveText(/\/invite\/[A-Z0-9]+$/)
    await invite.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Drawer → Profil (the retarget of the `.titles` tap and the pencil tap).
    await openProfile(page)
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Drawer → „Odhlásiť sa" → back to the login state, storage cleared.
    await logout(page)
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()
  })

  test('no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await stubBalance(page, -1234.56)
    // The LOCKED state, so the lock chip is in the bar too — the widest it gets.
    await openPortalWith(page, [cycleRow({ n: 8, status: 'locked', hasOrder: true })])

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth)
  })
})

// ---------------------------------------------------------------------------

test.describe('BrandChrome `.titles` — RD-DS-5\'s obligations, INVERTED by 18 §UC-PI-003', () => {
  // ⚠ THIS DESCRIBE USED TO ASSERT THE POSITIVE PATH of `titlesAction` (role,
  // tabindex, aria-label, Enter, Space) because the authenticated portal was its
  // only consumer. §UC-PI-003 retires that consumer: „`titlesAction` is empty in
  // every state — `.titles` carries no `role`, no `tabindex`, no `aria-label`
  // (reverses 03 UC-FL-004; the login-state opt-out becomes the rule)". So the
  // assertions invert, and the login-state test below is now the GENERAL rule
  // asserted on both states.
  //
  // ⚠ The SEAM ITSELF is not retired: `titlesAction` is still BrandChrome's prop
  // and 02 §UC-DS-006's no-op default is what these tests now pin — „empty ⇒
  // NOTHING is added", asserted where a consumer really renders. That is the
  // property a future consumer would rely on.

  const TITLES_ATTRS = async (page) => page.locator('.appbar .titles').evaluate((el) => ({
    role: el.getAttribute('role'),
    tabindex: el.getAttribute('tabindex'),
    ariaLabel: el.getAttribute('aria-label'),
    cursor: el.style.cursor,
  }))

  test('the AUTHENTICATED state opts out too: no role, no tabindex, no aria-label, no cursor', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    expect(await TITLES_ATTRS(page)).toEqual({ role: null, tabindex: null, ariaLabel: null, cursor: '' })
    // Non-vacuity: this IS the authenticated bar (the login bar reads „Členský
    // vstup"), so the four nulls are a claim about a rendered, populated block.
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')
  })

  test('⚠ `.titles` is not in the tab order, and Enter on it opens nothing', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    // Walk the real tab order across the bar: the first stop must be the MENU,
    // never the titles block. (Before §UC-PI-003 the first stop was `.titles`.)
    const stops = []
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || !el.closest('.appbar')) return null
        return { cls: el.className || '', name: el.getAttribute('aria-label') || el.textContent.trim() }
      })
      if (stop) stops.push(stop)
    }
    expect(stops.length, `appbar tab stops: ${JSON.stringify(stops)}`).toBeGreaterThan(0)
    expect(stops.some((s) => String(s.cls).includes('titles')),
      `.titles must not be a tab stop: ${JSON.stringify(stops)}`).toBe(false)
    expect(stops[0].name, 'the first stop in the bar is the menu').toBe('Menu')

    // …and a click on it does nothing at all — no dialog of any kind.
    await page.locator('.appbar .titles').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('the login state opts OUT as well — the same rule, now on both states', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await expect(page.getByText('Prihlásenie')).toBeVisible()

    expect(await TITLES_ATTRS(page)).toEqual({ role: null, tabindex: null, ariaLabel: null, cursor: '' })
    await expect(page.locator('.appbar [data-testid="profile-pencil"]')).toHaveCount(0)
    // No menu button on the login card either — the drawer is session chrome.
    await expect(page.locator('.appbar [aria-label="Menu"]')).toHaveCount(0)
    await expect(page.locator('.appbar .titles .s')).toHaveText('Členský vstup')
  })
})

// ---------------------------------------------------------------------------

test.describe('Balance card — three money states (UC-FL-005)', () => {
  test('a negative balance renders the bordered red pill', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    await expect(card.locator('.field-lbl')).toHaveText('Môj účet')

    const value = card.locator('.neg.pill')
    await expect(value).toHaveText('-74.24 EUR')
    await expect(value).toHaveCSS('color', 'rgb(209, 26, 91)') // var(--danger)
    await expect(value).toHaveCSS('font-size', '16px')
    // Bordered pill, not a bare number.
    await expect(value).toHaveCSS('border-width', '2px')
    await expect(value).toHaveCSS('background-color', 'rgb(255, 224, 234)') // var(--danger-soft)
  })

  test('a settled balance renders the muted zero state', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    await expect(card.locator('.zero')).toHaveText('0.00 EUR')
    await expect(card.locator('.neg')).toHaveCount(0)
  })

  test('a positive balance renders the recorded OPEN default: green mono with a + sign', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 12.5)
    await openPortal(page)

    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    const value = card.locator('.mono')
    await expect(value).toHaveText('+12.50 EUR')
    await expect(value).toHaveCSS('color', 'rgb(15, 93, 60)') // var(--ok-deep)
    await expect(value).toHaveCSS('font-weight', '700')
  })

  test('"Transakcie" opens the existing transactions modal', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    const button = page.getByRole('button', { name: 'Transakcie' })
    await expect(button).toHaveClass(/\bbtn\b/)
    await expect(button).toHaveClass(/\bsm\b/)
    // UC-DS-005 hit target: `.btn.sm` is 38px.
    expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(38)

    await button.click()
    await expect(page.getByRole('dialog').getByText('Všetky transakcie')).toBeVisible()
  })

  test('a failed balance load renders .banner.danger.slim inside the card and hides the button', async ({ page }) => {
    await signIn(page)
    await page.route('**/api/friends/*/balance', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Zostatok sa nepodarilo načítať' }),
    }))
    await openPortal(page)

    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    await expect(card.locator('.banner.danger.slim')).toContainText('Zostatok sa nepodarilo načítať')
    await expect(page.getByRole('button', { name: 'Transakcie' })).toHaveCount(0)
  })

  test('the loading state shows "Načítavam..." before the balance resolves', async ({ page }) => {
    await signIn(page)
    let release
    const held = new Promise((resolve) => { release = resolve })
    await page.route('**/api/friends/*/balance', async (route) => {
      await held
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ balance: -5, transactions: [] }) })
    })

    await page.goto('/')
    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    await expect(card.locator('.sub')).toHaveText('Načítavam...')
    release()
    await expect(card.locator('.neg.pill')).toHaveText('-5.00 EUR')
  })

  test('⚠ BalanceBadge is still the admin component — the card must not render it', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // BalanceBadge's signature is its Tailwind palette pills
    // (`bg-red-100` / `bg-green-100` / `bg-gray-100` + `inline-flex rounded`).
    // It is SHARED WITH ADMIN, so the restyle had to stop importing it rather
    // than edit it — the card renders the theme's own money classes instead.
    const card = page.locator('.card', { hasText: 'Môj účet' }).first()
    await expect(card.locator('.bg-red-100, .bg-green-100, .bg-gray-100')).toHaveCount(0)
    await expect(card.locator('.inline-flex.rounded')).toHaveCount(0)
    await expect(card.locator('.neg.pill')).toHaveCount(1)
  })
})

// ---------------------------------------------------------------------------

test.describe('Authenticated error banner — the RD-FL-1 residual', () => {
  // ⚠ RD-FL-8a MOVED this failure, on purpose — the same relocation RD-FL-7
  // performed on the invite fetch in the test below, and for the same reason.
  // The row mandates: "Give the profile modal a `profileError` and the
  // subscription modal a `subError`, after which `error && !showProfileModal`
  // collapses to `error`."
  //
  // RD-FL-3 wrote this test to prove `saveProfile` was no longer a SILENT
  // writer. It still is not silent: it writes its own `profileError` and renders
  // `.banner.danger.slim` in the modal body, instead of writing the shared
  // page-level `error` that the modal then had to SUPPRESS the page banner to
  // display without duplicating. That suppression term (`!showProfileModal`) had
  // to grow by one clause per dialog and let any other writer put a message in
  // this modal's banner. Same stub, same message, relocated assertion — plus the
  // stronger property the move buys: the message belongs to this action alone
  // and can never reach the page banner.
  test('a failed profile save surfaces IN THE MODAL, and a successful retry leaves nothing behind', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)

    // Fail the first PATCH only; let every later one through to the real backend.
    let failed = false
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() !== 'PATCH' || failed) return route.continue()
      failed = true
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Profil sa nepodarilo uložiť' }),
      })
    })

    await openPortal(page)

    // Before RD-FL-3 this message went nowhere at all.
    await expect(page.locator('.banner.danger')).toHaveCount(0)

    await openProfile(page)
    let dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Upraviť profil')).toBeVisible()
    await dialog.getByRole('button', { name: 'Uložiť' }).click()

    // The modal stays open (save failed) and the message is in its body, where
    // the user is looking — not behind the scrim.
    await expect(dialog.locator('.banner.danger.slim')).toContainText('Profil sa nepodarilo uložiť')
    // ONE surface: nothing renders it underneath as well.
    await expect(page.locator('.banner.danger')).toHaveCount(1)

    // Scoped to the modal, so it goes when the modal does — and it never
    // reaches the page banner, whose only remaining writer is `resolveVoucher`.
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
    await expect(page.locator('.app')).not.toContainText('Profil sa nepodarilo uložiť')

    // …and a successful retry leaves no stale message behind.
    await openProfile(page)
    dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })

  // ⚠ RD-FL-7 MOVED this failure, on purpose (03 §UC-FL-011: "keeping the user
  // in context is the restyle's one permitted UX correction here — same data,
  // same call"). RD-FL-3 wrote this test to prove the invite fetch was no longer
  // a SILENT writer; it is still not silent, but it now writes its own
  // `inviteError` and renders `.banner.danger.slim` in the modal body instead of
  // leaking into the page-level `error`. The user asked for a link, so the
  // answer — link or reason — belongs where they are looking. Same stub, same
  // message, relocated assertion.
  test('a failed invite-code fetch surfaces IN THE MODAL (RD-FL-7 moved it there)', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await page.route('**/api/invitations/my-code*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Pozvánkový kód sa nepodarilo načítať' }),
    }))

    await openPortal(page)
    await openInvite(page)
    const invite = page.getByRole('dialog')
    await expect(invite.locator('.banner.danger.slim')).toContainText('Pozvánkový kód sa nepodarilo načítať')
    // …and no copy row for a link that was never fetched.
    await expect(invite.locator('.copyrow')).toHaveCount(0)

    await invite.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The page banner stays clean: this modal no longer writes the shared ref.
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })

  test('⚠ the banner does not survive a logout into the NEXT session', async ({ page }) => {
    // ⚠ NO RELOAD anywhere below. A reload remounts FriendPortal and re-inits
    // `error` to '' regardless, which would make this test pass against the
    // very bug it exists for. The logout and the re-login must both happen in
    // ONE component instance — which is also the real-world path: nobody
    // hard-refreshes between "Odhlásiť sa" and the next person signing in.
    //
    // Rendering the login form that can do that in-place needs the MODERN card
    // (legacy's is a radix Select that `forced-change-ui.spec.js` deferred as
    // unreliable), so borrow RD-FL-2's idiom: stub the ONE endpoint the view
    // reads the mode from, per page. The seed stays legacy; no global write.
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))

    await signIn(page)
    await stubBalance(page, 0)

    // Fail the profile PATCH so `error` is set while authenticated.
    await page.route('**/api/friends/*/profile', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Profil sa nepodarilo uložiť' }),
      })
    })

    await openPortal(page)
    await openProfile(page)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.locator('.banner.danger')).toContainText('Profil sa nepodarilo uložiť')
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Log out. `switchUser` clears storage, `currentFriend` and `cycles` — and
    // must clear `error` with them.
    await logout(page)

    // Sign back in through the form. On a shared device this is routinely a
    // DIFFERENT person, who would otherwise be shown a stranger's failure with
    // nothing on screen it refers to.
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

    await expectLanding(page)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    // ⚠ PI-T2: `.s` is the VIEW SUBTITLE now (§UC-PI-003), not the friend's name.
    // The identity claim this line carried moves to the drawer header, which is
    // where a friend's name renders from here on.
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')
    await expectChromeName(page, friend.name)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('Voucher banner geometry (RD-FL-1 residual)', () => {
  // The banner's own look is pinned "visually untouched" by UC-FL-001, but its
  // WRAPPER was still `max-w-4xl` (896px) while the authenticated column moved
  // to 760px — measured at 1180px that is a 68px overhang on each side. RD-FL-3
  // is the row that touches this column, so it brings the two onto one geometry.
  //
  // Stubs only: a real voucher needs a resolved order in a cycle, and none of
  // that is what is under test here.
  test('the resolved-voucher banner lines up with the 760px page column', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await page.route('**/api/vouchers/pending*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{
        id: 987654,
        cycle_name: 'RDFL3 Voucher Cycle',
        supplier_discount: 40,
        applied_discount: 30,
        voucher_amount: 4.2,
      }]),
    }))
    await page.route('**/api/vouchers/*/resolve', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    }))

    await page.setViewportSize({ width: 1180, height: 900 })
    await page.goto('/')

    await page.getByRole('button', { name: 'Použiť ako kredit na ďalšiu objednávku' }).click()
    const banner = page.getByText('Kredit 4.20 € pridaný')
    await expect(banner).toBeVisible()

    const geometry = await page.evaluate(() => {
      const bannerWrap = document.querySelector('.app > div.mt-4')
      const column = Array.from(document.querySelectorAll('.app > div')).find((d) => d.querySelector('h2'))
      const b = bannerWrap.getBoundingClientRect()
      const c = column.getBoundingClientRect()
      return { bannerLeft: b.left, bannerWidth: b.width, columnLeft: c.left, columnWidth: c.width }
    })
    expect(geometry.bannerWidth, JSON.stringify(geometry)).toBe(geometry.columnWidth)
    expect(geometry.bannerLeft, JSON.stringify(geometry)).toBe(geometry.columnLeft)
    expect(geometry.bannerWidth).toBeLessThanOrEqual(760)
  })
})
