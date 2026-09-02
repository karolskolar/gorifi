import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/orders/:id/pickup — the admin's correction of a friend's pickup choice
// (PO decision, 2026-09-02).
//
// The request, in the PO's words: "niekedy si priatelia vyberu zly [pickup point],
// alebo sa potom zmeni a chcem mat moznost to upravit na finalny, aby sa mi lahsie
// pripravovalo balenie." Before this, `orders.pickup_location_id` / `_note` were
// WRITE-ONCE — set by the friend at submit time, with no route that could ever change
// them — so the packing sheet disagreed with where the bags actually go.
//
// What this file pins, in order of how badly each one bites:
//
//  1. ⚠ THE ROUTE TOUCHES NO MONEY. It is offered on a LOCKED, part-PAID cycle, which
//     is the only reason it is safe to expose there at all: `total`, `delivery_fee`,
//     `paid`, `status` and `packeta_address` must all read back unmoved, and NO
//     `transactions` row may appear (the GSO-T6 lesson — a pickup correction is not a
//     financial event, and a stray row corrupts a real friend's balance).
//  2. ⚠ A PACKETA ORDER IS REFUSED. Switching delivery method moves `delivery_fee`,
//     i.e. what the friend owes, and on an already-paid order that silently desyncs
//     the balance from what they actually paid. Refused, not "supported carefully".
//  3. ⚠ NO CYCLE-OPEN GATE, deliberately — the correction is needed exactly when the
//     cycle is locked, because that is when the admin packs. A test asserts the
//     locked case works, so nobody "fixes" it into a 409 later.
//  4. ⚠ EXPLICIT INTENT: exactly one of `pickup_location_id` / `pickup_location_note`.
//     `{}`, both, or neither is a 400 that writes NOTHING — a route that read "no
//     field" as "clear the column" would wipe a real pickup on a malformed body and
//     answer 200. Every refusal test reads the row back, because a status assertion
//     alone cannot see a write that happened anyway.
//  5. The unbindable-shape class (FUP-T13): `{}` / `true` / `[id]` in the id field
//     must be a 400, never a 500 with a stack in the log. The ONE-ELEMENT ARRAY is
//     the trap — `[3]` spreads to exactly one bind slot, so it is the shape that gets
//     silently ACCEPTED when the guard is missing.
// ─────────────────────────────────────────────────────────────────────────────

const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

const admin = () => ({ 'X-Admin-Token': adminToken })

async function adminReq(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: admin(),
    ...(opts.data ? { data: opts.data } : {}),
    timeout: TIMEOUT,
  })
}

/**
 * A friend with real credentials and a Bearer session — the only way to submit an
 * order, and submitting is what writes the pickup column this route then corrects.
 */
