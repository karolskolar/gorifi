import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FO-5 — module 04's FIDELITY net (04 §UC-FO-015 item 2), the same shape as
// module 03's `portal-fidelity.spec.js`.
//
// The closeout measured this screen element-for-element against the live
// prototype (served over HTTP, fonts force-loaded, the port fed the prototype's
// own demo data) at 378 px in all three states and at 1180 px. It found exactly
// two geometry drifts the port owned, and both are call-site fixes that a later
// edit would delete without anything noticing. That is what this file exists for.
//
// BOTH ARE THE SAME DEFECT, and it is the one module 03's closeout named:
// Tailwind preflight's `html{line-height:1.5}` reaching an element that
// `friends-theme.css`'s A9/A10 counter — a CLASS list — structurally cannot see,
// because the element carries no class at all.
//
//   (1) `.cartbar > details`. `.cartbar details summary` is `display:inline-flex`
//       (theme, canon-verbatim), so the `<details>` block establishes a line box
//       and its STRUT comes from the details' own inherited `line-height`. The
//       canon computes the UA `normal`; the port inherited 24px. Measured:
//       details 24→27, and therefore `.cartbar` 146→149 open / 90→93 locked, on
//       phone AND desktop — i.e. the sticky footer was 3px too tall on every
//       order screen in the module.
//
//   (2) the bakery card's title wrapper. Its `<h3>` is `inline` (deliberately —
//       it shares the weight span's baseline), so the WRAPPER establishes the
//       line box. Measured: header row 20→24, card 181→185, on every bakery card.
//       The COFFEE card is unaffected and deliberately carries no such fix: its
//       `<h3>` is block-level, so no strut is involved (measured: zero delta).
//
// `line-height: normal` is asserted EXACTLY rather than by height alone — that is
// the mechanism, and it is font-independent, so it cannot flake on a webfont
// metric (03 §UC-FL-013's reasoning, reused). The derived geometry is asserted
// too, with `neo-control-metrics.spec.js`'s 1px tolerance, because the property
// alone would not notice someone moving the element under a class that re-inflates.
//
// Deliberately NOT asserted here — recorded as residuals in 04 §UC-FO-015 instead,
// because the fix would have to land in `neo/` or `friends-theme.css`, which this
// row does not own:
//   · the icon-only `.chip` is 29px against the canon's 32 (preflight's
//     `svg{display:block;vertical-align:middle}` versus the canon's inline,
//     baseline-aligned SVG — restoring both reproduces 32 exactly). Systemic:
//     it applies to every icon-only chip/button in the design system.
//   · `.stepper button` renders its `−`/`+` in Figtree where the canon leaves the
//     UA's Arial (preflight's `button{font-family:inherit}`). Zero geometry
//     effect — the button is 38×38 either way.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// Canon numbers, measured in `docs/design/friends-portal-redesign/Podpultovka
// Friends.html` over HTTP at 378px, phone frame, fonts force-loaded.
const CANON = {
  cartbarDetails: 24,   // summary 16 + its 8px margin-top, no strut inflation
  bakeryHeaderRow: 20,  // .display 18.05 baseline-aligned with the 13px weight span
}

