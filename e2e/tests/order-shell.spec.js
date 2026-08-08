import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-FO-1 — the friend order screen's SHELL (04 §UC-FO-001..004).
//
// What this file pins, and why each one is a SILENT regression without it:
//
// (A) THE CHROME REPLACED A STICKY HEADER, AND `.app` HIDES THAT.
//     `.app > * { position:relative; z-index:1 }` neutralises every Tailwind
//     positioning utility on a DIRECT child — `fixed`, `absolute`, `sticky`, and
//     even `relative z-10`, whose z-index is silently clamped. The old
//     `<header … sticky top-0 z-40>` was such a child. Writing `class="app"`
//     without also removing it produces no build error and no failing spec — the
//     header simply stops sticking. So the header's ABSENCE is asserted, and so is
//     the fact that the two things that must still be positioned still are: the
//     `.cat-tabs` strip (sticky, top 0, z 40) and the cart footer (fixed, pinned to
//     the viewport bottom — it survives only because it is NESTED, not a root child).
//
// (B) THE STRIP'S `top` WAS CALIBRATED AGAINST THAT HEADER.
//     `top-16` (64px) existed because the appbar was sticky. `BrandChrome` is
//     deliberately NOT sticky (02 UC-DS-005), so the strip owns the top edge alone
//     and must be at `top: 0`. `mobile-no-h-overflow.spec.js` asserts the strip
//     scrolls WITHIN ITSELF and would not have caught a wrong `top` at all.
//
// (C) snapTab, THE 02 §UC-DS-012 DEFERRED OBLIGATION.
//     Proven by A/B rather than asserted: the same tab, on the same page, is
//     centred first through `snapTab` (`parent.scrollTo`) and then through
//     `scrollIntoView()`. The second one moves the PAGE. That is the whole reason
//     the helper exists, and no static assertion about `scrollTo` could show it.
//
// (D) THE GREEN BANNER NOW YIELDS WHILE UNSENT CHANGES EXIST.
//     A handoff UX change (§UC-FO-002 business rules), adopting the prototype's
//     `submitted && !dirty && lines > 0`. It is a CONDITION, invisible to a build.
//
// (E) THE BADGE'S VISUAL HALF (resolved conflict #1).
//     `guest-host-view.spec.js` (pre-existing, unmodified) pins the badge's
//     SEMANTICS — 2 colleagues → locked → 1 pending → none at zero. Nothing pinned
//     which SKIN each state wears, and the prototype gets this exactly wrong (it
//     always paints the amber pending badge). Plain `.tabbadge` at rest, amber
//     `.tabbadge.pending` only when locked with an outstanding hand-over.
//
// Everything here is hermetic: its own friend, its own cycles, its own products.
// Nothing is stubbed — `portal-appbar.spec.js`'s idiom, and the friends-list stub
// two older guest specs still carry is dead (see e2e/README.md).

const TIMEOUT = 20_000

let ctx = null
let adminToken = ''
let host = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const TICKER_OPEN = '+++ OBJEDNÁVKY OTVORENÉ +++ NEHOVOR O TOM NAHLAS +++'
const TICKER_LOCKED = '+++ OBJEDNÁVKY UZAMKNUTÉ +++ DRŽ JAZYK ZA ZUBAMI +++'

// Enough purposes to overflow a phone strip, in the shipped order (Espresso,
// Filter, Kapsule first, then encounter order) so the rendered sequence is
// predictable — `availablePurposes` is data-derived (resolved conflict #2).
const PURPOSES = ['Espresso', 'Filter', 'Kapsule', 'Filter Special', 'Brew Bags', 'Nespresso']

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

async function makeCycle(label, over = {}) {
  const name = `E2E RDFO1 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open', ...over } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function addProduct(cycleId, purpose, name) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId,
      name,
      purpose,
      roast_type: 'Medium roast',
      roastery: 'Goriffee',
      description1: '100% natural bourbon arabica',
      price_250g: 9.04,
      price_1kg: 35.7,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function setStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  const username = `rdfo1_${uniq}`.slice(0, 30)
  const name = `RDFO1 Hostitel ${uniq}`
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
// session — `FriendOrder.vue`'s `onMounted` deliberately delegates restore to
// `FriendPortal` (04 §UC-FO-001 business rules; this row must not "fix" it).
// Entering through the portal is how a real friend gets here.
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
  await expect(page.locator('.app .appbar')).toBeVisible()
}

/** `line-height: normal` and every text metric here are FONT-METRIC driven, and
 *  Google Fonts only downloads a family when something on the page uses it. */
async function fontsReady(page) {
  await page.evaluate(async () => {
    const weights = [400, 500, 600, 700, 800]
    await Promise.all(['Figtree', 'Darker Grotesque', 'Courier Prime']
      .flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`))))
    await document.fonts.ready
  })
}

