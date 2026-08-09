import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FO-3 — the sticky cart footer `.cartbar` (04 §UC-FO-009) and the behaviour
// contract it must not regress (§UC-FO-008).
//
// What this file pins, and why each one is a silent regression without it:
//
// (A) THE POSITIONING HAZARD, WHICH IS THE WHOLE REASON THIS BAR MOVED.
//     `.app > * { position:relative; z-index:1 }` neutralises Tailwind positioning
//     utilities on a DIRECT child, which is why RD-FO-1 had to leave the old
//     `fixed bottom-0 z-50` footer NESTED and warned against hoisting it. 04
//     §UC-FO-009 makes the bar a direct child of `.app` — legal only because it is
//     now on the THEME class `.cartbar`, whose rule is declared LATER than `.app>*`
//     at equal (0,1,0) specificity and therefore wins. That is a CASCADE ORDER
//     fact, not a structural one: reordering `friends-theme.css` would silently
//     compute `relative`, the bar would scroll away with the page, and nothing
//     would fail to build. So sticky / bottom 0 / z 50 are read back off the
//     SHIPPED element, together with the removal of the `h-48` spacer the `fixed`
//     bar needed (with `sticky` it would be 192px of dead space instead).
//
// (B) THE TOTAL IS `paymentTotal`, NOT `cartTotal` (resolved conflict #9).
//     `orders.delivery_fee` is a field ON the order and never an `order_items`
//     line (CLAUDE.md 2026-05-01), so a footer that sums the cart lines alone
//     under-states what the friend owes by exactly the Packeta fee — while the
//     success modal, the Pay-by-Square QR and `PaymentModal` all bill
//     `paymentTotal`. The fixture therefore carries a real 3.50 fee and the
//     assertion is the exact 12.54, not "greater than".
//
// (C) THE AUTO-SAVE MATRIX, OBSERVED AT THE NETWORK LEVEL (§UC-FO-008).
//     Three rows, and every one of them is a data-loss or a data-surprise bug in
//     the wrong direction: no order yet ⇒ NOTHING is written (an auto-created
//     order would show up in the admin's cycle as an order the friend never
//     placed); a draft ⇒ ONE debounced PUT ~500ms after the last edit (a lost
//     debounce means a PUT per tap); a SUBMITTED order ⇒ no PUT at all until the
//     friend presses Aktualizovať. Asserted by counting real requests and timing
//     them, never by inspecting a timer.
//
// (D) THE DIRTY WARNING'S DISMISS **AND ITS RETURN**.
//     Resolved conflict #5 keeps the shipped ✕ on a prototype banner that has
//     none. The half that actually matters is the RESET: `changesNotificationDismissed`
//     is cleared by the `cart` watcher, so a dismissed warning must come back on
//     the next edit — otherwise a friend who dismissed it once never sees an
//     unsent-changes warning again for the rest of the session.
//
// (E) `successMessage` IS RETIRED, AND A FAILED SUBMIT PROVES IT.
//     "Košík bol uložený" used to be set by `saveCart(false)` and then contradicted
//     by the error banner `doSubmitOrder()`'s catch sets — both visible for 3s.
//     RD-FO-3 removed the ref, the writes and the banner; the pin is a stubbed 500
//     on the submit endpoint.
//
// NOTE ON THE `incDisabled` OBLIGATION RD-FO-2 HANDED THIS ROW: the cartbar renders
// NO stepper at all (04 §UC-FO-009's markup has none — quantities are edited on the
// product cards), so there is no new increment path here and no new place for the
// stock ceiling to leak. `order-product-card.spec.js` remains its only guard.
//
// Hermetic: its own friend, its own cycles, its own products. Nothing stubbed
// except where a failure is being provoked on purpose.

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
  const name = `E2E RDFO3 ${label} ${uniq}`
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

