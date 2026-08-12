import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'
// ⚠ CROSS-TREE IMPORT, DELIBERATE. `bysquare` and `qrcode` are the frontend's own
// dependencies — the very packages `PaymentModal.vue` generates the code with — and
// this file must encode INDEPENDENTLY of the app to be worth anything. Adding a
// second copy under `e2e/` (or a QR-decoder package) would be a new dependency for
// no gain: the e2e recipe already builds the frontend, so its `node_modules` is
// present by construction. If this import ever fails, run `npm install` in
// `frontend/` — do NOT weaken it into a `test.skip`, it guards money.
import { encode, decode, PaymentOptions, CurrencyCode, Version } from '../../frontend/node_modules/bysquare/lib/index.js'
import QRCode from '../../frontend/node_modules/qrcode/lib/index.js'

// RD-GX-2 — the shared "Platba" modal (06 §UC-GX-005) and the g-confirm screen
// (§UC-GX-004).
//
// `guest-order.spec.js`, `guest-status.spec.js` and `guest-lead-capture.spec.js`
// already cover the behaviour end to end and are edited only where §UC-GX-011
// mandates it. This file adds what a re-skin of a PAYMENT surface can break
// silently — every item below fails with no build error:
//
// (A) THE QR IS MONEY A BANK APP SCANS. `.qr` is 190×190 of ink frame whether or
//     not what sits in it resolves, and the prototype ships a pseudo-QR generator
//     that would look perfect in a screenshot and be worthless in a phone camera.
//     So the code is read OFF THE RENDERED PIXELS as a module matrix and compared,
//     bit for bit, against an INDEPENDENT `bysquare.encode()` of the same inputs —
//     which is then `bysquare.decode()`d to prove the payload really carries the
//     amount, the IBAN and the server-owned reference. Identical module matrices
//     mean a scanner reads identical bytes; this is the same bar RD-FO-4 set for
//     the friend success modal.
//
// (B) THE MOUNT IS `v-if`. `NeoModal` has no `open` prop, and `PaymentModal` is
//     mounted PERMANENTLY by `FriendOrder.vue` with `:open="false"`. An
//     always-mounted `NeoModal` inside it would therefore park a second "Zavrieť"
//     and a full-viewport `.modal-scrim` (pointer-events:auto) in the DOM of every
//     friend order page and every guest screen — swallowing every click behind it,
//     and colliding with the UNSCOPED `getByRole('button', { name: 'Zavrieť' })`
//     three shipped, non-editable guest specs use. Asserted from the guest side AND
//     the friend side.
//
// (C) MODULE 04 INHERITS THE RESTYLE WITH NO CHANGE ON ITS SIDE. The theme tokens
//     live on `.app, .modal-layer` precisely so a teleported modal is themed from a
//     caller whose own root is not `.app`. Verified by opening the same modal from
//     the FRIEND cart bar and measuring the same anatomy — including the reference
//     row, which is new for friends too (the prototype's intent).
//
// (D) SECTION ORDER AND THE REFERENCE'S NEW HOME. Revolut → QR/IBAN → reference is
//     fixed by the prototype, and resolved conflict #4 moved the reference row OFF
//     the confirmation card INTO this modal. Both halves are asserted: the order of
//     `.m-body`'s children, and the absence of any reference on g-confirm.
//
// (E) THE 320px FOOTER GIVES NO DEGRADATION SIGNAL. `.btn` is `white-space:nowrap`
//     and `.m-foot .btn` is `flex:1`, so a footer that does not fit neither wraps
//     nor shrinks nor ellipsises. MIN-CONTENT is measured, not the flex-resolved
//     width (which always sums to the container and hides the overflow).
//
// Hermetic: its own friend, cycle, product and guest link.

const TIMEOUT = 20_000
const PHONE = { width: 378, height: 900 }

let ctx = null
let adminToken = ''
let host = null
let cycle = null
let coffee = null
let link = null
let guestOrder = null

const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

