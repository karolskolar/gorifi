import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// DP-T6 — module 16 (distribution pipeline), 16 §UC-DP-011 (+ §UC-DP-007's
// frontend half).
//
// THE BOARD ROWS: the per-friend Card DP-T5 left inside each group becomes one
// ROW with five columns — Kto · Doručenie/obsah · Platba · Krok 1 Zabalené ·
// Krok 2 Odovzdané — carrying the shipped packing mechanics (per-item
// checkboxes, guest folds, the pickup picker) inside a click-to-expand body.
//
// What carries this file:
//
//  1. ⚠ **A NESTED `via_host` GUEST ROW IS A MIRROR, NOT A CONTROL** (PO decision
//     2026-09-19). The API permits a per-guest correction (§UC-DP-005), the board
//     does not offer one. Proving "read-only" needs a NON-VACUITY GATE: the row
//     must first be shown to CONTAIN checkboxes, and only then shown to contain
//     no enabled one and no button — otherwise a typo in the row locator proves
//     "no clickable control" for free.
//
//  2. ⚠ **STAGE ORDER IS THE UI's TOO.** Krok 2 is disabled („Najprv zabaliť")
//     until the bag is packed, and Krok 1 is disabled („Najprv zrušte
//     odovzdanie") once it is handed over — the two halves of §UC-DP-007 as the
//     admin meets them. A refusal SNAPS THE CONTROL BACK and prints the SERVER's
//     message, never a client-side guess.
//
//  3. ⚠ **THE PICKUP CHANGE: PATCH IN PLACE, THEN RE-FETCH** (backlog DP-T6,
//     §UC-DP-011). A changed pickup can move the party to another GROUP, and the
//     new `delivery` / `plan` may only come from `helpers/delivery.js` — never a
//     client-side re-derivation. It must not be a page reload either: a reload
//     re-collapses every guest fold the admin has folded away, so the test folds
//     one FIRST and requires it still folded afterwards. That single assertion is
//     what tells "patch + loadSeq re-fetch" from "location.reload()".
//
//  4. ⚠ **A SYNTHETIC HOST HANDS OVER THROUGH THE BULK ROUTE.** They have no
//     `orders` row to stamp, so their Krok 2 is `POST /cycles/:id/distribution/
//     hand-over` with their live sub-order ids (one transaction, one timestamp);
//     the reversal is the per-guest PATCH in sequence — the only per-guest
//     reversal the board offers. Both are asserted on the WIRE, not inferred.
//
//  5. ⚠ **PRINT FOLDS, NEVER UNMOUNTS.** A collapsed row and a folded guest are
//     `hidden print:flex` / `hidden print:block`; the picker is `print:hidden`
//     and the pickup badge `hidden print:inline-flex`. Asserted under
//     `emulateMedia({ media: 'print' })`, badges located BY TESTID (the select's
//     own `<option>` carries the same string — the shipped idiom).

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `dp6_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `DP6 ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name, phone: '0911 222 333' } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()
  expect((await admin(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const auth = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' }, timeout: TIMEOUT })
  expect(auth.status(), 'friend login').toBe(200)
  const body = await auth.json()
  const changed = await ctx.put(`/api/friends/${row.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass12' },
    timeout: TIMEOUT,
  })
  expect(changed.status(), 'forced change').toBe(200)
  const token = (await changed.json()).token || body.token
  return { id: row.id, name, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, patch = null) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E DP6 ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  const cycle = await res.json()
  if (!patch) return cycle
  const upd = await admin(`/api/cycles/${cycle.id}`, { method: 'patch', data: patch })
  expect(upd.status(), 'cycle patch').toBe(200)
  return upd.json()
}

async function addProduct(cycleId) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId, name: `DP6 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
      price_250g: 10, price_1kg: 30,
    },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let locationSeq = 0
async function makeLocation(label) {
  const res = await admin('/api/pickup-locations', {
    method: 'post',
    data: {
      name: `DP6 ${label} ${uniq}${++locationSeq}`, address: `Radova ${locationSeq}`,
      for_coffee: true, for_bakery: true,
    },
  })
  expect(res.status(), 'pickup location create').toBe(201)
  return res.json()
}

async function ownOrder(friend, cycleId, items, submitBody) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth, data: { items }, timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth, data: submitBody, timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

async function shareLink(friend, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: friend.auth, timeout: TIMEOUT })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

async function submitGuest(linkToken, items, identity) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: identity.guest_name,
      guest_phone: identity.guest_phone || '0901 234 567',
      guest_email: identity.guest_email || 'kolega@example.com',
      items,
    },
    timeout: TIMEOUT,
  })
  expect(res.status(), 'guest submit').toBe(201)
  return (await res.json()).order
}

