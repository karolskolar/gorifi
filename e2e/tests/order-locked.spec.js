import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FO-5 — the LOCKED order screen (04 §UC-FO-014) and module 04's closeout net
// (§UC-FO-015).
//
// Most of the locked composition fell out of RD-FO-1..4 and is already pinned
// elsewhere; this file deliberately does NOT restate those. Already covered, and
// left alone:
//
//   · the lock chip and the locked ticker ......... order-shell.spec.js:238
//   · `.banner.warn` present, `.banner.ok` absent .. order-shell.spec.js:388
//   · the amber pending badge + a working switch ... order-shell.spec.js:462
//   · `.cartbar` with no `.actions`, both inline
//     warnings gone, meta rows + lines intact ..... order-cartbar.spec.js:479
//     and order-modals.spec.js:1084
//   · ONE stepper disabled on ONE coffee card ..... order-product-card.spec.js:827
//   · a stepper tap moving the CARTBAR TOTAL ...... order-product-card.spec.js:756
//     ("v-model round-trips, and the value reaches the cart total")
//   · a cat-tab tap scrolling the STRIP and not
//     the page (the snapTab A/B) ................. order-shell.spec.js:644
//
// The last two are 02 §UC-DS-014 item 6's deferred obligation, restated by
// §UC-FO-015 item 4. They are discharged; nothing here duplicates them.
//
// What was NOT covered, and is what this file adds:
//
// (A) "EVERY `NeoStepper` GETS `disabled`" — the spec says every, the suite
//     proved one. A locked cycle whose second card, second variant or bakery
//     branch stayed live would pass every existing assertion. Both halves of the
//     state are measured on ALL of them: the `disabled` ATTRIBUTE (the half
//     assistive tech reads) and the theme's VISUAL half,
//     `.stepper.disabled button { opacity:.35; pointer-events:none }`.
//     ⚠ Those two declarations sit on the BUTTONS, not on the `.stepper`
//     container — in the port and in the canon alike (`friends-theme.css:96`,
//     prototype `theme.css:99`). §UC-FO-014's phrasing reads as if the container
//     carries them; it does not, and asserting the container would pass
//     vacuously.
//
// (B) THE WARN BANNER IS THE *ONLY* STATUS BANNER. The existing test asserts
//     `.banner.ok` is absent; it does not assert that nothing else appears. The
//     count is the property §UC-FO-002/014 actually state, and the fixture is
//     built so the open cycle would legitimately show a second banner.
//
// (C) NAVIGATING AWAY NEVER OPENS THE LEAVE MODAL. §UC-FO-013's guard is not
//     gated on `isLocked` at all — it is unreachable only because a locked cart
//     cannot be mutated. That is a structural argument, and structural arguments
//     rot: any future edit that lets the cart change under a lock (a
//     pre-seeded draft, a stock refresh, a stray watcher) re-arms the modal on a
//     screen where the friend can do nothing about it. Both arms are exercised
//     (the chevron and the router guard), and the same page is A/B'd against an
//     OPEN cycle where the modal DOES fire, so a broken locator cannot make this
//     pass by accident.
//
// (D) THE ZAPLATIŤ RESIDUAL (§UC-FO-014's OPEN, decided). A friend who submitted
//     but did not pay before the lock loses the payment shortcut. That is
//     shipped behaviour and prototype behaviour, and it is now a recorded
//     product residual rather than an accident — so it is pinned from BOTH
//     sides on one cycle: with payment settings configured and the order
//     submitted, "Zaplatiť" is offered while open and gone once locked. If it is
//     ever re-introduced, this is the test that must be re-pointed, and the
//     asymmetry with the guest surface (which keeps a Zaplatiť when locked)
//     re-read first.
//
// Hermetic: its own friend, its own cycles, its own products.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

async function makeCycle(label, over = {}) {
  const name = `E2E RDFO5 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open', ...over } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function setStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

async function seedSubmitted(cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, {
    headers: host.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'seed cart').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, {
    headers: host.auth, data: {}, timeout: TIMEOUT,
  })
  expect(res.status(), 'seed submit').toBe(200)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfo5_${uniq}`.slice(0, 30)
  const name = `RDFO5 Hostitel ${uniq}`
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
})

