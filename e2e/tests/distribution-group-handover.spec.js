import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// DP-T7 — module 16 (distribution pipeline), 16 §UC-DP-012.
//
// THE GROUP BUTTON. „Odovzdať zabalené (n)" — rendered, counted and deliberately
// unwired by DP-T5 — becomes the moment the admin records a whole drop at once:
// a radix confirm dialog, the bulk POST, an in-place patch, a re-fetch and a
// 3.5 s toast; a refusal closes the dialog, shows an Alert and highlights the
// rows the SERVER named.
//
// What carries this file:
//
//  1. ⚠ **WHICH IDENTIFIERS GO ON THE WIRE, asserted on the wire.** DP-T4
//     recorded the asymmetry that decides it: a guest listed EXPLICITLY with one
//     unchecked item aborts a batch that would have succeeded had the same bag
//     merely been INHERITED from its host (§UC-DP-004 puts no pack gate on
//     inheritance). So the button sends PARTY identifiers — an `order_id` per
//     friend party, the live sub-order ids of a SYNTHETIC host — and never the
//     nested guest rows it happens to render. The load-bearing assertion is the
//     NEGATIVE one: `guest_order_ids` must not contain the nested guest of a
//     friend who has an own order.
//
//  2. ⚠ **PATCH IN PLACE, THEN RE-FETCH — and an open fold must survive.** The
//     same shape DP-T6 shipped for the row: a `location.reload()` would
//     re-collapse every guest fold the admin folded away in a long picking list,
//     and only the server may answer `plan[]` / `totals` / the grouping. The test
//     folds a guest CLOSED first (the default is open, so the assertion would be
//     vacuous otherwise) and requires it still folded after the hand-over, while
//     the plan card — which can only come from a re-fetch — has moved.
//
//  3. ⚠ **THE REFUSAL NAMES ROWS, AND ONLY THOSE ROWS ARE HIGHLIGHTED.** The
//     409 carries three identifier lists; the board resolves them back to the
//     parties that own them. A batch is all-or-nothing, so the INNOCENT party in
//     the same batch must be provably untouched — both un-highlighted and
//     unmoved in the payload. And the sentence does not outlive the advice it
//     gave: packing the offending bag clears it (the DP-T6 stale-refusal lesson,
//     not re-learned).
//
//  4. ⚠ **NO LEDGER ROW, EVER.** Stage 2 (`packed`) is and stays the only ledger
//     moment (`helpers/packing.js`); the dialog's banner CLAIMS the hand-over is
//     ledger-neutral, so this file proves it — across the whole flow, from two
//     sides (the friend's own `/detail` rows + balance, ungated, and a `MAX(id)`
//     watermark filtered to these friends when `DB_PATH` is exported).
//
//  5. ⚠ **THE QUEUED COUNT IS READ AND NOT RENDERED.** `queued_notifications`
//     is module 21's half; the toast here must not mention messages at all.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || ''
const TIMEOUT = 20_000
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

let ctx = null
let adminToken = ''

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
  timeout: TIMEOUT,
})

