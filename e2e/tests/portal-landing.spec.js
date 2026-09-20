import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { assertReadable, code, HAS_SRC, NEEDS_SRC } from '../helpers/source-pins.js'
import { expectLanding, drawer, openMenu, menuGo, gotoCycle } from '../helpers/portal.js'

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

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

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