async function makeHost() {
  const username = `gx2pay_${uniq}`.slice(0, 30)
  const name = `Peto Pay ${uniq}`
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
  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token

  host = await makeHost()

  const name = `RDGX2 Platba ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  cycle = { ...(await res.json()), name }
  expect((await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: { markup_ratio: 1.25 } })).status()).toBe(200)

  const p = await admin('/api/products', {
    method: 'post',
    data: { cycle_id: cycle.id, name: `Platba Kava ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 },
  })
  expect(p.status()).toBe(201)
  coffee = await p.json()

  const share = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
  expect([200, 201]).toContain(share.status())
  link = (await share.json()).link

  // One real guest sub-order placed the only way one can be: through the public
  // checkout behind the host's link. Its `payment` block is what the modal is fed.
  const submit = await ctx.post(`/api/guest/${link.token}/orders`, {
    data: {
      guest_name: 'Marek Platba', guest_phone: '0901 234 567',
      items: [{ product_id: coffee.id, variant: '250g', quantity: 2 }],
    },
  })
  expect(submit.status(), 'guest submit').toBe(201)
  guestOrder = await submit.json()
  expect(guestOrder.payment.iban, 'the seed configures payment settings').toBeTruthy()
  expect(guestOrder.payment.revolut_username).toBeTruthy()
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ---------------------------------------------------------------------------
// helpers

/** Opens the modal from the guest STATUS page — the shortest route to it. */
async function openFromStatus(page) {
  await page.setViewportSize(PHONE)
  await page.goto(`/g/${link.token}/o/${guestOrder.order.order_token}`)
  await page.getByTestId('open-payment').click()
  const d = page.getByRole('dialog')
  await expect(d.locator('.m-title')).toHaveText('Platba')
  return d
}

/**
 * Reads the QR's module matrix off the RENDERED PIXELS of the <img>. Everything
 * here is derived from the image alone — the bounding box of the dark modules, the
 * module pitch from the 7-module top-left finder run, and the symbol size snapped
 * to the only legal series (21, 25, … ≡ 1 mod 4). Nothing about the expected
 * payload leaks in.
 */
async function readModules(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('.qr img')
    if (!img) return { error: 'no img' }
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const n = img.naturalWidth
    const cv = document.createElement('canvas')
    cv.width = n
    cv.height = n
    const cx = cv.getContext('2d')
    cx.drawImage(img, 0, 0)
    const px = cx.getImageData(0, 0, n, n).data
    const dark = (x, y) => px[(y * n + x) * 4] < 128

    let minX = n, minY = n, maxX = -1, maxY = -1
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!dark(x, y)) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return { error: 'all light' }

    let run = 0
    while (dark(minX + run, minY)) run++
    const width = maxX - minX + 1
    // The module pitch is fractional (a 45-module symbol painted into 234 px), so
    // `width / pitch` lands near — not on — the true size. Snap it to the series.
    const approx = width / (run / 7)
    let size = 21
    let best = Infinity
    for (let s = 21; s <= 177; s += 4) {
      const d = Math.abs(s - approx)
      if (d < best) { best = d; size = s }
    }
    const step = width / size
    const rows = []
    for (let r = 0; r < size; r++) {
      let line = ''
      for (let c = 0; c < size; c++) {
        line += dark(Math.round(minX + (c + 0.5) * step), Math.round(minY + (r + 0.5) * step)) ? '1' : '0'
      }
      rows.push(line)
    }
    return { size, matrix: rows.join('\n') }
  })
}

/**
 * The independent encode: the same inputs through the same two libraries, in Node,
 * with no knowledge of the component. `paymentDueDate` is "today" exactly as
 * `PaymentModal.generateQr()` computes it.
 */
