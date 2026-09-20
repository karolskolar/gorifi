import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
import { expectLanding, menuGo, dismissLandingState } from '../helpers/portal.js'
import { assertReadable, code, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// „Zostatok a platby“ — 18 §UC-PI-010, plus §UC-PI-019 items 7 and 9.
//
// ⚠⚠ THIS FILE IS A RENAME, NOT A NEW ONE. It was `portal-transactions-modal.spec.js`
// (11 tests over `FriendTransactionsModal.vue`, which PI-T7 DELETES) and it absorbs
// `portal-appbar.spec.js`'s „Balance card — three money states“ describe (7 tests),
// which §UC-PI-019 item 7 parks here. The full migration mapping — every test kept,
// retargeted or dropped-because-unsatisfiable, with its reason — is in
// `docs/learnings/10-portal-ia.md` §PI-T7. The three summary rules it comes from:
//
//   · the modal SHELL pins are structurally unsatisfiable (`.m-title 'Všetky
//     transakcie'`, `body > .modal-layer`, `[aria-label="Zatvoriť dialóg"]`, the
//     520px `wide`) — the list renders IN PAGE now. §1 pins the replacement property
//     (nothing teleports, no dialog is parked) rather than deleting the question.
//   · every `tx-*` row pin, the sign/colour rule, the loading/empty/error copy, the
//     320px unbreakable-name test and the admin-invariance describe are KEPT —
//     retargeted from the dialog to the page, and nothing else.
//   · the card's money CLASSES changed by canon (`portal2.jsx:232` / §UC-PI-010:
//     one `.display` at 38px, not `.neg.pill` at 16px), so the appbar describe's
//     pill geometry is retargeted onto the display. The three STATES it asserted —
//     red debt, muted-green zero, green credit with a leading „+“ — are the
//     protected property and every one of them is still here.
//
// ⚠ A MIGRATED ASSERTION THAT CANNOT FAIL IS WORSE THAN A DELETED ONE. Every
// absence pin below is preceded by a non-vacuity gate, and the source pins go
// through `assertReadable()` (see `helpers/source-pins.js` — the comment-strip hole
// that made a third of a file invisible).
//
// ⚠ HERMETIC, per `portal-appbar.spec.js`'s idiom: this file provisions its own
// friend over the admin API, signs the browser in with a REAL session token, and
// stubs balance + transactions where a specific state is under test.

const TIMEOUT = 20_000

// Theme tokens (`friends-theme.css:14`) as Chromium serialises them.
const DANGER = 'rgb(209, 26, 91)' // --danger
const OK_DEEP = 'rgb(15, 93, 60)' // --ok-deep

let ctx = null
let adminToken = ''
let friend = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

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

/**
 * ⚠ `payment` IS PART OF THE PAYLOAD (15 §UC-PL-003 item 4) and a stub that omits it
 * is asserting „no payment settings configured“, not „a balance“. Pass `null`
 * deliberately where that is the point (§2's last test).
 */
const PAYMENT_BLOCK = {
  amount: 74.24,
  reference: 'RDTX / zostatok',
  iban: 'SK3112000000198742637541',
  revolut_username: 'gorifitest',
  variable_symbol: '8000123',
  creditor_name: 'Gorifi',
}

async function stubBalance(page, balance, payment = PAYMENT_BLOCK) {
  await page.route('**/api/friends/*/balance', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance, transactions: [], payment }),
  }))
}

/** `GET /api/transactions/friend/:id` — the list's only call (`api.js:441`). */
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

/**
 * ⚠ THE CYCLES PAYLOAD IS STUBBED IN EVERY TEST, and that is not decoration. The
 * landing resolves to `closed` against whatever rounds the template happens to
 * carry, and a `closed` landing mounts `LandingStateModal` automatically
 * (§UC-PI-006, once per session) — a full-viewport `.modal-scrim` that intercepts
 * the appbar's Menu click. Pinning ONE completed round makes the state the same on
 * every target, so `dismissLandingState()` is always applicable and never a guess
 * (learnings 10 §11).
 */