let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `pick_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `Pickup ${label} ${uniq}`
  const created = await adminReq('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const row = await created.json()

  expect((await adminReq(`/api/friends/${row.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await adminReq(`/api/friends/${row.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

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
  return { id: row.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label, over = {}) {
  const res = await adminReq('/api/cycles', {
    method: 'post',
    data: { name: `E2E PICKUP ${label} ${uniq}`, type: 'coffee', status: 'open', ...over },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}

async function addProduct(cycleId, name) {
  const res = await adminReq('/api/products', {
    method: 'post',
    data: { cycle_id: cycleId, name: `${name} ${uniq}`, purpose: 'Espresso', price_250g: 9.5 },
  })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

let locationSeq = 0
async function makeLocation(label, over = {}) {
  const res = await adminReq('/api/pickup-locations', {
    method: 'post',
    data: { name: `Miesto ${label} ${uniq}${++locationSeq}`, address: 'Testovacia 1', ...over },
  })
  expect(res.status(), 'pickup location create').toBe(201)
  return res.json()
}

/** A submitted order, with whatever pickup the friend chose. */
async function submittedOrder(friend, cycleId, product, submitBody = {}) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${friend.id}`, {
    headers: friend.auth,
    data: { items: [{ product_id: product.id, variant: '250g', quantity: 2 }] },
    timeout: TIMEOUT,
  })
  expect(put.status(), 'cart PUT').toBe(200)
  const res = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${friend.id}/submit`, {
    headers: friend.auth,
    data: submitBody,
    timeout: TIMEOUT,
  })
  expect(res.status(), 'submit').toBe(200)
  return (await res.json()).order
}

/** The STORED row, read back through the admin listing the two views actually use. */
async function storedOrder(cycleId, orderId) {
  const res = await adminReq(`/api/orders/cycle/${cycleId}`)
  expect(res.status(), 'admin orders listing').toBe(200)
  const row = (await res.json()).find((o) => o.id === orderId)
  expect(row, `order ${orderId} is in the cycle listing`).toBeTruthy()
  return row
}

async function setPickup(orderId, data) {
  return adminReq(`/api/orders/${orderId}/pickup`, { method: 'patch', data })
}

async function lockCycle(cycleId) {
  const res = await adminReq(`/api/cycles/${cycleId}`, { method: 'patch', data: { status: 'locked' } })
  expect(res.status(), 'lock cycle').toBe(200)
}

/** The friend's own ledger — the surface a stray `transactions` row would show up on. */
async function ledgerCount(friend) {
  const res = await ctx.get(`/api/transactions/friend/${friend.id}`, { headers: friend.auth, timeout: TIMEOUT })
  expect(res.status(), 'ledger').toBe(200)
  const body = await res.json()
  return (Array.isArray(body) ? body : body.transactions || []).length
}

test.beforeAll(async () => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

// ═══════════════════════════════════════════════════════════════════════════
// (A) what the route is FOR

test.describe('correcting the pickup location', () => {
  test('a friend who picked the wrong place is moved to the right one, note cleared', async () => {
    const friend = await makeFriend('Alica')
    const cycle = await makeCycle('A1')
    const product = await addProduct(cycle.id, 'Colombia')
    const wrong = await makeLocation('Neskolka')
    const right = await makeLocation('AdamFilo')

    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: wrong.id })
    expect((await storedOrder(cycle.id, order.id)).pickup_location_name).toBe(wrong.name)

    const res = await setPickup(order.id, { pickup_location_id: right.id })
    expect(res.status(), 'the correction is accepted').toBe(200)
    const body = await res.json()
    // The joined name comes back on the mutation response, because both views patch
    // their row in place from it rather than reloading the whole table.
    expect(body.pickup_location_id).toBe(right.id)
    expect(body.pickup_location_name, 'the joined name rides the response').toBe(right.name)

    const stored = await storedOrder(cycle.id, order.id)
    expect(stored.pickup_location_id).toBe(right.id)
    expect(stored.pickup_location_name).toBe(right.name)
    expect(stored.pickup_location_note, 'the old note/id cannot survive alongside').toBeFalsy()
  })

  test('a friend\'s free-text "Iné" answer is replaced by a real location', async () => {
    const friend = await makeFriend('Peta')
    const cycle = await makeCycle('A2')
    const product = await addProduct(cycle.id, 'Brazil')
    const place = await makeLocation('LegoDoma')

    // The shape the PO's screenshot is full of: a grey badge holding a sentence.
    const order = await submittedOrder(friend, cycle.id, product, {
      pickup_location_note: 'Peta :) potvrdim este do spravy, vdaka',
    })
    expect((await storedOrder(cycle.id, order.id)).pickup_location_note).toContain('potvrdim')

    expect((await setPickup(order.id, { pickup_location_id: place.id })).status()).toBe(200)

    const stored = await storedOrder(cycle.id, order.id)
    expect(stored.pickup_location_name).toBe(place.name)
    expect(stored.pickup_location_note, 'the note is cleared, not left behind the badge').toBeFalsy()
  })

  test('and the other way: a location can be replaced by a note', async () => {
    const friend = await makeFriend('Janci')
    const cycle = await makeCycle('A3')
    const product = await addProduct(cycle.id, 'Kenya')
    const place = await makeLocation('LukyHlasny')

    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })

    const res = await setPickup(order.id, { pickup_location_note: '  V domcheku alebo v petrzalke  ' })
    expect(res.status()).toBe(200)

    const stored = await storedOrder(cycle.id, order.id)
    expect(stored.pickup_location_note, 'trimmed').toBe('V domcheku alebo v petrzalke')
    expect(stored.pickup_location_id).toBeFalsy()
    expect(stored.pickup_location_name).toBeFalsy()
  })

  test('⚠ WORKS ON A LOCKED CYCLE — there is deliberately no cycle-open gate', async () => {
    const friend = await makeFriend('Eva')
    const cycle = await makeCycle('A4')
    const product = await addProduct(cycle.id, 'Peru')
    const place = await makeLocation('PoZamknuti')

    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_note: 'este nevie' })
    await lockCycle(cycle.id)

    const res = await setPickup(order.id, { pickup_location_id: place.id })
    expect(res.status(), 'packing happens AFTER the lock — this is the whole point').toBe(200)
    expect((await storedOrder(cycle.id, order.id)).pickup_location_name).toBe(place.name)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (B) ⚠ THE MONEY GUARANTEE

test.describe('⚠ the correction touches no money', () => {
  test('total, delivery_fee, paid and status are unmoved, and NO transactions row appears', async () => {
    const friend = await makeFriend('Baska')
    const cycle = await makeCycle('B1')
    const product = await addProduct(cycle.id, 'Ethiopia')
    const first = await makeLocation('PredZmenou')
    const second = await makeLocation('PoZmene')

    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: first.id })

    // Marked paid FIRST, so the state under test is the dangerous one: real money
    // recorded against this order, on a locked cycle.
    expect((await adminReq(`/api/orders/${order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)
    await lockCycle(cycle.id)

    const before = await storedOrder(cycle.id, order.id)
    const ledgerBefore = await ledgerCount(friend)
    expect(before.paid, 'fixture is honest: the order really is paid').toBeTruthy()
    expect(ledgerBefore, 'marking paid wrote a ledger row').toBeGreaterThan(0)

    expect((await setPickup(order.id, { pickup_location_id: second.id })).status()).toBe(200)

    const after = await storedOrder(cycle.id, order.id)
    expect(after.pickup_location_name, 'the pickup really did move').toBe(second.name)
    expect(after.total, 'total').toBe(before.total)
    expect(after.delivery_fee || 0, 'delivery_fee').toBe(before.delivery_fee || 0)
    expect(after.paid, 'paid').toBe(before.paid)
    expect(after.status, 'status').toBe(before.status)
    expect(after.packeta_address || null, 'packeta_address').toBe(before.packeta_address || null)
    expect(after.packed || 0, 'packed').toBe(before.packed || 0)

    expect(
      await ledgerCount(friend),
      'a pickup correction is not a financial event — a stray transactions row would move a real balance'
    ).toBe(ledgerBefore)
  })

  test('⚠ a PACKETA order is refused (400) and keeps its fee and address', async () => {
    const friend = await makeFriend('Viktor')
    const cycle = await makeCycle('B2')
    // Parcel delivery is PATCH-only on `/api/cycles/:id` — POST ignores both fields.
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 3.5 } })).status()).toBe(200)
    const product = await addProduct(cycle.id, 'Guatemala')
    const place = await makeLocation('NaPacketu')

    const order = await submittedOrder(friend, cycle.id, product, {
      use_parcel_delivery: true,
      packeta_address: 'Z-Box Petržalka, Bratislava',
    })
    const before = await storedOrder(cycle.id, order.id)
    expect(before.delivery_fee, 'fixture is honest: a real parcel fee is on the order').toBe(3.5)

    const res = await setPickup(order.id, { pickup_location_id: place.id })
    expect(res.status(), 'delivery METHOD is a money change and is out of this route\'s scope').toBe(400)
    expect((await res.json()).error).toMatch(/Packetou/)

    const after = await storedOrder(cycle.id, order.id)
    expect(after.delivery_fee, 'the fee is untouched').toBe(3.5)
    expect(after.packeta_address, 'the address is untouched').toBe(before.packeta_address)
    expect(after.pickup_location_id, 'and no pickup was planted next to it').toBeFalsy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (C) refusals — each one reads the row back

