import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// RD-GX-3 — `GuestOrderStatus.vue` on the Neobrutal shell: 06 §UC-GX-006 (the read
// view's four states), §UC-GX-007 (edit mode) and §UC-GX-008 (the shared cancel
// confirm).
//
// `guest-status.spec.js` owns the BEHAVIOUR of this route (GSO-T4's resolver, the
// bounds, the lifecycle) and is immutable this row apart from the one sanctioned
// §UC-GX-011 item-2 edit. Everything here is the restyle's own contract: the theme
// root, the state→affordance mapping, and the invariants that carry money or
// irreversibility.
//
// ⚠ THE FIRST DESCRIBE IS THE REGRESSION NET FOR A SHIPPED-BUT-BROKEN SCREEN.
// RD-GX-1 lifted the SHARED `GuestProductGrid` onto the neo card, but this view had
// no `.app` ancestor and every theme rule is `:where(.app,.modal-layer) …` — so the
// edit screen rendered that grid with every theme class resolving to nothing, while
// staying fully functional and fully green. Measured on the build immediately
// before this row:
//
//     .cat-tabs   display:block  gap:normal   the two tabs TOUCHING (gap 0px)
//     .stepper    display:block  buttons 9×24 and 10×24, border 0px, no shadow
//     .vbox       border 0px     .card border 0px, box-shadow none
//     .stepper .val  system-ui, not the display face
//
// i.e. the purpose strip read as one word ("EspressoFilter") and the stepper as
// three glued glyphs ("−1+"). No behaviour spec can see that, which is why the
// assertions below are geometric.
//
// NOTE ON RATE LIMITS: this spec drives the guest read/write buckets. Run the full
// suite with the budgets in e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

