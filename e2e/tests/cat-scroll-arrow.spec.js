import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// The `.cat-tabs` horizontal-scroll affordance (`components/CatScrollArrow.vue`).
//
// A cycle with more purposes than fit scrolls sideways, and the theme's only
// signal was `.cat-tabs::after` — a 28px `transparent → --bg` fade that reads as
// a soft edge, not as "there is more to the right". The arrow both signals the
// overflow and performs the scroll.
//
// What this file pins, and why each one is a SILENT regression without it:
//
// (A) "ABSENT WHEN THE STRIP FITS" IS THE EASIEST ASSERTION TO WRITE VACUOUSLY.
//     `toBeHidden()` passes just as happily against a strip that never rendered,
//     a purpose list of one, or a component that failed to mount. So the fitting
//     case first proves the strip IS on screen, HAS two tabs, and genuinely does
//     NOT overflow — and only then that the arrow is hidden.
//
// (B) THE ARROW MUST ADD NOTHING TO `scrollWidth`.
//     It is a flex item, so its 36px plus one more 8px `gap` would inflate the
//     strip's scrollable content by 44px — enough to make a strip whose tabs
//     comfortably fit report an overflow, and enough to move `scrollWidth` as the
//     arrow appears and disappears at the right end. A `margin-left` cancels both
//     terms; nothing about the rendered page looks wrong when that cancel is lost,
//     so it is measured directly (same strip, class toggled off, same number).
//
// (C) THE FADE PAINTS AFTER IT.
//     `.cat-tabs::after` is generated content — last in paint order — and is
//     itself `position:sticky`, so with `z-index:auto` on the arrow the gradient
//     washes straight over the control. That is a pure appearance bug: every
//     behavioural assertion here still passes. Pinned by SAMPLING THE RENDERED
//     PIXEL, not by reading a computed z-index back.
//
// (D) IT IS DELIBERATELY NOT IN THE ACCESSIBILITY TREE.
//     `.cat-tabs` is a `role="tablist"` whose children are `role="tab"`; a
//     focusable control there breaks the ARIA contract and inflates the count
//     `mobile-no-h-overflow.spec.js` asserts on. The arrow is a redundant,
//     pointer-only duplicate of scrolling, so it is `aria-hidden` + `tabindex=-1`
//     (the appbar's profile pencil precedent).
//
// (E) BOTH STRIPS, ONE CONTROL.
//     `views/FriendOrder.vue` and `components/GuestProductGrid.vue` render the
//     same strip; the guest grid additionally serves the status/edit screen. The
//     guest half is exercised end to end so the two cannot drift apart.
//
// Hermetic: its own admin session, its own friend, its own cycles and products.

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// Six purposes overflow a 378px phone strip comfortably; the first three are the
// shipped priority prefix, so the rendered order is predictable.
const MANY_PURPOSES = ['Espresso', 'Filter', 'Kapsule', 'Filter Special', 'Brew Bags', 'Nespresso']
// Two short ones fit with room to spare — the strip still renders (one purpose
// renders no strip at all), so this is the real "fits" case, not "no strip".
const FEW_PURPOSES = ['Espresso', 'Filter']

let many = null
let few = null
let manyLink = null
let fewLink = null

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

async function makeCycle(label) {
  const name = `E2E CATARROW ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type: 'coffee', status: 'open', markup_ratio: 1.2 },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, purpose) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId,
      name: `Guatemala ${purpose} ${uniq}`,
      purpose,
      roast_type: 'Medium roast',
      roastery: 'Goriffee',
      price_250g: 9.04,
      price_1kg: 35.7,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLink(cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth, timeout: TIMEOUT })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `catarrow_${uniq}`.slice(0, 30)
  const name = `CatArrow Hostitel ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  // An admin reset raises must_change_password; clear it so the portal is not
  // gated by the forced-change modal on the way to the order page.
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  host = { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }

  many = await makeCycle('Many')
  for (const purpose of MANY_PURPOSES) await addProduct(many.id, purpose)
  few = await makeCycle('Few')
  for (const purpose of FEW_PURPOSES) await addProduct(few.id, purpose)

  manyLink = await shareLink(many.id)
  fewLink = await shareLink(few.id)
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
// session — `FriendOrder.vue` delegates the restore to `FriendPortal`. Entering
// through the portal is how a real friend gets here.
async function gotoCycle(page, cycle, width = 378) {
  await page.setViewportSize({ width, height: 844 })
  await signIn(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
  await expect(page.locator('.app .appbar')).toBeVisible()
  await fontsReady(page)
}

async function gotoGuest(page, link, width = 378) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`/g/${link.token}`)
  await expect(page.locator('.app .card.hl')).toBeVisible({ timeout: TIMEOUT })
  await fontsReady(page)
}