async function stubCycles(page) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{
      id: 81_001, name: `RDTX Round ${uniq}`, status: 'completed',
      created_at: '2026-03-01 10:00:00', total_friends: 0, expected_date: null,
      type: 'coffee', plan_note: null, opens_at: null, closes_at: null, stage: null,
      parcel_enabled: 0, parcel_fee: 0, hasOrder: false, orderTotal: 0,
      orderStatus: null, orderKilos: 0, orderItemCount: 0, orderPickupName: null,
      orderPacketa: false, orderPaid: false, orderHandedOver: false,
    }]),
  }))
}

/** Land on `path` with the cycles response already in (PI-T1 §9's early-read trap). */
async function open(page, path) {
  await stubCycles(page)
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

async function openPortal(page) {
  await open(page, '/')
  // §UC-PI-006's modal is a dialog with a scrim — out of the way before anything
  // clicks the appbar. Non-`shop` views never mount it, hence its absence below.
  await dismissLandingState(page)
}

/**
 * Open „Zostatok a platby“ — the RETARGET of the deleted `openModal()`, which
 * clicked „Transakcie“ on the landing's balance card. Both the card and the ledger
 * are a VIEW now (§UC-PI-019 item 9).
 *
 * ⚠ It enters by URL rather than through the drawer, deliberately: every test below
 * is about the VIEW, and routing each one through the menu would make the drawer a
 * shared dependency of all of them. The drawer entry point §UC-PI-019 item 9 names
 * is pinned once, on its own, in §1.
 */
async function openBalance(page) {
  await open(page, '/zostatok')
  await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'balance')
  await expect(page.getByRole('heading', { name: 'Zostatok a platby' })).toBeVisible()
  await expect(page.getByRole('dialog'), 'a non-`shop` view mounts no state modal').toHaveCount(0)
}

const card = (page) => page.locator('.card').filter({ hasText: 'Môj účet' })

// ---------------------------------------------------------------------------
// 1. The surface — in page, not in a dialog
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — the view replaces the modal', () => {
  // ⚠ RETARGET of „opens from the balance card, teleported out of .app onto
  // .modal-layer". The teleport question is what made sense for a NeoModal; with no
  // modal the surviving question is its inverse, and it is the one worth keeping:
  // this screen must park NO dialog at all, because a `.modal-scrim` is
  // `pointer-events:auto` and eats every click on the page behind it.
  test('the account card and the ledger render IN PAGE, with no dialog parked', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)
    await openBalance(page)

    // Non-vacuity: the surface really rendered before anything is asserted absent.
    await expect(card(page)).toBeVisible()
    await expect(page.getByTestId('tx-list')).toBeVisible()
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(3)

    // Both live INSIDE the session's page column, i.e. inside `.app` — the exact
    // opposite of where the modal had to live.
    await expect(page.locator('.app [data-testid="portal-landing"] [data-testid="tx-list"]')).toHaveCount(1)
    await expect(page.locator('.app [data-testid="portal-landing"]').locator('.card', { hasText: 'Môj účet' })).toHaveCount(1)

    // ⚠ THE STRUCTURES THAT ARE GONE — the modal-shell pins §UC-PI-019 item 9 calls
    // unsatisfiable, asserted as ABSENT rather than silently dropped.
    await expect(page.getByRole('dialog'), 'the ledger is not a dialog any more').toHaveCount(0)
    await expect(page.locator('body > .modal-layer > .modal-scrim > .modal')).toHaveCount(0)
    await expect(page.getByText('Všetky transakcie'), 'the modal title is retired').toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Transakcie' }),
      '§UC-PI-010: „the „Transakcie“ button is removed"').toHaveCount(0)
  })

  // ⚠ RETARGET of „the × closes it and unmounts it; exactly one control answers to
  // Zavrieť". The × and the footer button belong to a shell that is gone — but the
  // PROPERTY („a dialog on this screen must UNMOUNT on close, or its scrim keeps
  // eating clicks") applies to the one dialog this view still has, the balance
  // `PaymentModal`. Carried over onto it.
  test('the one dialog this view has opens from „Zaplatiť“ and UNMOUNTS on close', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)
    await openBalance(page)

    await expect(page.getByRole('dialog'), 'nothing is mounted until it is opened').toHaveCount(0)
    await page.getByTestId('pay-balance').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog, 'ONE modal, not two — the mount is relocated, never duplicated').toHaveCount(1)
    await expect(dialog.locator('.m-title')).toHaveText('Platba')
    await expect(dialog).toContainText('74.24 EUR')

    await dialog.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog'), 'closing must UNMOUNT, or the scrim keeps eating clicks').toHaveCount(0)
    // The scrim really is gone: the trigger underneath is clickable again.
    await page.getByTestId('pay-balance').click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
  })

  // §UC-PI-019 item 9's named entry point, pinned once: „open via
  // `menuGo(page, 'Zostatok a platby')`". The rest of this file enters by URL so
  // that the drawer is not a shared dependency of every money assertion.
  test('the drawer item „Zostatok a platby“ is the way in', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)
    await openPortal(page)

    // Non-vacuity: we really start somewhere else.
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
    await menuGo(page, 'Zostatok a platby')

    await expect(page).toHaveURL(/\/zostatok$/)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'balance')
    await expect(page.locator('.appbar .titles .s'), 'the appbar subtitle follows the view')
      .toHaveText('Zostatok a platby')
    await expect(card(page)).toBeVisible()
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(3)
  })
})

