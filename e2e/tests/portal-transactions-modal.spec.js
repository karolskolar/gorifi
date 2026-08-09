import { test, expect, request as playwrightRequest } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'

// "Všetky transakcie" — the ledger behind the balance card's "Transakcie"
// button, restyled onto the Neobrutal shell (`NeoModal` + `.suborder > ul.items`
// + the theme's money classes).
//
// ⚠ THIS MODAL HAD NO COVERAGE OF ITS OWN. The only shipped assertion that ever
// touched it is `portal-appbar.spec.js:403`, which opens it and checks the title
// is visible — nothing about its rows, its three data states, its shell or its
// behaviour at 320px. Everything below is new.
//
// ⚠ THERE IS NO CANON SCREEN for it either: `portal.jsx:114` has the BUTTON and
// nothing behind it. So these tests pin the EXTRAPOLATION — which shipped
// vocabulary was reused and what it must keep doing — rather than a pixel
// reference. In particular they pin the two things a restyle can silently
// destroy: the sign/colour rule on money, and the fact that an admin-authored
// cycle name cannot scroll a phone sideways.
//
// ⚠ HERMETIC, per `portal-appbar.spec.js`'s idiom: this file provisions its own
// friend over the admin API, signs the browser in with a REAL session token, and
// stubs only balance + transactions, where a specific state is under test.

const TIMEOUT = 20_000