// ---------------------------------------------------------------------------
// UC-FO-001 — screen shell & brand chrome

test.describe('UC-FO-001 — brand chrome', () => {
  let open = null
  let locked = null

  test.beforeAll(async () => {
    open = await makeCycle('Chrome')
    await addProduct(open.id, 'Espresso', `Brazil Morada ${uniq}`)
    locked = await makeCycle('ChromeLock')
    await addProduct(locked.id, 'Espresso', `Kolumbia Huila ${uniq}`)
    await setStatus(locked.id, 'locked')
  })

  test('an OPEN cycle: back chevron, cycle name in display caps, the rotated "Otvorené" chip, hazard tape and the open ticker', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, open)
    await fontsReady(page)

    // Back chevron — a bare span in the prototype, given the house zero-pixel ARIA
    // layer here because it is the only in-page route back. `exact: true` matters:
    // Playwright matches accessible names as a case-insensitive SUBSTRING, and the
    // fatal-error state renders a "Späť na zoznam cyklov" button.
    const back = page.getByRole('button', { name: 'Späť', exact: true })
    await expect(back).toBeVisible()
    await expect(back.locator('svg')).toHaveCount(1)

    const title = page.locator('.appbar .titles .t')
    await expect(title).toHaveText(open.name)
    const titleStyle = await title.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { transform: cs.textTransform, family: cs.fontFamily, weight: cs.fontWeight }
    })
    expect(titleStyle.transform, 'the cycle name renders in display caps').toBe('uppercase')
    expect(titleStyle.family, 'display face').toContain('Darker Grotesque')
    expect(titleStyle.weight).toBe('800')

    // Subtitle: the friend's NAME ONLY (orchestrator decision — the endpoint
    // returns no code, and the session uid is optional in the stored shape, so
    // "name · code" would appear for some friends and not others).
    const sub = page.locator('.appbar .titles .s')
    await expect(sub).toHaveText(host.name)
    expect(await sub.textContent(), 'no "name · code" pattern').not.toContain('·')

    const chip = page.locator('.appbar .chip')
    await expect(chip).toHaveText('Otvorené')
    const chipStyle = await chip.evaluate((el) => ({
      cls: el.className,
      transform: getComputedStyle(el).transform,
      shadow: getComputedStyle(el).boxShadow,
    }))
    expect(chipStyle.cls.split(/\s+/), 'the accent chip variant').toContain('acc')
    expect(chipStyle.transform, 'the chip is rotated (-2deg)').not.toBe('none')
    expect(chipStyle.shadow, 'and carries the hard 3px offset shadow').not.toBe('none')

    const hazard = page.locator('.app .hazard')
    await expect(hazard).toBeVisible()
    expect(await hazard.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(10)

    // The ticker is static and repeats its segment 3× inside one span.
    const ticker = page.locator('.app .ticker span')
    const tickerText = await ticker.textContent()
    expect(tickerText.split(TICKER_OPEN).length - 1, 'the open-cycle ticker, 3×').toBe(3)
    expect(tickerText).not.toContain('UZAMKNUTÉ')
  })

  test('a LOCKED cycle: the lock chip and the locked ticker', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, locked)

    const chip = page.locator('.appbar .chip')
    await expect(chip.locator('svg'), 'the locked chip is the lock glyph, no text').toHaveCount(1)
    expect((await chip.textContent()).trim()).toBe('')
    expect((await chip.evaluate((el) => el.className)).split(/\s+/), 'never the accent variant when locked')
      .not.toContain('acc')

    const tickerText = await page.locator('.app .ticker span').textContent()
    expect(tickerText.split(TICKER_LOCKED).length - 1, 'the locked ticker, 3×').toBe(3)
    expect(tickerText).not.toContain('OTVORENÉ')
  })

  test('⚠ the sticky header is GONE, and nothing else lost its positioning', async ({ page }) => {
    // A SHORT viewport on purpose: this cycle has one product, and at 844px tall
    // the page does not scroll at all — "the chrome scrolls away" would then pass
    // vacuously for a chrome that was pinned.
    await page.setViewportSize({ width: 378, height: 420 })
    await signIn(page)
    await gotoCycle(page, open)

    // 1. The header is gone outright — not merely restyled.
    await expect(page.locator('header')).toHaveCount(0)

    // 2. The chrome is NOT sticky: `.appbar` keeps the canon's own
    //    `position: relative` and scrolls away with the page.
    const appbar = page.locator('.app .appbar')
    expect(await appbar.evaluate((el) => getComputedStyle(el).position)).toBe('relative')

    // 3. `.app > *` did NOT eat the two positions that still have to work.
    const positions = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="purpose-tabs"]')
      const bar = [...document.querySelectorAll('div')].find((d) => getComputedStyle(d).position === 'fixed' && d.querySelector('details'))
      const cs = (el) => (el ? { pos: getComputedStyle(el).position, top: getComputedStyle(el).top, z: getComputedStyle(el).zIndex } : null)
      return { strip: cs(strip), bar: cs(bar), barBottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null, vh: window.innerHeight }
    })
    // The strip only exists with >1 purpose; this cycle has one, so it is absent
    // by design here — the strip's own geometry is asserted in UC-FO-004 below.
    expect(positions.strip).toBeNull()
    expect(positions.bar, 'the cart footer is still `fixed` — it survives because it is NESTED').toEqual(
      expect.objectContaining({ pos: 'fixed' })
    )
    expect(positions.barBottom, 'and still pinned to the viewport bottom').toBe(positions.vh)

    // 4. And the chrome genuinely scrolls away: it moves 1:1 with the document.
    //    (Measured as a delta rather than "bottom < 0", so the amount the page
    //    happens to be scrollable by never decides the outcome.)
    const before = await appbar.evaluate((el) => el.getBoundingClientRect().bottom)
    const scrolled = await page.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      const by = Math.min(400, max)
      window.scrollTo(0, by)
      return by
    })
    await page.waitForTimeout(150)
    expect(scrolled, 'the page must actually be scrollable for this to mean anything').toBeGreaterThan(50)
    const after = await appbar.evaluate((el) => el.getBoundingClientRect().bottom)
    expect(Math.round(before - after), 'the appbar moves 1:1 with the page — it is not pinned').toBe(Math.round(scrolled))
  })
})

