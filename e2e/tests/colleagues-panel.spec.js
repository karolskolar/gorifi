import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-KG-1 — 05 §UC-KG-001..005, 007: the "Kolegovia" panel restyled onto the
// friends theme (`.card.flat` share row, `.display` heading, `.suborder` cards,
// the big green NeoCheckbox hand-over tick, the `.confirmbox` soft-cancel).
//
// This is a RE-SKIN. No API, schema or business-logic change — `guest-host-view.spec.js`
// runs UNMODIFIED and remains the behavioural contract for this surface. What is
// added here is what the restyle newly makes assertable:
//
//   1. THE MONEY RULE (§UC-KG-001). The colleague money is CONTEXT. `{label}` and
//      `{total}` come from the server's `totals` ({count, total}, cancelled-excluded
//      — GSO-T5 pins that shape) and NOTHING in this panel may reach the host's own
//      payable total. Pinned with 2 live + 1 cancelled sub-orders.
//   2. The `rows` field on the `summary` emit — ADDITIVE, and the panel's state
//      machine is the only consumer. `count`/`pendingDelivery` keep their meaning
//      and module 04's tab badge is NOT re-gated on it.
//   3. The paid-409 escalation: the server's sentence VERBATIM in the panel banner,
//      with the confirmbox left OPEN (the host escalates to the admin — Decision 2).
//   4. The three non-list states, the error banner with AND without rows, and the
//      theme metrics at the 378px reference width.
//
// NOTE ON RATE LIMITS: the guest submits below sit behind `guestWriteLimiter`. Run
// the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// The backend keeps exactly ONE live admin session, overwritten on every
// /api/admin/login — a UI login in another spec (or in this one) invalidates a
// token captured earlier. Every fixture-building block re-logs-in first.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// A friend with a real per-friend Bearer session — the host identity these routes
// require. Mirrors guest-host-view.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `kg1_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Peto ${label} ${uniq}`
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