// ---------------------------------------------------------------------------
// 2. The account card — three money states (§UC-PI-010 item 1)
//    ⚠ MOVED HERE from `portal-appbar.spec.js`'s „Balance card" describe
//    (§UC-PI-019 item 7), retargeted from the landing onto `/zostatok`.
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — the account card', () => {
  test('a negative balance renders the 38px display in danger, on a highlighted card', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, [])
    await openBalance(page)

    await expect(card(page).locator('.field-lbl')).toHaveText('Môj účet')

    // ⚠ RETARGET, case (a): this asserted `.neg.pill` at 16px with a 2px border and
    // a `--danger-soft` fill. §UC-PI-010 (and `portal2.jsx:232` before it) replaces
    // the pill with ONE `.display` at 38px, and the two cannot be combined —
    // `friends-theme.css:216` declares `.neg{font-family:var(--font-mono);
    // font-size:13px}` AFTER `:25`'s `.display`, at equal specificity. The protected
    // property was never the pill: it is „a debt is painted in the danger token".
    const value = page.getByTestId('balance-amount')
    await expect(value).toHaveText('-74.24 EUR')
    await expect(value).toHaveCSS('color', DANGER)
    await expect(value).toHaveCSS('font-size', '38px')
    await expect(value, 'the canon paints it in the display face').toHaveClass(/\bdisplay\b/)
    await expect(card(page), '`.hl` only while the friend owes something').toHaveClass(/\bhl\b/)

    // The sentence the row is required to keep, verbatim.
    await expect(page.getByTestId('balance-sub'))
      .toHaveText('Nedoplatok — po zaplatení sa zostatok vyrovná do 1–2 dní.')
  })

  test('a settled balance renders the muted zero state and offers nothing', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await stubTransactions(page, [])
    await openBalance(page)

    const value = page.getByTestId('balance-amount')
    await expect(value).toHaveText('0.00 EUR')
    await expect(value).toHaveCSS('color', OK_DEEP)
    await expect(page.getByTestId('balance-sub')).toHaveText('Všetko vyrovnané.')
    await expect(page.getByTestId('pay-balance'), 'nothing is owed, nothing is asked for').toHaveCount(0)
    await expect(card(page), 'and the card is not highlighted').not.toHaveClass(/\bhl\b/)
  })

  test('a positive balance keeps the recorded OPEN default: green with a + sign', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 12.5)
    await stubTransactions(page, [])
    await openBalance(page)

    const value = page.getByTestId('balance-amount')
    await expect(value).toHaveText('+12.50 EUR')
    await expect(value).toHaveCSS('color', OK_DEEP)
    await expect(page.getByTestId('balance-sub')).toHaveText('Všetko vyrovnané.')
    await expect(page.getByTestId('pay-balance'), 'credit is not a debt').toHaveCount(0)
  })

  test('„Zaplatiť {suma}“ is the block\'s amount, and it is `.btn.accent.block`', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, [])
    await openBalance(page)

    const pay = page.getByTestId('pay-balance')
    await expect(pay).toHaveText('Zaplatiť 74.24 EUR')
    await expect(pay).toHaveClass(/\baccent\b/)
    await expect(pay).toHaveClass(/\bblock\b/)
    // UC-DS-005 hit target — carried over from the „Transakcie" button's pin.
    expect((await pay.boundingBox()).height).toBeGreaterThanOrEqual(38)
  })

  test('a failed balance load renders .banner.danger.slim inside the card and hides the button', async ({ page }) => {
    await signIn(page)
    await stubTransactions(page, [])
    await page.route('**/api/friends/*/balance', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Zostatok sa nepodarilo načítať' }),
    }))
    await openBalance(page)

    await expect(card(page).locator('.banner.danger.slim')).toContainText('Zostatok sa nepodarilo načítať')
    await expect(page.getByTestId('pay-balance')).toHaveCount(0)
    await expect(page.getByTestId('balance-amount'), 'no number is invented over a failure').toHaveCount(0)
  })

  test('the loading state shows "Načítavam..." before the balance resolves', async ({ page }) => {
    await signIn(page)
    await stubTransactions(page, [])

    // ⚠ THE HOLD MUST OUTLAST THE ASSERTION WINDOW. Playwright retries for 10s
    // (`playwright.config.js`), so a 5s hold would let the discriminating assertion
    // pass against the RESOLVED screen. This one is released explicitly; nothing
    // below it can observe the loading state by accident.
    let release
    const held = new Promise((resolve) => { release = resolve })
    await page.route('**/api/friends/*/balance', async (route) => {
      await held
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ balance: -5, transactions: [], payment: PAYMENT_BLOCK }),
      })
    })

    await openBalance(page)
    await expect(card(page).locator('.sub')).toHaveText('Načítavam...')
    await expect(page.getByTestId('balance-amount')).toHaveCount(0)
    release()
    await expect(page.getByTestId('balance-amount')).toHaveText('-5.00 EUR')
  })

  test('⚠ BalanceBadge is still the admin component — the card must not render it', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, [])
    await openBalance(page)

    // BalanceBadge's signature is its Tailwind palette pills
    // (`bg-red-100` / `bg-green-100` / `bg-gray-100` + `inline-flex rounded`).
    // It is SHARED WITH ADMIN, so the restyle had to stop importing it rather
    // than edit it — the card renders the theme's own money classes instead.
    await expect(card(page).locator('.bg-red-100, .bg-green-100, .bg-gray-100')).toHaveCount(0)
    await expect(card(page).locator('.inline-flex.rounded')).toHaveCount(0)
    await expect(card(page).getByTestId('balance-amount'), 'non-vacuity: the money really is rendered').toHaveCount(1)
  })

  test('no payment block ⇒ no „Zaplatiť“, and the debt is still shown', async ({ page }) => {
    // Not hypothetical: a deployment with neither an IBAN nor a Revolut handle
    // configured answers exactly this. A surface with no payment data offers no
    // payment control rather than a made-up one (15 §UC-PL-007 business rules).
    await signIn(page)
    await stubBalance(page, -30, null)
    await stubTransactions(page, [])
    await openBalance(page)

    await expect(page.getByTestId('balance-amount'), 'non-vacuity: the debt is on screen').toHaveText('-30.00 EUR')
    await expect(page.getByTestId('pay-balance'), 'no block, no button').toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The ledger rows — KEPT from the modal, verbatim but for the scope
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — the ledger rows', () => {
  test('renders one row per transaction with date, type label and context', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)
    await openBalance(page)

    const rows = page.locator('[data-testid="tx-row"]')
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
    await openBalance(page)

    const amounts = page.locator('[data-testid="tx-amount"]')

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
})