function independentQr(amount, reference, iban) {
  const t = new Date()
  const dateStr = t.getFullYear().toString()
    + (t.getMonth() + 1).toString().padStart(2, '0')
    + t.getDate().toString().padStart(2, '0')
  const qrString = encode({
    invoiceId: '',
    payments: [{
      type: PaymentOptions.PaymentOrder,
      amount,
      currencyCode: CurrencyCode.EUR,
      paymentDueDate: dateStr,
      variableSymbol: '',
      constantSymbol: '',
      specificSymbol: '',
      originatorsReferenceInformation: '',
      paymentNote: reference || '',
      bankAccounts: [{ iban: iban.replace(/\s/g, ''), bic: '' }],
      beneficiary: { name: 'Gorifi', street: '', city: '' },
    }],
  }, { version: Version['1.0.0'] })
  const qr = QRCode.create(qrString, { errorCorrectionLevel: 'M' })
  const rows = []
  for (let r = 0; r < qr.modules.size; r++) {
    let line = ''
    for (let c = 0; c < qr.modules.size; c++) line += qr.modules.get(r, c) ? '1' : '0'
    rows.push(line)
  }
  return { qrString, size: qr.modules.size, matrix: rows.join('\n') }
}

// ---------------------------------------------------------------------------
// (A) the QR

