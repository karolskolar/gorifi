import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-GX-1 — the g-order SHELL, the shared neo grid and the checkout modal
// (06 §UC-GX-001..003).
//
// `guest-order.spec.js` and `guest-status.spec.js` are IMMUTABLE this row and
// already cover the behaviour end to end (cart maths, identity validation, the
// submit, bakery grouping, the dead link, the status edit flow). This file adds
// only what a re-skin can break SILENTLY — every item below fails with no build
// error and no failing behaviour spec:
//
// (A) `.app > * { position:relative; z-index:1 }` NEUTRALISES Tailwind positioning
//     on a direct child. The shipped cart footer was a nested `fixed bottom-0 z-50`
//     div plus an `<div class="h-32">` spacer, kept nested precisely so `.app>*`
//     could not reach it. §UC-GX-003 hoists it to a DIRECT `.app` child on the
//     THEME class `.cartbar`, which survives only because
//     `:where(.app,.modal-layer) .cartbar` is declared LATER than `.app>*` at equal
//     (0,1,0) specificity. Written as a utility instead it would compute
//     `relative`/`z-index:1` and simply stop sticking. So: the bar's own computed
//     position, the ABSENCE of any `fixed` element under `.app`, and the ABSENCE of
//     the spacer are all asserted.
//
// (B) THE CHECKOUT MUST BE `v-if`-MOUNTED, and that is not cosmetic. `NeoModal`
//     has no `open` prop, and three shipped NON-EDITABLE specs locate controls with
//     UNSCOPED role+name queries — `guest-order.spec.js:865`,
//     `guest-status.spec.js:664` and `guest-lead-capture.spec.js:466` each click an
//     unscoped `getByRole('button', { name: 'Zavrieť' })` on the payment modal that
//     opens right after this one closes. An always-mounted checkout would leave its
//     own footer in the DOM and hand `.modal-scrim` (pointer-events:auto over the
//     whole viewport) the click. Asserted from both ends: dialog count 0 → 1 → 0,
//     and after the submit exactly ONE dialog with exactly ONE unscoped "Zavrieť".
//
// (C) THE `+` AT THE STOCK CEILING NOW LOOKS DEAD. `NeoStepper`'s `incDisabled`
//     put a real `disabled` attribute on "+" alone, but the ported stylesheet had
//     no `.stepper button:disabled` rule — only `.stepper.disabled button` for the
//     whole control — so the button measured `opacity:1`, `cursor:pointer`,
//     `pointer-events:auto`, and mousedown still applied the full press physics.
//     `friends-theme.css` A11 closes it (§UC-GX-002: ".35 opacity on the + button
//     only"). `pointer-events:none` is the load-bearing half.
//
// (D) THE 320px FOOTER GIVES NO DEGRADATION SIGNAL. `.btn` is `white-space:nowrap`
//     and `.m-foot .btn` is `flex:1`, so a footer that does not fit neither wraps
//     nor shrinks nor ellipsises — it paints outside the modal's 4px border and
//     `.modal-scrim` grows a horizontal scrollbar. The MIN-CONTENT need is measured
//     (the flex-resolved width always sums to the container and hides it).
//
// (E) THE SUBMIT CARRIES NO AUTH HEADERS AND THE PAYLOAD IS UNCHANGED. The URL
//     token IS the credential (GSO-T3); `api.js guestRequest()` is untouched by
//     this row and must stay that way. The GSO-T3 input bounds are mirrored as
//     `maxlength`.
//
// Hermetic: its own friend, its own cycle, its own products, its own guest link.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null
let cycle = null
let coffee = null
let scarce = null
let link = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const GUEST_TICKER = '+++ KÁVA POD PULTOM +++ BEZ ÚČTU · BEZ REČÍ +++ POŠLI ODKAZ ĎALEJ +++'

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// A friend with real credentials — the identity `/api/guest-links` requires.
async function makeHost() {
  const username = `gx1shell_${uniq}`.slice(0, 30)
  const name = `Peto Shell ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()
  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, token, auth: { Authorization: `Bearer ${token}` } }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  host = await makeHost()

  const res = await admin('/api/cycles', { method: 'post', data: { name: `RDGX1 Shell ${uniq}`, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  cycle = { ...(await res.json()), name: `RDGX1 Shell ${uniq}` }
  expect((await admin(`/api/cycles/${cycle.id}`, {
    method: 'patch',
    data: { markup_ratio: 1.25, expected_date: '29. august 2026' },
  })).status()).toBe(200)

  // Two purposes ⇒ the `.cat-tabs` strip renders (single purpose ⇒ no strip).
  const p1 = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycle.id, name: `Shell Espresso ${uniq}`, purpose: 'Espresso',
      roast_type: 'Tmavé', roastery: 'Goriffee',
      description1: 'natural · 1100 m n. m.', description2: 'slivka, para orech',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(p1.status()).toBe(201)
  coffee = await p1.json()

  // 500 g left ⇒ exactly two 250 g bags, so the `+` ceiling is reachable on screen.
  const p2 = await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycle.id, name: `Shell Scarce ${uniq}`, purpose: 'Espresso', price_250g: 12, stock_limit_g: 500 },
  })
  expect(p2.status()).toBe(201)
  scarce = await p2.json()

  expect((await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycle.id, name: `Shell Filter ${uniq}`, purpose: 'Filter', price_250g: 11 },
  })).status()).toBe(201)

  const share = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
  expect([200, 201]).toContain(share.status())
  link = (await share.json()).link
})

test.afterAll(async () => { await ctx?.dispose() })

async function gotoGuest(page, width = 378) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/g/${link.token}`)
  await expect(page.locator('.app .card.hl')).toBeVisible({ timeout: TIMEOUT })
}