// Theme tokens (`friends-theme.css:14`) as Chromium serialises them.
const DANGER = 'rgb(209, 26, 91)' // --danger
const OK_DEEP = 'rgb(15, 93, 60)' // --ok-deep

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

  const username = `rdtx_${uniq}`.slice(0, 30)
  const name = `RDTX Tester ${uniq}`
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
  const token = (await changed.json()).token || body.token

  const profile = await ctx.get(`/api/friends/${row.id}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: TIMEOUT,
  })
  expect(profile.status(), 'friend profile').toBe(200)
  const full = await profile.json()

  friend = { id: row.id, name, username, token, uid: full.uid }
})

test.afterAll(async () => { await ctx?.dispose() })

/** Sign the browser in the way "remember me" does. */
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

async function stubBalance(page, balance) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance, transactions: [] }),
  }))
}

/** `GET /api/transactions/friend/:id` — the modal's only call (`api.js:260`). */
async function stubTransactions(page, rows) {
  await page.route('**/api/transactions/friend/*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(rows),
  }))
}

// ⚠ `created_at` is written the way SQLite's CURRENT_TIMESTAMP writes it
// ('YYYY-MM-DD HH:MM:SS', no zone), because that is the string `formatDate()`
// actually receives in production. Midday, so no timezone can roll the day.
const ROWS = [
  { id: 901, type: 'charge', amount: -24.5, created_at: '2026-03-04 12:00:00', cycle_name: 'Marcový cyklus', note: null },
  { id: 902, type: 'payment', amount: 30, created_at: '2026-03-06 12:00:00', cycle_name: null, note: 'Prevod na účet' },
  { id: 903, type: 'adjustment', amount: 5.25, created_at: '2026-04-01 12:00:00', cycle_name: null, note: null },
]

async function openPortal(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

/** Open the modal off the balance card and return its dialog locator. */
async function openModal(page) {
  await openPortal(page)
  await expect(page.getByRole('dialog'), 'the modal is v-if-gated, not always mounted').toHaveCount(0)
  await page.getByRole('button', { name: 'Transakcie' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

test.describe('Transactions modal — the NeoModal shell', () => {
  test('opens from the balance card, teleported out of .app onto .modal-layer', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)

    const dialog = await openModal(page)
    await expect(dialog.locator('.m-title')).toHaveText('Všetky transakcie')

    // The house shell, not radix: one `.modal-layer` directly under <body>, and
    // nothing inside `.app`. (`.app > *` neutralises Tailwind positioning, which
    // is exactly why every friend dialog must teleport.)
    await expect(page.locator('body > .modal-layer > .modal-scrim > .modal')).toHaveCount(1)
    await expect(page.locator('.app .modal'), 'the dialog must not live inside .app').toHaveCount(0)

    // `wide` — 520px, the old `max-w-lg`'s counterpart.
    await expect(dialog).toHaveCSS('max-width', '520px')
  })

  test('the × closes it and unmounts it; exactly one control answers to "Zavrieť"', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)

    const dialog = await openModal(page)

    // ⚠ NeoModal's × is named "Zatvoriť dialóg", a deliberate SYNONYM: Playwright
    // matches accessible names as a case-insensitive SUBSTRING unless
    // `exact: true`, so an × named "Zavrieť…" would collide with the footer
    // button below and throw a strict-mode violation.
    await expect(dialog.getByRole('button', { name: 'Zavrieť' })).toHaveCount(1)
    await expect(dialog.locator('[aria-label="Zatvoriť dialóg"]')).toHaveCount(1)

    await dialog.locator('[aria-label="Zatvoriť dialóg"]').click()
    await expect(page.getByRole('dialog'), 'closing must UNMOUNT, or the scrim keeps eating clicks').toHaveCount(0)
    // The scrim really is gone: the button underneath is clickable again.
    await page.getByRole('button', { name: 'Transakcie' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

test.describe('Transactions modal — rows', () => {
  test('renders one row per transaction with date, type label and context', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)

    const dialog = await openModal(page)
    const rows = dialog.locator('[data-testid="tx-row"]')
    await expect(rows).toHaveCount(3)

    // Type labels — `payment`→Platba, `charge`→Účtovanie, `adjustment`→Kredit.
    await expect(rows.nth(0).locator('[data-testid="tx-type"]')).toHaveText('Účtovanie')
    await expect(rows.nth(1).locator('[data-testid="tx-type"]')).toHaveText('Platba')
    await expect(rows.nth(2).locator('[data-testid="tx-type"]')).toHaveText('Kredit')

    // `sk-SK` numeric date. `\s` rather than a literal space: Chromium's sk-SK
    // formatter separates the parts with U+00A0/U+202F depending on ICU build.
    await expect(rows.nth(0).locator('[data-testid="tx-meta"]')).toHaveText(/^4\.\s*3\.\s*2026\s*·\s*Marcový cyklus$/)
    // `cycle_name || note` — the note is the fallback…
    await expect(rows.nth(1).locator('[data-testid="tx-meta"]')).toHaveText(/^6\.\s*3\.\s*2026\s*·\s*Prevod na účet$/)
    // …and with neither, the date stands alone with no orphaned separator.
    await expect(rows.nth(2).locator('[data-testid="tx-meta"]')).toHaveText(/^1\.\s*4\.\s*2026$/)
  })

  test('⚠ the sign and colour rule: a charge is danger `.neg`, a credit is ok-deep with a leading +', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)

    const dialog = await openModal(page)
    const amounts = dialog.locator('[data-testid="tx-amount"]')

    const charge = amounts.nth(0)
    await expect(charge).toHaveText('-24.50 EUR')
    await expect(charge, 'money-bad is the theme money class, not a Tailwind red').toHaveClass(/\bneg\b/)
    await expect(charge).toHaveCSS('color', DANGER)

    const payment = amounts.nth(1)
    await expect(payment, 'the + is the shipped sign rule for amount > 0').toHaveText('+30.00 EUR')
    await expect(payment).not.toHaveClass(/\bneg\b/)
    await expect(payment).toHaveCSS('color', OK_DEEP)
    await expect(payment).toHaveCSS('font-weight', '700')

    await expect(amounts.nth(2)).toHaveText('+5.25 EUR')
  })

  test('the balance renders the same three money states the card does', async ({ page }) => {
    // ⚠ `BalanceBadge.vue` is NOT reused here — it is shared with five admin
    // views. This asserts the three-state span this dialog renders instead.
    await signIn(page)
    await stubTransactions(page, ROWS)

    await stubBalance(page, -74.24)
    let dialog = await openModal(page)
    await expect(dialog.locator('.m-head .neg.pill')).toHaveText('-74.24 EUR')

    await page.unroute('**/api/friends/*/balance')
    await stubBalance(page, 0)
    dialog = await openModal(page)
    await expect(dialog.locator('.m-head .zero')).toHaveText('0.00 EUR')
    await expect(dialog.locator('.m-head .neg')).toHaveCount(0)

    await page.unroute('**/api/friends/*/balance')
    await stubBalance(page, 12.5)
    dialog = await openModal(page)
    const positive = dialog.locator('.m-head .mono')
    await expect(positive).toHaveText('+12.50 EUR')
    await expect(positive).toHaveCSS('color', OK_DEEP)
  })
})

// ---------------------------------------------------------------------------
// The three data states
// ---------------------------------------------------------------------------

test.describe('Transactions modal — loading / empty / error', () => {
  test('empty: "Žiadne transakcie" and no list at all', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await stubTransactions(page, [])

    const dialog = await openModal(page)
    await expect(dialog.getByText('Žiadne transakcie')).toBeVisible()
    await expect(dialog.locator('[data-testid="tx-list"]')).toHaveCount(0)
  })

  test('error: the house `.banner.danger.slim`, and no rows behind it', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -5)
    await page.route('**/api/transactions/friend/*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Transakcie sa nepodarilo načítať' }),
    }))

    const dialog = await openModal(page)
    const banner = dialog.locator('.banner.danger.slim')
    await expect(banner).toContainText('Transakcie sa nepodarilo načítať')
    await expect(banner.locator('.dot')).toHaveCount(1)
    await expect(dialog.locator('[data-testid="tx-list"]')).toHaveCount(0)
    // Not "empty" — a failed load must never read as "you have no transactions".
    await expect(dialog.getByText('Žiadne transakcie')).toHaveCount(0)
  })

  test('loading: "Načítavam..." while the request is in flight, then the rows', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -5)

    let release
    const held = new Promise((resolve) => { release = resolve })
    await page.route('**/api/transactions/friend/*', async (route) => {
      await held
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) })
    })

    const dialog = await openModal(page)
    await expect(dialog.getByText('Načítavam...')).toBeVisible()
    await expect(dialog.locator('[data-testid="tx-row"]')).toHaveCount(0)

    release()
    await expect(dialog.locator('[data-testid="tx-row"]')).toHaveCount(3)
    await expect(dialog.getByText('Načítavam...')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 320px
// ---------------------------------------------------------------------------

test.describe('Transactions modal — 320px', () => {
  test('⚠ an unbreakable cycle name cannot scroll the modal sideways', async ({ page }) => {
    // `min-width:0` lets a flex item SHRINK; it does NOTHING about a token with
    // no break opportunity, which paints straight out of its column. Cycle names
    // are free admin text, so the row's text container carries
    // `overflow-wrap:anywhere` — the RD-FO-2 product-card precedent. The fixture
    // name is spelled without a hyphen on purpose: `-` is a break opportunity and
    // would make this test pass without the property.
    //
    // ⚠ THE DOCUMENT IS THE WRONG THING TO MEASURE HERE, and only measuring it is
    // how this test was first written — vacuously. `.modal-scrim` is
    // `overflow-y:auto`, and CSS computes the other axis of a non-`visible`
    // overflow to `auto` as well, so the scrim absorbs any width the modal spills
    // and `documentElement.scrollWidth` never moves. Measured with the property
    // deleted: document 320/320 (green), scrim **399**/320, row **342**/206.
    // The scrim and the row are therefore the load-bearing measurements; the
    // document assertion stays as the outer guard it is elsewhere in this suite.
    const monster = 'Predvianocnyspecialnyvelkoobjemovycykluskavy2026'
    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await stubBalance(page, -1234.56)
    await stubTransactions(page, [
      { id: 950, type: 'charge', amount: -1234.56, created_at: '2026-03-04 12:00:00', cycle_name: monster, note: null },
      ...ROWS,
    ])

    const dialog = await openModal(page)
    // Non-vacuity: the monster really is on screen.
    await expect(dialog.locator('[data-testid="tx-meta"]').first()).toContainText(monster)

    const wrap = await dialog.locator('[data-testid="tx-row"]').first()
      .locator('[data-testid="tx-meta"]')
      .evaluate((el) => getComputedStyle(el).overflowWrap)
    expect(wrap, 'overflow-wrap must reach the text, by inheritance from its container').toBe('anywhere')

    const m = await page.evaluate(() => {
      const scrim = document.querySelector('.modal-scrim')
      const row = document.querySelector('[data-testid="tx-row"]')
      return {
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        scrimScroll: scrim.scrollWidth,
        scrimClient: scrim.clientWidth,
        rowScroll: row.scrollWidth,
        rowClient: row.clientWidth,
      }
    })
    expect(m.rowScroll, `the row spills its own column: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.rowClient)
    expect(m.scrimScroll, `the modal scrolls sideways: ${JSON.stringify(m)}`).toBe(m.scrimClient)
    expect(m.docScroll, `the document scrolls sideways: ${JSON.stringify(m)}`).toBe(m.docClient)
  })
})

