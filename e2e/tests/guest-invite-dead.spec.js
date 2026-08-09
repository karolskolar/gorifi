import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-GX-4 — the last row of the friends-portal redesign: the invite CTA on the neo
// shell (06 §UC-GX-009), the three dead-link variants and the status-404 card
// (§UC-GX-010), plus the two §UC-GX-011 closeout invariants that are testable
// (the localStorage contract, and admin invariance from the theme's side).
//
// `guest-lead-capture.spec.js` owns the BEHAVIOUR of the CTA (attribution, the
// source tag, the 409, the bounds, the gating asymmetry) and is immutable this row
// apart from the one sanctioned §UC-GX-011 item-1 edit. `guest-order.spec.js` and
// `guest-status.spec.js` own the dead ends' resolution. Everything here is the
// restyle's own contract.
//
// ⚠ WHY GEOMETRY, NOT JUST COPY. The lesson RD-GX-3 paid for: `GuestOrderStatus.vue`
// shipped for two rows rendering the SHARED product grid with every theme class
// resolving to nothing, because the view had no `.app` ancestor and the whole theme
// is `:where(.app,.modal-layer) …`. It was fully functional and fully green. Both
// screens this row touches are children of that same root, and `GuestInviteRequest`
// is a THIRD consumer of it — so the assertions below read borders, shadows and
// backgrounds off `getComputedStyle`, not text.
//
// NOTE ON RATE LIMITS: this spec drives the guest read/write buckets. Run the full
// suite with the budgets in e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const PHONE = { width: 378, height: 900 }
const NARROW = { width: 320, height: 720 }

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

let seq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++seq}`
  const username = `gx4_${slug}`.slice(0, 30 - suffix.length) + suffix
  const name = `Lead ${label} ${uniq}`
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
  return { id: friend.id, name, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label) {
  const name = `E2E GX4 ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type: 'coffee', status: 'open', expected_date: '2026-08-20' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.25 } })).status()).toBe(200)
  return { ...cycle, name }
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

let phoneSeq = 0
const uniquePhone = () => `09${String(Date.now() % 1e7).padStart(7, '0')}`.slice(0, 8) + String(++phoneSeq).padStart(2, '0')

async function submitGuest(linkToken, items, identity) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