test.describe('refusals write nothing', () => {
  let friend
  let cycle
  let product
  let place
  let order

  test.beforeAll(async () => {
    friend = await makeFriend('Refuse')
    cycle = await makeCycle('C1')
    product = await addProduct(cycle.id, 'Rwanda')
    place = await makeLocation('Puvodne')
    order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })
  })

  test('404 for an order that does not exist', async () => {
    const res = await setPickup(999999, { pickup_location_note: 'kdekolvek' })
    expect(res.status()).toBe(404)
  })

  test('400 on a DRAFT — the column is written on submit, so there is nothing to correct', async () => {
    const drafter = await makeFriend('Draft')
    const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${drafter.id}`, {
      headers: drafter.auth,
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(put.status(), 'cart PUT creates the row as a draft').toBe(200)
    const draft = (await put.json()).order
    expect(draft.status, 'fixture is honest').toBe('draft')

    const res = await setPickup(draft.id, { pickup_location_id: place.id })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/odoslanej/)
  })

  test.describe('explicit intent — exactly one of the two fields', () => {
    for (const [label, data] of [
      ['an empty body', {}],
      ['both fields at once', { pickup_location_id: 1, pickup_location_note: 'aj aj' }],
      ['both explicitly null', { pickup_location_id: null, pickup_location_note: null }],
      ['an unrelated field only', { pickup_location: 5 }],
    ]) {
      test(`400 for ${label}, and the stored pickup survives`, async () => {
        const res = await setPickup(order.id, data)
        expect(res.status(), `${label} must not be a write`).toBe(400)
        const stored = await storedOrder(cycle.id, order.id)
        expect(stored.pickup_location_id, 'nothing was cleared').toBe(place.id)
        expect(stored.pickup_location_name).toBe(place.name)
      })
    }
  })

  test('400 for a location id that does not exist', async () => {
    const res = await setPickup(order.id, { pickup_location_id: 999999 })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/neexistuje alebo nie je aktívne/)
    expect((await storedOrder(cycle.id, order.id)).pickup_location_id).toBe(place.id)
  })

  test('400 for a DEACTIVATED location — the dropdown never offers one, the route refuses it', async () => {
    const retired = await makeLocation('Zrusene')
    expect((await adminReq(`/api/pickup-locations/${retired.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const res = await setPickup(order.id, { pickup_location_id: retired.id })
    expect(res.status()).toBe(400)
    expect((await storedOrder(cycle.id, order.id)).pickup_location_id).toBe(place.id)
  })

  // ⚠ FUP-T13 class: an unbindable body field must be a 400, never a 500 with a stack
  // in the log. `[id]` is the trap — a one-element array SPREADS to exactly the single
  // bind slot this statement wants, so it is the shape that gets silently accepted
  // when the guard is missing.
  test.describe('unbindable id shapes are 400, never 500', () => {
    for (const [label, value] of [
      ['an object', {}],
      ['a boolean', true],
      ['an array', [1, 2]],
      ['a ONE-ELEMENT array', null], // filled in below — needs the real location id
      ['a NaN-ish string', 'abc'],
    ]) {
      test(`400 for ${label}`, async () => {
        const id = label === 'a ONE-ELEMENT array' ? [place.id] : value
        const res = await setPickup(order.id, { pickup_location_id: id })
        expect(res.status(), `${label} must not reach the binder`).toBe(400)
        const stored = await storedOrder(cycle.id, order.id)
        expect(stored.pickup_location_id, 'and it certainly must not be stored').toBe(place.id)
      })
    }
  })

  test.describe('the note field', () => {
    for (const [label, note] of [
      ['a number', 123],
      ['an object', {}],
      ['an empty string', ''],
      ['whitespace only', '   '],
    ]) {
      test(`400 for ${label}`, async () => {
        const res = await setPickup(order.id, { pickup_location_note: note })
        expect(res.status()).toBe(400)
        expect((await storedOrder(cycle.id, order.id)).pickup_location_id).toBe(place.id)
      })
    }

    test('200 at the 200-character bound, 400 one over it', async () => {
      const ok = await setPickup(order.id, { pickup_location_note: 'x'.repeat(200) })
      expect(ok.status(), 'exactly at the bound').toBe(200)
      expect((await storedOrder(cycle.id, order.id)).pickup_location_note.length).toBe(200)

      const over = await setPickup(order.id, { pickup_location_note: 'y'.repeat(201) })
      expect(over.status(), 'one over').toBe(400)
      expect((await over.json()).error).toMatch(/dlhá/)
      // The 200-char note from the previous step is still there — the refusal wrote
      // nothing, including nothing truncated.
      const stored = await storedOrder(cycle.id, order.id)
      expect(stored.pickup_location_note).toBe('x'.repeat(200))

      // Put the fixture back for any test that runs after this one.
      expect((await setPickup(order.id, { pickup_location_id: place.id })).status()).toBe(200)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (D) UI — the pill IS the select, on both surfaces
//
// ⚠ Every test here logs in through the UI FIRST and adopts the browser's token for
// its fixture calls: there is ONE admin token app-wide (`INSERT OR REPLACE`), so a UI
// login invalidates a token minted earlier by `beforeAll` (the documented trap).

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  adminToken = token
  return token
}

async function openOrdersTab(page, cycleId) {
  await page.goto(`/admin/cycle/${cycleId}`)
  await page.getByRole('tab', { name: 'Objednávky' }).click()
}

test.describe('UI — the orders tab', () => {
  test('picking a place from the pill saves immediately and survives a reload', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiPick')
    const cycle = await makeCycle('D1')
    const product = await addProduct(cycle.id, 'UiKava')
    const wrong = await makeLocation('UiNeskolka')
    const right = await makeLocation('UiAdamFilo')
    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: wrong.id })

    await openOrdersTab(page, cycle.id)
    const pill = page.getByTestId(`pickup-select-${order.id}`)
    await expect(pill).toBeVisible()
    // ⚠ The pill IS a `<select>` — that is the row's whole interaction budget (open,
    // pick). A badge-then-reveal build would be three interactions and hide the
    // control behind a state the admin has to discover first.
    await expect(pill).toHaveJSProperty('tagName', 'SELECT')
    await expect(pill, 'blue = a configured location, exactly as the old badge').toHaveClass(/bg-blue-50/)

    await pill.selectOption(String(right.id))
    // No Uložiť: the save is the pick. The server is the proof.
    await expect.poll(
      async () => (await storedOrder(cycle.id, order.id)).pickup_location_id,
      { message: 'the pick was persisted with no further click' }
    ).toBe(right.id)

    await page.reload()
    await page.getByRole('tab', { name: 'Objednávky' }).click()
    await expect(page.getByTestId(`pickup-select-${order.id}`)).toHaveValue(String(right.id))
  })

  test('"Iné (poznámka)" reveals an input; saving it turns the pill grey', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiNote')
    const cycle = await makeCycle('D2')
    const product = await addProduct(cycle.id, 'UiKava2')
    const place = await makeLocation('UiLegoDoma')
    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: place.id })

    await openOrdersTab(page, cycle.id)
    await page.getByTestId(`pickup-select-${order.id}`).selectOption('__note_new__')

    const input = page.getByTestId(`pickup-note-input-${order.id}`)
    await expect(input, 'and it is focused, so the admin can just type').toBeFocused()
    // Mirrors the server bound, so the field cannot compose a request the route refuses.
    await expect(input).toHaveAttribute('maxlength', '200')
    await input.fill('U mna v aute pred skolkou')
    await page.getByTestId(`pickup-note-save-${order.id}`).click()

    const pill = page.getByTestId(`pickup-select-${order.id}`)
    await expect(pill, 'grey = the free-text answer, same as the old badge').toHaveClass(/bg-gray-50/)
    await expect(pill).toHaveValue('__note_current__')
    await expect(pill.locator('option', { hasText: 'U mna v aute pred skolkou' })).toHaveCount(1)

    const stored = await storedOrder(cycle.id, order.id)
    expect(stored.pickup_location_note).toBe('U mna v aute pred skolkou')
    expect(stored.pickup_location_id).toBeFalsy()
  })

  test('a refused change snaps the pill back — it never claims a place that was not saved', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiFail')
    const cycle = await makeCycle('D3')
    const product = await addProduct(cycle.id, 'UiKava3')
    const from = await makeLocation('UiOdkial')
    const to = await makeLocation('UiKam')
    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: from.id })

    await openOrdersTab(page, cycle.id)
    // The packing sheet is read as fact; "it looked like it saved" is how a bag goes
    // to the wrong address.
    await page.route(`**/api/orders/${order.id}/pickup`, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Nepodarilo sa' }) })
    )
    await page.getByTestId(`pickup-select-${order.id}`).selectOption(String(to.id))

    await expect(page.getByTestId(`pickup-error-${order.id}`)).toHaveText('Nepodarilo sa')
    await expect(page.getByTestId(`pickup-select-${order.id}`)).toHaveValue(String(from.id))
    expect((await storedOrder(cycle.id, order.id)).pickup_location_id, 'and nothing moved').toBe(from.id)
  })

  test('a DRAFT and a PACKETA row offer no picker at all — a control that can only fail is worse than none', async ({ page }) => {
    await loginAsAdminUI(page)
    const cycle = await makeCycle('D4')
    expect((await adminReq(`/api/cycles/${cycle.id}`, { method: 'patch', data: { parcel_enabled: true, parcel_fee: 2 } })).status()).toBe(200)
    const product = await addProduct(cycle.id, 'UiKava4')

    const drafter = await makeFriend('UiDraft')
    const put = await ctx.put(`/api/orders/cycle/${cycle.id}/friend/${drafter.id}`, {
      headers: drafter.auth,
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
      timeout: TIMEOUT,
    })
    expect(put.status()).toBe(200)
    const draft = (await put.json()).order

    const parcelFriend = await makeFriend('UiParcel')
    const parcelOrder = await submittedOrder(parcelFriend, cycle.id, product, {
      use_parcel_delivery: true,
      packeta_address: 'Z-Box Ruzinov',
    })

    await openOrdersTab(page, cycle.id)
    await expect(page.getByTestId(`pickup-select-${draft.id}`), 'no pickup exists on an unsubmitted cart').toHaveCount(0)
    await expect(page.getByTestId(`pickup-select-${parcelOrder.id}`), 'delivery method is a money change').toHaveCount(0)
    // …and the Packeta row still says what it is.
    await expect(page.getByText('Packeta').first()).toBeVisible()
  })
})