test.describe('RD-GX-1 · g-order scaffold, brand header and hero (§UC-GX-001)', () => {
  test('the view root is `.app`, the guest chrome is its first three children, and the background is uniform', async ({ page }) => {
    await gotoGuest(page)

    const app = page.locator('.app')
    await expect(app).toHaveCount(1)

    // Chrome, in order, full-bleed and NOT sticky — `.cat-tabs` owns the top edge.
    const chrome = await app.evaluate((el) => [...el.children].slice(0, 3).map((c) => c.className))
    expect(chrome, 'appbar → hazard tape → ticker, as direct children of .app').toEqual(['appbar', 'hazard', 'ticker'])
    // NOT sticky (02 §UC-DS-005) — it scrolls away and `.cat-tabs` owns the top
    // edge. (`.appbar` is `position:relative` in the theme, for the hazard border;
    // what matters is that it is not pinned.)
    await expect(app.locator('.appbar')).not.toHaveCSS('position', 'sticky')

    // The wordmark replaces a screen title, with the middle syllable in accent.
    await expect(app.locator('.appbar .titles .t')).toHaveText('Podpultovka')
    await expect(app.locator('.appbar .titles .t span')).toHaveCSS('color', 'rgb(255, 45, 135)')
    await expect(app.locator('.appbar .titles .s')).toHaveText('Objednávka cez odkaz')
    await expect(app.locator('.appbar .chip')).toHaveText('Bez účtu')
    await expect(app.locator('.appbar .chip')).toHaveClass(/\bacc\b/)
    await expect(app.locator('.ticker span')).toContainText(GUEST_TICKER)

    // §UC-GX-001 item 1: the per-tab background tinting is REMOVED. The root
    // carries the theme's `--bg` and nothing else, on either purpose tab.
    const bgEspresso = await app.evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.getByRole('tab', { name: 'Filter' }).click()
    const bgFilter = await app.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bgEspresso, 'uniform --bg').toBe('rgb(255, 248, 243)')
    expect(bgFilter, 'the same on every tab — no bg-sky-100 / bg-stone-200 tinting').toBe(bgEspresso)
  })

  test('the hero is `.card.hl` with the magenta offset shadow, three badges and the mono deadline', async ({ page }) => {
    await gotoGuest(page)

    const hero = page.locator('.app .card.hl')
    // `.card.hl` is the ONLY card on the guest surface with an ACCENT shadow
    // (plain `.card` is `5px 5px 0` ink); losing `.hl` is invisible to any
    // behaviour spec.
    await expect(hero).toHaveCSS('box-shadow', 'rgb(255, 45, 135) 6px 6px 0px 0px')
    await expect(hero).toHaveCSS('border-top-width', '3px')

    await expect(hero.locator('h1.h-screen')).toHaveText(cycle.name)
    await expect(hero).toContainText(`Spoločná objednávka · organizuje ${host.name.split(' ')[0]}`)

    // Deadline: VERBATIM from the API, in `.mono`, with the NeoIcon calendar and
    // no emoji (the design language has none — the shipped line was "📅 …").
    const deadline = hero.locator('.mono')
    await expect(deadline).toHaveText('Objednávka do: 29. august 2026')
    await expect(deadline.locator('svg')).toHaveCount(1)
    await expect(hero).not.toContainText('📅')

    const badges = hero.locator('.badge')
    await expect(badges).toHaveCount(3)
    await expect(badges.nth(0)).toHaveText('Login netreba')
    await expect(badges.nth(0)).toHaveClass(/\bacc\b/)
    await expect(badges.nth(1)).toHaveText('Platba prevodom')
    await expect(badges.nth(2)).toHaveText(`Tovar odovzdá ${host.name.split(' ')[0]}`)
    await expect(badges.nth(2)).toHaveClass(/\bacc-o\b/)

    // Prototype copy — "Účet netreba" now lives in the appbar chip, so the shipped
    // sentence that repeated it is gone.
    await expect(hero).toContainText('Vyberte si tovar, na konci zadáte len meno a telefón.')
    await expect(hero).not.toContainText('Účet netreba.')
  })
})

