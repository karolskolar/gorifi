import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// 40×30 RGBA PNG, left half opaque magenta, right half fully transparent — the
// product-photo fixture for the frameless image rules (product decision
// 2026-08-20). Non-square ON PURPOSE: `height:auto` at a 58px column must
// compute 43.5px, which no cropped/covered rendering can produce.
const FIXTURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAM0lEQVR4nO3OMQ0AAAgEMQyhE9mPAjbGXnJ7Kz35vL4DBAQEBAQEBAQEBAQEBAQEBAS8WsmPUYvRfZB+AAAAAElFTkSuQmCC'

// RD-FO-2 — the friend order screen's PRODUCT CARDS (04 §UC-FO-005..007), and the
// deferred `NeoStepper` obligation (02 §UC-DS-014 item 6, restated by
// 04 §UC-FO-015 item 4).
//
// What this file pins, and why each one is a silent regression without it:
//
// (A) THE VARIANT MATRIX IS NOW DATA-DRIVEN, AND IT USED TO HIDE PRODUCT.
//     The pre-redesign template hand-wrote one block per weight and gated the
//     whole group behind `v-if="!product.price_20pc5g"`, so a product priced for
//     both capsules and weights showed ONLY the capsules — an admin could publish
//     a price nobody could ever buy. 04 §UC-FO-005 replaces that with "one `.vbox`
//     per non-null price field, in a fixed order". A build cannot see the
//     difference; only an all-six-prices product can.
//
// (B) THE STOCK BAR CHANGED UNITS BUT MUST NOT CHANGE MATH (resolved conflict #6).
//     `getRemainingGrams` is server `remaining_g` MINUS this friend's own local
//     cart, so the bar reacts before anything is saved. Displaying it in kg is a
//     formatter with three interesting cases (250 → "0.25 kg", 1000 → "1 kg",
//     1250 → "1.25 kg") — trailing-zero stripping and the dot decimal are exactly
//     the kind of thing a `toFixed(2)` "cleanup" would quietly break.
//
// (C) THE `+` CEILING LIVES IN THE VIEW, BY MANDATE.
//     02 §UC-DS-008 forbids a `max` in `NeoStepper`, so the refusal is asserted
//     from both sides: the button carries the disabled state (`incDisabled`), and
//     a click dispatched straight at the DOM — bypassing actionability and the
//     disabled attribute alike — still cannot move the quantity.
//     ⚠ Be honest about what that second half reaches. `NeoStepper.inc()` returns
//     early when `incDisabled` is true, so the forced click never emits and never
//     enters `onQty` → `increment` → `canIncrement`. The two assertions therefore
//     jointly pin `incDisabled` plus the SILENT refusal (no growth, no toast, no
//     banner); the `onQty` re-check is NOT e2e-reachable while `incDisabled` is
//     bound, and no test here proves it. See the note on that test for why the
//     production double-guard still stays, and what it means for RD-FO-3.
//
// (D) NeoStepper's FIRST REGRESSION NET. It shipped in RD-DS-3 with no consumer
//     and therefore no coverage: v-model round-trip, the `min` floor, and the
//     no-emit-at-`min` rule (a no-op tap must not dirty the cart, or auto-save and
//     the leave guard fire on nothing).
//
// (E) THE FRAMELESS PHOTO (product decision 2026-08-20, superseding 02
//     §UC-DS-013's bare-frame disposition): the photo renders as imported — no
//     `.pimg` frame, no border, no dark gradient, never cropped, top-aligned
//     with the name, only as tall as itself; no photo ⇒ nothing renders.
//
// (F) TWO NARROW-WIDTH HOLES THAT ARE INVISIBLE TO A BUILD AND TO A SCREENSHOT.
//     The variant grid's `grid-cols-2` has a track minimum of ZERO, so a
//     breakpoint set even 6px too low does not break the layout — it silently
//     squeezes the flex stepper buttons below the 38×38 that 02 §UC-DS-008 pins.
//     And the card's text column is `min-w-0`, which lets the BOX shrink but does
//     nothing about an unbreakable token: one 44-char space-free product name
//     scrolled the whole document 263px sideways at 320px. Both are asserted with
//     real fixtures at real widths, because nothing else can see them.
//
// Hermetic: its own friend, its own cycles, its own products. Nothing stubbed.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null
let eater = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

async function makeCycle(label, over = {}) {
  const name = `E2E RDFO2 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open', ...over } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function makeFriend(prefix) {
  const username = `${prefix}_${uniq}`.slice(0, 30)
  const name = `RDFO2 ${prefix} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  // An admin reset raises must_change_password; clear it so the portal is not gated
  // by the forced-change modal on the way to the order page.
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

/** Consume stock as a DIFFERENT friend, so `excludeFriendId` leaves it counted. */
async function consume(cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${eater.id}`, {
    headers: eater.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'stock-eater cart saved').toBe(200)
  const sub = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${eater.id}/submit`, {
    headers: eater.auth, data: {}, timeout: TIMEOUT,
  })
  expect(sub.status(), 'stock-eater order submitted').toBe(200)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  host = await makeFriend('host')
  eater = await makeFriend('eater')
})

