import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { assertReadable, code, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
import {
  expectLanding, drawer, openMenu, menuGo, gotoCycle,
  landingStateModal, dismissLandingState, logout,
} from '../helpers/portal.js'
import { makeAdmin } from '../helpers/admin.js'

// PI-T3 — 18 §UC-PI-005 (the landing, OPEN state), §UC-PI-011 (the two new share
// entry points), §UC-PI-016 (the cycle list, the gear and the archive retired) and
// §UC-PI-019 item 17's `portal-landing.spec.js`.
//
// ⚠⚠ THIS FILE IS HALF OF WHERE TWO DELETED SPEC FILES WENT.
// `portal-cycles.spec.js` (18 tests) and `portal-share-row.spec.js` (14 tests) were
// deleted with the cycle list they tested. The properties that SURVIVE the deletion
// are split between here and `portal-menu.spec.js` §1b:
//
//   HERE — the share dialog's ENTRY contract (it opens, it names the round it
//   shares, and it does NOT navigate: module 03's `@click.stop` claim restated on
//   the control that replaced the card's share button), and „a round that is not
//   open offers no share affordance at all" (05 §UC-KG-002).
//
//   `portal-menu.spec.js` §1b — the colleague count's copy states, the bound on its
//   fetch, and the session-scoping half of the `loadSeq` guard.
//
// Everything else those two files held was ABOUT the cards: the badge matrix, the
// `div.p-4` geometry, the archive fold, the gear, the 378px share-row rule. Those
// retire with the structures, and section 2 below pins that they are really gone
// rather than merely untested.
//
// ⚠ WHAT IS DELIBERATELY NOT HERE: the CLOSED (§UC-PI-006) and LOCKED (§UC-PI-007)
// landings are PI-T4's and PI-T5's. §UC-PI-019 item 17's list for this file covers
// all three states plus the debt banner (PI-T7); this row builds the open state, and
// the other sections arrive with the rows that build them.
//
// ⚠ HERMETIC, per the RD-FL-2 idiom: every test provisions its own friend, and its
// own REAL cycle where the grid is under test (the landing's `FriendOrder` loads its
// order from the API, so a stubbed cycles payload cannot produce a working grid).
// A cycle created here is the NEWEST open one, which is what makes it the landing's
// round (`lib/portal-state.js`). Where a specific landing STATE is needed instead,
// `GET /friends/cycles` is stubbed.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3997'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

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
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pi3_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `PI3 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0900 000 000' } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, username, token }
}

/** A REAL open cycle. Created last ⇒ the newest open ⇒ the landing's round. */
async function makeCycle(label, data = {}) {
  const name = `PI3 Round ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type: 'coffee', status: 'open', ...data },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function signIn(page, friend) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: friend.id,
    friendName: friend.name,
    token: friend.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
}

/** A cycle row shaped like `GET /friends/cycles` publishes one (for STATE fixtures). */
const cycleRow = (over) => ({
  id: 80_000 + (over.n || 0), name: `PI3 Stub ${over.n || 0}`, status: 'planned',
  created_at: over.created_at || `2026-09-0${(over.n || 1) % 9 + 1} 10:00:00`,
  total_friends: 0, expected_date: null, type: 'coffee', plan_note: null,
  opens_at: null, closes_at: null, stage: null, parcel_enabled: 0, parcel_fee: 0,
  hasOrder: false, orderTotal: 0, orderStatus: null, orderKilos: 0, orderItemCount: 0,
  orderPickupName: null, orderPacketa: false, orderPaid: false, orderHandedOver: false,
  ...over,
})

async function stubCycles(page, cycles) {
  await page.route('**/api/friends/cycles*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(cycles),
  }))
}

/**
 * Land on `/` with the cycles response already in.
 *
 * ⚠ It WAITS for `GET /friends/cycles`. `cycles` starts EMPTY on a restore, so the
 * resolver's answer before the payload lands is `closed` — an assertion that fired
 * early would read the wrong state, and „no share affordance" would pass for
 * entirely the wrong reason (PI-T1 §9).
 */
async function open(page, path = '/') {
  const served = page.waitForResponse((r) => r.url().includes('/api/friends/cycles'), { timeout: TIMEOUT })
  await page.goto(path)
  await served
  await expectLanding(page)
}

const cartbarShare = (page) =>
  page.locator('.app .cartbar').getByRole('button', { name: 'Zdieľať s kolegami' })