// ---------------------------------------------------------------------------
// Admin invariance
// ---------------------------------------------------------------------------

test.describe('Transactions modal — admin invariance', () => {
  // ⚠ `BalanceBadge.vue` is imported by AdminFriends, FriendDetail, Distribution,
  // CycleDetail and three admin dialogs. Restyling it — the obvious shortcut for
  // "make the balance in the modal look neobrutal" — would leak the theme across
  // the whole admin surface. The friend side renders its own three-state span
  // instead, and this pins that the shared component was left alone.
  test('BalanceBadge.vue is untouched on this branch', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    // Self-skips off a git checkout (the `DB_PATH` precedent), so running the
    // suite against staging from a tarball reports a skip, not a false red.
    test.skip(!existsSync(resolve(repo, '.git')), 'needs a git checkout')
    const diff = execFileSync(
      'git',
      ['diff', '--stat', 'main', '--', 'frontend/src/components/BalanceBadge.vue'],
      { cwd: repo, encoding: 'utf8' }
    ).trim()
    expect(diff, `BalanceBadge.vue changed:\n${diff}`).toBe('')
  })

  test('no theme/neo class reaches the admin surface that renders the same balance', async ({ page }) => {
    // ⚠ Runs LAST and logs in through the UI: the backend keeps exactly ONE live
    // admin session, so this invalidates `adminToken`. Nothing after it uses the
    // API context.
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    await page.goto('/admin/friends')
    await expect(page.getByRole('heading', { name: /Priatelia/ }).first()).toBeVisible()

    const leaked = await page.evaluate(() => {
      // Distinctly theme-only selectors. `.card` and `.btn` are deliberately
      // absent — they are generic enough that an admin view could own them for
      // its own reasons, and a false red there would teach nothing.
      const bad = [
        '.app', '.modal-layer', '.modal-scrim', '.m-title',
        '.field-lbl', '.copyrow', '.banner', '.appbar',
        '.suborder', '.neg', '.zero',
      ]
      return bad.filter((sel) => document.querySelector(sel) !== null)
    })
    expect(leaked, JSON.stringify(leaked)).toEqual([])

    // Non-vacuity: BalanceBadge really is on this page, in its shadcn skin.
    await expect(page.locator('span.inline-flex.rounded').first()).toBeVisible()
  })
})
