import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FO-4 — the four modals FriendOrder owns: Spôsob prevzatia (04 §UC-FO-010),
// Hotovo! (§UC-FO-011), Zrušiť objednávku? (§UC-FO-012) and the leave guard
// (§UC-FO-013), all moved off shadcn `Dialog` onto `NeoModal`.
//
// What this file pins, and why each one is a silent regression without it:
//
// (A) THE 4-SCENARIO MATRIX, INCLUDING THE ROW THAT RENDERS NOTHING.
//     "no locations + no parcel ⇒ NO modal" is the only row whose evidence is an
//     ABSENCE, so it is the one a restyle can break without anything looking
//     wrong: a modal that opens with two empty sections and a Potvrdiť button is
//     a perfectly plausible-looking bug that adds a mandatory tap to every submit
//     on every cycle that configured neither option. The other three rows differ
//     only in which sections and which COPY appear — in particular the parcel-only
//     pair keeps the repo's "Bez doručenia (vyzdvihnem osobne)", which is not the
//     both-scenario's "Osobný odber".
//
// (B) EVERY PRE-SELECTION BRANCH, because pre-selection is what makes 04's routing
//     rule tolerable. The modal opens on EVERY explicit submit, first and
//     Aktualizovať alike; that is only acceptable while a re-submit opens on the
//     previous answer and is one tap. A broken branch turns every update into
//     re-answering a question the friend already answered — or worse, silently
//     switches a Packeta order back to pickup.
//
// (C) SAVE-AS-DEFAULT, BOTH DIRECTIONS. It writes to the friend's PROFILE, i.e. it
//     outlives the order, so: it must be UNCHECKED by default (resolved conflict
//     #11 — the prototype's `checked={true}` is a demo constant, and a persistent
//     setting must not change because someone submitted an order), it must
//     actually reach `PATCH /friends/:id/profile` when ticked, and its failure must
//     be NON-BLOCKING — a profile-save 500 that swallowed the submit would lose the
//     order over a convenience feature.
//
// (D) THE SUCCESS MODAL'S PAYMENT BLOCK AND ITS EXIT. The QR is asserted to be a
//     REAL QR code — the three finder patterns are decoded off the rendered pixels
//     — because `.qr` is 190×190 of ink frame whether or not what sits in it can be
//     scanned, and the prototype ships a pseudo-QR generator that must NOT have
//     been ported. And there is NO payment-reference row: the reference lives only
//     in the Platba modal (RD-GX-2). All four close routes land on the portal
//     WITHOUT the leave modal firing — the one interaction where two modals could
//     legitimately be in flight at once.
//
// (E) THE CANCEL BANNER'S PROMISE ABOUT SOMEBODY ELSE'S DATA. "Kolegov, ktorí
//     objednali cez váš odkaz, sa to nedotkne" is a claim on the guest tables, and
//     a spec is the only thing that can keep it true: the flows are wired through
//     different routers and nothing in the view would break if that stopped
//     holding. A real colleague sub-order is created, the host cancels, and the
//     sub-order is re-read for status/paid/delivered.
//
// (F) THE LEAVE GUARD'S THREE OUTCOMES — stay / leave / dismiss — plus the fact
//     that dismissing CLEARS the pending target. A stale `pendingNavigation` would
//     send the friend somewhere they never asked to go on the next confirm.
//
// (G) FOOTER WIDTHS AT 320px. Every `.btn` is `white-space:nowrap`, so a footer
//     that does not fit does not wrap — it overflows. `Potvrdiť a odoslať` is the
//     longest label on this screen and it shares a row with `Zrušiť`.
//
// Hermetic: its own friend, its own cycles, its own products. Pickup locations are
// GLOBAL rows, so they are created `for_coffee: 0, for_bakery: 0` — invisible to
// every real `GET /pickup-locations?type=…` in the app, and therefore to every
// other spec — and injected per test through `page.route`. That is what lets the
// four matrix rows be four independent tests instead of an ordered sequence.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null
let locA = null
let locB = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