async function makeCycle(label) {
  const name = `E2E KG1 ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function setCycleStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
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

const IDENTITY = { guest_name: 'Juraj Lehotsky', guest_phone: '0905 012 998' }

async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

async function markPaid(guestOrderId) {
  const res = await admin(`/api/guest-orders/${guestOrderId}/paid`, { method: 'patch', data: { paid: true } })
  expect(res.status(), 'admin marks paid').toBe(200)
}

async function cancelSubOrder(host, guestOrderId) {
  const res = await ctx.delete(`/api/guest-orders/${guestOrderId}`, { headers: host.auth })
  expect(res.status(), 'host soft-cancels').toBe(200)
  return res.json()
}

// The host's OWN order, so the cartbar carries a total that the panel must not move.
async function setOwnOrder(host, cycleId, items) {
  const res = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, { headers: host.auth, data: { items } })
  expect(res.status(), 'own order').toBe(200)
  return res.json()
}

async function hostView(host, cycleId) {
  const res = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect(res.status(), 'host view').toBe(200)
  return res.json()
}

// FriendPortal resolves the stored session against GET /api/friends?active=true,
// which is admin-gated — an anonymous browser gets 401 (pre-existing app gap, see
// e2e/README.md), so that ONE response is stubbed. Everything under test still
// talks to the real backend with the real Bearer token.
async function signInAsHost(page, host) {
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, JSON.stringify({ friendId: host.id, friendName: host.name, token: host.token, expiresAt: Date.now() + 864e5 }))

  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EKG1', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

// A hard load of /cycle/:id bounces to the portal (pre-existing app behaviour), so
// going in through the portal is how a real host gets here.
async function gotoCycle(page, cycle) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

async function openPanel(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
  await page.getByTestId('main-tab-guests').click()
}

const box = (locator) => locator.evaluate((el) => {
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
    font: cs.fontSize, lineHeight: cs.lineHeight, weight: cs.fontWeight, family: cs.fontFamily,
    border: cs.borderTopWidth, style: cs.borderTopStyle, radius: cs.borderTopLeftRadius,
    padding: cs.padding, shadow: cs.boxShadow, gap: cs.gap, opacity: cs.opacity,
    decoration: cs.textDecorationLine, color: cs.color, background: cs.backgroundColor,
  }
})

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await refreshAdminToken()
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// UC-KG-001 / UC-KG-003 — panel composition, the money rule, the card skins

test.describe('UC-KG-001/003 — composition, money rule, sub-order cards', () => {
  let host, cycle, product, link, first, second, killed, ownTotal

  test.beforeAll(async () => {
    await refreshAdminToken()
    host = await makeHost('comp')
    cycle = await makeCycle('comp')
    product = await addProduct(cycle.id, { name: `KG1 Brazil ${uniq}`, purpose: 'Espresso', price_250g: 7.6, price_1kg: 24 })
    link = await shareLink(host, cycle.id)

    first = await submitGuest(link.token, [
      { product_id: product.id, variant: '250g', quantity: 2 },
      { product_id: product.id, variant: '1kg', quantity: 1 },
    ])
    second = await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }], {
      guest_name: 'Misa Kovacova', guest_phone: '0910 447 213',
    })
    killed = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Katka Prazna', guest_phone: '0911 902 664',
    })
    await cancelSubOrder(host, killed.order.id)
    await markPaid(first.order.id)

    const own = await setOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    ownTotal = Number(own.total ?? own.order?.total)
  })

  // ⚠ THE hard rule of this panel. The colleagues pay the ADMIN directly, so their
  // money is context and must never reach the host's own payable total.
  test('2 live + 1 cancelled: the summary counts 2, sums only the live totals, and the cartbar is untouched', async ({ page }) => {
    const view = await hostView(host, cycle.id)
    const liveRows = view.guest_orders.filter((o) => (o.status || 'submitted') !== 'cancelled')
    expect(liveRows).toHaveLength(2)
    expect(view.totals.count, 'server totals exclude the cancelled row').toBe(2)
    expect(view.totals.total).toBeCloseTo(liveRows.reduce((s, o) => s + Number(o.total), 0), 2)
    // Not a vacuous check: the cancelled sub-order really did have a price.
    const cancelledWorth = view.guest_orders
      .find((o) => o.id === killed.order.id).items
      .reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0)
    expect(cancelledWorth, 'the cancelled row was worth real money').toBeGreaterThan(0)

    await openPanel(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')

    // "Objednali 2 kolegovia · spolu {total} EUR."
    await expect(section).toContainText('Objednali 2 kolegovia')
    await expect(section.locator('b.mono')).toHaveText(`${view.totals.total.toFixed(2)} EUR`)
    // Three cards on screen, but only two are counted — a cancelled colleague is
    // still the host's record, and it is NOT in the money.
    await expect(section.locator('.suborder')).toHaveCount(3)
    await expect(section.locator('.suborder.cancelled')).toHaveCount(1)

    // …and the host's own payable total is exactly their own items, unmoved by any
    // figure in the panel.
    const cartTotal = await page.locator('.cartbar .sum').innerText()
    const cartNumber = Number(cartTotal.replace(/[^0-9.]/g, ''))
    expect(cartNumber, 'the cartbar is own-items-only').toBeCloseTo(ownTotal, 2)
    expect(cartNumber, 'and is nowhere near the colleague aggregate').not.toBeCloseTo(view.totals.total, 2)
    await expect(page.locator('.cartbar')).not.toContainText(view.totals.total.toFixed(2))

    // Switching to the own tab must not import a colleague figure either.
    await page.getByTestId('main-tab-own').click()
    const stillCart = await page.locator('.cartbar .sum').innerText()
    expect(stillCart).toBe(cartTotal)
  })

  test('the panel matches 05 §UC-KG-001 at 378px: flat share row, display heading, mono total, 14px rhythm', async ({ page }) => {
    await openPanel(page, host, cycle)
    const panel = page.locator('#panel-guests')
    const shareRow = panel.locator('> .card.flat')
    const section = page.getByTestId('guest-sub-orders')

    // 1 — share row: `.card.flat` is the 2px, shadowless card.
    const row = await box(shareRow)
    expect(row.border).toBe('2px')
    expect(row.shadow, 'flat = no hard shadow').toBe('none')
    expect(row.padding).toBe('12px 14px')
    await expect(shareRow.locator('.sub')).toHaveText('Ďalší kolegovia sa môžu pridať cez ten istý odkaz.')
    const shareBtn = shareRow.getByRole('button', { name: 'Zdieľať odkaz' })
    await expect(shareBtn).toBeVisible()
    expect((await box(shareBtn)).height, '.btn.sm').toBe(39)

    // 3 — heading block.
    const heading = section.locator('.display')
    await expect(heading).toHaveText('Objednávky kolegov')
    const h = await box(heading)
    expect(h.font).toBe('24px')
    expect(h.family).toContain('Darker Grotesque')
    // A10: the display face must not carry preflight's 1.5 strut.
    expect(h.lineHeight).toBe('normal')

    const total = section.locator('b.mono')
    expect((await box(total)).family).toContain('Courier Prime')

    // 14px column rhythm, ACROSS the FriendOrder → GuestSubOrders boundary: the
    // share row lives in the parent, everything below in the child.
    const rhythm = await page.evaluate(() => {
      const kids = [...document.querySelector('#panel-guests').children]
      const cont = document.querySelector('[data-testid="guest-sub-orders"]')
      const all = [...kids.filter((k) => k !== cont), ...cont.children]
      const rects = all.map((el) => el.getBoundingClientRect())
      return rects.slice(1).map((r, i) => Math.round(r.top - (rects[i].top + rects[i].height)))
    })
    expect(rhythm.every((g) => g === 14), JSON.stringify(rhythm)).toBe(true)
    expect(rhythm.length, 'share row + heading block + 3 cards ⇒ 4 gaps').toBe(4)
  })

  test('a live `.suborder` card carries the theme skin, bare item amounts and the display total', async ({ page }) => {
    await openPanel(page, host, cycle)
    const card = page.locator(`.suborder:not(.cancelled)`).first()

    const skin = await box(card)
    expect(skin.border).toBe('3px')
    expect(skin.style).toBe('solid')
    expect(skin.radius).toBe('12px')
    expect(skin.padding).toBe('12px 14px')
    expect(skin.shadow).toContain('3px 3px 0px')
    expect(skin.opacity).toBe('1')

    // Item lines: bare numbers. The EUR suffix belongs to TOTALS only.
    const lines = page.getByTestId(`guest-items-${first.order.id}`).locator('li')
    await expect(lines).toHaveCount(2)
    for (const line of await lines.all()) {
      const mono = line.locator('.mono')
      await expect(mono).toHaveText(/^\d+\.\d{2}$/)
      await expect(mono).not.toContainText('EUR')
    }
    // …and the variant suffix survived: a lost whitespace node would glue the
    // product name straight onto the em dash.
    await expect(lines.first()).toContainText(`${product.name} — 250g`)

    // Foot total: display face, WITH the EUR suffix.
    const cardTotal = card.locator('.total')
    await expect(cardTotal).toHaveText(`${Number(first.order.total).toFixed(2)} EUR`)
    const t = await box(cardTotal)
    expect(t.font).toBe('20px')
    expect(t.family).toContain('Darker Grotesque')

    // Exactly ONE badge, and it is the admin's read-only paid flag.
    const badges = card.locator('.badge')
    await expect(badges).toHaveCount(1)
    await expect(page.getByTestId('guest-paid-badge').first()).toHaveText('Zaplatené')

    // The chevron is accent + rotated while open (`.chev.open`).
    const chev = card.locator('.chev')
    await expect(chev).toHaveClass(/open/)
    expect((await box(chev)).color).toBe('rgb(255, 45, 135)')

    // ⚠ The unclassed name span must not inherit preflight's 1.5 strut — a class
    // list cannot reach it, so the fix is `line-height:normal` at the call site.
    // button > span.chev + span(column) > span(name)
    const nameLine = card.locator(`[data-testid="guest-items-toggle-${first.order.id}"] > span:nth-child(2) > span:nth-child(1)`)
    await expect(nameLine).toHaveText(IDENTITY.guest_name)
    const n = await box(nameLine)
    expect(n.font).toBe('15.5px')
    expect(n.weight).toBe('800')
    expect(n.height, '15.5px at line-height:normal, not 1.5 (=23)').toBeLessThanOrEqual(20)
  })

  // §UC-KG-003 rule 3 + rule 6, and resolved conflict 2.
  test('a cancelled row: dashed, 60%, ONE muted badge, no items, no controls — and the RECOMPUTED struck amount', async ({ page }) => {
    await openPanel(page, host, cycle)
    const card = page.locator('.suborder.cancelled')

    const skin = await box(card)
    expect(skin.style).toBe('dashed')
    expect(skin.shadow).toBe('none')
    expect(skin.opacity).toBe('0.6')

    // A single `.badge.muted` — the paid badge is dropped (its paid state is the
    // ADMIN's refund signal, not something the host can act on).
    await expect(card.locator('.badge')).toHaveCount(1)
    await expect(page.getByTestId(`guest-status-${killed.order.id}`)).toHaveText('Zrušené')
    await expect(card.locator('[data-testid="guest-paid-badge"]')).toHaveCount(0)

    // Not a toggle, no item list, no controls.
    await expect(page.getByTestId(`guest-items-toggle-${killed.order.id}`)).toHaveCount(0)
    await expect(card.locator('[aria-expanded]')).toHaveCount(0)
    await expect(page.getByTestId(`guest-items-${killed.order.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`guest-delivered-${killed.order.id}`)).toHaveCount(0)
    await expect(page.getByTestId(`guest-remove-${killed.order.id}`)).toHaveCount(0)
    await expect(card.locator('.chev.open'), 'the chevron stays closed').toHaveCount(0)
    // The "N položiek" line is permanent on a cancelled row.
    await expect(page.getByTestId(`guest-items-summary-${killed.order.id}`)).toHaveText('1 položka')

    // ⚠ Rule 6: the struck amount is RECOMPUTED from the kept item rows. The server
    // zeroes `total` on soft-cancel, so `subOrder.total` would print "0.00 EUR" and
    // say nothing about what was called off.
    const view = await hostView(host, cycle.id)
    const row = view.guest_orders.find((o) => o.id === killed.order.id)
    expect(Number(row.total), 'the server really did zero it').toBe(0)
    const worth = row.items.reduce((s, i) => s + Number(i.price) * Number(i.quantity), 0)
    const struck = card.locator('.foot span')
    await expect(struck).toHaveText(`${worth.toFixed(2)} EUR`)
    await expect(struck).not.toHaveText('0.00 EUR')
    expect((await box(struck)).decoration).toBe('line-through')
  })
})