// ═════════════════════════════════════════════════════════════════════════════
// 1. The landing IS the order screen (§UC-PI-005)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T3 · 18 §UC-PI-005 — the landing, open state', () => {
  test('the product grid and the cartbar render on `/` with no click at all', async ({ page }) => {
    const friend = await makeFriend('Grid')
    const cycle = await makeCycle('Grid')
    const product = await addProduct(cycle.id, { name: `PI3 Grid Bean ${uniq}`, purpose: 'Espresso', price_250g: 7.5 })

    await signIn(page, friend)
    await open(page)

    // R1.1: „the landing IS the order screen". Before PI-T3 this needed a click on a
    // cycle card, which is the whole point of the change.
    expect(new URL(page.url()).pathname, 'and it did not redirect to /cycle/:id').toBe('/')
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'open')
    await expect(page.getByTestId('product-card').filter({ hasText: product.name })).toBeVisible()
    await expect(page.locator('.app .cartbar')).toBeVisible()

    // …and the shipped tabgroup stays (§UC-PI-005 item 3: „the prototype is silent,
    // silence is not removal" — the Kolegovia panel is where hosts manage sub-orders).
    await expect(page.getByTestId('main-tab-own')).toBeVisible()
    await expect(page.getByTestId('main-tab-guests')).toBeVisible()

    // The cart is live: a step updates the bar's total.
    await page.getByTestId('product-card').filter({ hasText: product.name })
      .getByRole('button', { name: 'viac' }).first().click()
    await expect(page.locator('.app .cartbar .sum')).toContainText('7.50 EUR')
  })

  test('⚠ ONE `.app` root and ONE chrome — the embedded view brings neither', async ({ page }) => {
    // §UC-PI-005: „In `landing` mode the view renders no `.app` root, no
    // `BrandChrome`, no page-column wrapper". A second `.app` would nest the token
    // block AND insert a fresh `.app > * { position:relative; z-index:1 }` stacking
    // context between the session's column and this subtree — the most-repeated trap
    // in this codebase, and one that fails SILENTLY.
    const friend = await makeFriend('Roots')
    const cycle = await makeCycle('Roots')
    await addProduct(cycle.id, { name: `PI3 Roots Bean ${uniq}`, purpose: 'Espresso', price_250g: 6 })

    await signIn(page, friend)
    await open(page)
    // Non-vacuity: the embedded order view really mounted.
    await expect(page.locator('[data-fo-mode="landing"]')).toHaveCount(1)

    await expect(page.locator('.app'), 'exactly one `.app` root').toHaveCount(1)
    await expect(page.locator('.appbar'), 'one appbar (the portal\'s)').toHaveCount(1)
    await expect(page.locator('.ticker'), 'one ticker').toHaveCount(1)
    // The portal's own chrome, not FriendOrder's: the deep link's back chevron and
    // its per-cycle title have no business on `/`.
    await expect(page.locator('.appbar .back')).toHaveCount(0)
    await expect(page.locator('.appbar .titles .t')).toHaveText('Podpultovka')

    // And the cartbar is still the THEME class doing the work — the reason it may be
    // nested inside the session's page column at all.
    await expect(page.locator('.app .cartbar')).toHaveCSS('position', 'sticky')
    await expect(page.locator('.app .cartbar')).toHaveCSS('bottom', '0px')
    await expect(page.locator('.app .cartbar')).toHaveCSS('z-index', '50')
  })

  test('the status line: deadline, expected date, and the explainer link', async ({ page }) => {
    const friend = await makeFriend('Status')
    const cycle = await makeCycle('Status', {
      closes_at: '2026-09-25', expected_date: '2. október 2026',
    })
    await addProduct(cycle.id, { name: `PI3 Status Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page)

    const line = page.getByTestId('landing-status')
    // `fmtWeekdayDayMonth` (lib/dates.js) — the SHORT form, because the date stands
    // alone after a preposition rather than inside one of module 17's sentences.
    // ⚠ The weekday arrives ALREADY DECLINED („piatku", `WEEKDAY_GENITIVE`), which is
    // what makes „Objednávky do …" grammatical; „do piatok" would be the tell that
    // someone swapped in a nominative list.
    await expect(line).toContainText('Objednávky do piatku 25. 9.')
    await expect(line.locator('b')).toHaveText('Objednávky do piatku 25. 9.')
    // `expected_date` is ADMIN FREE TEXT and renders verbatim — never reformatted.
    // The em dash is part of THIS clause (see the fallback test for the other half).
    await expect(line).toContainText('Káva príde okolo 2. október 2026 —')

    const link = line.getByRole('link', { name: 'Ako to funguje?' })
    await expect(link).toHaveCSS('font-weight', '700')
    await link.click()
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
  })

  test('the status line falls back per field: no `closes_at`, no `expected_date`', async ({ page }) => {
    // Both branches, because a fixture carrying both dates would pass against a
    // template that could not render either absence.
    const friend = await makeFriend('Fallback')
    const cycle = await makeCycle('Fallback')
    await addProduct(cycle.id, { name: `PI3 Fb Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page)

    const line = page.getByTestId('landing-status')
    await expect(line.locator('b')).toHaveText('Objednávky sú otvorené.')
    await expect(line, 'no deadline ⇒ no „do …" clause').not.toContainText('Objednávky do')
    await expect(line, 'no expected_date ⇒ no „Káva príde" clause').not.toContainText('Káva príde')
    // The way into the explainer survives both absences — it is not a decoration on
    // the deadline sentence.
    await expect(line.getByRole('link', { name: 'Ako to funguje?' })).toBeVisible()
    // ⚠ …and NO ORPHAN EM DASH. The dash belongs to the „Káva príde …" clause the
    // spec drops here; rendering it unconditionally produced „Objednávky sú otvorené.
    // — Ako to funguje?", a dash introducing nothing. Pinned in BOTH directions (the
    // test above asserts it IS there beside the date), so restoring a separator in
    // this branch is a deliberate copy decision rather than a silent template edit.
    expect((await line.innerText()).replace(/\s+/g, ' ').trim())
      .toBe('Objednávky sú otvorené. Ako to funguje?')
  })

  test('the fatal-error state offers „Skúsiť znova" here and „Späť na ponuku" on the deep link', async ({ page }) => {
    // §UC-PI-005: on the landing there is no list to go back to, so the button
    // RE-RUNS the load. On `/cycle/:id` it still navigates, with §UC-PI-017's new
    // wording (was „Späť na zoznam cyklov").
    const friend = await makeFriend('Fatal')
    const cycle = await makeCycle('Fatal')
    await addProduct(cycle.id, { name: `PI3 Fatal Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    let fail = true
    await page.route('**/api/orders/cycle/*/friend/*', (route) => (fail
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Servis spadol' }) })
      : route.continue()))

    await open(page)
    await expect(page.locator('.banner.danger')).toContainText('Servis spadol')
    await expect(page.getByRole('button', { name: 'Späť na ponuku' }),
      'the landing must not offer a link to the page it is already on').toHaveCount(0)

    // The retry really re-loads: the grid appears without a navigation.
    fail = false
    await page.getByRole('button', { name: 'Skúsiť znova' }).click()
    await expect(page.getByTestId('product-card').first()).toBeVisible()
    expect(new URL(page.url()).pathname, 'a retry is not a navigation').toBe('/')

    // The deep link keeps the other button, with §UC-PI-017's wording.
    fail = true
    await gotoCycle(page, cycle.id)
    const back = page.getByRole('button', { name: 'Späť na ponuku' })
    await expect(back).toBeVisible()
    await expect(page.getByRole('button', { name: 'Späť na zoznam cyklov' }),
      'the retired wording is really gone').toHaveCount(0)
    await back.click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('⚠ the leave guard fires on the DRAWER\'s `router.push`, not only on the chevron', async ({ page }) => {
    // §UC-PI-005 business rules: „the drawer's `router.push` is a route leave".
    // Before PI-T3 the only in-page navigation away from an order was the appbar
    // chevron; the drawer adds six more, and `onBeforeRouteLeave` has to cover them
    // from inside a component that is no longer the route component itself.
    const friend = await makeFriend('Leave')
    const cycle = await makeCycle('Leave')
    const product = await addProduct(cycle.id, { name: `PI3 Leave Bean ${uniq}`, purpose: 'Espresso', price_250g: 5 })

    await signIn(page, friend)
    await open(page)

    // An unsaved cart with NO order row: auto-save deliberately never auto-creates
    // one (04 §UC-FO-008), so `hasUnsavedChanges` stays true indefinitely.
    await page.getByTestId('product-card').filter({ hasText: product.name })
      .getByRole('button', { name: 'viac' }).first().click()
    await expect(page.locator('.app .cartbar .sum')).toContainText('5.00 EUR')

    await menuGo(page, 'Moje objednávky')
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText('Neuložené zmeny')
    expect(new URL(page.url()).pathname, 'the navigation was CANCELLED, not merely warned about').toBe('/')

    // „Zostať" keeps the cart; „Opustiť" lets the navigation through.
    await dialog.getByRole('button', { name: 'Zostať' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe('/')

    await menuGo(page, 'Moje objednávky')
    await page.getByRole('dialog').getByRole('button', { name: 'Opustiť' }).click()
    await expect(page).toHaveURL(/\/moje-objednavky$/)
  })

  test('⚠ …and it still fires AFTER a submit — the one-shot bypass is not left armed', async ({ page }) => {
    // ⚠⚠ THE REGRESSION THIS TEST EXISTS FOR, and the test above could not see it.
    // `handleSuccessModalClose()` and `confirmCancelOrder()` arm `leaveConfirmed`, a
    // ONE-SHOT guard bypass that only `onBeforeRouteLeave` disarms, and then push `/`.
    // On `/cycle/:id` that push really leaves, the guard runs and consumes the flag.
    // On the LANDING the push is a NO-OP — same route, no unmount, guard never runs —
    // so the flag stayed armed and silently swallowed the NEXT navigation's prompt.
    //
    // Measured on the built app before the fix: submit → close → step a product →
    // drawer ⇒ zero dialogs, URL changed, cart gone, no „Neuložené zmeny" at all.
    // The test above only ever exercises the NEVER-SUBMITTED path, which never arms
    // the flag, which is exactly why it passed throughout.
    const friend = await makeFriend('Armed')
    const cycle = await makeCycle('Armed')
    const product = await addProduct(cycle.id, { name: `PI3 Armed Bean ${uniq}`, purpose: 'Espresso', price_250g: 5 })

    await signIn(page, friend)
    // No pickup locations and no parcel ⇒ „Odoslať" submits directly (04 §UC-FO-010
    // scenario 1), so the success modal is the only dialog in the way.
    await page.route('**/api/pickup-locations*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await open(page)

    const plus = page.getByTestId('product-card').filter({ hasText: product.name })
      .getByRole('button', { name: 'viac' }).first()
    await plus.click()
    await expect(page.locator('.app .cartbar .sum')).toContainText('5.00 EUR')

    await page.locator('.app .cartbar').getByRole('button', { name: 'Odoslať' }).click()
    const success = page.getByRole('dialog')
    await expect(success).toContainText('Hotovo!')
    await success.getByRole('button', { name: 'OK' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The close is a no-op navigation on the landing — we are still on the offer.
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('product-card').first(), 'the grid is still here').toBeVisible()

    // Now make the order dirty again and try to leave through the drawer.
    await plus.click()
    await expect(page.getByTestId('cart-warn-dirty')).toBeVisible()

    await menuGo(page, 'Moje objednávky')
    await expect(page.getByRole('dialog').locator('.m-title'),
      'the bypass armed by the success modal must NOT still be armed here')
      .toHaveText('Neuložené zmeny')
    expect(new URL(page.url()).pathname, 'and the navigation was cancelled').toBe('/')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. The cycle list, the gear and the archive are GONE (§UC-PI-005 / §UC-PI-016)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T3 · 18 §UC-PI-005 — the retired list really is retired', () => {
  test('no heading, no cycle cards, no gear, no archive fold', async ({ page }) => {
    // The structures `portal-cycles.spec.js` tested. Asserting their ABSENCE once,
    // here, is what stops them from creeping back as „a list view" (18 §Dropped).
    const friend = await makeFriend('Gone')
    const cycle = await makeCycle('Gone')
    await addProduct(cycle.id, { name: `PI3 Gone Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page)
    // Non-vacuity: the landing really rendered its body before the absences are read.
    await expect(page.getByTestId('landing-status')).toBeVisible()

    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toHaveCount(0)
    await expect(page.locator('div.p-4').filter({ has: page.getByRole('heading', { name: cycle.name, exact: true }) }),
      'the `div.p-4` cycle card').toHaveCount(0)
    await expect(page.locator('[aria-label="Nastavenia odberu"]'), 'the gear').toHaveCount(0)
    await expect(page.getByTestId('archive-toggle'), 'the archive fold').toHaveCount(0)
    await expect(page.getByTestId('share-row'), 'the card\'s share row').toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('Žiadne dostupné cykly')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. The share dialog's ENTRY CONTRACT (§UC-PI-011)
//    — the surviving half of `portal-share-row.spec.js`'s dialog describe.
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T3 · 18 §UC-PI-011 — two entry points, ONE dialog', () => {
  test('the cartbar icon opens the dialog for THIS round, and the URL stays `/`', async ({ page }) => {
    // THE RETARGET of „`@click.stop` opens the dialog for THAT cycle without
    // navigating". The card navigated on click, so its share button needed
    // `@click.stop`; the cartbar submits and cancels orders, so the same class of
    // defect one layer down would be a share tap that left the page. The claim is
    // the same and it is still the one that reds.
    const friend = await makeFriend('Entry')
    const cycle = await makeCycle('Entry')
    await addProduct(cycle.id, { name: `PI3 Entry Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page)

    await expect(cartbarShare(page)).toHaveCount(1)
    await cartbarShare(page).click()
    expect(new URL(page.url()).pathname, 'sharing must not navigate').toBe('/')

    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText('Zdieľať s kolegami')
    // ⚠ The dialog must NAME the round it shares (GSO-T2): an unlabelled /g/ URL
    // cannot be verified by the host.
    await expect(dialog.locator('.m-head .sub b')).toHaveText(cycle.name)
  })

  test('the drawer row opens the SAME instance — never a second dialog', async ({ page }) => {
    // §UC-PI-011: „the landing never mounts a second dialog instance". Two instances
    // is how one of them stops receiving updates — the drawer row reaches the one in
    // `FriendOrder.vue` through its `defineExpose`d `openShareDialog()`.
    const friend = await makeFriend('OneDlg')
    const cycle = await makeCycle('OneDlg')
    await addProduct(cycle.id, { name: `PI3 One Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page)

    await menuGo(page, 'Zdieľať s kolegami')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('.m-title')).toHaveText('Zdieľať s kolegami')
    await expect(dialog.locator('.m-head .sub b')).toHaveText(cycle.name)
    // ONE teleported layer — a second `GuestShareDialog` would be a second
    // `.modal-layer`, and `getByRole('dialog')` would resolve two.
    await expect(page.locator('.modal-layer')).toHaveCount(1)
    expect(new URL(page.url()).pathname).toBe('/')

    // Escape closes it, and nothing is left mounted (05 §UC-KG-007's mount seam).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-layer')).toHaveCount(0)

    // …and the cartbar icon then opens the very same one.
    await cartbarShare(page).click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
  })

  test('the drawer row works from ANOTHER view: it goes to `/` and opens there', async ({ page }) => {
    // Item 4's condition is the landing STATE, not the current VIEW, so the row is
    // offered on „Zostatok a platby" too — where the embedded `FriendOrder` (and with
    // it the one dialog) is not mounted yet.
    const friend = await makeFriend('OtherView')
    const cycle = await makeCycle('OtherView')
    await addProduct(cycle.id, { name: `PI3 OV Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page, '/zostatok')
    await expect(page.locator('[data-fo-mode="landing"]'), 'non-vacuity: not mounted here').toHaveCount(0)

    await menuGo(page, 'Zdieľať s kolegami')
    await expect(page).toHaveURL(/\/$/)
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.m-title')).toHaveText('Zdieľať s kolegami')
    await expect(dialog.locator('.m-head .sub b')).toHaveText(cycle.name)
    await expect(page.locator('.modal-layer')).toHaveCount(1)
  })

  test('⚠ the pending open is CONSUMED — coming back to `/` does not re-open the dialog', async ({ page }) => {
    // The row's action from another view is „go to `/`, then open" (a pending flag the
    // mount consumes). A flag that survives its use is a dialog that opens UNBIDDEN
    // the next time the friend lands on the offer — which is a jump-scare, not a
    // feature. Reachable half of the disarm rule; the two defensive exits have no
    // trigger today and `FriendPortalSession.vue` says so rather than pretending.
    const friend = await makeFriend('Pending')
    const cycle = await makeCycle('Pending')
    await addProduct(cycle.id, { name: `PI3 Pend Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    await open(page, '/zostatok')
    await menuGo(page, 'Zdieľať s kolegami')
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Zdieľať s kolegami')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Leave the offer and come back the ordinary way — client-side, same document.
    await menuGo(page, 'Moje objednávky')
    await expect(page).toHaveURL(/\/moje-objednavky$/)
    await menuGo(page, 'Aktuálna ponuka')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-fo-mode="landing"]'), 'the offer really re-mounted').toHaveCount(1)

    await expect(page.getByRole('dialog'), 'nothing may open on its own').toHaveCount(0)
    await expect(page.locator('.modal-layer')).toHaveCount(0)
  })

  test('⚠ a round that is not OPEN offers no share affordance at all', async ({ page }) => {
    // THE RETARGET of „locked and planned cycles carry no row and no share
    // affordance" (05 §UC-KG-002). It runs against a STUBBED payload because this
    // database carries ~135 open rounds — locking one cycle does not make the
    // landing closed, it just makes the resolver pick the next one.
    const friend = await makeFriend('NoShare')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))

    for (const [state, list] of [
      ['locked', [cycleRow({ n: 1, status: 'locked' })]],
      ['closed', [cycleRow({ n: 2, status: 'completed' }), cycleRow({ n: 3, status: 'planned' })]],
    ]) {
      await stubCycles(page, list)
      await open(page)
      // Non-vacuity: the resolver really reached the state under test.
      await expect(page.getByTestId('portal-landing'), state)
        .toHaveAttribute('data-landing-state', state === 'locked' ? 'locked' : 'closed')

      // ⚠ SANCTIONED EDIT, PI-T4 (18 §UC-PI-006, immutability case (a)) and now
      // PI-T5 (§UC-PI-007): the landing opens its state modal by itself, and a
      // NeoModal's scrim covers the appbar — so `openMenu()` below would time out on
      // actionability rather than on anything this test is about. The claim („a round
      // that is not open offers no share affordance") is unchanged; only the step
      // that reaches the drawer is.
      // ⚠ The condition is GONE, not inverted: PI-T4's note („the LOCKED half has no
      // modal until PI-T5") expired with this row — `cycleRow` seeds `hasOrder: false`,
      // which is exactly §UC-PI-007's „locked, NO own order" branch, i.e. the closed
      // treatment with two different strings.
      await dismissLandingState(page)

      await expect(cartbarShare(page), `${state}: no cartbar icon`).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Zdieľať s kolegami' }),
        `${state}: nothing anywhere on the page`).toHaveCount(0)

      const menu = await openMenu(page)
      await expect(menu.getByText('Zdieľať s kolegami'), `${state}: no drawer row`).toHaveCount(0)
      // …and the drawer did render, so this is an absence rather than an empty page.
      await expect(menu.locator('.p2-mi')).toHaveCount(6)
      await page.keyboard.press('Escape')
      await expect(drawer(page)).toHaveCount(0)
    }
  })

  test('a FAILED colleague count gates nothing — the row and the dialog still work', async ({ page }) => {
    // THE RETARGET of „the count is context only — it gates nothing on this screen".
    const friend = await makeFriend('CtxOnly')
    const cycle = await makeCycle('CtxOnly')
    await addProduct(cycle.id, { name: `PI3 Ctx Bean ${uniq}`, purpose: 'Espresso', price_250g: 9 })

    await signIn(page, friend)
    // Only the GET — the dialog's own POST („Vytvoriť odkaz") shares the URL.
    await page.route('**/api/guest-links/cycle/*', (route) => (route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      : route.continue()))
    await open(page)

    const menu = await openMenu(page)
    await expect(menu.getByText('Zdieľať s kolegami')).toHaveCount(1)
    await expect(menu.getByText('Pošlite odkaz kolegom')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)

    await cartbarShare(page).click()
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Zdieľať s kolegami')
    // ⚠ NO „no error banner anywhere" ASSERTION HERE, deliberately, and the reason is
    // worth recording: `GuestSubOrders.vue` (the Kolegovia panel, module 05) makes its
    // OWN `GET /guest-links/cycle/:id` and renders its OWN failure surface, so a stub
    // that fails the endpoint fails BOTH components and a page-wide banner count would
    // be measuring module 05 rather than the count. The „a failed count owns no error
    // surface" claim is pinned where only the session fetches — `portal-menu.spec.js`
    // §1b, on `/zostatok`.
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. ONE HOME — the source pins, because the DOM cannot see this one
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T3 · 18 §UC-PI-011 — exactly ONE `GuestShareDialog` mount', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  // ⚠ The stripper and the readability gate live in `helpers/source-pins.js` now
  // (PI-T3 review): they were written HERE first, and a rule with two homes is how one
  // of them keeps the bug. `portal-shell.spec.js` had the broken copy.

  test('⚠ the friend surface mounts it exactly ONCE, and not in the session view', () => {
    // ⚠ WHY THIS IS A SOURCE PIN AND NOT A DOM ONE — measured, not assumed.
    // A second `GuestShareDialog` mounted beside the first was written as a mutation
    // and it reddened exactly ONE behavioural test in this file (and none in
    // `share-dialog.spec.js`): the dialog renders `v-if="open"`, so the extra
    // instance is INVISIBLE while closed, and when the drawer opens ITS copy the
    // screen shows one dialog with the right title and the right cycle name. The
    // defect the rule exists for — one of the two instances silently stops receiving
    // updates — has no observable DOM signature until the two disagree, which is
    // precisely the state a test cannot reach on purpose.
    //
    // So the invariant is pinned where it lives: in the source. The count is the
    // whole claim, and it is asserted per FILE rather than in total, so „moved from
    // A to B" cannot pass as „still one".
    assertReadable('views/FriendOrder.vue', ['defineExpose', 'showShareModal'])
    assertReadable('views/FriendPortalSession.vue', ['const landing = computed(', 'requestShareDialog'])
    const mounts = (p) => (code(p).match(/<GuestShareDialog\b/g) || []).length

    expect(mounts('views/FriendOrder.vue'),
      'FriendOrder.vue is THE home of the one instance (§UC-PI-011)').toBe(1)
    expect(mounts('views/FriendPortalSession.vue'),
      'the session reaches it through `defineExpose({ openShareDialog })` — it mounts none').toBe(0)
    expect(mounts('views/FriendPortal.vue'), 'the parent mounts none').toBe(0)

    // …and the bridge really is the exposed opener rather than a copy of the state.
    expect(code('views/FriendOrder.vue'))
      .toMatch(/defineExpose\(\{[^}]*openShareDialog/)
    expect(code('views/FriendPortalSession.vue'))
      .toMatch(/landingOrder\.value\.openShareDialog\(\)/)
    expect(code('views/FriendPortalSession.vue'),
      'no `shareCycle` ref survived the card it belonged to').not.toContain('shareCycle')
  })

  test('the cycle LIST helpers are gone from the session view, not merely unrendered', () => {
    // §UC-PI-005/016. Dead code that still compiles is how a retired screen comes
    // back: these eight names were the list's, and a future row that finds them
    // sitting there reads them as „still supported".
    const src = assertReadable('views/FriendPortalSession.vue', ['const landing = computed(', 'menuItems'])
    for (const gone of [
      'activeCycles', 'archivedCycles', 'showArchive', 'goToCycle',
      'orderQuantityLabel', 'getCycleTypeLabel',
      'openSubscriptionModal', 'saveSubscriptions', 'loadCycles', 'loadSubscriptions',
    ]) {
      expect(src, `${gone} must not survive the structure it served`).not.toContain(gone)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. PI-T4 — the landing, CLOSED state (18 §UC-PI-006)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠⚠ READ THIS BEFORE „FIXING" §5.2. The same closed landing prints the SAME date
// in TWO formats — „3. 12." in the modal's card and „3. decembra" in the warn
// banner that replaces the modal — and that is a RECORDED, UNRESOLVED PRODUCT-OWNER
// QUESTION, not a defect anybody here owns. Module 17 §UC-CS-005 ships the sentence
// („Ďalšia objednávka sa otvorí približne {fmtDay}") and owns it; module 18
// §UC-PI-002 specifies `fmtDayMonth` for the same words. PI-T1 kept 17's form
// because the alternative is a SECOND home for one sentence
// (`docs/learnings/10-portal-ia.md` §1, both options costed). §5.2 pins the state
// of play in BOTH directions so the collision is visible rather than accidental;
// when the PO rules, that test is the edit.
//
// ⚠ And the thing that is NOT true, because an earlier draft of the note said it
// and a reader who checked it would have concluded the conflict had evaporated:
// the two forms are NOT both inside the modal. In the `opens_at === null` branch
// the modal carries the sentence alone (§5.5) and there is no collision at all.

/** `today + n` as a local ISO date — the shape module 17's columns carry. */
function isoPlusDays(n) {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ⚠ Both formatters are RE-DERIVED here rather than imported, and that is the point:
// an assertion that read the app's own `fmtDayMonth` would pass whatever that
// function did. These two are independent, so swapping one for the other in the app
// reds §5.2 — which is the one thing this row must not do quietly.
const shortForm = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' })
const longForm = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('sk-SK', { day: 'numeric', month: 'long' })

const closedBanner = (page) => page.getByTestId('landing-closed-banner')

test.describe('PI-T4 · 18 §UC-PI-006 — the landing, closed state', () => {
  test('the state modal opens by ITSELF and names the next round', async ({ page }) => {
    const friend = await makeFriend('Closed')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))

    // +14 days is chosen so the weeks phrase is EXACT and cannot drift with the
    // date the suite happens to run on: `Math.round(14 / 7) === 2` whatever „today"
    // is, and 2 takes the 2–4 declension („týždne"), not the 1 or the ≥5 one.
    const opensAt = isoPlusDays(14)
    await stubCycles(page, [
      cycleRow({ n: 20, status: 'completed' }),
      cycleRow({ n: 21, status: 'planned', opens_at: opensAt }),
    ])
    await open(page)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'closed')

    // ⚠ Nobody clicked anything: §UC-PI-006 says „shown automatically once per
    // session", and „the friend has to find it" would be a different feature.
    const modal = landingStateModal(page)
    await expect(modal).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(modal.locator('.m-title')).toHaveText('Objednávky sú zatvorené')
    await expect(modal).toContainText(
      'Káva sa objednáva spoločne, v termínoch — pár dní naraz, potom ju nakúpime v pražiarni a rozdáme si ju.',
    )

    await expect(modal.getByTestId('next-round-card')).toContainText('Ďalšia objednávka sa otvorí približne')
    await expect(modal.getByTestId('next-round-date')).toHaveText(shortForm(opensAt))
    await expect(modal.getByTestId('next-round-card'))
      .toContainText('o 2 týždne · dáme vedieť cez WhatsApp')

    // The two footer buttons, in the prototype's order.
    await expect(modal.locator('.m-foot .btn')).toHaveText(['Ako to funguje', 'Prezrieť ponuku'])
  })

  test('⚠ the SHORT form in the card, the LONG form in the banner — the recorded PO question', async ({ page }) => {
    // ⚠ THIS TEST ASSERTS A CONFLICT, ON PURPOSE. See the block comment above §5.
    // Neither half may be „fixed" at its call site; when the PO chooses a format,
    // one of the two expectations below is rewritten and the other one stays.
    const friend = await makeFriend('TwoForms')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))

    const opensAt = isoPlusDays(14)
    const short = shortForm(opensAt)   // „3. 12."     — `lib/dates.js fmtDayMonth`
    const long = longForm(opensAt)     // „3. decembra" — `cycle-stages.js fmtDay`
    // Non-vacuity: the two really are different strings. If ICU ever collapsed them
    // this whole test would be measuring nothing, and it would do so silently.
    expect(short, 'the two formats must actually differ').not.toBe(long)

    await stubCycles(page, [
      cycleRow({ n: 22, status: 'completed' }),
      cycleRow({ n: 23, status: 'planned', opens_at: opensAt }),
    ])
    await open(page)

    // (a) the card: a date STANDING ALONE in display type is 18's SHORT form.
    const modal = landingStateModal(page)
    await expect(modal.getByTestId('next-round-date')).toHaveText(short)
    await expect(modal.getByTestId('next-round-date')).toHaveText(/^\d{1,2}\. \d{1,2}\.$/)
    await expect(modal, 'the modal must not compose 17\'s sentence as well').not.toContainText(long)

    // (b) the banner: the date INSIDE module 17's composed sentence is its LONG form,
    // and the sentence is 17's verbatim — never re-composed here.
    await dismissLandingState(page)
    await expect(closedBanner(page)).toContainText('Objednávky sú zatvorené.')
    await expect(closedBanner(page)).toContainText(`Ďalšia objednávka sa otvorí približne ${long}`)
    await expect(closedBanner(page)).toContainText(/približne \d{1,2}\. [a-záčďéíĺľňóôŕšťúýž]+a\b/)
    await expect(closedBanner(page), 'the banner must not be re-formatted at the call site')
      .not.toContainText(short)
  })

  test('once per SESSION — dismiss leaves the banner, a reload brings the modal back', async ({ page }) => {
    const friend = await makeFriend('OnceSession')
    // ⚠⚠ `signIn()` IS NOT USABLE HERE, AND FINDING THAT OUT IS HALF OF THIS TEST.
    // Its `addInitScript` calls `localStorage.clear()`, and an init script runs on
    // EVERY navigation — a reload included. So with `signIn()` the reload below
    // wipes any persisted flag on its way in, and „the modal comes back" would pass
    // against an implementation that stored the dismissal in `localStorage`
    // forever. Measured: mutation M1 (persist it) reddened the cross-session test
    // and left this one GREEN. This variant seeds the session WITHOUT clearing, so
    // a flag written by the app survives the reload and the assertion can fail for
    // the reason it states.
    await page.addInitScript((value) => {
      localStorage.setItem('gorifi_friend_auth', value)
    }, JSON.stringify({
      friendId: friend.id,
      friendName: friend.name,
      token: friend.token,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }))
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    await stubCycles(page, [cycleRow({ n: 24, status: 'completed' })])

    // ⚠ THE VIEW GATE, MEASURED FIRST — and it has to be first. §UC-PI-006 puts the
    // modal on the LANDING, not on the session, so „Zostatok a platby" reached by
    // URL must not open it. After the dismissal below the flag hides the modal
    // everywhere, and this claim becomes unmeasurable: mutation M10 (drop the
    // `view === 'shop'` gate) reddened NOTHING until this block existed.
    await open(page, '/zostatok')
    await expect(landingStateModal(page), 'the modal belongs to the landing').toHaveCount(0)

    await open(page)
    await expect(landingStateModal(page), '…and it DOES open on the landing').toBeVisible()
    // While the modal is up there is NO banner: it REPLACES the modal, it does not
    // sit behind it (§UC-PI-006 item 2, „after dismissal").
    await expect(closedBanner(page)).toHaveCount(0)

    await dismissLandingState(page)
    await expect(closedBanner(page)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // …and it stays dismissed while the session lives: leaving the view and coming
    // back is not a new session.
    await menuGo(page, 'Zostatok a platby')
    await expect(page).toHaveURL(/\/zostatok$/)
    await expect(landingStateModal(page), 'never over another view').toHaveCount(0)
    await menuGo(page, 'Aktuálna ponuka')
    await expect(page).toHaveURL(/\/$/)
    await expect(landingStateModal(page), 'dismissed for this session').toHaveCount(0)
    await expect(closedBanner(page)).toBeVisible()

    // ⚠ A RELOAD IS A NEW SESSION AND THE MODAL COMES BACK — PO clarification
    // 2026-09-19 (a). This is the direction that proves there is no persistence:
    // a `localStorage` flag would make the modal stay gone here, and the test that
    // only checks „it disappears when dismissed" passes either way.
    await open(page)
    await expect(landingStateModal(page)).toBeVisible()
    // …and nothing about it was written down anywhere a next session could read.
    const stored = await page.evaluate(() => {
      const dump = (s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`).join('\n')
      return `${dump(localStorage)}\n${dump(sessionStorage)}`
    })
    expect(stored, 'no dismissal flag is persisted').not.toMatch(/closed|dismiss/i)
  })

  test('⚠ one friend\'s dismissal never reaches the NEXT friend\'s session', async ({ page }) => {
    // THE SESSION-BOUNDARY HALF, and the reason the flag may not live in
    // `localStorage`, in a plain `<script>` block or in `FriendPortal.vue`: all
    // three outlive the handshake, and friend B would land on a closed offer with
    // friend A's dismissal already applied. One document, two friends — no reload,
    // so a fresh page load cannot be what clears it.
    const a = await makeFriend('DismissA')
    const b = await makeFriend('DismissB')
    await signIn(page, a)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    await stubCycles(page, [cycleRow({ n: 25, status: 'completed' })])

    await open(page)
    await dismissLandingState(page)
    await expect(closedBanner(page)).toBeVisible()

    await logout(page)
    // ⚠ THE SHARED-PASSWORD CARD, not the username one: the gate database seeds
    // `auth_mode = 'legacy'` (`seed.mjs`), and `FriendPortal.vue` renders the
    // username form only in `modern`. Flipping the mode for one test would be a
    // global settings write the rest of the suite would inherit. Which credential
    // opens the session is irrelevant here — the claim is about what the SESSION
    // carries across the handshake.
    const loginAs = async (friend) => {
      await page.getByRole('combobox').click()
      await page.getByRole('option', { name: friend.name, exact: true }).click()
      await page.getByPlaceholder('Zadajte heslo').fill(FRIENDS_PASSWORD)
      await page.getByRole('button', { name: 'Prihlásiť sa' }).click()
      await expectLanding(page)
    }
    await loginAs(b)
    await expect(landingStateModal(page), "A's dismissal must not reach B").toBeVisible()

    // …and the other way round, still in the same document: B dismissing must not
    // leave A's next session silent either.
    await dismissLandingState(page)
    await logout(page)
    await loginAs(a)
    await expect(landingStateModal(page), 'each handshake owns its own dismissal').toBeVisible()
  })

  test('no usable `opens_at` ⇒ the card carries `nextText` ALONE', async ({ page }) => {
    const friend = await makeFriend('NoDate')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))

    // (a) a planned round with only a `plan_note` — rendered VERBATIM (§UC-PI-002).
    await stubCycles(page, [
      cycleRow({ n: 26, status: 'completed' }),
      cycleRow({ n: 27, status: 'planned', opens_at: null, plan_note: 'Otvoríme hneď po Vianociach.' }),
    ])
    await open(page)
    let modal = landingStateModal(page)
    await expect(modal.getByTestId('next-round-text')).toHaveText('Otvoríme hneď po Vianociach.')
    await expect(modal.getByTestId('next-round-date'), 'no date ⇒ no display-type date').toHaveCount(0)
    // ⚠ The lead line goes with the date it introduced: „…sa otvorí približne" with
    // nothing after it is a sentence with a hole in it.
    await expect(modal.getByTestId('next-round-card')).not.toContainText('Ďalšia objednávka sa otvorí približne')
    // …and this is the branch where the modal carries the sentence ALONE — the
    // collision of §5.2 does not exist here at all.
    await dismissLandingState(page)
    await expect(closedBanner(page)).toContainText('Otvoríme hneď po Vianociach.')

    // (b) nothing planned at all ⇒ module 17's fallback, same in both places.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 28, status: 'completed' })])
    await open(page)
    modal = landingStateModal(page)
    await expect(modal.getByTestId('next-round-text')).toHaveText('O ďalšej objednávke dáme vedieť.')
    await dismissLandingState(page)
    await expect(closedBanner(page)).toContainText('O ďalšej objednávke dáme vedieť.')
  })

  test('„Kde sme teraz" — module 17\'s dots, this module\'s caption row', async ({ page }) => {
    const friend = await makeFriend('Dots')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))

    // (a) with a PLANNED round the timeline is about IT ⇒ step 1 of 6, „Pauza".
    await stubCycles(page, [
      cycleRow({ n: 29, status: 'completed' }),
      cycleRow({ n: 30, status: 'planned', opens_at: isoPlusDays(21) }),
    ])
    await open(page)
    let modal = landingStateModal(page)
    await expect(modal).toContainText('Kde sme teraz')

    const dots = modal.getByTestId('cycle-timeline-compact')
    await expect(dots).toHaveCount(1)
    await expect(dots.locator('.d')).toHaveCount(6)
    // ⚠ THE STEP LABEL COMES FROM MODULE 17, and the `aria-label` is where it shows.
    // This module passes `:cycle` and never `:steps`, so 17 decides both which dot
    // is „now" and what it is called; a consumer that assembled its own steps could
    // print any of the six words here.
    await expect(dots).toHaveAttribute('aria-label', 'Krok 1 z 6: Pripravujeme ďalšiu objednávku')

    // The caption row is THIS module's (§UC-PI-006) — three words under six dots,
    // and it is not part of the component (17 §UC-CS-006: the dots strip renders
    // dots only). ⚠ `toHaveText` reads `textContent`, which does NOT apply the
    // `text-transform:uppercase` the captions are painted with.
    const captions = modal.getByTestId('timeline-captions').locator('span')
    await expect(captions).toHaveText(['Pauza', 'Objednávky', 'Doručenie'])
    const weights = async () => captions.evaluateAll((els) => els.map((el) => getComputedStyle(el).fontWeight))
    expect(await weights(), 'a planned round ⇒ „Pauza" is where we are').toEqual(['700', '400', '400'])

    // (b) with NOTHING planned the timeline falls back to `catalogCycle` — a
    // COMPLETED round, step 6 ⇒ the emphasis moves to „Doručenie". Without this
    // second fixture the weights above would pass against a hardcoded first word.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 31, status: 'completed' })])
    await open(page)
    modal = landingStateModal(page)
    await expect(modal.getByTestId('cycle-timeline-compact'))
      .toHaveAttribute('aria-label', 'Krok 6 z 6: Objednávka ukončená')
    expect(
      await modal.getByTestId('timeline-captions').locator('span')
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontWeight)),
      'a finished round ⇒ „Doručenie"',
    ).toEqual(['400', '400', '700'])
  })

  test('„Ako to funguje" dismisses AND navigates; the drawer is reachable afterwards', async ({ page }) => {
    const friend = await makeFriend('ToExplainer')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    await stubCycles(page, [cycleRow({ n: 32, status: 'completed' })])
    await open(page)

    await landingStateModal(page).getByRole('button', { name: 'Ako to funguje' }).click()
    await expect(page).toHaveURL(/\/ako-to-funguje$/)
    await expect(landingStateModal(page), 'it dismissed on the way out').toHaveCount(0)

    // Back on the offer the modal stays dismissed — and the hamburger, which the
    // modal's scrim covers, is reachable again. „drawer reachable" is §UC-PI-006's
    // own acceptance criterion.
    await page.goBack()
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'closed')
    await expect(landingStateModal(page)).toHaveCount(0)
    await expect(closedBanner(page)).toBeVisible()
    const menu = await openMenu(page)
    await expect(menu.locator('.p2-mi')).toHaveCount(6)
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toHaveCount(0)
  })

  test('no locked and no completed round ⇒ „Ponuka ešte nie je pripravená."', async ({ page }) => {
    const friend = await makeFriend('NoCatalog')
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    // A planned round only: `catalogCycle` is null — a planned round has no products
    // a friend may look at, which is why `resolveLanding` does not offer it as one.
    await stubCycles(page, [cycleRow({ n: 33, status: 'planned', opens_at: isoPlusDays(30) })])
    await open(page)
    await dismissLandingState(page)

    await expect(page.getByTestId('landing-empty')).toHaveText('Ponuka ešte nie je pripravená.')
    await expect(page.getByTestId('product-card')).toHaveCount(0)
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
    // Non-vacuity: the closed landing itself really did render.
    await expect(closedBanner(page)).toBeVisible()
  })

  test('the READ-ONLY catalogue: faded cards, live tabs, no cartbar, no tabgroup, no stock bars', async ({ page }) => {
    // ⚠ A REAL cycle: the grid is served by `GET /products` and the availability by
    // its own call, so a stubbed cycles payload alone produces no cards. The payload
    // IS stubbed — to nothing but this round — because the gate database carries
    // ~135 open rounds and completing one does not make the landing closed.
    const friend = await makeFriend('ROGrid')
    const cycle = await makeCycle('ROGrid')
    const espressoName = `PI4 RO Espresso ${uniq}`
    const filterName = `PI4 RO Filter ${uniq}`
    await addProduct(cycle.id, { name: espressoName, purpose: 'Espresso', price_250g: 8.5, stock_limit_g: 5000 })
    await addProduct(cycle.id, { name: filterName, purpose: 'Filter', price_250g: 9.5 })

    // ⚠⚠ THE FRIEND ORDERED IN THIS ROUND — added in the PI-T4 review, and it is the
    // NON-VACUITY GATE for the read-only cart rule below. Every earlier fixture here used
    // a FRESH friend with no order on the catalogue cycle, so `cart` was empty BY ACCIDENT
    // and „read-only shows no quantities" passed without the code doing anything. §UC-PI-006
    // says the order GET still fires but „its `order` is IGNORED in `readonly`"; before the
    // review it was not, and a friend saw their old quantities in faded, disabled steppers
    // of a grid with no cartbar to act on. It matters more for PI-T5, where the friend
    // almost always DOES have an order on the locked round.
    const ordered = await addProduct(cycle.id, {
      name: `PI4 RO Ordered ${uniq}`, purpose: 'Espresso', price_250g: 7.5, stock_limit_g: 5000,
    })
    expect((await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
      headers: { Authorization: `Bearer ${friend.token}` },
      data: { items: [{ product_id: ordered.id, variant: '250g', quantity: 3 }] },
      timeout: TIMEOUT,
    })).status(), 'the friend really has a cart on the catalogue round').toBe(200)

    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'completed' } })).status()).toBe(200)

    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    await stubCycles(page, [cycleRow({ n: 34, id: cycle.id, name: cycle.name, status: 'completed' })])
    await open(page)
    await dismissLandingState(page)

    // The caption row — „Minulá ponuka · {name}" + „len na prezretie".
    await expect(page.getByTestId('portal-landing')).toContainText(`Minulá ponuka · ${cycle.name}`)
    await expect(page.getByTestId('portal-landing')).toContainText('len na prezretie')

    // The cards are there and they are the round's real products.
    const card = page.getByTestId('product-card').filter({ hasText: espressoName })
    await expect(card).toBeVisible()

    // …and they are INERT: `.p2-ro` is opacity .55 + `pointer-events:none`, and the
    // steppers are `disabled` as well. CLAUDE.md: a `disabled` attribute does not
    // stop a DISPATCHED click, and `pointer-events:none` stops nothing a script
    // dispatches either — which is why the handlers are guarded in JS too, and why
    // the last assertion in this block DISPATCHES a click and reads the quantity back.
    const grid = page.getByTestId('product-grid')
    await expect(grid).toHaveClass(/\bp2-ro\b/)
    expect(await grid.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents }
    })).toEqual({ opacity: '0.55', pointerEvents: 'none' })
    await expect(card.getByRole('button', { name: 'viac' }).first()).toBeDisabled()

    // ⚠⚠ THE JS GUARD, PINNED BY BEHAVIOUR — added in the PI-T4 review, which caught
    // that the comment above PROMISED a cart assertion this block never made. Markup
    // was the only evidence: `toHaveClass`, a computed style and `toBeDisabled()`.
    // CLAUDE.md states outright that a `disabled` attribute does NOT stop a dispatched
    // click, so without this line the pair of JS guards (`FriendOrder`'s `editingLocked`
    // and `NeoStepper`'s own `if (props.disabled) return`) had no pin at all — delete
    // both and every assertion above still passes.
    const plus = card.getByRole('button', { name: 'viac' }).first()
    await plus.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await expect(card.locator('.val').first(),
      'a DISPATCHED click cannot mutate a read-only cart').toHaveText('0')

    // ⚠ AND THE STORED ORDER IS IGNORED: the friend ordered 3 × 250 g of the product
    // above in this very round, and the read-only grid still renders 0 everywhere.
    // Without `if (isReadonly.value) cart.value = {}` this reads „3".
    const orderedCard = page.getByTestId('product-card').filter({ hasText: `PI4 RO Ordered ${uniq}` })
    await expect(orderedCard).toBeVisible()
    await expect(orderedCard.locator('.val').first(),
      'the stored order is IGNORED in readonly (§UC-PI-006)').toHaveText('0')

    // No cartbar, no tabgroup, no stock bars (§UC-PI-006).
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
    await expect(page.getByTestId('main-tab-own')).toHaveCount(0)
    await expect(page.getByTestId('main-tab-guests')).toHaveCount(0)
    await expect(page.getByTestId('stock-bar')).toHaveCount(0)
    // …and no lock banner either: the warn banner above the catalogue already says it.
    await expect(page.getByTestId('portal-landing'))
      .not.toContainText('Už nie je možné meniť objednávku')

    // ⚠ THE CATEGORY STRIP STAYS INTERACTIVE — resolved conflict 6: „only the CARDS
    // are read-only/faded … every category is browsable". This is also the
    // non-vacuity gate for `pointer-events:none` above: if the whole panel were
    // wrapped, this click would time out.
    await expect(page.getByTestId('purpose-tabs')).toBeVisible()
    await page.getByTestId('purpose-tabs').getByRole('tab', { name: 'Filter' }).click()
    await expect(page.getByTestId('product-card').filter({ hasText: filterName })).toBeVisible()
    await expect(page.getByTestId('product-card').filter({ hasText: espressoName })).toHaveCount(0)

    // ⚠ NON-VACUITY FOR „no stock bars", AND THE „landing-only" CLAIM IN ONE STEP:
    // the SAME product on the deep link renders its bar, because `readonly` is a
    // landing-mode switch and §UC-PI-018 leaves `/cycle/:id` exactly as it shipped.
    await gotoCycle(page, cycle.id)
    await expect(page.getByTestId('stock-bar').first()).toBeVisible()
    await expect(page.locator('.cartbar')).toBeVisible()
    await expect(page.getByTestId('main-tab-own')).toBeVisible()
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. PI-T5 — the landing, LOCKED state (18 §UC-PI-007)
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠ THE FIXTURE IS THE HALF THAT MATTERS HERE, and PI-T4 paid for the lesson: every
// closed-state fixture in §5 used a FRESH friend, so „the read-only grid ignores the
// stored order" passed by accident until one was added that had really ordered. On a
// LOCKED landing the friend almost always HAS an order — it is the whole subject of
// the screen — so every fixture below submits one, and §6.1 asserts both halves at
// once: the quantities are in the CARD and the grid beside it still reads 0.
//
// ⚠ AND ONE OBVIOUS ASSERTION IS DELIBERATELY ABSENT. This is the first
// `variant="vertical"` `CycleTimeline` on the friend portal, and module 17 recorded
// (09 §UC-CS-006 / its learnings) that a computed-style read of the marker's border
// proves NOTHING inside `.app`: the portal supplies `--nb-ink` with a value
// byte-identical to the component's own fallback, so the assertion passes whether
// the fallback exists or not. The runtime proof of that mechanism lives on the admin
// page, where the token is genuinely absent. §6.5 pins the step COUNTS and the
// current step's LABEL, which are real here — and drives the stage so the „now" step
// MOVES, which a hardcoded render could not fake.

/** The stage a freshly locked round gets (CS-T1: lock ⇒ `ordered`) ⇒ step 3 of 6. */
const STEP_ORDERED = 'Objednávky uzavreté, káva objednaná v pražiarni'
const STEP_ARRIVED = 'Káva dorazila, balíme'

/**
 * A REAL round with a REAL submitted order, then LOCKED — §UC-PI-007's subject.
 *
 * `delivery` picks which ONE of the three pickup targets the order carries
 * (`helpers/pickup.js`: exactly one of them exists). The `location` variant also
 * DEACTIVATES its pickup point straight after the submit, which does double duty: it
 * leaves no active row behind for the other spec files (`pickup_locations` is global
 * — `distribution-board.spec.js` §5) and it pins that the badge reads the server's
 * `pickup` block, whose name lookup carries no `active = 1` filter on purpose.
 */
async function lockedRound(label, { delivery = 'note' } = {}) {
  const friend = await makeFriend(label)
  // ⚠ No `markup_ratio` is passed: `POST /api/cycles` does not read one and the
  // column defaults to 1.0, which is what makes the amounts below exact.
  const cycle = await makeCycle(label)
  const espresso = await addProduct(cycle.id, {
    name: `PI5 ${label} Espresso ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 5000,
  })
  const filter = await addProduct(cycle.id, {
    name: `PI5 ${label} Filter ${uniq}`, purpose: 'Filter', price_250g: 10,
  })

  let location = null
  const body = {}
  if (delivery === 'packeta') {
    expect((await admin(`/api/cycles/${cycle.id}`, {
      method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.5 },
    })).status(), 'parcel enabled').toBe(200)
    body.use_parcel_delivery = true
    body.packeta_address = `Z-BOX Hlavná 15, Bratislava ${uniq}`
  } else if (delivery === 'location') {
    const created = await admin('/api/pickup-locations', {
      method: 'post', data: { name: `PI5 Bod ${label} ${uniq}`, address: 'Ružová 1' },
    })
    expect(created.status(), 'pickup location create').toBe(201)
    location = await created.json()
    body.pickup_location_id = location.id
  } else {
    body.pickup_location_note = `Pri fontáne ${uniq}`
  }

  const friendCall = (path, data, method = 'put') => ctx[method](path, {
    headers: { Authorization: `Bearer ${friend.token}` }, data, timeout: TIMEOUT,
  })

  expect((await friendCall(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, {
    items: [
      { product_id: espresso.id, variant: '250g', quantity: 2 },
      { product_id: filter.id, variant: '250g', quantity: 1 },
    ],
  })).status(), 'cart saved').toBe(200)

  const submitted = await friendCall(`/api/orders/cycle/${cycle.id}/friend/${friend.id}/submit`, body, 'post')
  expect(submitted.status(), 'order submitted').toBe(200)

  if (location) {
    expect((await admin(`/api/pickup-locations/${location.id}`, {
      method: 'patch', data: { active: false },
    })).status(), 'pickup point deactivated again').toBe(200)
  }

  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status())
    .toBe(200)

  const read = await friendCall(`/api/orders/cycle/${cycle.id}/friend/${friend.id}`, undefined, 'get')
  const orderRow = (await read.json()).order

  return { friend, cycle, espresso, filter, location, order: orderRow, packeta: body.packeta_address || null, note: body.pickup_location_note || null }
}

/** Land on the locked round, with the cycles payload stubbed to it (+ extra rows). */
async function openLocked(page, fx, { hasOrder = true, extraRows = [] } = {}) {
  await signIn(page, fx.friend)
  await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
  await stubCycles(page, [
    cycleRow({ n: 60, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder }),
    ...extraRows,
  ])
  await open(page)
}

const ownCard = (page) => page.getByTestId('own-order-card')

test.describe('PI-T5 · 18 §UC-PI-007 — the landing, locked state', () => {
  test('the own-order card carries the lines, the fee and the total — the grid beside it carries none of it', async ({ page }) => {
    const fx = await lockedRound('Card', { delivery: 'packeta' })
    await openLocked(page, fx)

    const card = ownCard(page)
    await expect(card).toBeVisible()
    await expect(card).toContainText('Vaša objednávka')
    await expect(card.getByText('Odoslaná', { exact: true })).toBeVisible()

    // ⚠ `CartLineList`, the ONE home — so the lines are `li.ln`, grouped by purpose
    // with a badge header each, and the amounts carry `€` (never `EUR`, which is the
    // TOTALS unit — CLAUDE.md §Frontend).
    const lines = card.getByTestId('own-order-line')
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0)).toContainText(fx.espresso.name)
    await expect(lines.nth(0).locator('.ln-qty')).toHaveText('2×')
    await expect(lines.nth(0).locator('.ln-amt')).toHaveText('16.00 €')
    await expect(lines.nth(1)).toContainText(fx.filter.name)
    await expect(lines.nth(1).locator('.ln-amt')).toHaveText('10.00 €')
    // The group headers, in the category strip's order (`availablePurposes`).
    await expect(card.locator('li.ln-group')).toHaveText(['Espresso', 'Filter'])

    // ⚠ THE PACKETA FEE IS AN EXTRA, NEVER AN ITEM: `orders.delivery_fee` is a field
    // ON the order and has never been an `order_items` row (CLAUDE.md §Money & data).
    // So it has no purpose header, no quantity and no size — and it is NOT one of the
    // two `own-order-line` rows counted above.
    const fee = card.locator('li.ln').filter({ hasText: 'Doručenie Packetou' })
    await expect(fee).toHaveCount(1)
    await expect(fee.locator('.ln-amt')).toHaveText('3.50 €')
    await expect(fee.locator('.ln-qty')).toHaveCount(0)

    // ⚠ `paymentTotal` = goods + `delivery_fee`, for DISPLAY (04 resolved conflict
    // #9). 16 + 10 + 3.50. `EUR` on a total.
    await expect(card.getByTestId('own-order-total')).toHaveText('29.50 EUR')

    // ⚠⚠ AND THE GRID BESIDE IT SHOWS NOTHING OF THIS ORDER. PI-T4's fix
    // (`if (isReadonly.value) cart.value = {}`) is what keeps the friend's three
    // bags out of the faded, disabled steppers — this is the screen it was written
    // for, and this fixture is one that can measure it.
    const orderedCard = page.getByTestId('product-card').filter({ hasText: fx.espresso.name })
    await expect(orderedCard).toBeVisible()
    await expect(orderedCard.locator('.val').first(),
      'the order belongs to the CARD, not to the grid\'s steppers').toHaveText('0')
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
  })

  test('the pickup row shows EXACTLY ONE target — location, note or Packeta', async ({ page }) => {
    // Three rounds, because the rule is „exactly one of the three" and one fixture
    // can only ever show that one of them renders.
    const cases = [
      { delivery: 'location', label: 'Loc', expected: (fx) => fx.location.name, absent: ['Packeta', 'fontáne'] },
      { delivery: 'note', label: 'Note', expected: (fx) => fx.note, absent: ['Packeta'] },
      { delivery: 'packeta', label: 'Pkt', expected: (fx) => `Packeta · ${fx.packeta}`, absent: ['fontáne'] },
    ]

    for (const c of cases) {
      const fx = await lockedRound(c.label, { delivery: c.delivery })
      await openLocked(page, fx)

      const badge = ownCard(page).getByTestId('own-order-pickup')
      await expect(badge, `${c.delivery}: exactly one target`).toHaveCount(1)
      await expect(badge).toContainText(c.expected(fx))
      for (const gone of c.absent) await expect(badge).not.toContainText(gone)
    }
  })

  test('Nezaplatené ⇒ Zaplatiť opens the ONE PaymentModal with the order total and the SERVER\'s VS — and writes no ledger row', async ({ page }) => {
    const fx = await lockedRound('Pay')
    await page.route('**/api/admin/payment-settings', (route) => route.fulfill({
      json: { paymentIban: 'SK3112000000198742637541', paymentRevolutUsername: 'gorifi', paymentCreditorName: '' },
    }))
    await openLocked(page, fx)

    const ledgerBefore = await ctx.get(`/api/transactions/friend/${fx.friend.id}`, {
      headers: { Authorization: `Bearer ${fx.friend.token}` }, timeout: TIMEOUT,
    })
    expect(ledgerBefore.status()).toBe(200)
    const rowsBefore = (await ledgerBefore.json()).length

    const card = ownCard(page)
    await expect(card.getByTestId('own-order-paid')).toHaveText('Nezaplatené')
    const pay = card.getByTestId('own-order-pay')
    await expect(pay).toHaveText('Zaplatiť 26.00 EUR')
    await pay.click()

    // ⚠ ONE modal — `FriendOrder`'s own. The session mounts none (the source pin
    // below), so this is the same surface the cartbar's „Zaplatiť" opens elsewhere.
    const modal = page.getByRole('dialog')
    await expect(modal).toHaveCount(1)
    await expect(modal).toContainText('Suma na úhradu: 26.00 EUR')

    // ⚠ THE VARIABLE SYMBOL IS THE SERVER'S — a friend order's VS IS its order id
    // (`backend/src/helpers/payment.js`), quoted from the order response. No client
    // derives one (CLAUDE.md §Money & data), which is why this asserts the value the
    // API issued rather than a locally composed string.
    await expect(modal.getByTestId('payment-vs')).toContainText(String(fx.order.id))

    await page.keyboard.press('Escape')

    // ⚠ NO LEDGER ROW, AND THAT IS THE POINT OF THE ASSERTION. `transactions` rows
    // come ONLY from the friend paid toggle and pack/unpack (CLAUDE.md §Money & data);
    // this surface shows a QR and writes nothing at all.
    const ledgerAfter = await ctx.get(`/api/transactions/friend/${fx.friend.id}`, {
      headers: { Authorization: `Bearer ${fx.friend.token}` }, timeout: TIMEOUT,
    })
    expect((await ledgerAfter.json()).length, 'opening a payment surface writes no ledger row').toBe(rowsBefore)
  })

  test('the admin marks it paid ⇒ „Zaplatené" and no button at all', async ({ page }) => {
    const fx = await lockedRound('Paid')
    // `paid` is ADMIN-ONLY (CLAUDE.md §Money & data) — the friend surface renders it,
    // it never writes it. This is the admin route doing the write.
    expect((await admin(`/api/orders/${fx.order.id}/paid`, { method: 'patch', data: { paid: true } })).status())
      .toBe(200)

    await openLocked(page, fx)
    const card = ownCard(page)
    await expect(card.getByTestId('own-order-paid')).toHaveText('Zaplatené')
    await expect(card.getByTestId('own-order-pay')).toHaveCount(0)
    // Non-vacuity: the card really is the one under test.
    await expect(card.getByTestId('own-order-total')).toHaveText('26.00 EUR')
  })

  test('„Kde je vaša káva" — module 17\'s VERTICAL timeline, and the „now" step really moves', async ({ page }) => {
    const fx = await lockedRound('Timeline')
    await openLocked(page, fx)

    const tl = page.getByTestId('cycle-timeline')
    await expect(page.getByTestId('where-is-my-coffee')).toContainText('Kde je vaša káva')
    await expect(tl).toHaveCount(1)
    // Six steps, and the compact dot strip is NOT what this surface mounts.
    await expect(tl.locator('.st')).toHaveCount(6)
    await expect(page.getByTestId('cycle-timeline-compact')).toHaveCount(0)

    // A freshly locked round is `stage = 'ordered'` (CS-T1: lock ⇒ `ordered`) ⇒
    // step 3 of 6: two done, one now, three next.
    await expect(tl.locator('.st.done')).toHaveCount(2)
    await expect(tl.locator('.st.now')).toHaveCount(1)
    await expect(tl.locator('.st.next')).toHaveCount(3)
    await expect(tl.locator('.st.now .lbl')).toHaveText(STEP_ORDERED)

    // ⚠ THE DISCRIMINATING HALF: the admin advances the stage and the „now" step
    // MOVES. A hardcoded render, or one that built its own step array, passes every
    // assertion above and fails here — which is what makes „17 owns the now rule;
    // this module only mounts it" measurable rather than merely written down.
    expect((await admin(`/api/cycles/${fx.cycle.id}`, { method: 'patch', data: { stage: 'arrived' } })).status())
      .toBe(200)
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({
      n: 61, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'arrived', hasOrder: true,
    })])
    await open(page)

    await expect(tl.locator('.st.now .lbl')).toHaveText(STEP_ARRIVED)
    await expect(tl.locator('.st.done')).toHaveCount(3)
    expect(STEP_ARRIVED, 'the two labels differ — otherwise the move above measures nothing')
      .not.toBe(STEP_ORDERED)
  })

  test('the next-round banner: the SHORT date, the plan note, and „dáme vedieť"', async ({ page }) => {
    const fx = await lockedRound('Next')
    const opensAt = isoPlusDays(14)
    await openLocked(page, fx, {
      extraRows: [cycleRow({ n: 62, status: 'planned', opens_at: opensAt, created_at: '2026-09-09 10:00:00' })],
    })

    const banner = page.getByTestId('landing-next-round')
    await expect(banner).toContainText('Ďalšia objednávka')
    await expect(banner).toContainText(`približne ${shortForm(opensAt)}`)
    await expect(banner).toContainText('ponuku si už môžete prezrieť nižšie')

    // ⚠⚠ THE SHORT FORM, AND IT IS NOT A CALL-SITE RESOLUTION OF THE RECORDED PO
    // QUESTION (§5's header, learnings 10 §1). That question is about module 17's
    // ONE sentence — „Ďalšia objednávka sa otvorí približne {fmtDay}" — which this
    // banner is not: §UC-PI-007 specifies a shorter sentence of module 18's own,
    // and PI-T1's rule says a date standing alone after a preposition is SHORT.
    // The long form must not appear here, and the two spellings must differ or this
    // whole assertion measures nothing.
    expect(shortForm(opensAt)).not.toBe(longForm(opensAt))
    await expect(banner).not.toContainText(longForm(opensAt))

    // Branch 2 — the admin's `plan_note`, verbatim.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [
      cycleRow({ n: 60, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder: true }),
      cycleRow({ n: 63, status: 'planned', plan_note: 'Otvoríme po sviatkoch.', created_at: '2026-09-09 10:00:00' }),
    ])
    await open(page)
    await expect(banner).toContainText('Ďalšia objednávka Otvoríme po sviatkoch. — ponuku si už môžete prezrieť nižšie.')

    // Branch 3 — nothing planned at all.
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [
      cycleRow({ n: 60, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder: true }),
    ])
    await open(page)
    await expect(banner).toContainText('Ďalšia objednávka — dáme vedieť — ponuku si už môžete prezrieť nižšie.')
  })

  test('⚠ the tabgroup STAYS here and is GONE on the closed catalogue — the same grid, one split term', async ({ page }) => {
    const fx = await lockedRound('Tabs')
    await openLocked(page, fx)

    // ── the LOCKED landing (§UC-PI-007): inert grid, LIVE tabs ────────────────
    await expect(page.getByTestId('main-tab-own')).toBeVisible()
    await expect(page.getByTestId('main-tab-guests')).toBeVisible()
    // The panel really is a tab interface again — `readonly` alone used to strip
    // these two attributes with the tabs.
    await expect(page.locator('#panel-own')).toHaveAttribute('role', 'tabpanel')
    await expect(page.locator('#panel-own')).toHaveAttribute('aria-labelledby', 'tab-own')
    await page.getByTestId('main-tab-guests').click()
    await expect(page.locator('#panel-guests')).toBeVisible()
    await page.getByTestId('main-tab-own').click()

    // …and the grid is still read-only: faded, inert, no stock bars, no cartbar.
    const grid = page.getByTestId('product-grid')
    await expect(grid).toHaveClass(/\bp2-ro\b/)
    const card = page.getByTestId('product-card').filter({ hasText: fx.espresso.name })
    const plus = card.getByRole('button', { name: 'viac' }).first()
    await expect(plus).toBeDisabled()
    await plus.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await expect(card.locator('.val').first(),
      'a DISPATCHED click cannot mutate a read-only cart (CLAUDE.md: `disabled` stops nothing)')
      .toHaveText('0')
    await expect(page.getByTestId('stock-bar')).toHaveCount(0)
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
    // The shipped locked treatment is REPLACED here (§UC-PI-007), not repeated.
    await expect(page.getByTestId('portal-landing'))
      .not.toContainText('Už nie je možné meniť objednávku')

    // ── the SAME round, now CLOSED (§UC-PI-006): inert grid, NO tabs ──────────
    // ⚠ This is the other direction of the split, measured on one page object: a
    // single `isReadonly` term cannot satisfy both halves, which is exactly why
    // PI-T5 had to split it. Collapse `hasTabs` back into `isReadonly` and one of
    // these two blocks goes red whichever way it is collapsed.
    expect((await admin(`/api/cycles/${fx.cycle.id}`, { method: 'patch', data: { status: 'completed' } })).status())
      .toBe(200)
    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({ n: 64, id: fx.cycle.id, name: fx.cycle.name, status: 'completed' })])
    await open(page)
    await dismissLandingState(page)

    await expect(page.getByTestId('portal-landing')).toContainText(`Minulá ponuka · ${fx.cycle.name}`)
    await expect(page.getByTestId('main-tab-own')).toHaveCount(0)
    await expect(page.getByTestId('main-tab-guests')).toHaveCount(0)
    await expect(page.locator('#panel-own')).not.toHaveAttribute('role', 'tabpanel')
    // Non-vacuity: the grid is still the same read-only grid, so what changed is the
    // tabgroup and nothing else.
    await expect(page.getByTestId('product-grid')).toHaveClass(/\bp2-ro\b/)
    await expect(page.getByTestId('own-order-card')).toHaveCount(0)
  })

  test('locked with NO own order ⇒ the SAME parametrised modal, two different strings', async ({ page }) => {
    const fx = await lockedRound('NoOrder')
    // A DIFFERENT friend, who never ordered in this round — and the payload says so.
    const stranger = await makeFriend('Stranger')
    await signIn(page, stranger)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({ json: { balance: 0, transactions: [] } }))
    await stubCycles(page, [
      cycleRow({ n: 65, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder: false }),
      cycleRow({ n: 66, status: 'planned', opens_at: isoPlusDays(14), created_at: '2026-09-09 10:00:00' }),
    ])
    await open(page)

    const modal = landingStateModal(page)
    await expect(modal).toBeVisible()
    await expect(modal.locator('.m-title')).toHaveText('Objednávky sú uzamknuté')
    await expect(modal).toContainText('Táto objednávka je už uzavretá — káva je objednaná v pražiarni.')
    // The shared card and the shared dots — one component, three strings.
    await expect(modal.getByTestId('next-round-card')).toBeVisible()
    await expect(modal.getByTestId('cycle-timeline-compact')).toHaveCount(1)

    // ⚠ THE DOTS DESCRIBE THE ROUND IN FLIGHT, NOT THE PLANNED ONE. §UC-PI-006's
    // closed modal is handed `nextCycle ?? catalogCycle` and emphasises „Pauza";
    // here the caller hands it `currentCycle`, which is locked, so the caption is
    // „Doručenie". The planned row above exists precisely so the two answers
    // DIFFER — without it this assertion could not tell which cycle was passed.
    const captions = modal.getByTestId('timeline-captions').locator('span')
    await expect(captions).toHaveText(['Pauza', 'Objednávky', 'Doručenie'])
    expect(await captions.nth(2).evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700')
    expect(await captions.nth(0).evaluate((el) => getComputedStyle(el).fontWeight)).not.toBe('700')
    await expect(modal.locator('[aria-label^="Krok 3 z 6"]'), 'the dots come from 17\'s stageIndex')
      .toHaveCount(1)

    await dismissLandingState(page)

    // …then the warn banner with this state's words, and no own-order surface at all.
    await expect(page.getByTestId('landing-locked-banner')).toContainText('Objednávky sú uzamknuté.')
    await expect(page.getByTestId('own-order-card')).toHaveCount(0)
    await expect(page.getByTestId('where-is-my-coffee')).toHaveCount(0)
    await expect(page.getByTestId('landing-next-round')).toHaveCount(0)

    // ⚠ The grid and the TABS are still here: a host who ordered nothing themselves
    // is exactly the party whose colleagues' hand-over ticks happen now
    // (`helpers/pickup.js`'s PO decision 2026-09-03 is about that very person).
    await expect(page.getByTestId('portal-landing')).toContainText(`Ponuka · ${fx.cycle.name}`)
    await expect(page.getByTestId('main-tab-own')).toBeVisible()
    await expect(page.getByTestId('main-tab-guests')).toBeVisible()
    await expect(page.getByTestId('product-grid')).toHaveClass(/\bp2-ro\b/)
    await expect(page.locator('.app .cartbar')).toHaveCount(0)
  })

  test('the appbar says „Vaša objednávka" with an order and „Aktuálna ponuka" without one', async ({ page }) => {
    const fx = await lockedRound('Subtitle')
    await openLocked(page, fx)
    await expect(page.locator('.appbar .titles .s')).toHaveText('Vaša objednávka')
    await expect(page.locator('.appbar .chip.p2-lock')).toHaveAttribute('title', 'Objednávky sú uzamknuté')

    await page.unroute('**/api/friends/cycles*')
    await stubCycles(page, [cycleRow({
      n: 67, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder: false,
    })])
    await open(page)
    await expect(page.locator('.appbar .titles .s')).toHaveText('Aktuálna ponuka')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6b. PI-T5 — the one-home pins the DOM cannot see (18 §UC-PI-007)
// ═════════════════════════════════════════════════════════════════════════════
test.describe('PI-T5 · 18 §UC-PI-007 — one loader, one modal, one normaliser', () => {
  test.skip(!HAS_SRC, NEEDS_SRC)

  test('the session mounts NO second PaymentModal and runs NO second order loader', () => {
    const session = assertReadable('views/FriendPortalSession.vue', ['lockedOwnOrder', 'payOwnOrder'])
    const order = assertReadable('views/FriendOrder.vue', ['defineExpose', 'ownOrder'])

    // ⚠ Same argument as the `GuestShareDialog` pin above, and the same reason it
    // cannot be a DOM one: a second `PaymentModal` mounted beside the first is
    // INVISIBLE until the two disagree about an amount or a variable symbol, which
    // is a state no test can reach on purpose. 15 §UC-PL-004/D4 and CLAUDE.md both
    // state the rule; this is where it is measured.
    const mounts = (src) => (src.match(/<PaymentModal\b/g) || []).length
    expect(mounts(order), 'FriendOrder.vue is the ONE home of this order\'s payment surface').toBe(1)
    // ⚠ SANCTIONED EDIT, PI-T7, case (a) of the immutability rule (03 §UC-FL-013).
    // ~~`expect(mounts(session)).toBe(0)` — „the session reaches it through
    // `openPaymentModal()`; it mounts none".~~ 18 §UC-PI-008/010 makes that
    // UNSATISFIABLE and for the right reason: the BALANCE's `PaymentModal` — a
    // different debt, a different `8`-prefixed symbol — was mounted in
    // `FriendBalanceCard.vue`, and PI-T7 gives that debt two surfaces on two views
    // (the „Zostatok a platby" card and the landing's debt banner). A mount inside
    // the card cannot be opened from a banner on another view, so it RELOCATED here
    // rather than being duplicated.
    //
    // THE PROTECTED PROPERTY IS UNTOUCHED, and it was never the zero: it is „this
    // ORDER's payment surface has one home, and the session is not a second one".
    // Stated precisely instead of by absence — the session's single mount is the
    // BALANCE's, it quotes `balancePayment`, and it is nowhere near the locked
    // card's `payOwnOrder()`. A second one makes the count 2, exactly as before.
    expect(mounts(session), 'exactly ONE PaymentModal in the session, and it is the balance\'s').toBe(1)
    expect(session, 'it quotes the server\'s balance block, not an order')
      .toMatch(/<PaymentModal[\s\S]{0,400}?:amount="balancePayment\.amount"/)
    expect(session, 'and the locked card still reaches FriendOrder\'s own modal')
      .toMatch(/function payOwnOrder\(\)[\s\S]{0,200}?lockedOrder\.value\?\.openPaymentModal/)
    expect(session, 'the session composes no amount, reference or symbol of its own')
      .not.toMatch(/:amount="[^"]*paymentTotal/)

    // …and the card's DATA is the same component's loaded order, not a second fetch.
    //
    // ⚠ SANCTIONED EDIT, PI-T6, case (a) of the immutability rule (03 §UC-FL-013):
    // this line used to read `.not.toContain('getOrderByFriend')`, and 18 §UC-PI-009
    // made that UNSATISFIABLE — „Moje objednávky" fetches a past round's lines
    // „lazily on first expand via `api.getOrderByFriend(cycle.id, friendId)`", by
    // name, in this same component. The protected property is untouched and is now
    // stated precisely instead of by absence: the LOCKED CARD runs no loader of its
    // own, and the session's one and only call to that endpoint is the history
    // view's. A second one — the defect this pin exists for — makes the count 2.
    expect((session.match(/getOrderByFriend/g) || []).length,
      'exactly ONE order GET in the session view, and it is the history view\'s').toBe(1)
    expect(session, 'and it lives inside `loadRoundLines`, not beside the own-order card')
      .toMatch(/function loadRoundLines\(id\)[\s\S]{0,600}?getOrderByFriend/)
    expect(session).toMatch(/lockedOrder\.value\?\.ownOrder/)
    expect(order).toMatch(/defineExpose\(\{[^}]*ownOrder/)
    expect(order).toMatch(/defineExpose\(\{[^}]*openPaymentModal/)
  })

  test('the ordered-line normaliser has ONE home, and both screens ask it', () => {
    const lib = assertReadable('lib/order-lines.js', ['export function orderLines', 'export function lineSize'])
    const order = assertReadable('views/FriendOrder.vue', ['cartLines'])
    expect(lib).toContain('export function cartLines')
    expect(lib).toContain('export function deliveryExtras')
    // The rule really MOVED rather than being copied: the `variant_label` / 'ks' /
    // raw-key ladder and the fee's name exist in the lib and nowhere in the view.
    expect(order, 'lineSize moved to lib/order-lines.js').not.toMatch(/function lineSize\(/)
    expect(order, "the fee's name has one spelling").not.toContain("name: 'Doručenie Packetou'")
    expect(order).toMatch(/from '@\/lib\/order-lines'/)
  })

  test('the tabgroup term is SPLIT — `hasTabs` asks a different question from `isReadonly`', () => {
    const src = assertReadable('views/FriendOrder.vue', ['const hasTabs = computed', 'colleaguesTab'])
    // The four sites §UC-PI-006/007 disagree about are all on `hasTabs` now, and the
    // grid's four `readonly` switches are all still on `isReadonly`. Mixing them up
    // is precisely the defect the split exists to prevent, and neither name may
    // quietly absorb the other.
    expect(src).toMatch(/v-if="hasTabs" class="tabgroup"/)
    expect(src).toMatch(/v-show="!hasTabs \|\| mainTab === 'own'"/)
    expect(src).toMatch(/:role="hasTabs \? 'tabpanel' : null"/)
    expect(src).toMatch(/:aria-labelledby="hasTabs \? 'tab-own' : null"/)
    expect(src, 'the cards wrapper still fades on `isReadonly`').toMatch(/'p2-ro': isReadonly/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. PI-T7 · 18 §UC-PI-008 — the debt banner, in all three landing states
//
// ⚠ §UC-PI-019 item 17 parks „debt banner three balances" in THIS file, because the
// banner is a property of the LANDING; the „Zostatok a platby" view it pays into is
// `portal-balance.spec.js`'s. The two halves of R2.3 are asserted here together on
// purpose: „never hide debt" and „never show a settled balance on the landing" are
// one product decision, and a test file that pinned only the first would let the
// second rot silently.
// ═════════════════════════════════════════════════════════════════════════════

/** A block shaped like `helpers/payment.js balancePaymentBlock()` publishes one. */
const DEBT_PAYMENT = {
  amount: 52.8,
  reference: 'PI7 / zostatok',
  iban: 'SK3112000000198742637541',
  revolut_username: 'gorifitest',
  variable_symbol: '8000777',
  creditor_name: 'Gorifi',
}

async function stubBalanceAt(page, balance, payment = DEBT_PAYMENT) {
  await page.route('**/api/friends/*/balance', (r) => r.fulfill({
    json: { balance, transactions: [], payment },
  }))
}

const debtBanner = (page) => page.getByTestId('debt-banner')

/** Index of a node among the page column's element children — for ORDER pins. */
async function columnIndex(page, testid) {
  return page.evaluate((id) => {
    const col = document.querySelector('[data-testid="portal-landing"]')
    const kids = [...col.children]
    return kids.findIndex((el) => el.matches(`[data-testid="${id}"]`) || el.querySelector(`[data-testid="${id}"]`))
  }, testid)
}

test.describe('PI-T7 · 18 §UC-PI-008 — the debt banner', () => {
  test('OPEN state: the banner sits between the status line and the order surface', async ({ page }) => {
    const friend = await makeFriend('DebtOpen')
    const cycle = await makeCycle('DebtOpen', { closes_at: '2026-09-25' })
    await addProduct(cycle.id, { name: `PI7 Open Bean ${uniq}`, purpose: 'Espresso', price_250g: 7 })

    await signIn(page, friend)
    await stubBalanceAt(page, -52.8)
    await open(page)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'open')

    const banner = debtBanner(page)
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Nedoplatok 52.80 EUR')
    // The prototype's „z minulého kola" is DROPPED and nothing replaces it (18
    // resolved conflict 1) — which is also what keeps „kolo" off a friend surface.
    await expect(banner).not.toContainText('kola')
    await expect(banner).toHaveClass(/\bdanger\b/)
    await expect(banner).toHaveClass(/\bslim\b/)
    await expect(banner.locator('.dot')).toHaveCount(1)

    // §UC-PI-005 item 2: slot TWO — after the status line, before the grid.
    const status = await columnIndex(page, 'landing-status')
    const debt = await columnIndex(page, 'debt-banner')
    expect(status, 'non-vacuity: both are really on the page').toBeGreaterThanOrEqual(0)
    expect(debt, 'the debt banner follows the status line').toBeGreaterThan(status)
    const gridIdx = await page.evaluate(() => {
      const col = document.querySelector('[data-testid="portal-landing"]')
      return [...col.children].findIndex((el) => el.matches('[data-fo-mode="landing"]') || el.querySelector('[data-fo-mode="landing"]'))
    })
    expect(gridIdx, 'and precedes the order surface').toBeGreaterThan(debt)
  })

  test('CLOSED state: the banner is there once the state modal is dismissed', async ({ page }) => {
    const friend = await makeFriend('DebtClosed')
    await signIn(page, friend)
    await stubBalanceAt(page, -52.8)
    await stubCycles(page, [cycleRow({ n: 70, status: 'completed' })])
    await open(page)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'closed')

    await dismissLandingState(page)
    const banner = debtBanner(page)
    await expect(banner).toContainText('Nedoplatok 52.80 EUR')
    // §UC-PI-006 item 3: after the „Objednávky sú zatvorené." warn banner.
    const closed = await columnIndex(page, 'landing-closed-banner')
    const debt = await columnIndex(page, 'debt-banner')
    expect(closed, 'non-vacuity: the closed banner is on the page').toBeGreaterThanOrEqual(0)
    expect(debt, 'the debt banner follows it').toBeGreaterThan(closed)
  })

  test('LOCKED state: the banner sits ABOVE the own-order card', async ({ page }) => {
    const fx = await lockedRound('DebtLocked')
    await signIn(page, fx.friend)
    await stubBalanceAt(page, -52.8)
    await stubCycles(page, [
      cycleRow({ n: 71, id: fx.cycle.id, name: fx.cycle.name, status: 'locked', stage: 'ordered', hasOrder: true }),
    ])
    await open(page)
    await expect(page.getByTestId('portal-landing')).toHaveAttribute('data-landing-state', 'locked')

    await expect(ownCard(page), 'non-vacuity: the own-order card really rendered').toBeVisible()
    await expect(debtBanner(page)).toContainText('Nedoplatok 52.80 EUR')

    // §UC-PI-007 item 1: „above the own-order card in `locked`".
    const debt = await columnIndex(page, 'debt-banner')
    const card = await columnIndex(page, 'own-order-card')
    expect(debt, 'non-vacuity: both are on the page').toBeGreaterThanOrEqual(0)
    expect(card, 'the own-order card follows the debt banner').toBeGreaterThan(debt)
  })

  test('⚠ zero and positive: NOTHING about money on the landing, in any state', async ({ page }) => {
    // R2.3, and it is a PRODUCT DECISION rather than a rounding tolerance: a settled
    // friend gets no „Môj účet", no „Transakcie" and no figure at all.
    const friend = await makeFriend('DebtZero')
    const cycle = await makeCycle('DebtZero')
    await addProduct(cycle.id, { name: `PI7 Zero Bean ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await signIn(page, friend)

    for (const balance of [0, 0.004, -0.004, 10.5]) {
      await page.unroute('**/api/friends/*/balance')
      await stubBalanceAt(page, balance)
      await open(page)
      await expect(page.getByTestId('landing-status'), `non-vacuity (${balance}): the landing really rendered`).toBeVisible()
      await expect(debtBanner(page), `balance ${balance} is not a debt`).toHaveCount(0)
      await expect(page.getByText('Môj účet'), `balance ${balance}: no account card`).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Transakcie' })).toHaveCount(0)
      await expect(page.getByTestId('pay-balance')).toHaveCount(0)
      // ⚠ NOT „no `EUR` anywhere": the open landing's cartbar legitimately prints a
      // total. The thing that must be absent is the BALANCE's vocabulary.
      await expect(page.getByText(/Nedoplatok/), `balance ${balance}: no debt copy`).toHaveCount(0)
      await expect(page.getByTestId('balance-amount'), `balance ${balance}: no figure`).toHaveCount(0)
    }

    // …and one cent past the threshold it IS a debt — the gate is real, not an
    // absence that would pass whatever the balance were.
    await page.unroute('**/api/friends/*/balance')
    await stubBalanceAt(page, -0.02)
    await open(page)
    await expect(debtBanner(page)).toContainText('Nedoplatok 0.02 EUR')
  })

  test('„Zaplatiť“ opens the ONE shared Platba modal with the server\'s block', async ({ page }) => {
    const friend = await makeFriend('DebtPay')
    const cycle = await makeCycle('DebtPay')
    await addProduct(cycle.id, { name: `PI7 Pay Bean ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await signIn(page, friend)
    await stubBalanceAt(page, -52.8)
    await open(page)

    await expect(page.getByRole('dialog'), 'nothing is mounted until it is opened').toHaveCount(0)
    await page.getByTestId('debt-banner-pay').click()

    const d = page.getByRole('dialog')
    await expect(d, 'ONE modal — the mount is relocated into the session, never duplicated').toHaveCount(1)
    await expect(d.locator('.m-title')).toHaveText('Platba')
    await expect(d, '§UC-PI-008: amount = -balance').toContainText('Suma na úhradu:')
    await expect(d).toContainText('52.80 EUR')
    // Quoted from the server's block, never composed here (15 §UC-PL-003 item 4).
    await expect(page.getByTestId('payment-vs').locator('.val')).toHaveText('8000777')
    await expect(page.getByTestId('payment-reference')).toContainText('PI7 / zostatok')

    await d.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog'), 'closing UNMOUNTS it — a live scrim eats every click').toHaveCount(0)
    await expect(debtBanner(page), 'and the banner is still there: nothing was settled').toBeVisible()
  })

  test('a FAILED balance renders no banner and no error on the landing', async ({ page }) => {
    // §UC-PI-008: „the balance view owns the error surface". The landing says nothing.
    const friend = await makeFriend('DebtFail')
    const cycle = await makeCycle('DebtFail')
    await addProduct(cycle.id, { name: `PI7 Fail Bean ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await signIn(page, friend)
    await page.route('**/api/friends/*/balance', (r) => r.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'Zostatok sa nepodarilo načítať' }),
    }))
    await open(page)

    await expect(page.getByTestId('landing-status'), 'non-vacuity: the landing rendered').toBeVisible()
    await expect(debtBanner(page)).toHaveCount(0)
    await expect(page.getByText('Zostatok sa nepodarilo načítať')).toHaveCount(0)
    await expect(page.locator('.banner.danger')).toHaveCount(0)
  })
})