async function makeCycle(label, over = {}) {
  const name = `E2E RDFO4 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open', ...over } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

/** Parcel delivery is PATCH-only on `/api/cycles/:id` — POST ignores both fields. */
async function enableParcel(cycleId, fee) {
  const res = await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: fee } })
  expect(res.status(), 'enable parcel').toBe(200)
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function setStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

async function seedCart(cycleId, items) {
  const res = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, {
    headers: host.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(res.status(), 'seed cart').toBe(200)
  return res.json()
}

async function seedSubmitted(cycleId, items, submitBody = {}) {
  await seedCart(cycleId, items)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, {
    headers: host.auth, data: submitBody, timeout: TIMEOUT,
  })
  expect(res.status(), 'seed submit').toBe(200)
  return (await res.json()).order
}

async function serverOrder(cycleId) {
  const res = await ctx.get(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, timeout: TIMEOUT })
  expect(res.status()).toBe(200)
  return (await res.json()).order
}

async function profile() {
  const res = await ctx.get(`/api/friends/${host.id}/profile`, { headers: host.auth, timeout: TIMEOUT })
  expect(res.status()).toBe(200)
  return res.json()
}

async function setProfilePacketa(address) {
  const res = await ctx.patch(`/api/friends/${host.id}/profile`, {
    headers: host.auth, data: { packeta_address: address }, timeout: TIMEOUT,
  })
  expect(res.status(), 'set profile packeta').toBe(200)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfo4_${uniq}`.slice(0, 30)
  const name = `RDFO4 Hostitel ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
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
  host = { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }

  // ⚠ `for_coffee: 0, for_bakery: 0` — real rows with real ids (so a submit that
  // carries one is a legitimate write), yet excluded from BOTH branches of
  // `GET /pickup-locations?type=…`, which is the only read the app performs. They
  // therefore cannot leak into another spec's run, and this file injects them
  // through `page.route` exactly where a scenario needs them.
  const mk = async (label, address) => {
    const res = await admin('/api/pickup-locations', {
      method: 'post',
      data: { name: `RDFO4 ${label} ${uniq}`, address, for_coffee: 0, for_bakery: 0 },
    })
    expect(res.status(), 'pickup location create').toBe(201)
    return res.json()
  }
  locA = await mk('Kancelária', 'Hlavná 1, Bratislava')
  locB = await mk('Sklad', 'Vedľajšia 2, Bratislava')
})

test.afterAll(async () => {
  // Belt and braces — the rows are already invisible to the app by their flags.
  for (const loc of [locA, locB]) {
    if (loc) await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' }).catch(() => {})
  }
  await ctx?.dispose()
})

// ---------------------------------------------------------------------------
// page helpers

async function signIn(page) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: host.id, friendName: host.name, token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
}

/**
 * The only read of pickup locations the app performs. Stubbing it is what makes
 * the four matrix rows independent — `locations: []` is a genuine "the admin
 * configured none", not "this test ran before the other one".
 */
async function stubLocations(page, locations) {
  await page.route('**/api/pickup-locations*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(locations) }))
}

// A cold deep-link to /cycle/:id bounces to `/` even with a valid stored session —
// `FriendOrder.vue`'s onMounted delegates restore to `FriendPortal`.
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
  await expect(page.locator('.app .cartbar')).toBeVisible()
}

const bar = (page) => page.locator('.app .cartbar')
const dialog = (page) => page.getByRole('dialog')
const plusIn = (page, name) =>
  page.getByTestId('product-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .locator('.vbox').first().getByRole('button', { name: 'viac' })

/** The checked state is the DOM state of the hidden native radio — never the paint. */
async function checkedMethod(page) {
  return page.locator('input[name="fo-delivery-method"]:checked').getAttribute('value')
}

// ---------------------------------------------------------------------------
// (A) the 4-scenario matrix

test.describe('UC-FO-010 — the 4-scenario matrix', () => {
  test('⚠ no locations + no parcel ⇒ NO modal at all, straight to doSubmitOrder()', async ({ page }) => {
    const cycle = await makeCycle('M1')
    const p = await addProduct(cycle.id, { name: `M1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    // The evidence for this row is an ABSENCE, so it is watched from the moment
    // the button is pressed rather than sampled once afterwards: the success modal
    // is itself a dialog, so a "no dialog ever appeared" assertion has to be taken
    // against the pickup modal's own contents.
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page), 'the success modal, NOT the pickup modal').toContainText('Hotovo!')
    await expect(page.getByText('Spôsob prevzatia')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Potvrdiť a odoslať' })).toHaveCount(0)

    const order = await serverOrder(cycle.id)
    expect(order.status).toBe('submitted')
    expect(order.pickup_location_id, 'nothing was asked, so nothing is stored').toBeNull()
    expect(order.packeta_address).toBeNull()
  })

  test('pickup locations only ⇒ the pickup section, and NO method radios', async ({ page }) => {
    const cycle = await makeCycle('M2')
    const p = await addProduct(cycle.id, { name: `M2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    await expect(d).toContainText('Spôsob prevzatia')
    await expect(d).toContainText('Vyberte, ako chcete dostať objednávku.')
    await expect(d.locator('input[name="fo-delivery-method"]'), 'no method choice to make').toHaveCount(0)
    await expect(d.getByTestId('pickup-section')).toBeVisible()
    // Both locations plus the trailing "Iné".
    await expect(d.locator('input[name="fo-pickup-location"]')).toHaveCount(3)
    await expect(d.getByTestId('pickup-section')).toContainText(locA.name)
    await expect(d.getByTestId('pickup-section')).toContainText(locA.address)
    await expect(d.getByTestId('pickup-section')).toContainText('Iné')
    await expect(d.getByTestId('packeta-section')).toHaveCount(0)
  })

  test('⚠ parcel only ⇒ Packetou + the REPO copy "Bez doručenia (vyzdvihnem osobne)"', async ({ page }) => {
    const cycle = await makeCycle('M3')
    await enableParcel(cycle.id, 3.5)
    const p = await addProduct(cycle.id, { name: `M3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    const rows = d.locator('label[data-testid^="delivery-method-"]')
    await expect(rows).toHaveCount(2)
    // Order matters: with nothing to pick FROM, Packeta leads and the opt-out
    // trails it. "Osobný odber" would be a lie — there is no location.
    await expect(rows.nth(0)).toContainText('Doručenie Packetou')
    await expect(rows.nth(0)).toContainText('(+3.50 EUR)')
    await expect(rows.nth(1)).toHaveText(/Bez doručenia \(vyzdvihnem osobne\)/)
    await expect(d).not.toContainText('Osobný odber')
    // Pre-selection with no locations is packeta, so its section is what shows.
    expect(await checkedMethod(page)).toBe('packeta')
    await expect(d.getByTestId('packeta-section')).toBeVisible()
    await expect(d.getByTestId('pickup-section')).toHaveCount(0)
  })

  test('both ⇒ Osobný odber / Doručenie Packetou (+fee), with the pickup section', async ({ page }) => {
    const cycle = await makeCycle('M4')
    await enableParcel(cycle.id, 4.2)
    const p = await addProduct(cycle.id, { name: `M4 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    const rows = d.locator('label[data-testid^="delivery-method-"]')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toHaveText('Osobný odber')
    await expect(rows.nth(1)).toContainText('Doručenie Packetou')
    await expect(rows.nth(1)).toContainText('(+4.20 EUR)')
    await expect(d).not.toContainText('Bez doručenia')
    expect(await checkedMethod(page)).toBe('pickup')
    await expect(d.getByTestId('pickup-section')).toBeVisible()
    await expect(d.getByTestId('packeta-section')).toHaveCount(0)

    // Switching method swaps the sections — and the switch goes through the NATIVE
    // radio, which is the whole reason it stays in the DOM.
    await d.getByTestId('delivery-method-packeta').click()
    expect(await checkedMethod(page)).toBe('packeta')
    await expect(d.getByTestId('packeta-section')).toBeVisible()
    await expect(d.getByTestId('pickup-section')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (A2) the RadioRow itself — the native control, and the paint

test.describe('UC-FO-010 — the RadioRow keeps a real radio group', () => {
  test('⚠ hidden but focusable, arrow-navigable, and the paint follows the DOM', async ({ page }) => {
    const cycle = await makeCycle('R1')
    await enableParcel(cycle.id, 2)
    const p = await addProduct(cycle.id, { name: `R1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    const radios = d.locator('input[name="fo-delivery-method"]')

    // Hidden by CLIPPING, not by display/visibility — those two would delete the
    // control from the tab order and the a11y tree, i.e. exactly what the spec
    // keeps the native input FOR.
    const box = await radios.first().evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { display: cs.display, visibility: cs.visibility, w: r.width, h: r.height, pos: cs.position }
    })
    expect(box.display).not.toBe('none')
    expect(box.visibility).toBe('visible')
    expect(box.w).toBeLessThanOrEqual(1)
    expect(box.h).toBeLessThanOrEqual(1)
    // ⚠ BOTH halves, and neither is what the obvious story says. The recipe sets
    // NO `top`/`left`, so the box keeps its STATIC position (CSS 2.1 §10.3.7) and
    // focusing it scrolls nothing — with the insets omitted, forcing the row to
    // `position:static` is unobservable (measured: scrollTop 486→486 / 487→487,
    // same rect), so `relative` is NOT what makes the shipped code safe.
    // It is what makes the CLASSIC sr-only recipe safe: add `top:0;left:0` and a
    // static row yanks the dialog to the top (487→0, rect −488→−1) while a
    // positioned row does not move at all (487→487). RD-GX-1 lifts this block, so
    // both are asserted — a lift that restores the familiar insets onto an
    // unpositioned row is exactly the regression this pins.
    expect(box.pos).toBe('absolute')
    // ⚠ Asserted BEHAVIOURALLY, not by reading `top`/`left` — `getComputedStyle`
    // resolves `auto` insets on an absolutely positioned box to their USED value
    // (20.5px here), so it can never report the omission. What the omission buys
    // is that the control still sits inside its own row; what `relative` buys is
    // that the row is its containing block. Both are checked directly.
    const placement = await radios.first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      const row = el.parentElement.getBoundingClientRect()
      return {
        offsetParentIsRow: el.offsetParent === el.parentElement,
        insideRow: r.top >= row.top - 2 && r.bottom <= row.bottom + 2,
        rowPos: getComputedStyle(el.parentElement).position,
      }
    })
    expect(placement.rowPos, 'the .radiorow is the positioning context').toBe('relative')
    expect(placement.offsetParentIsRow, 'containing block is the row, not .modal-scrim').toBe(true)
    expect(placement.insideRow, 'static position kept — the control is in its own row').toBe(true)

    // Focusable and arrow-navigable — the native group behaviour.
    await radios.first().focus()
    expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('fo-delivery-method')
    await page.keyboard.press('ArrowDown')
    expect(await checkedMethod(page)).toBe('packeta')
    await page.keyboard.press('ArrowUp')
    expect(await checkedMethod(page)).toBe('pickup')

    // The paint follows the DOM: the checked row is accent-soft with an ink border
    // and a filled dot; the unchecked one is white with a 30% border and a white dot.
    const paint = await d.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('label[data-testid^="delivery-method-"]'))
      return rows.map((r) => {
        const cs = getComputedStyle(r)
        const dot = getComputedStyle(r.querySelector('span'))
        return { bg: cs.backgroundColor, border: cs.borderTopColor, dot: dot.backgroundColor, dotW: dot.width }
      })
    })
    expect(paint[0].bg, 'checked = accent-soft').not.toBe('rgb(255, 255, 255)')
    expect(paint[1].bg, 'unchecked = white').toBe('rgb(255, 255, 255)')
    expect(paint[0].border).not.toBe(paint[1].border)
    expect(paint[0].dot, 'checked dot is accent-filled').not.toBe('rgb(255, 255, 255)')
    expect(paint[1].dot).toBe('rgb(255, 255, 255)')
    expect(paint[0].dotW).toBe('18px')

    // ⚠ The unclassed content span cannot be reached by A10's class list, so the
    // call site sets it. Without this it inherits preflight's 1.5.
    const lh = await d.locator('label[data-testid="delivery-method-pickup"] span').last()
      .evaluate((el) => getComputedStyle(el).lineHeight)
    expect(lh, 'line-height:normal at the call site').toBe('normal')

    // The hidden input has no ring of its own, so the row wears it — but ONLY on
    // keyboard arrival. `:focus-within` (the obvious spelling) also fires for
    // POINTER input, and on a touch-first surface that leaves one row wearing a
    // magenta offset shadow permanently after any tap — a state neither the
    // prototype nor 02 specifies, on top of `.card.flat{box-shadow:none}`.
    const rowRing = () => d.locator('label[data-testid="delivery-method-pickup"]')
      .evaluate((el) => ({
        shadow: getComputedStyle(el).boxShadow,
        within: el.matches(':focus-within'),
        visible: el.matches(':has(:focus-visible)')
      }))

    // TAP: focus lands (so `:focus-within` is true) but no ring is painted.
    await d.getByTestId('delivery-method-pickup').click()
    const tapped = await rowRing()
    expect(tapped.within, 'a tap does focus the row').toBe(true)
    expect(tapped.visible, ':focus-visible stays false for pointer input').toBe(false)
    expect(tapped.shadow, '⚠ a tap must leave NO ring').toBe('none')

    // KEYBOARD: arriving by arrow key still paints.
    await page.keyboard.press('ArrowDown')
    const keyed = await d.locator('label[data-testid="delivery-method-packeta"]')
      .evaluate((el) => ({
        shadow: getComputedStyle(el).boxShadow,
        visible: el.matches(':has(:focus-visible)')
      }))
    expect(keyed.visible).toBe(true)
    expect(keyed.shadow, 'keyboard arrival paints what the hidden input cannot').not.toBe('none')

    // …and it still outranks `:where(…) .card.flat{box-shadow:none}` (0,2,0):
    // `:has()` takes its most specific argument, so the scoped rule stays (0,3,0).
    expect(keyed.shadow).toContain('3px 3px 0px')
  })

  test('choosing "Iné" reveals the note input, and it persists to the order', async ({ page }) => {
    const cycle = await makeCycle('R2')
    const p = await addProduct(cycle.id, { name: `R2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    // Nothing is pre-selected in the location group on a fresh order, and `null`
    // ("Iné") IS that state — so the note input is there from the start.
    await expect(d.getByTestId('pickup-note')).toBeVisible()

    // Picking a real location hides it again.
    await d.getByTestId('pickup-section').locator('label').first().click()
    await expect(d.getByTestId('pickup-note')).toHaveCount(0)

    // Back to Iné, type a note, confirm.
    await d.getByTestId('pickup-section').locator('label').last().click()
    await d.getByTestId('pickup-note').fill('Pri recepcii')
    await d.getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')

    const order = await serverOrder(cycle.id)
    expect(order.pickup_location_id).toBeNull()
    expect(order.pickup_location_note).toBe('Pri recepcii')
  })

  test('a real location is what lands on the order', async ({ page }) => {
    const cycle = await makeCycle('R3')
    const p = await addProduct(cycle.id, { name: `R3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    await d.getByTestId('pickup-section').locator('label').nth(1).click()
    await d.getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')

    const order = await serverOrder(cycle.id)
    expect(order.pickup_location_id).toBe(locB.id)
    expect(order.pickup_location_note).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (B) pre-selection — every branch

test.describe('UC-FO-010 — pre-selection on open, every branch', () => {
  test('an existing packeta_address ⇒ packeta + that address', async ({ page }) => {
    const cycle = await makeCycle('P1')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `P1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }], {
      use_parcel_delivery: true, packeta_address: 'Z-BOX Objednávková 9',
    })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()

    expect(await checkedMethod(page)).toBe('packeta')
    await expect(dialog(page).locator('#fo-packeta-address')).toHaveValue('Z-BOX Objednávková 9')
  })

  test('an existing pickup_location_id ⇒ pickup + that location', async ({ page }) => {
    const cycle = await makeCycle('P2')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `P2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }], {
      pickup_location_id: locB.id,
    })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()

    expect(await checkedMethod(page)).toBe('pickup')
    expect(await page.locator('input[name="fo-pickup-location"]:checked').inputValue()).toBe(String(locB.id))
    await expect(dialog(page).getByTestId('pickup-note'), 'not Iné, so no note field').toHaveCount(0)
  })

  test('an existing pickup_location_note ⇒ pickup + Iné + the note', async ({ page }) => {
    const cycle = await makeCycle('P3')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `P3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }], {
      pickup_location_note: 'Zvoňte na vrátnicu',
    })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()

    expect(await checkedMethod(page)).toBe('pickup')
    await expect(dialog(page).getByTestId('pickup-note')).toHaveValue('Zvoňte na vrátnicu')
  })

  test('nothing stored ⇒ pickup when locations exist, with packetaAddress primed from the PROFILE', async ({ page }) => {
    await setProfilePacketa('Z-BOX Profilová 42')
    const cycle = await makeCycle('P4')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `P4 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    expect(await checkedMethod(page)).toBe('pickup')
    // The profile default is loaded EAGERLY, not on the switch — which is what
    // makes flipping to Packeta a one-tap action for a friend who has one.
    await dialog(page).getByTestId('delivery-method-packeta').click()
    await expect(dialog(page).locator('#fo-packeta-address')).toHaveValue('Z-BOX Profilová 42')
  })

  test('nothing stored and NO locations ⇒ packeta, address primed from the profile', async ({ page }) => {
    await setProfilePacketa('Z-BOX Profilová 42')
    const cycle = await makeCycle('P5')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `P5 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    expect(await checkedMethod(page)).toBe('packeta')
    await expect(dialog(page).locator('#fo-packeta-address')).toHaveValue('Z-BOX Profilová 42')
  })

  test('⚠ the modal opens on EVERY explicit submit — Aktualizovať included', async ({ page }) => {
    const cycle = await makeCycle('P6')
    const p = await addProduct(cycle.id, { name: `P6 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }], {
      pickup_location_id: locA.id,
    })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)

    await plusIn(page, `P6 Kava ${uniq}`).click()
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()
    // Opens — and opens ON THE PREVIOUS ANSWER, which is what makes "it opens
    // every time" acceptable rather than an extra question per update.
    await expect(dialog(page)).toContainText('Spôsob prevzatia')
    expect(await page.locator('input[name="fo-pickup-location"]:checked').inputValue()).toBe(String(locA.id))

    await dialog(page).getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')
    expect((await serverOrder(cycle.id)).pickup_location_id).toBe(locA.id)
  })
})