test.describe('RD-GX-1 · the shared neo grid (§UC-GX-002)', () => {
  test('the purpose strip is the theme `.cat-tabs` (sticky, top 0, z 40) with real tabs', async ({ page }) => {
    await gotoGuest(page)

    const strip = page.locator('.app .cat-tabs')
    await expect(strip).toHaveCount(1)
    await expect(strip).toHaveCSS('position', 'sticky')
    await expect(strip).toHaveCSS('top', '0px')
    await expect(strip).toHaveCSS('z-index', '40')
    // The radix triggers it replaces were real buttons; the prototype's are bare
    // spans, so the house zero-pixel ARIA layer has to carry the role.
    await expect(strip.getByRole('tab')).toHaveCount(2)
    await expect(strip.getByRole('tab', { name: 'Espresso' })).toHaveAttribute('aria-selected', 'true')

    await strip.getByRole('tab', { name: 'Filter' }).click()
    await expect(strip.getByRole('tab', { name: 'Filter' })).toHaveAttribute('aria-selected', 'true')
    await expect(strip.getByRole('tab', { name: 'Filter' })).toHaveClass(/\bon\b/)
    await expect(page.getByTestId(`product-${coffee.id}`), 'one purpose at a time').toHaveCount(0)

    // At most one sticky bar per edge (02 §UC-DS-005): the strip at the top, the
    // cartbar at the bottom, nothing else.
    const stickies = await page.evaluate(() => [...document.querySelectorAll('.app *')]
      .filter((e) => getComputedStyle(e).position === 'sticky')
      .map((e) => e.className))
    expect(stickies, 'exactly two, one per edge').toEqual(['cat-tabs', 'cartbar'])
  })

  test('a variant box selects individually (`.vbox.sel`) — the whole-card ring is gone', async ({ page }) => {
    await gotoGuest(page)

    const card = page.getByTestId(`product-${coffee.id}`)
    const boxes = card.locator('.vbox')
    await expect(boxes, '250g + 1kg').toHaveCount(2)
    await expect(boxes.nth(0)).not.toHaveClass(/\bsel\b/)

    await card.getByTestId('inc-250g').click()
    await expect(boxes.nth(0)).toHaveClass(/\bsel\b/)
    await expect(boxes.nth(0)).toHaveCSS('box-shadow', 'rgb(255, 45, 135) 3px 3px 0px 0px')
    await expect(boxes.nth(0).locator('.vprice')).toHaveCSS('color', 'rgb(255, 45, 135)')
    // Selection is PER BOX — the sibling must not light up with it, and neither
    // may the card gain a ring (`getGroupQuantityTotal` is retired).
    await expect(boxes.nth(1), 'the other variant is untouched').not.toHaveClass(/\bsel\b/)
    await expect(card).toHaveCSS('box-shadow', 'rgb(10, 10, 10) 5px 5px 0px 0px')

    // Prices arrive marked up from the server; the FE never multiplies.
    await expect(boxes.nth(0).locator('.vprice')).toHaveText('12.50 EUR')
    await expect(boxes.nth(1).locator('.vprice')).toHaveText('37.50 EUR')
  })

  test('⚠ the `+` at the stock ceiling is disabled AND inert — no press physics, no false "added"', async ({ page }) => {
    await gotoGuest(page)

    const card = page.getByTestId(`product-${scarce.id}`)
    const plus = card.getByTestId('inc-250g')
    const qty = card.getByTestId('qty-250g')

    // 500 g limit ⇒ exactly two 250 g bags.
    await plus.click()
    await plus.click()
    await expect(qty).toHaveText('2')
    await expect(card.getByTestId('stock-label')).toHaveText('Vypredané')
    await expect(plus, 'the ceiling reaches assistive tech').toBeDisabled()

    // (C): before friends-theme.css A11 this measured opacity 1 / pointer:pointer /
    // pointer-events:auto — hover turned the dead button `--hi` and mousedown gave
    // it the full `translate(2px,2px)` press, which reads as "added" at exactly the
    // ceiling. `pointer-events:none` is the half that removes the false feedback.
    await expect(plus).toHaveCSS('opacity', '0.35')
    await expect(plus).toHaveCSS('cursor', 'not-allowed')
    await expect(plus).toHaveCSS('pointer-events', 'none')

    // …and the refusal is still silent, and still holds against a click that
    // bypasses both actionability and the disabled attribute.
    await plus.dispatchEvent('click')
    await expect(qty, 'silently refused — no growth').toHaveText('2')
    await expect(page.locator('.app .banner.danger')).toHaveCount(0)

    // It lifts the moment the grams are freed again.
    await card.getByTestId('dec-250g').click()
    await expect(plus).toBeEnabled()
    await expect(plus).toHaveCSS('pointer-events', 'auto')
  })
})