// ---------------------------------------------------------------------------
// UC-FO-002 — status banners

test.describe('UC-FO-002 — status banners', () => {
  let cycle = null
  let product = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Banner')
    product = await addProduct(cycle.id, 'Espresso', `Etiopia Yirgacheffe ${uniq}`)
    // A submitted order, so the page opens in the green-banner state.
    const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth,
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(put.status(), 'cart saved').toBe(200)
    const sub = await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${host.id}/submit`, {
      headers: host.auth, data: {}, timeout: TIMEOUT,
    })
    expect(sub.status(), 'order submitted').toBe(200)
  })

  test('a submitted order shows the green banner — and it YIELDS while unsent changes exist', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const green = page.locator('.app .banner.ok').filter({ hasText: 'Vaša objednávka bola odoslaná!' })
    await expect(green).toBeVisible()
    await expect(green).toContainText('Stále ju môžete upraviť až do uzamknutia.')
    // Theme contract: every `.banner` carries its `span.dot` as the first child.
    expect(await green.evaluate((el) => el.firstElementChild.className)).toBe('dot')
    expect(await green.evaluate((el) => getComputedStyle(el).borderTopWidth), 'full banner, not `.slim`').toBe('3px')

    // Dirty the cart from the UI. The prototype hides the green banner while
    // `dirty`; the repo equivalent is `hasUnsubmittedChanges`.
    await page.getByRole('button', { name: '+', exact: true }).first().click()
    await expect(green, 'the green banner yields to the cartbar warning').toBeHidden()
    await expect(page.getByText('Zmeny neboli odoslané.')).toBeVisible()

    // Revert and it comes back — same cart as the last submission.
    await page.getByRole('button', { name: '-', exact: true }).first().click()
    await expect(green, 'reverting the change brings it back').toBeVisible()
  })

  test('an open cycle with nothing ordered shows NO banner — and the Kolegovia tab is still there with no badge', async ({ page }) => {
    const quiet = await makeCycle('Quiet')
    await addProduct(quiet.id, 'Espresso', `Rwanda Kivu ${uniq}`)

    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, quiet)

    // The third row of the priority table: "otherwise → nothing".
    await expect(page.locator('.app .banner')).toHaveCount(0)
    // No colleagues ⇒ no badge, but the tab STAYS — it is where sharing lives.
    await expect(page.getByTestId('guest-tab-badge')).toHaveCount(0)
    await expect(page.getByTestId('main-tab-guests')).toBeVisible()
  })

  test('a locked cycle shows the warn banner and never the green one', async ({ page }) => {
    await setStatus(cycle.id, 'locked')
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const warn = page.locator('.app .banner.warn')
    await expect(warn).toBeVisible()
    await expect(warn).toContainText('Objednávky sú uzamknuté.')
    await expect(warn).toContainText('Už nie je možné meniť objednávku.')
    expect(await warn.evaluate((el) => el.firstElementChild.className)).toBe('dot')
    await expect(
      page.locator('.app .banner.ok'),
      'the locked banner wins outright — the order is still submitted underneath'
    ).toHaveCount(0)

    // Banners sit ABOVE the main switch: a submit can fail from either tab.
    const order = await page.evaluate(() => {
      const b = document.querySelector('.app .banner')
      const g = document.querySelector('.tabgroup')
      return b.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING ? 'banner-first' : 'switch-first'
    })
    expect(order).toBe('banner-first')

    await setStatus(cycle.id, 'open')
  })
})

// ---------------------------------------------------------------------------
// UC-FO-003 — main switch shell + the badge's visual half

test.describe('UC-FO-003 — main switch', () => {
  let cycle = null
  let product = null
  let link = null

  test.beforeAll(async () => {
    cycle = await makeCycle('Switch')
    product = await addProduct(cycle.id, 'Espresso', `Peru Cajamarca ${uniq}`)
    const res = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(res.status())
    link = (await res.json()).link
    const guest = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: 'Marek Kolega',
        guest_phone: '0901 234 567',
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      },
      timeout: TIMEOUT,
    })
    expect(guest.status(), 'guest sub-order').toBe(201)
  })

  test('the panels are v-show — the hidden one stays MOUNTED, which is what feeds the badge', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    // The badge is present before the tab it advertises has ever been opened.
    // That is only possible because `#panel-guests` is `v-show`, so its
    // `GuestSubOrders` child is mounted and its `summary` emit has fired.
    await expect(page.getByTestId('guest-tab-badge')).toHaveText('1')

    const guests = page.locator('#panel-guests')
    await expect(guests, 'v-if would have removed it').toHaveCount(1)
    await expect(guests).toBeHidden()
    expect(await guests.evaluate((el) => el.style.display), 'hidden by `display:none`, i.e. v-show').toBe('none')

    await page.getByTestId('main-tab-guests').click()
    await expect(guests).toBeVisible()
    await expect(page.locator('#panel-own')).toBeHidden()
    expect(await page.locator('#panel-own').evaluate((el) => el.style.display)).toBe('none')
  })

  test('the badge wears the RESTING skin on an open cycle and the amber PENDING skin only when locked', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const badge = page.getByTestId('guest-tab-badge')
    await expect(badge).toHaveText('1')
    let skin = await badge.evaluate((el) => ({ cls: el.className, bg: getComputedStyle(el).backgroundColor }))
    expect(skin.cls.split(/\s+/), 'plain `.tabbadge` at rest — the prototype always paints pending, which is wrong here')
      .not.toContain('pending')
    expect(skin.bg, 'white').toBe('rgb(255, 255, 255)')
    await expect(badge).toHaveAttribute('title', 'Toľko kolegov si objednalo cez váš odkaz')

    // Theme metrics, so a later restyle cannot quietly drift the pill.
    const box = await badge.boundingBox()
    expect(Math.round(box.height), '22px mono pill').toBe(22)
    expect(await badge.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Courier Prime')

    await setStatus(cycle.id, 'locked')
    await gotoCycle(page, cycle)

    const locked = page.getByTestId('guest-tab-badge')
    await expect(locked).toHaveText('1')
    skin = await locked.evaluate((el) => ({ cls: el.className, bg: getComputedStyle(el).backgroundColor }))
    expect(skin.cls.split(/\s+/), 'amber `.tabbadge.pending` — the host owes a hand-over').toContain('pending')
    expect(skin.bg, 'warn-soft, not white').not.toBe('rgb(255, 255, 255)')
    await expect(locked).toHaveAttribute('title', 'Toľkým kolegom ste ešte neodovzdali tovar')

    // Still opens on the own order, even locked.
    await expect(page.getByTestId('main-tab-own')).toHaveAttribute('aria-selected', 'true')

    await setStatus(cycle.id, 'open')
  })

  test('the switch is operable by keyboard — both tabs are the only route to their panel', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, cycle)

    const guests = page.getByTestId('main-tab-guests')
    await guests.focus()
    await page.keyboard.press('Enter')
    await expect(guests).toHaveAttribute('aria-selected', 'true')

    const own = page.getByTestId('main-tab-own')
    await own.focus()
    await page.keyboard.press(' ')
    await expect(own).toHaveAttribute('aria-selected', 'true')
    // Space must not also scroll the page.
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// UC-FO-004 — the `.cat-tabs` category strip

