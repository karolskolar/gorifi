import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// Module 14 — guest order recovery (UC-GR-*). This file is the module's own spec
// file; later GR rows extend it (UC-GR-010 item 9 enumerates the obligations).
//
// GR-T7 / 14 §UC-GR-009 — the share dialog's TWO standing copy lines. The
// incident's host almost certainly regenerated the link because "Vygenerovať nový
// odkaz" read as "share with one more colleague", which silently severed every
// colleague who already held the old URL. The fix is standing copy, visible BEFORE
// the host reaches for the button:
//
//   1. `share-standing-copy` under the NeoCopyRow — one link serves ALL colleagues.
//   2. `regen-guidance` directly above the actions row — regenerate ONLY on a leak.
//
// ⚠ Both are `div.field-help`, and that is a CONSTRAINT, not a preference
// (§UC-GR-009 placement rules): `share-dialog.spec.js` pins `dialog.locator('p.sub')`
// with a single-element `toHaveText` (:239, :579), pins `subtitle.locator('b')` as a
// single element (:200) and pins the `.confirmbox` copy and its single `<b>`
// (:417-418). This row therefore edits ZERO existing spec files — the tests below
// assert the additivity directly, so a later "tidy-up" into a `p.sub` or a `<b>`
// reddens here rather than in an immutable file.
//
// Fixtures are per test, never a shared `beforeAll` (the GSO-T8 worker-restart
// lesson: Playwright re-runs `beforeAll` after a failure).
//
// NOTE ON RATE LIMITS: guest/friend/admin auth all sit behind their own buckets.
// Run with the raised budget — see e2e/README.md.

const STANDING_COPY =
  'Ten istý odkaz platí pre všetkých kolegov — každý si cez neho vytvorí vlastnú objednávku. Pre ďalšieho kolegu nevytvárajte nový odkaz.'
const REGEN_GUIDANCE =
  'Nový odkaz vygenerujte len vtedy, ak sa pôvodný dostal k nesprávnym ľuďom — kolegom potom treba poslať nový.'

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
// /api/admin/login — a UI login elsewhere invalidates a token captured earlier.
async function refreshAdminToken() {
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin re-login').toBe(200)
  adminToken = (await login.json()).token
}

// A friend with a real per-friend Bearer session — the host identity the
// guest-link routes require (the share-dialog.spec.js pattern).
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gr_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `Hostitel ${label} ${uniq}`
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
  const name = `E2E GR ${label} ${uniq}`
  const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
  expect(res.status(), 'cycle create').toBe(201)
  return { ...(await res.json()), name }
}

async function shareLink(host, cycleId) {
  const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
  expect([200, 201]).toContain(res.status())
  return (await res.json()).link
}

async function addProduct(cycleId, data) {
  const res = await admin('/api/products', { method: 'post', data: { cycle_id: cycleId, ...data } })
  expect(res.status(), 'product create').toBe(201)
  return res.json()
}

async function setCycleStatus(cycleId, status) {
  expect((await admin(`/api/cycles/${cycleId}`, { method: 'patch', data: { status } })).status()).toBe(200)
}

const IDENTITY = { guest_name: 'Martina Tomasova', guest_phone: '0901 234 567' }

// A unique 12-digit phone per call. ⚠ `validateIdentity` requires at least NINE
// digits, and `invitations` carries a partial unique index on a PENDING phone
// (`idx_invitations_phone_pending`), so a lead-capture fixture needs both.
// ⚠ The seed is 8 digits and RUN-SCOPED, mirroring `guest-lead-capture.spec.js:43`
// for its stated reason: `idx_invitations_phone_pending` is PERSISTENT while
// `phoneSeq` resets every run, so a 6-digit seed (which wraps every ~16.7 min)
// lets two runs against a long-lived DB — staging, or a `DB_PATH` kept for days —
// reuse a number. The second run then gets 409 instead of 201 from
// `invite-request`, which reads like a broken gate rather than a fixture
// collision. Later GR rows extend this file and add more lead rows, so the
// collision surface only grows.
const phoneSeed = String(Date.now()).slice(-8)
let phoneSeq = 0
const uniquePhone = () => `09${phoneSeed}${String(++phoneSeq).padStart(2, '0')}`

// A guest sub-order is only ever created through the public submit (GSO-T3).
async function submitGuest(linkToken, items, identity = IDENTITY) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

// The host's "Objednávky kolegov" payload.
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
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGR1', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

async function gotoPortal(page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Objednávkové cykly' })).toBeVisible()
}

