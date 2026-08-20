import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// The product-photo LIGHTBOX (product decision 2026-08-20).
//
// The card renders the photo at 58px (frameless/uncropped since earlier the same
// day), which cannot show the text printed on a coffee bag. Tapping it opens the
// full photo in a dialog. One shared component — `components/ProductImageModal.vue`
// on the `NeoModal` shell — with TWO call sites: `views/FriendOrder.vue` and
// `components/GuestProductGrid.vue` (which itself serves `/g/:token` and the
// status/edit screen). 06 §UC-GX-002 keeps the two cards identical, so the guest
// half is asserted here too rather than assumed.
//
// ⚠ What only a measurement catches, and why each assertion exists:
//   1. THE MODAL IS ON THE NeoModal SHELL, not a hand-rolled overlay. A
//      `position:fixed` overlay that is a direct child of `.app` silently computes
//      `position:relative` (the `.app > *` rule at equal specificity — a
//      documented, SILENT failure that no build error and no text assertion sees),
//      and the order screen IS an `.app` scope. Pinned as: the dialog is teleported
//      OUT of `.app`, `.modal-layer` really computes `fixed`, and the body scroll
//      is locked while it is open.
//   2. IT IS ACTUALLY BIGGER — the whole point of the row. A relation against the
//      thumbnail, not a constant, so it survives a column-width change.
//   3. IT IS NOT DISTORTED, AND NOT LETTERBOXED. `width:100%` + `height:auto`
//      with NO `max-height` — a cap was measured and removed because it
//      letterboxes a PORTRAIT photo (what a coffee bag usually is) inside a
//      100% × 70vh box, rendering it smaller than the dialog allows. Compared
//      against the fixture's own natural ratio, in portrait as well as landscape.
//   4. IT FITS A 320px PHONE with zero horizontal document overflow (02
//      §UC-DS-005's floor) — the request was explicitly "musí to dobre fungovať na
//      mobile".
//   5. KEYBOARD REACHABILITY. The photo became the only route to the full image,
//      so a pointer-only handler would be a real regression; Enter must open it.

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// 40×30 RGBA PNG, left half opaque magenta, right half fully transparent. The
// non-square ratio is what makes the no-distortion assertion possible at all.
const FIXTURE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAM0lEQVR4nO3OMQ0AAAgEMQyhE9mPAjbGXnJ7Kz35vL4DBAQEBAQEBAQEBAQEBAQEBAS8WsmPUYvRfZB+AAAAAElFTkSuQmCC'
const NATURAL_RATIO = 40 / 30

let ctx = null
let adminToken = ''
let host = null
let cycle = null
let photo = null
let bare = null
let guestToken = ''