test.afterAll(async () => { await ctx?.dispose() })

async function signIn(page) {
  const stored = JSON.stringify({
    friendId: host.id,
    friendName: host.name,
    token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)
}

// ⚠ A cold deep-link to /cycle/:id bounces to `/` even with a valid stored
// session — `FriendOrder.vue`'s `onMounted` delegates restore to `FriendPortal`.
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
  await expect(page.locator('.app .appbar')).toBeVisible()
}

/** Text metrics here are FONT-METRIC driven and Google Fonts loads lazily. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
}

/** The card whose `<h3>` is this product's name. */
function cardFor(page, name) {
  return page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name, exact: true }) })
}

// ---------------------------------------------------------------------------
// UC-FO-005 — the coffee card

test.describe('UC-FO-005 — coffee product card', () => {
  let cycle = null
  let full = null
  let unbreakable = null
  let bare = null

  test.beforeAll(async () => {
    // markup 1.25 on purpose: every price on screen must be the MARKED-UP one, and
    // a ratio of 1 would let a dropped `applyMarkup` pass.
    cycle = await makeCycle('Card')
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.25 } })).status()).toBe(200)

    full = await addProduct(cycle.id, {
      name: `Etiopia Yirgacheffe ${uniq}`,
      purpose: 'Espresso',
      roast_type: 'Medium roast',
      roastery: 'Goriffee',
      description1: '100% natural bourbon arabica',
      description2: 'cokolada · lieskovy orech · karamel',
      // ALL SIX price fields — (A) above.
      price_150g: 4, price_200g: 5.2, price_250g: 8, price_500g: 15.6, price_1kg: 28, price_20pc5g: 6.4,
      // A 40×30 RGBA PNG (right half fully TRANSPARENT) for the frameless-photo
      // assertions: the 4:3 ratio is what proves `height:auto` (58px wide ⇒
      // 43.5px tall — a cropped `object-fit:cover` square would read 58), and
      // the transparency is the "transparent stays transparent" claim's fixture.
      image: FIXTURE_PNG,
    })
    await addProduct(cycle.id, {
      name: `Kapsule Only ${uniq}`,
      purpose: 'Espresso',
      price_20pc5g: 6.4,
    })
    // ⚠ (F) — a 44-char SPACE-FREE, HYPHEN-FREE name. Product names are free admin
    // text and the card's text column is a `min-w-0` flex child, which lets the box
    // shrink but does nothing about a token that cannot break: this one painted the
    // `<h3>` 479px wide inside a 183px column and scrolled the DOCUMENT 263px
    // sideways at 320px. A hyphenated name would NOT reproduce it (a `-` is a break
    // opportunity), which is exactly why the fixture is spelled this way.
    unbreakable = await addProduct(cycle.id, {
      name: `Etiopiayirgacheffekongannaerobicnatural${uniq.slice(0, 5)}`,
      purpose: 'Espresso',
      description2: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      price_250g: 8, price_1kg: 28,
    })
    // NO image on purpose — the "no photo ⇒ nothing renders" fixture.
    bare = await addProduct(cycle.id, {
      name: `Holy Bare ${uniq}`,
      purpose: 'Espresso',
      price_250g: 8,
    })
  })

  test('the card: heading, two badges, spec line, mono notes, and a frameless top-aligned photo (none when no photo)', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, full.name)
    await expect(card).toBeVisible()

    // ⚠ The name is an <h3> — 04 §UC-FO-015's pinned hook, relied on by the
    // pre-existing `guest-host-view.spec.js`. `.display` supplies the caps.
    const h3 = card.getByRole('heading', { name: full.name, exact: true })
    await expect(h3).toBeVisible()
    const nameStyle = await h3.evaluate((el) => ({
      tag: el.tagName,
      cls: el.className,
      tt: getComputedStyle(el).textTransform,
      ff: getComputedStyle(el).fontFamily,
      fw: getComputedStyle(el).fontWeight,
      fs: getComputedStyle(el).fontSize,
      lh: getComputedStyle(el).lineHeight,
    }))
    expect(nameStyle.tag).toBe('H3')
    expect(nameStyle.cls.split(/\s+/)).toContain('display')
    expect(nameStyle.tt, 'display caps').toBe('uppercase')
    expect(nameStyle.ff).toContain('Darker Grotesque')
    expect(nameStyle.fw).toBe('800')
    expect(nameStyle.fs, 'phone size').toBe('19px')
    // 19 × 0.95 = 18.05 — the inline line-height must survive `friends-theme.css`,
    // which loads after Tailwind and would otherwise win at equal specificity.
    expect(nameStyle.lh).toBe('18.05px')

    // Two SMALL badges: plain, then the highlighted `acc-o` roastery.
    const badges = card.locator('.badge')
    await expect(badges).toHaveCount(2)
    await expect(badges.nth(0)).toHaveText('Medium roast')
    await expect(badges.nth(1)).toHaveText('Goriffee')
    expect((await badges.nth(0).getAttribute('class')).split(/\s+/)).not.toContain('acc-o')
    expect((await badges.nth(1).getAttribute('class')).split(/\s+/)).toContain('acc-o')
    expect(await badges.nth(0).evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px')

    // ⚠ RETARGETED 2026-08-13 (Noto Sans Condensed) and again 2026-08-18: the
    // product decision moved both lines onto Figtree, the body face — matching the
    // status banner — as `.pspec` 700 / `.pnotes` 400. The notes line keeps its
    // deliberate loss of `.mono` (it was the least readable text on the card). The
    // full computed table, both weights, both subsets and the ≤2-line acceptance
    // criteria live in `product-desc-font.spec.js`; what this test keeps is the
    // card-composition claim — the two lines exist, in the right order, with the
    // right text — plus enough of the face to notice the classes being reverted.
    const spec = card.locator('.pspec').first()
    await expect(spec).toHaveText('100% natural bourbon arabica')
    const notes = card.locator('.pnotes').first()
    await expect(notes).toHaveText('cokolada · lieskovy orech · karamel')
    const lineStyles = await card.evaluate((el) => {
      const read = (sel) => {
        const cs = getComputedStyle(el.querySelector(sel))
        return { ff: cs.fontFamily, fw: cs.fontWeight, fs: cs.fontSize, color: cs.color }
      }
      return { spec: read('.pspec'), notes: read('.pnotes') }
    })
    expect(lineStyles.spec.ff, 'the body face on the spec line').toContain('Figtree')
    expect(lineStyles.spec.fw, 'the spec line is Bold').toBe('700')
    expect(lineStyles.spec.fs).toBe('14.5px')
    expect(lineStyles.spec.color, 'ink — the spec line is the heavier of the two').toBe('rgb(10, 10, 10)')
    expect(lineStyles.notes.ff, 'the body face on the notes line').toContain('Figtree')
    expect(lineStyles.notes.fw, 'the notes line is Regular').toBe('400')
    expect(lineStyles.notes.fs).toBe('14px')
    expect(lineStyles.notes.color, 'ink-dim — dimmer than the spec line').toBe('rgba(10, 10, 10, 0.66)')
    // The hierarchy the brief asks for, as a relation rather than two constants:
    // spec is heavier AND darker than notes.
    expect(Number(lineStyles.spec.fw)).toBeGreaterThan(Number(lineStyles.notes.fw))

    // ⚠ (E) — the FRAMELESS photo (product decision 2026-08-20, superseding 02
    // §UC-DS-013's bare-frame disposition and RD-FO-2's `.pimg` port). The photo
    // renders exactly as imported: no `.pimg` wrapper, no border, no background
    // behind it (transparent stays transparent), NEVER cropped (`height:auto` —
    // the 40×30 fixture at a 58px column must compute 43.5px; the old
    // `object-fit:cover` read the text-block height instead), top-aligned with
    // the product name, and only as tall as the image itself.
    await expect(card.locator('.pimg'), 'the .pimg frame is retired').toHaveCount(0)
    const photo = card.locator('img')
    await expect(photo).toHaveCount(1)
    const img = await photo.evaluate((el) => {
      const cs = getComputedStyle(el)
      const h3 = el.parentElement.querySelector('h3')
      return {
        loaded: el.complete && el.naturalWidth > 0,
        border: cs.borderTopWidth,
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage,
        fit: cs.objectFit,
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
        topDelta: Math.abs(el.getBoundingClientRect().top - h3.closest('div').getBoundingClientRect().top),
        textH: el.nextElementSibling.getBoundingClientRect().height,
      }
    })
    expect(img.loaded, 'the photo actually decoded').toBe(true)
    expect(img.border, 'no border').toBe('0px')
    expect(img.bg, 'no background of our own — transparency stays transparent').toBe('rgba(0, 0, 0, 0)')
    expect(img.bgImage, 'no dark gradient behind the photo').toBe('none')
    expect(img.w, 'phone column width 58').toBe(58)
    // height:auto ⇒ the intrinsic 4:3 ratio survives — 58 × 30/40 = 43.5. This is
    // the not-cropped claim as a number: cover/fill at the old frame geometry
    // cannot produce it.
    expect(img.h, 'natural ratio — never cropped').toBeCloseTo(43.5, 0)
    expect(img.h, 'only as tall as the image itself, not the description block')
      .toBeLessThan(img.textH)
    // self-start in an items-stretch row: the image's top edge sits at the row's
    // top, i.e. level with the product name.
    expect(img.topDelta, 'top-aligned with the name').toBeLessThanOrEqual(1)

    // …and a product with NO photo renders NOTHING — no empty frame, no box.
    const bareCard = cardFor(page, bare.name)
    await expect(bareCard).toBeVisible()
    await expect(bareCard.locator('img'), 'no photo ⇒ no element at all').toHaveCount(0)
    await expect(bareCard.locator('.pimg')).toHaveCount(0)
  })

  test('the variant matrix: one `.vbox` per priced field in the fixed order, marked-up prices, `1fr 1fr` vs `1fr`', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    // ⚠ (A): all six render, in 04 §UC-FO-005's fixed order — and the capsule
    // variant no longer suppresses the weights.
    const card = cardFor(page, full.name)
    await expect(card.locator('.vbox')).toHaveCount(6)
    expect(await card.locator('.vbox .vsize').allTextContents())
      .toEqual(['150g', '200g', '250g', '500g', '1kg', '20 ks × 5g'])
    // Every price through `applyMarkup` — base × 1.25, rounded to cents.
    expect(await card.locator('.vbox .vprice').allTextContents())
      .toEqual(['5.00 EUR', '6.50 EUR', '10.00 EUR', '19.50 EUR', '35.00 EUR', '8.00 EUR'])

    const cols = await card.locator('.grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    expect(cols.split(' '), '>1 variant ⇒ two equal columns').toHaveLength(2)

    // A capsule-only product is simply a ONE-variant grid (no special branch).
    const caps = cardFor(page, `Kapsule Only ${uniq}`)
    await expect(caps.locator('.vbox')).toHaveCount(1)
    await expect(caps.locator('.vbox .vsize')).toHaveText('20 ks × 5g')
    const capCols = await caps.locator('.grid').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    expect(capCols.split(' '), 'single variant ⇒ one column').toHaveLength(1)

    // A product with neither roast nor roastery renders no badge row at all.
    const bare = cardFor(page, `Holy Bare ${uniq}`)
    await expect(bare.locator('.badge')).toHaveCount(0)
  })

  // ⚠ THE COLUMN BREAKPOINT, AND WHY IT IS ASSERTED AT FOUR WIDTHS.
  //
  // 04 §UC-FO-005's `1fr 1fr` is adapted below 368px (recorded in `FriendOrder.vue`
  // and CLAUDE.md). The number is arithmetic on measured parts: a `.vbox`'s
  // min-content is 146px, two of them plus the 10px gap need 302px of card CONTENT
  // box, and that box is `viewport − 32 (page column) − 28 (card padding) − 6
  // (`.card`'s own 3px border a side)` ⇒ 368.
  //
  // It first shipped as 362 — the `.card` border term dropped — and NOTHING caught
  // it, because `grid-cols-2` is `repeat(2, minmax(0,1fr))`, whose track minimum is
  // ZERO. So between 362 and 367 the layout looked fine and the shortfall was
  // absorbed silently by the flex stepper buttons shrinking: 36.5px at 362, 37.75px
  // at 367. 02 §UC-DS-008 pins those hit targets at 38×38 "from CSS — do not
  // override", so that band was a real, invisible defect. 364 below is the pin that
  // makes it impossible to reintroduce; the widths on either side of 368 make the
  // switch itself unambiguous, and every case re-asserts 38×38 because the button
  // width is the actual symptom.
  test('⚠ the variant grid switches to two columns at 368px — and the "+" stays 38×38 at every width', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 378, height: 900 })
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, full.name)
    const grid = card.locator('.grid').last()

    const at = async (width) => {
      await page.setViewportSize({ width, height: 900 })
      // The grid re-lays out synchronously, but the font-metric-driven text above it
      // settles a frame later; wait for a stable box before reading.
      await page.waitForTimeout(150)
      return grid.evaluate((el) => {
        const plus = el.querySelector('.stepper button:last-child')
        const r = plus.getBoundingClientRect()
        return {
          tracks: getComputedStyle(el).gridTemplateColumns.split(' '),
          plus: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
          doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
    }

    // 320px — 02 §UC-DS-005's floor. One column, and the DOCUMENT does not scroll.
    const w320 = await at(320)
    expect(w320.tracks, '320px ⇒ single column').toHaveLength(1)
    expect(w320.plus, '38×38 survives the floor').toEqual([38, 38])
    expect(w320.doc, 'zero horizontal document overflow').toBe(0)

    // ⚠ 364px — INSIDE the old 362–367 band. Before the fix this rendered two 144px
    // tracks with a 37px-wide "+", i.e. the pinned hit target quietly lost.
    const w364 = await at(364)
    expect(w364.tracks, '364px is still BELOW the breakpoint ⇒ single column').toHaveLength(1)
    expect(w364.plus, 'and the hit target is intact — this is the regression pin').toEqual([38, 38])
    expect(w364.doc).toBe(0)

    // 367px — the last single-column width.
    const w367 = await at(367)
    expect(w367.tracks, '367px ⇒ still single column').toHaveLength(1)
    expect(w367.plus).toEqual([38, 38])

    // 368px — the switch. Both tracks land exactly on the 146px min-content, which
    // is what makes 368 the correct number rather than a safety margin.
    const w368 = await at(368)
    expect(w368.tracks, '368px ⇒ two columns').toEqual(['146px', '146px'])
    expect(w368.plus, 'and the tracks are wide enough to carry a full-size button').toEqual([38, 38])
    expect(w368.doc).toBe(0)

    // 378px — the prototype's own phone width. 151px tracks, per `03-shot.png`.
    const w378 = await at(378)
    expect(w378.tracks, 'the design width is unaffected either way').toEqual(['151px', '151px'])
    expect(w378.plus).toEqual([38, 38])
    expect(w378.doc).toBe(0)
  })

  // ⚠ (F) — free admin text must not be able to scroll the page sideways.
  test('⚠ an unbreakable product name wraps inside its column instead of scrolling the document', async ({ page }) => {
    await signIn(page)
    await page.setViewportSize({ width: 320, height: 900 })
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, unbreakable.name)
    const metrics = await card.locator('h3.display').evaluate((el) => {
      const col = el.parentElement
      // ⚠ `.pnotes`, not `.mono`: the notes line lost `.mono` on 2026-08-13 (and
      // has been Figtree since 2026-08-18). The claim under test is unchanged
      // — free admin text must wrap inside its own column — and the notes line is
      // still the right probe for it, being the longest free-text line on the card.
      const notes = col.querySelector('.pnotes')
      return {
        wrap: getComputedStyle(col).overflowWrap,
        h3Box: Math.round(el.getBoundingClientRect().width),
        h3Content: el.scrollWidth,
        notesBox: Math.round(notes.getBoundingClientRect().width),
        notesContent: notes.scrollWidth,
        lines: Math.round(el.getBoundingClientRect().height),
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })

    // ⚠ SYMPTOM FIRST, mechanism last — a failure here should name the defect the
    // user sees, not the declaration that fixes it.
    expect(metrics.doc, '02 §UC-DS-005: zero horizontal overflow at 320px').toBe(0)
    expect(metrics.h3Content, 'the name paints inside its column — it was 479px in a 183px box')
      .toBeLessThanOrEqual(metrics.h3Box)
    // It wrapped rather than being clipped — several 19px lines, nothing lost.
    expect(metrics.lines, 'and it wrapped onto more than one line').toBeGreaterThan(30)
    // `min-w-0` shrinks the BOX; only `overflow-wrap` breaks the token inside it —
    // and it is on the CONTAINER, so `description2` (also free admin text) inherits.
    expect(metrics.notesContent, 'the descriptions are covered too').toBeLessThanOrEqual(metrics.notesBox)
    expect(metrics.wrap, 'via the container, so it inherits rather than being repeated').toBe('anywhere')
  })

  test('`.sel` flips at qty > 0 — ink border, magenta shadow, magenta price — and only on the touched box', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, full.name)
    const box250 = card.locator('.vbox').nth(2)
    const box500 = card.locator('.vbox').nth(3)

    const at = async (box) => box.evaluate((el) => ({
      sel: el.classList.contains('sel'),
      border: getComputedStyle(el).borderTopWidth,
      shadow: getComputedStyle(el).boxShadow,
      price: getComputedStyle(el.querySelector('.vprice')).color,
    }))

    const before = await at(box250)
    expect(before.sel).toBe(false)
    expect(before.border, 'unselected: hairline 2px').toBe('2px')
    expect(before.shadow).toBe('none')

    await box250.getByRole('button', { name: 'viac' }).click()

    const after = await at(box250)
    expect(after.sel).toBe(true)
    expect(after.border, 'selected: 3px ink').toBe('3px')
    expect(after.shadow, 'hard 3px magenta offset').toBe('rgb(255, 45, 135) 3px 3px 0px 0px')
    expect(after.price, 'and a magenta price').toBe('rgb(255, 45, 135)')

    expect((await at(box500)).sel, 'its neighbour is untouched').toBe(false)
  })
})