// ---------------------------------------------------------------------------
// UC-KG-004 — the hand-over checkbox

test.describe('UC-KG-004 — the "Odovzdané" hand-over tick', () => {
  let host, cycle, product, link, sub

  test.beforeAll(async () => {
    await refreshAdminToken()
    host = await makeHost('handover')
    cycle = await makeCycle('handover')
    product = await addProduct(cycle.id, { name: `KG1 HO ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    link = await shareLink(host, cycle.id)
    sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
  })

  test('it is the big green NeoCheckbox, and it writes `delivered`', async ({ page }) => {
    await openPanel(page, host, cycle)
    const cbox = page.getByTestId(`guest-delivered-${sub.order.id}`)

    await expect(cbox).toHaveClass(/cbox/)
    await expect(cbox).toHaveClass(/big/)
    await expect(cbox).toHaveClass(/ok/)
    await expect(cbox).toHaveRole('checkbox')
    const before = await box(cbox)
    expect(before.height, '32px thumb target').toBe(32)
    expect(before.border).toBe('3px')

    await expect(cbox).not.toBeChecked()
    await cbox.click()
    await expect(cbox).toBeChecked()
    // Green `--ok` fill, not the default magenta.
    expect((await box(cbox)).background).toBe('rgb(31, 138, 91)')
    await expect
      .poll(async () => (await hostView(host, cycle.id)).guest_orders[0].delivered, { timeout: 5000 })
      .toBe(1)
  })

  // ⚠ REGRESSION GUARD. `NeoCheckbox` is a `span[role=checkbox]`; a wrapping `<label>`
  // can neither forward a click to it nor name it. The markup this replaced was a native
  // `<input type="checkbox">`, where BOTH came free — so swapping in the primitive
  // silently made the "Odovzdané" text and the 8px gap dead, and left every checkbox in
  // the panel anonymous, with nothing in the suite noticing. On the hand-over checklist,
  // on a phone, the text is the part a thumb actually hits. All three zones are asserted
  // here, and each must fire EXACTLY ONE PATCH — a double-toggle would write to the
  // server twice and land back where it started, looking like a dead control.
  test('all three zones toggle it — box, label text, and the gap — each exactly once', async ({ page }) => {
    const own = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '250g', quantity: 1 }],
      { guest_name: 'Zuzana Klikova', guest_phone: '0905 012 777' }
    )
    await openPanel(page, host, cycle)

    const cbox = page.getByTestId(`guest-delivered-${own.order.id}`)
    const label = cbox.locator('xpath=..')
    const text = label.locator('span', { hasText: 'Odovzdané' })
    await expect(cbox).toBeVisible()

    // The accessible name is what `getByRole('checkbox', { name })` needs — and what the
    // "no `paid` control" assertion leans on to be non-vacuous.
    await expect(
      page.getByTestId('guest-sub-orders').getByRole('checkbox', { name: 'Odovzdané' })
    ).not.toHaveCount(0)

    let patches = 0
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes(`/api/guest-orders/${own.order.id}/delivered`)) patches++
    })

    // Relative flips, so this test does not care what any earlier test persisted.
    const flip = async (zone, click) => {
      const before = await cbox.getAttribute('aria-checked')
      const seen = patches
      await click()
      await expect(cbox, `${zone} flips aria-checked`).toHaveAttribute(
        'aria-checked', before === 'true' ? 'false' : 'true'
      )
      // Settle, then confirm the flip was a SINGLE write.
      await expect
        .poll(async () => (await hostView(host, cycle.id)).guest_orders
          .find((o) => o.id === own.order.id).delivered, { timeout: 5000 })
        .toBe(before === 'true' ? 0 : 1)
      expect(patches - seen, `${zone} fires exactly one PATCH (no double-toggle)`).toBe(1)
    }

    await flip('the box', () => cbox.click())
    await flip('the label text', () => text.click())

    // The GAP: label's own area between the 32px control and the text — the zone that
    // only `@click.self` can serve, and the one `cursor:pointer` promises across.
    const lb = await label.boundingBox()
    const cb = await cbox.boundingBox()
    const tb = await text.boundingBox()
    const gapMidX = (cb.x + cb.width + tb.x) / 2
    expect(gapMidX, 'the gap sits between the control and the text').toBeGreaterThan(cb.x + cb.width)
    expect(gapMidX, 'the gap sits between the control and the text').toBeLessThan(tb.x)
    await flip('the gap', () => label.click({
      position: { x: gapMidX - lb.x, y: lb.height / 2 },
    }))
  })

  // The `disabled`-capable primitive (UC-DS-009's approved extension). A mutation
  // in flight must not be re-fired from the same row.
  test('while a mutation is in flight it is `aria-disabled`, refuses clicks — and stays keyboard-reachable', async ({ page }) => {
    await signInAsHost(page, host)
    await page.setViewportSize({ width: 378, height: 900 })
    let release
    const held = new Promise((resolve) => { release = resolve })
    await page.route(`**/api/guest-orders/${sub.order.id}/delivered`, async (route) => {
      await held
      await route.continue()
    })
    await gotoCycle(page, cycle)
    await page.getByTestId('main-tab-guests').click()

    const cbox = page.getByTestId(`guest-delivered-${sub.order.id}`)
    const wasChecked = await cbox.getAttribute('aria-checked')
    await cbox.click()
    await expect(cbox).toHaveAttribute('aria-disabled', 'true')
    // WAI-ARIA: "present but unavailable" — it must remain focusable.
    await expect(cbox).toHaveAttribute('tabindex', '0')
    const optimistic = await cbox.getAttribute('aria-checked')
    expect(optimistic, 'the optimistic flip happened').not.toBe(wasChecked)

    // A second click (and Space) while disabled must be a no-op, not a second PATCH.
    await cbox.click({ force: true })
    await cbox.press(' ')
    expect(await cbox.getAttribute('aria-checked')).toBe(optimistic)

    release()
    await expect(cbox).not.toHaveAttribute('aria-disabled', 'true')
  })

  test('no `paid` control is offered anywhere in the panel (Decision 2)', async ({ page }) => {
    await openPanel(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')
    await expect(section.getByRole('button', { name: /Zaplaten/ })).toHaveCount(0)
    await expect(section.getByRole('checkbox', { name: /Zaplaten/ })).toHaveCount(0)
    await expect(section.locator('input[type="checkbox"]'), 'the theme checkbox is a span').toHaveCount(0)

    // ⚠ The `/Zaplaten/` count-0 above is only meaningful while the panel's checkboxes
    // actually HAVE accessible names — otherwise it passes for the wrong reason and can
    // never fail. (It was briefly vacuous: `NeoCheckbox` is a `span[role=checkbox]`, which
    // a wrapping `<label>` cannot name, so every checkbox was anonymous.) Assert the
    // POSITIVE too, so the negative cannot silently go vacuous again: every checkbox in
    // the panel is named, and the only name in use is the hand-over tick's.
    const named = await section.getByRole('checkbox', { name: 'Odovzdané' }).count()
    expect(named, 'the hand-over tick is named — this is what gives the /Zaplaten/ count-0 its force').toBeGreaterThan(0)
    expect(named, 'and it is the ONLY named checkbox in the panel').toBe(
      await section.getByRole('checkbox').count()
    )
  })
})

// ---------------------------------------------------------------------------
// UC-KG-005 — the `.confirmbox` soft-cancel and the paid-409

test.describe('UC-KG-005 — soft-cancel, and the paid-409 escalation', () => {
  let host, cycle, product, link

  test.beforeAll(async () => {
    await refreshAdminToken()
    host = await makeHost('remove')
    cycle = await makeCycle('remove')
    product = await addProduct(cycle.id, { name: `KG1 RM ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    link = await shareLink(host, cycle.id)
  })

  test('the confirmbox wears the theme, and cancelling converts the row in place', async ({ page }) => {
    const sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await openPanel(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')

    await section.getByTestId(`guest-remove-${sub.order.id}`).click()
    const confirm = section.locator('.confirmbox')
    await expect(confirm).toBeVisible()
    await expect(confirm.locator('span').first()).toHaveText(
      'Objednávka kolegu sa zruší. Kolega ju uvidí ako zrušenú a už si ju nebude môcť upraviť.'
    )
    const c = await box(confirm)
    expect(c.border).toBe('3px')
    expect(c.radius).toBe('10px')
    expect(c.background, 'warn-soft fill').toBe('rgb(255, 241, 207)')
    expect(c.font).toBe('13.5px')
    // The trigger folds away while its own confirmbox is open (one at a time).
    await expect(section.getByTestId(`guest-remove-${sub.order.id}`)).toHaveCount(0)

    await expect(confirm.getByRole('button', { name: 'Nie' })).toBeVisible()
    await confirm.getByRole('button', { name: 'Áno, odstrániť' }).click()

    await expect(section.getByTestId(`guest-status-${sub.order.id}`)).toHaveText('Zrušené')
    await expect(section.locator('.suborder.cancelled')).toHaveCount(1)
    await expect(section, 'the row never leaves the list').toContainText(IDENTITY.guest_name)
    await expect(section.locator('.confirmbox'), 'a success closes the confirmbox').toHaveCount(0)
  })

  // ⚠ The escalation case. Under Decision 2 the host CANNOT resolve this: the money
  // the guest sent must keep a refund signal, so only the admin can act.
  test('a PAID row refuses: the server sentence VERBATIM in the banner, with the confirmbox left OPEN', async ({ page }) => {
    const paid = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Platca Zaplateny', guest_phone: '0902 111 222',
    })
    await markPaid(paid.order.id)

    await openPanel(page, host, cycle)
    const section = page.getByTestId('guest-sub-orders')

    // The trigger is deliberately still there on a paid row — hiding it would hide
    // the escalation path silently.
    const trigger = section.getByTestId(`guest-remove-${paid.order.id}`)
    await expect(trigger).toBeVisible()
    await trigger.click()
    await section.getByRole('button', { name: 'Áno, odstrániť' }).click()

    const banner = section.locator('.banner.danger.slim')
    await expect(banner).toBeVisible()
    await expect(banner, 'the server copy already says "talk to the admin" — no client rewording')
      .toContainText('Táto objednávka je už zaplatená. Zrušenie vyriešte so správcom.')

    // The confirmbox stays OPEN: the host sees what was refused, and dismisses it.
    await expect(section.locator('.confirmbox')).toBeVisible()
    await expect(section.getByRole('button', { name: 'Áno, odstrániť' })).toBeVisible()

    // The row is otherwise untouched — still live, still paid-badged.
    await expect(section.getByTestId(`guest-status-${paid.order.id}`)).toHaveCount(0)
    const row = (await hostView(host, cycle.id)).guest_orders.find((o) => o.id === paid.order.id)
    expect(row.status === null || row.status === 'submitted', 'nothing was written').toBe(true)
    expect(row.paid).toBe(1)

    // "Nie" is the way out.
    await section.getByRole('button', { name: 'Nie' }).click()
    await expect(section.locator('.confirmbox')).toHaveCount(0)
    await expect(trigger).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// UC-KG-002 — the three non-list states, plus the error banner

test.describe('UC-KG-002 — empty, locked and error states', () => {
  test('A — open cycle, no rows: the empty card IS the panel, and no list exists', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('empty')
    const cycle = await makeCycle('empty')
    await addProduct(cycle.id, { name: `KG1 E ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })

    await openPanel(page, host, cycle)
    const card = page.locator('#panel-guests > .card')
    await expect(card).toBeVisible()
    expect((await box(card)).padding).toBe('22px')
    // `.card`, NOT `.card.dashed` (resolved conflict 1) — the solid 3px+5px skin.
    await expect(card).not.toHaveClass(/dashed/)
    expect((await box(card)).shadow).toContain('5px 5px 0px')

    const badge = card.locator('.badge.acc')
    await expect(badge).toHaveText('Zatiaľ nikto')
    expect(await badge.evaluate((el) => getComputedStyle(el).transform), 'rotated -1.5°')
      .not.toBe('none')

    await expect(card.locator('.display')).toHaveText('Objednávate aj pre kolegov?')
    expect((await box(card.locator('.display'))).font).toBe('22px')
    await expect(card.locator('.sub')).toHaveText(
      'Pošlite im odkaz — objednajú si sami, bez registrácie, a vy im tovar odovzdáte.'
    )
    const cta = card.getByRole('button', { name: 'Zdieľať objednávku s kolegami' })
    await expect(cta).toBeVisible()
    await expect(cta).toHaveClass(/accent/)

    await expect(page.getByTestId('guest-sub-orders'), 'no list to show yet').toHaveCount(0)
    await expect(page.getByTestId('guest-tab-badge'), 'and no badge').toHaveCount(0)
  })

  test('B — locked cycle, no rows: one line, no card, no CTA', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('lockempty')
    const cycle = await makeCycle('lockempty')
    await addProduct(cycle.id, { name: `KG1 LE ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    await setCycleStatus(cycle.id, 'locked')

    await openPanel(page, host, cycle)
    const panel = page.locator('#panel-guests')
    const line = panel.locator('> .sub')
    await expect(line).toHaveText('Cez váš odkaz si nikto neobjednal.')
    expect((await box(line)).padding).toBe('8px 2px')
    await expect(panel.locator('> .card')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /Zdieľať/ })).toHaveCount(0)
    await expect(page.getByTestId('guest-sub-orders')).toHaveCount(0)
  })

  test('C — locked cycle WITH rows: sharing and removal go, the hand-over checklist stays', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('lockrows')
    const cycle = await makeCycle('lockrows')
    const product = await addProduct(cycle.id, { name: `KG1 LR ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    const sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    await setCycleStatus(cycle.id, 'locked')

    await openPanel(page, host, cycle)
    const panel = page.locator('#panel-guests')
    const section = page.getByTestId('guest-sub-orders')

    await expect(panel.locator('> .card.flat'), 'nobody can order into a locked cycle').toHaveCount(0)
    await expect(page.getByRole('button', { name: /Zdieľať/ })).toHaveCount(0)
    await expect(section.getByTestId(`guest-remove-${sub.order.id}`), 'removal ends at the lock').toHaveCount(0)

    // …but the hand-over is exactly what happens AFTER the lock.
    await expect(section.locator('.display')).toHaveText('Objednávky kolegov')
    const cbox = section.getByTestId(`guest-delivered-${sub.order.id}`)
    await expect(cbox).toBeVisible()
    await cbox.click()
    await expect(cbox).toBeChecked()
    await expect
      .poll(async () => (await hostView(host, cycle.id)).guest_orders[0].delivered, { timeout: 5000 })
      .toBe(1)
  })

  // The rule the empty state exists to protect: a failed load must never read as
  // "no colleagues yet" — with OR without rows.
  test('the error banner is the FIRST child of the section, with and without rows', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('err')
    const cycle = await makeCycle('err')
    const product = await addProduct(cycle.id, { name: `KG1 ER ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    // (a) load fails ⇒ no rows at all.
    await signInAsHost(page, host)
    await page.setViewportSize({ width: 378, height: 900 })
    await page.route(`**/api/guest-links/cycle/${cycle.id}`, (route) => route.fulfill({
      status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'Nepodarilo sa načítať objednávky kolegov' }),
    }))
    await gotoCycle(page, cycle)
    await page.getByTestId('main-tab-guests').click()

    const section = page.getByTestId('guest-sub-orders')
    await expect(section).toBeVisible()
    const banner = section.locator('.banner.danger.slim')
    await expect(banner).toContainText('Nepodarilo sa načítať objednávky kolegov')
    expect(await section.evaluate((el) => el.firstElementChild.className)).toContain('banner')
    expect(await banner.evaluate((el) => el.firstElementChild.className), 'the .dot leads').toBe('dot')
    await expect(section.locator('.suborder')).toHaveCount(0)
    // …and the locked-empty line must NOT also appear over a failed request.
    await expect(page.locator('#panel-guests')).not.toContainText('Cez váš odkaz si nikto neobjednal.')

    // (b) rows present, a MUTATION fails ⇒ the same banner, still first.
    await page.unroute(`**/api/guest-links/cycle/${cycle.id}`)
    const rows = await hostView(host, cycle.id)
    const id = rows.guest_orders[0].id
    await page.route(`**/api/guest-orders/${id}/delivered`, (route) => route.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'Táto objednávka bola zrušená, nie je čo odovzdať.' }),
    }))
    await gotoCycle(page, cycle)
    await page.getByTestId('main-tab-guests').click()
    await expect(section.locator('.suborder')).toHaveCount(1)
    await section.getByTestId(`guest-delivered-${id}`).click()
    await expect(section.locator('.banner.danger.slim')).toContainText('Táto objednávka bola zrušená')
    expect(await section.evaluate((el) => el.firstElementChild.className)).toContain('banner')
    await expect(section.getByTestId(`guest-delivered-${id}`), 'and the tick reverted').not.toBeChecked()
  })
})