test.describe('UC-FO-004 — category strip', () => {
  let many = null
  let single = null

  test.beforeAll(async () => {
    many = await makeCycle('Strip')
    let firstProduct = null
    for (const purpose of PURPOSES) {
      const p = await addProduct(many.id, purpose, `Guatemala ${purpose} ${uniq}`)
      if (!firstProduct) firstProduct = p
    }
    // ⚠ A guest sub-order, purely so the 320px test below is not VACUOUS. The
    // `.tabgroup` switch is widest with the Kolegovia badge rendered, and the
    // badge is DATA-dependent — without one here (and there is none in
    // `mobile-no-h-overflow.spec.js`'s seeded cycle either) the narrow-width
    // pins would only ever exercise the roomiest possible state.
    const share = await ctx.post(`/api/guest-links/cycle/${many.id}`, { headers: host.auth, timeout: TIMEOUT })
    expect([200, 201]).toContain(share.status())
    const guest = await ctx.post(`/api/guest/${(await share.json()).link.token}/orders`, {
      data: {
        guest_name: 'Zuzana Kolegyňa',
        guest_phone: '0902 345 678',
        items: [{ product_id: firstProduct.id, variant: '250g', quantity: 1 }],
      },
      timeout: TIMEOUT,
    })
    expect(guest.status(), 'guest sub-order for the badge').toBe(201)

    single = await makeCycle('Single')
    await addProduct(single.id, 'Espresso', `Keňa AA ${uniq}`)
  })

  test('sticky at top 0 with the theme z-40, hidden scrollbar, snap and the right-edge fade', async ({ page }) => {
    // Short viewport so the page can actually scroll far enough to prove sticky.
    await page.setViewportSize({ width: 378, height: 420 })
    await signIn(page)
    await gotoCycle(page, many)

    const strip = page.getByTestId('purpose-tabs')
    await expect(strip).toBeVisible()
    await expect(strip).toHaveAttribute('role', 'tablist')

    const geo = await strip.evaluate((el) => {
      const cs = getComputedStyle(el)
      const tab = el.querySelector('.tab')
      const after = getComputedStyle(el, '::after')
      return {
        pos: cs.position,
        top: cs.top,
        z: cs.zIndex,
        snap: cs.scrollSnapType,
        scrollbar: cs.scrollbarWidth,
        overflow: cs.overflowX,
        tabSnap: getComputedStyle(tab).scrollSnapAlign,
        fade: after.backgroundImage,
        fadeWidth: after.flexBasis,
      }
    })
    // ⚠ `top: 0`, NOT the old `top-16`: that 64px was calibrated against a sticky
    // header that no longer exists. Nothing above the strip is pinned any more.
    expect(geo.pos).toBe('sticky')
    expect(geo.top, 'the strip owns the top edge alone').toBe('0px')
    expect(geo.z).toBe('40')
    // `scroll-snap-type: x proximity` — Chromium serialises the computed value
    // as bare "x" because `proximity` is the strictness default.
    expect(geo.snap).toBe('x')
    expect(geo.scrollbar, 'scrollbar hidden').toBe('none')
    expect(geo.overflow).toBe('auto')
    expect(geo.tabSnap).toBe('start')
    expect(geo.fade, 'the 28px right-edge gradient').toContain('gradient')
    expect(geo.fadeWidth).toBe('28px')

    // Purposes are DATA-DERIVED (resolved conflict #2): the distinct
    // `product.purpose` values, with Espresso / Filter / Kapsule pulled to the
    // front and everything else in ENCOUNTER order — which is the products
    // endpoint's own ordering, so only the priority prefix is deterministic here.
    const labels = (await strip.getByRole('tab').allTextContents()).map((t) => t.trim())
    expect(labels.slice(0, 3), 'Espresso, Filter, Kapsule first').toEqual(['Espresso', 'Filter', 'Kapsule'])
    expect([...labels].sort(), 'and nothing else is invented or dropped').toEqual([...PURPOSES].sort())
    // The active one is `.tab.on` — no per-purpose colour classes survive
    // (resolved conflict #7), and the page background is the uniform `--bg`.
    await expect(strip.getByRole('tab').first()).toHaveClass(/\bon\b/)
    const bodyBg = await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor)

    // Sticky for real: scroll the page past the strip's resting offset and it
    // stays at the viewport top.
    const restingY = Math.round((await strip.boundingBox()).y)
    const scrolled = await page.evaluate(() => {
      const by = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo(0, by)
      return by
    })
    await page.waitForTimeout(200)
    expect(scrolled, 'the page must scroll past the strip for this to mean anything').toBeGreaterThan(restingY)
    expect(Math.round((await strip.boundingBox()).y), 'pinned to the top edge').toBe(0)
    // …and switching purpose no longer repaints the page (the old `backgroundClass`).
    await strip.getByRole('tab').nth(1).click()
    await expect(strip.getByRole('tab').nth(1)).toHaveClass(/\bon\b/)
    expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(bodyBg)
  })

  test('only the ACTIVE purpose\'s cards render, and the tab switches them', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, many)

    const strip = page.getByTestId('purpose-tabs')
    await expect(page.getByRole('heading', { name: `Guatemala Espresso ${uniq}` })).toBeVisible()
    await expect(page.getByRole('heading', { name: `Guatemala Filter ${uniq}`, exact: true })).toHaveCount(0)

    await strip.getByRole('tab').nth(1).click()
    await expect(page.getByRole('heading', { name: `Guatemala Filter ${uniq}`, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: `Guatemala Espresso ${uniq}` })).toHaveCount(0)
  })

  test('a single purpose renders NO strip at all — just the cards', async ({ page }) => {
    await page.setViewportSize({ width: 378, height: 844 })
    await signIn(page)
    await gotoCycle(page, single)

    await expect(page.getByTestId('purpose-tabs')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: `Keňa AA ${uniq}` })).toBeVisible()
    // The switch is still there — it is not a purpose strip and never was.
    await expect(page.getByTestId('main-tab-own')).toBeVisible()
  })

  test('⚠ snapTab centres the tab and does NOT move the page — A/B against scrollIntoView', async ({ page }) => {
    // ⚠ SHORT viewport on purpose. The B half only means something if the
    // document CAN scroll vertically — at 844px tall this page does not, and
    // `scrollIntoView` would then look as innocent as `snapTab`.
    await page.setViewportSize({ width: 378, height: 420 })
    await signIn(page)
    await gotoCycle(page, many)
    await fontsReady(page)

    const strip = page.getByTestId('purpose-tabs')
    await expect(strip).toBeVisible()
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), 'the strip must actually overflow').toBe(true)

    const reset = async () => {
      await page.evaluate(() => {
        window.scrollTo(0, 0)
        document.querySelector('[data-testid="purpose-tabs"]').scrollLeft = 0
      })
      await page.waitForTimeout(120)
    }

    // ---- A: snapTab (what ships) ------------------------------------------
    await reset()
    const target = strip.getByRole('tab').nth(4) // 'Brew Bags' — off-screen at 378px
    const expected = await target.evaluate((el) => {
      const p = el.parentNode
      return Math.max(0, el.offsetLeft - (p.clientWidth - el.offsetWidth) / 2)
    })
    await target.click()
    await page.waitForTimeout(600) // `behavior: 'smooth'`
    const afterSnap = await page.evaluate(() => ({
      pageY: window.scrollY,
      left: document.querySelector('[data-testid="purpose-tabs"]').scrollLeft,
    }))
    // Tolerance, not slop: `.cat-tabs` is `scroll-snap-type: x proximity` with
    // `scroll-snap-align: start` per tab, so the browser re-snaps to the nearest
    // tab edge once the smooth scroll lands (measured 5px off the ideal centre
    // here). The property under test is that the strip scrolled to roughly the
    // centring offset — an unsnapped implementation would be hundreds off.
    expect(Math.abs(afterSnap.left - expected), 'the tab is centred in the strip').toBeLessThanOrEqual(24)
    expect(afterSnap.left, 'the strip really did scroll').toBeGreaterThan(0)
    expect(afterSnap.pageY, 'and the PAGE did not move a pixel').toBe(0)
    await expect(target, 'the tapped tab is now fully in view').toBeInViewport({ ratio: 0.99 })

    // ---- B: scrollIntoView on the same tab, same page ----------------------
    // The alternative `snap-tab.js` exists to avoid: it also scrolls the nearest
    // scrollable ANCESTOR — the document — so the category the user tapped is
    // yanked out from under their thumb.
    await reset()
    await page.evaluate(() => {
      document.querySelectorAll('[data-testid="purpose-tabs"] .tab')[4].scrollIntoView()
    })
    await page.waitForTimeout(300)
    const afterIntoView = await page.evaluate(() => window.scrollY)
    expect(
      afterIntoView,
      'A/B: scrollIntoView DOES scroll the document — this is the bug snapTab avoids, not an aspiration'
    ).toBeGreaterThan(0)
  })

  test('at 320px the document does not overflow, the strip scrolls inside itself, and the switch — badge and all — does not scroll', async ({ page }) => {
    await setStatus(many.id, 'locked')
    await page.setViewportSize({ width: 320, height: 844 })
    await signIn(page)
    await gotoCycle(page, many)
    await fontsReady(page)

    // ⚠ NON-VACUITY GATE. The switch's binding constraint is the BADGE, not the
    // label, and the badge is data-dependent — a 320px pass with an empty
    // Kolegovia tab proves nothing about the state real hosts see. This cycle
    // has a guest sub-order (see beforeAll) and the cycle is locked here, so the
    // amber pending badge is rendered while the measurements below are taken.
    const badge = page.getByTestId('guest-tab-badge')
    await expect(badge, 'the widest state must actually be on screen').toBeVisible()
    await expect(badge).toHaveText('1')

    const metrics = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="purpose-tabs"]')
      const sw = document.querySelector('.tabgroup')

      // The REAL model. `.tabgroup` is `grid-auto-columns: 1fr`, i.e.
      // `minmax(auto, 1fr)`: each track FLOORS at its own min-content and only
      // the surplus is shared, so the constraint is `min₁ + min₂ + gap ≤ content`
      // — never "does the label fit in half the row" (it legitimately does not:
      // "Moja objednávka" is wider than half, and the Kolegovia track gives the
      // difference back). Sizing the container to `min-content` reads
      // `min₁ + min₂ + gap` straight off the layout engine.
      const cs = getComputedStyle(sw)
      const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
      const content = sw.getBoundingClientRect().width - chrome
      const prev = sw.style.width
      sw.style.width = 'min-content'
      void sw.offsetWidth
      const needed = sw.getBoundingClientRect().width - chrome
      sw.style.width = prev
      void sw.offsetWidth

      return {
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        strip: strip.scrollWidth - strip.clientWidth,
        switchOverflow: sw.scrollWidth - sw.clientWidth,
        headroom: +(content - needed).toFixed(2),
      }
    })
    expect(metrics.doc, 'zero horizontal DOCUMENT overflow at 320px, locked state').toBe(0)
    expect(metrics.strip, 'the strip scrolls WITHIN itself').toBeGreaterThan(0)
    // ⚠ The switch is a 1fr/1fr grid with NO scroll affordance: an overflowing
    // label there is simply unreachable, so it must fit outright.
    expect(metrics.switchOverflow, 'the own/colleagues switch must fit without scrolling').toBeLessThanOrEqual(0)
    // Headroom, not just "no overflow": this row is already the tight one
    // (measured 12.3px with Figtree, 3.6px on the fallback face when Google
    // Fonts is unreachable), so anything added to it lands here as a near-miss
    // BEFORE it becomes a visible break. A 3-digit badge on the fallback face
    // already overflows by 2px.
    expect(metrics.headroom, 'min₁ + min₂ + gap must still fit the content box, badge included').toBeGreaterThan(0)

    await setStatus(many.id, 'open')
  })
})