// ---------------------------------------------------------------------------
// UC-FO-006 — stock bar, kg formatter, increment ceiling

test.describe('UC-FO-006 — stock-limit bar & the `+` ceiling', () => {
  let cycle = null
  let limited = null
  let scarce = null
  let unlimited = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Stock')
    limited = await addProduct(cycle.id, {
      name: `Limit Petkilo ${uniq}`, purpose: 'Espresso',
      price_250g: 9.04, price_1kg: 35.7, stock_limit_g: 5000,
    })
    scarce = await addProduct(cycle.id, {
      name: `Limit Kilo ${uniq}`, purpose: 'Espresso',
      price_250g: 5, stock_limit_g: 1000,
    })
    unlimited = await addProduct(cycle.id, {
      name: `Bez Limitu ${uniq}`, purpose: 'Espresso', price_250g: 5,
    })
    // Another friend eats 3750 g of the 5 kg product and 750 g of the 1 kg one, so
    // the host arrives at 1250 g and 250 g remaining respectively.
    await consume(cycle.id, [
      { product_id: limited.id, variant: '250g', quantity: 15 },
      { product_id: scarce.id, variant: '250g', quantity: 3 },
    ])
  })

  test('a 5000 g limit with 1250 g left: a 75%-full magenta bar and mono "Zostáva 1.25 kg z 5 kg"', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, limited.name)
    const label = card.getByTestId('stock-label')
    await expect(label).toHaveText('Zostáva 1.25 kg z 5 kg')

    const style = await label.evaluate((el) => ({
      ff: getComputedStyle(el).fontFamily,
      color: getComputedStyle(el).color,
    }))
    expect(style.ff, 'mono').toContain('Courier Prime')
    expect(style.color, 'warn amber, not danger').toBe('rgb(138, 90, 0)')

    // 75% of the TRACK, and always accent magenta — the sold-out signal is the
    // label, never a bar colour. The declared percentage is asserted exactly (that
    // is the computed value); the RENDERED ratio only within half a percent, since
    // a 10px-tall track on a fractional CSS pixel grid cannot be exact.
    const fill = await card.getByTestId('stock-fill').evaluate((el) => {
      const track = el.parentElement
      return {
        declared: el.style.width,
        ratio: (el.getBoundingClientRect().width / track.clientWidth) * 100,
        bg: getComputedStyle(el).backgroundColor,
        trackBorder: getComputedStyle(track).borderTopWidth,
        trackH: Math.round(track.getBoundingClientRect().height),
      }
    })
    expect(fill.declared, '(5000 − 1250) / 5000').toBe('75%')
    expect(fill.ratio, 'and it is genuinely painted that wide').toBeCloseTo(75, 0)
    expect(fill.bg).toBe('rgb(255, 45, 135)')
    expect(fill.trackBorder).toBe('2px')
    expect(fill.trackH).toBe(10)

    // A product without a stock limit gets no bar at all.
    await expect(cardFor(page, unlimited.name).getByTestId('stock-bar')).toHaveCount(0)
  })

  test('the bar is CART-AWARE: adding and removing a bag moves it live, before anything is saved', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const card = cardFor(page, limited.name)
    const label = card.getByTestId('stock-label')
    // The declared width — `stockPct()`'s own output, free of sub-pixel rounding.
    const pct = () => card.getByTestId('stock-fill').evaluate((el) => el.style.width)

    await expect(label).toHaveText('Zostáva 1.25 kg z 5 kg')

    // +1 × 250 g ⇒ 1000 g left. The kg formatter's "strip the trailing zeros" case.
    await card.locator('.vbox').first().getByRole('button', { name: 'viac' }).click()
    await expect(label).toHaveText('Zostáva 1 kg z 5 kg')
    expect(await pct()).toBe('80%')

    // +1 × 1 kg ⇒ 0 g left ⇒ the danger-red "Vypredané" LABEL, full magenta bar.
    await card.locator('.vbox').nth(1).getByRole('button', { name: 'viac' }).click()
    await expect(label).toHaveText('Vypredané')
    expect(await label.evaluate((el) => getComputedStyle(el).color), 'danger red').toBe('rgb(209, 26, 91)')
    expect(await pct()).toBe('100%')

    // Emptying the variants restores bar and label live.
    await card.locator('.vbox').nth(1).getByRole('button', { name: 'menej' }).click()
    await expect(label).toHaveText('Zostáva 1 kg z 5 kg')
    await card.locator('.vbox').first().getByRole('button', { name: 'menej' }).click()
    await expect(label).toHaveText('Zostáva 1.25 kg z 5 kg')
    expect(await pct()).toBe('75%')
  })

  test('the kg formatter: 250 → "0.25 kg", 1000 → "1 kg", 1250 → "1.25 kg"', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // 250 g remaining out of a 1000 g limit — both edge cases in one string.
    await expect(cardFor(page, scarce.name).getByTestId('stock-label'))
      .toHaveText('Zostáva 0.25 kg z 1 kg')
    // 1250 g out of 5000 g.
    await expect(cardFor(page, limited.name).getByTestId('stock-label'))
      .toHaveText('Zostáva 1.25 kg z 5 kg')
  })

  test('⚠ `+` past `remaining_g` is SILENTLY refused — disabled for AT, and still refused when the click is forced', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const card = cardFor(page, scarce.name)
    const box = card.locator('.vbox').first()
    const plus = box.getByRole('button', { name: 'viac' })
    const val = box.locator('.stepper .val')

    // 250 g left ⇒ exactly one more bag is buyable.
    await expect(plus).toBeEnabled()
    await plus.click()
    await expect(val).toHaveText('1')
    await expect(card.getByTestId('stock-label')).toHaveText('Vypredané')

    // (C) half one: the ceiling reaches assistive tech — the shipped view had a
    // real `:disabled` here and dropping it would have been a regression.
    await expect(plus, 'the stepper is at the stock ceiling').toBeDisabled()

    // (C) half two: the refusal survives a click that bypasses Playwright's
    // actionability checks AND the disabled attribute.
    //
    // ⚠ WHAT THIS DOES *NOT* PROVE. `NeoStepper.inc()` returns early on
    // `incDisabled`, so this dispatch stops inside the primitive: no emit, and
    // therefore `onQty` → `increment()` → `canIncrement()` is never entered. This
    // assertion would still pass if `@update:model-value` bound `setQuantity`
    // directly. Together with the `toBeDisabled()` above it pins `incDisabled` and
    // the silence (no growth, no banner) — not the view-side re-check.
    //
    // And no test here can pin that re-check: `incDisabled` and `canIncrement` read
    // the same reactive state in the same tick, so there is no e2e-reachable state
    // where the button is enabled and the increment would still exceed the limit
    // (`isLocked` is the same story via `disabled`), and the stepper only ever emits
    // ±1, so `onQty`'s clamp is unreachable too. The double-guard stays because the
    // reachability depends entirely on `incDisabled` being bound — see the ⚠ in
    // `FriendOrder.vue` and the CLAUDE.md note aimed at RD-FO-3's cartbar steppers.
    await plus.dispatchEvent('click')
    await expect(val, 'silently refused — no growth').toHaveText('1')

    // Silently: no error banner, no toast, nothing appears on screen.
    await expect(page.locator('.app .banner.danger')).toHaveCount(0)

    // And it lifts the moment the friend frees the grams again.
    await box.getByRole('button', { name: 'menej' }).click()
    await expect(val).toHaveText('0')
    await expect(plus).toBeEnabled()
  })
})