const near = (actual, expected, what) =>
  expect(Math.abs(actual - expected), `${what}: got ${actual}, canon ${expected}`).toBeLessThanOrEqual(1)

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

  const username = `rdfo5f_${uniq}`.slice(0, 30)
  const name = `RDFO5F Hostitel ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
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

async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
  await expect(page.locator('.app .cartbar')).toBeVisible()
}

/** Text metrics here are FONT-METRIC driven and Google Fonts loads lazily. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800, 900]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
}

test.describe('04 fidelity — the preflight line-height counter at the two call sites', () => {
  let coffee = null
  let bakery = null

  test.beforeAll(async () => {
    const cname = `E2E RDFO5F Kava ${uniq}`
    const c = await admin('/api/cycles', {
      method: 'post',
      data: { name: cname, type: 'coffee', status: 'open', expected_date: '29. august 2026' },
    })
    expect(c.status(), 'cycle create').toBe(201)
    coffee = { ...(await c.json()), name: cname }
    const p = await admin('/api/products', {
      method: 'post',
      data: { cycle_id: coffee.id, name: `Fid Kava ${uniq}`, purpose: 'Espresso', price_250g: 7.6 },
    })
    expect(p.status(), 'product create').toBe(201)

    // The bakery card's title must stay on ONE line for the header row height to
    // be a stable number — hence a deliberately short name.
    const bp = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: `Bageta ${uniq}`.slice(0, 18), category: 'slané',
        composition: 'psenicna muka, sunka, syr',
        variants: [{ label: '1 ks', weight_grams: 190, price: 3.2 }],
      },
    })
    expect(bp.status(), 'bakery product create').toBe(201)
    const bname = `E2E RDFO5F Pekaren ${uniq}`
    const bc = await admin('/api/cycles', {
      method: 'post',
      data: { name: bname, type: 'bakery', status: 'open', bakery_product_ids: [(await bp.json()).id] },
    })
    expect(bc.status(), 'bakery cycle create').toBe(201)
    bakery = { ...(await bc.json()), name: bname }
  })

  test('⚠ the cartbar `<details>` computes line-height NORMAL, and is the canon 24px', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, coffee)
    await fontsReady(page)

    const m = await page.evaluate(() => {
      const d = document.querySelector('.app .cartbar details')
      const s = d.querySelector('summary')
      return {
        lh: getComputedStyle(d).lineHeight,
        detailsH: d.getBoundingClientRect().height,
        summaryH: s.getBoundingClientRect().height,
        summaryDisplay: getComputedStyle(s).display,
        summaryMt: getComputedStyle(s).marginTop,
      }
    })

    // The mechanism. `1.5` (or `24px`) here is the whole defect.
    expect(m.lh, 'the counter is in force on the element preflight actually reaches').toBe('normal')
    // Why the element matters at all: an inline-level summary makes the details a
    // line-box owner. If this ever becomes `block` the fix is moot — and it is the
    // theme's, canon-verbatim, so a change is a signal, not a detail.
    expect(m.summaryDisplay, 'canon: .cartbar details summary is inline-flex').toBe('inline-flex')
    expect(m.summaryMt).toBe('8px')
    near(m.detailsH, CANON.cartbarDetails, '.cartbar details height')
    near(m.detailsH - m.summaryH, 8, 'details height is exactly the summary plus its margin')
  })

  test('⚠ the bakery card title wrapper computes NORMAL, and the header row is the canon 20px', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, bakery)
    await fontsReady(page)

    const m = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="product-card"]')
      const row = card.firstElementChild
      const wrap = row.firstElementChild
      const h3 = wrap.querySelector('h3.display')
      return {
        wrapLh: getComputedStyle(wrap).lineHeight,
        rowH: row.getBoundingClientRect().height,
        h3Display: getComputedStyle(h3).display,
        h3Lines: h3.getClientRects().length,
      }
    })

    expect(m.wrapLh, 'the counter is in force on the wrapper').toBe('normal')
    // The `inline` h3 is what makes the wrapper the line-box owner; it is a pinned
    // RD-FO-2 choice (the weight span's baseline), so it is asserted, not assumed.
    expect(m.h3Display, 'the bakery title is inline by design').toBe('inline')
    expect(m.h3Lines, 'one line, or the height number below means nothing').toBe(1)
    near(m.rowH, CANON.bakeryHeaderRow, 'bakery card header row height')
  })

  test('the COFFEE card deliberately has no such fix — and needs none', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, coffee)
    await fontsReady(page)

    const m = await page.evaluate(() => {
      const h3 = document.querySelector('[data-testid="product-card"] h3.display')
      return {
        display: getComputedStyle(h3).display,
        lh: getComputedStyle(h3).lineHeight,
        h: h3.getBoundingClientRect().height,
      }
    })
    // Block-level ⇒ its own `line-height:.95` governs its box outright and the
    // parent's strut never enters the calculation. 19 × 0.95 = 18.05.
    expect(m.display, 'coffee title is block-level').toBe('block')
    expect(m.lh).toBe('18.05px')
    near(m.h, 18.05, 'coffee card title height')
  })
})