test.describe('RD-GX-1 · the sticky cartbar (§UC-GX-003)', () => {
  test('⚠ `.cartbar` is a DIRECT `.app` child that really is sticky — no `fixed`, no spacer', async ({ page }) => {
    await gotoGuest(page)

    const bar = page.locator('.cartbar')
    await expect(bar).toHaveCount(1)
    // (A). A plain `sticky bottom-0 z-50` utility div in this position computes
    // `relative` / `z-index: 1` — `.app > *` wins by declaration order. Only the
    // THEME class survives, and only because its rule is declared later.
    await expect(bar).toHaveCSS('position', 'sticky')
    await expect(bar).toHaveCSS('bottom', '0px')
    await expect(bar).toHaveCSS('z-index', '50')
    await expect(bar).toHaveCSS('box-shadow', 'rgb(255, 45, 135) 0px -6px 0px 0px')
    expect(await bar.evaluate((el) => el.parentElement.classList.contains('app')), 'direct child of .app').toBe(true)

    // The `fixed` footer and its `h-32` spacer are both GONE: with `sticky` the
    // spacer would be 128px of dead space at the end of every page.
    const fixed = await page.evaluate(() => [...document.querySelectorAll('.app *')]
      .filter((e) => getComputedStyle(e).position === 'fixed').map((e) => e.className))
    expect(fixed, 'no fixed element anywhere under .app').toEqual([])
    await expect(page.locator('.app .h-32, .app .h-48')).toHaveCount(0)

    // Sticky needs no spacer because `.app` is `min-height:100vh` + flex column and
    // the page column takes `flex-1` — so on a SHORT page the bar still sits at the
    // viewport bottom rather than half way up.
    const box = await bar.boundingBox()
    expect(Math.round(box.y + box.height), 'flush with the viewport bottom').toBe(900)
  })

  test('the bar carries the deadline, the count, the sum and one accent action; lines use `×`', async ({ page }) => {
    await gotoGuest(page)

    const bar = page.locator('.cartbar')
    await expect(bar.locator('.deadline')).toHaveText('Objednávka do: 29. august 2026')
    await expect(bar).toContainText('Položiek: 0')
    await expect(page.getByTestId('cart-total')).toHaveText('Celkom: 0.00 EUR')

    const order = bar.getByTestId('open-checkout')
    await expect(order).toHaveText('Objednať')
    await expect(order).toHaveClass(/\baccent\b/)
    await expect(order, 'nothing to order yet').toBeDisabled()
    await expect(bar.locator('.btn'), 'one action only').toHaveCount(1)

    // `<details>` renders only when the cart has lines (shipped rule).
    await expect(bar.locator('details')).toHaveCount(0)

    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await expect(page.getByTestId('cart-total')).toHaveText('Celkom: 25.00 EUR')
    await expect(bar).toContainText('Položiek: 1')
    await expect(order).toBeEnabled()

    await bar.locator('summary').click()
    const line = bar.locator('.lines .ln').first()
    // U+00D7 MULTIPLICATION SIGN, not the letter "x" (prototype).
    await expect(line).toContainText('×2')
    expect(await line.innerText(), 'the letter x would be a fidelity bug').not.toContain('x2')
    await expect(line.locator('.mono')).toHaveText('25.00 EUR')
  })
})