test.describe('RD-GX-2 · the Pay-by-Square payload (§UC-GX-005)', () => {
  test('⚠ the RENDERED PIXELS decode to the same payload as an independent encode', async ({ page }) => {
    const d = await openFromStatus(page)
    await expect(d.getByAltText('Pay by Square QR')).toBeVisible()

    const scanned = await readModules(page)
    expect(scanned.error).toBeUndefined()

    const expected = independentQr(
      guestOrder.payment.amount,
      guestOrder.payment.reference,
      guestOrder.payment.iban,
    )

    expect(scanned.size, 'a real QR grid size (21 + 4k)').toBe(expected.size)
    expect((scanned.size - 21) % 4).toBe(0)
    // Bit for bit. Identical module matrices ⇒ identical encoded bytes, version and
    // mask ⇒ a scanner reads exactly `expected.qrString`.
    expect(scanned.matrix, 'the scanned code IS the independent encode').toBe(expected.matrix)

    // …and that string really is the payment, not merely a stable blob.
    const decoded = decode(expected.qrString)
    const pay = decoded.payments[0]
    expect(pay.amount).toBe(guestOrder.payment.amount)
    expect(pay.currencyCode).toBe('EUR')
    expect(pay.bankAccounts[0].iban).toBe(guestOrder.payment.iban.replace(/\s/g, ''))
    // The reference is SERVER-owned (`guestPaymentReference()`), never composed here.
    expect(pay.paymentNote).toBe(guestOrder.payment.reference)
    expect(pay.paymentNote).toBe(`G${guestOrder.order.id} / Marek Platba / ${cycle.name}`)
    expect(pay.beneficiary.name).toBe('Gorifi')
  })

  test('a generation failure shows the shipped error copy — never an empty frame, never a fake QR', async ({ page }) => {
    // ⚠ SYNTHETIC TRIGGER, and deliberately so. `bysquare.encode()` is permissive
    // (a malformed IBAN, a non-numeric amount and an unknown currency all encode
    // happily — measured), so the only lever the network offers on the catch arm is
    // a non-string `iban`, which makes `props.iban.replace(...)` throw. What is
    // being pinned is the ARM, not the trigger: the error string is one of the two
    // the restyle must carry over byte-identically, and on failure the frame must
    // not paint — `ui.jsx`'s pseudo-QR grid is prototype-only and a blank 190×190
    // ink box would read as "scan me".
    await page.setViewportSize(PHONE)
    await page.route(`**/api/guest/${link.token}/orders/${guestOrder.order.order_token}`, async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      body.payment = { ...body.payment, iban: 123456 }
      await route.fulfill({ response: res, body: JSON.stringify(body) })
    })
    await page.goto(`/g/${link.token}/o/${guestOrder.order.order_token}`)
    await page.getByTestId('open-payment').click()
    const d = page.getByRole('dialog')
    await expect(d).toContainText('Nepodarilo sa vygenerovat QR kod.')
    await expect(d.locator('.qr'), 'no empty ink frame').toHaveCount(0)
    await expect(d.locator('.qr .grid'), 'the prototype pseudo-QR is never rendered').toHaveCount(0)
    // The IBAN line still prints what the guest was given, and Revolut still works —
    // one broken half must not take the whole payment surface down.
    await expect(d.locator('.sub.mono')).toContainText('IBAN: 123456')
    await expect(d.getByRole('link', { name: /Revolut/ })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// (B) + (D) the modal shell

test.describe('RD-GX-2 · the Platba modal shell (§UC-GX-005)', () => {
  test('⚠ it is `v-if`-MOUNTED: no dialog, no scrim and no "Zavrieť" exist until it opens', async ({ page }) => {
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}/o/${guestOrder.order.order_token}`)
    await expect(page.getByTestId('open-payment')).toBeVisible()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Zavrieť' }), 'three immutable specs query this unscoped').toHaveCount(0)
    // ⚠ THE DEFERRED HALF, LANDED (RD-GX-4). This used to be a comment explaining
    // why `payment-reference` count 0 was NOT asserted here: RD-GX-3 owned
    // `GuestOrderStatus.vue` and that page still rendered its own on-card reference
    // row, so a closed modal did not mean no reference on screen. RD-GX-3 removed
    // that row (resolved conflict #4), so the assertion the comment was deferring is
    // now the real contract — and it is the one that actually pins "modal-only":
    // without it, re-adding an on-card row would leave every test in this file green.
    await expect(page.getByTestId('payment-reference'), 'modal-only: nothing on the card').toHaveCount(0)

    await page.getByTestId('open-payment').click()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.modal-scrim')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Zavrieť' })).toHaveCount(1)

    // The × is a deliberate SYNONYM: Playwright matches accessible names as a
    // case-insensitive SUBSTRING, so "Zavrieť dialóg" would resolve to two nodes.
    await expect(page.locator('.m-x')).toHaveAttribute('aria-label', 'Zatvoriť dialóg')

    await page.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim'), 'the scrim must not linger to swallow clicks').toHaveCount(0)
  })

  test('anatomy at 378px: title, mono subtitle, and the fixed Revolut → QR → reference order', async ({ page }) => {
    const d = await openFromStatus(page)

    // Rich subtitle — the sum is mono (02 §UC-DS-012's money convention).
    await expect(d.locator('.m-head .sub')).toHaveText('Suma na úhradu: 25.00 EUR')
    await expect(d.locator('.m-head .sub b')).toHaveClass(/\bmono\b/)
    expect(await d.locator('.m-head .sub b').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Courier/i)

    // ⚠ SECTION ORDER IS FIXED (prototype): Revolut, then the QR block, then the
    // reference. `.m-body` is the 12px-gap flex column, so its children ARE the
    // sections — an accidental reorder is invisible in any behaviour spec.
    const order = await d.locator('.m-body').evaluate((el) =>
      Array.from(el.children).map((c) => (c.tagName === 'A' ? 'revolut' : c.querySelector('.qr, .sub.mono') ? 'qr' : c.querySelector('.copyrow') ? 'reference' : c.tagName)))
    expect(order).toEqual(['revolut', 'qr', 'reference'])

    // 1. the Revolut bar: prototype blue on an INK border, full width, real link.
    const rev = d.getByRole('link', { name: /Revolut/ })
    await expect(rev).toHaveAttribute('target', '_blank')
    await expect(rev).toHaveAttribute('rel', 'noopener noreferrer')
    expect(await rev.getAttribute('href')).toBe(`https://revolut.me/${guestOrder.payment.revolut_username}`)
    const revStyle = await rev.evaluate((el) => {
      const cs = getComputedStyle(el)
      const p = el.parentElement
      const pcs = getComputedStyle(p)
      return {
        bg: cs.backgroundColor,
        color: cs.color,
        border: cs.borderTopColor,
        w: el.getBoundingClientRect().width,
        parent: p.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight),
      }
    })
    expect(revStyle.bg).toBe('rgb(0, 117, 235)')
    expect(revStyle.color).toBe('rgb(255, 255, 255)')
    expect(revStyle.border, 'the border stays ink, not blue').toBe('rgb(10, 10, 10)')
    expect(revStyle.w, '.btn.block spans the body').toBeCloseTo(revStyle.parent, 0)

    // 2. the QR in the 190×190 ink frame (02 §UC-DS-012).
    const frame = await d.locator('.qr').evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const img = el.querySelector('img').getBoundingClientRect()
      return { w: r.width, h: r.height, border: cs.borderTopWidth, pad: cs.paddingTop, imgW: img.width, imgH: img.height }
    })
    expect(frame.w).toBe(190)
    expect(frame.h).toBe(190)
    expect(frame.border).toBe('3px')
    expect(frame.pad).toBe('10px')
    // 190 − 2×3 border − 2×10 padding
    expect(frame.imgW).toBe(164)
    expect(frame.imgH).toBe(164)

    // 3. the mono IBAN line.
    const iban = d.locator('.sub.mono')
    await expect(iban).toHaveText(`IBAN: ${guestOrder.payment.iban}`)
    expect(await iban.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Courier/i)

    // 4. the footer: exactly one button, named exactly "Zavrieť".
    await expect(d.locator('.m-foot button')).toHaveText(['Zavrieť'])
  })

  test('⚠ the reference row: testid on the `.copyrow` ROOT, value as text, button as its child', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-write'])
    const d = await openFromStatus(page)

    const row = d.getByTestId('payment-reference')
    // §UC-GX-011 item 2 reads the text off this node; item 4 reaches the button
    // through it. Both only work if the testid falls through to the ROOT.
    await expect(row).toHaveClass(/\bcopyrow\b/)
    await expect(row).toContainText(`G${guestOrder.order.id} / Marek Platba / ${cycle.name}`)
    await expect(row.locator('.val')).toHaveText(guestOrder.payment.reference)
    expect(await row.locator('.val').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Courier/i)

    await expect(d.locator('.field-lbl')).toHaveText('Poznámka k platbe (uveďte ju pri platbe)')

    // The 2 s flip, with the exclamation mark (resolved conflict #6, UC-DS-011).
    const copy = row.getByRole('button')
    await expect(copy).toHaveText('Kopírovať')
    await copy.click()
    await expect(copy).toHaveText('Skopírované!')
    await expect(copy).toHaveClass(/\bok\b/)
    await expect(copy).toHaveText('Kopírovať', { timeout: 5000 })
  })

  test('⚠ the 320px footer fits by MIN-CONTENT, not by flex resolution', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto(`/g/${link.token}/o/${guestOrder.order.order_token}`)
    await page.getByTestId('open-payment').click()
    const d = page.getByRole('dialog')
    await expect(d.locator('.m-title')).toHaveText('Platba')

    const fit = await d.locator('.m-foot').evaluate((foot) => {
      const cs = getComputedStyle(foot)
      const available = foot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      // The flex-resolved width ALWAYS sums to the container, so it can never show
      // the overflow. Clone the row at `width:min-content` to get the real need.
      const clone = foot.cloneNode(true)
      clone.style.position = 'absolute'
      clone.style.visibility = 'hidden'
      clone.style.width = 'min-content'
      foot.parentNode.appendChild(clone)
      const need = Array.from(clone.children).reduce((s, c) => s + c.getBoundingClientRect().width, 0)
        + parseFloat(cs.columnGap || cs.gap || 0) * (clone.children.length - 1)
      clone.remove()
      return { available, need }
    })
    expect(fit.need, `min-content ${fit.need} must fit ${fit.available}`).toBeLessThanOrEqual(fit.available)

    // And nothing paints outside the modal.
    const overflow = await page.evaluate(() => {
      const scrim = document.querySelector('.modal-scrim')
      return scrim.scrollWidth - scrim.clientWidth
    })
    expect(overflow, 'no horizontal scrollbar on the scrim').toBeLessThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// (C) module 04 inherits it

test.describe('RD-GX-2 · module 04 inherits the restyle (§UC-GX-005 shared-consumer contract)', () => {
  test('⚠ the SAME modal, fully themed, opened from the FRIEND cart bar — no change on module 04\'s side', async ({ page }) => {
    // A submitted friend order is what puts "Zaplatiť" in the cart bar.
    const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${host.id}`, {
      headers: host.auth, data: { items: [{ product_id: coffee.id, variant: '250g', quantity: 1 }] }, timeout: TIMEOUT,
    })
    expect(put.status(), 'seed friend cart').toBe(200)
    expect((await ctx.post(`/api/orders/cycle/${cycle.id}/friend/${host.id}/submit`, {
      headers: host.auth, data: {}, timeout: TIMEOUT,
    })).status(), 'seed friend submit').toBe(200)

    await page.setViewportSize(PHONE)
    await page.addInitScript((value) => {
      localStorage.clear()
      localStorage.setItem('gorifi_friend_auth', value)
    }, JSON.stringify({
      friendId: host.id, friendName: host.name, token: host.token,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }))
    await page.route('**/api/pickup-locations*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))

    await page.goto('/')
    await page.getByRole('heading', { name: cycle.name, exact: true }).click()
    await expect(page.locator('.app .cartbar')).toBeVisible()

    // (B) from the friend side: `FriendOrder.vue` mounts `<PaymentModal>`
    // PERMANENTLY with `:open="false"`, so an always-mounted `NeoModal` inside it
    // would put a scrim over this page at all times.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim')).toHaveCount(0)

    await page.locator('.app .cartbar').getByRole('button', { name: 'Zaplatiť', exact: true }).click()
    const d = page.getByRole('dialog')
    await expect(d.locator('.m-title')).toHaveText('Platba')

    // Fully themed although it was opened from module 04: the tokens ride on
    // `.modal-layer`, which is what makes the teleport out of `.app` safe.
    const themed = await d.evaluate((el) => {
      const cs = getComputedStyle(el)
      const title = getComputedStyle(el.querySelector('.m-title'))
      const layer = el.closest('.modal-layer')
      return {
        border: cs.borderTopWidth,
        titleFont: title.fontFamily,
        displayToken: getComputedStyle(layer).getPropertyValue('--font-display').trim(),
        accent: getComputedStyle(layer).getPropertyValue('--accent').trim(),
        insideApp: !!el.closest('.app'),
      }
    })
    expect(themed.border, 'the neo 4px ink border, not a shadcn card').toBe('4px')
    expect(themed.insideApp, 'teleported OUT of `.app` — which is the whole point').toBe(false)
    expect(themed.accent, 'tokens resolve outside `.app`, because they ride on `.modal-layer`').toBe('#ff2d87')
    expect(themed.displayToken).toContain('Darker Grotesque')
    expect(themed.titleFont, 'the display face, resolved from the token').toContain('Darker Grotesque')

    // The reference row appears for FRIENDS too — the prototype's intent. The
    // friend reference is `{meno} / {cyklus}` (composed by module 04, not here).
    await expect(d.getByTestId('payment-reference')).toContainText(`${host.name} / ${cycle.name}`)
    await expect(d.locator('.qr img')).toBeVisible()
    await expect(d.getByRole('link', { name: /Revolut/ })).toBeVisible()

    await d.getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.modal-scrim')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// (D) g-confirm

test.describe('RD-GX-2 · g-confirm (§UC-GX-004)', () => {
  /** Submits a fresh sub-order through the UI and lands on the confirmation. */
  async function submitThrough(page) {
    await page.setViewportSize(PHONE)
    await page.goto(`/g/${link.token}`)
    const card = page.getByTestId(`product-${coffee.id}`)
    await card.getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    const checkout = page.getByRole('dialog')
    await checkout.getByTestId('guest-name').fill('Zuzka Confirm')
    await checkout.getByTestId('guest-phone').fill('0902 111 222')
    await checkout.getByTestId('guest-submit').click()
    await expect(page.getByTestId('guest-confirmation')).toBeVisible({ timeout: TIMEOUT })
    // The Platba modal auto-opens (§UC-GSO-003) — close it to reach the card.
    await page.getByRole('dialog').getByRole('button', { name: 'Zavrieť' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }

  test('the composition: brand subtitle, highlighted headline with room to breathe, 520px column', async ({ page }) => {
    await submitThrough(page)

    await expect(page.locator('.appbar .titles .s')).toHaveText('Objednávka odoslaná')

    const col = page.getByTestId('guest-confirmation')
    const geom = await col.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { maxW: cs.maxWidth, padTop: cs.paddingTop, padLeft: cs.paddingLeft, gap: cs.rowGap }
    })
    expect(geom.maxW).toBe('520px')
    expect(geom.padLeft, '16px on a phone').toBe('16px')
    expect(geom.padTop).toBe('16px')
    expect(geom.gap).toBe('16px')

    // ⚠ 2026-08-12: the rotated green "✔ Odoslané" badge is REMOVED — it was the
    // third statement of one fact (badge + headline + appbar subtitle). Asserted as
    // an absence so a revert cannot land unnoticed.
    await expect(col.locator('.badge.ok-solid'), 'the green confirmation badge is gone').toHaveCount(0)
    expect(await col.innerText()).not.toMatch(/Odoslané/)

    const h1 = col.locator('h1.h-screen')
    // ⚠ Vue's `condense` deletes a newline-bearing whitespace node between two
    // elements; "Objednávkaje" is what that looks like.
    await expect(h1).toHaveText('Objednávka je odoslaná')
    await expect(h1.locator('.hl')).toHaveText('odoslaná')
    expect(await h1.evaluate((el) => getComputedStyle(el).fontSize), '34px on a phone').toBe('34px')

    // ⚠ THE HEADLINE'S LEADING, AND WHY IT IS MEASURED AS GEOMETRY. This headline
    // wraps onto two lines on a phone and `.hl` paints a filled block with a `0 4px 0`
    // underline shadow, so at the theme's `.h-screen{line-height:.95}` the second
    // line's block overlapped the descenders above it. A text assertion cannot see
    // that. Read back: the override is in force, and the highlighted line's box
    // really does clear the line above it.
    const lead = await h1.evaluate((el) => {
      const cs = getComputedStyle(el)
      const hl = el.querySelector('.hl').getBoundingClientRect()
      // The first line's baseline area: the h1's own top edge plus one line box.
      const box = el.getBoundingClientRect()
      return { lh: cs.lineHeight, fs: parseFloat(cs.fontSize), hlTop: hl.top, boxTop: box.top, h: box.height }
    })
    expect(parseFloat(lead.lh) / lead.fs, 'the .95 canon is overridden for this wrapped headline')
      .toBeGreaterThan(1.2)
    expect(lead.hlTop - lead.boxTop, 'the highlighted line starts below the first line, not over it')
      .toBeGreaterThan(lead.fs)

    const sub = col.locator('.sub').first()
    await expect(sub).toHaveText(`${cycle.name} · organizuje ${host.name.split(' ')[0]}`)
    // 20px, not the shipped 10px — the underline shadow eats 4px of it.
    await expect(sub).toHaveCSS('margin-top', '20px')
  })

  test('the sum card: display total, divider, and the shared `CartLineList` columns', async ({ page }) => {
    await submitThrough(page)
    // ⚠ `.first()` — RD-GX-4 made `GuestInviteRequest`'s folded state a `.card` too
    // (§UC-GX-009: pink `--hi` card, display headline), so this column now holds TWO
    // `.card`s and TWO `.display`s. The sum card is the first, and it is the one this
    // test is about; the CTA has its own coverage in `guest-invite-dead.spec.js`.
    const card = page.getByTestId('guest-confirmation').locator('.card').first()

    await expect(card.locator('.field-lbl')).toHaveText('Suma na úhradu')
    const total = card.locator('.display')
    await expect(total).toHaveText('12.50 EUR')
    expect(await total.evaluate((el) => getComputedStyle(el).fontSize)).toBe('24px')

    await expect(card.locator('hr.divider')).toHaveCount(1)
    expect(await card.locator('hr.divider').evaluate((el) => getComputedStyle(el).borderTopWidth),
      'the theme rule must beat preflight\'s 1px hr').toBe('2px')

    // ⚠ 2026-08-12: this list is `components/CartLineList.vue` now — the SAME
    // component the friend cart bar, the guest cart bar, the guest status page and the
    // host's "Objednávky kolegov" render, so the four columns and the `€` are asserted
    // here as its contract rather than as this screen's own composition.
    const line = card.locator('.lines .ln')
    await expect(line).toHaveCount(1)
    await expect(line.locator('.ln-name')).toHaveText(`Platba Kava ${uniq}`)
    await expect(line.locator('.ln-qty')).toHaveText('1×')
    expect(await line.locator('.ln-qty').innerText(), 'U+00D7, not the letter x').not.toContain('x')
    await expect(line.locator('.ln-size')).toHaveText('250g')
    // ⚠ `€` on the line. The prototype's "bare toFixed(2), the heading states the
    // unit" rule is superseded — the guest reads these lines on screens where the
    // nearest total belongs to a different order.
    await expect(line.locator('.ln-amt')).toHaveText('12.50 €')
    // …and the purpose header the grouping adds.
    await expect(card.locator('.ln-group .badge')).toHaveText('Espresso')
  })

  test('⚠ the reference is GONE from the card and lives only in the modal (resolved conflict #4)', async ({ page }) => {
    await submitThrough(page)
    const col = page.getByTestId('guest-confirmation')

    await expect(col.getByTestId('payment-reference'), 'not on the card any more').toHaveCount(0)
    await expect(col).not.toContainText('Poznámka k platbe')
    // The retired testids of the old markup are gone with it (§UC-GX-011 item 4).
    await expect(page.getByTestId('copy-reference')).toHaveCount(0)
    await expect(page.getByTestId('copy-status-url')).toHaveCount(0)
    // And the two lines the prototype drops.
    await expect(col).not.toContainText('Tovar vám odovzdá')
    await expect(col).not.toContainText('✅')

    // Re-opening via the green Zaplatiť is the only route to it.
    const pay = col.getByRole('button', { name: 'Zaplatiť', exact: true })
    await expect(pay).toHaveClass(/\bok\b/)
    await expect(pay).toHaveClass(/\bblock\b/)
    await pay.click()
    await expect(page.getByRole('dialog').getByTestId('payment-reference')).toContainText(`/ Zuzka Confirm / ${cycle.name}`)
  })

  test('the status-URL copy row, and the ghost button that navigates to the status page', async ({ page }) => {
    await submitThrough(page)
    const col = page.getByTestId('guest-confirmation')

    const row = col.getByTestId('guest-status-url')
    await expect(row).toHaveClass(/\bcopyrow\b/)
    const shown = (await row.locator('.val').textContent()).trim()
    expect(shown).toMatch(new RegExp(`/g/${link.token}/o/[A-Z2-9]{12,}$`))
    // ⚠ 2026-08-12: the label absorbed the help line's first sentence and the
    // `.field-help` paragraph under the copy row is GONE (the screen was too
    // crowded). The absence is asserted, not just the new copy — otherwise a revert
    // of the removal passes silently.
    await expect(col.getByText('Na tomto odkaze uvidíte stav objednávky - uložte si ho!')).toBeVisible()
    await expect(col.locator('.field-help'), 'no help paragraph on this screen any more').toHaveCount(0)

    // ⚠ §UC-GX-004 item 6 — a NEW prototype affordance: pure client-side navigation
    // to `result.status_path`. It must land on the SAME URL the copy row shows; a
    // composed one would be a different (or nonexistent) order.
    await col.getByRole('button', { name: 'Zobraziť stav objednávky' }).click()
    await expect(page).toHaveURL(shown)
    await expect(page.getByTestId('guest-status')).toBeVisible()
  })
})
