import { test, expect, request as playwrightRequest } from '@playwright/test'
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
  expect(friend.uid, 'the appbar renders the uid, so it must exist').toBeTruthy()
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
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

// ---------------------------------------------------------------------------

test.describe('Portal appbar — name, code, pencil, Pozvať chip, logout (UC-FL-004)', () => {
  test('renders the four controls with the prototype structure', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // ⚠ Titles = the Podpultovka WORDMARK + the LOGIN NAME (product decision,
    // 2026-08-09). It used to be `<name> / <uid>`; the uid is no longer rendered
    // anywhere in the appbar, so the bar reads as the brand and no user identifier
    // is on screen. Still never `display_name`, which is admin-only.
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar .titles .s')).toHaveText(friend.name)
    // The load-bearing half: the uid must be absent from the whole appbar, not
    // merely moved out of `.s`.
    await expect(page.locator('.appbar')).not.toContainText(friend.uid)

    // The authenticated ticker copy.
    await expect(page.locator('.ticker')).toContainText('ČLENSKÝ OKRUH')
    await expect(page.locator('.hazard')).toBeVisible()

    // The rotated magenta chip carries the invite glyph AND the visible label —
    // its accessible name is that text, not an aria-label contradicting it.
    const chip = page.locator('.appbar .chip.acc')
    await expect(chip).toHaveText('Pozvať')
    await expect(chip.locator('svg')).toHaveCount(1)
    await expect(chip).toHaveCSS('background-color', 'rgb(255, 45, 135)')
    const transform = await chip.evaluate((el) => getComputedStyle(el).transform)
    expect(transform, 'the chip is rotated -2deg').toMatch(/^matrix\(/)
    expect(transform).not.toBe('none')

    // "Label in name": the chip's `title` must not displace its visible text.
    await expect(page.getByRole('button', { name: 'Pozvať', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Pozvi priateľa' })).toHaveCount(0)

    // Logout is icon-only, so it carries an aria-label.
    await expect(page.locator('.appbar span[aria-label="Odhlásiť sa"] svg')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Odhlásiť sa' })).toHaveCount(1)

    // The pencil renders and is clickable, but is deliberately NOT exposed:
    // it duplicates `.titles`' action and name, so a11y-wise it is decoration.
    const pencil = page.locator('.appbar [data-testid="profile-pencil"]')
    await expect(pencil.locator('svg')).toHaveCount(1)
    await expect(pencil).toHaveAttribute('aria-hidden', 'true')
    await expect(pencil).toHaveAttribute('title', 'Upraviť profil')
    await expect(pencil).not.toHaveAttribute('tabindex', /.*/)
    await expect(pencil).not.toHaveAttribute('role', /.*/)

    // The three EXPOSED controls are keyboard-operable (the zero-pixel layer).
    for (const sel of ['.titles', '.chip.acc', 'span[aria-label="Odhlásiť sa"]']) {
      await expect(page.locator(`.appbar ${sel}`)).toHaveAttribute('tabindex', '0')
    }
  })

  test('⚠ the pencil adds no second tab stop with the same name', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // Walk the real tab order across the bar and record each stop's accessible
    // name. Two adjacent "Upraviť profil, button" stops was the regression.
    const stops = []
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      const stop = await page.evaluate(() => {
        const el = document.activeElement
        if (!el || !el.closest('.appbar')) return null
        return {
          tag: el.tagName,
          cls: el.className || '',
          name: el.getAttribute('aria-label') || el.textContent.trim(),
        }
      })
      if (stop) stops.push(stop)
    }

    const profileStops = stops.filter((s) => s.name === 'Upraviť profil')
    expect(profileStops.length, `appbar tab stops: ${JSON.stringify(stops)}`).toBe(1)
    expect(profileStops[0].cls, 'the surviving stop is .titles').toContain('titles')
  })

  test('⚠ the pencil sits BETWEEN .titles and .grow, not at the right edge', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // The whole point of RD-DS-5's `#after-titles` amendment: `#trailing`
    // renders AFTER the spacer and would fling the pencil to the far edge
    // (`screenshots/02-shot.png` puts it right next to the name).
    const order = await page.locator('.appbar').evaluate((bar) => {
      const kids = Array.from(bar.children)
      return {
        titles: kids.findIndex((k) => k.classList.contains('titles')),
        pencil: kids.findIndex((k) => k.dataset.testid === 'profile-pencil'),
        grow: kids.findIndex((k) => k.classList.contains('grow')),
        chip: kids.findIndex((k) => k.classList.contains('chip')),
      }
    })
    expect(order.titles, JSON.stringify(order)).toBeGreaterThanOrEqual(0)
    expect(order.pencil, 'pencil immediately after .titles').toBe(order.titles + 1)
    expect(order.grow, '.grow immediately after the pencil').toBe(order.pencil + 1)
    expect(order.chip, 'the chip is trailing, i.e. after the spacer').toBeGreaterThan(order.grow)

    // …and geometrically: the pencil hugs the name, the chip does not.
    const box = await page.evaluate(() => {
      const bar = document.querySelector('.appbar')
      const t = bar.querySelector('.titles').getBoundingClientRect()
      const p = bar.querySelector('[data-testid="profile-pencil"]').getBoundingClientRect()
      const c = bar.querySelector('.chip').getBoundingClientRect()
      return { titlesRight: t.right, pencilLeft: p.left, chipLeft: c.left, barRight: bar.getBoundingClientRect().right }
    })
    expect(box.pencilLeft - box.titlesRight, JSON.stringify(box)).toBeLessThan(40)
    expect(box.chipLeft, 'the chip is pushed to the trailing edge').toBeGreaterThan(box.pencilLeft + 40)
  })

  test('name and pencil both open the profile modal; the chip opens invite; logout returns to login', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await openPortal(page)

    // Titles tap.
    await page.locator('.appbar .titles').click()
    await expect(page.getByRole('dialog').getByText('Upraviť profil')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Pencil tap (pointer-only by design — it is aria-hidden).
    await page.locator('.appbar [data-testid="profile-pencil"]').click()
    await expect(page.getByRole('dialog').getByText('Upraviť profil')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Chip → invite modal (real `GET /invitations/my-code`).
    await page.locator('.appbar .chip.acc').click()
    const invite = page.getByRole('dialog')
    await expect(invite.getByText('Pozvi priateľa')).toBeVisible()
    // ⚠ RD-FL-7: the bespoke readonly `<Input>` + copy button became
    // `NeoCopyRow` (02 §UC-DS-011), whose value box is a `div.copyrow > .val` —
    // there is no `input` in this modal any more, by design. Same assertion,
    // same regex, read as text.
    await expect(invite.locator('.copyrow .val')).toHaveText(/\/invite\/[A-Z0-9]+$/)
    await invite.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Logout → back to the login state, storage cleared, wordmark restored.
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toHaveCount(0)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    expect(await page.evaluate(() => localStorage.getItem('gorifi_friend_auth'))).toBeNull()
  })

  test('no horizontal overflow at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await stubBalance(page, -1234.56)
    await openPortal(page)

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth)
  })
})