async function payload(cycleId) {
  const res = await admin(`/api/cycles/${cycleId}/distribution`)
  expect(res.status(), 'distribution').toBe(200)
  return res.json()
}

const partyOf = (body, friendId) => body.distribution.find((p) => p.id === friendId)

/** Tick every own + guest item of a party WITHOUT flipping the whole-order flag. */
async function checkAllItems(cycleId, friendId) {
  const party = partyOf(await payload(cycleId), friendId)
  for (const item of party.items) {
    if (item.packed) continue
    expect((await admin(`/api/order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
  }
  for (const guest of party.guest_orders) {
    for (const item of guest.items) {
      if (item.packed) continue
      expect((await admin(`/api/guest-order-items/${item.id}/packed`, { method: 'patch' })).status()).toBe(200)
    }
  }
}

// ⚠ IDEMPOTENT, because `PATCH /orders/:id/packed` is a TOGGLE: these tests run
// serially over one fixture, and a second "pack this" on an already-packed order
// would UN-pack it (and post the ledger reversal) instead.
async function packParty(cycleId, friendId, orderId) {
  await checkAllItems(cycleId, friendId)
  if (!orderId) return
  if (partyOf(await payload(cycleId), friendId).packed) return
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status()).toBe(200)
}

// ⚠ ONE ADMIN TOKEN APP-WIDE. A UI login mints a new one and invalidates the API
// context's; `adoptBrowserToken` is the other direction and the one to use when a
// test drives the page and the API alternately.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

async function adoptBrowserToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the browser is logged in').toBeTruthy()
  adminToken = token
}

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => { await ctx?.dispose() })

// ─────────────────────────────────────────────────────────────────────────────
// One cycle, three kinds of party — every column of §UC-DP-011 is readable on at
// least one of them:
//
//   H — friend WITH an own order + 2 nested guests, at pickup point L
//       (own 1×250 g, guest A 1×250 g, guest B 3×250 g ⇒ 3 lines, 1.25 kg)
//       ⚠ guest B carries THREE bags, not two, so the party total is a FRACTIONAL
//       kilo. A whole kilo is a fixed point of a scale-preserving mutation in
//       `lib/kg.js` (1000 → 1000), so the kg assertion below could not fail for the
//       reason it claims — FUP-T24 review, 2026-09-20. Keep this fraction.
//   P — friend with a PACKETA address and a phone
//   S — SYNTHETIC host: no own order, 2 guest bags, at pickup point L
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T6 · 16 §UC-DP-011 — the board rows', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Rows', { parcel_enabled: true, parcel_fee: 3.9 })
    fx.product = await addProduct(fx.cycle.id)
    fx.L = await makeLocation('Miesto L')
    fx.N = await makeLocation('Miesto N')

    const line = (variant, quantity) => [{ product_id: fx.product.id, variant, quantity }]

    fx.h = await makeFriend('Hostitel')
    fx.hOrder = await ownOrder(fx.h, fx.cycle.id, line('250g', 1), { pickup_location_id: fx.L.id })
    const hLink = await shareLink(fx.h, fx.cycle.id)
    fx.guestAName = `Alica ${uniq}`
    fx.guestBName = `Bohus ${uniq}`
    fx.guestA = await submitGuest(hLink.token, line('250g', 1), { guest_name: fx.guestAName, guest_phone: '0901 111 222' })
    fx.guestB = await submitGuest(hLink.token, line('250g', 3), { guest_name: fx.guestBName, guest_phone: '0901 111 333' })

    fx.p = await makeFriend('Packeta')
    fx.pOrder = await ownOrder(fx.p, fx.cycle.id, line('250g', 1), {
      use_parcel_delivery: true, packeta_address: 'Packeta Ruzinov, Bratislava',
    })

    fx.s = await makeFriend('Synteticky')
    const sLink = await shareLink(fx.s, fx.cycle.id)
    fx.guestCName = `Cyril ${uniq}`
    fx.guestDName = `Dana ${uniq}`
    fx.guestC = await submitGuest(sLink.token, line('250g', 1), { guest_name: fx.guestCName, guest_phone: '0901 111 444' })
    fx.guestD = await submitGuest(sLink.token, line('250g', 1), { guest_name: fx.guestDName, guest_phone: '0901 111 555' })
    // The synthetic host is a pickup party too — DP-T5's board groups it by its link.
    expect((await admin(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.s.id}/pickup`, {
      method: 'patch', data: { pickup_location_id: fx.L.id },
    })).status(), 'synthetic host pickup').toBe(200)
  })

  test.afterAll(async () => {
    await refreshAdminToken()
    for (const loc of [fx.L, fx.N]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('the fixture is the shape the rows are asserted against', async () => {
    const body = await payload(fx.cycle.id)
    const h = partyOf(body, fx.h.id)
    expect(h.stage).toBe('to_pack')
    expect(h.guest_orders).toHaveLength(2)
    expect(h.kg, 'own 250 + 250 + 3×250').toBe(1250)
    expect(partyOf(body, fx.p.id).delivery).toMatchObject({ type: 'packeta', target_key: 'packeta' })
    const s = partyOf(body, fx.s.id)
    expect(s.has_own_order).toBe(false)
    expect(s.delivery.target_key).toBe(`loc${fx.L.id}`)
  })

  // ── 1. the five columns ────────────────────────────────────────────────────
  test('a row reads Kto · Doručenie/obsah · Platba · Krok 1 · Krok 2', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    await expect(row).toBeVisible()

    // Kto — the name (still a heading: DP-T5's group assertions and two shipped
    // specs locate a party by it) plus the nested-guest count badge.
    await expect(row.getByRole('heading', { name: fx.h.name, exact: true })).toBeVisible()
    await expect(row.getByTestId(`bag-who-${fx.h.id}`)).toContainText('+2 hostia')

    // Doručenie / obsah — a pickup party reads „{items} pol. · {kg} kg".
    await expect(row.getByTestId(`bag-delivery-${fx.h.id}`)).toContainText('3 pol. · 1.25 kg')

    // Platba — the shipped paid semantics, in the compact column form.
    await expect(row.getByTestId(`bag-pay-${fx.h.id}`)).toContainText('Nezapl.')

    // Krok 1 — the shipped whole-order toggle, gated on every item being checked.
    const packed = row.getByTestId(`packed-toggle-${fx.h.id}`)
    await expect(packed).toHaveText('Zabaliť')
    await expect(packed, 'nothing checked yet').toBeDisabled()

    // Krok 2 — refused until Krok 1 is done, and it SAYS why.
    const handover = row.getByTestId(`handover-toggle-${fx.h.id}`)
    await expect(handover).not.toBeChecked()
    await expect(handover).toBeDisabled()
    await expect(handover).toHaveAttribute('title', 'Najprv zabaliť')
  })

  // ── 2. the nested guest row is a mirror ────────────────────────────────────
  test('a nested guest row is a READ-ONLY mirror — no clickable hand-over on it', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    const guestRow = row.getByTestId(`guest-row-${fx.guestA.id}`)
    await expect(guestRow).toBeVisible()
    await expect(guestRow).toContainText(fx.guestAName)
    await expect(guestRow).toContainText('hosť')
    await expect(guestRow).toContainText('v balíku hostiteľa · 1 pol.')

    // ⚠ NON-VACUITY. There ARE controls in this row — two mirrors, Krok 1 and
    // Krok 2 — and the guest's own Krok 2 mirror is one of them by testid.
    await expect(guestRow.locator('input[type="checkbox"]')).toHaveCount(2)
    await expect(guestRow.getByTestId(`handover-toggle-guest-${fx.guestA.id}`)).toBeVisible()

    // …and NONE of them can be operated: every checkbox disabled, no button at all.
    await expect(guestRow.locator('input[type="checkbox"]:not([disabled])')).toHaveCount(0)
    await expect(guestRow.getByRole('button')).toHaveCount(0)
  })

  // ── 3. Packeta address + phone ─────────────────────────────────────────────
  test('a Packeta row prints the address and the phone', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const delivery = page.getByTestId(`bag-row-${fx.p.id}`).getByTestId(`bag-delivery-${fx.p.id}`)
    await expect(delivery).toContainText('Packeta Ruzinov, Bratislava')
    // Both are needed on the bag AND on the label (§UC-DP-011).
    await expect(delivery.getByTestId(`bag-phone-${fx.p.id}`)).toHaveText('0911 222 333')
  })

  // ── 8. the pickup change: patch in place, THEN re-fetch ────────────────────
  test('a pickup change re-groups the row from the server without re-opening a fold', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // ⚠ NON-VACUITY: the row is in L's group before anything moves.
    const inL = page.getByTestId(`dist-group-loc${fx.L.id}`).getByTestId(`bag-row-${fx.h.id}`)
    await expect(inL).toBeVisible()

    // Fold one guest away. A page reload would re-open it (the fold map is local
    // and defaults to open) — this is the assertion that tells a re-fetch from a
    // reload.
    const items = inL.getByTestId(`guest-group-items-${fx.guestA.id}`)
    await expect(items).toBeVisible()
    await inL.getByTestId(`guest-group-toggle-${fx.guestA.id}`).click()
    await expect(items).toBeHidden()

    await page.getByTestId(`dist-pickup-select-${fx.h.id}`).selectOption(String(fx.N.id))

    // The new group comes from `helpers/delivery.js` via a re-fetch — never from a
    // client-side re-derivation.
    const inN = page.getByTestId(`dist-group-loc${fx.N.id}`).getByTestId(`bag-row-${fx.h.id}`)
    await expect(inN).toBeVisible()
    await expect(page.getByTestId(`dist-group-loc${fx.L.id}`).getByTestId(`bag-row-${fx.h.id}`)).toHaveCount(0)
    // …and the plan card, which is `plan[]`, moved with it.
    await expect(page.getByTestId(`plan-count-loc${fx.N.id}`)).toHaveText('1')

    // The fold the admin made is still made.
    await expect(inN.getByTestId(`guest-group-items-${fx.guestA.id}`), 'a reload would have re-opened this').toBeHidden()

    // Put it back for the print test below.
    await page.getByTestId(`dist-pickup-select-${fx.h.id}`).selectOption(String(fx.L.id))
    await expect(page.getByTestId(`dist-group-loc${fx.L.id}`).getByTestId(`bag-row-${fx.h.id}`)).toBeVisible()
  })

  // ── 9. print: everything folds, nothing unmounts ───────────────────────────
  test('print opens every fold, drops the pickers, and prints the badges', async ({ page }) => {
    await loginAsAdminUI(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    const body = row.getByTestId(`bag-row-body-${fx.h.id}`)
    const items = row.getByTestId(`guest-group-items-${fx.guestA.id}`)

    // Collapse the ROW and fold a GUEST — two independent folds, both screen-only.
    await row.getByTestId(`guest-group-toggle-${fx.guestA.id}`).click()
    await expect(items).toBeHidden()
    await row.getByTestId(`bag-row-toggle-${fx.h.id}`).click()
    await expect(body).toBeHidden()

    const picker = page.getByTestId(`dist-pickup-select-${fx.h.id}`)
    const badge = page.getByTestId(`dist-pickup-badge-${fx.h.id}`)
    await expect(picker, 'on screen the control wins').toBeVisible()
    await expect(badge).toBeHidden()

    await page.emulateMedia({ media: 'print' })
    await expect(body, 'every row prints expanded').toBeVisible()
    await expect(items, 'and every guest fold prints').toBeVisible()
    await expect(picker, 'the control has no business on paper').toBeHidden()
    await expect(badge, 'but the place is printed, as text').toBeVisible()
    await expect(row.getByTestId(`handover-toggle-${fx.h.id}`), 'checkboxes are screen tools').toBeHidden()
    await page.emulateMedia({ media: 'screen' })
    await expect(body).toBeHidden()
  })

  // ── 4. expand / collapse, and the default on each side of packed ───────────
  test('a to-pack row is expanded, a packed one is collapsed — and the fold is a fold', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    // The synthetic host is the party whose checklist survives packing (no
    // `orders` row ⇒ the shipped `v-if="!packed"` body never applies to it), so it
    // is the one that can show BOTH default states.
    const row = page.getByTestId(`bag-row-${fx.s.id}`)
    const items = row.getByTestId(`guest-group-items-${fx.guestC.id}`)
    await expect(row, 'to_pack ⇒ the admin is packing it ⇒ open').toHaveAttribute('data-stage', 'to_pack')
    await expect(items).toBeVisible()

    // Collapsing is screen-only: the rows stay in the DOM for the printed sheet.
    await row.getByTestId(`bag-row-toggle-${fx.s.id}`).click()
    await expect(items).toBeHidden()
    await expect(items.locator('[data-owner="guest"]'), 'hidden, not unmounted').toHaveCount(1)
    await row.getByTestId(`bag-row-toggle-${fx.s.id}`).click()
    await expect(items).toBeVisible()

    // Pack it behind the page's back and reload: a done bag is one line.
    await packParty(fx.cycle.id, fx.s.id, null)
    await page.reload()
    const reloaded = page.getByTestId(`bag-row-${fx.s.id}`)
    await expect(reloaded).toHaveAttribute('data-stage', 'packed')
    await expect(reloaded.getByTestId(`guest-group-items-${fx.guestC.id}`)).toBeHidden()
    await reloaded.getByTestId(`bag-row-toggle-${fx.s.id}`).click()
    await expect(reloaded.getByTestId(`guest-group-items-${fx.guestC.id}`)).toBeVisible()
  })

  // ── 5. the synthetic host's Krok 2 goes through the BULK route ─────────────
  test('a synthetic host hands over through the bulk route, and reverses per guest', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.s.id}`)
    const handover = row.getByTestId(`handover-toggle-${fx.s.id}`)
    await expect(handover, 'packed by the previous test').toBeEnabled()

    const bulk = page.waitForRequest((req) =>
      req.method() === 'POST' && /\/distribution\/hand-over$/.test(req.url()))
    await handover.check()
    const sent = await bulk
    expect(sent.postDataJSON(), 'party identifiers: the guest ids, no order id')
      .toMatchObject({ order_ids: [], guest_order_ids: expect.arrayContaining([fx.guestC.id, fx.guestD.id]) })

    // The mirrors flip without a reload.
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestC.id}`)).toBeChecked()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestD.id}`)).toBeChecked()
    await expect(row).toHaveAttribute('data-stage', 'handed')

    // The reversal is NOT bulk (Phase 2, explicitly not built): one PATCH per guest.
    const reversals = []
    page.on('request', (req) => {
      if (req.method() === 'PATCH' && /\/api\/guest-orders\/\d+\/handed-over$/.test(req.url())) reversals.push(req.url())
    })
    await row.getByTestId(`handover-toggle-${fx.s.id}`).uncheck()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestC.id}`)).not.toBeChecked()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestD.id}`)).not.toBeChecked()
    expect(reversals, 'one per guest, in sequence').toHaveLength(2)

    const s = partyOf(await payload(fx.cycle.id), fx.s.id)
    expect(s.stage, 'and the server agrees').toBe('packed')
  })

  // ── 6. Krok 2 enables, stamps the guests, and then locks Krok 1 ────────────
  test('Krok 2 unlocks once packed, ticks the nested guests, and disables Krok 1', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await packParty(fx.cycle.id, fx.h.id, fx.hOrder.id)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    const handover = row.getByTestId(`handover-toggle-${fx.h.id}`)
    await expect(row.getByTestId(`packed-toggle-${fx.h.id}`)).toHaveText('Zabalené')
    await expect(handover, 'packed ⇒ the step is reachable').toBeEnabled()

    await handover.check()
    await expect(handover).toBeChecked()
    // Every nested guest inherits, without a reload.
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestA.id}`)).toBeChecked()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestB.id}`)).toBeChecked()
    await expect(row).toHaveAttribute('data-stage', 'handed')

    // §UC-DP-007's frontend half: un-packing a bag that has left is refused BEFORE
    // it is attempted.
    const packed = row.getByTestId(`packed-toggle-${fx.h.id}`)
    await expect(packed).toBeDisabled()
    await expect(packed).toHaveAttribute('title', 'Najprv zrušte odovzdanie')

    // Reversal clears the guests too.
    await handover.uncheck()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestA.id}`)).not.toBeChecked()
    await expect(row.getByTestId(`packed-toggle-${fx.h.id}`)).toBeEnabled()
  })

  // ── 7. a refused Krok 2 snaps back and prints the SERVER's message ─────────
  test('a 409 snaps the checkbox back and shows the server message inline', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    const handover = row.getByTestId(`handover-toggle-${fx.h.id}`)
    await expect(handover, 'non-vacuity: it really is clickable right now').toBeEnabled()

    // Behind the screen's back: the bag is un-packed, so the tick the admin is
    // about to make is stale.
    expect((await admin(`/api/orders/${fx.hOrder.id}/packed`, { method: 'patch' })).status()).toBe(200)

    await handover.check()
    await expect(row.getByTestId(`bag-row-error-${fx.h.id}`)).toHaveText('Najprv označte balíček ako zabalený')
    await expect(handover, 'the control snaps back to what the server holds').not.toBeChecked()
    expect(partyOf(await payload(fx.cycle.id), fx.h.id).stage, 'and nothing moved').toBe('to_pack')

    // ⚠ AND THE SENTENCE DOES NOT OUTLIVE THE STEP IT DESCRIBED. „Najprv označte
    // balíček ako zabalený" is advice about Krok 1; the admin takes it right here
    // (the refusal path already re-fetched, so the row is back to „Zabaliť" with
    // every item still ticked), and a red line still sitting under a row that is
    // now packed and ready to hand over would be a WRONG sentence on a
    // money-adjacent screen. Review finding, DP-T6.
    const packed = row.getByTestId(`packed-toggle-${fx.h.id}`)
    await expect(packed, 'the refusal path brought the real state back').toHaveText('Zabaliť')
    await packed.click()
    await expect(packed).toHaveText('Zabalené')
    await expect(row.getByTestId(`bag-row-error-${fx.h.id}`)).toHaveCount(0)
    await expect(handover, 'and the step it refused is reachable again').toBeEnabled()
  })

  // ── 10. a host handed over with a guest withheld ───────────────────────────
  // UC-DP-005 case c: the admin takes ONE guest's bag back. The host row says so
  // rather than silently disagreeing with its own mirrors.
  test('„odovzdané okrem 1" when a nested guest is taken back', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)

    await packParty(fx.cycle.id, fx.h.id, fx.hOrder.id)
    expect((await admin(`/api/orders/${fx.hOrder.id}/handed-over`, {
      method: 'patch', data: { handed_over: true },
    })).status()).toBe(200)
    expect((await admin(`/api/guest-orders/${fx.guestB.id}/handed-over`, {
      method: 'patch', data: { handed_over: false },
    })).status()).toBe(200)

    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    const row = page.getByTestId(`bag-row-${fx.h.id}`)
    await expect(row.getByTestId(`bag-handed-except-${fx.h.id}`)).toHaveText('odovzdané okrem 1')
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestA.id}`)).toBeChecked()
    await expect(row.getByTestId(`handover-toggle-guest-${fx.guestB.id}`)).not.toBeChecked()
  })
})