test.afterAll(async () => { await ctx?.dispose() })

async function signIn(page) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: host.id, friendName: host.name, token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
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
const cardFor = (page, name) =>
  page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

/**
 * Every stepper currently in the DOM, measured on BOTH halves of the state.
 * `.stepper.disabled` puts `opacity`/`pointer-events` on the BUTTONS, so the
 * container's own computed values are the defaults and would pass vacuously.
 */
async function steppers(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.app .stepper')).map((s) => {
    const [dec, inc] = Array.from(s.querySelectorAll('button'))
    const cs = (el) => getComputedStyle(el)
    return {
      cls: s.className,
      decDisabled: dec.disabled,
      incDisabled: inc.disabled,
      decOpacity: cs(dec).opacity,
      incOpacity: cs(inc).opacity,
      decPointer: cs(dec).pointerEvents,
      incPointer: cs(inc).pointerEvents,
      value: s.querySelector('.val').textContent.trim(),
    }
  }))
}

// ---------------------------------------------------------------------------
// (A) every stepper, both halves of the state

test.describe('UC-FO-014 — EVERY stepper is inert, not just the first', () => {
  let cycle = null
  let bakery = null

  test.beforeAll(async () => {
    // Three coffee cards on one tab, deliberately of different arity: two
    // variants, two variants, one. Six steppers on the Espresso tab alone, so
    // "the first one is disabled" is no longer the same statement as "the page
    // is inert".
    cycle = await makeCycle('EveryStepper')
    await addProduct(cycle.id, { name: `Locked A ${uniq}`, purpose: 'Espresso', price_250g: 7.5, price_1kg: 30 })
    await addProduct(cycle.id, { name: `Locked B ${uniq}`, purpose: 'Espresso', price_250g: 6.4, price_1kg: 25.6 })
    await addProduct(cycle.id, { name: `Locked C ${uniq}`, purpose: 'Espresso', price_20pc5g: 10 })
    // A second purpose, so the strip renders and the OTHER tab can be checked too.
    await addProduct(cycle.id, { name: `Locked D ${uniq}`, purpose: 'Filter', price_250g: 8.9, price_1kg: 35.3 })
    await setStatus(cycle.id, 'locked')

    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: `RDFO5 Bageta ${uniq}`, category: 'slané',
        composition: 'psenicna muka, sunka, syr',
        variants: [
          { label: '1 ks', weight_grams: 190, price: 3.2 },
          { label: '3 ks', weight_grams: 570, price: 8.9 },
        ],
      },
    })
    expect(bp.status(), 'bakery product create').toBe(201)
    const bname = `E2E RDFO5 Pekaren ${uniq}`
    const bres = await admin('/api/cycles', {
      method: 'post',
      data: { name: bname, type: 'bakery', status: 'open', bakery_product_ids: [(await bp.json()).id] },
    })
    expect(bres.status(), 'bakery cycle create').toBe(201)
    bakery = { ...(await bres.json()), name: bname }
    await setStatus(bakery.id, 'locked')
  })

  test('coffee: all six steppers on the tab carry the attribute AND the theme dimming', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const all = await steppers(page)
    // 2 + 2 + 1 = five variant boxes on Espresso. If the count ever drops the
    // "every" claim silently weakens, so it is asserted rather than assumed.
    expect(all.length, 'five variant boxes on the Espresso tab').toBe(5)
    for (const [i, s] of all.entries()) {
      expect(s.cls.split(/\s+/), `stepper ${i}: .stepper.disabled`).toContain('disabled')
      expect(s.decDisabled, `stepper ${i}: "−" carries the disabled attribute`).toBe(true)
      expect(s.incDisabled, `stepper ${i}: "+" carries the disabled attribute`).toBe(true)
      expect(s.decOpacity, `stepper ${i}: "−" at 0.35`).toBe('0.35')
      expect(s.incOpacity, `stepper ${i}: "+" at 0.35`).toBe('0.35')
      expect(s.decPointer, `stepper ${i}: "−" pointer-events none`).toBe('none')
      expect(s.incPointer, `stepper ${i}: "+" pointer-events none`).toBe('none')
    }

    // The OTHER category tab renders fresh cards — `activeProducts` re-renders
    // them, so `:disabled="isLocked"` has to hold on the second render too.
    await page.getByTestId('purpose-tabs').getByRole('tab', { name: 'Filter' }).click()
    const filter = await steppers(page)
    expect(filter.length, 'two variant boxes on the Filter tab').toBe(2)
    for (const [i, s] of filter.entries()) {
      expect(s.cls.split(/\s+/), `filter stepper ${i}`).toContain('disabled')
      expect(s.incDisabled && s.decDisabled, `filter stepper ${i}: both buttons`).toBe(true)
    }
  })

  test('a forced click on any of them still cannot move the quantity or the total', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    await expect(bar(page).locator('.sum')).toHaveText('Celkom: 0.00 EUR')

    // `pointer-events:none` alone would let a programmatic click through, and the
    // `disabled` attribute alone is bypassable from JS in some paths — which is
    // exactly why `NeoStepper.inc()`/`dec()` re-check the prop and `setQuantity`
    // guards on `isLocked`. Dispatch straight at the DOM, past actionability.
    await page.evaluate(() => {
      document.querySelectorAll('.app .stepper button').forEach((b) => b.click())
    })
    await page.waitForTimeout(300)

    const all = await steppers(page)
    expect(all.map((s) => s.value), 'nothing moved').toEqual(all.map(() => '0'))
    await expect(bar(page).locator('.sum'), 'and the total is untouched').toHaveText('Celkom: 0.00 EUR')
    await expect(bar(page).getByText('Položiek: 0')).toBeVisible()
  })

  test('bakery: the `unit` steppers are disabled on the same terms', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, bakery)

    const all = await steppers(page)
    expect(all.length, 'two variant boxes on the one bakery card').toBe(2)
    for (const [i, s] of all.entries()) {
      expect(s.cls.split(/\s+/), `bakery stepper ${i}`).toContain('disabled')
      expect(s.decDisabled && s.incDisabled, `bakery stepper ${i}: both buttons`).toBe(true)
      expect(s.incOpacity, `bakery stepper ${i}: dimmed`).toBe('0.35')
      expect(s.incPointer, `bakery stepper ${i}: inert`).toBe('none')
    }
    // The bakery branch renders no `.actions` either — it is the same cartbar.
    await expect(bar(page).locator('.actions')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (B) exactly one status banner

test.describe('UC-FO-014 — the warn banner is the ONLY status banner', () => {
  test('a submitted order under a lock shows one banner, and it is the warn one', async ({ page }) => {
    const cycle = await makeCycle('OneBanner')
    const p = await addProduct(cycle.id, { name: `OneBanner Kava ${uniq}`, purpose: 'Espresso', price_250g: 7 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)

    // Control: OPEN, the same order ⇒ the green banner. Without this the locked
    // assertion below could be satisfied by a fixture that has no banner at all.
    await gotoCycle(page, cycle)
    await expect(page.locator('.app .banner'), 'open: exactly one banner').toHaveCount(1)
    await expect(page.locator('.app .banner.ok')).toBeVisible()

    await setStatus(cycle.id, 'locked')
    await gotoCycle(page, cycle)
    // ⚠ COUNT, not just "the green one is gone". The cartbar's two inline
    // warnings are `.banner.warn.slim` and live inside `.cartbar`, so a
    // regression that re-armed one of them would show up right here.
    await expect(page.locator('.app .banner'), 'locked: exactly one banner in the whole scope').toHaveCount(1)
    const only = page.locator('.app .banner')
    await expect(only).toHaveClass(/\bwarn\b/)
    await expect(only).toContainText('Objednávky sú uzamknuté.')
  })
})

// ---------------------------------------------------------------------------
// (C) the leave guard can never fire

test.describe('UC-FO-014 — navigating away never opens the leave modal', () => {
  let cycle = null
  let product = null

  test.beforeAll(async () => {
    cycle = await makeCycle('NoLeave')
    product = await addProduct(cycle.id, { name: `NoLeave Kava ${uniq}`, purpose: 'Espresso', price_250g: 8 })
    await seedSubmitted(cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
  })

  test('⚠ CONTROL — the same page, OPEN, DOES arm the guard after one tap', async ({ page }) => {
    await setStatus(cycle.id, 'open')
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    await cardFor(page, product.name).locator('.vbox').first().getByRole('button', { name: 'viac' }).click()
    await expect(bar(page).getByTestId('cart-warn-dirty')).toBeVisible()
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    // `exact` here only: the modal's title AND its subtitle both contain the
    // phrase, so the loose matcher trips strict mode on the POSITIVE assertion.
    // The negative ones below keep the loose matcher on purpose — `toHaveCount(0)`
    // is not strict-mode bound, and the wider net also covers the subtitle.
    await expect(page.getByText('Neuložené zmeny', { exact: true }), 'the locator and the flow are sound').toBeVisible()
    await page.getByRole('button', { name: 'Zostať' }).click()
  })

  test('locked: the back chevron leaves immediately, no modal', async ({ page }) => {
    await setStatus(cycle.id, 'locked')
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // Tapping every stepper first: the guard is only unreachable because the cart
    // cannot be mutated, so the interesting case is "after the friend has tried".
    await page.evaluate(() => {
      document.querySelectorAll('.app .stepper button').forEach((b) => b.click())
    })
    await page.waitForTimeout(200)

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
  })

  test('locked: the router-guard arm (browser Back) is silent too', async ({ page }) => {
    await setStatus(cycle.id, 'locked')
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  })

  test('locked: switching to Kolegovia and back changes nothing about that', async ({ page }) => {
    await setStatus(cycle.id, 'locked')
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // The main switch stays fully functional when locked (§UC-FO-014). The panels
    // are `v-show`, so both stay mounted — this is the cheapest place to notice a
    // regression to `v-if`, which would unmount `GuestSubOrders` and kill the
    // badge the tab advertises.
    await page.getByTestId('main-tab-guests').click()
    await expect(page.getByTestId('main-tab-guests')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#panel-own')).toBeHidden()
    await page.getByTestId('main-tab-own').click()
    await expect(page.locator('#panel-own')).toBeVisible()

    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('Neuložené zmeny')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (D) the decided OPEN — no Zaplatiť when locked

test.describe('UC-FO-014 — the Zaplatiť residual, pinned from both sides', () => {
  test('offered on the open cycle, gone the moment it locks — with payment settings live', async ({ page }) => {
    const cycle = await makeCycle('Pay')
    const p = await addProduct(cycle.id, { name: `Pay Kava ${uniq}`, purpose: 'Espresso', price_250g: 9 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    // `hasPaymentSettings` is the other half of the `v-if`; the shared seed fills
    // IBAN + Revolut, and this asserts they really are live rather than assuming.
    const settings = await (await ctx.get('/api/admin/payment-settings', { timeout: TIMEOUT })).json()
    expect(Boolean(settings.paymentIban || settings.paymentRevolutUsername), 'payment settings configured').toBe(true)

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await expect(bar(page).getByRole('button', { name: 'Zaplatiť' }), 'open + submitted ⇒ the shortcut is there').toBeVisible()

    await setStatus(cycle.id, 'locked')
    await gotoCycle(page, cycle)
    // ⚠ RECORDED PRODUCT RESIDUAL (04 §UC-FO-014's OPEN, decided by the
    // orchestrator 2026-08-08): a friend who submitted but did not pay before
    // the lock loses this shortcut, while a GUEST keeps a Zaplatiť in their
    // locked state (README item 9). Shipped + prototype behaviour; re-introducing
    // the button means re-pointing THIS test and order-cartbar.spec.js:489.
    await expect(page.getByRole('button', { name: 'Zaplatiť' }), 'locked ⇒ nowhere on the screen').toHaveCount(0)
    await expect(bar(page).locator('.actions')).toHaveCount(0)
  })
})
