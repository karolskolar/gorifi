import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FL-4 — the portal's cycle list: section heading + gear trigger
// (03 §UC-FL-006), the restyled cycle cards (badge matrix, plan block, the
// "Objednané ·" fold) and the archive fold (03 §UC-FL-008).
//
// ⚠ HERMETIC, per the idiom RD-FL-2 established and RD-FL-3 refined
// (`portal-appbar.spec.js`): this file writes NO global server state beyond the
// one friend it provisions for itself. Every card state under test comes from a
// per-page `page.route` stub of `GET /api/friends/cycles`, because the matrix
// (type × status × order) would otherwise need ~8 real cycles — and cycles are
// GLOBAL, so every other portal spec would inherit them.
//
// ⚠ Do NOT re-add a `**\/api/friends?active=true` stub. That endpoint is
// admin-gated and this view stopped calling it — see `e2e/README.md`
// §"Friend-portal UI specs and the friends-list stub". The stubs below are only
// the responses actually under test.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let friend = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const ACCENT = 'rgb(255, 45, 135)'

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

  const username = `rdfl4_${uniq}`.slice(0, 30)
  const name = `RDFL4 Tester ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()

  // An admin reset raises must_change_password; clear it so the portal is not
  // gated by the forced-change modal.
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)

  friend = { id: row.id, name, username, token: (await changed.json()).token || body.token }
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// Fixtures — the shape is `GET /api/friends/cycles`'s verbatim
// (`backend/src/routes/friends.js:297`): the `order_cycles` row plus
// hasOrder / orderTotal / orderStatus / orderKilos / orderItemCount /
// orderPickupName / orderPacketa.

const cycleRow = (over) => ({
  id: 0,
  name: '',
  status: 'open',
  created_at: '2026-08-01 10:00:00',
  total_friends: 12,
  expected_date: '29. august 2026',
  type: 'coffee',
  plan_note: null,
  hasOrder: false,
  orderTotal: 0,
  orderStatus: null,
  orderKilos: 0,
  orderItemCount: 0,
  orderPickupName: null,
  orderPacketa: false,
  ...over,
})

const NAMES = {
  openOrdered: `RDFL4 Coffee Open Ordered ${uniq}`,
  bakeryOrdered: `RDFL4 Bakery Open Ordered ${uniq}`,
  openEmpty: `RDFL4 Coffee Open Empty ${uniq}`,
  lockedOrdered: `RDFL4 Coffee Locked Ordered ${uniq}`,
  lockedEmpty: `RDFL4 Bakery Locked Empty ${uniq}`,
  planned: `RDFL4 Coffee Planned ${uniq}`,
  archivedOrdered: `RDFL4 Coffee Done Ordered ${uniq}`,
  archivedEmpty: `RDFL4 Bakery Done Empty ${uniq}`,
}

// ⚠ The third line is a long UNBREAKABLE token on purpose. `plan_note` is free
// admin text and a pasted Google Docs/Sheets URL is the obvious real case; with
// no `overflow-wrap` on the plan block it pushed the DOCUMENT to 531px at a
// 320px viewport (211px of horizontal overflow — measured on this exact
// fixture; 320px exactly once the wrap is in place). The geometry test below is
// what keeps that closed, so the fixture has to actually contain the hazard.
const PLAN_NOTE =
  '22. – 28. august — Objednávanie\n1. – 3. september — Delivery\n' +
  'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'

const MATRIX = [
  cycleRow({
    id: 9101,
    name: NAMES.openOrdered,
    type: 'coffee',
    status: 'open',
    plan_note: PLAN_NOTE,
    hasOrder: true,
    orderTotal: 7.6,
    orderStatus: 'submitted',
    orderKilos: 0.25,
    orderItemCount: 1,
    // ⚠ Set on purpose: resolved conflict #1 drops the delivery-method badge
    // from the portal card, so this must render NOTHING.
    orderPacketa: true,
  }),
  cycleRow({
    id: 9102,
    name: NAMES.bakeryOrdered,
    type: 'bakery',
    status: 'open',
    expected_date: '13. august 2026',
    hasOrder: true,
    orderTotal: 9.8,
    orderStatus: 'submitted',
    orderKilos: 0,
    orderItemCount: 3,
    orderPickupName: 'Kancelária Mlynské Nivy',
  }),
  cycleRow({ id: 9103, name: NAMES.openEmpty, type: 'coffee', status: 'open' }),
  cycleRow({
    id: 9104,
    name: NAMES.lockedOrdered,
    type: 'coffee',
    status: 'locked',
    hasOrder: true,
    orderTotal: 44.15,
    orderStatus: 'submitted',
    orderKilos: 1.25,
  }),
  cycleRow({ id: 9105, name: NAMES.lockedEmpty, type: 'bakery', status: 'locked' }),
  cycleRow({
    id: 9106,
    name: NAMES.planned,
    type: 'coffee',
    status: 'planned',
    expected_date: '26. september 2026',
    plan_note: 'Plánovaný cyklus — objednávky sa otvoria 19.9.',
  }),
  cycleRow({
    id: 9107,
    name: NAMES.archivedOrdered,
    type: 'coffee',
    status: 'completed',
    expected_date: null,
    hasOrder: true,
    orderTotal: 13.09,
    orderStatus: 'submitted',
    orderKilos: 0.25,
  }),
  cycleRow({ id: 9108, name: NAMES.archivedEmpty, type: 'bakery', status: 'completed', expected_date: null }),
]

/** Sign in the way "remember me" does — a REAL session token, nothing stubbed. */
async function signIn(page) {
  const stored = JSON.stringify({
    friendId: friend.id,
    friendName: friend.name,
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

async function stubCycles(page, cycles) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(cycles),
  }))
}

/** A fixed balance keeps the card above the list deterministic. */
async function stubBalance(page, balance = -74.24) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance, transactions: [] }),
  }))
}

async function openPortal(page, cycles = MATRIX) {
  await signIn(page)
  await stubBalance(page)
  await stubCycles(page, cycles)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

/**
 * The card locator, written EXACTLY as `guest-link.spec.js:301` writes it. If
 * this stops resolving to one element per cycle, that spec breaks too.
 */
const cardFor = (page, name) => page.locator('div.p-4', { has: page.getByRole('heading', { name, exact: true }) })

// ---------------------------------------------------------------------------

test.describe('Cycle list — heading + gear (UC-FL-006)', () => {
  test('the heading is a real <h2> with the display class and the magenta highlight', async ({ page }) => {
    await openPortal(page)

    // ⚠ The pin five specs depend on: role=heading, accessible name
    // "Objednávkové cykly" concatenated across the `.hl` span.
    const heading = page.getByRole('heading', { name: 'Objednávkové cykly' })
    await expect(heading).toBeVisible()
    expect(await heading.evaluate((el) => el.tagName)).toBe('H2')

    // `h-screen` here is the THEME's display-heading class, not Tailwind's
    // height utility (it is blocklisted in tailwind.config.js) — so the heading
    // must be display-font and nowhere near 100vh tall.
    await expect(heading).toHaveClass(/\bh-screen\b/)
    const box = await heading.boundingBox()
    const viewport = page.viewportSize()
    expect(box.height, 'h-screen must NOT be resolving to a height utility').toBeLessThan(viewport.height / 2)

    const hl = heading.locator('.hl')
    await expect(hl).toHaveText('cykly')
    await expect(hl).toHaveCSS('background-color', ACCENT)
  })

  test('the gear opens the subscription modal and is keyboard-operable', async ({ page }) => {
    await openPortal(page)

    const gear = page.getByRole('button', { name: 'Nastavenia odberu' })
    await expect(gear.locator('svg')).toHaveCount(1)
    await expect(gear).toHaveAttribute('tabindex', '0')
    await expect(gear).toHaveAttribute('title', 'Nastavenia odberu')

    await gear.click()
    await expect(page.getByRole('dialog').getByText('Nastavenia odberu')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Zrušiť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The gear is the ONLY route to this modal, so it carries the keyboard layer.
    await gear.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog').getByText('Nastavenia odberu')).toBeVisible()
  })

  test('both empty states render as centered .sub copy', async ({ page }) => {
    await openPortal(page, [])
    await expect(page.locator('.sub', { hasText: 'Žiadne dostupné cykly' })).toBeVisible()
    await expect(page.locator('.sub', { hasText: 'Žiadne aktívne cykly' })).toHaveCount(0)

    // Only completed cycles ⇒ the list is empty but the archive is not.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await stubBalance(page)
    await stubCycles(page, MATRIX.filter((c) => c.status === 'completed'))
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await expect(page.locator('.sub', { hasText: 'Žiadne aktívne cykly' })).toBeVisible()
    await expect(page.locator('.sub', { hasText: 'Žiadne dostupné cykly' })).toHaveCount(0)
    await expect(page.getByText('Archív (2)')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------

test.describe('Cycle card — structure and pins (UC-FL-006)', () => {
  test('⚠ every active cycle resolves to exactly ONE div.p-4 holding its <h3>', async ({ page }) => {
    await openPortal(page)

    for (const name of [
      NAMES.openOrdered, NAMES.bakeryOrdered, NAMES.openEmpty,
      NAMES.lockedOrdered, NAMES.lockedEmpty, NAMES.planned,
    ]) {
      // `guest-link.spec.js`'s locator, verbatim. More than one match here
      // (e.g. if the page column ever took a literal `p-4`) is a strict-mode
      // failure in THAT spec, which this row may not edit.
      await expect(cardFor(page, name), `cardFor(${name})`).toHaveCount(1)
      const heading = cardFor(page, name).getByRole('heading', { name, exact: true })
      expect(await heading.evaluate((el) => el.tagName)).toBe('H3')
      // Exactly the cycle name, nothing nested (`.display` uppercases via CSS
      // only, so textContent is untouched).
      expect(await heading.textContent()).toBe(name)
      await expect(heading.locator('span')).toHaveCount(0)
    }

    // The archive rows must NOT be able to answer that locator.
    await page.getByTestId('archive-toggle').click()
    await expect(cardFor(page, NAMES.archivedOrdered)).toHaveCount(0)
  })

  test('⚠ the share button sits INSIDE the same div.p-4 (the RD-FL-5 seam)', async ({ page }) => {
    await openPortal(page)

    // RD-FL-5 replaces this button with UC-FL-007's full share row, in place.
    // Until then the pin is satisfied by the transitional control.
    await expect(cardFor(page, NAMES.openOrdered).getByRole('button', { name: 'Zdieľať s kolegami' })).toHaveCount(1)
    await expect(
      cardFor(page, NAMES.lockedOrdered).getByRole('button', { name: 'Zdieľať s kolegami' }),
      'a locked cycle offers no share affordance'
    ).toHaveCount(0)

    // The share affordance is the card's LAST child, directly under the badge
    // row — where the designed row goes.
    //
    // ⚠ Deliberately asserts the affordance is IN the last child, not that the
    // last child IS a <button>. UC-FL-007's share row is a `div` (the border-top
    // bar) that CONTAINS the button, so a tagName check would fail the moment
    // RD-FL-5 does the in-place replacement the seam comment promises — forcing
    // RD-FL-5 to edit a spec RD-FL-4 just created. The guarantee is identical;
    // it just doesn't pin which element type carries it.
    // The matcher accepts EITHER accessible-name source, because the two forms
    // name the control differently: today's transitional button has no
    // `aria-label` and is named by its text content, while UC-FL-007's carries
    // `aria-label="Zdieľať s kolegami"` with visible text just "Zdieľať".
    const order = await cardFor(page, NAMES.openOrdered).evaluate((card, label) => {
      const isShare = (el) =>
        el.getAttribute('aria-label') === label ||
        ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') &&
          el.textContent.trim() === label)
      const kids = Array.from(card.children)
      const last = kids[kids.length - 1]
      return {
        count: kids.length,
        lastTag: last.tagName,
        lastHasShare: isShare(last) || Array.from(last.querySelectorAll('*')).some(isShare),
      }
    }, 'Zdieľať s kolegami')
    expect(order.lastHasShare, JSON.stringify(order)).toBe(true)
  })

  test('an open card is the white .card.hl with the 6px magenta shadow', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await openPortal(page)

    const card = cardFor(page, NAMES.openOrdered)
    await expect(card).toHaveClass(/\bcard\b/)
    await expect(card).toHaveClass(/\bhl\b/)
    await expect(card).toHaveCSS('box-shadow', `${ACCENT} 6px 6px 0px 0px`)
    await expect(card).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(card).toHaveCSS('padding', '16px')
    await expect(card).toHaveCSS('cursor', 'pointer')

    // A locked card is the plain (ink-shadow) card.
    const locked = cardFor(page, NAMES.lockedOrdered)
    await expect(locked).not.toHaveClass(/\bhl\b/)
    await expect(locked).toHaveCSS('box-shadow', /5px 5px 0px/)
  })

  test('the name is display-font, the date and plan block are mono', async ({ page }) => {
    await openPortal(page)
    const card = cardFor(page, NAMES.openOrdered)

    const name = card.getByRole('heading', { name: NAMES.openOrdered, exact: true })
    await expect(name).toHaveCSS('text-transform', 'uppercase')
    await expect(name).toHaveCSS('font-size', '22px')
    const nameFont = await name.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(nameFont, 'the cycle name uses the display family').toMatch(/Darker Grotesque/i)

    // ⚠ `.mono` left this row on 2026-08-13, so the locator is the testid the view
    // gained for exactly this reason. The face is Figtree BOLD since 2026-08-18
    // (the body face, matching the order screen's status banner — this replaced
    // the Noto Sans Condensed pass).
    const date = card.getByTestId('cycle-date')
    await expect(date).toContainText('29. august 2026')
    await expect(date.locator('svg'), 'the calendar glyph').toHaveCount(1)
    // The face itself, or this change is only a locator rename. Bold on the date,
    // Regular on the plan — the same 700/400 pair the product card uses.
    await expect(date).toHaveCSS('font-weight', '700')
    // ⚠ 14px since 2026-08-13 (bumped from 12px), kept through the 2026-08-18
    // face change. Pinned because the size was its own product decision.
    await expect(date).toHaveCSS('font-size', '14px')
    expect(await date.evaluate((el) => getComputedStyle(el).fontFamily), 'the body face on the date')
      .toContain('Figtree')
    // …and it is NOT the mono face any more.
    expect(await date.evaluate((el) => getComputedStyle(el).fontFamily)).not.toContain('Courier')

    // Plan block: faint, and `white-space: pre-line` so the admin's multiline note
    // keeps one line per row. ⚠ Was `.mono` nth(1) — the row lost that class on
    // 2026-08-13, and an nth() over a class this row no longer carries would
    // silently have pointed at the archive rows' money column.
    const plan = card.getByTestId('cycle-plan')
    await expect(plan).toHaveCSS('white-space', 'pre-line')
    // ⚠ 13.5px, kept below the date's 14px so the weight AND size hierarchy both
    // still say "date first, plan second". Weight 400 = the inherited body default
    // (the view declares no font-family and no font-weight on this row).
    await expect(plan).toHaveCSS('font-size', '13.5px')
    await expect(plan).toHaveCSS('font-weight', '400')
    expect(await plan.evaluate((el) => getComputedStyle(el).fontFamily), 'the body face on the plan')
      .toContain('Figtree')
    expect((await plan.textContent()).split('\n').map((s) => s.trim())).toEqual([
      '22. – 28. august — Objednávanie',
      '1. – 3. september — Delivery',
      'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
    ])

    // ⚠ ...and it wraps. `pre-line` alone keeps one line per row but does NOT
    // break a long unbreakable token, so a pasted URL scrolled the whole
    // document sideways on a phone. Both properties are load-bearing together.
    await expect(plan).toHaveCSS('overflow-wrap', 'anywhere')

    // A cycle without a plan note renders no block at all.
    await expect(cardFor(page, NAMES.openEmpty).locator('[style*="pre-line"]')).toHaveCount(0)
  })

  test('the order total (delivery fee included) renders in the display font next to the accent chevron', async ({ page }) => {
    await openPortal(page)

    const card = cardFor(page, NAMES.openOrdered)
    // UC-DS-012: `toFixed(2) + " EUR"`, DOT decimal — and `orderTotal` already
    // includes the delivery fee, so it is rendered as-is.
    const total = card.locator('.display', { hasText: 'EUR' })
    await expect(total).toHaveText('7.60 EUR')
    await expect(total).toHaveCSS('font-size', '18px')

    const chevron = card.locator('span[style*="var(--accent)"] svg')
    await expect(chevron).toHaveCount(1)

    // No order ⇒ no amount, but still a chevron (the card navigates).
    const empty = cardFor(page, NAMES.openEmpty)
    await expect(empty.locator('.display', { hasText: 'EUR' })).toHaveCount(0)
    await expect(empty.locator('span[style*="var(--accent)"] svg')).toHaveCount(1)
  })

  test('open and locked cards navigate; planned cards are inert', async ({ page }) => {
    await openPortal(page)

    // Locked stays clickable — the read-only order view is module 04's business.
    await cardFor(page, NAMES.lockedOrdered).click()
    await expect(page).toHaveURL(/\/cycle\/9104$/)

    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()

    // Planned: cursor:default, dimmed, and clicking does nothing.
    const planned = cardFor(page, NAMES.planned)
    await expect(planned).toHaveCSS('cursor', 'default')
    await expect(planned).toHaveCSS('opacity', '0.85')
    await expect(planned.locator('span[style*="var(--accent)"] svg'), 'no chevron on a planned card').toHaveCount(0)
    await planned.click()
    await expect(page).toHaveURL(/\/$/)

    // Clicking the NAME navigates too (`mobile-no-h-overflow.spec.js:73`).
    await page.getByRole('heading', { name: NAMES.openOrdered, exact: true }).click()
    await expect(page).toHaveURL(/\/cycle\/9101$/)
  })
})

// ---------------------------------------------------------------------------

test.describe('Badge matrix — type × status × order (UC-FL-006)', () => {
  const badges = (page, name) => cardFor(page, name).locator('.badge')

  test('every combination renders the pinned badge set', async ({ page }) => {
    await openPortal(page)

    await expect(badges(page, NAMES.openOrdered)).toHaveText([
      'Káva', 'Otvorený', 'Objednané · 0.25 kg',
    ])
    await expect(badges(page, NAMES.bakeryOrdered)).toHaveText([
      'Pekáreň', 'Otvorený', 'Objednané · 3 ks',
    ])
    await expect(badges(page, NAMES.openEmpty)).toHaveText([
      'Káva', 'Otvorený', 'Neobjednané',
    ])
    await expect(badges(page, NAMES.lockedOrdered)).toHaveText([
      'Káva', 'Uzamknutý', 'Objednané · 1.25 kg',
    ])
    // ⚠ locked WITHOUT an order gets no third badge at all (prototype rule):
    // "Neobjednané" is only meaningful while ordering is still possible.
    await expect(badges(page, NAMES.lockedEmpty)).toHaveText([
      'Pekáreň', 'Uzamknutý',
    ])
    await expect(badges(page, NAMES.planned)).toHaveText([
      'Káva', 'Plánovaný',
    ])
  })

  test('each badge carries its theme variant', async ({ page }) => {
    await openPortal(page)

    // Type: coffee = solid ink, bakery = acc-o (highlighter).
    await expect(badges(page, NAMES.openOrdered).first()).toHaveClass(/\bsolid\b/)
    await expect(badges(page, NAMES.bakeryOrdered).first()).toHaveClass(/\bacc-o\b/)

    // Status: open = rotated magenta, locked = plain, planned = dashed muted.
    const openStatus = badges(page, NAMES.openOrdered).nth(1)
    await expect(openStatus).toHaveClass(/\bacc\b/)
    await expect(openStatus).toHaveCSS('background-color', ACCENT)
    const transform = await openStatus.evaluate((el) => getComputedStyle(el).transform)
    expect(transform, 'the "Otvorený" badge is rotated -1.5deg').toMatch(/^matrix\(/)

    await expect(badges(page, NAMES.lockedOrdered).nth(1)).not.toHaveClass(/\b(acc|muted|ok|warn)\b/)
    await expect(badges(page, NAMES.planned).nth(1)).toHaveClass(/\bmuted\b/)
    await expect(badges(page, NAMES.planned).nth(1)).toHaveCSS('border-style', 'dashed')

    // Order: ordered = ok (green), not ordered = warn (amber).
    await expect(badges(page, NAMES.openOrdered).nth(2)).toHaveClass(/\bok\b/)
    await expect(badges(page, NAMES.openEmpty).nth(2)).toHaveClass(/\bwarn\b/)
  })

  test('⚠ the dropped surfaces stay dropped: no delivery badge, no separate kilos line', async ({ page }) => {
    await openPortal(page)

    // Resolved conflict #1 — the fixture sets `orderPacketa: true` and a pickup
    // name; neither may reach the portal card any more.
    await expect(cardFor(page, NAMES.openOrdered)).not.toContainText('Packeta')
    await expect(cardFor(page, NAMES.bakeryOrdered)).not.toContainText('Kancelária Mlynské Nivy')

    // Resolved conflict #6 — the quantity lives in the badge, and the old
    // emoji line is gone from the whole page.
    await expect(page.locator('.app')).not.toContainText('☕')
    await expect(page.locator('.app')).not.toContainText('🥐')
    await expect(cardFor(page, NAMES.openOrdered).getByText('0.25 kg', { exact: true })).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('Archive fold (UC-FL-008)', () => {
  test('defaults closed; the chevron rotates 90° and turns accent when open', async ({ page }) => {
    await openPortal(page)

    const toggle = page.getByTestId('archive-toggle')
    await expect(toggle).toContainText('Archív (2)')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText(NAMES.archivedOrdered)).toHaveCount(0)

    const chev = toggle.locator('.chev')
    await expect(chev).not.toHaveClass(/\bopen\b/)
    expect(await chev.evaluate((el) => getComputedStyle(el).transform)).toBe('none')

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(chev).toHaveClass(/\bopen\b/)
    // rotate(90deg) == matrix(0, 1, -1, 0, 0, 0). Asserted with a retrying
    // matcher, not a one-shot evaluate: `.chev` animates over .12s, so a plain
    // read lands mid-transition.
    await expect(chev).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)')
    await expect(chev).toHaveCSS('color', ACCENT)

    await toggle.click()
    await expect(page.getByText(NAMES.archivedOrdered)).toHaveCount(0)
  })

  test('expanded rows are flat cards with small badges and a mono total', async ({ page }) => {
    await openPortal(page)
    await page.getByTestId('archive-toggle').click()

    const row = page.locator('.card.flat', { hasText: NAMES.archivedOrdered })
    await expect(row).toHaveCount(1)
    await expect(row).toHaveCSS('box-shadow', 'none')
    await expect(row).toHaveCSS('border-width', '2px')
    await expect(row).toHaveCSS('padding', '14px')
    await expect(row).toHaveCSS('opacity', '0.85')
    await expect(row.locator('.badge')).toHaveText(['Káva', 'Dokončený'])
    await expect(row.locator('.badge').nth(1)).toHaveClass(/\bmuted\b/)

    const total = row.locator('.mono')
    await expect(total).toHaveText('13.09 EUR')
    const font = await total.evaluate((el) => getComputedStyle(el).fontFamily)
    expect(font, 'money is mono').toMatch(/Courier/i)

    // No order ⇒ no amount (repo behaviour; the prototype's demo data always
    // has one).
    const empty = page.locator('.card.flat', { hasText: NAMES.archivedEmpty })
    await expect(empty.locator('.badge')).toHaveText(['Pekáreň', 'Dokončený'])
    await expect(empty.locator('.mono')).toHaveCount(0)
  })

  test('archived rows still navigate (resolved conflict #4)', async ({ page }) => {
    await openPortal(page)
    await page.getByTestId('archive-toggle').click()

    await page.locator('.card.flat', { hasText: NAMES.archivedOrdered }).click()
    await expect(page).toHaveURL(/\/cycle\/9107$/)
  })

  test('⚠ the fold does not survive a logout into the NEXT session', async ({ page }) => {
    // Session-scoped display state dies with the session (the rule RD-FL-3
    // established). `showArchive` carries no data, but UC-FL-008 pins the fold
    // as default-closed and a surviving component instance is the only way the
    // next person on a shared device could land on it already open.
    //
    // ⚠ NO RELOAD: a reload re-inits the ref regardless and would make this
    // pass against the very bug it exists for. Rendering a login form that can
    // sign back in without one needs the MODERN card, so stub the ONE endpoint
    // the view reads the mode from (RD-FL-2's idiom; the seed stays legacy).
    await page.route('**/friends/auth-mode', (route) => route.fulfill({ json: { authMode: 'modern' } }))
    await openPortal(page)

    await page.getByTestId('archive-toggle').click()
    await expect(page.getByTestId('archive-toggle')).toHaveAttribute('aria-expanded', 'true')

    await page.locator('.appbar span[aria-label="Odhlásiť sa"]').click()
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    await page.getByLabel(/^užívateľské meno$/i).fill(friend.username)
    await page.getByLabel(/^heslo$/i).fill('ownPass12')
    await page.getByRole('button', { name: 'Prihlásiť sa' }).click()

    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await expect(page.getByTestId('archive-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText(NAMES.archivedOrdered)).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------

test.describe('Cycle list geometry', () => {
  test('no horizontal overflow at 320px, even with a long unbreakable cycle name or plan-note URL', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })

    const longName = `RDFL4Averylongunbreakablecyclenamewithoutanyspaces${uniq}`
    await signIn(page)
    await stubBalance(page)
    await stubCycles(page, [
      ...MATRIX,
      cycleRow({ id: 9109, name: longName, status: 'open', plan_note: PLAN_NOTE }),
    ])
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    await page.getByTestId('archive-toggle').click()
    await expect(page.locator('.card.flat')).toHaveCount(2)

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.scrollWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.clientWidth)
  })

  test('the cards sit in the 760px page column with 16px between them', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 1000 })
    await openPortal(page)

    const gap = await page.evaluate(() => {
      // ⚠ NOT `.card.p-4` — the BALANCE card also carries `p-4` (it is
      // `p-4 sm:p-5`). It is not a cycle card and is not in this list; anchor on
      // a cycle heading instead. The same overlap is harmless for
      // `guest-link.spec.js`'s `cardFor()`, whose `has:` filter excludes it.
      const list = document.querySelector('.app h3.display').closest('div.p-4').parentElement
      return { display: getComputedStyle(list).display, gap: getComputedStyle(list).rowGap, width: list.getBoundingClientRect().width }
    })
    expect(gap.display).toBe('flex')
    expect(gap.gap).toBe('16px')
    expect(gap.width, JSON.stringify(gap)).toBeLessThanOrEqual(760)
  })
})