// ---------------------------------------------------------------------------
// 4. The three data states — KEPT from the modal
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — loading / empty / error', () => {
  test('empty: "Žiadne transakcie" and no list at all', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, 0)
    await stubTransactions(page, [])
    await openBalance(page)

    await expect(page.getByText('Žiadne transakcie')).toBeVisible()
    await expect(page.locator('[data-testid="tx-list"]')).toHaveCount(0)
  })

  test('error: the house `.banner.danger.slim`, and no rows behind it', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -5)
    await page.route('**/api/transactions/friend/*', (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Transakcie sa nepodarilo načítať' }),
    }))
    await openBalance(page)

    // ⚠ SCOPED OFF THE CARD. The account card renders its OWN `.banner.danger.slim`
    // on a balance failure (§2), and this screen can show both at once — an
    // unscoped locator would let the card's banner satisfy the ledger's assertion.
    const banner = page.locator('.banner.danger.slim').filter({ hasText: 'Transakcie sa nepodarilo načítať' })
    await expect(banner).toHaveCount(1)
    await expect(banner.locator('.dot')).toHaveCount(1)
    await expect(page.locator('[data-testid="tx-list"]')).toHaveCount(0)
    // Not "empty" — a failed load must never read as "you have no transactions".
    await expect(page.getByText('Žiadne transakcie')).toHaveCount(0)
  })

  test('loading: "Načítavam..." while the request is in flight, then the rows', async ({ page }) => {
    await signIn(page)
    await stubBalance(page, -5)

    // ⚠ Held until `release()`, for the reason §2's loading test states: the
    // assertion window is 10s, so a timed hold shorter than that proves nothing.
    let release
    const held = new Promise((resolve) => { release = resolve })
    await page.route('**/api/transactions/friend/*', async (route) => {
      await held
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) })
    })

    await openBalance(page)
    // ⚠ Scoped: the card above renders no „Načítavam..." here (its own fetch
    // resolved), but scoping is what keeps this true if that ever changes.
    await expect(page.getByTestId('tx-list')).toHaveCount(0)
    await expect(page.locator('[data-testid="portal-landing"]').getByText('Načítavam...')).toBeVisible()
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(0)

    release()
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(3)
    await expect(page.locator('[data-testid="portal-landing"]').getByText('Načítavam...')).toHaveCount(0)
  })

  test('re-entering the view reloads BOTH the balance and the ledger (§UC-PI-010)', async ({ page }) => {
    // „a payment marked by the admin shows after re-entering the view — no polling".
    await signIn(page)
    let balanceReads = 0
    let txReads = 0
    page.on('request', (req) => {
      if (/\/api\/friends\/\d+\/balance/.test(req.url())) balanceReads++
      if (/\/api\/transactions\/friend\/\d+/.test(req.url())) txReads++
    })
    await stubBalance(page, -74.24)
    await stubTransactions(page, ROWS)

    await openPortal(page)
    // ⚠ THE LANDING MAKES EXACTLY ONE BALANCE READ — PI-T7 collapsed the two PI-T2
    // left behind (the card's own fetch is gone). `payment-links.spec.js` carries
    // the same claim as its own exact-count pin.
    await expect(page.getByTestId('debt-banner')).toBeVisible()
    expect(balanceReads, 'one reader on a landing load: the session').toBe(1)
    expect(txReads, 'the landing reads no ledger at all').toBe(0)

    await menuGo(page, 'Zostatok a platby')
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(3)
    expect(balanceReads, 'entering the view re-reads the balance').toBe(2)
    expect(txReads, 'and the ledger').toBe(1)

    // Leave and come back IN-SESSION (a client-side route change, not a reload):
    // the view's own reload is what must fire, not the session handshake's.
    await page.goBack()
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-view', 'shop')
    await menuGo(page, 'Zostatok a platby')
    await expect(page.locator('[data-testid="tx-row"]')).toHaveCount(3)
    expect(balanceReads, 're-entering the view reloads it again').toBe(3)
    expect(txReads, 'and re-mounts the ledger').toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 5. 320px — KEPT, with the outer measurement moved
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — 320px', () => {
  test('⚠ an unbreakable cycle name cannot scroll the page sideways', async ({ page }) => {
    // `min-width:0` lets a flex item SHRINK; it does NOTHING about a token with
    // no break opportunity, which paints straight out of its column. Cycle names
    // are free admin text, so the row's text container carries
    // `overflow-wrap:anywhere` — the RD-FO-2 product-card precedent. The fixture
    // name is spelled without a hyphen on purpose: `-` is a break opportunity and
    // would make this test pass without the property.
    //
    // ⚠ THE OUTER MEASUREMENT MOVED WITH THE MARKUP, and this is the one place the
    // rename changes what is measured. In the modal, `.modal-scrim` was
    // `overflow-y:auto` — CSS computes the other axis of a non-`visible` overflow to
    // `auto` too — so the scrim absorbed any spill and `documentElement.scrollWidth`
    // never moved; the SCRIM and the ROW were the load-bearing pair (measured then:
    // document 320/320 green, scrim 399/320, row 342/206). There is no scrim in the
    // page, so the pair is now the ROW and the DOCUMENT.
    const monster = 'Predvianocnyspecialnyvelkoobjemovycykluskavy2026'
    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await stubBalance(page, -1234.56)
    await stubTransactions(page, [
      { id: 950, type: 'charge', amount: -1234.56, created_at: '2026-03-04 12:00:00', cycle_name: monster, note: null },
      ...ROWS,
    ])
    await openBalance(page)

    // Non-vacuity: the monster really is on screen.
    await expect(page.locator('[data-testid="tx-meta"]').first()).toContainText(monster)

    const wrap = await page.locator('[data-testid="tx-row"]').first()
      .locator('[data-testid="tx-meta"]')
      .evaluate((el) => getComputedStyle(el).overflowWrap)
    expect(wrap, 'overflow-wrap must reach the text, by inheritance from its container').toBe('anywhere')

    const m = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="tx-row"]')
      const col = document.querySelector('[data-testid="portal-landing"]')
      return {
        docScroll: document.documentElement.scrollWidth,
        docClient: document.documentElement.clientWidth,
        colScroll: col.scrollWidth,
        colClient: col.clientWidth,
        rowScroll: row.scrollWidth,
        rowClient: row.clientWidth,
      }
    })
    expect(m.rowScroll, `the row spills its own column: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.rowClient)
    expect(m.colScroll, `the page column scrolls sideways: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.colClient)
    expect(m.docScroll, `the document scrolls sideways: ${JSON.stringify(m)}`).toBe(m.docClient)
  })
})