// ---------------------------------------------------------------------------
// UC-KG-001 rule 5 — the additive `rows` field

test.describe('UC-KG-001 rule 5 — `rows` is additive and the tab badge is NOT re-gated on it', () => {
  test('cancelling the only colleague keeps the share ROW (rows=1) while the badge, on `count`, goes to 0', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('rows')
    const cycle = await makeCycle('rows')
    const product = await addProduct(cycle.id, { name: `KG1 RW ${uniq}`, purpose: 'Espresso', price_250g: 7.6 })
    const link = await shareLink(host, cycle.id)
    const sub = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await openPanel(page, host, cycle)
    const panel = page.locator('#panel-guests')
    await expect(page.getByTestId('guest-tab-badge')).toHaveText('1')
    await expect(panel.locator('> .card.flat')).toBeVisible()

    await panel.getByTestId(`guest-remove-${sub.order.id}`).click()
    await panel.getByRole('button', { name: 'Áno, odstrániť' }).click()
    await expect(page.getByTestId(`guest-status-${sub.order.id}`)).toHaveText('Zrušené')

    // ⚠ resolved conflict 6: `count` is now 0, but a row is still on screen, so the
    // panel must keep the one-line share row — NOT stack a "Zatiaľ nikto" CTA card
    // above a visible cancelled card.
    await expect(panel.locator('> .card.flat'), 'gated on rows, not count').toBeVisible()
    await expect(panel).not.toContainText('Objednávate aj pre kolegov?')
    await expect(panel.locator('.suborder.cancelled')).toHaveCount(1)

    // …while the badge, which is `count`/`pendingDelivery`, correctly drops away.
    await expect(page.getByTestId('guest-tab-badge'), 'badge math untouched').toHaveCount(0)
    await expect(page.getByTestId('guest-sub-orders')).toContainText('Objednali 0 kolegov')
  })
})