test.describe('RD-GX-1 · the checkout modal (§UC-GX-003)', () => {
  test('⚠ it is `v-if`-MOUNTED: no dialog, no trigger and no scrim exist until it opens', async ({ page }) => {
    await gotoGuest(page)
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()

    // (B). An always-mounted `NeoModal` would put "Späť"/"Odoslať objednávku" and a
    // full-viewport `.modal-scrim` in the DOM permanently.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Späť' })).toHaveCount(0)
    await expect(page.getByTestId('guest-submit')).toHaveCount(0)

    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCount(1)
    await expect(dialog.locator('.m-title')).toHaveText('Dokončiť objednávku')
    // Rich subtitle: the sum is mono and ink-coloured inside a `.sub` row.
    await expect(dialog.locator('.m-head .sub')).toHaveText('Suma na úhradu: 12.50 EUR. Platba prevodom, tovar vám odovzdá Peto.')
    await expect(dialog.locator('.m-head .sub b')).toHaveClass(/\bmono\b/)

    // The × is a deliberate SYNONYM — Playwright matches accessible names as a
    // case-insensitive SUBSTRING, so naming it "Zavrieť dialóg" would collide with
    // the "Zavrieť" footer buttons three immutable guest specs query unscoped.
    await expect(dialog.locator('.m-x')).toHaveAttribute('aria-label', 'Zatvoriť dialóg')

    await dialog.getByRole('button', { name: 'Späť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim'), 'the scrim must not linger to swallow clicks').toHaveCount(0)
  })

  test('the three fields carry the GSO-T3 bounds as `maxlength`, and the inline error is a slim danger banner', async ({ page }) => {
    await gotoGuest(page)
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')

    const fields = [
      ['guest-name', 'Meno *', 'Meno a priezvisko', '120', null],
      ['guest-phone', 'Mobil *', '0901 234 567', '32', 'tel'],
      ['guest-email', 'E-mail (nepovinné)', 'meno@example.com', '160', 'email'],
    ]
    for (const [testid, label, placeholder, max, mode] of fields) {
      const input = dialog.getByTestId(testid)
      await expect(input).toHaveClass('inp')
      await expect(input).toHaveAttribute('placeholder', placeholder)
      // The mirror is what stops a 200 000-char name reaching the host and admin
      // views; the server re-validates, but only after it has been typed.
      await expect(input).toHaveAttribute('maxlength', max)
      if (mode) await expect(input).toHaveAttribute('inputmode', mode)
      await expect(dialog.locator(`label.field-lbl[for="${testid}"]`)).toHaveText(label)
    }

    // Client messages verbatim (§UC-GX-003); the server re-validates anyway.
    await dialog.getByTestId('guest-submit').click()
    const err = dialog.getByTestId('checkout-error')
    await expect(err).toHaveText('Zadajte svoje meno.')
    await expect(dialog.locator('.banner.danger.slim')).toHaveCount(1)
    await expect(dialog.locator('.banner.danger.slim .dot')).toHaveCount(1)

    await dialog.getByTestId('guest-name').fill('Marek Shell')
    await dialog.getByTestId('guest-phone').fill('0901 23')
    await dialog.getByTestId('guest-submit').click()
    await expect(err).toHaveText('Zadajte telefónne číslo (aspoň 9 číslic).')
  })

  test('⚠ the footer FITS at 320px — measured against min-content, not the flex-resolved width', async ({ page }) => {
    await gotoGuest(page, 320)
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    await expect(page.getByRole('dialog')).toHaveCount(1)

    // (D). `.m-foot .btn` is `flex:1`, so the resolved widths ALWAYS sum to the
    // container — reading them proves nothing. Clone the row at
    // `width:min-content` to get what the labels actually need.
    const foot = await page.evaluate(() => {
      const f = document.querySelector('.m-foot')
      const probe = f.cloneNode(true)
      probe.style.position = 'absolute'
      probe.style.width = 'min-content'
      probe.style.visibility = 'hidden'
      f.parentElement.appendChild(probe)
      const widths = [...probe.querySelectorAll('.btn')].map((b) => b.getBoundingClientRect().width)
      probe.remove()
      const scrim = document.querySelector('.modal-scrim')
      return {
        // scrim 18px a side + `.modal` 4px of border a side + `.m-foot` 18px of
        // padding a side ⇒ the row has `W − 80` to spend.
        available: window.innerWidth - 80,
        // +8px gap between the two buttons
        minContent: widths.reduce((a, b) => a + b, 0) + 8,
        scrimHOverflow: scrim.scrollWidth - scrim.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(foot.minContent, 'the labels are pinned verbatim, so the padding gives way instead').toBeLessThanOrEqual(foot.available)
    expect(foot.scrimHOverflow, '.btn is nowrap: an over-wide footer scrolls the scrim sideways').toBe(0)
    expect(foot.docOverflow).toBe(0)
  })

  test('no horizontal overflow at 320px, on the page and inside the grid', async ({ page }) => {
    await gotoGuest(page, 320)
    await page.getByRole('tab', { name: 'Filter' }).click()
    await page.getByRole('tab', { name: 'Espresso' }).click()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, '02 §UC-DS-005 floor').toBe(0)
    // The strip scrolls WITHIN ITSELF rather than widening the document.
    const strip = await page.locator('.cat-tabs').evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, ox: getComputedStyle(el).overflowX }))
    expect(strip.ox).toBe('auto')
  })
})