// ---------------------------------------------------------------------------
// (C) save-as-default

test.describe('UC-FO-010 — "Uložiť ako predvolenú adresu"', () => {
  test('⚠ it is UNCHECKED by default (resolved conflict #11)', async ({ page }) => {
    const cycle = await makeCycle('S0')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `S0 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    await expect(dialog(page).getByTestId('save-packeta-default')).toHaveAttribute('aria-checked', 'false')
  })

  test('ticked ⇒ PATCH /friends/:id/profile, and the profile really changes', async ({ page }) => {
    await setProfilePacketa('Z-BOX Stará')
    const cycle = await makeCycle('S1')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `S1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    const patches = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/api\/friends\/\d+\/profile$/.test(r.url())) patches.push(r.postDataJSON())
    })

    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    const d = dialog(page)
    await d.locator('#fo-packeta-address').fill('Z-BOX Nová 7, Košice')
    await d.getByTestId('save-packeta-default').click()
    await expect(d.getByTestId('save-packeta-default')).toHaveAttribute('aria-checked', 'true')
    await d.getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')

    expect(patches, 'exactly one profile write').toHaveLength(1)
    expect(patches[0]).toEqual({ packeta_address: 'Z-BOX Nová 7, Košice' })
    expect((await profile()).packeta_address).toBe('Z-BOX Nová 7, Košice')
    expect((await serverOrder(cycle.id)).packeta_address).toBe('Z-BOX Nová 7, Košice')
  })

  test('UNticked ⇒ the order carries the address but the PROFILE is untouched', async ({ page }) => {
    await setProfilePacketa('Z-BOX Stála')
    const cycle = await makeCycle('S2')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `S2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    const patches = []
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/api\/friends\/\d+\/profile$/.test(r.url())) patches.push(r.url())
    })

    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    await dialog(page).locator('#fo-packeta-address').fill('Z-BOX Jednorazová 1')
    await dialog(page).getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')

    expect(patches, 'a persistent setting is not changed by an order').toEqual([])
    expect((await profile()).packeta_address).toBe('Z-BOX Stála')
    expect((await serverOrder(cycle.id)).packeta_address).toBe('Z-BOX Jednorazová 1')
  })

  test('⚠ a FAILING profile save does NOT block the submit', async ({ page }) => {
    const cycle = await makeCycle('S3')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `S3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    // The convenience feature fails; the order must not.
    await page.route('**/api/friends/*/profile', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) })
        : route.fallback())

    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    const d = dialog(page)
    await d.locator('#fo-packeta-address').fill('Z-BOX Odolná 3')
    await d.getByTestId('save-packeta-default').click()
    await d.getByRole('button', { name: 'Potvrdiť a odoslať' }).click()

    await expect(dialog(page), 'the submit went through anyway').toContainText('Hotovo!')
    await expect(page.locator('.banner.danger'), 'and it is not reported as an order failure').toHaveCount(0)
    const order = await serverOrder(cycle.id)
    expect(order.status).toBe('submitted')
    expect(order.packeta_address).toBe('Z-BOX Odolná 3')
  })

  test('Potvrdiť is disabled while the Packeta address is blank', async ({ page }) => {
    await setProfilePacketa('')
    const cycle = await makeCycle('S4')
    await enableParcel(cycle.id, 3)
    const p = await addProduct(cycle.id, { name: `S4 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()

    const d = dialog(page)
    const confirm = d.getByRole('button', { name: 'Potvrdiť a odoslať' })
    await expect(confirm).toBeDisabled()
    // Whitespace is not an address.
    await d.locator('#fo-packeta-address').fill('   ')
    await expect(confirm).toBeDisabled()
    await d.locator('#fo-packeta-address').fill('Z-BOX Platná 1')
    await expect(confirm).toBeEnabled()
    // …and it re-disables when the field is emptied again.
    await d.locator('#fo-packeta-address').fill('')
    await expect(confirm).toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// (D) the Hotovo! success modal

/**
 * Decodes the three QR finder patterns off the rendered <img>. This is the
 * difference between "the frame contains an image" and "the friend's banking app
 * can scan it": ui.jsx ships a deterministic PSEUDO-QR generator, and porting it
 * would look perfect in a screenshot and be worthless in a phone camera.
 */
async function readFinderPatterns(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('.qr img')
    if (!img) return { error: 'no img' }
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const n = img.naturalWidth
    const cv = document.createElement('canvas')
    cv.width = n
    cv.height = n
    const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0)
    const px = cx.getImageData(0, 0, n, n).data
    const dark = (x, y) => px[(y * n + x) * 4] < 128

    // Bounding box of the code itself (strip the quiet zone).
    let minX = n, minY = n, maxX = -1, maxY = -1
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!dark(x, y)) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return { error: 'all light' }

    // The first row of the code opens with the top-left finder: 7 dark modules.
    let run = 0
    while (dark(minX + run, minY)) run++
    const module = run / 7
    const size = Math.round((maxX - minX + 1) / module)

    // Sample module centres and compare against the canonical finder pattern.
    const at = (r, c) => dark(Math.round(minX + (c + 0.5) * module), Math.round(minY + (r + 0.5) * module))
    const finderOk = (r0, c0) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
          if (at(r0 + r, c0 + c) !== (ring || core)) return false
        }
      }
      return true
    }
    return {
      naturalWidth: n,
      size,
      topLeft: finderOk(0, 0),
      topRight: finderOk(0, size - 7),
      bottomLeft: finderOk(size - 7, 0),
    }
  })
}

test.describe('UC-FO-011 — the Hotovo! success modal', () => {
  test('⚠ ok-soft banner + mono sum + blue Revolut bar + a REAL QR in the 190px frame + mono IBAN', async ({ page }) => {
    const cycle = await makeCycle('H1')
    await enableParcel(cycle.id, 3.5)
    const p = await addProduct(cycle.id, { name: `H1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 9.04 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    await dialog(page).locator('#fo-packeta-address').fill('Z-BOX QR 1')
    await dialog(page).getByRole('button', { name: 'Potvrdiť a odoslať' }).click()

    const d = dialog(page)
    await expect(d).toContainText('Hotovo!')

    // 1. the ok-soft slim banner, with the sum in mono — and the fee split, which
    //    is repo information the prototype is silent about.
    const banner = d.locator('.banner.ok.slim')
    await expect(banner).toBeVisible()
    await expect(banner.locator('b.mono')).toHaveText('12.54 EUR')
    await expect(banner).toContainText('(9.04 EUR + 3.50 EUR doručenie)')
    const bannerFont = await banner.locator('b.mono').evaluate((el) => getComputedStyle(el).fontFamily)
    expect(bannerFont).toMatch(/Courier/i)

    // 2. the Revolut bar — a link, because it navigates off-site.
    const rev = d.getByRole('link', { name: 'Zaplatiť cez Revolut' })
    await expect(rev).toBeVisible()
    await expect(rev).toHaveAttribute('target', '_blank')
    await expect(rev).toHaveAttribute('rel', 'noopener noreferrer')
    expect(await rev.getAttribute('href')).toMatch(/^https:\/\/revolut\.me\//)
    const revStyle = await rev.evaluate((el) => {
      const cs = getComputedStyle(el)
      const p = el.parentElement
      const pcs = getComputedStyle(p)
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        w: el.getBoundingClientRect().width,
        // `.m-body`'s CONTENT box — the anchor is `.btn.block{width:100%}`, so it
        // spans that, not the padded border box.
        parent: p.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight),
      }
    })
    expect(revStyle.bg).toBe('rgb(0, 117, 235)')
    expect(revStyle.color).toBe('rgb(255, 255, 255)')
    expect(revStyle.w, '.btn.block spans the body').toBeCloseTo(revStyle.parent, 0)

    // 3. the QR: the neo frame's geometry, then the code inside it.
    await expect(d.locator('.qr img')).toBeVisible()
    const frame = await d.locator('.qr').evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const img = el.querySelector('img').getBoundingClientRect()
      return { w: r.width, h: r.height, border: cs.borderTopWidth, pad: cs.paddingTop, imgW: img.width, imgH: img.height }
    })
    expect(frame.w).toBe(190)
    expect(frame.h).toBe(190)
    expect(frame.border).toBe('3px')
    expect(frame.pad).toBe('10px')
    // 190 − 2×3 border − 2×10 padding
    expect(frame.imgW).toBe(164)
    expect(frame.imgH).toBe(164)

    const qr = await readFinderPatterns(page)
    expect(qr.error).toBeUndefined()
    expect(qr.size, 'a QR version is 21+ modules and ≡1 mod 4').toBeGreaterThanOrEqual(21)
    expect((qr.size - 21) % 4, 'a real QR grid size').toBe(0)
    expect(qr.topLeft, 'top-left finder pattern').toBe(true)
    expect(qr.topRight, 'top-right finder pattern').toBe(true)
    expect(qr.bottomLeft, 'bottom-left finder pattern').toBe(true)

    // 4. the IBAN line is mono.
    const iban = d.locator('.sub.mono')
    await expect(iban).toContainText('IBAN:')
    expect(await iban.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Courier/i)

    // ⚠ 5. NO payment-reference row. It lives ONLY in the Platba modal (RD-GX-2).
    await expect(d).not.toContainText(`${host.name} / ${cycle.name}`)
    await expect(d.locator('.copyrow')).toHaveCount(0)
    await expect(d.getByRole('button', { name: 'Kopírovať' })).toHaveCount(0)
  })

  test('⚠ the SAME subtitle on both paths (resolved conflict #4)', async ({ page }) => {
    const SUB = 'Objednávka bola odoslaná. Môžete ju upraviť až do uzamknutia cyklu.'
    const cycle = await makeCycle('H2')
    const p = await addProduct(cycle.id, { name: `H2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    // first submit
    await bar(page).getByRole('button', { name: 'Odoslať' }).click()
    await expect(dialog(page)).toContainText(SUB)
    await expect(dialog(page), 'the retired two-way message is gone').not.toContainText('úspešne odoslaná')

    // …back in, and update
    await dialog(page).getByRole('button', { name: 'OK' }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.getByRole('heading', { name: cycle.name, exact: true }).click()
    await expect(page.locator('.app .cartbar')).toBeVisible()
    await plusIn(page, `H2 Kava ${uniq}`).click()
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()
    await expect(dialog(page)).toContainText(SUB)
    await expect(dialog(page)).not.toContainText('bola aktualizovaná')
  })

  test('⚠ OK / × / scrim / Esc all land on the portal, and the leave modal never fires', async ({ page }) => {
    const cycle = await makeCycle('H3')
    const p = await addProduct(cycle.id, { name: `H3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])

    // Each route starts from a fresh, DIRTY-CAPABLE state: an unsubmitted cart is
    // exactly what arms `hasUnsavedChanges`, so if the success close did not bypass
    // the guard, the leave modal would appear on top of it.
    const routes = [
      ['OK', async () => dialog(page).getByRole('button', { name: 'OK' }).click()],
      ['×', async () => dialog(page).getByRole('button', { name: 'Zatvoriť dialóg' }).click()],
      ['scrim', async () => {
        const box = await page.locator('.modal-scrim').boundingBox()
        await page.mouse.move(box.x + 6, box.y + 6)
        await page.mouse.down()
        await page.mouse.up()
      }],
      ['Esc', async () => page.keyboard.press('Escape')],
    ]

    for (const [label, close] of routes) {
      await seedCart(cycle.id, [])
      await gotoCycle(page, cycle)
      await plusIn(page, `H3 Kava ${uniq}`).click()
      await bar(page).getByRole('button', { name: /Odoslať|Aktualizovať/ }).click()
      await expect(dialog(page), label).toContainText('Hotovo!')

      await close()
      await expect(page, `${label} lands on the portal`).toHaveURL(/\/$/)
      await expect(page.getByText('Neuložené zmeny'), `${label} must not arm the leave guard`).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    }
  })
})