// ---------------------------------------------------------------------------

test.describe('BrandChrome #after-titles + titles-click — the RD-DS-5 obligations (02 §UC-DS-006)', () => {
  test('the .titles block is reachable by Tab and activates on BOTH Enter and Space', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    const titles = page.locator('.appbar .titles')
    await expect(titles).toHaveAttribute('role', 'button')
    await expect(titles).toHaveAttribute('tabindex', '0')

    // Reachable by Tab from the top of the document (not merely focusable).
    let reached = false
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = await page.evaluate(() => document.activeElement === document.querySelector('.appbar .titles'))
    }
    expect(reached, '.titles must be in the tab order').toBe(true)

    // Enter activates.
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog').getByText('Upraviť profil')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Space activates too — and is preventDefault'ed, so the page does not scroll.
    await titles.focus()
    const scrollBefore = await page.evaluate(() => window.scrollY)
    await page.keyboard.press(' ')
    await expect(page.getByRole('dialog').getByText('Upraviť profil')).toBeVisible()
    expect(await page.evaluate(() => window.scrollY), 'Space must not also scroll').toBe(scrollBefore)
  })

  test('⚠ the aria-label announces the ACTION, not the friend\'s name', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await openPortal(page)

    const titles = page.locator('.appbar .titles')
    await expect(titles).toHaveAttribute('aria-label', 'Upraviť profil')

    // The whole reason `titlesAction` carries a label rather than a boolean: a
    // bare role="button" would announce the CONTENT of the block, never the action.
    // Since 2026-08-09 that content is "Podpultovka <name>" rather than
    // "<name> <uid>" — still the brand and the person, still not a verb.
    await expect(page.getByRole('button', { name: 'Podpultovka' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: friend.name })).toHaveCount(0)
    await expect(page.getByRole('button', { name: friend.uid })).toHaveCount(0)
    // ⚠ EXACTLY ONE control answers to the action's name. The pencil is an
    // adjacent duplicate of this very block — same handler, and its only
    // possible name is the same string — so exposing it too bought nothing and
    // cost every keyboard user a redundant stop. It is `aria-hidden` instead.
    await expect(page.getByRole('button', { name: 'Upraviť profil' })).toHaveCount(1)
  })

  test('the login state opts OUT: no pencil, no role, no tabindex on .titles', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/')
    await expect(page.getByText('Prihlásenie')).toBeVisible()

    // `titlesAction` empty ⇒ NOTHING is added (UC-DS-006: the affordance is
    // strictly opt-in, so a non-interactive appbar renders byte-identically).
    const attrs = await page.locator('.appbar .titles').evaluate((el) => ({
      role: el.getAttribute('role'),
      tabindex: el.getAttribute('tabindex'),
      ariaLabel: el.getAttribute('aria-label'),
      cursor: el.style.cursor,
    }))
    expect(attrs, JSON.stringify(attrs)).toEqual({ role: null, tabindex: null, ariaLabel: null, cursor: '' })
    await expect(page.locator('.appbar [data-testid="profile-pencil"]')).toHaveCount(0)
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

    await page.locator('.appbar .titles').click()
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
    await page.locator('.appbar .titles').click()
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
    await page.locator('.appbar .chip.acc').click()
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
    await page.locator('.appbar .titles').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Uložiť' }).click()
    await expect(page.locator('.banner.danger')).toContainText('Profil sa nepodarilo uložiť')
    await dialog.getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Log out. `switchUser` clears storage, `currentFriend` and `cycles` — and
    // must clear `error` with them.
    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    // Sign back in through the form. On a shared device this is routinely a
    // DIFFERENT person, who would otherwise be shown a stranger's failure with
    // nothing on screen it refers to.
    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(page.locator('.appbar .titles .s')).toHaveText(friend.name)
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