test.describe('RD-GX-1 · the submit is untouched by the restyle', () => {
  test('⚠ no auth headers on any guest call, and the payload is byte-identical', async ({ page }) => {
    const AUTH = ['authorization', 'x-admin-token', 'x-friends-password', 'cookie']
    const calls = []
    page.on('request', (r) => {
      if (r.url().includes('/api/')) calls.push({ method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() })
    })

    await gotoGuest(page)
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await page.getByTestId(`product-${coffee.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    const dialog = page.getByRole('dialog')
    // Deliberately padded, and a whitespace-only email: the payload trims name and
    // phone and omits `guest_email` entirely unless it is non-empty.
    await dialog.getByTestId('guest-name').fill('  Marek Shell  ')
    await dialog.getByTestId('guest-phone').fill(' 0901 234 567 ')
    await dialog.getByTestId('guest-email').fill('   ')
    await dialog.getByTestId('guest-submit').click()

    await expect(page.getByTestId('guest-confirmation')).toBeVisible({ timeout: TIMEOUT })

    // (E). The URL token IS the credential (GSO-T3) — `guestRequest()` sends no
    // auth of any kind, and this row must not have given it any.
    const withAuth = calls.filter((c) => Object.keys(c.headers).some((h) => AUTH.includes(h.toLowerCase())))
    expect(withAuth.map((c) => c.url), 'guest calls carry no credentials at all').toEqual([])

    const submit = calls.find((c) => c.method === 'POST' && c.url.includes('/orders'))
    expect(JSON.parse(submit.body)).toEqual({
      guest_name: 'Marek Shell',
      guest_phone: '0901 234 567',
      items: [{ product_id: coffee.id, variant: '250g', quantity: 2 }],
    })
    expect(Object.keys(JSON.parse(submit.body)), 'no guest_email for a blank field').not.toContain('guest_email')

    // The status URL still round-trips through localStorage under the SAME schema.
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('gorifi_guest_orders')))
    expect(Object.keys(stored[link.token]).sort())
      .toEqual(['cycle_name', 'guest_name', 'order_id', 'order_token', 'saved_at', 'status_url', 'total'])

    // (B) from the other end: the checkout is unmounted before the payment modal
    // opens, so the unscoped "Zavrieť" three immutable specs use resolves to ONE
    // element and its scrim is the only one on the page.
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.getByRole('dialog')).toContainText('Platba')
    await expect(page.getByRole('button', { name: 'Zavrieť' }), 'the immutable specs query this unscoped').toHaveCount(1)
    // ⚠ UPDATED BY RD-GX-2. When this row shipped, `PaymentModal` was still the
    // radix dialog, so the only `.modal-scrim` that could exist here was the
    // checkout's — left behind to swallow the click those specs make — and the
    // count was 0. RD-GX-2 put `PaymentModal` on `NeoModal` (06 §UC-GX-005), so the
    // payment modal now brings its OWN scrim. The property being pinned is
    // unchanged: exactly ONE scrim, and it belongs to the dialog on screen.
    await expect(page.locator('.modal-scrim'), 'exactly one scrim: the payment modal\'s').toHaveCount(1)
    await expect(page.locator('.modal-scrim .modal .m-title'), 'and it is the Platba one, not the checkout\'s').toHaveText('Platba')
  })
})