/** Tab widths — and therefore whether the strip overflows at all — are FONT-METRIC
 *  driven, and Figtree downloads asynchronously. Every measurement here waits for
 *  the real faces, exactly as `order-shell.spec.js` does. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
  // The arrow re-measures on `document.fonts.ready`; give that microtask a turn.
  await page.waitForTimeout(120)
}

const stripMetrics = (page) => page.getByTestId('purpose-tabs').evaluate((el) => ({
  scrollWidth: el.scrollWidth,
  clientWidth: el.clientWidth,
  scrollLeft: el.scrollLeft,
}))

// ---------------------------------------------------------------------------
// The friend strip

test.describe('cat-tabs scroll arrow — the friend strip', () => {
  test('⚠ a strip that FITS gets no arrow — and the strip is really there, with two tabs, really not overflowing', async ({ page }) => {
    await gotoCycle(page, few)

    // NON-VACUITY, in three steps. `toBeHidden()` on the arrow would also pass
    // against a page with no strip, one purpose, or a component that never
    // mounted — none of which is what this test claims.
    const strip = page.getByTestId('purpose-tabs')
    await expect(strip, 'the strip renders at all (two purposes ⇒ it must)').toBeVisible()
    await expect(strip.getByRole('tab')).toHaveCount(FEW_PURPOSES.length)
    const m = await stripMetrics(page)
    expect(m.scrollWidth, 'the two short tabs genuinely fit — nothing to scroll to').toBe(m.clientWidth)

    // …and only now: no affordance, because there is nothing to afford.
    await expect(page.getByTestId('cat-scroll-arrow')).toBeHidden()
  })

  test('a strip that OVERFLOWS gets the arrow, pinned to its right edge above the fade', async ({ page }) => {
    await gotoCycle(page, many)

    const strip = page.getByTestId('purpose-tabs')
    const m = await stripMetrics(page)
    expect(m.scrollWidth, 'the six purposes must actually overflow 378px').toBeGreaterThan(m.clientWidth)

    const arrow = page.getByTestId('cat-scroll-arrow')
    await expect(arrow).toBeVisible()
    await expect(arrow).toHaveCSS('position', 'sticky')

    // Pinned to the STRIP's right edge — not the page's, and not floating in the
    // scrolled content. `right: 4px` leaves the 3px hard shadow inside the
    // scroller's clip instead of having it sliced off.
    const [sb, ab] = [await strip.boundingBox(), await arrow.boundingBox()]
    expect(Math.round(sb.x + sb.width - (ab.x + ab.width)), 'flush to the strip\'s right edge').toBe(4)
    // Vertically centred on the tab row rather than stretched down it.
    expect(Math.abs((ab.y + ab.height / 2) - (sb.y + sb.height / 2)), 'centred on the row').toBeLessThanOrEqual(2)
  })

  test('⚠ the arrow contributes NOTHING to the strip\'s scrollWidth', async ({ page }) => {
    await gotoCycle(page, many)
    await expect(page.getByTestId('cat-scroll-arrow')).toBeVisible()

    // Same strip, same layout, the arrow's `on` class toggled off and back. If the
    // negative margin ever stops cancelling the 36px box plus the 8px flex gap,
    // these two numbers diverge by exactly that much — and a strip whose tabs FIT
    // would start claiming an overflow and rendering an arrow that scrolls nowhere.
    const delta = await page.getByTestId('purpose-tabs').evaluate((el) => {
      const arrow = el.querySelector('[data-testid="cat-scroll-arrow"]')
      const withArrow = el.scrollWidth
      arrow.classList.remove('on')
      const withoutArrow = el.scrollWidth
      arrow.classList.add('on')
      return withArrow - withoutArrow
    })
    expect(delta, 'showing the arrow must not widen the scrollable content').toBe(0)
  })

  test('clicking it scrolls the strip right, and it withdraws at the right end — then comes back', async ({ page }) => {
    await gotoCycle(page, many)

    const strip = page.getByTestId('purpose-tabs')
    const arrow = page.getByTestId('cat-scroll-arrow')
    await expect(arrow).toBeVisible()
    expect((await stripMetrics(page)).scrollLeft).toBe(0)

    await arrow.click()
    await page.waitForTimeout(700) // `behavior: 'smooth'`
    const after = await stripMetrics(page)
    // Roughly one strip-width, deliberately a little less so the previous edge tab
    // stays on screen as an anchor. `scroll-snap-type: x proximity` then settles it
    // on a tab edge, which is the intended behaviour and is not fought — hence a
    // band rather than an exact offset.
    expect(after.scrollLeft, 'it scrolled right').toBeGreaterThan(after.clientWidth * 0.4)
    expect(after.scrollLeft, 'by roughly one strip-width, not to the end in one jump')
      .toBeLessThan(after.clientWidth * 1.2)

    // Park it at the far right: nothing left to reveal, so the affordance withdraws
    // rather than lying about the content.
    await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth - el.clientWidth })
    await expect(arrow, 'no arrow at the right end').toBeHidden()

    // …and it is not a one-way trip.
    await strip.evaluate((el) => { el.scrollLeft = 0 })
    await expect(arrow, 'scrolling back brings it back').toBeVisible()
  })

  test('it is pointer-only: aria-hidden, out of the tab order, and NOT one of the tabs', async ({ page }) => {
    await gotoCycle(page, many)

    const strip = page.getByTestId('purpose-tabs')
    const arrow = page.getByTestId('cat-scroll-arrow')
    await expect(arrow).toBeVisible()

    await expect(arrow).toHaveAttribute('aria-hidden', 'true')
    await expect(arrow).toHaveAttribute('tabindex', '-1')
    // `.cat-tabs` is a tablist; a button is not a valid child of one, and
    // `mobile-no-h-overflow.spec.js` counts exactly this.
    await expect(strip.getByRole('tab'), 'the arrow is not a tab').toHaveCount(MANY_PURPOSES.length)
    expect(await arrow.getAttribute('role'), 'no role at all').toBeNull()
    // Nothing is lost: every category is still reachable by keyboard through the
    // tabs themselves, which are focusable and scroll into view when focused.
    await strip.getByRole('tab').nth(5).focus()
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(MANY_PURPOSES[5])
  })

  test('⚠ it paints ABOVE the 28px fade — sampled from the rendered pixel, not from a computed z-index', async ({ page }) => {
    await gotoCycle(page, many)
    const arrow = page.getByTestId('cat-scroll-arrow')
    await expect(arrow).toBeVisible()

    const sample = await samplePixel(page, arrow)
    // The arrow's fill is `--accent` #ff2d87. It sits over the last ~11px of the
    // 28px `transparent → --bg (#fff8f3)` gradient, i.e. roughly 60% opaque there,
    // so a fade painting on top would drag green from 45 to about 170. The green
    // channel is the whole discriminator: both colours are red-heavy.
    const seen = `sampled rgb(${sample.r}, ${sample.g}, ${sample.b})`
    expect(sample.r, `accent is red-heavy — ${seen}`).toBeGreaterThan(200)
    expect(
      sample.g,
      `and green-poor; a fade painting on top pushes this past 150 — ${seen}`
    ).toBeLessThan(110)
  })

  test('at 320px: the arrow is there, the strip scrolls inside itself, the document does not', async ({ page }) => {
    await gotoCycle(page, many, 320)

    await expect(page.getByTestId('cat-scroll-arrow'), 'the narrowest phone is exactly where the affordance matters').toBeVisible()

    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(
      doc.scrollWidth,
      `the document must not scroll sideways (overflow ${doc.scrollWidth - doc.clientWidth}px)`
    ).toBe(doc.clientWidth)

    const m = await stripMetrics(page)
    expect(m.scrollWidth, 'the strip is what scrolls, and the arrow rides inside it').toBeGreaterThan(m.clientWidth)
  })
})

// ---------------------------------------------------------------------------
// The guest strip — the same component, the second call site

test.describe('cat-tabs scroll arrow — the guest strip', () => {
  test('a fitting guest strip gets no arrow, an overflowing one does — and it scrolls', async ({ page }) => {
    await gotoGuest(page, fewLink)
    const stripFew = page.getByTestId('purpose-tabs')
    await expect(stripFew).toBeVisible()
    await expect(stripFew.getByRole('tab')).toHaveCount(FEW_PURPOSES.length)
    const mFew = await stripMetrics(page)
    expect(mFew.scrollWidth, 'the guest fixture genuinely fits').toBe(mFew.clientWidth)
    await expect(page.getByTestId('cat-scroll-arrow')).toBeHidden()

    await gotoGuest(page, manyLink)
    const arrow = page.getByTestId('cat-scroll-arrow')
    await expect(arrow).toBeVisible()
    await expect(page.getByTestId('purpose-tabs').getByRole('tab'), 'still not a tab here either')
      .toHaveCount(MANY_PURPOSES.length)
    await expect(arrow).toHaveAttribute('aria-hidden', 'true')

    expect((await stripMetrics(page)).scrollLeft).toBe(0)
    await arrow.click()
    await page.waitForTimeout(700)
    expect((await stripMetrics(page)).scrollLeft, 'the guest strip scrolls on the same terms').toBeGreaterThan(0)
  })

  test('⚠ the sticky census with the arrow SHOWING — the strip, the arrow, the cartbar', async ({ page }) => {
    await gotoGuest(page, manyLink)
    await expect(page.getByTestId('cat-scroll-arrow')).toBeVisible()

    // `guest-order-shell.spec.js` pins "exactly two sticky elements, one per page
    // edge" — and stays honest, because its own fixture has two purposes that FIT,
    // and a hidden arrow is `display:none` AND `position:static`, so it is not
    // sticky at all. THIS is the case that spec cannot see: with the strip actually
    // overflowing there is a third sticky element. It is pinned here, by name and
    // exactly, because it is NOT page-edge chrome — it rides the strip's own right
    // edge, inside the horizontal scroller, which is the same technique the theme's
    // `.cat-tabs::after` fade already uses.
    const stickies = await page.evaluate(() => [...document.querySelectorAll('.app *')]
      .filter((e) => getComputedStyle(e).position === 'sticky')
      .map((e) => e.className))
    expect(stickies, 'the top strip, the arrow riding its right edge, the bottom cartbar')
      .toEqual(['cat-tabs', 'catarrow on', 'cartbar'])
  })
})

/**
 * Reads back an actually-rendered pixel from inside `locator`.
 *
 * Playwright hands screenshots to Node as a PNG buffer, so the decode happens in
 * the page: the buffer goes back in as a `data:` URL (origin-clean, so the canvas
 * is not tainted), is drawn to a canvas, and `getImageData` returns the truth
 * about what was painted. A computed-style read could not answer this question at
 * all — the thing possibly covering the arrow is a PSEUDO-element, which is not in
 * the DOM and cannot be located, hit-tested or measured.
 *
 * Samples a 3×3 average at 80% of the way across the box: clear of the 3px border,
 * clear of the centred chevron glyph, and in the part of the control the fade is
 * most opaque over. Averaging keeps antialiasing from deciding the result.
 */
async function samplePixel(page, locator) {
  const box = await locator.boundingBox()
  const png = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  })
  return page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const g2d = canvas.getContext('2d')
    g2d.drawImage(img, 0, 0)
    const sx = Math.round(img.width * 0.8)
    const sy = Math.round(img.height * 0.5)
    const px = g2d.getImageData(sx - 1, sy - 1, 3, 3).data
    let r = 0, g = 0, b = 0
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2] }
    const n = px.length / 4
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
  }, png.toString('base64'))
}