const PHONE = { width: 378, height: 900 }

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gx3_${slug}`.slice(0, 30 - suffix.length) + suffix
  const name = `Lego ${label} ${uniq}`
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

async function makeCycle(label, { markup = 1.25 } = {}) {
  const name = `E2E GX3 ${label} ${uniq}`
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name, type: 'coffee', status: 'open', expected_date: '2026-08-20' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: markup } })).status()).toBe(200)
  return { ...cycle, name }
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

const IDENTITY = { guest_name: 'Karol Skolar', guest_phone: '0901 234 567' }

async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

function statusPath(linkToken, orderToken) {
  return `/api/guest/${linkToken}/orders/${orderToken}`
}

async function getStatus(linkToken, orderToken) {
  return ctx.get(statusPath(linkToken, orderToken))
}

async function setPaid(orderId, paid) {
  return admin(`/api/guest-orders/${orderId}/paid`, { method: 'patch', data: { paid: paid ? 1 : 0 } })
}

// One cycle, one product, one link — the shape almost every test here needs.
async function scenario(label, { markup = 1.25, productData } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label, { markup })
  const product = await addProduct(cycle.id, {
    name: `Brazil Rodomunho ${label} ${uniq}`,
    // ⚠ 'Espresso' because the grid's purpose order is ['Espresso','Filter','Kapsule']
    // and it opens on the first — so the product these tests interact with has to be
    // the one the default tab shows.
    purpose: 'Espresso',
    roast: 'svetlé',
    price_250g: 8,
    price_1kg: 28,
    stock_limit_g: 100000,
    ...productData,
  })
  // ⚠ A SECOND purpose, so `.cat-tabs` renders at all: the shared grid draws the
  // strip only when `availablePurposes.length > 1` (shipped rule). Without it the
  // very element the `.app`-root hazard deformed would be absent from the fixture.
  const second = await addProduct(cycle.id, {
    name: `Candy Blast Decaf ${label} ${uniq}`,
    purpose: 'Filter',
    roast: 'stredné',
    price_250g: 9,
    stock_limit_g: 100000,
  })
  const link = await shareLink(host, cycle.id)
  return { host, cycle, product, second, link }
}

// Wire-level record of every write this page makes. The cancel invariant is about
// what LEAVES the browser, so it is asserted on the request body, not on an
// after-the-fact read of the row.
function recordWrites(page, linkToken) {
  const writes = []
  page.on('request', (r) => {
    if (r.method() === 'PUT' && r.url().includes(`/api/guest/${linkToken}/orders/`)) {
      writes.push(r.postData())
    }
  })
  return writes
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
// (A) the `.app` root — the recorded merge-order hazard

test.describe('RD-GX-3 · the `.app` root (§UC-GX-006)', () => {
  test('⚠ the SHARED grid renders THEMED in edit mode — the tabs separate and the stepper is a control', async ({ page }) => {
    const { product, link } = await scenario('approot')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.locator('.app'), 'the theme root every rule is scoped to').toHaveCount(1)

    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId(`product-${product.id}`)).toBeVisible()

    const shape = await page.evaluate(() => {
      const cs = (el) => getComputedStyle(el)
      const tabs = Array.from(document.querySelectorAll('.cat-tabs .tab'))
      const strip = document.querySelector('.cat-tabs')
      const stepper = document.querySelector('.stepper')
      const btns = Array.from(stepper.querySelectorAll('button'))
      const val = stepper.querySelector('.val')
      return {
        stripDisplay: cs(strip).display,
        // The tabs are one text node's worth of characters apart in the DOM either
        // way — what changed is whether they are separate BOXES.
        tabGap: tabs.length > 1
          ? Math.round(tabs[1].getBoundingClientRect().left - tabs[0].getBoundingClientRect().right)
          : null,
        tabHeight: Math.round(tabs[0].getBoundingClientRect().height),
        stepperDisplay: cs(stepper).display,
        btnW: Math.round(btns[0].getBoundingClientRect().width),
        btnH: Math.round(btns[0].getBoundingClientRect().height),
        btnBorder: cs(btns[0]).borderTopWidth,
        btnShadow: cs(btns[0]).boxShadow,
        valFont: cs(val).fontFamily,
        vboxBorder: cs(document.querySelector('.vbox')).borderTopWidth,
        cardBorder: cs(document.querySelector('.card')).borderTopWidth,
        cardShadow: cs(document.querySelector('.card')).boxShadow,
      }
    })

    // Before the `.app` root: display:block, gap 0, buttons 9×24 with border 0px.
    expect(shape.stripDisplay, 'the purpose strip is a flex row, not a text block').toBe('flex')
    expect(shape.tabGap, 'the tabs must not touch — "EspressoFilter" was the symptom').toBeGreaterThanOrEqual(8)
    expect(shape.tabHeight, 'a tab is a pill, not a line of text').toBeGreaterThan(30)
    expect(shape.stepperDisplay).toBe('flex')
    expect(shape.btnW, 'the canon 38×38 stepper button').toBe(38)
    expect(shape.btnH).toBe(38)
    expect(shape.btnBorder).toBe('3px')
    expect(shape.btnShadow).toBe('rgb(10, 10, 10) 2px 2px 0px 0px')
    expect(shape.valFont, 'the quantity is in the display face').toMatch(/Darker Grotesque/i)
    expect(shape.vboxBorder, 'the variant box has its ink border').toBe('3px')
    expect(shape.cardBorder).toBe('3px')
    expect(shape.cardShadow).toBe('rgb(10, 10, 10) 5px 5px 0px 0px')
  })

  test('the brand header is one instance whose subtitle switches with the purpose', async ({ page }) => {
    const { product, link } = await scenario('subtitle')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    const subtitle = page.locator('.appbar .titles .s')
    await expect(page.locator('.appbar'), 'one chrome, not one per branch').toHaveCount(1)
    await expect(subtitle).toHaveText('Vaša objednávka')

    await page.getByTestId('start-edit').click()
    await expect(subtitle).toHaveText('Úprava objednávky')
    await expect(page.locator('.appbar'), 'remounting would restart the ticker').toHaveCount(1)

    await page.getByTestId('abort-edit').click()
    await expect(subtitle).toHaveText('Vaša objednávka')
  })
})

// ---------------------------------------------------------------------------
// (B) the four read states

test.describe('RD-GX-3 · the read view, four states (§UC-GX-006)', () => {
  test('editable: warn/off pills, Upraviť + the wider Zaplatiť, no banner', async ({ page }) => {
    const { product, link } = await scenario('editable')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    await expect(page.getByTestId('status-paid')).toHaveClass(/\bstatuspill\b/)
    await expect(page.getByTestId('status-paid')).toHaveClass(/\bwarn\b/)
    await expect(page.getByTestId('status-paid')).toHaveText('Nezaplatené')
    await expect(page.getByTestId('status-delivered')).toHaveClass(/\boff\b/)
    await expect(page.getByTestId('status-delivered')).toHaveText('Zatiaľ neodovzdané')
    // The square is part of the pill's grammar, not decoration on one of them.
    await expect(page.getByTestId('status-paid').locator('.sq')).toHaveCount(1)
    await expect(page.getByTestId('status-delivered').locator('.sq')).toHaveCount(1)

    await expect(page.getByTestId('start-edit')).toHaveText('Upraviť')
    await expect(page.getByTestId('open-payment')).toHaveText('Zaplatiť')
    await expect(page.getByTestId('open-payment')).toHaveClass(/\bok\b/)
    // Paying is the wider of the two — it is what the guest came for.
    const ratio = await page.evaluate(() => {
      const w = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().width
      return w('open-payment') / w('start-edit')
    })
    expect(ratio, 'flex 1.6 against flex 1').toBeGreaterThan(1.2)

    await expect(page.getByTestId('status-readonly')).toHaveCount(0)
    await expect(page.getByTestId('cancel-order'), 'cancel lives in edit mode here').toHaveCount(0)
    await expect(page.getByTestId('status-total')).toHaveText('20.00 EUR')
  })

  test('paid-frozen: pills + a ghost danger cancel and NOTHING else (resolved conflict #5)', async ({ page }) => {
    const { product, link } = await scenario('paidfrozen')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    await expect(page.getByTestId('status-paid')).toHaveClass(/\bok\b/)
    await expect(page.getByTestId('status-paid')).toHaveText('Zaplatené')

    // `items_editable = editable && !paid` (GSO-T6): the page can never offer an
    // action the backend would refuse, and a non-empty edit is refused once paid.
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
    // Nothing left to pay, so the pay affordance goes too.
    await expect(page.getByTestId('open-payment')).toHaveCount(0)

    const cancel = page.getByTestId('cancel-order')
    await expect(cancel).toBeVisible()
    await expect(cancel).toHaveText('Zrušiť objednávku')
    await expect(cancel).toHaveClass(/\bghost\b/)
    // Compared against the TOKEN, not a hard-coded rgb: the point is that it is
    // `--danger`, and 02 owns what that resolves to.
    const dangerHue = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--danger)'
      document.querySelector('.app').appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
    expect(await cancel.evaluate((el) => getComputedStyle(el).color), 'ghost in --danger').toBe(dangerHue)

    // Both texts the prototype drops.
    await expect(page.getByTestId('paid-locked')).toHaveCount(0)
    await expect(page.getByTestId('guest-status')).not.toContainText('Platba je zaevidovaná')
    await expect(page.getByTestId('guest-status')).not.toContainText('Ďakujeme')
  })

  test('read-only after the lock: a full-width Zaplatiť over the warn banner, no edit, no cancel', async ({ page }) => {
    const { cycle, product, link } = await scenario('lockedstate')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }])
    await setCycleStatus(cycle.id, 'locked')

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    const pay = page.getByTestId('open-payment')
    await expect(pay, 'the money is still owed').toBeVisible()
    await expect(pay).toHaveClass(/\bblock\b/)

    const banner = page.getByTestId('status-readonly')
    await expect(banner).toHaveClass(/\bbanner\b/)
    await expect(banner).toHaveClass(/\bwarn\b/)
    await expect(banner).toHaveClass(/\bslim\b/)
    // Resolved conflict #1: guest.jsx's SHORT wording wins over the README's, which
    // additionally promised a cancel the backend 409s after the lock.
    await expect(banner).toHaveText('Objednávanie v tomto cykle je uzavreté, objednávku už nie je možné upraviť.')

    await expect(page.getByTestId('start-edit')).toHaveCount(0)
    await expect(page.getByTestId('cancel-order'), 'a PUT would 409 here — do not offer it').toHaveCount(0)
    await expect(page.getByTestId('status-total')).toHaveText('30.00 EUR')
  })

  test('cancelled: a danger banner, struck lines under their own heading, and NO total', async ({ page }) => {
    const { product, link } = await scenario('cancelledstate')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await ctx.put(statusPath(link.token, created.order.order_token), { data: { items: [] } })).status()).toBe(200)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    const banner = page.getByTestId('status-cancelled')
    await expect(banner).toHaveClass(/\bbanner\b/)
    await expect(banner).toHaveClass(/\bdanger\b/)
    await expect(banner).toContainText('Táto objednávka bola zrušená.')
    await expect(banner.locator('b'), 'the word that carries the state is bold').toHaveText('zrušená')

    // The pills are REPLACED, not joined by a third.
    await expect(page.getByTestId('status-paid')).toHaveCount(0)
    await expect(page.getByTestId('status-delivered')).toHaveCount(0)

    // GSO-T4 cancels by UPDATE, never DELETE: the lines are the record of what was
    // called off, so they stay — struck, and owing nothing.
    await expect(page.getByTestId('status-item')).toHaveCount(1)
    await expect(page.locator('.field-lbl').filter({ hasText: 'Zrušené položky' })).toBeVisible()
    await expect(page.getByTestId('status-total')).toHaveCount(0)
    // ⚠ Read off the CONTAINER, not the line: `text-decoration` propagates to
    // descendants visually but is NOT inherited as a computed value, so a child
    // reports 'none' while the strike still paints through it. The prototype sets it
    // on the lines wrapper, and so does this view.
    const struck = await page.getByTestId('status-item')
      .evaluate((el) => getComputedStyle(el.parentElement).textDecorationLine)
    expect(struck).toBe('line-through')

    // Terminal: no edit, no pay, no cancel.
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
    await expect(page.getByTestId('open-payment')).toHaveCount(0)
    await expect(page.getByTestId('cancel-order')).toHaveCount(0)
  })

  test('⚠ the on-card payment reference is GONE from ALL FOUR states (resolved conflict #4)', async ({ page }) => {
    const { cycle, product, link } = await scenario('noref')
    const line = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const editable = await submitGuest(link.token, line)
    const paid = await submitGuest(link.token, line, { guest_name: 'Paid Pani', guest_phone: '0902 111 222' })
    const cancelled = await submitGuest(link.token, line, { guest_name: 'Zrusena Pani', guest_phone: '0903 111 222' })
    const locked = await submitGuest(link.token, line, { guest_name: 'Locked Pani', guest_phone: '0904 111 222' })
    expect((await setPaid(paid.order.id, true)).status()).toBe(200)
    expect((await ctx.put(statusPath(link.token, cancelled.order.order_token), { data: { items: [] } })).status()).toBe(200)

    await page.setViewportSize(PHONE)
    for (const [name, sub] of [['editable', editable], ['paid', paid], ['cancelled', cancelled]]) {
      await page.goto(`/g/${link.token}/o/${sub.order.order_token}`)
      await expect(page.getByTestId('guest-status')).toBeVisible()
      await expect(page.getByTestId('payment-reference'), `${name}: reference only in the Platba modal`).toHaveCount(0)
      await expect(page.getByTestId('copy-reference'), `${name}: the old copy button retired`).toHaveCount(0)
      await expect(page.getByTestId('guest-status'), `${name}: the header says "a odovzdá" instead`).not.toContainText('Tovar vám odovzdá')
    }

    // The lock is the fourth state, and it is the one where the reference matters
    // most — so it must still be REACHABLE, just only through the modal.
    await setCycleStatus(cycle.id, 'locked')
    await page.goto(`/g/${link.token}/o/${locked.order.order_token}`)
    await expect(page.getByTestId('payment-reference')).toHaveCount(0)
    await page.getByTestId('open-payment').click()
    await expect(page.getByRole('dialog').getByTestId('payment-reference'))
      .toContainText(`G${locked.order.id} / Locked Pani / ${cycle.name}`)
  })

  test('the header reads "organizuje a odovzdá {host}" and the lines are bare ×-amounts', async ({ page }) => {
    const { host, product, link } = await scenario('headerline')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    const first = host.name.split(' ')[0]
    await expect(page.locator('.sub').first()).toHaveText(`Vaša objednávka · organizuje a odovzdá ${first}`)

    // ⚠ 2026-08-12: this list is `components/CartLineList.vue` — the same component
    // the host's colleague view and both cart bars render. The size left the name
    // string for its own column, and the amount carries `€` (the "bare on lines, unit
    // on the total" rule is superseded); `status-total` still says EUR, because that
    // is the figure the guest actually pays.
    const line = page.getByTestId('status-item')
    await expect(line.locator('.ln-qty')).toHaveText('2×')
    expect(await line.locator('.ln-qty').innerText(), 'U+00D7, not the letter x').not.toContain('x')
    await expect(line.locator('.ln-size')).toHaveText('250g')
    await expect(line.locator('.ln-amt')).toHaveText('20.00 €')
    await expect(page.locator('.ln-group .badge'), 'grouped by purpose').toHaveText('Espresso')
    await expect(page.getByTestId('status-total'), 'the total keeps its unit').toHaveText('20.00 EUR')
  })
})

// ---------------------------------------------------------------------------
// (C) edit mode

test.describe('RD-GX-3 · edit mode (§UC-GX-007)', () => {
  test('the column widens, the grid is seeded, and the cartbar sits at the viewport bottom', async ({ page }) => {
    const { product, link } = await scenario('editmode')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    // The read view is the narrow 520px column; edit mode is the grid's 760px.
    const readMax = await page.getByTestId('guest-status').evaluate((el) => getComputedStyle(el).maxWidth)
    expect(readMax).toBe('520px')

    await page.getByTestId('start-edit').click()

    const column = page.locator('.app > div').filter({ has: page.locator('[data-testid^="product-"]') })
    expect(await column.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('760px')

    // The intro banner names whose order is being edited.
    const intro = page.locator('.banner.slim').first()
    await expect(intro).toContainText('Upravujete objednávku pre')
    await expect(intro.locator('b')).toHaveText(IDENTITY.guest_name)

    // Seeded from the PERSISTED items, not from an empty grid.
    const card = page.getByTestId(`product-${product.id}`)
    await expect(card.getByTestId('qty-250g')).toHaveText('2')
    await expect(card.getByTestId('qty-1kg')).toHaveText('0')

    // The cartbar is the theme's sticky bar, not the shipped `fixed` footer — which
    // `.app > * { position:relative }` would have silently neutralised.
    const bar = await page.locator('.cartbar').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { position: getComputedStyle(el).position, bottom: Math.round(r.bottom), viewport: window.innerHeight }
    })
    expect(bar.position).toBe('sticky')
    expect(bar.bottom, 'pinned to the viewport bottom on a short page').toBe(bar.viewport)
    // The shipped `h-36` spacer would now be 144px of dead space under the bar.
    await expect(page.locator('.h-36')).toHaveCount(0)

    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 20.00 EUR')
    await expect(page.locator('.cartbar')).toContainText('Položiek: 1')
    await expect(page.getByTestId('abort-edit')).toHaveText('Späť')
    await expect(page.getByTestId('save-edit')).toHaveText('Uložiť zmeny')
    await expect(page.getByTestId('cancel-order')).toHaveClass(/\bghost\b/)

    // ⚠ Items-ONLY (GSO-T4): identity is frozen at submit, because anyone holding
    // the URL could otherwise rewrite someone else's contact details.
    await expect(page.locator('input')).toHaveCount(0)
    await expect(page.getByTestId('invite-cta'), 'the CTA yields the screen to the cart').toHaveCount(0)
  })

  test('Späť discards silently and leaves the persisted order untouched', async ({ page }) => {
    const { product, link } = await scenario('abort')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const writes = recordWrites(page, link.token)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 20.00 EUR')

    await page.getByTestId('abort-edit').click()
    await expect(page.getByTestId('status-total')).toHaveText('10.00 EUR')
    expect(writes, 'abandoning an edit sends nothing').toEqual([])

    // Re-entering rebuilds from the server, not from the abandoned cart.
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 10.00 EUR')
  })
})

// ---------------------------------------------------------------------------
// (D) the cancel confirm — three entry points, ONE payload

test.describe('RD-GX-3 · the cancel confirm (§UC-GX-008)', () => {
  // ⚠ GSO-T4's hard rule: `items` absent, non-array, or non-empty-but-unpriceable
  // must 400 non-destructively, because before that guard `PUT {}` returned 200 and
  // irreversibly cancelled the order. Only a literal `items: []` cancels. Every
  // entry point below is checked on the WIRE for exactly that payload.

  async function expectConfirmModal(page) {
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.m-title')).toHaveText('Zrušiť objednávku?')
    await expect(dialog).toContainText('už ju nebude možné obnoviť')
    await expect(dialog.locator('.banner.danger.slim')).toHaveText('Toto sa nedá vrátiť späť.')
    await expect(dialog.getByTestId('keep-order')).toHaveText('Ponechať')
    await expect(dialog.getByTestId('confirm-cancel-order')).toHaveText('Zrušiť objednávku')
    return dialog
  }

  test('entry point 1 of 3: emptying the cart FUNNELS into the confirm instead of saving', async ({ page }) => {
    const { product, link } = await scenario('funnel')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const writes = recordWrites(page, link.token)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await page.getByTestId(`product-${product.id}`).getByTestId('dec-250g').click()
    await expect(page.getByTestId('edit-total')).toHaveText('Celkom: 0.00 EUR')

    await page.getByTestId('save-edit').click()
    await expectConfirmModal(page)
    // The whole point of the funnel: "Uložiť zmeny" on an empty cart must not
    // quietly PUT `items: []` on the guest's behalf.
    expect(writes, 'an empty save sends NOTHING until confirmed').toEqual([])

    await page.getByTestId('keep-order').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(writes, 'Ponechať sends nothing either').toEqual([])
    await expect(page.getByTestId('save-edit'), 'still in edit mode with the cart intact').toBeVisible()

    await page.getByTestId('save-edit').click()
    await page.getByTestId('confirm-cancel-order').click()
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    expect(writes.map((w) => JSON.parse(w)), 'exactly one write, the literal empty cart').toEqual([{ items: [] }])
  })

  test('entry point 2 of 3: the ghost cancel under the cartbar actions', async ({ page }) => {
    const { product, link } = await scenario('ghostedit')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 2 }])
    const writes = recordWrites(page, link.token)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await page.getByTestId('cancel-order').click()
    await expectConfirmModal(page)
    await page.getByTestId('confirm-cancel-order').click()

    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    // ⚠ A CART WITH TWO BAGS IN IT still cancels with `items: []` — the payload is
    // the intent, never the current cart.
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ items: [] }])
    expect((await (await getStatus(link.token, created.order.order_token)).json()).order.status).toBe('cancelled')
  })

  test('entry point 3 of 3: the paid-frozen direct cancel — no edit mode to enter', async ({ page }) => {
    const { product, link } = await scenario('ghostpaid')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)
    const writes = recordWrites(page, link.token)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('start-edit'), 'there IS no edit mode here').toHaveCount(0)

    await page.getByTestId('cancel-order').click()
    await expectConfirmModal(page)
    await page.getByTestId('confirm-cancel-order').click()

    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    expect(writes.map((w) => JSON.parse(w))).toEqual([{ items: [] }])

    // `paid` SURVIVES the cancel — it is the refund signal (GSO-T6), and the row
    // lands in the admin's refund queue rather than vanishing.
    const reread = await (await getStatus(link.token, created.order.order_token)).json()
    expect(reread.order.status).toBe('cancelled')
    expect(reread.order.paid).toBe(1)
  })

  test('⚠ every OTHER payload is a non-destructive 400 — the order survives and stays editable', async ({ page }) => {
    const { product, link } = await scenario('malformedui')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const path = statusPath(link.token, created.order.order_token)

    // Every shape a client bug, a body-stripping proxy or a wrong content-type can
    // produce. None of them may be read as "empty the cart".
    expect((await ctx.put(path, { data: {} })).status(), 'PUT {}').toBe(400)
    expect((await ctx.put(path)).status(), 'no body at all').toBe(400)
    for (const items of ['[]', { 0: {} }, 0, null, false]) {
      expect((await ctx.put(path, { data: { items } })).status(), `items: ${JSON.stringify(items)}`).toBe(400)
    }
    // Lines WERE sent but none price: "I sent you lines and you deleted my order"
    // is never what the caller meant.
    expect((await ctx.put(path, {
      data: { items: [{ product_id: product.id, variant: 'zzz', quantity: 2 }] },
    })).status(), 'non-empty but unpriceable').toBe(400)

    // The page still renders a live, editable order — which the TERMINAL cancelled
    // state would have made impossible forever.
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('status-cancelled')).toHaveCount(0)
    await expect(page.getByTestId('status-total')).toHaveText('10.00 EUR')
    await expect(page.getByTestId('status-item')).toHaveCount(1)
    await expect(page.getByTestId('start-edit')).toBeVisible()
  })

  test('the confirm is `v-if`-mounted: no dialog, no scrim, no footer buttons until it opens', async ({ page }) => {
    const { product, link } = await scenario('vifconfirm')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    // An always-mounted dialog would leave `.modal-scrim` (pointer-events:auto over
    // the whole viewport) swallowing the clicks three immutable guest specs make.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim')).toHaveCount(0)
    await expect(page.getByTestId('keep-order')).toHaveCount(0)
    await expect(page.getByTestId('confirm-cancel-order')).toHaveCount(0)

    await page.getByTestId('cancel-order').click()
    await expect(page.locator('.modal-scrim')).toHaveCount(1)
    // The × is a deliberate SYNONYM — Playwright matches accessible names as a
    // case-insensitive SUBSTRING, and no label here may contain another's.
    await expect(page.locator('.m-x')).toHaveAttribute('aria-label', 'Zatvoriť dialóg')

    await page.getByTestId('keep-order').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim'), 'the scrim must not linger').toHaveCount(0)
  })

  test('⚠ the 320px confirm footer fits by MIN-CONTENT, not by flex resolution', async ({ page }) => {
    const { product, link } = await scenario('confirm320')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await page.getByTestId('cancel-order').click()
    await expect(page.getByRole('dialog').locator('.m-title')).toHaveText('Zrušiť objednávku?')

    // `.btn` is `white-space:nowrap` and `.m-foot .btn` is `flex:1`, so an
    // overflowing row gives NO degradation signal: the flex-resolved width always
    // sums to the container. Clone at `width:min-content` for the real need.
    const fit = await page.getByRole('dialog').locator('.m-foot').evaluate((foot) => {
      const cs = getComputedStyle(foot)
      const available = foot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const clone = foot.cloneNode(true)
      clone.style.position = 'absolute'
      clone.style.visibility = 'hidden'
      clone.style.width = 'min-content'
      foot.parentNode.appendChild(clone)
      const need = Array.from(clone.children).reduce((s, c) => s + c.getBoundingClientRect().width, 0)
        + parseFloat(getComputedStyle(clone).gap || 0) * (clone.children.length - 1)
      clone.remove()
      return { available, need }
    })
    expect(fit.need, `min-content ${fit.need} must fit ${fit.available}`).toBeLessThanOrEqual(fit.available)
  })
})

// ---------------------------------------------------------------------------
// (E) the paid freeze, and the flags this page must never write

test.describe('RD-GX-3 · the paid freeze (§UC-GX-006, GSO-T6)', () => {
  test('a guest may CANCEL a paid sub-order but may NOT change what they owe — and clearing `paid` unfreezes it', async ({ page }) => {
    const { product, link } = await scenario('unfreeze')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    // The affordance and the backend agree in BOTH directions: no edit button, and
    // a non-empty edit is refused if one is forged.
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
    await expect(page.getByTestId('cancel-order'), 'but calling it off stays the guest\'s own call').toBeVisible()

    const frozen = await ctx.put(statusPath(link.token, created.order.order_token), {
      data: { items: [{ product_id: product.id, variant: '1kg', quantity: 3 }] },
    })
    expect(frozen.status(), 'what is owed cannot change after the money arrived').toBe(409)
    expect((await frozen.json()).reason).toBe('paid')

    // ⚠ STATE-BASED, NOT TERMINAL: a mis-matched payment the admin clears must
    // unfreeze the order, or the guest is stuck forever on someone else's mistake.
    expect((await setPaid(created.order.id, false)).status()).toBe(200)
    const payload = await (await getStatus(link.token, created.order.order_token)).json()
    expect(payload.items_editable, 'items_editable = editable && !paid').toBe(true)

    await page.reload()
    await expect(page.getByTestId('status-paid')).toHaveText('Nezaplatené')
    await expect(page.getByTestId('start-edit'), 'the edit affordance comes back').toBeVisible()
    await expect(page.getByTestId('cancel-order'), 'and the direct cancel steps aside for edit mode').toHaveCount(0)
  })

  test('⚠ the `items_editable === undefined` fallback for older payloads stays', async ({ page }) => {
    const { product, link } = await scenario('fallback')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    const path = `**/api/guest/${link.token}/orders/${created.order.order_token}`

    // A payload from before the paid freeze carried only `editable`. Falling back to
    // "not editable" would silently lock every guest out of their own cart on any
    // deployment where the frontend is ahead of the backend.
    await page.route(path, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      delete body.items_editable
      expect(body.editable, 'the older flag is what the fallback reads').toBe(true)
      await route.fulfill({ response: res, body: JSON.stringify(body) })
    })

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('start-edit'), 'falls back to `editable`, not to locked').toBeVisible()
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId(`product-${product.id}`)).toBeVisible()

    // The other half of the fallback: with `editable` false and no `items_editable`,
    // it must still refuse — the fallback is permissive about the FLAG, never about
    // the state.
    await page.unroute(path)
    await page.route(path, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      delete body.items_editable
      body.editable = false
      await route.fulfill({ response: res, body: JSON.stringify(body) })
    })
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
    await expect(page.getByTestId('status-readonly')).toBeVisible()
  })

  test('the page offers no control that could write `paid` or `delivered`', async ({ page }) => {
    const { product, link } = await scenario('readonlyflags')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)

    // Decision 2, single owner per flag: `paid` is the ADMIN's, `delivered` is the
    // HOST's. Both are `<span>`s here, not buttons, checkboxes or inputs.
    for (const id of ['status-paid', 'status-delivered']) {
      const tag = await page.getByTestId(id).evaluate((el) => el.tagName)
      expect(tag, `${id} is display-only`).toBe('SPAN')
      await expect(page.getByTestId(id).locator('button, input, [role="button"], [role="checkbox"]')).toHaveCount(0)
    }
  })
})

// ---------------------------------------------------------------------------
// (F) the invite CTA — the server flag wins over the prototype

test.describe('RD-GX-3 · the invite CTA in all four states (§UC-GX-006 item 6)', () => {
  test('⚠ rendered whenever the server says `available` — cancelled included (resolved conflict #3)', async ({ page }) => {
    const { cycle, product, link } = await scenario('cta')
    const line = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const editable = await submitGuest(link.token, line)
    const paid = await submitGuest(link.token, line, { guest_name: 'CTA Paid', guest_phone: '0905 111 222' })
    const cancelled = await submitGuest(link.token, line, { guest_name: 'CTA Zrusena', guest_phone: '0906 111 222' })
    const locked = await submitGuest(link.token, line, { guest_name: 'CTA Locked', guest_phone: '0907 111 222' })
    expect((await setPaid(paid.order.id, true)).status()).toBe(200)
    expect((await ctx.put(statusPath(link.token, cancelled.order.order_token), { data: { items: [] } })).status()).toBe(200)

    // The server sets `available` from the link and host being alive — deliberately
    // ignoring the lock AND the cancelled state (GSO-T10): a guest asks for an
    // account precisely when the coffee has arrived, and a called-off sub-order is
    // still a lead. The PROTOTYPE hides the CTA when cancelled; the server wins.
    await page.setViewportSize(PHONE)
    for (const [name, sub] of [['editable', editable], ['paid-frozen', paid], ['cancelled', cancelled]]) {
      const payload = await (await getStatus(link.token, sub.order.order_token)).json()
      expect(payload.invite_request.available, `${name}: the server offers it`).toBe(true)
      await page.goto(`/g/${link.token}/o/${sub.order.order_token}`)
      await expect(page.getByTestId('invite-cta'), `${name}: so the page renders it`).toBeVisible()
    }

    await setCycleStatus(cycle.id, 'locked')
    await page.goto(`/g/${link.token}/o/${locked.order.order_token}`)
    await expect(page.getByTestId('status-readonly')).toBeVisible()
    await expect(page.getByTestId('invite-cta'), 'read-only: the fourth state').toBeVisible()
  })

  test('a dead link withdraws it — the page never offers what the endpoint would 410', async ({ page }) => {
    const { host, product, link } = await scenario('ctadead')
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth })).status(), 'deactivate').toBe(200)
    const payload = await (await getStatus(link.token, created.order.order_token)).json()
    expect(payload.invite_request.available, 'the lead would be credited to a dead host').toBe(false)

    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${created.order.order_token}`)
    // GSO-T4's read resolver is 404-ONLY, so the receipt still renders …
    await expect(page.getByTestId('guest-status')).toBeVisible()
    await expect(page.getByTestId('status-readonly')).toBeVisible()
    // … but nothing that would be refused is on screen.
    await expect(page.getByTestId('invite-cta')).toHaveCount(0)
    await expect(page.getByTestId('start-edit')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (G) 320px

test.describe('RD-GX-3 · 320px (§UC-DS-005)', () => {
  test('no horizontal overflow in any state, read or edit', async ({ page }) => {
    const { cycle, product, link } = await scenario('narrow')
    const line = [{ product_id: product.id, variant: '250g', quantity: 1 }]
    const editable = await submitGuest(link.token, line)
    const paid = await submitGuest(link.token, line, { guest_name: 'Uzka Pani', guest_phone: '0908 111 222' })
    const cancelled = await submitGuest(link.token, line, { guest_name: 'Uzka Zrusena', guest_phone: '0909 111 222' })
    expect((await setPaid(paid.order.id, true)).status()).toBe(200)
    expect((await ctx.put(statusPath(link.token, cancelled.order.order_token), { data: { items: [] } })).status()).toBe(200)

    await page.setViewportSize({ width: 320, height: 900 })
    const noOverflow = () => page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }))

    for (const sub of [editable, paid, cancelled]) {
      await page.goto(`/g/${link.token}/o/${sub.order.order_token}`)
      await expect(page.getByTestId('guest-status')).toBeVisible()
      const m = await noOverflow()
      expect(m.scrollW, `read view at 320px`).toBeLessThanOrEqual(m.clientW)
    }

    // Edit mode adds the grid and the cartbar, which is where the width goes.
    await page.goto(`/g/${link.token}/o/${editable.order.order_token}`)
    await page.getByTestId('start-edit').click()
    await expect(page.getByTestId(`product-${product.id}`)).toBeVisible()
    const edit = await noOverflow()
    expect(edit.scrollW, 'edit mode at 320px').toBeLessThanOrEqual(edit.clientW)

    // …and the locked state, whose banner carries the longest sentence on the page.
    await setCycleStatus(cycle.id, 'locked')
    await page.goto(`/g/${link.token}/o/${editable.order.order_token}`)
    await expect(page.getByTestId('status-readonly')).toBeVisible()
    const locked = await noOverflow()
    expect(locked.scrollW, 'locked banner at 320px').toBeLessThanOrEqual(locked.clientW)
  })
})