// A hard load of /cycle/:id bounces to the portal, so a real host arrives through it.
async function gotoCycle(page, cycle) {
  await gotoPortal(page)
  await page.getByRole('heading', { name: cycle.name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/cycle/${cycle.id}$`))
}

const portalCard = (page, name) =>
  page.locator('div.card.p-4', { has: page.getByRole('heading', { name, exact: true }) })

// Entry point A — the "Kolegovia" panel in FriendOrder (module 05's own).
async function openFromOrderPage(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
  await page.getByTestId('main-tab-guests').click()
  await page.getByRole('button', { name: /Zdieľať/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// Entry point B — the portal cycle card's share row. ONE shared component
// (GSO-T2), so both entry points must render the same standing copy.
async function openFromPortal(page, host, cycle, { width = 378 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoPortal(page)
  await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

const overflow = (page) => page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}))

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  await refreshAdminToken()
})

test.afterAll(async () => { await ctx?.dispose() })

// ---------------------------------------------------------------------------
// UC-GR-009 — the share dialog's standing copy

test.describe('UC-GR-009 — share dialog standing copy', () => {
  test('link exists (order page): both lines render with the EXACT strings, as div.field-help', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('copyA')
    const cycle = await makeCycle('copyA')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)

    const standing = dialog.getByTestId('share-standing-copy')
    const guidance = dialog.getByTestId('regen-guidance')

    // ⚠ The point of line 1: the host must not read "Vygenerovať nový odkaz" as
    // "share with one more colleague" (the incident).
    await expect(standing).toBeVisible()
    await expect(standing).toHaveText(STANDING_COPY)
    await expect(guidance).toBeVisible()
    await expect(guidance).toHaveText(REGEN_GUIDANCE)

    // The primitive is mandated, not chosen — see the header note.
    for (const line of [standing, guidance]) {
      expect(await line.evaluate((el) => el.tagName)).toBe('DIV')
      expect(await line.evaluate((el) => el.className)).toBe('field-help')
      // `.field-help` is A10-covered, so no call-site line-height fix-up is
      // needed (and none may widen A10).
      expect(await line.evaluate((el) => getComputedStyle(el).lineHeight)).toBe('normal')
    }
  })

  test('link exists (portal card): the SAME two lines — one shared dialog', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('copyB')
    const cycle = await makeCycle('copyB')
    await shareLink(host, cycle.id)

    const dialog = await openFromPortal(page, host, cycle)

    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  test('placement: standing copy directly UNDER the copy row, guidance directly ABOVE the actions row', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('place')
    const cycle = await makeCycle('place')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    // Presence first, so a MISSING line fails by name instead of as a null
    // dereference inside the evaluate below.
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)

    // Structural, not merely "present somewhere": line 1 answers the copy row
    // ("this URL, for everyone"), line 2 must be read before the button it is
    // about, so it sits immediately above the actions row.
    const placement = await dialog.evaluate(() => {
      const standing = document.querySelector('[data-testid="share-standing-copy"]')
      const guidance = document.querySelector('[data-testid="regen-guidance"]')
      const actions = guidance && guidance.nextElementSibling
      return {
        prevOfStanding: standing.previousElementSibling?.className || null,
        actionsButtons: actions
          ? [...actions.querySelectorAll('button')].map((b) => (b.textContent || '').trim())
          : null,
        // Reading order top-to-bottom must be copyrow → standing → guidance.
        standingBeforeGuidance:
          standing.compareDocumentPosition(guidance) === Node.DOCUMENT_POSITION_FOLLOWING,
      }
    })

    expect(placement.prevOfStanding).toContain('copyrow')
    expect(placement.standingBeforeGuidance).toBe(true)
    expect(placement.actionsButtons).toEqual(['Deaktivovať odkaz', 'Vygenerovať nový odkaz'])
  })

  test('the no-link state gains NOTHING (there is no link to mis-share yet) — and both lines arrive with the link', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('nolink')
    const cycle = await makeCycle('nolink')

    const dialog = await openFromOrderPage(page, host, cycle)

    await expect(dialog.locator('p.sub')).toHaveText('Odkaz ešte nie je vytvorený.')
    await expect(dialog.getByTestId('share-standing-copy')).toHaveCount(0)
    await expect(dialog.getByTestId('regen-guidance')).toHaveCount(0)

    // Creating the link flips the state in place — and the copy comes with it.
    await dialog.getByRole('button', { name: 'Vytvoriť odkaz' }).click()
    await expect(dialog.locator('.copyrow')).toHaveCount(1)
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  test('a DEACTIVATED link still carries both lines (still the link-exists state)', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('deact')
    const cycle = await makeCycle('deact')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await dialog.getByRole('button', { name: 'Deaktivovať odkaz' }).click()
    await expect(dialog.locator('.banner.warn')).toBeVisible()

    // The URL stays on screen while deactivated, so the "one link for everyone"
    // statement stays true and must stay visible with it.
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)
  })

  // ⚠ THE ADDITIVITY GUARD. `share-dialog.spec.js` must pass UNMODIFIED
  // (§UC-GR-009, UC-GR-010 item 8), so this row may not introduce a second
  // `p.sub` in the dialog, a second `<b>` in the subtitle slot, or touch the
  // `.confirmbox`. Asserted here so a later refactor toward those primitives
  // fails in THIS file instead of in an immutable one.
  test('additive against every share-dialog.spec.js pin: no new p.sub, no new subtitle <b>, confirmbox untouched', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('additive')
    const cycle = await makeCycle('additive')
    await shareLink(host, cycle.id)

    const dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.getByTestId('share-standing-copy')).toBeVisible()

    // :239/:579 — `dialog.locator('p.sub')` is asserted as a SINGLE element with
    // the no-link sentence, so the link-exists state must contain none at all.
    await expect(dialog.locator('p.sub')).toHaveCount(0)
    // :200 — `subtitle.locator('b')` is a single-element `toHaveText(cycleName)`.
    const subtitle = dialog.locator('.m-head .sub')
    await expect(subtitle.locator('b')).toHaveCount(1)
    await expect(subtitle.locator('b')).toHaveText(cycle.name)
    // Neither new line may live in the subtitle slot.
    expect(await subtitle.textContent()).not.toContain('Ten istý odkaz')
    expect(await subtitle.textContent()).not.toContain('Nový odkaz vygenerujte')

    // :417-418 — the confirmbox keeps its exact copy and its ONE `<b>`; the
    // guidance is STANDING text outside the box (visible before the click, which
    // is the whole point).
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    const box = dialog.locator('.confirmbox')
    await expect(box).toContainText('Starý odkaz prestane fungovať. Objednávky, ktoré vám kolegovia už poslali, zostanú zachované.')
    await expect(box.locator('b')).toHaveCount(1)
    await expect(box.locator('b')).toHaveText('Starý odkaz prestane fungovať.')
    expect(await box.textContent(), 'the guidance is not inside the box').not.toContain('len vtedy')
    // …and the guidance stays on screen while the box is open.
    await expect(dialog.getByTestId('regen-guidance')).toBeVisible()
  })

  test('320px: the two lines add no horizontal overflow in any link-exists state', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('narrow')
    const cycle = await makeCycle('narrow')
    await shareLink(host, cycle.id)

    await page.setViewportSize({ width: 320, height: 900 })
    await signInAsHost(page, host)
    await gotoPortal(page)
    await portalCard(page, cycle.name).getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('share-standing-copy')).toBeVisible()

    // ⚠ Unlike `.btn` (nowrap, so it pushes sideways instead of degrading), a
    // `.field-help` block wraps — but the em dash and the long words are worth
    // measuring against the modal's own box rather than assuming.
    const outside = () => dialog.evaluate((modal) => {
      const box = modal.getBoundingClientRect()
      return ['share-standing-copy', 'regen-guidance'].filter((id) => {
        const r = modal.querySelector(`[data-testid="${id}"]`).getBoundingClientRect()
        return r.right > box.right + 0.5 || r.left < box.left - 0.5
      })
    })

    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await outside()).toEqual([])

    await dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' }).click()
    await expect(dialog.locator('.confirmbox')).toBeVisible()
    expect(await overflow(page)).toEqual({ scrollW: 320, clientW: 320 })
    expect(await outside()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// GR-T1 / 14 §UC-GR-001 + §UC-GR-002 (API half)
//
// THE INCIDENT: a guest paid, her host regenerated the share link, and
// `resolveGuestOrder()` resolved `order_token AND link_id` where `link_id` came
// from the CURRENT link token — so her saved URL 404'd forever while her order sat
// in the DB. The share link and the per-order URL are two credentials with
// DIFFERENT LIFETIMES: regeneration must keep revoking the former (nobody new may
// order through a leaked link) without killing the latter.
//
// So `order_token` alone is the credential from here on (D1/D2 — same generator,
// same 14 chars of `CODE_ALPHABET` entropy, SEC-S2), reachable two ways:
//   canonical  GET/PUT /api/guest/o/:orderToken (+ /invite-request)
//   legacy     GET/PUT /api/guest/:token/orders/:orderToken — the `:token` half is
//              ignored for resolution AND authorization; it is URL carriage only.
//
// ⚠ These routes are PUBLIC BY DESIGN and must never join `ADMIN_ENDPOINTS`.
//
// ⚠ The risky half of this row is the EXTRACTION: both URL forms must run the SAME
// handler bodies over a resolved `{ link, cycle, order }`. Two copies of the
// paid-freeze guard or the literal-`items:[]`-only cancel rule is how one of them
// stops enforcing it — so every gate is asserted through the CANONICAL form here
// (guest-status.spec.js keeps asserting them through the legacy one, unchanged).

const canonicalPath = (orderToken) => `/api/guest/o/${orderToken}`
const pairPath = (linkToken, orderToken) => `/api/guest/${linkToken}/orders/${orderToken}`

// One host + open coffee cycle + one product + link + a submitted sub-order.
async function orderScenario(label, { productData } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label)
  const product = await addProduct(cycle.id, {
    name: `GR ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30, ...productData,
  })
  const link = await shareLink(host, cycle.id)
  const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
  return { host, cycle, product, link, created, orderToken: created.order.order_token }
}