const admin = (path, opts = {}) => ctx[opts.method || 'get'](path, {
  headers: { 'X-Admin-Token': adminToken },
  ...(opts.data ? { data: opts.data } : {}),
  timeout: TIMEOUT,
})

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  // --- the friend (host of the guest link too)
  const username = `plb_${uniq}`.slice(0, 30)
  const name = `PLB Host ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)
  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const first = (await auth.json()).token
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || first
  host = { id: row.id, name, token, auth: { Authorization: `Bearer ${token}` } }

  // --- the cycle: one product WITH a photo, one WITHOUT
  const cname = `E2E PLB ${uniq}`
  const c = await admin('/api/cycles', {
    method: 'post', data: { name: cname, type: 'coffee', status: 'open' },
  })
  expect(c.status(), 'cycle create').toBe(201)
  cycle = { ...(await c.json()), name: cname }

  const mk = async (data) => {
    const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycle.id, ...data } })
    expect(res.status(), `product create ${data.name}`).toBe(201)
    return res.json()
  }
  photo = await mk({
    name: `Foto Bag ${uniq}`, purpose: 'Espresso', roast_type: 'Medium roast',
    description1: '100% natural bourbon arabica', price_250g: 8, price_1kg: 28,
    image: FIXTURE_PNG,
  })
  bare = await mk({ name: `Bez Fotky ${uniq}`, purpose: 'Espresso', price_250g: 8 })

  // --- the guest link, for the §UC-GX-002 parity half
  const link = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, {
    headers: host.auth, timeout: TIMEOUT,
  })
  expect(link.status(), 'guest link create').toBe(201)
  guestToken = (await link.json()).link.token
})

test.afterAll(async () => { await ctx?.dispose() })

/** ⚠ A cold deep-link to /cycle/:id bounces to `/` — enter via the portal card. */
async function gotoFriendCycle(page) {
  await page.addInitScript((value) => {
    localStorage.clear()
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({
    friendId: host.id, friendName: host.name, token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  }))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

const cardFor = (page, name) =>
  page.getByTestId('product-card').filter({ has: page.getByRole('heading', { name, exact: true }) })

const thumbOf = (page, name) => cardFor(page, name).locator('img')
const fullPhoto = (page) => page.getByTestId('product-photo-full')

/** Geometry of the thumbnail and the opened full photo, plus the natural size. */
async function photoMetrics(page) {
  return page.evaluate(() => {
    const full = document.querySelector('[data-testid="product-photo-full"]')
    const r = full.getBoundingClientRect()
    return {
      w: r.width,
      h: r.height,
      naturalW: full.naturalWidth,
      naturalH: full.naturalHeight,
      loaded: full.complete && full.naturalWidth > 0,
      maxH: getComputedStyle(full).maxHeight,
    }
  })
}

async function docOverflow(page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('Product photo lightbox — the friend order screen', () => {
  test('tapping the photo opens a dialog titled with the product, showing the full image', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoFriendCycle(page)

    // Nothing is open before the tap — otherwise every assertion below is vacuous.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(fullPhoto(page)).toHaveCount(0)

    const thumb = thumbOf(page, photo.name)
    await expect(thumb).toBeVisible()
    const thumbBox = await thumb.boundingBox()
    await thumb.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // The dialog names the product — several cards look alike once enlarged.
    await expect(dialog.locator('.m-title')).toHaveText(photo.name)
    await expect(fullPhoto(page)).toBeVisible()

    const m = await photoMetrics(page)
    expect(m.loaded, 'the full photo actually decoded').toBe(true)

    // (2) MUCH bigger than the thumbnail. A relation, not a constant.
    expect(m.w, `full ${m.w}px vs thumb ${thumbBox.width}px — not meaningfully enlarged`)
      .toBeGreaterThan(thumbBox.width * 4)

    // (3) NOT distorted and NOT letterboxed. With `height:auto` the element box
    // IS the photo, so the box ratio being the natural ratio proves both at once.
    expect(m.w / m.h, 'the aspect ratio is preserved').toBeCloseTo(NATURAL_RATIO, 1)
    expect(m.maxH, 'a max-height cap would letterbox a portrait photo — see the component')
      .toBe('none')

    // (4) …and it stays inside the viewport.
    expect(m.w, 'the photo must not exceed the viewport width').toBeLessThanOrEqual(390)
    expect(await docOverflow(page), 'document scrolls sideways with the lightbox open')
      .toBeLessThanOrEqual(0)
  })

  // (1) The guard against somebody rebuilding this as a hand-rolled overlay: on
  // this screen that silently loses `position:fixed` to the `.app > *` rule.
  test('⚠ it is on the NeoModal shell — teleported out of `.app`, really fixed, body locked', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoFriendCycle(page)

    const bodyOverflowBefore = await page.evaluate(() => getComputedStyle(document.body).overflow)
    await thumbOf(page, photo.name).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const shell = await page.evaluate(() => {
      const layer = document.querySelector('.modal-layer')
      const dialog = document.querySelector('[role="dialog"]')
      return {
        hasLayer: !!layer,
        layerPosition: layer ? getComputedStyle(layer).position : null,
        layerZ: layer ? getComputedStyle(layer).zIndex : null,
        insideApp: !!dialog.closest('.app'),
        bodyOverflow: getComputedStyle(document.body).overflow,
      }
    })
    expect(shell.hasLayer, 'the dialog must render inside `.modal-layer`').toBe(true)
    expect(shell.insideApp, '`.app` descendant ⇒ `.app > *` can neutralise its positioning').toBe(false)
    expect(shell.layerPosition, 'the layer must really compute fixed').toBe('fixed')
    expect(shell.layerZ).toBe('200')
    expect(shell.bodyOverflow, 'the page behind the lightbox must not scroll').toBe('hidden')

    // …and the lock is released, not leaked, when it closes.
    await page.getByRole('button', { name: 'Zavrieť', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow))
      .toBe(bodyOverflowBefore)
  })

  test('(5) the photo is keyboard-operable: it focuses and Enter opens the lightbox', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoFriendCycle(page)

    const thumb = thumbOf(page, photo.name)
    await expect(thumb).toHaveAttribute('role', 'button')
    // The accessible name names the product, so a list of cards is navigable.
    await expect(thumb).toHaveAttribute('aria-label', `Zobraziť fotku: ${photo.name}`)

    await thumb.focus()
    expect(await page.evaluate(() => document.activeElement?.tagName),
      'the photo must be focusable').toBe('IMG')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(fullPhoto(page)).toBeVisible()
  })

  test('every close path works: footer, ×, Escape and a scrim click', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoFriendCycle(page)
    const thumb = thumbOf(page, photo.name)

    for (const [label, close] of [
      ['footer button', async () => page.getByRole('button', { name: 'Zavrieť', exact: true }).click()],
      ['the ×', async () => page.getByRole('button', { name: 'Zatvoriť dialóg' }).click()],
      ['Escape', async () => page.keyboard.press('Escape')],
      // A genuine scrim gesture: mousedown AND mouseup on the scrim itself, which
      // is what NeoModal's origin guard requires (a drag out of the body must not
      // close it — that half is pinned on the shell's own spec).
      ['a scrim click', async () => page.locator('.modal-scrim').click({ position: { x: 5, y: 5 } })],
    ]) {
      await thumb.click()
      await expect(page.getByRole('dialog'), `${label}: precondition — open`).toBeVisible()
      await close()
      await expect(page.getByRole('dialog'), `${label} must close the lightbox`).toHaveCount(0)
      await expect(fullPhoto(page), `${label}: the photo leaves the DOM`).toHaveCount(0)
    }
  })

  test('a product with no photo offers nothing to tap', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoFriendCycle(page)

    const card = cardFor(page, bare.name)
    await expect(card).toBeVisible()
    await expect(card.locator('img'), 'no photo ⇒ no image, so no lightbox trigger').toHaveCount(0)
    await expect(card.getByRole('button', { name: /Zobraziť fotku/ })).toHaveCount(0)
  })

  // (4) The explicit mobile floor, at the narrowest supported width.
  test('320px: the lightbox fits, and the document does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 })
    await gotoFriendCycle(page)

    await thumbOf(page, photo.name).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const m = await photoMetrics(page)
    expect(m.w, 'the photo must fit a 320px viewport').toBeLessThanOrEqual(320)
    expect(m.w / m.h, 'still undistorted at 320px').toBeCloseTo(NATURAL_RATIO, 1)
    // Still a real enlargement at the narrowest width — not merely "it fits".
    expect(m.w, 'and still much bigger than the 58px thumbnail').toBeGreaterThan(58 * 4)
    expect(await docOverflow(page), 'no horizontal overflow at 320px').toBeLessThanOrEqual(0)

    // The close control has to be reachable on a short viewport: `.modal-scrim`
    // is `overflow-y:auto`, so it must be scrollable-to rather than clipped away.
    const foot = page.getByRole('button', { name: 'Zavrieť', exact: true })
    await foot.scrollIntoViewIfNeeded()
    await expect(foot).toBeVisible()
  })

  // ⚠ THE PORTRAIT CASE — a coffee bag usually is one, and it is the case the
  // removed `max-height` cap would have quietly shrunk. It must FILL THE WIDTH
  // (that is the legibility the request is about), keep its ratio, and remain
  // reachable by scrolling the scrim rather than being clipped.
  test('a tall portrait photo fills the width and scrolls, rather than being letterboxed', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await gotoFriendCycle(page)
    await thumbOf(page, photo.name).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const landscapeW = (await photoMetrics(page)).w

    // Swap in a 1:3 portrait source on the OPEN dialog and re-measure: exercises
    // the portrait geometry without seeding a second product.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="product-photo-full"]')
      const c = document.createElement('canvas')
      c.width = 100; c.height = 300
      const g = c.getContext('2d')
      g.fillStyle = '#ff2d87'; g.fillRect(0, 0, 100, 300)
      el.src = c.toDataURL('image/png')
    })
    await expect.poll(async () =>
      (await photoMetrics(page)).naturalH, { timeout: 5000 }).toBe(300)

    const m = await photoMetrics(page)
    // Same rendered width as the landscape photo ⇒ it really fills the dialog and
    // is not fitted into a capped box with dead bands either side.
    expect(m.w, 'a portrait photo fills the same dialog width').toBeCloseTo(landscapeW, 0)
    expect(m.w / m.h, 'the 1:3 ratio is preserved — no stretch, no letterbox')
      .toBeCloseTo(100 / 300, 1)
    // Taller than the viewport is FINE and intended: the scrim scrolls it.
    const scroll = await page.evaluate(() => {
      const s = document.querySelector('.modal-scrim')
      return { canScroll: s.scrollHeight > s.clientHeight + 1, overflowY: getComputedStyle(s).overflowY }
    })
    expect(scroll.overflowY, 'the scrim is the scroller for a tall photo').toBe('auto')
    expect(scroll.canScroll, 'a photo taller than the viewport must be scrollable, not clipped').toBe(true)
    expect(await docOverflow(page), 'no sideways scroll with a portrait photo')
      .toBeLessThanOrEqual(0)
  })
})

// 06 §UC-GX-002 — the guest card is the same card, so it is the same lightbox.
test.describe('Product photo lightbox — the guest surface', () => {
  test('the guest ordering page opens the same lightbox', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/g/${guestToken}`)

    const thumb = page.getByRole('button', { name: `Zobraziť fotku: ${photo.name}` })
    await expect(thumb).toBeVisible()
    const thumbBox = await thumb.boundingBox()
    await thumb.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.m-title')).toHaveText(photo.name)

    const m = await photoMetrics(page)
    expect(m.loaded, 'the guest full photo decoded').toBe(true)
    expect(m.w, 'enlarged on the guest surface too').toBeGreaterThan(thumbBox.width * 4)
    expect(m.w / m.h, 'undistorted on the guest surface').toBeCloseTo(NATURAL_RATIO, 1)
    expect(await docOverflow(page), 'no sideways scroll on the guest page').toBeLessThanOrEqual(0)

    await page.getByRole('button', { name: 'Zavrieť', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