// ---------------------------------------------------------------------------
// (E) the Zrušiť objednávku? confirm

test.describe('UC-FO-012 — the cancel confirm', () => {
  test('⚠ the banner\'s promise holds: a colleague\'s sub-order survives, flags intact', async ({ page }) => {
    const cycle = await makeCycle('C1')
    const p = await addProduct(cycle.id, { name: `C1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 2 }])

    // A REAL colleague sub-order, placed the only way one can be: through the
    // public guest checkout behind the host's share link.
    const share = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(share.status())
    const link = (await share.json()).link
    const sub = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: 'Kolega Kolegovic',
        guest_phone: '0902 111 222',
        items: [{ product_id: p.id, variant: '250g', quantity: 1 }],
      },
      timeout: TIMEOUT,
    })
    expect(sub.status(), 'guest submit').toBe(201)

    const before = (await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth, timeout: TIMEOUT })).json())
    expect(before.guest_orders).toHaveLength(1)
    const subId = before.guest_orders[0].id
    expect(before.guest_orders[0].paid).toBeFalsy()
    expect(before.guest_orders[0].delivered).toBeFalsy()

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    await bar(page).getByRole('button', { name: 'Zrušiť' }).click()
    const d = dialog(page)
    await expect(d).toContainText('Zrušiť objednávku?')
    await expect(d).toContainText('Naozaj chcete zrušiť objednávku a vymazať všetky položky z košíka?')
    const promise = d.locator('.banner.danger.slim')
    await expect(promise).toBeVisible()
    await expect(promise).toContainText('Položky sa vymažú z košíka. Kolegov, ktorí objednali cez váš odkaz, sa to nedotkne.')

    await d.getByRole('button', { name: 'Áno, zrušiť' }).click()
    await expect(page, 'straight to the portal').toHaveURL(/\/$/)
    // The guard must NOT fire — `confirmCancelOrder` resets the snapshot and sets
    // `leaveConfirmed` before pushing.
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)

    // The host's own order is gone…
    expect(await serverOrder(cycle.id), 'the friend is now "Neobjednané"').toBeNull()

    // …and the promise the banner made is still true.
    const after = (await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth, timeout: TIMEOUT })).json())
    expect(after.guest_orders, 'the colleague is still there').toHaveLength(1)
    expect(after.guest_orders[0].id).toBe(subId)
    expect(after.guest_orders[0].status || 'submitted').not.toBe('cancelled')
    expect(after.guest_orders[0].total).toBeGreaterThan(0)
    expect(after.guest_orders[0].paid, 'unpaid, exactly as before').toBeFalsy()
    expect(after.guest_orders[0].delivered, 'undelivered, exactly as before').toBeFalsy()
    expect(after.totals.count).toBe(1)
  })

  test('"Nie" (and ×) leave the order exactly as it was', async ({ page }) => {
    const cycle = await makeCycle('C2')
    const p = await addProduct(cycle.id, { name: `C2 Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 2 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    await bar(page).getByRole('button', { name: 'Zrušiť' }).click()
    await dialog(page).getByRole('button', { name: 'Nie' }).click()
    await expect(page.getByText('Zrušiť objednávku?')).toHaveCount(0)
    await expect(bar(page).getByText('Položiek: 1')).toBeVisible()

    // The × is the same non-destructive branch.
    await bar(page).getByRole('button', { name: 'Zrušiť' }).click()
    await dialog(page).getByRole('button', { name: 'Zatvoriť dialóg' }).click()
    await expect(page.getByText('Zrušiť objednávku?')).toHaveCount(0)
    expect((await serverOrder(cycle.id)).status).toBe('submitted')
  })

  test('unreachable on an empty cart, and absent entirely when locked', async ({ page }) => {
    const cycle = await makeCycle('C3')
    await addProduct(cycle.id, { name: `C3 Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await expect(bar(page).getByRole('button', { name: 'Zrušiť' })).toBeDisabled()

    await setStatus(cycle.id, 'locked')
    await page.goto('/')
    await page.getByRole('heading', { name: cycle.name, exact: true }).click()
    await expect(page.locator('.app .cartbar')).toBeVisible()
    await expect(bar(page).locator('.actions'), 'no actions row at all when locked').toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (F) the leave guard

test.describe('UC-FO-013 — the leave guard, all three outcomes', () => {
  async function dirtyPage(page, label) {
    const cycle = await makeCycle(label)
    const p = await addProduct(cycle.id, { name: `${label} Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)
    await plusIn(page, `${label} Kava ${uniq}`).click()
    await expect(bar(page).getByTestId('cart-warn-dirty')).toBeVisible()
    return cycle
  }

  test('Zostať keeps the friend on the page with the cart intact', async ({ page }) => {
    const cycle = await dirtyPage(page, 'L1')

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    const d = dialog(page)
    await expect(d).toContainText('Neuložené zmeny')
    await expect(d).toContainText('Máte neuložené zmeny v objednávke. Naozaj chcete opustiť stránku? Zmeny nebudú uložené.')

    await d.getByRole('button', { name: 'Zostať' }).click()
    await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
    await expect(bar(page).getByText('Položiek: 1')).toBeVisible()
    await expect(bar(page).getByTestId('cart-warn-dirty'), 'still dirty, nothing thrown away').toBeVisible()
  })

  test('Opustiť navigates, and the unsaved edit is genuinely dropped', async ({ page }) => {
    const cycle = await dirtyPage(page, 'L2')

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await dialog(page).getByRole('button', { name: 'Opustiť' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
    // The whole point of the warning: the server still holds the pre-edit cart.
    const items = (await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, timeout: TIMEOUT,
    })).json()).items
    expect(items.reduce((s, i) => s + i.quantity, 0)).toBe(1)
  })

  test('⚠ dismissing (Esc) stays put AND clears the pending target', async ({ page }) => {
    const cycle = await dirtyPage(page, 'L3')

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(dialog(page)).toContainText('Neuložené zmeny')
    await page.keyboard.press('Escape')
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))

    // A stale `pendingNavigation` would make the NEXT confirm fire twice or send
    // the friend to a route they never asked for. Re-opening and confirming must
    // behave exactly as the first time.
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await dialog(page).getByRole('button', { name: 'Opustiť' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('the ROUTER-guard arm fires too, not just the back chevron', async ({ page }) => {
    const cycle = await dirtyPage(page, 'L4')

    // Browser Back goes through `onBeforeRouteLeave`, which is the arm that catches
    // every navigation the chevron does not own.
    await page.goBack()
    await expect(dialog(page)).toContainText('Neuložené zmeny')
    await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
    await dialog(page).getByRole('button', { name: 'Opustiť' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('a CLEAN submitted order navigates silently', async ({ page }) => {
    const cycle = await makeCycle('L5')
    const p = await addProduct(cycle.id, { name: `L5 Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await stubLocations(page, [])
    await gotoCycle(page, cycle)

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (G) 320px — every footer this row owns

test.describe('UC-FO-010..013 — the footers fit at 320px', () => {
  test('⚠ no `.m-foot` overflows, and neither does its modal', async ({ page }) => {
    const cycle = await makeCycle('W1')
    await enableParcel(cycle.id, 3.5)
    const p = await addProduct(cycle.id, { name: `W1 Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 320, height: 720 })
    await signIn(page)
    await stubLocations(page, [locA, locB])
    await gotoCycle(page, cycle)

    // Every `.btn` is `white-space:nowrap`, so a footer that does not fit does not
    // wrap — it overflows. Measured, per modal, on the real face.
    const measure = async (label) => page.evaluate((lbl) => {
      const foot = document.querySelector('.modal .m-foot')
      const modal = document.querySelector('.modal')
      const btns = Array.from(foot.querySelectorAll('.btn'))
      const cs = getComputedStyle(foot)
      const content = foot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const gap = parseFloat(cs.columnGap || cs.gap) || 0
      const used = btns.reduce((s, b) => s + b.getBoundingClientRect().width, 0) + gap * (btns.length - 1)
      return {
        label: lbl,
        widths: btns.map((b) => +b.getBoundingClientRect().width.toFixed(2)),
        content: +content.toFixed(2),
        used: +used.toFixed(2),
        headroom: +(content - used).toFixed(2),
        footScroll: foot.scrollWidth - foot.clientWidth,
        modalScroll: modal.scrollWidth - modal.clientWidth,
        docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    }, label)

    const rows = []

    // 1. Spôsob prevzatia — Zrušiť + the longest label on the screen.
    await bar(page).getByRole('button', { name: 'Aktualizovať' }).click()
    await expect(dialog(page)).toContainText('Spôsob prevzatia')
    rows.push(await measure('Spôsob prevzatia'))

    // 2. Hotovo! — a single OK.
    await dialog(page).getByRole('button', { name: 'Potvrdiť a odoslať' }).click()
    await expect(dialog(page)).toContainText('Hotovo!')
    rows.push(await measure('Hotovo!'))
    await dialog(page).getByRole('button', { name: 'OK' }).click()
    await expect(page).toHaveURL(/\/$/)

    // 3. Zrušiť objednávku? — Nie + Áno, zrušiť.
    await page.getByRole('heading', { name: cycle.name, exact: true }).click()
    await expect(page.locator('.app .cartbar')).toBeVisible()
    await bar(page).getByRole('button', { name: 'Zrušiť' }).click()
    await expect(dialog(page)).toContainText('Zrušiť objednávku?')
    rows.push(await measure('Zrušiť objednávku?'))
    await dialog(page).getByRole('button', { name: 'Nie' }).click()

    // 4. Neuložené zmeny — Zostať + Opustiť.
    await plusIn(page, `W1 Kava ${uniq}`).click()
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(dialog(page)).toContainText('Neuložené zmeny')
    rows.push(await measure('Neuložené zmeny'))

    console.log('320px footers:\n' + rows.map((r) =>
      `  ${r.label.padEnd(20)} btns=[${r.widths.join(', ')}] content=${r.content} used=${r.used} headroom=${r.headroom}`
    ).join('\n'))

    for (const r of rows) {
      expect(r.headroom, `${r.label}: the footer buttons fit the row`).toBeGreaterThanOrEqual(0)
      expect(r.footScroll, `${r.label}: .m-foot does not scroll`).toBeLessThanOrEqual(0)
      expect(r.modalScroll, `${r.label}: .modal does not scroll sideways`).toBeLessThanOrEqual(0)
      expect(r.docScroll, `${r.label}: the document does not scroll sideways`).toBeLessThanOrEqual(0)
    }
  })
})