/** One cycle, one product, one link, one submitted sub-order. */
async function scenario(label) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label)
  const product = await addProduct(cycle.id, {
    // 'Espresso' is the grid's first purpose, so this is the product the default tab shows.
    name: `GX4 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 8, price_1kg: 28, stock_limit_g: 100000,
  })
  const link = await shareLink(host, cycle.id)
  const guestPhone = uniquePhone()
  const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
    guest_name: `Kolega ${label}`, guest_phone: guestPhone, guest_email: `${label}.${uniq}@example.com`,
  })
  return { host, cycle, product, link, guestPhone, order: created.order }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL })
  const res = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(res.status(), 'admin login').toBe(200)
  adminToken = (await res.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ---------------------------------------------------------------------------
// (A) the invite CTA — §UC-GX-009

test.describe('RD-GX-4 · the invite CTA on the neo shell (§UC-GX-009)', () => {
  test('⚠ the folded card is THEMED — pink `--hi` card, rotated icon tile, display headline', async ({ page }) => {
    const { link, order } = await scenario('ctafold')

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    const cta = page.getByTestId('invite-cta')
    await expect(cta).toBeVisible()

    // §UC-GX-009 item 1, read off the rendered boxes. Before the `.app` root landed
    // one screen over, every one of these resolved to nothing while the page stayed
    // green — which is why none of this is asserted as text.
    const shape = await cta.evaluate((el) => {
      const cs = getComputedStyle(el)
      const tile = el.querySelector('span')
      const tcs = getComputedStyle(tile)
      const head = el.querySelector('.display')
      const hcs = getComputedStyle(head)
      const btn = el.querySelector('[data-testid="invite-cta-open"]')
      const bcs = getComputedStyle(btn)
      return {
        root: el.className,
        bg: cs.backgroundColor,
        border: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
        padding: [cs.paddingTop, cs.paddingLeft],
        // ⚠ `offsetWidth`, not `getBoundingClientRect()`: the tile is ROTATED, and a
        // client rect is the axis-aligned bounding box of the rotated square
        // (36 × (cos3° + sin3°) = 37.83). The border box is what 36×36 means.
        tile: [tile.offsetWidth, tile.offsetHeight],
        tileBorder: tcs.borderTopWidth,
        tileRadius: tcs.borderTopLeftRadius,
        tileTransform: tcs.transform,
        tileGlyph: tile.querySelector('svg') ? [tile.querySelector('svg').getAttribute('width'), tile.querySelector('svg').getAttribute('height')] : null,
        headFont: hcs.fontFamily,
        headSize: hcs.fontSize,
        headTransform: hcs.textTransform,
        headLine: hcs.lineHeight,
        btnH: Math.round(btn.getBoundingClientRect().height),
        btnSize: bcs.fontSize,
        btnBorder: bcs.borderTopWidth,
      }
    })

    expect(shape.root, 'the folded/unfolded state IS a `.card`').toContain('card')
    // `--hi` = #ffd9e7. The shipped CTA was a dashed muted box; the prototype's is pink.
    expect(shape.bg, 'the `--hi` pink card').toBe('rgb(255, 217, 231)')
    expect(shape.border, 'the canon 3px ink border').toBe('3px')
    expect(shape.radius).toBe('14px')
    expect(shape.shadow, 'the canon 5px ink offset shadow').toContain('5px 5px')
    expect(shape.padding, 'prototype `padding:10px 12px`').toEqual(['10px', '12px'])

    expect(shape.tile, 'the 36×36 icon tile').toEqual([36, 36])
    expect(shape.tileBorder).toBe('3px')
    expect(shape.tileRadius).toBe('9px')
    // rotate(-3deg) — a matrix, so it is compared by its cosine/sine rather than by text.
    expect(shape.tileTransform, 'the tile is rotated, not square-on').toMatch(/^matrix\(/)
    expect(shape.tileTransform).not.toBe('none')
    expect(shape.tileGlyph, 'NeoIcon "invite" at its own 17px').toEqual(['17', '17'])

    expect(shape.headFont, 'the display face, not the body face').toMatch(/Anton|Darker/i)
    expect(shape.headSize).toBe('17px')
    expect(shape.headTransform, '`.display` is uppercase by class').toBe('uppercase')
    // .95 × 17 = 16.15 — the prototype's tight headline, NOT A10's `normal`.
    expect(parseFloat(shape.headLine)).toBeCloseTo(16.15, 1)

    expect(shape.btnH, '`btn sm` shrunk to the prototype\'s 34').toBe(34)
    expect(shape.btnSize).toBe('12.5px')
    expect(shape.btnBorder, 'a real neo button, not a text link').toBe('3px')

    // Resolved conflict #2 — the prototype's fold line, uppercased by `.display`.
    // The word this line dropped ("nabudúce") must still exist, one fold deeper.
    await expect(cta).toContainText(/Chcete si objednať sami\?/i)
    await expect(cta).not.toContainText(/nabudúce/i)
    await page.getByTestId('invite-cta-open').click()
    await expect(cta, 'the body still says when the account starts paying off').toContainText(/nabudúce/i)
  })

  test('the unfolded form is the module Field port — `.inp` inputs, `btn sm dark` submit, bounds mirrored', async ({ page }) => {
    const { link, order, guestPhone } = await scenario('ctaform')

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await page.getByTestId('invite-cta-open').click()

    // §UC-GX-009 item 2. `ui/input` + `ui/label` are gone: the neo shell uses a
    // native `label.field-lbl` + `input.inp`, which is the only reason the 3px
    // border and the magenta focus shadow exist at all.
    for (const id of ['invite-name', 'invite-phone', 'invite-email']) {
      const input = page.getByTestId(id)
      await expect(input).toHaveClass(/\binp\b/)
      const border = await input.evaluate((el) => getComputedStyle(el).borderTopWidth)
      expect(border, `${id}: the themed 3px input`).toBe('3px')
    }
    // The GSO-T3 bounds, mirrored so a 200 000-char paste cannot even be typed.
    await expect(page.getByTestId('invite-name')).toHaveAttribute('maxlength', '120')
    await expect(page.getByTestId('invite-phone')).toHaveAttribute('maxlength', '32')
    await expect(page.getByTestId('invite-email')).toHaveAttribute('maxlength', '160')
    await expect(page.getByTestId('invite-email')).toHaveAttribute('placeholder', 'meno@example.com')

    // `btn sm dark` — the ink-filled primary. `--nb-ink` is #0a0a0a.
    const submit = page.getByTestId('invite-submit')
    await expect(submit).toHaveClass(/\bdark\b/)
    expect(await submit.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(10, 10, 10)')

    // ⚠ PREFILL AT OPEN TIME, not at setup: on THIS screen the props arrive with the
    // async load, after the component's first render. Reading them in `setup()` would
    // hand the guest three empty fields and no clue they were meant to be filled.
    await expect(page.getByTestId('invite-name')).toHaveValue('Kolega ctaform')
    await expect(page.getByTestId('invite-phone')).toHaveValue(guestPhone)
    await expect(page.getByTestId('invite-email')).toHaveValue(`ctaform.${uniq}@example.com`)

    // Client validation strings verbatim, rendered in the neo error banner.
    await page.getByTestId('invite-name').fill('   ')
    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-error')).toHaveText('Zadajte meno.')
    expect(await page.locator('.banner.danger.slim').first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('2px')

    await page.getByTestId('invite-name').fill('Kolega Testovaci')
    await page.getByTestId('invite-phone').fill('123')
    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-error')).toHaveText('Zadajte telefónne číslo (aspoň 9 číslic).')

    // Späť folds it back without submitting anything.
    await page.getByRole('button', { name: 'Späť', exact: true }).click()
    await expect(page.getByTestId('invite-cta-open')).toBeVisible()
    await expect(page.getByTestId('invite-submit')).toHaveCount(0)
  })

  test('done and already-requested are BANNERS, and neither offers a retry', async ({ page }) => {
    const { link, order, guestPhone } = await scenario('ctabanner')

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await page.getByTestId('invite-cta-open').click()
    await page.getByTestId('invite-submit').click()

    // §UC-GX-009 item 3 — `.banner.ok.slim` with the dot. `--ok-soft` is the green wash.
    const done = page.getByTestId('invite-cta')
    await expect(page.getByTestId('invite-done')).toBeVisible()
    await expect(done).toHaveClass(/\bbanner\b/)
    await expect(done).toHaveClass(/\bok\b/)
    await expect(done).toHaveClass(/\bslim\b/)
    await expect(done.locator('.dot')).toHaveCount(1)
    await expect(page.getByTestId('invite-done')).toContainText('Žiadosť o účet je odoslaná.')
    await expect(page.getByTestId('invite-done')).toContainText('Správca sa vám ozve.')
    // The first sentence is bolded (prototype), so it is not one flat paragraph.
    await expect(page.getByTestId('invite-done').locator('b')).toHaveText('Žiadosť o účet je odoslaná.')
    await expect(page.getByTestId('invite-cta-open'), 'no second submission on offer').toHaveCount(0)

    // §UC-GX-009 item 4, the state the prototype never designed: a reload learns
    // `invite_request.requested` from the server, and a 409 would produce the same.
    await page.reload()
    const queued = page.getByTestId('invite-cta')
    await expect(page.getByTestId('invite-requested')).toBeVisible()
    await expect(queued).toHaveClass(/\bbanner\b/)
    await expect(queued).toHaveClass(/\bslim\b/)
    await expect(queued, 'neutral accent-soft, not the green success wash').not.toHaveClass(/\bok\b/)
    expect(await queued.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 227, 239)')
    await expect(page.getByTestId('invite-requested')).toHaveText('Žiadosť o účet už evidujeme. Správca sa vám ozve.')
    // ⚠ 409 → the requested state, NEVER a retry invitation (GSO-T10). A form here
    // could only ever be answered with another 409.
    await expect(page.getByTestId('invite-cta-open')).toHaveCount(0)
    await expect(page.getByTestId('invite-submit')).toHaveCount(0)

    // And the lead is real, not just a paint.
    const list = await admin(`/api/invitations?status=pending`)
    expect(list.status()).toBe(200)
    const rows = (await list.json()).filter((r) => r.phone === guestPhone)
    expect(rows.length, 'exactly one pending lead').toBe(1)
    expect(rows[0].source).toBe('guest_order')
  })

  test('the confirmation screen carries the SAME component, folded, below the payment affordances', async ({ page }) => {
    const host = await makeHost('ctaconf')
    const cycle = await makeCycle('ctaconf')
    const product = await addProduct(cycle.id, {
      name: `GX4 ctaconf ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 100000,
    })
    const link = await shareLink(host, cycle.id)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}`)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    await page.getByTestId('guest-name').fill('Marek Potvrdenie')
    await page.getByTestId('guest-phone').fill(uniquePhone())
    await page.getByTestId('guest-submit').click()

    await expect(page.getByTestId('guest-confirmation')).toBeVisible()
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) await dialog.getByRole('button', { name: 'Zavrieť' }).click()

    const cta = page.getByTestId('invite-cta')
    await expect(cta).toBeVisible()
    // ONE component, not a fork: the same pink card renders here.
    await expect(cta).toHaveClass(/\bcard\b/)
    expect(await cta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 217, 231)')

    // ⚠ PLACEMENT is what keeps the louder card from competing with the payment
    // information: the pay button and the status-URL row are both ABOVE it. That is
    // the whole answer to the shipped component's "deliberately low-key" argument.
    const order = await page.evaluate(() => {
      const y = (sel) => {
        const el = document.querySelector(sel)
        return el ? el.getBoundingClientRect().top : null
      }
      return {
        pay: y('[data-testid="guest-confirmation"] .btn.ok'),
        statusUrl: y('[data-testid="guest-status-url"]'),
        cta: y('[data-testid="invite-cta"]'),
      }
    })
    expect(order.pay, 'the pay button exists on this fixture').not.toBeNull()
    expect(order.cta).toBeGreaterThan(order.pay)
    expect(order.cta).toBeGreaterThan(order.statusUrl)
  })

  test('nothing on this component overflows a 320px card', async ({ page }) => {
    const { link, order } = await scenario('ctanarrow')

    await page.setViewportSize(NARROW)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await expect(page.getByTestId('invite-cta')).toBeVisible()
    // The folded row is icon + headline + button on one line at 320px — the headline
    // is the only shrinkable item, which is why it carries `min-width:0`.
    let scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(scroll, 'folded: the page does not scroll sideways').toBeLessThanOrEqual(0)

    await page.getByTestId('invite-cta-open').click()
    await expect(page.getByTestId('invite-submit')).toBeVisible()
    scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(scroll, 'unfolded: the page does not scroll sideways').toBeLessThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// (B) g-dead — §UC-GX-010

test.describe('RD-GX-4 · g-dead, three variants (§UC-GX-010)', () => {
  // Title → the shipped one (unchanged); description → the prototype's, replacing
  // the raw server message the shipped card printed under it.
  const COPY = {
    notfound: {
      title: 'Odkaz neexistuje',
      text: 'Tento odkaz sme nenašli. Skontrolujte, či je skopírovaný celý.',
    },
    inactive: {
      title: 'Odkaz už nie je aktívny',
      text: 'Kolega, ktorý objednávku organizuje, tento odkaz deaktivoval.',
    },
    closed: {
      title: 'Objednávanie je uzavreté',
      text: 'Cyklus sa medzičasom uzamkol — objednávky už neprijímame.',
    },
  }

  // ⚠ ONE LINK PER VARIANT, NOT ONE LINK WALKED THROUGH THREE STATES — a measured
  // constraint, not tidiness. `410 Gone` is cacheable by default and the backend
  // sends no `Cache-Control` on it, so a SECOND `page.goto` of the same `/g/:token`
  // after the server's answer changed is served the FIRST 410 out of Chromium's HTTP
  // cache. Reproduced on this build: deactivate → 410 `inactive`; then reactivate and
  // lock the cycle → a direct fetch answers `closed` while the page still renders
  // "Odkaz už nie je aktívny", with the stale body visible on the response event.
  // Pre-existing and backend-owned (this row touches no backend); recorded here
  // because it is exactly the shape that makes a variant test silently re-assert the
  // previous variant.
  async function deadLink(label, kind) {
    const host = await makeHost(label)
    const cycle = await makeCycle(label)
    await addProduct(cycle.id, { name: `GX4 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 8, stock_limit_g: 100000 })
    const link = await shareLink(host, cycle.id)
    if (kind === 'inactive') {
      // PATCH with no body means `active: 0` (guest-links.js).
      expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status()).toBe(200)
    } else if (kind === 'closed') {
      expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    }
    return link
  }

  test('⚠ each server reason gets its OWN explanation, not the server sentence twice', async ({ page }) => {
    await page.setViewportSize(PHONE)

    // 404 — unknown token.
    await page.goto('/g/THISLINKISNOTREAL')
    const card = page.getByTestId('guest-unavailable')
    await expect(card).toBeVisible()
    await expect(card).toContainText(COPY.notfound.title)
    await expect(card).toContainText(COPY.notfound.text)

    // 410 `inactive` — the host deactivated the link.
    await page.goto(`/g/${(await deadLink('deadoff', 'inactive')).token}`)
    await expect(card).toContainText(COPY.inactive.title)
    await expect(card).toContainText(COPY.inactive.text)
    // ⚠ The old card printed the server's own message here, which for this variant
    // read "Tento odkaz už nie je aktívny. Požiadajte kolegu o nový." — i.e. the
    // title restated, plus a duplicate of the closing line below it.
    await expect(card).not.toContainText('Požiadajte kolegu o nový.')

    // 410 `closed` — a LIVE link on a cycle that locked.
    await page.goto(`/g/${(await deadLink('deadlock', 'closed')).token}`)
    await expect(card).toContainText(COPY.closed.title)
    await expect(card).toContainText(COPY.closed.text)

    // The closing line is on all three, and the ordering surface is on none of them.
    await expect(card).toContainText('Ak ste odkaz dostali od kolegu, požiadajte ho o nový.')
    await expect(page.getByTestId('open-checkout')).toHaveCount(0)
  })

  test('the composition is the prototype dead-card: brand chrome, rotated danger badge, floating card', async ({ page }) => {
    await page.setViewportSize(PHONE)
    await page.goto('/g/STILLNOTREAL')
    await expect(page.getByTestId('guest-unavailable')).toBeVisible()

    const shape = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="guest-unavailable"]')
      const cs = getComputedStyle(card)
      const badge = card.querySelector('.badge')
      const bcs = getComputedStyle(badge)
      const h1 = card.querySelector('.h-screen')
      const zone = card.parentElement
      const zcs = getComputedStyle(zone)
      const r = card.getBoundingClientRect()
      const zr = zone.getBoundingClientRect()
      return {
        border: cs.borderTopWidth,
        shadow: cs.boxShadow,
        maxWidth: cs.maxWidth,
        align: cs.textAlign,
        gap: cs.rowGap,
        padding: cs.paddingTop,
        badgeText: badge.textContent.trim(),
        badgeBg: bcs.backgroundColor,
        badgeSize: bcs.fontSize,
        badgeTransform: bcs.transform,
        badgeGlyph: !!badge.querySelector('svg'),
        // ⚠ ONE LINE, GLYPH CENTRED WITH THE LABEL. The prototype writes
        // `{I.lock()} Slepá ulička` inside a plain `display:inline-block` badge; that
        // markup DOES NOT PORT, because Tailwind preflight declares `svg{display:block}`
        // and the padlock takes a line of its own with the label underneath it.
        // Measured: prototype 148.93 × 41.14 with the glyph +0.22 off the badge
        // centre; the literal port 128.85 × 52.41 at −6.13. Neither `badgeGlyph`
        // above nor any text assertion can see that, so the geometry is read here.
        badgeH: +badge.getBoundingClientRect().height.toFixed(2),
        badgeGlyphOffCentre: +(() => {
          const br = badge.getBoundingClientRect()
          const sr = badge.querySelector('svg').getBoundingClientRect()
          return (sr.top + sr.bottom) / 2 - (br.top + br.bottom) / 2
        })().toFixed(2),
        titleFont: getComputedStyle(h1).fontFamily,
        titleSize: getComputedStyle(h1).fontSize,
        // The card FLOATS: centred on both axes inside a `flex-1` zone, not pinned
        // under the header. `16-shot.png` is the reference.
        zoneDisplay: zcs.display,
        zoneAlign: zcs.alignItems,
        zoneJustify: zcs.justifyContent,
        centredX: Math.abs((r.left - zr.left) - (zr.right - r.right)) < 2,
        centredY: Math.abs((r.top - zr.top) - (zr.bottom - r.bottom)) < 2,
        // The brand chrome the shipped card did NOT have: a guest who mistyped a
        // link used to get an unbranded box on a white page.
        appbar: !!document.querySelector('.appbar'),
        ticker: !!document.querySelector('.ticker'),
        subtitle: document.querySelector('.appbar .titles .s')?.textContent,
        docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })

    expect(shape.border, 'the canon 3px ink border').toBe('3px')
    expect(shape.shadow).toContain('5px 5px')
    expect(shape.maxWidth).toBe('400px')
    expect(shape.align).toBe('center')
    expect(shape.gap).toBe('12px')
    expect(shape.padding, 'phone padding 22px').toBe('22px')

    expect(shape.badgeText).toBe('Slepá ulička')
    expect(shape.badgeGlyph, 'NeoIcon "lock" inside the badge').toBe(true)
    // `--danger-soft` = #ffe0ea.
    expect(shape.badgeBg).toBe('rgb(255, 224, 234)')
    expect(shape.badgeSize).toBe('13px')
    expect(shape.badgeTransform, 'rotated −2°, like the confirmation badge').not.toBe('none')
    // The two-line regression measures 52.41; one line measures 38.15.
    expect(shape.badgeH, 'the padlock and the label share ONE line').toBeLessThan(45)
    expect(Math.abs(shape.badgeGlyphOffCentre), 'the padlock sits on the label\'s line, not above it').toBeLessThan(3)

    expect(shape.titleFont).toMatch(/Anton|Darker/i)
    expect(shape.titleSize, '32px on a phone').toBe('32px')

    expect(shape.zoneDisplay).toBe('flex')
    expect(shape.zoneAlign).toBe('center')
    expect(shape.zoneJustify).toBe('center')
    expect(shape.centredX, 'the card floats horizontally centred').toBe(true)
    expect(shape.centredY, 'and vertically — the zone takes the remaining height').toBe(true)

    expect(shape.appbar, 'the guest brand chrome').toBe(true)
    expect(shape.ticker).toBe(true)
    expect(shape.subtitle, "this route's own subtitle").toBe('Objednávka cez odkaz')
    expect(shape.docScroll).toBeLessThanOrEqual(0)

    // 320px is the narrowest phone the shell supports; a 400px card must not force
    // a scrollbar there.
    await page.setViewportSize(NARROW)
    await expect(page.getByTestId('guest-unavailable')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('a network/5xx failure keeps the SHIPPED fallback — the page does not invent a reason', async ({ page }) => {
    const { link } = await scenario('dead5xx')

    // ⚠ The three variants above are safe only because the server NAMES the reason.
    // Anything else has no reason to name, so both shipped strings stand: the
    // fallback title, and the server's own message as the description.
    await page.route(`**/api/guest/${link.token}`, (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Služba je dočasne nedostupná.' }),
    }))
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}`)

    const card = page.getByTestId('guest-unavailable')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Objednávka nie je dostupná')
    await expect(card).toContainText('Služba je dočasne nedostupná.')
    // None of the three named variants may be claimed for a failure with no reason.
    for (const v of Object.values(COPY)) await expect(card).not.toContainText(v.text)
  })
})

// ---------------------------------------------------------------------------
// (C) the status-404 card — §UC-GX-010

test.describe('RD-GX-4 · the status-404 card (§UC-GX-010)', () => {
  test('the pair that does not resolve reuses the dead-card composition, with the shipped copy', async ({ page }) => {
    const { link } = await scenario('s404')

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/THISORDERDOESNOTEXIST`)
    const card = page.getByTestId('guest-status-unavailable')
    await expect(card).toBeVisible()

    await expect(card).toContainText('Objednávka sa nenašla')
    // The COPY is shipped copy — this failure has an actionable cause the g-dead
    // variants do not share, so the server line and the instruction both stand.
    await expect(card).toContainText('Táto objednávka neexistuje')
    await expect(card).toContainText('Skontrolujte, či je odkaz skopírovaný celý. Ak nie, požiadajte kolegu, ktorý objednávku organizuje.')

    const shape = await card.evaluate((el) => {
      const badge = el.querySelector('.badge')
      return {
        cls: el.className,
        border: getComputedStyle(el).borderTopWidth,
        maxWidth: getComputedStyle(el).maxWidth,
        badgeText: badge.textContent.trim(),
        badgeGlyph: !!badge.querySelector('svg'),
        subtitle: document.querySelector('.appbar .titles .s')?.textContent,
        titleSize: getComputedStyle(el.querySelector('.h-screen')).fontSize,
      }
    })
    expect(shape.cls).toContain('card')
    expect(shape.border).toBe('3px')
    expect(shape.maxWidth).toBe('400px')
    expect(shape.badgeText, 'the same badge — it is the same dead end').toBe('Slepá ulička')
    expect(shape.badgeGlyph).toBe(true)
    expect(shape.titleSize).toBe('32px')
    // ⚠ THIS route's subtitle, not the ordering route's.
    expect(shape.subtitle).toBe('Vaša objednávka')

    await expect(page.getByTestId('guest-status')).toHaveCount(0)
  })

  test('⚠ a LOCKED cycle and a dead link do NOT route here — they still owe money', async ({ page }) => {
    const { host, cycle, link, order } = await scenario('s404lock')

    // GSO-T4's read resolver is deliberately 404-only: the order and the payment
    // reference must survive the lock. A dead card here would hide a debt.
    expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { status: 'locked' } })).status()).toBe(200)
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await expect(page.getByTestId('guest-status-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('status-readonly')).toBeVisible()
    await expect(page.getByTestId('open-payment')).toBeVisible()

    // Same for a deactivated link.
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status()).toBe(200)
    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await expect(page.getByTestId('guest-status-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('guest-status')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// (D) the §UC-GX-011 closeout invariants

test.describe('RD-GX-4 · closeout invariants (§UC-GX-011)', () => {
  test('⚠ the localStorage contract round-trips EXACTLY across the restyle', async ({ page }) => {
    const host = await makeHost('lstore')
    const cycle = await makeCycle('lstore')
    const product = await addProduct(cycle.id, {
      name: `GX4 lstore ${uniq}`, purpose: 'Espresso', price_250g: 10, stock_limit_g: 100000,
    })
    const link = await shareLink(host, cycle.id)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}`)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    await page.getByTestId('guest-name').fill('Pamät Kolegova')
    await page.getByTestId('guest-phone').fill(uniquePhone())
    await page.getByTestId('guest-submit').click()
    await expect(page.getByTestId('guest-confirmation')).toBeVisible()

    // The entry `rememberStatusUrl()` writes, keyed by LINK token — the shape GSO-T3
    // pinned. The restyle touched the surrounding markup on every screen that reads
    // or writes it, so the schema is asserted key by key rather than by "truthy".
    const stored = await page.evaluate((t) => JSON.parse(localStorage.getItem('gorifi_guest_orders'))[t], link.token)
    expect(Object.keys(stored).sort()).toEqual(
      ['cycle_name', 'guest_name', 'order_id', 'order_token', 'saved_at', 'status_url', 'total'].sort()
    )
    expect(stored.cycle_name).toBe(cycle.name)
    expect(stored.guest_name).toBe('Pamät Kolegova')
    expect(stored.total).toBe(12.5) // 10 × 1.25 markup, frozen server-side
    expect(stored.status_url).toBe(`${new URL(page.url()).origin}/g/${link.token}/o/${stored.order_token}`)
    expect(typeof stored.order_id).toBe('number')
    expect(Date.parse(stored.saved_at)).not.toBeNaN()

    // A reload of the STATUS page refreshes the same entry in place — `status` is the
    // one key the status page adds, and our entry must not be replaced by another
    // link's or dropped.
    await page.goto(stored.status_url)
    await expect(page.getByTestId('guest-status')).toBeVisible()
    const after = await page.evaluate((t) => JSON.parse(localStorage.getItem('gorifi_guest_orders'))[t], link.token)
    expect(after.order_id).toBe(stored.order_id)
    expect(after.order_token).toBe(stored.order_token)
    expect(after.status_url).toBe(stored.status_url)
    expect(after.guest_name).toBe(stored.guest_name)
    expect(after.total).toBe(stored.total)
    expect(after.status).toBe('submitted')
  })

  test('⚠ ADMIN INVARIANCE — no admin screen picks up the friends theme', async ({ page }) => {
    // The whole theme is `:where(.app,.modal-layer) …`, and `.app` is declared only
    // in the friend/guest views. This is the assertion that keeps that true from the
    // outside: an admin view that grew a `.app`, a `neo/` primitive or a theme class
    // would start repainting under every module of this effort.
    await page.setViewportSize({ width: 1180, height: 900 })
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    for (const route of ['/admin/dashboard', '/admin/friends', '/admin/cycles', '/admin/invitations', '/admin/settings']) {
      await page.goto(route)
      await expect(page.locator('.app'), `${route}: no theme root`).toHaveCount(0)
      await expect(page.locator('.modal-layer'), `${route}: no portal layer`).toHaveCount(0)
      for (const cls of ['.h-screen', '.cartbar', '.appbar', '.statuspill', '.field-lbl', '.copyrow', '.vbox', '.cat-tabs']) {
        await expect(page.locator(cls), `${route}: no ${cls}`).toHaveCount(0)
      }
    }
  })
})