/** Draft = a saved cart that was never submitted (the PUT creates it on demand). */
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

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfo3_${uniq}`.slice(0, 30)
  const name = `RDFO3 Hostitel ${uniq}`
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

async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
}

const bar = (page) => page.locator('.app .cartbar')
const plusIn = (page, name) =>
  page.getByTestId('product-card')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .locator('.vbox').first().getByRole('button', { name: 'viac' })

/**
 * Records every cart-write PUT with the ms offset from `t0`. This is the ONLY
 * honest way to assert a debounce: a timer's existence proves nothing about how
 * many requests actually leave the page.
 */
function watchCartPuts(page) {
  const seen = []
  const t0 = Date.now()
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/orders\/cycle\/\d+\/friend\/\d+$/.test(req.url())) {
      seen.push(Date.now() - t0)
    }
  })
  return seen
}

/** Aktualizovať/Odoslať → the Spôsob prevzatia modal only exists on some cycles. */
async function pressSubmit(page, label) {
  await bar(page).getByRole('button', { name: label }).click()
  const confirm = page.getByRole('button', { name: 'Potvrdiť a odoslať' })
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click()
}

// ---------------------------------------------------------------------------
// (A) the positioning hazard

test.describe('UC-FO-009 — `.cartbar` is a direct child of `.app`', () => {
  let cycle = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Pos', { expected_date: '29. august 2026' })
    await addProduct(cycle.id, { name: `Pos Kava ${uniq}`, purpose: 'Espresso', price_250g: 9.04 })
  })

  test('⚠ it computes sticky / bottom 0 / z 50, and the `h-48` spacer is gone', async ({ page }) => {
    // A SHORT viewport, so the page genuinely scrolls: "sticks to the bottom" would
    // pass vacuously on a page that fits.
    await page.setViewportSize({ width: 378, height: 420 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const geom = await page.evaluate(() => {
      const el = document.querySelector('.cartbar')
      const app = document.querySelector('.app')
      const cs = getComputedStyle(el)
      return {
        parentIsApp: el.parentElement === app,
        position: cs.position,
        bottom: cs.bottom,
        zIndex: cs.zIndex,
        borderTop: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        boxShadow: cs.boxShadow,
        // `div.h-48`, not `.h-48`: the success modal's QR image legitimately keeps
        // `w-48 h-48`, and only the spacer was ever a bare div.
        spacers: document.querySelectorAll('div.h-48').length,
        fixedBars: [...document.querySelectorAll('.app div')]
          .filter((d) => getComputedStyle(d).position === 'fixed').length,
        rectBottom: Math.round(el.getBoundingClientRect().bottom),
        vh: window.innerHeight,
        scrollable: document.documentElement.scrollHeight - window.innerHeight,
      }
    })

    expect(geom.parentIsApp, 'a DIRECT child of `.app`, per 04 §UC-FO-009').toBe(true)
    // ⚠ If this reads `relative`, `.app > *` has won — the theme rule moved above
    // it in the cascade. Do not "fix" that by adding a utility; fix the order.
    expect(geom.position, '`.app>*` did NOT eat it — the theme rule is declared later').toBe('sticky')
    expect(geom.bottom).toBe('0px')
    expect(geom.zIndex).toBe('50')
    // The 03-shot chrome: 4px ink top border and the magenta `0 -6px 0` shadow.
    expect(geom.borderTop).toBe('4px solid rgb(10, 10, 10)')
    expect(geom.boxShadow).toBe('rgb(255, 45, 135) 0px -6px 0px 0px')

    // The spacer was load-bearing only for `fixed`; with `sticky` it is dead space.
    expect(geom.spacers, 'the `h-48` spacer hack is gone').toBe(0)
    expect(geom.fixedBars, 'and no `fixed` bar survives anywhere under `.app`').toBe(0)

    expect(geom.scrollable, 'the fixture must actually scroll').toBeGreaterThan(0)
    expect(geom.rectBottom, 'pinned to the viewport bottom at rest').toBe(geom.vh)

    // …and still pinned at the very end of the document, with nothing under it.
    const atEnd = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight)
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector('.cartbar')
        r({
          bottom: Math.round(el.getBoundingClientRect().bottom),
          vh: window.innerHeight,
          below: Math.round(document.documentElement.scrollHeight - (window.scrollY + window.innerHeight)),
        })
      })))
    })
    expect(atEnd.bottom, 'still on the viewport bottom when scrolled to the end').toBe(atEnd.vh)
    expect(atEnd.below, 'no layout gap left behind by the removed spacer').toBe(0)
  })

  test('the bar is the SAME element on both tabs — it belongs to neither panel', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    await expect(bar(page)).toHaveCount(1)
    const own = await bar(page).evaluate((el) => el.getBoundingClientRect().height)
    await page.getByTestId('main-tab-guests').click()
    await expect(page.getByTestId('main-tab-guests')).toHaveAttribute('aria-selected', 'true')
    await expect(bar(page), 'the host must be able to submit from the colleagues tab').toHaveCount(1)
    await expect(bar(page).getByText('Celkom:')).toBeVisible()
    expect(await bar(page).evaluate((el) => el.getBoundingClientRect().height)).toBe(own)
  })
})

// ---------------------------------------------------------------------------
// the bar's composition, against 03-shot.png

test.describe('UC-FO-009 — composition at 378px', () => {
  let cycle = null
  let coffee = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Comp', { expected_date: '29. august 2026' })
    expect((await admin(`/api/cycles/${cycle.id}`, {
      method: 'patch', data: { parcel_enabled: 1, parcel_fee: 3.5 },
    })).status()).toBe(200)
    coffee = await addProduct(cycle.id, {
      name: `Brazil Morada da Prata ${uniq}`, purpose: 'Espresso', price_250g: 9.04, price_1kg: 35.7,
    })
  })

  test('deadline + count, the `.sum` total, three actions, the `<details>` lines', async ({ page }) => {
    // A SUBMITTED order with a real Packeta fee: the only state in which all three
    // action buttons and the fee line exist at once.
    await seedSubmitted(cycle.id, [{ product_id: coffee.id, variant: '250g', quantity: 1 }], {
      use_parcel_delivery: true, packeta_address: 'Z-BOX Hlavna 15, Bratislava',
    })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    // 1. Deadline — VERBATIM from the API, mono, uppercase, no emoji.
    const deadline = bar(page).locator('.deadline')
    await expect(deadline).toHaveText('Objednávka do: 29. august 2026')
    expect(await deadline.textContent(), 'the design language has no emoji').not.toMatch(/\p{Extended_Pictographic}/u)
    const dl = await deadline.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { ff: cs.fontFamily, tt: cs.textTransform, fs: cs.fontSize, lh: cs.lineHeight }
    })
    expect(dl.ff).toContain('Courier Prime')
    expect(dl.tt).toBe('uppercase')
    expect(dl.fs).toBe('11px')
    // A10 covers `.cartbar .deadline`; at the inherited 1.5 it would be 16.5px.
    expect(dl.lh).toBe('normal')

    // 2. Count.
    await expect(bar(page).getByText('Položiek: 1')).toBeVisible()

    // 3. Total — `.sum` display style (22px Darker Grotesque), NOT mono, and it is
    //    `paymentTotal`: 9.04 product + 3.50 delivery.
    const sum = bar(page).locator('.sum')
    await expect(sum).toHaveText('Celkom: 12.54 EUR')
    const sumCs = await sum.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { ff: cs.fontFamily, fs: cs.fontSize, lh: cs.lineHeight }
    })
    expect(sumCs.ff, 'display face, not mono').toContain('Darker Grotesque')
    expect(sumCs.ff).not.toContain('Courier Prime')
    expect(sumCs.fs).toBe('22px')
    expect(sumCs.lh).toBe('22px')

    // 4. The three actions, sharing the row from the theme (flex:1, 46px min).
    const actions = bar(page).locator('.actions .btn')
    await expect(actions).toHaveText(['Zrušiť', 'Zaplatiť', 'Aktualizovať'])
    const metrics = await actions.evaluateAll((els) => els.map((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return { flex: cs.flexGrow + '/' + cs.flexShrink + '/' + cs.flexBasis, h: Math.round(r.height) }
    }))
    for (const m of metrics) {
      expect(m.flex, '`.cartbar .actions .btn{flex:1}` — widths are NOT overridden here').toBe('1/1/0%')
      expect(m.h).toBe(46)
    }

    // 5. `<details>` — collapsed by default, ▸ before / ▾ after, flat lines.
    const details = bar(page).locator('details')
    await expect(details).toHaveCount(1)
    const lines = bar(page).locator('.lines .ln')
    await expect(lines.first()).toBeHidden()
    const marker = () => details.evaluate((el) => getComputedStyle(el.querySelector('summary'), '::before').content)
    expect(await marker()).toContain('▸')
    await bar(page).getByText('Zobraziť položky v košíku').click()
    await expect(lines.first()).toBeVisible()
    expect(await marker()).toContain('▾')

    // Flat: product line then the fee line, no purpose headers, `×` not `x`, and the
    // per-line totals ARE mono (only the `.sum` is display).
    await expect(lines).toHaveCount(2)
    await expect(lines.nth(0)).toContainText(`Brazil Morada da Prata ${uniq} (250g) ×1`)
    await expect(lines.nth(0).locator('.mono')).toHaveText('9.04 EUR')
    await expect(lines.nth(1)).toContainText('Doručenie Packetou')
    await expect(lines.nth(1).locator('.mono')).toHaveText('3.50 EUR')
    expect(await bar(page).innerText(), 'no 📦, and no purpose header (conflict #10)')
      .not.toMatch(/📦|Espresso/)
    for (const m of await lines.locator('.mono').evaluateAll((els) => els.map((e) => getComputedStyle(e).fontFamily))) {
      expect(m).toContain('Courier Prime')
    }
  })

  test('an empty cart: "Košík je prázdny", 0.00 total, both actions disabled', async ({ page }) => {
    const empty = await makeCycle('Empty')
    await addProduct(empty.id, { name: `Empty Kava ${uniq}`, purpose: 'Espresso', price_250g: 5 })

    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, empty)

    await expect(bar(page).getByText('Položiek: 0')).toBeVisible()
    // ⚠ `paymentTotal.toFixed(2)`, not the old `formatPrice`, which rendered a bare
    // "-" for a zero total.
    await expect(bar(page).locator('.sum')).toHaveText('Celkom: 0.00 EUR')
    await bar(page).getByText('Zobraziť položky v košíku').click()
    await expect(bar(page).getByText('Košík je prázdny')).toBeVisible()
    await expect(bar(page).getByRole('button', { name: 'Zrušiť' })).toBeDisabled()
    await expect(bar(page).getByRole('button', { name: 'Odoslať' })).toBeDisabled()
    await expect(bar(page).getByRole('button', { name: 'Zaplatiť' }), 'not submitted ⇒ no Zaplatiť').toHaveCount(0)
  })

  test('`lineSize`: `variant_label`, `unit` → "ks", and the weight fallback', async ({ page }) => {
    // Bakery gives the two cases coffee cannot: a labelled variant, and a legacy
    // single-variant row whose `variant_label` is NULL (⇒ the `'unit'` branch).
    const labelled = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: `Makovnik ${uniq}`, category: 'sladké',
        variants: [{ label: '1/2', weight_grams: 300, price: 4.4 }],
      },
    })
    expect(labelled.status()).toBe(201)
    const legacy = await admin('/api/bakery-products', {
      method: 'post', data: { name: `Stara Buchta ${uniq}`, category: 'sladké', price: 2.5 },
    })
    expect(legacy.status()).toBe(201)

    const name = `E2E RDFO3 Pekaren ${uniq}`
    const res = await admin('/api/cycles', {
      method: 'post',
      data: {
        name, type: 'bakery', status: 'open',
        bakery_product_ids: [(await labelled.json()).id, (await legacy.json()).id],
      },
    })
    expect(res.status()).toBe(201)
    const bakery = { ...(await res.json()), name }

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, bakery)

    await plusIn(page, `Makovnik ${uniq}`).click()
    await plusIn(page, `Stara Buchta ${uniq}`).click()
    await bar(page).getByText('Zobraziť položky v košíku').click()

    const text = await bar(page).locator('.lines').innerText()
    expect(text, '`variant_label` wins when the snapshot carries one').toContain(`Makovnik ${uniq} (1/2) ×1`)
    expect(text, "a NULL label on the zero-gram `'unit'` variant reads 'ks'").toContain(`Stara Buchta ${uniq} (ks) ×1`)

    // …and the coffee fallback: the raw variant key.
    await gotoCycle(page, cycle)
    await bar(page).getByText('Zobraziť položky v košíku').click()
    expect(await bar(page).locator('.lines').innerText()).toContain('(250g) ×1')
  })

  test('320px: no document overflow, and three real hit targets', async ({ page }) => {
    // ⚠ `.actions` is a flex row, not `grid-cols-2` — but the lesson from the
    // variant grid holds: a squeezed row loses hit targets without overflowing, so
    // the buttons are MEASURED rather than inferred from "the document fits".
    await page.setViewportSize({ width: 320, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    await expect(bar(page).locator('.actions .btn')).toHaveCount(3)
    const m = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      barOverflow: (() => { const c = document.querySelector('.cartbar'); return c.scrollWidth - c.clientWidth })(),
      buttons: [...document.querySelectorAll('.cartbar .actions .btn')].map((b) => ({
        t: b.textContent.trim(),
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
        clipped: b.scrollWidth - b.clientWidth,
      })),
    }))
    expect(m.doc, '02 §UC-DS-005: zero horizontal document overflow').toBe(0)
    expect(m.body).toBe(0)
    expect(m.barOverflow).toBe(0)
    for (const b of m.buttons) {
      expect(b.w, `"${b.t}" keeps a real hit target at 320px`).toBeGreaterThanOrEqual(60)
      expect(Math.round(b.h)).toBe(46)
      expect(b.clipped, `"${b.t}" is not clipping its own label`).toBe(0)
    }
  })

  test('locked: the actions row is absent entirely, the meta rows and lines remain', async ({ page }) => {
    const locked = await makeCycle('Locked', { expected_date: '29. august 2026' })
    const p = await addProduct(locked.id, { name: `Locked Kava ${uniq}`, purpose: 'Espresso', price_250g: 7.5 })
    await seedSubmitted(locked.id, [{ product_id: p.id, variant: '250g', quantity: 2 }])
    await setStatus(locked.id, 'locked')

    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, locked)

    await expect(bar(page).locator('.actions')).toHaveCount(0)
    await expect(bar(page).locator('.deadline')).toHaveText('Objednávka do: 29. august 2026')
    await expect(bar(page).getByText('Položiek: 1')).toBeVisible()
    await expect(bar(page).locator('.sum')).toHaveText('Celkom: 15.00 EUR')
    await bar(page).getByText('Zobraziť položky v košíku').click()
    await expect(bar(page).locator('.lines .ln')).toHaveCount(1)
    // Neither warning may show when locked.
    await expect(bar(page).getByTestId('cart-warn-unsent')).toHaveCount(0)
    await expect(bar(page).getByTestId('cart-warn-dirty')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (D) the two inline warnings

test.describe('UC-FO-009 — the inline dirty warnings', () => {
  let cycle = null
  let product = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Warn')
    product = await addProduct(cycle.id, { name: `Warn Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })
  })

  test('unsent notice while a cart has never been submitted', async ({ page }) => {
    const fresh = await makeCycle('Unsent')
    const p = await addProduct(fresh.id, { name: `Unsent Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, fresh)

    await expect(bar(page).getByTestId('cart-warn-unsent')).toHaveCount(0)
    await plusIn(page, `Unsent Kava ${uniq}`).click()
    const warn = bar(page).getByTestId('cart-warn-unsent')
    await expect(warn).toBeVisible()
    await expect(warn).toHaveText('Objednávka ešte nebola odoslaná.')
    await expect(warn).toHaveClass(/\bbanner\b.*\bwarn\b.*\bslim\b/)
    // ⚠ It carries NO dismiss: only the dirty warning does (conflict #5).
    await expect(warn.getByTestId('cart-warn-dismiss')).toHaveCount(0)
    // …and never both warnings at once.
    await expect(bar(page).getByTestId('cart-warn-dirty')).toHaveCount(0)
    expect(p.id).toBeTruthy()
  })

  test('⚠ the dirty warning is dismissable — AND it returns on the next cart change', async ({ page }) => {
    await seedSubmitted(cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // Submitted and clean ⇒ neither warning.
    await expect(bar(page).getByTestId('cart-warn-dirty')).toHaveCount(0)
    await expect(bar(page).getByTestId('cart-warn-unsent')).toHaveCount(0)

    await plusIn(page, `Warn Kava ${uniq}`).click()
    const dirty = bar(page).getByTestId('cart-warn-dirty')
    await expect(dirty).toBeVisible()
    await expect(dirty).toHaveText('Zmeny neboli odoslané. Stlačte „Aktualizovať“.')

    // The ✕: a `<span>` in the prototype, so it carries the house ARIA layer rather
    // than losing the keyboard reach the old `<button>` had.
    const x = dirty.getByTestId('cart-warn-dismiss')
    await expect(x).toHaveAttribute('role', 'button')
    await expect(x).toHaveAttribute('aria-label', 'Zavrieť')
    await expect(x.locator('svg')).toHaveAttribute('width', '14')

    await x.click()
    await expect(dirty, 'dismissed').toHaveCount(0)

    // ⚠ THE HALF THAT MATTERS: `changesNotificationDismissed` is reset by the cart
    // watcher, so the NEXT edit brings it back. Without the reset a friend who
    // dismissed it once would never be warned again.
    await plusIn(page, `Warn Kava ${uniq}`).click()
    await expect(bar(page).getByTestId('cart-warn-dirty'), 'it returns on the next edit').toBeVisible()

    // The keyboard path dismisses too.
    await bar(page).getByTestId('cart-warn-dismiss').press('Enter')
    await expect(bar(page).getByTestId('cart-warn-dirty')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (C) the auto-save matrix — §UC-FO-008, observed at the network level

test.describe('UC-FO-008 — the auto-save matrix, observed as requests', () => {
  test('no order yet ⇒ NOTHING is written, and leaving warns', async ({ page }) => {
    const cycle = await makeCycle('AsNone')
    await addProduct(cycle.id, { name: `AsNone Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const puts = watchCartPuts(page)
    await plusIn(page, `AsNone Kava ${uniq}`).click()
    await plusIn(page, `AsNone Kava ${uniq}`).click()
    await page.waitForTimeout(1800) // 3.6× the debounce
    expect(puts, 'a cart with no order behind it lives in memory only').toEqual([])

    // Nothing on the server either — an auto-created order would appear in the
    // admin's cycle as an order the friend never placed.
    const server = await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, timeout: TIMEOUT,
    })
    expect(server.status()).toBe(200)
    expect((await server.json()).order, 'GET must not auto-create either').toBeNull()

    // …and the leave guard is what stops that being silent data loss.
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('Neuložené zmeny')
  })

  test('a DRAFT order ⇒ exactly ONE debounced PUT ~500ms after the last edit', async ({ page }) => {
    const cycle = await makeCycle('AsDraft')
    const p = await addProduct(cycle.id, { name: `AsDraft Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })
    await seedCart(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await expect(bar(page).getByText('Položiek: 1')).toBeVisible()

    const puts = watchCartPuts(page)
    const plus = plusIn(page, `AsDraft Kava ${uniq}`)
    const t0 = Date.now()
    await plus.click()
    await plus.click()
    await plus.click()
    const lastEdit = Date.now() - t0

    // Nothing yet at 250ms — the debounce is real, not an immediate write.
    await page.waitForTimeout(250)
    expect(puts, 'no write while the friend is still tapping').toEqual([])

    await expect.poll(() => puts.length, { timeout: 5000 }).toBe(1)
    await page.waitForTimeout(700)
    expect(puts.length, 'three taps coalesce into ONE request').toBe(1)
    expect(puts[0] - lastEdit, 'the 500ms debounce, measured from the last edit')
      .toBeGreaterThanOrEqual(400)

    // …and it really persisted, still as a DRAFT (auto-save never submits).
    const server = await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, timeout: TIMEOUT,
    })).json()
    expect(server.items.reduce((s, i) => s + i.quantity, 0)).toBe(4)
    expect(server.order.status, 'auto-save preserves the status').not.toBe('submitted')
  })

  test('a SUBMITTED order ⇒ no PUT at all until "Aktualizovať"', async ({ page }) => {
    const cycle = await makeCycle('AsSub')
    const p = await addProduct(cycle.id, { name: `AsSub Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const puts = watchCartPuts(page)
    await plusIn(page, `AsSub Kava ${uniq}`).click()
    await page.waitForTimeout(1800)
    expect(puts, 'a submitted order waits for the explicit update').toEqual([])
    expect((await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, timeout: TIMEOUT,
    })).json()).items.reduce((s, i) => s + i.quantity, 0), 'server still at 1').toBe(1)

    await pressSubmit(page, 'Aktualizovať')
    await expect(page.getByText('Hotovo!')).toBeVisible()
    expect(puts.length, 'now exactly one write, from the button').toBe(1)
    expect((await (await ctx.get(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, timeout: TIMEOUT,
    })).json()).items.reduce((s, i) => s + i.quantity, 0)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// (E) `successMessage` is retired

test.describe('UC-FO-009 — the retired "Košík bol uložený" banner', () => {
  test('⚠ a FAILED submit shows the error ALONE — no contradicting success banner', async ({ page }) => {
    const cycle = await makeCycle('Fail')
    const p = await addProduct(cycle.id, { name: `Fail Kava ${uniq}`, purpose: 'Espresso', price_250g: 6 })
    await seedSubmitted(cycle.id, [{ product_id: p.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // Only the SUBMIT fails; the cart PUT that precedes it succeeds — which is
    // exactly the state that used to render "Košík bol uložený" next to the error.
    await page.route('**/api/orders/cycle/*/friend/*/submit', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Zlyhalo odoslanie' }) }))

    await plusIn(page, `Fail Kava ${uniq}`).click()
    await pressSubmit(page, 'Aktualizovať')

    await expect(page.locator('.banner.danger')).toBeVisible()
    await expect(page.getByText('Hotovo!')).toHaveCount(0)
    // The 3s window in which the two used to sit side by side.
    await expect(page.getByText('Košík bol uložený')).toHaveCount(0)
    await page.waitForTimeout(1200)
    await expect(page.getByText('Košík bol uložený')).toHaveCount(0)
  })
})