let friendSeq = 0
async function makeFriend(label) {
  const suffix = `_${uniq}${++friendSeq}`
  const username = `dp7_${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
  const name = `DP7 ${label} ${uniq}`
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

async function makeCycle(label) {
  const res = await admin('/api/cycles', {
    method: 'post',
    data: { name: `E2E DP7 ${label} ${uniq}`, type: 'coffee', status: 'open' },
  })
  expect(res.status(), 'cycle create').toBe(201)
  return res.json()
}

async function addProduct(cycleId) {
  const res = await admin('/api/products', {
    method: 'post',
    data: {
      cycle_id: cycleId, name: `DP7 Kava ${uniq}`, purpose: 'Espresso', roast_type: 'Svetlé',
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
      name: `DP7 ${label} ${uniq}${++locationSeq}`, address: `Radova ${locationSeq}`,
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

// ⚠ IDEMPOTENT, because `PATCH /orders/:id/packed` is a TOGGLE (DP-T6's finding):
// a second "pack this" on an already-packed order UN-packs it and posts the ledger
// REVERSAL — which would also quietly falsify this file's ledger claim.
async function packParty(cycleId, friendId, orderId) {
  await checkAllItems(cycleId, friendId)
  if (!orderId) return
  if (partyOf(await payload(cycleId), friendId).packed) return
  expect((await admin(`/api/orders/${orderId}/packed`, { method: 'patch' })).status()).toBe(200)
}

// ── the LEDGER, from two sides (the distribution-handover.spec.js idiom) ────────
// The API half needs no database file at all; the watermark is strictly EXTRA and
// FILTERED to this file's own friends, because a global count is a value claim over
// rows a concurrently running spec owns.
function withDb(fn) {
  if (!DB_PATH) return null
  let db
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true })
  } catch {
    return null
  }
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function ledgerWatermark() {
  return withDb((db) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM transactions').get().n))
}

function ledgerRowsSince(watermark, friendIds) {
  if (watermark === null) return null
  const ids = friendIds.map(Number)
  return withDb((db) =>
    db.prepare(
      `SELECT id, friend_id, order_id, type, amount, note FROM transactions
        WHERE id > ? AND friend_id IN (${ids.map(() => '?').join(',')})`
    ).all(watermark, ...ids)
  )
}

async function ledgerSnapshot(friendIds) {
  const out = {}
  for (const id of friendIds) {
    const res = await admin(`/api/friends/${id}/detail`)
    expect(res.status(), 'friend detail').toBe(200)
    const body = await res.json()
    out[id] = { count: (body.transactions || []).length, balance: body.balance }
  }
  return out
}

// ⚠ ONE ADMIN TOKEN APP-WIDE — a UI login mints a new one and invalidates the API
// context's, so a test that drives the page AND the API adopts the browser's.
async function adoptBrowserToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the browser is logged in').toBeTruthy()
  adminToken = token
}

async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD }, timeout: TIMEOUT })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
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
// TWO pickup groups in one cycle, chosen so that every claim of §UC-DP-012 has a
// party that can carry it:
//
//   L — „2 packed + 1 to-pack" (the use case's own acceptance shape)
//        A  friend, own order, ONE NESTED GUEST   → packed
//        B  friend, own order                     → packed
//        C  friend, own order                     → left to_pack
//   M — a MIXED batch, so the refusal has an innocent bystander
//        D  friend, own order                     → packed
//        S  SYNTHETIC host (no own order), 2 guest bags → packed
// ─────────────────────────────────────────────────────────────────────────────
test.describe('DP-T7 · 16 §UC-DP-012 — the group hand-over', () => {
  test.describe.configure({ mode: 'serial' })

  const fx = {}

  test.beforeAll(async () => {
    fx.cycle = await makeCycle('Group')
    fx.product = await addProduct(fx.cycle.id)
    fx.L = await makeLocation('Miesto L')
    fx.M = await makeLocation('Miesto M')

    const line = (variant, quantity) => [{ product_id: fx.product.id, variant, quantity }]
    const at = (loc) => ({ pickup_location_id: loc.id })

    fx.a = await makeFriend('Ander')
    fx.aOrder = await ownOrder(fx.a, fx.cycle.id, line('250g', 1), at(fx.L))
    const aLink = await shareLink(fx.a, fx.cycle.id)
    fx.guestA1Name = `Alica ${uniq}`
    fx.guestA1 = await submitGuest(aLink.token, line('250g', 1), { guest_name: fx.guestA1Name })

    fx.b = await makeFriend('Bela')
    fx.bOrder = await ownOrder(fx.b, fx.cycle.id, line('250g', 1), at(fx.L))

    fx.c = await makeFriend('Cyro')
    fx.cOrder = await ownOrder(fx.c, fx.cycle.id, line('250g', 1), at(fx.L))

    fx.d = await makeFriend('Dara')
    fx.dOrder = await ownOrder(fx.d, fx.cycle.id, line('250g', 1), at(fx.M))

    fx.s = await makeFriend('Synteticky')
    const sLink = await shareLink(fx.s, fx.cycle.id)
    fx.guestS1Name = `Sona ${uniq}`
    fx.guestS2Name = `Stefan ${uniq}`
    fx.guestS1 = await submitGuest(sLink.token, line('250g', 1), { guest_name: fx.guestS1Name })
    fx.guestS2 = await submitGuest(sLink.token, line('250g', 1), { guest_name: fx.guestS2Name })
    expect((await admin(`/api/orders/cycle/${fx.cycle.id}/friend/${fx.s.id}/pickup`, {
      method: 'patch', data: { pickup_location_id: fx.M.id },
    })).status(), 'synthetic host pickup').toBe(200)

    // Stage 2 for everyone but C — and this is where the ONLY ledger rows of this
    // file are written, BEFORE the watermark below is taken.
    await packParty(fx.cycle.id, fx.a.id, fx.aOrder.id)
    await packParty(fx.cycle.id, fx.b.id, fx.bOrder.id)
    await packParty(fx.cycle.id, fx.d.id, fx.dOrder.id)
    await packParty(fx.cycle.id, fx.s.id, null)
  })

  test.afterAll(async () => {
    await refreshAdminToken()
    for (const loc of [fx.L, fx.M]) {
      if (!loc) continue
      const res = await admin(`/api/pickup-locations/${loc.id}`, { method: 'delete' })
      expect([204, 404], 'fixture location retired').toContain(res.status())
    }
  })

  test('the fixture is the shape §UC-DP-012 is asserted against', async () => {
    const body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.a.id).stage).toBe('packed')
    expect(partyOf(body, fx.a.id).guest_orders, 'A carries ONE nested guest').toHaveLength(1)
    expect(partyOf(body, fx.b.id).stage).toBe('packed')
    expect(partyOf(body, fx.c.id).stage, 'C is the to-pack bag the button must not offer').toBe('to_pack')
    expect(partyOf(body, fx.d.id).stage).toBe('packed')
    const s = partyOf(body, fx.s.id)
    expect(s.has_own_order, 'S is synthetic — no orders row to stamp').toBe(false)
    expect(s.stage).toBe('packed')
    expect(s.guest_orders).toHaveLength(2)
    expect(partyOf(body, fx.a.id).delivery.target_key).toBe(`loc${fx.L.id}`)
    expect(s.delivery.target_key).toBe(`loc${fx.M.id}`)

    // The ledger line this whole file is measured against — taken AFTER the
    // fixture's packing, which is the one legitimate ledger moment in it.
    fx.friendIds = [fx.a.id, fx.b.id, fx.c.id, fx.d.id, fx.s.id]
    fx.ledgerBefore = await ledgerSnapshot(fx.friendIds)
    fx.ledgerMark = ledgerWatermark()
  })

  // ── 1. the dialog: what it says, and that „Zrušiť" is a no-op ──────────────
  test('the button opens a dialog that says what it will do — and „Zrušiť" changes nothing', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const groupKey = `loc${fx.L.id}`
    const button = page.getByTestId(`handover-group-${groupKey}`)
    // §UC-DP-012 acceptance: 2 packed + 1 to-pack ⇒ „(2)".
    await expect(button).toHaveText('Odovzdať zabalené (2)')
    await expect(button).toBeEnabled()

    // Nothing is posted until the admin confirms.
    const posts = []
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/distribution\/hand-over$/.test(req.url())) posts.push(req.url())
    })

    await button.click()
    const dialog = page.getByTestId('handover-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Odovzdať zabalené?', exact: true })).toBeVisible()

    // The subtitle names the group and the count, declined (`bagsLabel`).
    const subtitle = page.getByTestId('handover-subtitle')
    await expect(subtitle).toContainText(fx.L.name)
    await expect(subtitle).toContainText('2 balíčky')
    await expect(subtitle).toContainText('do stavu Odovzdané')

    // The ledger-neutral banner — the claim this file proves below.
    const banner = page.getByTestId('handover-ledger-note')
    await expect(banner).toContainText('Hostia v balíku hostiteľa sa označia spolu s ním.')
    await expect(banner).toContainText('Peniaze sa nemenia — účtovanie prebehlo pri zabalení.')

    // ⚠ The WhatsApp sentence is module 21's (resolved conflict 3) — not here.
    await expect(dialog).not.toContainText(/WhatsApp|správ/i)

    // Two actions, and only two.
    await expect(page.getByTestId('handover-confirm')).toHaveText('Áno, odovzdané')
    const cancel = page.getByTestId('handover-cancel')
    await expect(cancel).toHaveText('Zrušiť')

    await cancel.click()
    await expect(dialog).toBeHidden()
    expect(posts, 'a cancelled confirm posts nothing').toEqual([])

    const body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.a.id).stage, 'and nothing moved').toBe('packed')
    expect(partyOf(body, fx.b.id).stage).toBe('packed')
  })

  // ── 2. the refusal: the Alert, and EXACTLY the rows the server named ───────
  test('a stale snapshot yields the Alert, highlights only the named rows, and moves nothing', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const groupKey = `loc${fx.M.id}`
    const button = page.getByTestId(`handover-group-${groupKey}`)
    await expect(button, 'D and S are both ready').toHaveText('Odovzdať zabalené (2)')
    await button.click()
    await expect(page.getByTestId('handover-dialog')).toBeVisible()

    // Behind the screen's back: ONE of the synthetic host's bags loses an item
    // check, so the snapshot the modal promised is now stale. ⚠ S has no `orders`
    // row, so this un-check cannot post a ledger reversal (that is why the
    // bystander is the friend and the offender is the synthetic host).
    const sBefore = partyOf(await payload(fx.cycle.id), fx.s.id)
    const staleItem = sBefore.guest_orders.find((g) => g.id === fx.guestS1.id).items[0]
    expect((await admin(`/api/guest-order-items/${staleItem.id}/packed`, { method: 'patch' })).status()).toBe(200)

    await page.getByTestId('handover-confirm').click()

    // The modal closes, and the refusal is said once, on the group that refused.
    await expect(page.getByTestId('handover-dialog')).toBeHidden()
    const alert = page.getByTestId(`handover-alert-${groupKey}`)
    await expect(alert).toHaveText('Niektoré balíčky už nie sú zabalené — zoznam bol obnovený.')

    // …and the rows the SERVER named — no more, no fewer. All-or-nothing means
    // the innocent bystander in the same batch is untouched on BOTH counts.
    await expect(page.getByTestId(`bag-row-${fx.s.id}`)).toHaveAttribute('data-refused', 'true')
    await expect(page.getByTestId(`bag-row-${fx.d.id}`)).toHaveAttribute('data-refused', 'false')
    await expect(page.locator('[data-refused="true"]'), 'exactly one row is highlighted').toHaveCount(1)

    const body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.d.id).stage, 'the batch wrote NOTHING').toBe('packed')
    expect(partyOf(body, fx.s.id).stage).toBe('to_pack')
    expect(partyOf(body, fx.s.id).handed_over_at).toBeFalsy()

    // ⚠⚠ AND IT SURVIVES ANOTHER GROUP'S DIALOG, WITH ITS HIGHLIGHTS. A refusal's
    // sentence and its highlighted rows are ONE thing: the rows are what makes the
    // sentence clearable (packing one drops it). An earlier build kept the
    // sentences per group but the highlights in one flat map, so opening any other
    // group's dialog wiped M's highlights and left M's Alert pointing at nothing —
    // and the clearing path then early-returned on the missing highlight, so the
    // sentence could not be cleared at all. Worst exactly here: the offender is
    // this group's last packed bag, so its own button is at 0 and disabled.
    // Review finding, DP-T7. ⚠ The review's sketch asserted the first group's
    // alert is GONE, which is the other sanctioned fix (wipe every message with
    // the highlights); this build keeps the drops independent instead, so the
    // walk is the same and the assertion is that BOTH halves survive together.
    const otherGroup = `loc${fx.L.id}`
    await expect(page.getByTestId(`handover-group-${otherGroup}`), 'non-vacuity: L is openable').toBeEnabled()
    await page.getByTestId(`handover-group-${otherGroup}`).click()
    await expect(page.getByTestId('handover-dialog')).toBeVisible()
    await page.getByTestId('handover-cancel').click()
    await expect(page.getByTestId('handover-dialog')).toBeHidden()
    await expect(alert, 'M\'s sentence is M\'s business').toHaveText(
      'Niektoré balíčky už nie sú zabalené — zoznam bol obnovený.')
    await expect(page.getByTestId(`bag-row-${fx.s.id}`), 'and it still has a row to point at')
      .toHaveAttribute('data-refused', 'true')
    await expect(page.getByTestId(`handover-alert-${otherGroup}`), 'L never refused anything').toHaveCount(0)

    // ⚠ AND THE SENTENCE DOES NOT OUTLIVE THE ADVICE IT GAVE (the DP-T6 lesson).
    // „…už nie sú zabalené" is advice about packing; the admin takes it right here,
    // and a red line left under a group that is ready again would be a wrong
    // sentence on a money-adjacent screen.
    const row = page.getByTestId(`bag-row-${fx.s.id}`)
    await expect(row, 'the refusal path re-fetched the real state').toHaveAttribute('data-stage', 'to_pack')
    const staleRow = row.getByTestId(`guest-group-items-${fx.guestS1.id}`).locator('[data-owner="guest"]').first()
    await staleRow.click()
    await expect(staleRow.locator('input[type="checkbox"]')).toBeChecked()
    await expect(alert, 'the stale sentence is gone').toHaveCount(0)
    await expect(page.locator('[data-refused="true"]'), 'and so is the highlight').toHaveCount(0)
    expect(partyOf(await payload(fx.cycle.id), fx.s.id).stage, 'and the bag really is ready again').toBe('packed')
  })

  // ── 3. the confirm: the wire, the in-place patch, the re-fetch, the toast ──
  test('confirming posts PARTY identifiers, patches in place, re-fetches, and toasts', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)
    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)

    const groupKey = `loc${fx.L.id}`
    const rowA = page.getByTestId(`bag-row-${fx.a.id}`)

    // A is packed, so its body is gone (the shipped `v-if="!packed"`), which is
    // why the FOLD under test is the synthetic host's in group M — it is the one
    // party whose checklist survives packing. Fold it closed here, then require
    // it still folded after the hand-over of the OTHER group: a `location.reload()`
    // would have re-opened it.
    const rowS = page.getByTestId(`bag-row-${fx.s.id}`)
    const bodyS = rowS.getByTestId(`bag-row-body-${fx.s.id}`)
    // S is packed, so its row starts collapsed („done bags are one line", PO) —
    // expand it, THEN fold one guest away inside it.
    await rowS.getByTestId(`bag-row-toggle-${fx.s.id}`).click()
    const fold = rowS.getByTestId(`guest-group-items-${fx.guestS1.id}`)
    await expect(fold, 'non-vacuity: the fold is OPEN before anything is folded').toBeVisible()
    await rowS.getByTestId(`guest-group-toggle-${fx.guestS1.id}`).click()
    await expect(fold).toBeHidden()

    // Non-vacuity for the plan card: it says 0 handed before the click.
    await expect(page.getByTestId(`plan-line-loc${fx.L.id}`)).toContainText('0/3 odovzd.')

    const gets = []
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/api\/cycles\/\d+\/distribution$/.test(req.url())) gets.push(req.url())
    })

    // ⚠ THE PATCH IS NOT THE RE-FETCH, and this is where the two are told apart.
    // The re-fetch is HELD, so inside that window the only thing that can have
    // moved a row is the in-place patch — while `plan[]`, which only the server
    // answers, must still be saying exactly what it said before. Without this hold
    // the immediate re-fetch supersedes the patch and no assertion in this file
    // can see it (measured: removing `patchHandedOver` left the whole file green).
    //
    // ⚠ 4.5 s, not the 2.5 s this started at. The assertions inside the window
    // carry a 2 s bound and the toast checks run ahead of them, which left only a
    // few hundred ms of slack — and on a 2-core box one slow round would push the
    // window past the hold and let a patch-deletion mutant read GREEN again,
    // silently undoing the thing this hold exists to catch. It costs nothing:
    // the toast's own 3.5 s timer expires inside the window either way.
    const holdGet = (url) => /\/api\/cycles\/\d+\/distribution$/.test(url.pathname)
    await page.route(holdGet, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4500))
      await route.continue()
    })

    await page.getByTestId(`handover-group-${groupKey}`).click()
    const posted = page.waitForRequest((req) =>
      req.method() === 'POST' && /\/distribution\/hand-over$/.test(req.url()))
    await page.getByTestId('handover-confirm').click()
    const sent = (await posted).postDataJSON()

    // ⚠⚠ THE DECISION, ON THE WIRE. Party identifiers: one `order_id` per friend
    // party, and NOT the nested guest — DP-T4's asymmetry means an explicitly
    // listed guest with one unchecked item would abort a batch the same bag sails
    // through when merely inherited.
    expect([...sent.order_ids].sort((x, y) => x - y)).toEqual([fx.aOrder.id, fx.bOrder.id].sort((x, y) => x - y))
    expect(sent.guest_order_ids, 'no friend party contributes a guest id').toEqual([])
    expect(sent.guest_order_ids, 'A\'s nested guest INHERITS, it is never listed').not.toContain(fx.guestA1.id)
    // C is to_pack and was never offered, so it is never sent.
    expect(sent.order_ids).not.toContain(fx.cOrder.id)

    // The toast — `bagsLabel` + `handedAdjective`, and NOTHING about messages
    // (`queued_notifications` is read and dropped; module 21 renders it).
    const toast = page.getByTestId('handover-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toHaveText('2 balíčky odovzdané')
    await expect(toast).not.toContainText(/správ|WhatsApp/i)
    const shownAt = Date.now()

    // ── inside the held window: the PATCH, on its own ─────────────────────────
    // The row and its mirrors moved from the route's own answer, with no reload
    // and no payload in hand…
    await expect(rowA).toHaveAttribute('data-stage', 'handed', { timeout: 2000 })
    await expect(rowA.getByTestId(`handover-toggle-${fx.a.id}`)).toBeChecked()
    await expect(rowA.getByTestId(`handover-toggle-guest-${fx.guestA1.id}`), 'the nested guest inherited').toBeChecked()
    await expect(page.getByTestId(`bag-row-${fx.b.id}`)).toHaveAttribute('data-stage', 'handed')
    await expect(page.getByTestId(`bag-row-${fx.c.id}`), 'C was never in the batch').toHaveAttribute('data-stage', 'to_pack')
    // …while the plan card is still the one the server last sent, which is what
    // makes the previous four assertions about the PATCH and not about the GET.
    await expect(page.getByTestId(`plan-line-loc${fx.L.id}`), 'the re-fetch has not landed yet')
      .toContainText('0/3 odovzd.')

    // …and the toast clears itself on ITS OWN timer, about three and a half
    // seconds — measured HERE, still inside the held window, so the number is the
    // timer's and not "some time before the re-fetch finally landed".
    await expect(toast).toBeHidden({ timeout: 10_000 })
    const lived = Date.now() - shownAt
    expect(lived, `the toast lived ${lived} ms`).toBeGreaterThan(2500)
    expect(lived, `the toast lived ${lived} ms`).toBeLessThan(7000)

    // ── and then the RE-FETCH lands: `plan[]` is the server's alone ───────────
    await expect(page.getByTestId(`plan-line-loc${fx.L.id}`)).toContainText('2/3 odovzd.', { timeout: 10_000 })
    expect(gets.length, 'the board re-fetched').toBeGreaterThan(0)
    await page.unroute(holdGet)

    // ⚠ THE FOLD SURVIVED. This is the one assertion that tells a patch + re-fetch
    // from a page reload. Both halves are named so a collapsed ROW cannot be
    // mistaken for a folded GUEST.
    await expect(bodyS, 'the row the admin expanded is still expanded').toBeVisible()
    await expect(fold, 'a reload would have re-opened this').toBeHidden()

    // The group button now offers nothing — the two bags it counted have left.
    await expect(page.getByTestId(`handover-group-${groupKey}`)).toHaveText('Odovzdať zabalené (0)')
    await expect(page.getByTestId(`handover-group-${groupKey}`)).toBeDisabled()

    const body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.a.id).stage, 'and the server agrees').toBe('handed')
    expect(partyOf(body, fx.b.id).stage).toBe('handed')
    expect(partyOf(body, fx.c.id).stage).toBe('to_pack')
  })

  // ── 4. a synthetic host's ids, and no double post ──────────────────────────
  test('a synthetic host travels as its sub-order ids — and a second click does not double-post', async ({ page }) => {
    await loginAsAdminUI(page)
    await adoptBrowserToken(page)

    // Slow the POST down so the in-flight window is real rather than theoretical.
    const posts = []
    await page.route('**/distribution/hand-over', async (route) => {
      posts.push(route.request().postDataJSON())
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })

    await page.goto(`/admin/cycle/${fx.cycle.id}/distribution`)
    const groupKey = `loc${fx.M.id}`
    const button = page.getByTestId(`handover-group-${groupKey}`)
    await expect(button, 'D and S are ready again').toHaveText('Odovzdať zabalené (2)')
    await button.click()

    const confirm = page.getByTestId('handover-confirm')
    await confirm.click()
    // The dialog stays up while the batch is in flight, and the confirm is
    // disabled — the first line of defence.
    await expect(confirm).toBeDisabled()
    await expect(page.getByTestId(`handover-group-${groupKey}`), 'the group button too').toBeDisabled()
    // …and the JS guard is the second: a dispatched click reaches the handler even
    // on a disabled control, and must be swallowed.
    await confirm.dispatchEvent('click')
    await confirm.dispatchEvent('click')

    await expect(page.getByTestId('handover-toast')).toHaveText('2 balíčky odovzdané')
    expect(posts, 'one click, one batch').toHaveLength(1)

    // ⚠ THE SYNTHETIC HOST's IDENTIFIERS: their bag IS their sub-orders (there is
    // no `orders` row to stamp), so those ids go explicitly, beside D's order id.
    const sent = posts[0]
    expect(sent.order_ids).toEqual([fx.dOrder.id])
    expect([...sent.guest_order_ids].sort((x, y) => x - y))
      .toEqual([fx.guestS1.id, fx.guestS2.id].sort((x, y) => x - y))

    await expect(page.getByTestId(`bag-row-${fx.s.id}`)).toHaveAttribute('data-stage', 'handed')
    await expect(page.getByTestId(`bag-row-${fx.d.id}`)).toHaveAttribute('data-stage', 'handed')

    const body = await payload(fx.cycle.id)
    expect(partyOf(body, fx.s.id).stage).toBe('handed')
    expect(partyOf(body, fx.d.id).stage).toBe('handed')
  })

  // ── 5. the banner's claim, proven ─────────────────────────────────────────
  test('across every confirm, refusal and re-fetch in this file, the ledger never moved', async () => {
    await refreshAdminToken()

    // NON-VACUITY: this only means anything because bags really did go out.
    const body = await payload(fx.cycle.id)
    const handed = body.distribution.filter((p) => p.stage === 'handed')
    expect(handed.length, 'four parties were handed over by the board').toBe(4)
    expect(body.totals.handed_count).toBeGreaterThanOrEqual(4)

    expect(await ledgerSnapshot(fx.friendIds), 'stage 3 is ledger-neutral, as the banner says')
      .toEqual(fx.ledgerBefore)
    const rows = ledgerRowsSince(fx.ledgerMark, fx.friendIds)
    // ⚠ THE TELL IS THE SKIP, NOT THE FAILURE (e2e/README.md): without `DB_PATH`
    // the watermark half vanishes SILENTLY and the run still reads green. When the
    // variable IS exported, a null here means the file could not be opened — say so
    // loudly rather than lose an assertion to a typo'd path.
    if (DB_PATH) {
      expect(rows, 'DB_PATH is exported, so the watermark must have read the file').not.toBeNull()
    }
    if (rows !== null) {
      expect(rows, `the group hand-over wrote a ledger row: ${JSON.stringify(rows)}`).toEqual([])
    }
  })
})