test.describe('UC-GR-001/002 — order_token alone is the credential', () => {
  test('THE INCIDENT: after a regeneration the guest\'s ORIGINAL pair URL still resolves — and so do the new pair form and the canonical form', async () => {
    await refreshAdminToken()
    const { host, cycle, link, created, orderToken } = await orderScenario('incident')

    // The host regenerates (UPDATE on the same row — guest-links.js:51-59).
    const regen = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect(regen.status()).toBe(200)
    const fresh = (await regen.json()).link
    expect(fresh.id, 'regeneration keeps the ROW').toBe(link.id)
    expect(fresh.token, 'only the token moves').not.toBe(link.token)

    // ⚠ THE RECOVERY. Before this row the first of these was a permanent 404.
    const underOld = await ctx.get(pairPath(link.token, orderToken))
    expect(underOld.status(), 'the RETIRED link half must not kill the order URL').toBe(200)
    const underNew = await ctx.get(pairPath(fresh.token, orderToken))
    expect(underNew.status()).toBe(200)
    const canonicalRes = await ctx.get(canonicalPath(orderToken))
    expect(canonicalRes.status()).toBe(200)

    const [oldBody, newBody, canonBody] = [await underOld.json(), await underNew.json(), await canonicalRes.json()]
    for (const [label, body] of [['old pair', oldBody], ['new pair', newBody], ['canonical', canonBody]]) {
      expect(body.order.id, label).toBe(created.order.id)
      // The payment reference is what she needs to see what she owes.
      expect(body.payment.reference, label).toBe(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
      expect(body.payment.amount, label).toBe(10)
    }
    // All three forms answer with the SAME payload — one resolver, one handler.
    expect(JSON.stringify(oldBody)).toBe(JSON.stringify(canonBody))
    expect(JSON.stringify(newBody)).toBe(JSON.stringify(canonBody))

    // …and she can still act on it through the URL she saved.
    const edited = await ctx.put(pairPath(link.token, orderToken), {
      data: { items: [{ product_id: (await hostView(host, cycle.id)).guest_orders[0].items[0].product_id, variant: '1kg', quantity: 1 }] },
    })
    expect(edited.status(), 'the write half works through the retired link half too').toBe(200)
    expect((await edited.json()).order.total).toBe(30)

    // ⚠ THE COUNTER-PIN: regeneration keeps its WHOLE purpose on the ORDERING
    // surface. Nobody new may order through the leaked link.
    expect((await ctx.get(`/api/guest/${link.token}`)).status(), 'the retired link lists nothing').toBe(404)
    const lateSubmit = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { ...IDENTITY, items: [{ product_id: 1, variant: '250g', quantity: 1 }] },
    })
    expect(lateSubmit.status(), 'the retired link takes no new sub-orders').toBe(404)
    // The fresh token still does both.
    expect((await ctx.get(`/api/guest/${fresh.token}`)).status()).toBe(200)
  })

  test('the canonical GET returns a payload identical to the pair GET, with the pinned statusPayload shape', async () => {
    await refreshAdminToken()
    const { link, orderToken } = await orderScenario('parity')

    const viaPair = await ctx.get(pairPath(link.token, orderToken))
    const viaCanonical = await ctx.get(canonicalPath(orderToken))
    expect(viaPair.status()).toBe(200)
    expect(viaCanonical.status()).toBe(200)
    const body = await viaCanonical.json()
    expect(JSON.stringify(await viaPair.json())).toBe(JSON.stringify(body))

    // statusPayload is EXTENDED, never reshaped (GSO-T4/T6).
    expect(Object.keys(body).sort()).toEqual([
      'availability', 'cycle', 'editable', 'host', 'invite_request', 'items',
      'items_editable', 'order', 'payment', 'products',
    ])
    expect(body.editable).toBe(true)
    expect(body.items_editable).toBe(true)
  })

  test('route ordering: /api/guest/o/:orderToken is NOT swallowed by GET /:token', async () => {
    await refreshAdminToken()
    const { orderToken } = await orderScenario('ordering')

    // Proven by REQUEST, not by reading the file: the listing route answers with
    // `products` + `host` and no `order`, and its 404 carries a DIFFERENT message.
    const hit = await ctx.get(canonicalPath(orderToken))
    expect(hit.status()).toBe(200)
    const body = await hit.json()
    expect(body.order, 'a status payload, not a product listing').toBeTruthy()

    // The decisive one: a garbage order token under the canonical form must answer
    // the ORDER 404, never the LINK 404 that `GET /:token` would produce.
    const miss = await ctx.get(canonicalPath('ZZZZZZZZZZZZZZ'))
    expect(miss.status()).toBe(404)
    expect((await miss.json()).error).toBe('Táto objednávka neexistuje')
  })

  test('no oracle (D2): an unknown order token answers the SAME uniform 404 in both URL forms', async () => {
    await refreshAdminToken()
    const { link } = await orderScenario('oracle')

    const cases = [
      canonicalPath('THISORDERDOESNOTEXIST'),
      canonicalPath('ZZZZZZZZZZZZZZ'),
      pairPath(link.token, 'THISORDERDOESNOTEXIST'),
      pairPath('THISLINKDOESNOTEXIST', 'THISORDERDOESNOTEXIST'),
    ]
    for (const path of cases) {
      const res = await ctx.get(path)
      expect(res.status(), path).toBe(404)
      expect((await res.json()).error, path).toBe('Táto objednávka neexistuje')
    }
  })

  test('the read side stays 404-ONLY through the canonical form: a locked cycle and a dead link both still GET 200 with the payment block', async () => {
    await refreshAdminToken()
    const { host, cycle, link, created, orderToken } = await orderScenario('readonly')

    // Locked cycle — the GSO-T4 asymmetry: the listing 410s, the status URL must not.
    await setCycleStatus(cycle.id, 'locked')
    const locked = await ctx.get(canonicalPath(orderToken))
    expect(locked.status()).toBe(200)
    const lockedBody = await locked.json()
    expect(lockedBody.editable).toBe(false)
    expect(lockedBody.items_editable).toBe(false)
    expect(lockedBody.payment.reference).toBe(`G${created.order.id} / ${IDENTITY.guest_name} / ${cycle.name}`)
    // …and the orderable listing is NOT published while un-editable (that is what
    // stops the status GET leaking what a locked cycle 410s).
    expect(lockedBody.products, 'no product grid while not editable').toBeUndefined()
    expect(lockedBody.availability).toBeUndefined()

    // Deactivated link — same read, still open.
    await setCycleStatus(cycle.id, 'open')
    expect((await ctx.patch(`/api/guest-links/${link.id}`, { headers: host.auth, data: { active: false } })).status()).toBe(200)
    const dead = await ctx.get(canonicalPath(orderToken))
    expect(dead.status(), 'a dead link must never hide the guest\'s own record').toBe(200)
    expect((await dead.json()).editable).toBe(false)
  })

  test('WRITE GATES survive the extraction — through the canonical form: 410 dead link, 409 locked, 409 cancelled (terminal)', async () => {
    await refreshAdminToken()

    // 410 — deactivated link.
    const dead = await orderScenario('gate410')
    expect((await ctx.patch(`/api/guest-links/${dead.link.id}`, { headers: dead.host.auth, data: { active: false } })).status()).toBe(200)
    const res410 = await ctx.put(canonicalPath(dead.orderToken), {
      data: { items: [{ product_id: dead.product.id, variant: '250g', quantity: 2 }] },
    })
    expect(res410.status()).toBe(410)
    expect((await res410.json()).reason).toBe('inactive')

    // 409 closed — edits end at the lock.
    const locked = await orderScenario('gate409closed')
    await setCycleStatus(locked.cycle.id, 'locked')
    const res409 = await ctx.put(canonicalPath(locked.orderToken), {
      data: { items: [{ product_id: locked.product.id, variant: '250g', quantity: 2 }] },
    })
    expect(res409.status()).toBe(409)
    expect((await res409.json()).reason).toBe('closed')

    // 409 cancelled — TERMINAL, no edge back (and it is also what stops a guest
    // reviving what the host's soft-delete removed).
    const gone = await orderScenario('gate409cancelled')
    expect((await ctx.put(canonicalPath(gone.orderToken), { data: { items: [] } })).status()).toBe(200)
    const revive = await ctx.put(canonicalPath(gone.orderToken), {
      data: { items: [{ product_id: gone.product.id, variant: '250g', quantity: 1 }] },
    })
    expect(revive.status()).toBe(409)
    expect((await revive.json()).reason).toBe('cancelled')
    // A second empty cart is refused too — cancelled means cancelled.
    expect((await ctx.put(canonicalPath(gone.orderToken), { data: { items: [] } })).status()).toBe(409)
  })

  test('WRITE GATES survive the extraction — the PAID FREEZE: 409 on a non-empty edit, but items:[] still cancels', async () => {
    await refreshAdminToken()
    const { cycle, product, created, orderToken } = await orderScenario('gatepaid')

    expect((await admin(`/api/guest-orders/${created.order.id}/paid`, { method: 'patch', data: { paid: true } })).status()).toBe(200)

    // What is owed may not be quietly rewritten once the money arrived.
    const frozen = await ctx.put(canonicalPath(orderToken), {
      data: { items: [{ product_id: product.id, variant: '1kg', quantity: 3 }] },
    })
    expect(frozen.status(), 'a paid sub-order is frozen against ITEM changes').toBe(409)
    expect((await frozen.json()).reason).toBe('paid')
    // Nothing was written.
    const after = await (await ctx.get(canonicalPath(orderToken))).json()
    expect(after.order.total).toBe(10)
    expect(after.items.length).toBe(1)
    // The page must not offer what the server refuses (the GSO-T6 finer flag).
    expect(after.editable).toBe(true)
    expect(after.items_editable, 'items_editable = editable && !paid').toBe(false)

    // Deliberately NARROW: the whole thing may still be called off — a cancel
    // leaves the refund-queue trace, which is what the guard actually protects.
    const cancelled = await ctx.put(canonicalPath(orderToken), { data: { items: [] } })
    expect(cancelled.status(), 'a paid order may still be CANCELLED').toBe(200)
    expect((await cancelled.json()).order.status).toBe('cancelled')
    expect((await (await ctx.get(canonicalPath(orderToken))).json()).order.paid, 'paid is untouched — the refund trace').toBe(1)
    void cycle
  })

  test('WRITE GATES survive the extraction — only a LITERAL items:[] may cancel; every malformed body is a NON-DESTRUCTIVE 400', async () => {
    await refreshAdminToken()
    const { product, orderToken } = await orderScenario('gatecancelintent')

    // ⚠ Cancelling is irreversible, so it needs an EXPRESSED intent. Before this
    // guard existed, `PUT {}` returned 200 and destroyed the sub-order.
    const malformed = [
      ['{} (no items key)', {}],
      ['items: null', { items: null }],
      ['items: "" (non-array)', { items: '' }],
      ['items: {} (non-array)', { items: {} }],
      ['quantity: true (nothing prices)', { items: [{ product_id: product.id, variant: '250g', quantity: true }] }],
      ['unknown variant (nothing prices)', { items: [{ product_id: product.id, variant: 'zzz', quantity: 1 }] }],
    ]
    for (const [label, data] of malformed) {
      const res = await ctx.put(canonicalPath(orderToken), { data })
      expect(res.status(), label).toBe(400)
      expect((await res.json()).field, label).toBe('items')
      // NON-destructive: the order is still alive and unchanged after every one.
      const still = await (await ctx.get(canonicalPath(orderToken))).json()
      expect(still.order.status, label).toBe('submitted')
      expect(still.order.total, label).toBe(10)
    }

    // A bodyless PUT too (a proxy stripping the body must not cancel an order).
    const bodyless = await ctx.put(canonicalPath(orderToken))
    expect(bodyless.status(), 'no body at all').toBe(400)
    expect((await (await ctx.get(canonicalPath(orderToken))).json()).order.status).toBe('submitted')

    // The literal empty list DOES cancel — and keeps the item rows (the status
    // predicate is the release mechanism, GSO-T4/T5).
    const res = await ctx.put(canonicalPath(orderToken), { data: { items: [] } })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.order.status).toBe('cancelled')
    expect(body.order.total).toBe(0)
    expect(body.items.length, 'the record of what was called off survives').toBe(1)
  })

  test('a canonical PUT applies the same bounds and snapshot pricing as the pair PUT', async () => {
    await refreshAdminToken()
    const { cycle, product, orderToken } = await orderScenario('bounds')
    const second = await addProduct(cycle.id, { name: `GR bounds second ${uniq}`, purpose: 'Filter', price_250g: 20 })

    // Re-priced from the DB snapshot, replace-in-full.
    const ok = await ctx.put(canonicalPath(orderToken), {
      data: {
        items: [
          { product_id: product.id, variant: '1kg', quantity: 2 },
          { product_id: second.id, variant: '250g', quantity: 1 },
        ],
      },
    })
    expect(ok.status()).toBe(200)
    expect((await ok.json()).order.total, '2 × 30 + 20').toBe(80)

    // Bounds: > 100 lines, and > 100 per line.
    const tooMany = await ctx.put(canonicalPath(orderToken), {
      data: { items: Array.from({ length: 101 }, () => ({ product_id: product.id, variant: '250g', quantity: 1 })) },
    })
    expect(tooMany.status()).toBe(400)
    expect((await tooMany.json()).field).toBe('items')

    const tooBig = await ctx.put(canonicalPath(orderToken), {
      data: { items: [{ product_id: product.id, variant: '250g', quantity: 101 }] },
    })
    expect(tooBig.status()).toBe(400)

    // Untouched by either refusal.
    expect((await (await ctx.get(canonicalPath(orderToken))).json()).order.total).toBe(80)
  })

  test('the invite-request CTA works on both URL forms and keeps its exact gating', async () => {
    await refreshAdminToken()

    // 201 through the CANONICAL form, bare acknowledgement body.
    const a = await orderScenario('inviteok')
    const created = await ctx.post(`${canonicalPath(a.orderToken)}/invite-request`, {
      data: { name: 'Kolega Jeden', phone: uniquePhone() },
    })
    expect(created.status()).toBe(201)
    expect(await created.json()).toEqual({ success: true })

    // A LOCKED cycle still 201s (that is exactly when a guest asks for an account)
    // — the read-side resolver, with only the 410 re-applied.
    const b = await orderScenario('invitelocked')
    await setCycleStatus(b.cycle.id, 'locked')
    const locked = await ctx.post(`${canonicalPath(b.orderToken)}/invite-request`, {
      data: { name: 'Kolega Dva', phone: uniquePhone() },
    })
    expect(locked.status(), 'a lock must not withdraw lead capture').toBe(201)

    // A CANCELLED sub-order still 201s (still a lead).
    const c = await orderScenario('invitecancelled')
    expect((await ctx.put(canonicalPath(c.orderToken), { data: { items: [] } })).status()).toBe(200)
    const afterCancel = await ctx.post(`${canonicalPath(c.orderToken)}/invite-request`, {
      data: { name: 'Kolega Tri', phone: uniquePhone() },
    })
    expect(afterCancel.status()).toBe(201)

    // A DEAD link/host DOES withdraw it — the lead would be credited to a host who
    // can no longer log in.
    const d = await orderScenario('invitedead')
    expect((await ctx.patch(`/api/guest-links/${d.link.id}`, { headers: d.host.auth, data: { active: false } })).status()).toBe(200)
    const dead = await ctx.post(`${canonicalPath(d.orderToken)}/invite-request`, {
      data: { name: 'Kolega Styri', phone: uniquePhone() },
    })
    expect(dead.status()).toBe(410)
    expect((await dead.json()).reason).toBe('inactive')

    // …and the LEGACY pair form, with a retired link half, reaches the same handler.
    const e = await orderScenario('invitelegacy')
    const regen = await ctx.post(`/api/guest-links/cycle/${e.cycle.id}`, { headers: e.host.auth })
    expect(regen.status()).toBe(200)
    const legacy = await ctx.post(`${pairPath(e.link.token, e.orderToken)}/invite-request`, {
      data: { name: 'Kolega Pat', phone: uniquePhone() },
    })
    expect(legacy.status(), 'the retired link half is carriage, not authorization').toBe(201)
  })

  test('the retired link half does not become a back door: it grants nothing the canonical form does not', async () => {
    await refreshAdminToken()
    const a = await orderScenario('nobackdoora')
    const b = await orderScenario('nobackdoorb')

    // A FOREIGN host's link half carrying a real order token resolves to THAT
    // order — the link half is ignored, so it neither helps nor hurts (D2: the
    // order token is a full standalone credential of identical entropy).
    const crossed = await ctx.get(pairPath(b.link.token, a.orderToken))
    expect(crossed.status()).toBe(200)
    expect((await crossed.json()).order.id, 'resolution follows the ORDER token').toBe(a.created.order.id)

    // ⚠ But a foreign link half must not smuggle in foreign PRODUCTS: pricing is
    // still scoped to the ORDER's own cycle.
    const smuggle = await ctx.put(pairPath(b.link.token, a.orderToken), {
      data: { items: [{ product_id: b.product.id, variant: '250g', quantity: 1 }] },
    })
    expect(smuggle.status(), 'nothing prices ⇒ non-destructive 400, never a cancel').toBe(400)
    const still = await (await ctx.get(canonicalPath(a.orderToken))).json()
    expect(still.order.status).toBe('submitted')
    expect(still.order.total).toBe(10)

    // And b's own order is untouched by any of it.
    expect((await (await ctx.get(canonicalPath(b.orderToken))).json()).order.total).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// GR-T2 — 14 §UC-GR-002 (the SPA/page half) + §UC-GR-003 + D7
//
// GR-T1 made the API resolve a guest order by `order_token` alone. This row is the
// half the guest actually sees:
//
//   1. a NEW SPA route `/g/o/:orderToken` — three segments, so it can collide with
//      neither `/g/:token` (two) nor `/g/:token/o/:orderToken` (four). Asserted by
//      NAVIGATION below, never by reading router.js;
//   2. D7 — the legacy pair PAGE re-canonicalises the address bar with
//      `router.replace` after a SUCCESSFUL load, and ⚠ NEVER on a 404: the dead card
//      (06 §UC-GX-010) is diagnostic, so it must keep the URL the guest actually
//      followed on screen;
//   3. `status_path` (the submit response) becomes the canonical form, which carries
//      the whole confirmation screen with it — GuestOrder.vue consumes it verbatim;
//   4. `localStorage.gorifi_guest_orders` KEEPS ITS PAIR-KEYED SHAPE FOREVER (a
//      deliberate non-migration — the pair form working forever is what makes it
//      safe). On the canonical route there is no link token to key an entry on, so
//      `refreshStoredEntry` must UPDATE-BY-SCAN and must NEVER CREATE.
//
// Fixtures stay per test (the GSO-T8 worker-restart lesson).

const canonicalUiPath = (orderToken) => `/g/o/${orderToken}`
const pairUiPath = (linkToken, orderToken) => `/g/${linkToken}/o/${orderToken}`

const STORAGE_KEY = 'gorifi_guest_orders'
const readStore = (page) => page.evaluate((k) => {
  const raw = localStorage.getItem(k)
  return raw === null ? null : JSON.parse(raw)
}, STORAGE_KEY)

test.describe('UC-GR-002/003 + D7 — the guest surface uses the canonical URL', () => {
  test('§UC-GR-003: the submit response hands out the CANONICAL status_path — no link token in it', async () => {
    await refreshAdminToken()
    const { link, created, orderToken } = await orderScenario('statuspath')

    expect(created.status_path, 'the canonical form (14 §UC-GR-003)').toMatch(/^\/g\/o\/[A-Z2-9]{12,}$/)
    expect(created.status_path).toBe(canonicalUiPath(orderToken))
    // ⚠ The counter-pin: the link half is not merely moved, it is GONE. A path that
    // still carried it would keep propagating the legacy form from every new order.
    expect(created.status_path).not.toContain(link.token)
  })

  test('THE INCIDENT, UI HALF: after a regeneration the guest opens her SAVED pair URL and sees her order (D7 then canonicalises the address bar)', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, link, created, orderToken } = await orderScenario('uiincident')

    // The host regenerates — the exact production state that stranded her.
    const regen = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect(regen.status()).toBe(200)
    expect((await regen.json()).link.token, 'the link half of her URL is now retired').not.toBe(link.token)

    // She opens the URL from her messages. Before this module: the g-dead card.
    await page.goto(pairUiPath(link.token, orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()
    await expect(page.getByTestId('guest-status-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('status-total')).toContainText('10.00')
    await expect(page.getByTestId('open-payment'), 'she can still see what she owes').toBeVisible()

    // D7: the address bar is rewritten to the canonical form, so anything she
    // re-copies from it is canonical — and the retired link half is gone from it.
    await expect(page).toHaveURL(new RegExp(`${canonicalUiPath(orderToken)}$`))
    expect(new URL(page.url()).pathname).not.toContain(link.token)

    // And the page is fully live at the canonical URL, not merely rendered: she can
    // still act on the order she thought she had lost.
    await page.getByTestId('start-edit').click()
    const card = page.getByTestId(`product-${(await hostView(host, cycle.id)).guest_orders[0].items[0].product_id}`)
    await card.getByTestId('inc-1kg').click()
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-total')).toContainText('40.00')
    expect((await (await ctx.get(canonicalPath(orderToken))).json()).order.total, 'the edit really persisted').toBe(40)
    expect(created.order.total).toBe(10)
  })

  test('⚠ D7 NEVER fires on a 404: the dead card keeps the URL the guest actually followed', async ({ page }) => {
    await refreshAdminToken()
    const { link } = await orderScenario('d7dead')

    // (a) the legacy pair form with a dead order half — the URL must stay EXACTLY as
    // followed. Rewriting it under a failure hides what the guest clicked, which is
    // the one thing the diagnostic card exists to show.
    const deadPair = pairUiPath(link.token, 'THISORDERDOESNOTEXIST')
    await page.goto(deadPair)
    await expect(page.getByTestId('guest-status-unavailable')).toBeVisible()
    await expect(page.getByTestId('guest-status')).toHaveCount(0)
    expect(new URL(page.url()).pathname, 'no router.replace on a failure (D7)').toBe(deadPair)

    // (b) the canonical form with a dead token — same card, URL equally untouched.
    const deadCanonical = canonicalUiPath('THISORDERDOESNOTEXIST')
    await page.goto(deadCanonical)
    await expect(page.getByTestId('guest-status-unavailable')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(deadCanonical)
  })

  test('route table (by NAVIGATION, not by reading router.js): /g/o/:orderToken collides with neither /g/:token nor the pair form', async ({ page }) => {
    await refreshAdminToken()
    const { link, orderToken } = await orderScenario('routes')

    // 3 segments — the new canonical status page.
    await page.goto(canonicalUiPath(orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()

    // 2 segments — still the ORDERING page. ⚠ If `/g/o/:x` had been written as a
    // greedy `/g/:token` variant, or registered after a catch-all, one of these two
    // would silently serve the other's component.
    await page.goto(`/g/${link.token}`)
    await expect(page.getByTestId('open-checkout'), 'the ORDERING page, cart bar and all').toBeVisible()
    await expect(page.getByTestId('guest-status')).toHaveCount(0)

    // 4 segments — the legacy pair page still resolves (UC-GR-002: forever), and D7
    // hands it over to the canonical URL.
    await page.goto(pairUiPath(link.token, orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`${canonicalUiPath(orderToken)}$`))

    // The literal segment `o` can never be a token: `generateGuestToken()` emits 14
    // chars of the uppercase `CODE_ALPHABET`. `/g/o` alone is therefore a 2-segment
    // ordering URL for a token that cannot exist — it must NOT render a status page.
    await page.goto('/g/o')
    await expect(page.getByTestId('guest-status')).toHaveCount(0)
  })

  test('§UC-GR-003 localStorage: a pre-existing PAIR-KEYED entry is UPDATED BY SCAN on the canonical route — one entry in, one entry out', async ({ page }) => {
    await refreshAdminToken()
    const { link, created, orderToken } = await orderScenario('lsscan')
    const origin = new URL(process.env.BASE_URL || 'http://localhost:3997').origin

    // The shape GSO-T3 wrote and this module deliberately does NOT migrate: keyed by
    // LINK token, with `order_token` inside. Seeded with the OLD pair `status_url`,
    // as a real returning guest's device would hold it.
    await page.addInitScript(({ k, token, entry }) => {
      localStorage.setItem(k, JSON.stringify({ [token]: entry }))
    }, {
      k: STORAGE_KEY,
      token: link.token,
      entry: {
        order_id: created.order.id,
        order_token: orderToken,
        status_url: `${origin}/g/${link.token}/o/${orderToken}`,
        guest_name: IDENTITY.guest_name,
        cycle_name: 'stale name',
        total: 10,
        saved_at: '2020-01-01T00:00:00.000Z',
      },
    })

    // She arrives on the canonical route — where there is NO link token at all.
    await page.goto(canonicalUiPath(orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()

    const store = await readStore(page)
    // ⚠ THE COUNT, not just presence: a second entry keyed on something else would
    // leave the first stale forever and the "your order" card would show two.
    expect(Object.keys(store), 'exactly one entry, still keyed by the LINK token').toEqual([link.token])
    const entry = store[link.token]
    expect(entry.order_token).toBe(orderToken)
    expect(entry.order_id).toBe(created.order.id)
    // Refreshed in place — including the canonical `status_url` (§UC-GR-003).
    expect(entry.status_url).toBe(`${origin}${canonicalUiPath(orderToken)}`)
    expect(entry.cycle_name, 'stale fields are refreshed, not preserved').not.toBe('stale name')
    expect(entry.status).toBe('submitted')
    expect(entry.saved_at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  test('⚠ §UC-GR-003 localStorage: the canonical route NEVER CREATES an entry (only a real submit does)', async ({ page }) => {
    await refreshAdminToken()
    const { orderToken } = await orderScenario('lsnocreate')
    const other = await orderScenario('lsother')

    // (a) an empty device: the order renders, and nothing is written. There is no
    // link token on this route to key an entry on, so inventing one would fabricate
    // a "your order" card under a key that means nothing.
    await page.goto(canonicalUiPath(orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()
    expect(await readStore(page), 'no entry conjured out of the canonical route').toBeNull()

    // (b) a device holding ANOTHER link's order: the count must not grow, and the
    // foreign entry must not be touched.
    const foreign = {
      order_id: other.created.order.id,
      order_token: other.orderToken,
      status_url: `x/${other.link.token}`,
      guest_name: IDENTITY.guest_name,
      cycle_name: 'other cycle',
      total: 10,
      saved_at: '2020-01-01T00:00:00.000Z',
    }
    await page.addInitScript(({ k, token, entry }) => {
      localStorage.setItem(k, JSON.stringify({ [token]: entry }))
    }, { k: STORAGE_KEY, token: other.link.token, entry: foreign })

    await page.goto(canonicalUiPath(orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()
    const store = await readStore(page)
    expect(Object.keys(store), 'still exactly one entry — the foreign one').toEqual([other.link.token])
    expect(store[other.link.token]).toEqual(foreign)
  })

  test('the canonical route is a FULL surface with no link token available: edit, cancel and the lead-capture CTA all work', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, orderToken } = await orderScenario('canonui')

    await page.goto(canonicalUiPath(orderToken))
    await expect(page.getByTestId('guest-status')).toBeVisible()

    // Edit — the PUT must go to the tokenless endpoint (api.js composes it).
    await page.getByTestId('start-edit').click()
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('save-edit').click()
    await expect(page.getByTestId('status-total')).toContainText('20.00')

    // Lead capture — GSO-T10's endpoint through the canonical form. The lead is
    // credited to the ORDER's host, which is the only host this route can know.
    const phone = uniquePhone()
    await page.getByTestId('invite-cta-open').click()
    await page.getByTestId('invite-name').fill('Martina Tomasova')
    await page.getByTestId('invite-phone').fill(phone)
    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-done')).toBeVisible()
    const pending = await (await admin('/api/invitations?status=pending')).json()
    const lead = pending.find((i) => i.phone === phone)
    expect(lead, 'the lead reached the queue').toBeTruthy()
    expect(lead.invited_by_friend_id).toBe(host.id)
    expect(lead.source).toBe('guest_order')

    // Cancel — terminal, and reachable with only an order token in the URL.
    await page.getByTestId('start-edit').click()
    await page.getByTestId('cancel-order').click()
    await page.getByTestId('confirm-cancel-order').click()
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    expect((await (await ctx.get(canonicalPath(orderToken))).json()).order.status).toBe('cancelled')

    // The host's own screen agrees (one row, cancelled) — nothing was orphaned.
    const view = await hostView(host, cycle.id)
    expect(view.guest_orders).toHaveLength(1)
    expect(view.guest_orders[0].status).toBe('cancelled')
  })
})

// ---------------------------------------------------------------------------
// UC-GR-004 / D3 — the ADMIN half of the now-MIXED /api/guest-links router.
//
// PO requirement 1: the admin must be able to read every host's guest link for a
// cycle (to forward it when a colleague loses it) and to CREATE one for a friend
// who has not shared yet. D3 fixes the ceiling: READ + CREATE only. There is no
// admin regenerate, no deactivate and no reactivate — revocation stays host-only,
// because an admin regenerate silently severs every colleague already holding the
// URL (that is literally the incident) and an admin reactivate would republish a
// link the host deliberately revoked after a leak.
//
// ⚠ The idempotency test below (`token asserted UNCHANGED`) IS the machine proof of
// the non-capability: the only way an admin route on this router can rotate a token
// is through this POST, so a future "improvement" that makes create-if-missing
// regenerate reddens by name here.

async function adminLinks(cycleId) {
  const res = await admin(`/api/guest-links/cycle/${cycleId}/all`)
  expect(res.status(), 'admin link listing').toBe(200)
  return (await res.json()).links
}

const adminCreateLink = (cycleId, friendId) =>
  admin(`/api/guest-links/cycle/${cycleId}/host/${friendId}`, { method: 'post' })

test.describe('UC-GR-004 — admin reads + creates host share links', () => {
  test('the read returns EVERY host\'s link for the cycle, with the token and the host name', async () => {
    await refreshAdminToken()
    const cycleA = await makeCycle('linksA')
    const cycleB = await makeCycle('linksB')
    const hostOne = await makeHost('linksone')
    const hostTwo = await makeHost('linkstwo')
    const linkOne = await shareLink(hostOne, cycleA.id)
    const linkTwo = await shareLink(hostTwo, cycleA.id)
    // A link in ANOTHER cycle for the same host must not leak into this listing.
    const elsewhere = await shareLink(hostOne, cycleB.id)

    const links = await adminLinks(cycleA.id)
    const byHost = new Map(links.map((l) => [l.host_friend_id, l]))

    expect(byHost.get(hostOne.id), 'host one is listed').toBeTruthy()
    expect(byHost.get(hostOne.id).token, 'the token IS the point — it is what the admin forwards').toBe(linkOne.token)
    expect(byHost.get(hostOne.id).host_name).toBe(hostOne.name)
    expect(byHost.get(hostOne.id).host_active).toBe(1)
    expect(byHost.get(hostOne.id).active).toBe(1)
    expect(byHost.get(hostOne.id).id).toBe(linkOne.id)
    expect(typeof byHost.get(hostOne.id).created_at).toBe('string')

    expect(byHost.get(hostTwo.id).token).toBe(linkTwo.token)
    expect(byHost.get(hostTwo.id).host_name).toBe(hostTwo.name)

    expect(links.map((l) => l.token), 'cycle-scoped: the other cycle\'s link stays out')
      .not.toContain(elsewhere.token)

    // `order_token` is sub-order data, not link data (UC-GR-004) — GR-T5 publishes
    // it on the sub-order rows, never here.
    expect(JSON.stringify(links)).not.toContain('order_token')
  })

  test('the read reports a DEACTIVATED link and a DEACTIVATED host as state, with no way to flip either', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkstate')
    const revoker = await makeHost('linkrevoke')
    const gone = await makeHost('linkgone')
    const revoked = await shareLink(revoker, cycle.id)
    const orphaned = await shareLink(gone, cycle.id)

    // Host-only revocation (PATCH /guest-links/:id) — the capability D3 keeps host-side.
    expect((await ctx.patch(`/api/guest-links/${revoked.id}`, {
      headers: revoker.auth, data: { active: 0 },
    })).status()).toBe(200)
    expect((await admin(`/api/friends/${gone.id}`, { method: 'patch', data: { active: 0 } })).status()).toBe(200)

    const links = await adminLinks(cycle.id)
    const byHost = new Map(links.map((l) => [l.host_friend_id, l]))
    expect(byHost.get(revoker.id).active, 'a revoked link is LISTED with active 0, not hidden').toBe(0)
    expect(byHost.get(revoker.id).host_active).toBe(1)
    expect(byHost.get(gone.id).active, 'the link row itself is untouched by the host going inactive').toBe(1)
    expect(byHost.get(gone.id).host_active, 'but the host flag tells the admin it is dead anyway').toBe(0)
  })

  test('the read 404s an unknown cycle', async () => {
    await refreshAdminToken()
    const res = await admin('/api/guest-links/cycle/99999999/all')
    expect(res.status()).toBe(404)
  })

  test('create-if-missing: 201 for a linkless friend, and the host\'s own GET then returns it', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkcreate')
    const host = await makeHost('linkcreate')

    // The host has never shared — their own view says so.
    expect((await hostView(host, cycle.id)).link, 'no link yet').toBeFalsy()

    const res = await adminCreateLink(cycle.id, host.id)
    expect(res.status(), 'a fresh link is a creation').toBe(201)
    const body = await res.json()
    expect(body.created).toBe(true)
    expect(body.link.active, 'created active — a link the admin forwards must work').toBe(1)
    expect(body.link.host_friend_id).toBe(host.id)
    expect(body.link.cycle_id).toBe(cycle.id)
    expect(body.link.token).toMatch(/^[A-Z2-9]{14}$/)

    // The host sees it on their next dialog open — no notification mechanism exists.
    const view = await hostView(host, cycle.id)
    expect(view.link.token).toBe(body.link.token)

    // And it actually works as a guest ordering link.
    const product = await addProduct(cycle.id, { name: `GR linkcreate ${uniq}`, purpose: 'Espresso', price_250g: 9 })
    const created = await submitGuest(body.link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect(created.order.total).toBeGreaterThan(0)
  })

  test('create-if-missing is IDEMPOTENT and the token is byte-identical on repeat — the no-regenerate proof (D3)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkidem')
    const host = await makeHost('linkidem')
    const original = await shareLink(host, cycle.id)

    // A guest is already holding the URL — this is the incident's setup.
    const product = await addProduct(cycle.id, { name: `GR linkidem ${uniq}`, purpose: 'Espresso', price_250g: 10 })
    const guest = await submitGuest(original.token, [{ product_id: product.id, variant: '250g', quantity: 1 }])

    for (const attempt of [1, 2, 3]) {
      const res = await adminCreateLink(cycle.id, host.id)
      expect(res.status(), `attempt ${attempt} returns the existing row, not a creation`).toBe(200)
      const body = await res.json()
      expect(body.created).toBe(false)
      expect(body.link.id).toBe(original.id)
      expect(body.link.token, `attempt ${attempt}: THE TOKEN MUST NOT ROTATE (D3 — no admin regenerate)`)
        .toBe(original.token)
      expect(body.link.active, 'and `active` is never written by this route').toBe(1)
    }

    // The guest's own ordering surface is still alive on the ORIGINAL token, which
    // is the property an admin regenerate would have destroyed.
    expect((await ctx.get(`/api/guest/${original.token}`)).status()).toBe(200)
    expect((await ctx.get(canonicalPath(guest.order.order_token))).status()).toBe(200)
  })

  test('create-if-missing returns a REVOKED existing link untouched — it never reactivates (D3)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkrevoked')
    const host = await makeHost('linkrevoked')
    const link = await shareLink(host, cycle.id)
    expect((await ctx.patch(`/api/guest-links/${link.id}`, {
      headers: host.auth, data: { active: 0 },
    })).status()).toBe(200)

    const res = await adminCreateLink(cycle.id, host.id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.created).toBe(false)
    expect(body.link.id).toBe(link.id)
    expect(body.link.token).toBe(link.token)
    expect(body.link.active, 'a link the host deliberately revoked STAYS revoked').toBe(0)

    // Proof at the guest door: the link is still shut.
    expect((await ctx.get(`/api/guest/${link.token}`)).status()).toBe(410)

    // And the DB row agrees, not just the response.
    expect((await adminLinks(cycle.id)).find((l) => l.id === link.id).active).toBe(0)
  })

  test('create: 404 unknown cycle, 404 unknown friend, 409 `inactive_host` for a deactivated friend', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkgates')
    const host = await makeHost('linkgates')

    expect((await adminCreateLink(99999999, host.id)).status()).toBe(404)
    expect((await adminCreateLink(cycle.id, 99999999)).status()).toBe(404)

    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: 0 } })).status()).toBe(200)
    const res = await adminCreateLink(cycle.id, host.id)
    expect(res.status(), 'creating a link for an inactive host would hand the admin a dead URL').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('inactive_host')
    expect(typeof body.error).toBe('string')

    // Nothing was written.
    expect((await adminLinks(cycle.id)).filter((l) => l.host_friend_id === host.id)).toHaveLength(0)
  })

  test('no cycle-status gate — a locked cycle still yields a link (mirrors the host\'s own POST)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linklocked')
    const host = await makeHost('linklocked')
    await setCycleStatus(cycle.id, 'locked')

    const res = await adminCreateLink(cycle.id, host.id)
    expect(res.status()).toBe(201)
    // Inert, as the spec says: `resolveLink` 410s a non-open cycle.
    expect((await ctx.get(`/api/guest/${(await res.json()).link.token}`)).status()).toBe(410)
  })

  test('BOTH auth directions: the new admin routes refuse anonymous and friend tokens; the three host routes refuse an admin token', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkauth')
    const host = await makeHost('linkauth')
    const link = await shareLink(host, cycle.id)

    const adminPaths = [
      { method: 'get', path: `/api/guest-links/cycle/${cycle.id}/all` },
      { method: 'post', path: `/api/guest-links/cycle/${cycle.id}/host/${host.id}` },
    ]
    for (const ep of adminPaths) {
      expect((await ctx[ep.method](ep.path)).status(), `${ep.path} anonymous`).toBe(401)
      expect((await ctx[ep.method](ep.path, { headers: host.auth })).status(),
        `${ep.path} must not accept a friend Bearer token`).toBe(401)
      expect((await ctx[ep.method](ep.path, { headers: { 'X-Friends-Password': 'whatever' } })).status(),
        `${ep.path} must not accept the shared friends password`).toBe(401)
    }

    // The mount is BARE and gated per route: the three HOST routes must still
    // refuse an admin token (wrapping the mount in requireAdmin would break them,
    // wrapping it in requireHost would break the two above).
    const hostPaths = [
      { method: 'get', path: `/api/guest-links/cycle/${cycle.id}` },
      { method: 'post', path: `/api/guest-links/cycle/${cycle.id}` },
      { method: 'patch', path: `/api/guest-links/${link.id}` },
    ]
    for (const ep of hostPaths) {
      expect((await admin(ep.path, { method: ep.method })).status(),
        `${ep.path} is a friend surface, not an admin one`).toBe(401)
    }

    // And the host's own routes still work — the mix did not disturb them.
    expect((await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).status()).toBe(200)
  })

  test('the admin has NO regenerate / deactivate / reactivate on guest links (D3 non-capability)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkncap')
    const host = await makeHost('linkncap')
    const link = await shareLink(host, cycle.id)

    // No admin route on this prefix may write `token` or `active`. The plausible
    // shapes a future row might reach for all stay unauthorized-or-absent.
    const attempts = [
      { method: 'patch', path: `/api/guest-links/${link.id}`, data: { active: 0 } },
      { method: 'patch', path: `/api/guest-links/cycle/${cycle.id}/host/${host.id}`, data: { active: 0 } },
      { method: 'post', path: `/api/guest-links/${link.id}/regenerate` },
      { method: 'post', path: `/api/guest-links/cycle/${cycle.id}/host/${host.id}/regenerate` },
      { method: 'delete', path: `/api/guest-links/${link.id}` },
    ]
    for (const a of attempts) {
      const status = (await admin(a.path, { method: a.method, data: a.data })).status()
      expect([401, 404, 405], `${a.method.toUpperCase()} ${a.path} must not be an admin capability`)
        .toContain(status)
    }

    // A body smuggled into the create route changes nothing either.
    const smuggle = await admin(`/api/guest-links/cycle/${cycle.id}/host/${host.id}`, {
      method: 'post', data: { active: 0, token: 'SMUGGLEDTOKEN' },
    })
    expect(smuggle.status()).toBe(200)
    const after = (await adminLinks(cycle.id)).find((l) => l.id === link.id)
    expect(after.token, 'the request body is never spread into SQL').toBe(link.token)
    expect(after.active).toBe(1)
  })
})