// ---------------------------------------------------------------------------
// UC-KG-007 — 320px and admin invariance

test.describe('UC-KG-007 — 320px and admin invariance', () => {
  test('320px: no horizontal overflow with a long colleague name, in every state', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('narrow')
    const cycle = await makeCycle('narrow')
    const product = await addProduct(cycle.id, {
      name: `KG1 Kolumbia Finca El Paraiso Double Anaerobic ${uniq}`, purpose: 'Espresso', price_250g: 7.6,
    })
    const link = await shareLink(host, cycle.id)

    const overflow = () => page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }))

    // (a) empty state — the 28-character accent CTA is the tightest thing here.
    await openPanel(page, host, cycle, { width: 320 })
    await expect(page.getByRole('button', { name: 'Zdieľať objednávku s kolegami' })).toBeVisible()
    expect(await overflow()).toEqual({ scrollW: 320, clientW: 320 })

    // (b) with a long guest name and a long product name.
    await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }], {
      guest_name: 'Bartolomej Krasnohorsky-Podhradsky', guest_phone: '0905 012 998',
    })
    await gotoCycle(page, cycle)
    await page.getByTestId('main-tab-guests').click()
    await expect(page.getByTestId('guest-sub-orders')).toBeVisible()
    expect(await overflow()).toEqual({ scrollW: 320, clientW: 320 })

    // (c) with the confirmbox open — two buttons in a `.row`.
    const rows = await hostView(host, cycle.id)
    await page.getByTestId(`guest-remove-${rows.guest_orders[0].id}`).click()
    await expect(page.locator('.confirmbox')).toBeVisible()
    expect(await overflow()).toEqual({ scrollW: 320, clientW: 320 })
  })

  // Module 02's permanent rule: the friends theme never reaches an admin screen.
  test('no module-05 theme class reaches an admin page', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear())
    await page.goto('/admin')
    await page.locator('#password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
    await expect(page).toHaveURL(/\/admin\/dashboard/)

    // The admin's own guest surfaces (CycleDetail orders tab, Distribution) render
    // the same sub-orders — they must keep their shadcn skin.
    await refreshAdminToken()
    const cycles = await (await admin('/api/cycles')).json()
    const cycleId = cycles[0].id
    for (const path of ['/admin/dashboard', `/admin/cycle/${cycleId}`, `/admin/cycle/${cycleId}/distribution`]) {
      await page.goto(path)
      await page.waitForTimeout(400)
      const leaked = await page.evaluate(() => {
        const bad = ['.app', '.modal-layer', '.suborder', '.confirmbox', '.cbox', '.chev', '.copyrow', '.banner', '.card.flat']
        return bad.filter((sel) => document.querySelector(sel) !== null)
      })
      expect(leaked, `${path} → ${JSON.stringify(leaked)}`).toEqual([])
    }
  })
})