test.describe('UI — the Distribution picking sheet', () => {
  test('the same picker works here, and PRINT falls back to the place as TEXT', async ({ page }) => {
    await loginAsAdminUI(page)
    const friend = await makeFriend('UiDist')
    const cycle = await makeCycle('D5')
    const product = await addProduct(cycle.id, 'UiKava5')
    const from = await makeLocation('UiDistOd')
    const to = await makeLocation('UiDistKam')
    const order = await submittedOrder(friend, cycle.id, product, { pickup_location_id: from.id })

    await page.goto(`/admin/cycle/${cycle.id}/distribution`)
    const pill = page.getByTestId(`dist-pickup-select-${order.id}`)
    await expect(pill, 'this is the screen the bags are packed from').toBeVisible()

    await pill.selectOption(String(to.id))
    await expect.poll(async () => (await storedOrder(cycle.id, order.id)).pickup_location_id).toBe(to.id)

    // ⚠ A printed picking sheet must state the place as text, not render a dropdown
    // box (the same rule as the guest folds' `hidden print:flex`).
    // ⚠ The badge is located by TESTID, not by its text: the select's own hidden
    // `<option>` carries the same string, so a `getByText` here resolves to the
    // control it is supposed to prove is gone.
    const printBadge = page.getByTestId(`dist-pickup-badge-${friend.id}`)
    await expect(printBadge, 'on screen the badge yields to the control').toBeHidden()

    await page.emulateMedia({ media: 'print' })
    await expect(pill, 'the control has no business on paper').toBeHidden()
    await expect(printBadge, 'but the place is still printed, as text').toBeVisible()
    await expect(printBadge).toHaveText(to.name)
    await page.emulateMedia({ media: 'screen' })
  })
})