// ---------------------------------------------------------------------------
// 6. ONE trigger, ONE mount — the source pins (§UC-PI-010, CLAUDE.md §Money & data)
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — relocated, never duplicated', () => {
  // ⚠⚠ WHY A SOURCE PIN AND NOT A DOM ONE. Two `PaymentModal` mounts for the balance
  // are INVISIBLE in the DOM: each is `v-if`-gated on its own `showPayment`, they sit
  // on different views, and nothing renders twice. They are only observable the day
  // the two disagree about what the friend owes — i.e. after the damage. The count
  // has to be read off the source, per file, and every read below goes through
  // `assertReadable()` because an absence pin over text the comment strip ate is the
  // vacuous thing that helper exists to prevent.
  test.skip(!HAS_SRC, NEEDS_SRC)

  test('exactly ONE `pay-balance` control and ONE balance `PaymentModal` in the tree', async () => {
    const sessionSrc = assertReadable('views/FriendPortalSession.vue', [
      'openBalancePayment', 'balancePayment', '<PaymentModal', 'DebtBanner',
    ])
    const cardSrc = assertReadable('components/FriendBalanceCard.vue', [
      'data-testid="pay-balance"', 'canPayBalance', 'balanceState',
    ])
    const bannerSrc = assertReadable('components/DebtBanner.vue', [
      'data-testid="debt-banner"', 'inDebt', 'canPay',
    ])
    const listSrc = assertReadable('components/FriendTransactionList.vue', [
      'data-testid="tx-list"', 'getTransactions',
    ])

    const count = (src, needle) => src.split(needle).length - 1

    // THE TRIGGER. One element carries the testid, and it is the card's.
    expect(count(cardSrc, 'data-testid="pay-balance"'), 'the card owns the one trigger').toBe(1)
    expect(count(sessionSrc, 'pay-balance'), 'the session mounts no second trigger').toBe(0)
    expect(count(bannerSrc, 'pay-balance'),
      'the banner has its own testid — two `pay-balance` would make every lookup ambiguous').toBe(0)

    // THE MOUNT. One `<PaymentModal` for the balance, in the session view.
    expect(count(sessionSrc, '<PaymentModal'), 'exactly one balance PaymentModal mount').toBe(1)
    for (const [name, src] of [['FriendBalanceCard.vue', cardSrc], ['DebtBanner.vue', bannerSrc], ['FriendTransactionList.vue', listSrc]]) {
      expect(count(src, 'PaymentModal'), `${name} must mount no PaymentModal of its own`).toBe(0)
    }

    // THE FETCH. One `getFriendBalance` call on the friend surface, in the session.
    expect(count(sessionSrc, 'getFriendBalance'), 'one balance reader').toBe(1)
    expect(count(cardSrc, 'getFriendBalance'), 'the card fetches nothing any more').toBe(0)
    expect(count(cardSrc, "from '../api'") + count(cardSrc, "from '@/api'"),
      'and it imports no api at all').toBe(0)

    // THE THREE CALL SITES. One component, three mounts (open / closed / locked),
    // and the debt predicate IMPORTED, not restated.
    expect(count(sessionSrc, '<DebtBanner'), 'one banner per landing state, three in all').toBe(3)

    // ⚠⚠ REWRITTEN AT THE PI-T7 REVIEW. The earlier version asserted „the landing debt
    // threshold has one home" by counting `-0.01` inside the BANNER, and separately
    // blessed the session's copy as „the drawer badge's tone, not a restatement". That
    // pair did not guard the rule — it ENTRENCHED the split: the comparison was live in
    // three files (banner, card, drawer badge) while four documents called it one home,
    // and only the banner's copy had a boundary fixture, so a banner-vs-card disagreement
    // anywhere between −0.01 and −1.00 was invisible. The predicate now lives in
    // `lib/money.js isInDebt()`; what this sweep asserts is that NO friend-surface file
    // restates the literal.
    const moneySrc = code('lib/money.js')
    expect(count(moneySrc, '-0.01'), 'the one home declares the threshold').toBeGreaterThan(0)
    for (const [label, src] of [['DebtBanner', bannerSrc], ['FriendBalanceCard', cardSrc], ['FriendPortalSession', sessionSrc]]) {
      expect(count(src, '-0.01'), `${label} imports the predicate and restates no threshold`).toBe(0)
      expect(src, `${label} reads the one home`).toMatch(/isInDebt|balanceState/)
    }
  })

  test('`FriendTransactionsModal.vue` is gone, and nothing imports it', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    expect(existsSync(resolve(repo, 'frontend/src/components/FriendTransactionsModal.vue')),
      'the modal is deleted, not orphaned').toBe(false)

    const sessionSrc = assertReadable('views/FriendPortalSession.vue', ['FriendTransactionList', 'FriendBalanceCard'])
    expect(sessionSrc).not.toContain("FriendTransactionsModal.vue'")
    // Non-vacuity: the component that REPLACES it really is imported here.
    expect(sessionSrc).toContain("import FriendTransactionList from '@/components/FriendTransactionList.vue'")
  })

  test('nothing on this surface writes a `transactions` row', async () => {
    // CLAUDE.md §Money & data: rows come only from the friend paid toggle and
    // pack/unpack, both admin-side. `paid` is admin-only. The friend-side money
    // surfaces are READ-ONLY, and the cheapest durable proof is that they issue no
    // write at all — no POST/PUT/PATCH/DELETE against the ledger.
    // ⚠ NOT a keyword ban on „adjustment"/„paid": `FriendTransactionList` READS
    // `adjustment` as a row TYPE (`case 'adjustment': return 'Kredit'`) and a pin
    // that reddened on that would be repaired by weakening it. The honest, checkable
    // property is stronger and simpler — a component that never touches `api` cannot
    // write, and the one that does touch it touches exactly one READ method.
    const cardSrc = assertReadable('components/FriendBalanceCard.vue', ['canPayBalance', 'balanceState'])
    const bannerSrc = assertReadable('components/DebtBanner.vue', ['inDebt', 'canPay'])
    const listSrc = assertReadable('components/FriendTransactionList.vue', ['getTransactions', 'tx-amount'])

    expect(cardSrc, 'the card reaches no API at all').not.toContain('api')
    expect(bannerSrc, 'the banner reaches no API at all').not.toContain('api')

    // `api.js`'s ledger writers, by name (`:442`–`:454`, plus the order/guest paid
    // toggles). None of them may appear on the friend money surface.
    const writers = [
      'addPayment', 'addAdjustment', 'updateTransaction', 'deleteTransaction',
      'markPaid', 'markGuestOrderPaid', 'togglePacked',
    ]
    for (const [rel, src] of [['FriendBalanceCard.vue', cardSrc], ['DebtBanner.vue', bannerSrc], ['FriendTransactionList.vue', listSrc]]) {
      for (const verb of writers) {
        expect(src, `${rel} must not call api.${verb}`).not.toContain(verb)
      }
    }
    // The list's ONLY api reference is the read it is documented to make.
    const apiCalls = [...listSrc.matchAll(/\bapi\.(\w+)/g)].map((m) => m[1])
    expect(apiCalls, 'one call, and it is a GET').toEqual(['getTransactions'])

    // Non-vacuity: `api.js` really does export those writers under those names, so
    // the loop above is matching against live vocabulary rather than dead strings.
    const apiSrc = assertReadable('api.js', ['getTransactions', 'addAdjustment'])
    for (const verb of writers) {
      expect(apiSrc, `api.js no longer exports ${verb} — the probe above is stale`).toContain(`${verb}:`)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Admin invariance — KEPT verbatim from the modal file
// ---------------------------------------------------------------------------

test.describe('Zostatok a platby — admin invariance', () => {
  // ⚠ `BalanceBadge.vue` is imported by AdminFriends, FriendDetail, Distribution,
  // CycleDetail and three admin dialogs. Restyling it — the obvious shortcut for
  // "make the balance look neobrutal" — would leak the theme across the whole
  // admin surface. The friend side renders its own three-state span instead, and
  // this pins that the shared component was left alone.
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