// ---------------------------------------------------------------------------
// UC-FO-007 — the bakery branch

test.describe('UC-FO-007 — bakery card', () => {
  let cycle = null

  test.beforeAll(async () => {
    const multi = await admin('/api/bakery-products', {
      method: 'post',
      data: {
        name: `Sunkovo-syrova bageta ${uniq}`,
        category: 'slané',
        subtitle: 'cerstva',
        description: 'Pecena v den rozvozu.',
        composition: 'psenicna muka, voda, sol, drozdie, sunka, syr',
        variants: [
          { label: '1 ks', weight_grams: 190, price: 3.2 },
          { label: '3 ks', weight_grams: 570, price: 8.9 },
        ],
      },
    })
    expect(multi.status(), 'bakery product create').toBe(201)

    // Legacy shape: no `variants` array and no label ⇒ ONE snapshot row with a NULL
    // `variant_label`, which is what the `"1 ks"` fallback exists for.
    const legacy = await admin('/api/bakery-products', {
      method: 'post',
      data: { name: `Stara Buchta ${uniq}`, category: 'slané', price: 2.5 },
    })
    expect(legacy.status(), 'legacy bakery product create').toBe(201)

    const name = `E2E RDFO2 Pekaren ${uniq}`
    const res = await admin('/api/cycles', {
      method: 'post',
      data: {
        name, type: 'bakery', status: 'open',
        bakery_product_ids: [(await multi.json()).id, (await legacy.json()).id],
      },
    })
    expect(res.status(), 'bakery cycle create').toBe(201)
    cycle = { ...(await res.json()), name }
  })

  test('one card per bakery product, `variant_label` boxes, the "1 ks" fallback and the Zloženie fold', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    // ⚠ GROUPING: two variants of one product are ONE card, not two — the
    // CLAUDE.md 2026-04-19 `source_bakery_product_id` contract.
    await expect(page.getByTestId('product-card')).toHaveCount(2)

    const card = cardFor(page, `Sunkovo-syrova bageta ${uniq}`)
    await expect(card.locator('.vbox')).toHaveCount(2)
    expect(await card.locator('.vsize').allTextContents()).toEqual(['1 ks', '3 ks'])
    expect(await card.locator('.vprice').allTextContents()).toEqual(['3.20 EUR', '8.90 EUR'])

    // Card-level weight = the FIRST variant row's, mono, right-aligned at baseline.
    const weight = card.locator('.mono.sub')
    await expect(weight).toHaveText('190 g')
    expect(await weight.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Courier Prime')

    // Subtitle next to the name, description below it.
    await expect(card.getByText('cerstva', { exact: true })).toBeVisible()
    await expect(card.getByText('Pecena v den rozvozu.', { exact: true })).toBeVisible()

    // The composition sits behind a <details> fold and is hidden until opened.
    const fold = card.locator('details')
    await expect(fold).toHaveCount(1)
    const body = card.getByText('psenicna muka, voda, sol, drozdie, sunka, syr')
    await expect(body).toBeHidden()
    await card.getByText('Zloženie', { exact: true }).click()
    await expect(body).toBeVisible()

    // No image column and no stock bar on a bakery card (conflicts #8 / no
    // availability rows). `.pimg` is retired app-wide (2026-08-20), so the live
    // half of this pin is the `img` count.
    await expect(card.locator('.pimg, img')).toHaveCount(0)
    await expect(card.getByTestId('stock-bar')).toHaveCount(0)

    // The legacy product: a NULL `variant_label` renders the "1 ks" fallback, and
    // with no composition there is no fold at all.
    const old = cardFor(page, `Stara Buchta ${uniq}`)
    await expect(old.locator('.vbox')).toHaveCount(1)
    await expect(old.locator('.vsize')).toHaveText('1 ks')
    await expect(old.locator('details')).toHaveCount(0)
  })

  test('selection is PER VBOX — two variants of one product select independently', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const card = cardFor(page, `Sunkovo-syrova bageta ${uniq}`)
    const one = card.locator('.vbox').nth(0)
    const three = card.locator('.vbox').nth(1)

    await one.getByRole('button', { name: 'viac' }).click()
    await expect(one).toHaveClass(/\bsel\b/)
    await expect(three, 'the repo used to ring the WHOLE card').not.toHaveClass(/\bsel\b/)

    await three.getByRole('button', { name: 'viac' }).click()
    await expect(one).toHaveClass(/\bsel\b/)
    await expect(three).toHaveClass(/\bsel\b/)

    // Both lines reach the cart under the `'unit'` variant key: 3.20 + 8.90.
    await expect(page.getByText('Celkom: 12.10 EUR')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// NeoStepper — 02 §UC-DS-014 item 6's deferred obligation

test.describe('NeoStepper smoke (02 §UC-DS-008)', () => {
  let cycle = null
  let product = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Stepper')
    product = await addProduct(cycle.id, {
      name: `Stepper Kava ${uniq}`, purpose: 'Espresso', price_250g: 7.5,
    })
  })

  test('v-model round-trips, and the value reaches the cart total', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)
    await fontsReady(page)

    const box = cardFor(page, product.name).locator('.vbox').first()
    const val = box.locator('.stepper .val')
    const plus = box.getByRole('button', { name: 'viac' })
    const minus = box.getByRole('button', { name: 'menej' })

    await expect(val).toHaveText('0')
    // The glyphs are U+2212 MINUS SIGN and "+", and both buttons are labelled in
    // Slovak — which is why an accessible-name lookup for '-' cannot find them.
    expect(await minus.textContent()).toBe('−')
    expect(await plus.textContent()).toBe('+')
    expect(await val.evaluate((el) => getComputedStyle(el).fontFamily), 'display face').toContain('Darker Grotesque')
    expect(await val.evaluate((el) => getComputedStyle(el).fontSize)).toBe('20px')
    // 38×38 hit targets (02 §UC-DS-008 — from CSS, not overridden here).
    const size = await plus.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [Math.round(r.width), Math.round(r.height)]
    })
    expect(size).toEqual([38, 38])

    await plus.click()
    await plus.click()
    await plus.click()
    await expect(val).toHaveText('3')
    await expect(page.getByText('Celkom: 22.50 EUR')).toBeVisible()

    await minus.click()
    await expect(val).toHaveText('2')
    await expect(page.getByText('Celkom: 15.00 EUR')).toBeVisible()
  })

  test('the `min` floor: "−" at 0 cannot go negative, and does not dirty the cart', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const box = cardFor(page, product.name).locator('.vbox').first()
    const val = box.locator('.stepper .val')
    const minus = box.getByRole('button', { name: 'menej' })

    await expect(val).toHaveText('0')
    await minus.click()
    await minus.click()
    await expect(val, 'floored at min = 0').toHaveText('0')
    await expect(page.locator('.cartbar details summary')).toHaveText('Zobraziť položky v košíku (0 položiek)')

    // ⚠ A no-op tap must not emit: the emit is what the view hangs auto-save and
    // the unsaved-changes guard off, so an emit at `min` would make an empty cart
    // "dirty" and pop the leave-confirmation modal on the way out.
    await expect(box, 'and it never became selected').not.toHaveClass(/\bsel\b/)
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page, 'no leave-confirmation stood in the way').toHaveURL(/\/$/)
  })

  test('a locked cycle disables the whole stepper', async ({ page }) => {
    const locked = await makeCycle('StepperLock')
    const p = await addProduct(locked.id, { name: `Locked Kava ${uniq}`, purpose: 'Espresso', price_250g: 7.5 })
    expect((await admin(`/api/cycles/${locked.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)

    await page.setViewportSize({ width: 378, height: 900 })
    await signIn(page)
    await gotoCycle(page, locked)

    const stepper = cardFor(page, p.name).locator('.stepper').first()
    await expect(stepper).toHaveClass(/\bdisabled\b/)
    await expect(stepper.getByRole('button', { name: 'viac' })).toBeDisabled()
    await expect(stepper.getByRole('button', { name: 'menej' })).toBeDisabled()
  })
})
