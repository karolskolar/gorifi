import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_PASSWORD } from '../fixtures.js'
// GR-T8 / §UC-GR-011 — the mail describe at the bottom of this file. The SHARED
// harness (08 §UC-EM-005 item 1's extraction), never a fork.
import {
  CAN_SPAWN_BACKEND,
  FAKE_MAILGUN_KEY,
  STUB_MAILGUN_DOMAIN,
  withMailHarness,
  multipartFields,
} from '../mailgun-harness.js'

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
  'Ten istý odkaz platí pre všetkých kolegov - každý si cez neho vytvorí vlastnú objednávku. Pre ďalšieho kolegu nevytvárajte nový odkaz.'
const REGEN_GUIDANCE =
  'Nový odkaz vygenerujte len vtedy, ak sa pôvodný dostal k nesprávnym ľuďom - kolegom potom treba poslať nový.'


// GR-T5 / 14 §UC-GR-007 — the host's per-sub-order copy control. DRAFT copy pending
// PO sign-off (§OPEN), hoisted for the same reason as the two lines above: the
// sign-off edit is then a known TWO-PLACE change (these constants + the SFC
// literals), not a grep for quoted Slovak across the suite.
const COPY_LABEL = 'Kopírovať odkaz'
const COPIED_LABEL = 'Skopírované!'
const COPY_TITLE = 'Odkaz na stav objednávky pre kolegu'
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

// ⚠ ROTATE A LINK TOKEN AFTER COLLEAGUES HAVE ORDERED — and it MUST go through the
// ADMIN route (D3 as AMENDED, PO decision 2026-08-31).
//
// Most fixtures in this file need a RETIRED link half, because that is the incident
// this module exists for. Until 2026-08-31 they produced one with the HOST's own
// `POST /api/guest-links/cycle/:id`. That call now answers **409 `reason:'has_orders'`**
// whenever a live sub-order hangs off the link — which is true of every one of those
// fixtures — so four of them were FORCED to move here. The retarget is a sharpening,
// not a workaround: it is exactly the escalation a real host now performs (their
// dialog says "kontaktujte správcu"), so these fixtures reproduce the CURRENT
// production path to a retired token rather than one the app refuses.
//
// The admin route rotates `token` on the existing row and never writes `active`.
async function adminRegenerate(cycleId, friendId, label = 'admin regenerate') {
  const res = await admin(`/api/guest-links/cycle/${cycleId}/host/${friendId}/regenerate`, { method: 'post' })
  expect(res.status(), label).toBe(200)
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

    // ⚠ RETARGETED by a PO decision (2026-08-31, §OPEN option (b)). This test used to
    // assert the opposite — that "one link for everyone" stays visible while the link
    // is deactivated, on the reasoning that the URL is still on screen. The PO read the
    // shipped screen and disagreed, correctly: two rows above, the banner says
    // "Odkaz je deaktivovaný - kolegovia si cez neho nemôžu objednať", so a line
    // claiming the link "platí pre všetkých kolegov" contradicts it in that one state.
    // The guidance STAYS — when regeneration is the right move is exactly what a host
    // looking at a revoked link needs to read.
    await expect(dialog.getByTestId('share-standing-copy'),
      'it contradicts the deactivated banner two rows above').toHaveCount(0)
    await expect(dialog.getByTestId('regen-guidance')).toHaveText(REGEN_GUIDANCE)

    // …and it comes back on reactivation, so this is a state rule, not a deletion.
    await dialog.getByRole('button', { name: 'Znova aktivovať' }).click()
    await expect(dialog.getByTestId('share-standing-copy')).toHaveText(STANDING_COPY)
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

    // ⚠ RETARGETED (PO decision, 2026-08-31): the regeneration is performed by the
    // ADMIN. The HOST's own POST now 409s `has_orders` here — a live sub-order exists
    // by the line above — so the old host call could no longer produce the retired
    // token this test is about. The property under test is unchanged (a rotated token
    // must not kill an existing order URL); only the actor moved, to the one the
    // dialog now escalates to. UPDATE in place on the same row, never DELETE+INSERT.
    const fresh = await adminRegenerate(cycle.id, host.id, 'admin rotates the token')
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
    // ⚠ RETARGETED (PO decision, 2026-08-31) — admin actor, host's POST now 409s
    // `has_orders`. Incidental setup: this only needs a retired link HALF to prove it
    // is carriage rather than authorization, so which actor retired it is immaterial.
    await adminRegenerate(e.cycle.id, e.host.id, 'retire the link half')
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

    // The link is regenerated — the exact production state that stranded her.
    // ⚠ RETARGETED (PO decision, 2026-08-31) to the ADMIN actor: the host's own POST
    // now 409s `has_orders` because her order already exists. This is the CURRENT
    // production path to a retired token, so the reproduction is more faithful, not
    // less.
    const rotated = await adminRegenerate(cycle.id, host.id)
    expect(rotated.token, 'the link half of her URL is now retired').not.toBe(link.token)

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
// who has not shared yet.
//
// ⚠⚠ D3's CEILING WAS AMENDED (PO decision, 2026-08-31): READ + CREATE + REGENERATE.
// The admin still has NO deactivate and NO reactivate.
//
// D3 forbade an admin regenerate because it "silently severs every colleague already
// holding the URL — that is literally the incident". THAT REASON IS SPENT: since
// GR-T1/GR-T2 a guest's order resolves by `order_token` alone (§UC-GR-001/002), so no
// regeneration by anyone can strand an existing order. What regeneration still does is
// retire the ORDERING url, which is a deliberate act. The other half of D3 stands
// unamended — an admin reactivate would republish a link the host revoked after a
// leak, and only the host knows who holds it — so `active` remains host-only and the
// regenerate route writes `token` only.
//
// It exists because the HOST's own regenerate now REFUSES while live sub-orders exist
// (409 `reason:'has_orders'`, the PO's rule — see the UC-GR-012 describe at the foot
// of this file) and the share dialog tells the host to contact the admin. Without the
// admin route that copy would point at a dead end, which is the GSO-T5 mistake this
// module was written to remove.
//
// ⚠ The idempotency test below (`token asserted UNCHANGED`) IS STILL the machine proof
// that CREATE never rotates: regeneration is a separate, explicitly-named route, so a
// future "improvement" that makes create-if-missing rotate a token still reddens by
// name here. That pin did not weaken with the amendment — it got a sibling.

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

  test('the admin has NO deactivate / reactivate on guest links (the surviving half of D3)', async () => {
    await refreshAdminToken()
    const cycle = await makeCycle('linkncap')
    const host = await makeHost('linkncap')
    const link = await shareLink(host, cycle.id)

    // ⚠ RETARGETED (PO decision, 2026-08-31). `POST /cycle/:id/host/:id/regenerate`
    // used to sit in this list; it is now a real capability, pinned positively below
    // and in the UC-GR-012 describe. Everything else here is UNCHANGED and still
    // forbidden: **no admin route on this prefix may write `active`**, and the
    // `/:id/regenerate` shape is deliberately still absent — the capability hangs off
    // the (cycle, host) pair, not off a bare link id, so a caller cannot reach a link
    // whose cycle it never named.
    const attempts = [
      { method: 'patch', path: `/api/guest-links/${link.id}`, data: { active: 0 } },
      { method: 'patch', path: `/api/guest-links/cycle/${cycle.id}/host/${host.id}`, data: { active: 0 } },
      { method: 'post', path: `/api/guest-links/${link.id}/regenerate` },
      { method: 'delete', path: `/api/guest-links/${link.id}` },
    ]
    for (const a of attempts) {
      const status = (await admin(a.path, { method: a.method, data: a.data })).status()
      expect([401, 404, 405], `${a.method.toUpperCase()} ${a.path} must not be an admin capability`)
        .toContain(status)
    }

    // The regenerate that DOES exist rotates the token and leaves `active` alone —
    // which is what keeps it from being a back-door reactivate. Proved on a REVOKED
    // link, the only state where the difference is observable.
    expect((await ctx.patch(`/api/guest-links/${link.id}`, {
      headers: host.auth, data: { active: false },
    })).status(), 'the host revokes').toBe(200)

    const rotated = await adminRegenerate(cycle.id, host.id)
    expect(rotated.token, 'the token rotated').not.toBe(link.token)
    expect(rotated.id, 'same row — the sub-order FKs stay valid').toBe(link.id)
    expect(rotated.active, '⚠ a revoked link STAYS revoked through an admin regeneration').toBe(0)

    // A body smuggled into the create route changes nothing either. ⚠ The expected
    // values are now the POST-ROTATION state (rotated token, still revoked), because
    // the block above deliberately moved both — and that makes this assertion say
    // MORE than it used to: the create route neither rotates a token nor reactivates a
    // revoked link, which is the half of D3 the amendment left standing.
    const smuggle = await admin(`/api/guest-links/cycle/${cycle.id}/host/${host.id}`, {
      method: 'post', data: { active: 1, token: 'SMUGGLEDTOKEN' },
    })
    expect(smuggle.status()).toBe(200)
    const after = (await adminLinks(cycle.id)).find((l) => l.id === link.id)
    expect(after.token, 'the request body is never spread into SQL').toBe(rotated.token)
    expect(after.active, 'create never reactivates what the host revoked').toBe(0)
  })
})

// ---------------------------------------------------------------------------
// GR-T4 / 14 §UC-GR-005 — the ADMIN soft-cancel: POST /api/guest-orders/:id/cancel
// ---------------------------------------------------------------------------
//
// The escalation the host's DELETE points at ("Táto objednávka je už zaplatená.
// Zrušenie vyriešte so správcom.") was a DEAD END: the admin surface of
// `/api/guest-orders` was `/paid` + `/unpaid` and nothing else, so a paid guest who
// changed her mind could be cancelled by nobody — not the guest's own `items: []`
// path either, which the paid freeze (GSO-T6) 409s. This row gives the escalation a
// working target (resolved conflict 3).
//
// The money rules, each with its reason:
//   • SOFT cancel — `status='cancelled'`, `total=0`, `guest_order_items` KEPT. The
//     status predicate IS the release mechanism (`helpers/stock.js`
//     `COALESCE(status,'submitted') <> 'cancelled'`), so a row delete would buy
//     nothing and destroy the record of what was ordered and then called off.
//   • NO paid blockade (D4) — `paid`/`paid_at`/`delivered` untouched, so
//     `paid = 1 AND status = 'cancelled'` lands in the EXISTING refund queue with the
//     amount recomputed from the kept items (`total` is 0 by then). That landing is
//     the DESIGN, not a side effect. The host's own paid-409 is unchanged.
//   • ⚠ NO `transactions` row, ever (Decision 1 / the GSO-T6 lesson): guests have no
//     `friend_id` and no balance. Copying the friend paid-toggle would move a REAL
//     friend's balance (the host's) for money that never went through it.
//   • 409 `reason:'closed'` on a non-open cycle (D5), re-checked INSIDE the write
//     transaction so a mid-request lock writes nothing.
//   • Idempotent 200 `already_cancelled` (the GSO-T5 convergence precedent).

const cancelSubOrder = (id) => admin(`/api/guest-orders/${id}/cancel`, { method: 'post' })

const setPaid = (id, paid) => admin(`/api/guest-orders/${id}/paid`, { method: 'patch', data: { paid } })

async function unpaidOverview(cycleId) {
  const res = await admin(`/api/guest-orders/cycle/${cycleId}/unpaid`)
  expect(res.status(), 'unpaid overview').toBe(200)
  return res.json()
}

async function remainingFor(cycleId, productId) {
  const res = await ctx.get(`/api/products/cycle/${cycleId}/availability`)
  expect(res.status(), 'availability').toBe(200)
  return (await res.json()).find((a) => a.product_id === productId)
}

// The host's own totals + listing (a cancelled sub-order stays LISTED but leaves the
// aggregate — the PO's "svieti ako potvrdenie" requirement).
const listedSubOrder = (view, id) => view.guest_orders.find((o) => o.id === id)

// The friend-balance half of the no-ledger pin, through the API the admin uses.
//
// ⚠ The balance is at `detail.friend.balance`, NOT `detail.balance`: the route
// answers `{ friend: sanitizeFriend(friend), transactions, orders }` (friends.js) and
// `sanitizeFriend` does not hoist it. Reading the top level yields `undefined`, which
// makes `expect(after.balance).toBe(before.balance)` a comparison of undefined to
// undefined — VACUOUS, on a money assertion. `guest-admin-view.spec.js` carried the
// same dead read at three sites and was fixed with this.
async function friendLedger(friendId) {
  const res = await admin(`/api/friends/${friendId}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  const detail = await res.json()
  expect(detail.friend, 'the detail payload nests the friend').toBeTruthy()
  return { balance: detail.friend.balance, count: (detail.transactions || []).length }
}

// Direct read, for the rows no API surface can see. Same scoping rules as
// `guest-admin-view.spec.js` (FUP-T17): a MAX(id) watermark, filtered to the two
// identities this test owns — never a global `COUNT(*)` delta, which reddens on any
// concurrent ledger write from another spec file. No default path: guessing one can
// open a leftover database that is not the one under test.
const DB_PATH = process.env.DB_PATH || ''
const NEEDS_DB = 'needs direct DB access — set DB_PATH to the database the server runs on'

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

const transactionWatermark = () =>
  withDb((db) => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM transactions').get().n))

function txRowsFor(watermark, friendId, orderId) {
  if (watermark === null) return null
  return withDb((db) =>
    db
      .prepare(
        'SELECT id, friend_id, order_id, type, amount, note FROM transactions ' +
          'WHERE id > ? AND (friend_id = ? OR order_id = ?)'
      )
      .all(watermark, Number(friendId), Number(orderId))
  )
}

test.describe('UC-GR-005 — the admin cancels a guest sub-order', () => {
  test('⚠ THE FULL INCIDENT, END TO END: paid guest + regenerated link → her saved URL still opens → host refused → ADMIN cancels → refund queue', async ({ page }) => {
    await refreshAdminToken()

    // ── 1. Martina orders through her colleague's share link. ──────────────
    const host = await makeHost('incidentfull')
    const cycle = await makeCycle('incidentfull')
    const product = await addProduct(cycle.id, {
      name: `GR incident ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
    })
    const link = await shareLink(host, cycle.id)
    const created = await submitGuest(link.token, [
      { product_id: product.id, variant: '250g', quantity: 2 },
      { product_id: product.id, variant: '1kg', quantity: 1 },
    ])
    const orderId = created.order.id
    const orderToken = created.order.order_token
    const savedUrl = pairUiPath(link.token, orderToken) // what she actually kept
    expect(created.order.total, '2 × 250g + 1 × 1kg').toBe(50)

    // ── 2. She pays; the admin matches the transfer to her `G<id>` reference. ──
    expect((await setPaid(orderId, true)).status(), 'admin marks paid').toBe(200)

    // ── 3. The link is regenerated (the incident's trigger). ────────────────
    // ⚠ RETARGETED and STRENGTHENED (PO decision, 2026-08-31). The host can no longer
    // do this at all: with a live sub-order on the link their own POST answers 409
    // `has_orders`, which is asserted here rather than merely assumed, because it is
    // the step that used to strand the guest. The admin — the escalation target the
    // dialog names — performs the rotation instead.
    const hostTries = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect(hostTries.status(), 'the host may not invalidate a link colleagues are using').toBe(409)
    expect((await hostTries.json()).reason).toBe('has_orders')

    const rotated = await adminRegenerate(cycle.id, host.id)
    expect(rotated.token, 'the token really moved').not.toBe(link.token)

    // ── 4. Her ORIGINAL URL still opens her order (GR-T1/GR-T2 — the recovery). ──
    const stillThere = await ctx.get(pairPath(link.token, orderToken))
    expect(stillThere.status(), 'the retired link half must not kill her order URL').toBe(200)
    expect((await stillThere.json()).order.id).toBe(orderId)

    // ── 5. She changes her mind. The HOST cannot help — by design. ──────────
    const hostAttempt = await ctx.delete(`/api/guest-orders/${orderId}`, { headers: host.auth })
    expect(hostAttempt.status(), 'the host DELETE keeps its paid blockade').toBe(409)
    const refusal = await hostAttempt.json()
    expect(refusal.reason).toBe('paid')
    expect(refusal.error, 'and it points at the admin').toContain('so správcom')

    // ── 6. The ADMIN cancels — no paid blockade (D4). This is the new capability. ──
    const cancelled = await cancelSubOrder(orderId)
    expect(cancelled.status(), 'the escalation now has a working target').toBe(200)
    const body = await cancelled.json()
    expect(body.guest_order.status).toBe('cancelled')
    expect(body.guest_order.total, 'a cancelled sub-order owes nothing').toBe(0)
    expect(body.guest_order.items.length, 'SOFT cancel — the item rows are KEPT').toBe(2)
    expect(body.guest_order.paid, '`paid` is UNTOUCHED — that is what routes it to refunds').toBe(1)
    expect(body.guest_order.paid_at, 'and so is its timestamp').toBeTruthy()
    expect(body.already_cancelled, 'a real transition, not a no-op').toBeUndefined()

    // ── 7. It stays visible under its host, marked cancelled (the PO's ask). ──
    const view = await hostView(host, cycle.id)
    const listed = listedSubOrder(view, orderId)
    expect(listed, 'the order stays listed as confirmation that it existed').toBeTruthy()
    expect(listed.status).toBe('cancelled')
    expect(listed.guest_name).toBe(IDENTITY.guest_name)
    expect(view.totals.count, 'but it leaves what the host collects').toBe(0)

    // ── 8. The money is now visible on the ONE screen built for it: the refund
    //       queue — with the amount RECOMPUTED from the kept items, because
    //       cancelling zeroed `total`.
    const overview = await unpaidOverview(cycle.id)
    expect(overview.unpaid.map((r) => r.id), 'nothing is owed any more').not.toContain(orderId)
    const refund = overview.refunds.find((r) => r.id === orderId)
    expect(refund, 'paid + cancelled ⇒ the refund queue (D4, the INTENDED landing)').toBeTruthy()
    expect(refund.total, 'the stored total is zero…').toBe(0)
    expect(refund.amount, '…so the figure to give back comes from the kept item rows').toBe(50)
    expect(refund.reference, 'byte-identical to what she was told to put on the transfer')
      .toBe(`G${orderId} / ${IDENTITY.guest_name} / ${cycle.name}`)
    expect(refund.host.name, 'and it names who collected for her').toBe(host.name)
    expect(overview.refund_totals).toEqual({ count: 1, total: 50 })

    // ── 9. She opens her saved URL again and sees the truth. ────────────────
    await page.goto(savedUrl)
    await expect(page.getByTestId('status-cancelled')).toBeVisible()

    // ── 10. The admin refunds out-of-band and clears `paid` — the queue empties. ──
    expect((await setPaid(orderId, false)).status()).toBe(200)
    const settled = await unpaidOverview(cycle.id)
    expect(settled.refunds.map((r) => r.id), 'clearing `paid` closes the loop').not.toContain(orderId)
    expect(settled.unpaid.map((r) => r.id), 'and it does NOT reappear as money owed').not.toContain(orderId)
  })

  test('an UNPAID cancel releases the stock — `remaining_g` recovers and the freed grams are buyable again', async () => {
    await refreshAdminToken()
    const host = await makeHost('stockrel')
    const cycle = await makeCycle('stockrel')
    const product = await addProduct(cycle.id, {
      name: `GR stock ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
      stock_limit_g: 1000,
    })
    const link = await shareLink(host, cycle.id)

    expect((await remainingFor(cycle.id, product.id)).remaining_g, 'nothing sold yet').toBe(1000)

    // 750 g of a 1000 g limit: 1 × 500g would not exist on this product, so 3 × 250g.
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 3 }])
    expect((await remainingFor(cycle.id, product.id)).remaining_g, '750 g taken').toBe(250)

    // A 1 kg bag cannot be bought while she holds the 750 g.
    const blocked = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Blokovany Kolega', guest_phone: uniquePhone(), items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
    })
    expect(blocked.status(), 'the limit really binds before the cancel').toBe(400)

    const res = await cancelSubOrder(created.order.id)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.guest_order.items.length, 'the record of what was called off is kept').toBe(1)
    expect(body.guest_order.items[0].quantity).toBe(3)

    // ⚠ The release is the STATUS PREDICATE, not a row delete — real numbers, not a flag.
    expect((await remainingFor(cycle.id, product.id)).remaining_g, 'the grams come back').toBe(1000)

    // …and the freed grams are genuinely buyable by somebody else.
    const after = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Novy Kolega', guest_phone: uniquePhone(), items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
    })
    expect(after.status(), 'the same 1 kg bag that was refused above').toBe(201)
    expect((await remainingFor(cycle.id, product.id)).remaining_g).toBe(0)
  })

  test('⚠ NO `transactions` row, EVER — and nobody\'s balance moves (guests have no balance account)', async () => {
    await refreshAdminToken()
    const host = await makeHost('noledger')
    const cycle = await makeCycle('noledger')
    const product = await addProduct(cycle.id, {
      name: `GR ledger ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
    })
    const link = await shareLink(host, cycle.id)
    const created = await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 2 }])
    expect(created.order.total).toBe(60)

    // Cancel a PAID one: that is the shape where a naive copy of the friend handler
    // (`PATCH /api/orders/:id/paid`, orders.js — which DOES post a `payment` row and
    // a negative reversal) would look most plausible.
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    const before = await friendLedger(host.id)

    expect((await cancelSubOrder(created.order.id)).status()).toBe(200)

    const after = await friendLedger(host.id)
    expect(after.count, 'no ledger row for the only friend anywhere near this order').toBe(before.count)
    // ⚠ NON-VACUITY GATE. `undefined === undefined` passes, so assert the figure is
    // a real number BEFORE comparing it — that is exactly how this assertion was
    // dead until the GR-T4 review (it read `detail.balance`, which does not exist).
    expect(typeof before.balance, 'the balance must be a real figure, not undefined').toBe('number')
    expect(after.balance, 'and the host\'s balance is untouched').toBe(before.balance)
  })

  // The additive half of the no-ledger pin: rows NO API surface can see. Its own
  // test with an explicit `test.skip`, so a run without DB_PATH says so in the
  // summary instead of silently reporting the strongest half as green (the house
  // convention — catalog-admin.spec.js:249).
  test('⚠ NO `transactions` row, EVER — the direct-DB half (rows no API can see)', async () => {
    test.skip(!DB_PATH, NEEDS_DB)
    await refreshAdminToken()
    const { host, created } = await orderScenario('noledgerdb')
    expect((await setPaid(created.order.id, true)).status()).toBe(200)

    const watermark = transactionWatermark()
    expect(watermark, 'DB_PATH is set, so the watermark must be readable').not.toBeNull()

    expect((await cancelSubOrder(created.order.id)).status()).toBe(200)

    const rows = txRowsFor(watermark, host.id, created.order.id)
    expect(rows, `no transactions row at all for an admin guest cancel: ${JSON.stringify(rows)}`).toEqual([])
  })

  test('idempotent: a second cancel is 200 `already_cancelled` and changes nothing', async () => {
    await refreshAdminToken()
    const { created } = await orderScenario('idem')

    const first = await cancelSubOrder(created.order.id)
    expect(first.status()).toBe(200)
    expect((await first.json()).already_cancelled).toBeUndefined()

    const second = await cancelSubOrder(created.order.id)
    expect(second.status(), 'a double click must not error — the end state is the requested one').toBe(200)
    const body = await second.json()
    expect(body.already_cancelled).toBe(true)
    expect(body.guest_order.status).toBe('cancelled')
    expect(body.guest_order.total).toBe(0)
    expect(body.guest_order.items.length, 'and the second call destroys nothing').toBe(1)
  })

  test('a sub-order the GUEST already cancelled is also `already_cancelled` (one terminal state, two doors)', async () => {
    await refreshAdminToken()
    const { link, created, orderToken } = await orderScenario('guestfirst')

    const byGuest = await ctx.put(pairPath(link.token, orderToken), { data: { items: [] } })
    expect(byGuest.status()).toBe(200)
    expect((await byGuest.json()).order.status).toBe('cancelled')

    const res = await cancelSubOrder(created.order.id)
    expect(res.status()).toBe(200)
    expect((await res.json()).already_cancelled).toBe(true)
  })

  // ⚠ Guards the `softCancelGuestOrder` extraction (GR-T4 review item 2). The same
  // two-column write now has ONE home and THREE doors — the guest's empty-cart PUT,
  // the host's DELETE and the admin's cancel. Before the extraction the guest's copy
  // had already drifted (no `<> 'cancelled'` predicate), which is the exact failure
  // the one-home rule exists to prevent. So pin the OUTCOME at every door: identical
  // row state, item rows kept, `paid`/`delivered` untouched.
  //
  // The guest door's terminal-409 (its write is unreachable on an already-cancelled
  // row, so the adopted predicate is a proven no-op there) is pinned by the shipped
  // `guest-status.spec.js` "cancelled is TERMINAL — a PUT cannot revive it (409)",
  // which repeats an `items: []` PUT after cancelling. Not duplicated here.
  test('the THREE cancel doors produce byte-identical row state (the softCancelGuestOrder extraction)', async () => {
    await refreshAdminToken()
    const shape = (order) => ({
      status: order.status,
      total: order.total,
      items: order.items.length,
      quantity: order.items[0].quantity,
      delivered: order.delivered,
    })

    // Door 1 — the guest's own empty-cart PUT (routes/guest.js).
    const g = await orderScenario('door-guest')
    expect((await ctx.put(pairPath(g.link.token, g.orderToken), { data: { items: [] } })).status()).toBe(200)
    const viaGuest = listedSubOrder(await hostView(g.host, g.cycle.id), g.created.order.id)

    // Door 2 — the host's DELETE (unpaid only; that is its own rule, unchanged).
    const h = await orderScenario('door-host')
    expect((await ctx.delete(`/api/guest-orders/${h.created.order.id}`, { headers: h.host.auth })).status()).toBe(200)
    const viaHost = listedSubOrder(await hostView(h.host, h.cycle.id), h.created.order.id)

    // Door 3 — the admin's cancel (this row).
    const a = await orderScenario('door-admin')
    expect((await cancelSubOrder(a.created.order.id)).status()).toBe(200)
    const viaAdmin = listedSubOrder(await hostView(a.host, a.cycle.id), a.created.order.id)

    expect(shape(viaGuest), 'guest door').toEqual(shape(viaAdmin))
    expect(shape(viaHost), 'host door').toEqual(shape(viaAdmin))
    expect(shape(viaAdmin)).toEqual({ status: 'cancelled', total: 0, items: 1, quantity: 1, delivered: 0 })
  })

  test('409 `closed` on a non-open cycle (D5) — and the gate is re-checked INSIDE the write transaction', async () => {
    await refreshAdminToken()
    const { cycle, created } = await orderScenario('locked')

    await setCycleStatus(cycle.id, 'locked')
    const res = await cancelSubOrder(created.order.id)
    expect(res.status(), 'post-lock the coffee is bought; the refund workflow covers the money').toBe(409)
    const body = await res.json()
    expect(body.reason).toBe('closed')

    // Nothing was written.
    const view = await admin(`/api/guest-orders/cycle/${cycle.id}/unpaid`)
    const listed = (await view.json()).unpaid.find((r) => r.id === created.order.id)
    expect(listed, 'the refused cancel left the row alone').toBeTruthy()
    expect(listed.status).toBe('submitted')
    expect(listed.total).toBe(10)

    // Non-vacuity: the 409 above is the LOCK talking, not a broken route.
    await setCycleStatus(cycle.id, 'open')
    expect((await cancelSubOrder(created.order.id)).status(), 'reopened ⇒ cancellable again').toBe(200)

    // ⚠ HONEST LIMIT OF THIS TEST, stated so nobody over-reads it. The handler has
    // TWO cycle gates — a pre-check on the row already loaded, and a re-read INSIDE
    // the write transaction for a lock that lands mid-request. Over HTTP they are
    // INDISTINGUISHABLE: `instances: 1` plus synchronous better-sqlite3 means no
    // second request can interleave, so this test only proves that AT LEAST ONE of
    // them fires. What it does buy, mutation-checked at implementation time: with
    // the pre-check deleted this test still passes, i.e. the in-transaction gate
    // alone produces the correct 409 `closed` — it is wired, not decorative.
  })

  test('404 for an unknown sub-order — and the host DELETE\'s paid-409 is UNCHANGED (both halves of the escalation)', async () => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('escalation')
    const id = created.order.id

    expect((await cancelSubOrder(999999)).status(), 'unknown sub-order').toBe(404)

    // While UNPAID the host can still remove it themselves — GSO-T8's capability is
    // untouched by this row.
    expect((await ctx.delete(`/api/guest-orders/${id}`, { headers: host.auth })).status()).toBe(200)

    // Now the paid half, on a fresh sub-order under the same link.
    const paidOne = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '250g', quantity: 1 }],
      { guest_name: 'Zaplatena Kolegyna', guest_phone: uniquePhone() },
    )
    expect(paidOne.order.id, 'a second, independent sub-order').not.toBe(id)
    expect((await setPaid(paidOne.order.id, true)).status()).toBe(200)

    const refused = await ctx.delete(`/api/guest-orders/${paidOne.order.id}`, { headers: host.auth })
    expect(refused.status(), 'the host guard that CREATES the escalation still holds').toBe(409)
    expect((await refused.json()).reason).toBe('paid')

    // …and the admin, whom that refusal names, still gets through.
    expect((await cancelSubOrder(paidOne.order.id)).status()).toBe(200)
  })

  test('ADMIN-only: anonymous, the shared friends password and a host Bearer token are all 401 — and write nothing', async () => {
    await refreshAdminToken()
    const { host, cycle, created } = await orderScenario('cancelauth')
    const id = created.order.id
    const path = `/api/guest-orders/${id}/cancel`

    expect((await ctx.post(path)).status(), 'anonymous').toBe(401)
    expect((await ctx.post(path, { headers: { 'X-Friends-Password': 'kava' } })).status(),
      'the office-wide shared password is not admin identity').toBe(401)
    expect((await ctx.post(path, { headers: host.auth })).status(),
      'a host Bearer token is NOT admin identity on this router (the mirror of the host routes 401ing an admin token)').toBe(401)

    // Every refusal wrote nothing: the sub-order is still live…
    expect(listedSubOrder(await hostView(host, cycle.id), id).status).toBe('submitted')
    // …and the admin can still do it properly.
    expect((await cancelSubOrder(id)).status()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// UC-GR-006 / UC-GR-007 (GR-T5) — `order_token` published to the host and the
// admin, and the host's per-sub-order "resend the colleague's link" button.
//
// ⚠ THIS IS A CONSCIOUS REVERSAL of the GSO-T2 exclusion rule ("`order_token` is
// deliberately absent from every column list in helpers/guest-orders.js … neither
// the host nor the admin ever needs it"). The incident is the reason it is wrong:
// a guest lost her status URL to a link regeneration and NOBODY — not the host who
// invited her, not the admin who held her money — could send it back to her,
// because the one column that would have answered the question was hidden from
// every surface that had a person sitting in front of it.
//
// What SURVIVES the reversal, and is re-pinned below: `routes/guest.js` remains the
// ONLY place `order_token` authenticates anything. Publishing a column is not the
// same as accepting it as a credential, and no route outside guest.js does.
//
// D6 — ONE LIST. The column joins the shared `GUEST_ORDER_FIELDS`, never a
// per-surface pick, so it cannot land on the host view and be missing from the
// admin's. The "every surface" test below is what makes that structural rather
// than aspirational: a single-surface implementation reddens it.
//
// ⚠ The counter-invariant, and it is NOT weakened by any of this: the token must
// stay OUT OF THE DOM. `share-dialog.spec.js:602` pins that the rendered page never
// contains a guest's order token; the copy button therefore carries the sub-order
// ID in its testid and composes the URL in JS at click time — never a `title`, a
// `href` or a `data-` attribute holding the token.

// The host's colleagues panel (entry point A of module 05's tab split), without
// opening the share dialog.
async function gotoColleagues(page, host, cycle, { width = 390 } = {}) {
  await page.setViewportSize({ width, height: 900 })
  await signInAsHost(page, host)
  await gotoCycle(page, cycle)
  await page.getByTestId('main-tab-guests').click()
  await expect(page.getByTestId('guest-sub-orders')).toBeVisible()
}

const copyBtn = (page, id) => page.getByTestId(`guest-copy-url-${id}`)

test.describe('UC-GR-006/007 — order_token reaches the host and the admin, and the host can resend it', () => {
  test('the HOST payload carries every sub-order\'s order_token — byte-equal to the one the guest was given', async () => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('pubhost')
    const second = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '1kg', quantity: 1 }],
      { guest_name: 'Kolega Druhy', guest_phone: uniquePhone() }
    )

    const view = await hostView(host, cycle.id)
    const rowA = listedSubOrder(view, created.order.id)
    const rowB = listedSubOrder(view, second.order.id)

    // The whole point: the host can now answer "send me my link again".
    expect(rowA.order_token, 'the host sees the colleague\'s own status token').toBe(created.order.order_token)
    expect(rowB.order_token).toBe(second.order.order_token)
    // …and they are per-guest secrets, not one shared value.
    expect(rowA.order_token).not.toBe(rowB.order_token)
    expect(rowA.order_token, 'still NOT the link token — publishing it changed nothing about what it is')
      .not.toBe(link.token)
  })

  test('D6 — the ONE LIST puts it on EVERY host/admin surface: host view, admin orders tab, distribution, refund/unpaid overview, and mutation responses', async () => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('pubD6')
    const token = created.order.order_token
    const id = created.order.id

    // 1 — the host's "Objednávky kolegov" (guest-links GET → loadSubOrders).
    expect(listedSubOrder(await hostView(host, cycle.id), id).order_token).toBe(token)

    // 2 — a host MUTATION response (loadSubOrder), so a row patched in place on
    //     screen does not silently lose the column the copy button reads.
    const delivered = await ctx.patch(`/api/guest-orders/${id}/delivered`, {
      headers: host.auth, data: { delivered: true },
    })
    expect(delivered.status()).toBe(200)
    expect((await delivered.json()).guest_order.order_token, 'the mutation payload keeps it too').toBe(token)

    // 3 — the admin orders tab (cycleSubOrdersByHost via routes/orders.js).
    const ordersRes = await admin(`/api/orders/cycle/${cycle.id}`)
    expect(ordersRes.status()).toBe(200)
    const orders = await ordersRes.json()
    const hostRow = orders.find((o) => o.friend_id === host.id)
    expect(hostRow.guest_orders.find((g) => g.id === id).order_token).toBe(token)

    // 4 — the admin distribution sheet (cycleSubOrdersByHost via routes/cycles.js).
    //     The picking screen is where an admin is standing next to the bags with a
    //     colleague asking where their order went.
    const distRes = await admin(`/api/cycles/${cycle.id}/distribution`)
    expect(distRes.status()).toBe(200)
    const party = (await distRes.json()).distribution.find((p) => p.id === host.id)
    expect(party.guest_orders.find((g) => g.id === id).order_token).toBe(token)

    // 5 — the admin receivables/refund overview (its own hand-picked mapping, which
    //     UC-GR-006 requires to be extended alongside the shared list). This is the
    //     screen where the admin is chasing a payment from a guest whose URL died.
    const row = (await unpaidOverview(cycle.id)).unpaid.find((r) => r.id === id)
    expect(row.order_token, 'the receivables screen needs it most').toBe(token)

    // The link listing is NOT a sub-order surface — `order_token` is not link data.
    expect(JSON.stringify(await adminLinks(cycle.id))).not.toContain(token)
    expect(link.token).toBeTruthy()
  })

  test('the published token WORKS: pasted into an anonymous browser it opens that exact order', async ({ browser }) => {
    await refreshAdminToken()
    const { host, cycle, created } = await orderScenario('pubworks')

    // The host reads it off their own payload — the only route they have to it.
    const token = listedSubOrder(await hostView(host, cycle.id), created.order.id).order_token

    // API half: no credential but the token itself.
    const anon = await ctx.get(canonicalPath(token))
    expect(anon.status(), 'a published token that does not resolve is worse than none').toBe(200)
    expect((await anon.json()).order.id).toBe(created.order.id)

    // UI half, in a context that has never seen the host's session.
    const fresh = await browser.newContext()
    const guestPage = await fresh.newPage()
    await guestPage.goto(canonicalUiPath(token))
    await expect(guestPage.getByTestId('guest-status')).toBeVisible()
    await expect(guestPage.getByTestId('guest-status-unavailable')).toHaveCount(0)
    await expect(guestPage.getByTestId('status-total')).toContainText('10.00')
    await fresh.close()
  })

  test('the publication is SCOPED: every surface carrying it is host- or admin-authenticated, and nothing public leaks it', async () => {
    await refreshAdminToken()
    const { host, cycle, link, created } = await orderScenario('pubscope')
    const token = created.order.order_token
    const stranger = await makeHost('pubstranger')

    // Anonymous on each of the four carrying surfaces.
    for (const path of [
      `/api/guest-links/cycle/${cycle.id}`,
      `/api/orders/cycle/${cycle.id}`,
      `/api/cycles/${cycle.id}/distribution`,
      `/api/guest-orders/cycle/${cycle.id}/unpaid`,
    ]) {
      const res = await ctx.get(path)
      expect(res.status(), `anonymous must not reach ${path}`).toBe(401)
      expect(await res.text()).not.toContain(token)
    }

    // A DIFFERENT host is not "a host" — guest-links is keyed on the caller's own
    // identity, so the stranger sees their own (absent) link, never this token.
    const other = await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: stranger.auth })
    expect(other.status()).toBe(200)
    expect(await other.text(), 'one host cannot read another host\'s guests').not.toContain(token)

    // The PUBLIC guest ordering listing (the one surface anonymous callers do get)
    // publishes products, never sub-orders.
    const listing = await ctx.get(`/api/guest/${link.token}`)
    expect(listing.status()).toBe(200)
    expect(await listing.text()).not.toContain(token)

    // ⚠ The credential half of the GSO-T2 rule SURVIVES: publishing the column did
    // not make any other route accept it as authentication.
    expect((await ctx.get(`/api/guest/${token}`)).status(),
      'an order token is not a LINK token — routes/guest.js stays the only place it authenticates')
      .toBe(404)
    expect((await ctx.post(`/api/guest-orders/${created.order.id}/cancel`, {
      headers: { 'X-Admin-Token': token },
    })).status(), 'and it is certainly not an admin token').toBe(401)
  })

  test('UC-GR-007: "Kopírovať odkaz" puts the CANONICAL url on the clipboard, flips for 2 s — and the copied string RESOLVES', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await refreshAdminToken()
    const { host, cycle, link, created } = await orderScenario('copyurl')
    const id = created.order.id

    await gotoColleagues(page, host, cycle)

    const btn = copyBtn(page, id)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText(COPY_LABEL)
    await expect(btn).toHaveAttribute('title', COPY_TITLE)

    await btn.click()
    await expect(btn).toHaveText(COPIED_LABEL)

    const origin = await page.evaluate(() => window.location.origin)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    // Canonical only — the pair form is legacy carriage and is never newly emitted
    // (UC-GR-003). A link token in this string is exactly what the incident broke.
    expect(copied).toBe(`${origin}${canonicalUiPath(created.order.order_token)}`)
    expect(copied, 'no link half — that is the half the regeneration killed').not.toContain(link.token)

    await expect(btn).toHaveText(COPY_LABEL, { timeout: 5000 })

    // ⚠ The failure this test exists to prevent is a plausible-looking DEAD url, so
    // the copied string is actually followed — in a context with no host session.
    const fresh = await browser.newContext()
    const guestPage = await fresh.newPage()
    await guestPage.goto(copied)
    await expect(guestPage.getByTestId('guest-status')).toBeVisible()
    await expect(guestPage.getByTestId('status-total')).toContainText('10.00')
    await fresh.close()
  })

  test('the button is on EVERY row — a CANCELLED colleague and a LOCKED cycle both keep it, unlike "Odstrániť"', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('copyevery')
    const gone = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '250g', quantity: 2 }],
      { guest_name: 'Kolega Zruseny', guest_phone: uniquePhone() }
    )
    // Cancelled through the guest's own door, so the row is genuinely terminal.
    expect((await ctx.put(canonicalPath(gone.order.order_token), { data: { items: [] } })).status()).toBe(200)

    await gotoColleagues(page, host, cycle)

    // Live row: both controls.
    await expect(copyBtn(page, created.order.id)).toBeVisible()
    await expect(page.getByTestId(`guest-remove-${created.order.id}`)).toBeVisible()

    // Cancelled row: the copy stays (the terminal record is still reachable and the
    // colleague may still ask for it), "Odstrániť" is gone (cancelled is terminal).
    await expect(copyBtn(page, gone.order.id)).toBeVisible()
    await expect(page.getByTestId(`guest-remove-${gone.order.id}`)).toHaveCount(0)

    // Locked cycle: resending is PRECISELY a post-lock activity.
    // ⚠ Re-entered through the portal, never `page.reload()`: a hard load of
    // /cycle/:id races FriendOrder's session restore and bounces to `/`.
    await setCycleStatus(cycle.id, 'locked')
    await gotoColleagues(page, host, cycle)
    await expect(copyBtn(page, created.order.id), 'the resend survives the lock').toBeVisible()
    await expect(copyBtn(page, gone.order.id)).toBeVisible()
    await expect(page.getByTestId(`guest-remove-${created.order.id}`), 'removal does not').toHaveCount(0)
  })

  test('⚠ the token stays OUT OF THE DOM, and the card still shows exactly ONE badge', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('copydom')
    const second = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '250g', quantity: 1 }],
      { guest_name: 'Kolega Tretí', guest_phone: uniquePhone() }
    )

    await gotoColleagues(page, host, cycle)
    await expect(copyBtn(page, created.order.id)).toBeVisible()

    // The same property `share-dialog.spec.js:602` pins for the dialog, now that the
    // payload behind this screen genuinely carries the token: it may live in JS
    // state, never in rendered markup (attributes included — the button's hook is
    // the sub-order ID).
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html, 'a rendered token is a credential in a screenshot').not.toContain(created.order.order_token)
    expect(html).not.toContain(second.order.order_token)
    expect(await copyBtn(page, created.order.id).evaluate((el) => el.outerHTML))
      .not.toContain(created.order.order_token)

    // 05 §UC-KG-003's "exactly ONE badge" rule is untouched: the new control is a
    // BUTTON in the foot, not a badge (UC-GR-007). Asserted per row, scoped to the
    // `sub-order-badges` hook that rule lives on.
    const badgeRows = page.getByTestId('sub-order-badges')
    await expect(badgeRows).toHaveCount(2)
    for (let i = 0; i < 2; i++) {
      await expect(badgeRows.nth(i).locator('.badge')).toHaveCount(1)
    }
    // …and exactly one copy control per row, nowhere near the badge row.
    for (const sub of [created, second]) {
      await expect(copyBtn(page, sub.order.id)).toHaveCount(1)
      await expect(badgeRows.locator(`[data-testid="guest-copy-url-${sub.order.id}"]`)).toHaveCount(0)
    }
  })
})

// ---------------------------------------------------------------------------
// UC-GR-008 (GR-T6) — the ADMIN orders tab gains the three capabilities whose
// endpoints already shipped: see/create a host's share link (GR-T3), resend a
// guest their own order link (GR-T5 published the column), and cancel a guest
// sub-order (GR-T4).
//
// ⚠ THE CONSTRAINT THAT DOES NOT SHOW UP IN A GREEN SUITE. `order_token` reaches
// this payload from UC-GR-006 on, and until this row NO shipped assertion looked
// at the admin CycleDetail DOM — so an `<a :href="…order_token…">` or a `:title`
// here would satisfy every written rule and pass the whole suite. §UC-GR-008
// therefore makes this row owe its own whole-document `outerHTML` pin, in the
// shape of `share-dialog.spec.js:611`. It is the test below marked ⚠ DOM PIN.
//
// ⚠ DRAFT COPY, PO sign-off pending (§OPEN). Hoisted into constants for the
// documented reason: the sign-off edit is then a known TWO-PLACE change (these
// constants + the literals in `CycleDetail.vue`), never a grep for quoted Slovak.
const ADMIN_LINK_LABEL = 'Hosťovský odkaz'
const ADMIN_LINK_CREATE = 'Vytvoriť hosťovský odkaz'
const ADMIN_LINK_INACTIVE = 'neaktívny'
const ADMIN_ORDER_LINK_LABEL = 'Odkaz na objednávku'
const ADMIN_CANCEL_LABEL = 'Zrušiť'
const ADMIN_CANCEL_CONFIRM =
  'Objednávka hosťa sa zruší. Hosť ju uvidí ako zrušenú a už si ju nebude môcť upraviť.'
const ADMIN_CANCEL_CONFIRM_PAID =
  'Objednávka je zaplatená - po zrušení sa zobrazí medzi platbami na vrátenie.'
const ADMIN_CANCEL_YES = 'Áno, zrušiť'
const ADMIN_CANCEL_NO = 'Nie'

// ⚠ ONE admin session app-wide (`INSERT OR REPLACE … 'admin_token'`), so a UI login
// INVALIDATES a token an API fixture captured earlier. Every test here therefore
// builds its fixtures FIRST and then adopts the browser's token for anything it
// asks the API afterwards. (The documented trap, guest-admin-view.spec.js:820.)
async function adoptUiAdmin(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  const token = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(token, 'the UI login stored an admin token').toBeTruthy()
  adminToken = token
  return token
}

async function gotoOrdersTab(page, cycle) {
  await page.goto(`/admin/cycle/${cycle.id}`)
  await page.getByRole('tab', { name: 'Objednávky' }).click()
}

// The host's own submitted order — what puts a friend row on this tab at all.
// ⚠ `listedOrders` (CycleDetail.vue) filters to submitted/draft/has-guests, so a
// friend who has neither ordered nor hosted is NOT rendered here. See the report:
// §UC-GR-008's "a friend who has neither ordered nor shared is reachable here"
// describes the API payload, not this view.
async function submitOwnOrder(host, cycleId, items) {
  const put = await ctx.put(`/api/orders/cycle/${cycleId}/friend/${host.id}`, {
    headers: host.auth, data: { items },
  })
  expect(put.status(), 'own cart').toBe(200)
  const submit = await ctx.post(`/api/orders/cycle/${cycleId}/friend/${host.id}/submit`, {
    headers: host.auth, data: {},
  })
  expect(submit.status(), 'own submit').toBe(200)
  return submit.json()
}

// ⚠ Fixture names are interpolated into `RegExp`s below. `makeHost` happens to emit
// alphanumerics and spaces today, so escaping is currently a no-op — which is exactly
// why it has to be written down: a future label containing `(`, `+`, `?` or `.` would
// otherwise turn one of these anchors into a syntax error or, worse, a silently
// looser match that still passes.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const hostLinkBtn = (page, friendId) => page.getByTestId(`host-guest-link-${friendId}`)
const hostLinkCreateBtn = (page, friendId) => page.getByTestId(`host-guest-link-create-${friendId}`)
// The admin regenerate (D3 as amended, 2026-08-31) — the escalation target for the
// host's `has_orders` 409, with an inline confirm stating the consequence.
const hostLinkRegenBtn = (page, friendId) => page.getByTestId(`host-guest-link-regen-${friendId}`)
const subOrderLinkBtn = (page, id) => page.getByTestId(`guest-order-link-${id}`)
const subOrderCancelBtn = (page, id) => page.getByTestId(`guest-cancel-${id}`)

// The THEME's class names (friends-theme.css / components/neo). The admin is
// shadcn-only — 01-architecture's design-system SCOPE rule — and the two skins
// share a page only by mistake.
const NEO_CLASSES = [
  'app', 'btn', 'badge', 'card', 'cartbar', 'cat-tabs', 'confirmbox', 'field-help',
  'field-lbl', 'foot', 'hl', 'inp', 'modal-layer', 'mono', 'pnotes', 'pspec',
  'stepper', 'sub', 'suborder', 'tabbadge', 'tabgroup', 'vbox',
]

test.describe('UC-GR-008 — the admin orders tab: share links, resend, cancel', () => {
  test('a host row carries a copyable SHARE link — the ordering URL, composed in JS, and it works', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await refreshAdminToken()
    const { host, cycle, link } = await orderScenario('adminlink')

    await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    const btn = hostLinkBtn(page, host.id)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText(ADMIN_LINK_LABEL)
    // The link EXISTS, so no create affordance is offered on this row.
    await expect(hostLinkCreateBtn(page, host.id)).toHaveCount(0)

    await btn.click()
    await expect(btn).toHaveText(COPIED_LABEL)

    const origin = await page.evaluate(() => window.location.origin)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    // ⚠ The ORDERING url (`/g/:linkToken`) — this is what the admin forwards to a
    // friend who lost it, and it is a different thing from the per-guest status URL
    // on the sub-order rows below.
    expect(copied).toBe(`${origin}/g/${link.token}`)

    await expect(btn).toHaveText(ADMIN_LINK_LABEL, { timeout: 5000 })

    // A plausible-looking dead URL is the exact failure this whole module exists
    // for, so the copied string is FOLLOWED, in a context with no admin session.
    const fresh = await browser.newContext()
    const guestPage = await fresh.newPage()
    await guestPage.goto(copied)
    await expect(guestPage.getByTestId('cartbar')).toBeVisible()
    await expect(guestPage.getByTestId('guest-unavailable')).toHaveCount(0)
    await fresh.close()
  })

  test('a linkless friend row CREATES one in place — no reload — and the host\'s own dialog then returns the same token', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await refreshAdminToken()
    const host = await makeHost('mklink')
    const cycle = await makeCycle('mklink')
    const product = await addProduct(cycle.id, {
      name: `GR mklink ${uniq}`, purpose: 'Espresso', price_250g: 10,
    })
    // No share link at all — the friend is on this tab because they ORDERED.
    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await hostView(host, cycle.id)).link, 'precondition: no link yet').toBeFalsy()

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    await expect(hostLinkBtn(page, host.id)).toHaveCount(0)
    const create = hostLinkCreateBtn(page, host.id)
    await expect(create).toBeVisible()
    await expect(create).toHaveText(ADMIN_LINK_CREATE)

    await create.click()

    // In place: the copy control replaces the create button with no navigation.
    const btn = hostLinkBtn(page, host.id)
    await expect(btn).toBeVisible()
    await expect(create).toHaveCount(0)

    await btn.click()
    const origin = await page.evaluate(() => window.location.origin)
    const copied = await page.evaluate(() => navigator.clipboard.readText())

    // The row is not just claiming a link — the HOST's own dialog payload has it,
    // and it is byte-identical to what the admin just copied.
    adminToken = token
    const hostsOwn = (await hostView(host, cycle.id)).link
    expect(hostsOwn, 'the create actually persisted').toBeTruthy()
    expect(copied).toBe(`${origin}/g/${hostsOwn.token}`)
    expect(hostsOwn.active).toBe(1)
  })

  test('a REVOKED link is MARKED revoked, not offered as if it worked — and the admin cannot REACTIVATE it, even by regenerating (the surviving half of D3)', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, link } = await orderScenario('revoked')

    // Only the host can revoke — and only the host can undo it.
    expect((await ctx.patch(`/api/guest-links/${link.id}`, {
      headers: host.auth, data: { active: false },
    })).status()).toBe(200)

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    await expect(hostLinkBtn(page, host.id), 'the link is still forwardable — as a KNOWN-dead one').toBeVisible()
    const marker = page.getByTestId(`host-guest-link-inactive-${host.id}`)
    await expect(marker).toBeVisible()
    await expect(marker).toHaveText(ADMIN_LINK_INACTIVE)

    // ⚠ RETARGETED (PO decision, 2026-08-31). The row DOES now offer a regenerate —
    // it is the escalation target for the host's `has_orders` 409 — so the old blanket
    // "no admin control writes `token` or `active`" is retargeted onto the half that
    // survives: no admin control writes **`active`**. Merely rendering the page still
    // flips nothing, and there is still no reactivate affordance.
    await expect(hostLinkCreateBtn(page, host.id)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /aktivovať/i }),
      'reactivation is host-only — the admin has no such control').toHaveCount(0)
    adminToken = token
    let stored = (await adminLinks(cycle.id)).find((l) => l.host_friend_id === host.id)
    expect(stored.token, 'rendering the page rotates nothing').toBe(link.token)
    expect(stored.active, 'never reactivated').toBe(0)

    // ⚠ AND THE POINT: the admin USES the new regenerate on this revoked row, and it
    // is still not a reactivate. The token moves; `active` does not. Driven through
    // the UI, because a control that quietly republished a leaked link would be a
    // security regression the API-level test above cannot see.
    await hostLinkRegenBtn(page, host.id).click()
    await page.getByTestId(`host-guest-link-regen-yes-${host.id}`).click()
    await expect(hostLinkRegenBtn(page, host.id)).toBeEnabled()

    stored = (await adminLinks(cycle.id)).find((l) => l.host_friend_id === host.id)
    expect(stored.token, 'the admin regenerate rotated the token').not.toBe(link.token)
    expect(stored.active, '⚠ STILL revoked — regenerating is not reactivating').toBe(0)
    await expect(marker, 'and the row still says so').toBeVisible()
  })

  test('a DEACTIVATED host: the create button renders the 409 `inactive_host` refusal and no link appears', async ({ page }) => {
    await refreshAdminToken()
    const host = await makeHost('deadhost')
    const cycle = await makeCycle('deadhost')
    const product = await addProduct(cycle.id, {
      name: `GR deadhost ${uniq}`, purpose: 'Espresso', price_250g: 10,
    })
    await submitOwnOrder(host, cycle.id, [{ product_id: product.id, variant: '250g', quantity: 1 }])
    expect((await admin(`/api/friends/${host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    const create = hostLinkCreateBtn(page, host.id)
    await expect(create).toBeVisible()
    await create.click()

    // ⚠ The `inactive_host` gate runs BEFORE the existing-link lookup, so this route
    // is NOT a token-retrieval path — the 409 body carries no `link`. The UI must
    // show the refusal rather than a link control that would hand out a dead URL.
    const err = page.getByTestId(`host-guest-link-error-${host.id}`)
    await expect(err).toBeVisible()
    await expect(err).toContainText('deaktivovaný')
    await expect(hostLinkBtn(page, host.id), 'no link is invented from a refusal').toHaveCount(0)

    adminToken = token
    expect((await adminLinks(cycle.id)).filter((l) => l.host_friend_id === host.id)).toEqual([])
  })

  test('a sub-order row RESENDS the guest\'s own status URL — canonical form, and it opens their order', async ({ page, context, browser }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await refreshAdminToken()
    const { cycle, link, created } = await orderScenario('resend')
    const id = created.order.id

    await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    const btn = subOrderLinkBtn(page, id)
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText(ADMIN_ORDER_LINK_LABEL)

    await btn.click()
    await expect(btn).toHaveText(COPIED_LABEL)

    const origin = await page.evaluate(() => window.location.origin)
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(`${origin}${canonicalUiPath(created.order.order_token)}`)
    expect(copied, 'never the legacy pair form — that is the half a regeneration kills')
      .not.toContain(link.token)

    await expect(btn).toHaveText(ADMIN_ORDER_LINK_LABEL, { timeout: 5000 })

    // Followed for real, from a context that has never seen an admin session.
    const fresh = await browser.newContext()
    const guestPage = await fresh.newPage()
    await guestPage.goto(copied)
    await expect(guestPage.getByTestId('guest-status')).toBeVisible()
    await expect(guestPage.getByTestId('status-total')).toContainText('10.00')
    await fresh.close()
  })

  test('D9 — the resend affordance is on the nested sub-order rows ONLY, not on the refund card', async ({ page }) => {
    await refreshAdminToken()
    const { cycle, created } = await orderScenario('d9')
    const id = created.order.id
    expect((await setPaid(id, true)).status()).toBe(200)
    expect((await cancelSubOrder(id)).status()).toBe(200)

    await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    // Paid + cancelled ⇒ the refund queue, which carries `order_token` in its
    // payload (UC-GR-006) but deliberately renders no resend control: no PO ask
    // names that surface, and two affordances for one action drift apart.
    const refundRow = page.getByTestId(`guest-refund-row-${id}`)
    await expect(refundRow).toBeVisible()
    await expect(refundRow.locator('[data-testid^="guest-order-link-"]')).toHaveCount(0)
    // …while the sub-order row keeps it, cancelled or not.
    await expect(subOrderLinkBtn(page, id)).toHaveCount(1)

    // ⚠ THE DOM PIN'S BLIND SPOT, closed here. The whole-document assertion lives in
    // the test below, whose fixture has no paid+cancelled row — so the refund card is
    // simply not in the markup it inspects. `guest-orders.js` puts `order_token` on
    // refund rows too, and D9 names this card as THE widening candidate, so the day
    // somebody adds the affordance here they must add it without rendering the token.
    // This test is the only one that renders the card, so the pin belongs here.
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html, 'the refund card carries order_token in its payload — never in its markup')
      .not.toContain(created.order.order_token)
    expect(await refundRow.evaluate((el) => el.outerHTML)).not.toContain(created.order.order_token)
  })

  test('cancelling an UNPAID sub-order asks first, flips the row to "Zrušené" IN PLACE — and the row STAYS listed', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, created } = await orderScenario('cancelui')
    const id = created.order.id

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    const row = page.getByTestId(`guest-suborder-${id}`)
    await expect(row).toContainText('10.00 EUR')
    await expect(row).not.toContainText('Zrušené')

    // Destructive, so it asks — and the unpaid copy says exactly what happens.
    // ⚠ Every control here is LOCATED by testid but its LABEL is asserted, because a
    // hoisted constant that nothing pins is not a sign-off contract — it is a comment
    // that rots at the first rename. These three are the whole visible vocabulary of
    // the cancel flow.
    await expect(subOrderCancelBtn(page, id)).toHaveText(ADMIN_CANCEL_LABEL)
    await subOrderCancelBtn(page, id).click()
    const confirm = page.getByTestId(`guest-cancel-confirm-${id}`)
    await expect(confirm).toBeVisible()
    await expect(confirm).toContainText(ADMIN_CANCEL_CONFIRM)
    await expect(confirm, 'nothing about refunds on an UNPAID order')
      .not.toContainText(ADMIN_CANCEL_CONFIRM_PAID)
    await expect(page.getByTestId(`guest-cancel-yes-${id}`)).toHaveText(ADMIN_CANCEL_YES)
    await expect(page.getByTestId(`guest-cancel-no-${id}`)).toHaveText(ADMIN_CANCEL_NO)

    // "Nie" backs out and writes nothing.
    await page.getByTestId(`guest-cancel-no-${id}`).click()
    await expect(confirm).toHaveCount(0)
    adminToken = token
    expect(listedSubOrder(await hostView(host, cycle.id), id).status).toBe('submitted')

    await subOrderCancelBtn(page, id).click()
    await page.getByTestId(`guest-cancel-yes-${id}`).click()

    // In place — no navigation, no reload — and the row is STILL THERE. That is a
    // PO requirement, not an accident: the record that the order existed, who
    // created it, and that it was called off.
    await expect(row).toBeVisible()
    await expect(row).toContainText('Zrušené')
    // `formatPrice(0)` is '-' in this view (pre-existing), so the proof that the
    // total was zeroed is that the amount is GONE, not that it reads 0.00.
    await expect(row, 'the amount was zeroed by the soft cancel').not.toContainText('10.00 EUR')
    await expect(subOrderCancelBtn(page, id), 'cancelled is terminal').toHaveCount(0)
    await expect(subOrderLinkBtn(page, id), 'but the guest can still be sent their record').toBeVisible()

    expect(listedSubOrder(await hostView(host, cycle.id), id).status).toBe('cancelled')

    // And it survives a reload — it is server state, not a ref.
    await gotoOrdersTab(page, cycle)
    await expect(page.getByTestId(`guest-suborder-${id}`)).toContainText('Zrušené')
  })

  test('cancelling a PAID sub-order names the REFUND QUEUE in the confirm, and the refund card then lists it', async ({ page }) => {
    await refreshAdminToken()
    const { cycle, created } = await orderScenario('cancelpaid')
    const id = created.order.id
    expect((await setPaid(id, true)).status()).toBe(200)

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    await expect(page.getByTestId(`guest-refund-row-${id}`), 'not a refund yet').toHaveCount(0)

    await subOrderCancelBtn(page, id).click()
    const confirm = page.getByTestId(`guest-cancel-confirm-${id}`)
    // ⚠ The admin cancels a PAID order KNOWINGLY: the money does not vanish, it
    // moves to the refund queue, and the confirm says so before the click.
    await expect(confirm).toContainText(ADMIN_CANCEL_CONFIRM_PAID)
    await expect(confirm).toContainText(ADMIN_CANCEL_CONFIRM)

    await page.getByTestId(`guest-cancel-yes-${id}`).click()
    await expect(page.getByTestId(`guest-suborder-${id}`)).toContainText('Zrušené')

    // The whole point of D4: paid + cancelled lands in the EXISTING refund queue,
    // with the amount recomputed from the kept item rows (cancelling zeroed `total`).
    const refundRow = page.getByTestId(`guest-refund-row-${id}`)
    await expect(refundRow).toBeVisible()
    await expect(refundRow).toContainText(IDENTITY.guest_name)
    await expect(refundRow).toContainText('10.00')

    adminToken = token
    const refunds = (await unpaidOverview(cycle.id)).refunds
    expect(refunds.find((r) => r.id === id).amount).toBe(10)
  })

  test('⚠ DOM PIN — no guest order token is anywhere in the admin orders tab\'s markup', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('admindom')
    const second = await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '1kg', quantity: 1 }],
      { guest_name: 'Kolegyna Druha', guest_phone: uniquePhone() },
    )

    // Precondition — non-vacuity. The payload behind this screen genuinely carries
    // both tokens (UC-GR-006); without this the assertions below could pass because
    // nothing rendered at all.
    const orders = await (await admin(`/api/orders/cycle/${cycle.id}`)).json()
    const hostRow = orders.find((o) => o.friend_id === host.id)
    expect(hostRow.guest_orders.map((g) => g.order_token).sort())
      .toEqual([created.order.order_token, second.order.order_token].sort())

    await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)
    await expect(subOrderLinkBtn(page, created.order.id)).toBeVisible()
    await expect(subOrderLinkBtn(page, second.order.id)).toBeVisible()
    // Expanded too — the fold is where an `<a :href>` would most naturally be put.
    await page.getByTestId(`guest-expand-${created.order.id}`).click()
    await expect(page.getByTestId(`guest-suborder-items-${created.order.id}`)).toBeVisible()

    // ⚠ The pin §UC-GR-008 makes this row owe, in the shape of
    // `share-dialog.spec.js:611`. A rendered token is a credential in every
    // screenshot, every DevTools tab and every "share your screen" call — and until
    // this assertion existed, an `<a :href="…">` here passed the ENTIRE suite.
    const html = await page.evaluate(() => document.documentElement.outerHTML)
    expect(html, 'the guest\'s private order credential must not be in the markup')
      .not.toContain(created.order.order_token)
    expect(html).not.toContain(second.order.order_token)

    // Attributes included: the controls' hook is the sub-order ID, and the URL is
    // composed in JS at click time.
    for (const sub of [created, second]) {
      expect(await subOrderLinkBtn(page, sub.order.id).evaluate((el) => el.outerHTML))
        .not.toContain(sub.order.order_token)
    }

    // Implementation-chosen, not mandated by §UC-GR-008, and stated as such so a
    // future "print the link so the admin can read it" decision knows it is
    // retargeting a choice rather than breaking an invariant: the SHARE link token
    // is composed in JS here too.
    expect(html, 'the share link is composed at click time as well').not.toContain(link.token)
    expect(await hostLinkBtn(page, host.id).evaluate((el) => el.outerHTML)).not.toContain(link.token)
  })

  test('a FAILED link listing is stated, not silently rendered as "nobody has ever shared"', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, link } = await orderScenario('linkserr')

    await adoptUiAdmin(page)
    // ⚠ THE FAILURE MODE THIS EXISTS FOR. `guestLinks` stays `[]` on an error, so
    // every friend row falls through to the create branch — and a row offering
    // "Vytvoriť hosťovský odkaz" is indistinguishable from a friend who genuinely
    // never shared. The admin then concludes nobody has, on the one screen this
    // whole module was written to make link state recoverable from.
    await page.route(`**/api/guest-links/cycle/${cycle.id}/all`, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Chyba servera' }),
    }))

    await gotoOrdersTab(page, cycle)

    const banner = page.getByTestId('guest-links-error')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Hosťovské odkazy sa nepodarilo načítať')

    // The rest of the tab is UNHARMED — the listing is non-blocking (the
    // `loadGuestUnpaid` precedent), so the orders themselves still render.
    await expect(page.getByRole('columnheader', { name: 'Priateľ' })).toBeVisible()
    await expect(page.getByRole('cell', { name: new RegExp(`^${escapeRe(host.name)}`) })).toBeVisible()

    // And the row genuinely IS in the ambiguous state the banner explains — this is
    // what makes the banner load-bearing rather than decorative.
    await expect(hostLinkBtn(page, host.id), 'the real link is not rendered').toHaveCount(0)
    await expect(hostLinkCreateBtn(page, host.id), 'so the row looks like a linkless one').toBeVisible()
    expect(link.token, '…while a link demonstrably exists').toBeTruthy()
  })

  test('admin skin: the orders tab renders shadcn only — ZERO neo/theme classes, no `.app` scope', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle } = await orderScenario('skin')

    await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)
    await expect(hostLinkBtn(page, host.id)).toBeVisible()

    // 01-architecture's design-system SCOPE rule: the friends theme is scoped to the
    // friend/guest surfaces and the admin stays on shadcn. The two skins share a page
    // only by mistake — and `.app > *` silently neutralises Tailwind positioning
    // utilities on a direct child, which is how that mistake usually surfaces.
    const found = await page.evaluate((classes) => classes.filter(
      (c) => document.querySelectorAll(`.${c}`).length > 0
    ), NEO_CLASSES)
    expect(found, 'theme classes on an admin screen').toEqual([])
  })

  test('⚠ per-row sequencing: two cancels resolving OUT OF ORDER both land, and neither row lies about the server', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('outoforder')
    const slow = created.order.id
    const fast = (await submitGuest(
      link.token,
      [{ product_id: product.id, variant: '1kg', quantity: 1 }],
      { guest_name: 'Kolegyna Rychla', guest_phone: uniquePhone() },
    )).order.id

    const token = await adoptUiAdmin(page)

    // The FIRST-clicked row's response is held back so the SECOND one resolves
    // first. A shared sequence counter (rather than per-row `rowSeq`) discards the
    // superseded response, and the first row then sits on screen claiming a live
    // order the server has already cancelled — on a money screen, a wrong answer.
    // A shared PENDING lock fails differently and just as loudly: the second row's
    // button would be disabled and the click below would time out.
    await page.route(`**/api/guest-orders/${slow}/cancel`, async (route) => {
      await new Promise((r) => setTimeout(r, 2000))
      await route.continue()
    })

    await gotoOrdersTab(page, cycle)

    await subOrderCancelBtn(page, slow).click()
    await page.getByTestId(`guest-cancel-yes-${slow}`).click()
    await subOrderCancelBtn(page, fast).click()
    await page.getByTestId(`guest-cancel-yes-${fast}`).click()

    await expect(page.getByTestId(`guest-suborder-${fast}`)).toContainText('Zrušené')
    await expect(page.getByTestId(`guest-suborder-${slow}`)).toContainText('Zrušené', { timeout: 10000 })

    // Both rows agree with the server, which is the only claim that matters.
    adminToken = token
    const view = await hostView(host, cycle.id)
    expect(listedSubOrder(view, slow).status).toBe('cancelled')
    expect(listedSubOrder(view, fast).status).toBe('cancelled')
  })

  test('a REFUSED cancel never leaves the row claiming a cancellation — the error is surfaced on THAT row', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, created } = await orderScenario('refused')
    const id = created.order.id

    const token = await adoptUiAdmin(page)
    // The real refusal this hits in production is a cycle locked between the page
    // load and the click (409 `closed`, D5) — reproduced here as the server answer
    // it produces, without a race the suite cannot schedule.
    await page.route(`**/api/guest-orders/${id}/cancel`, (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Cyklus je už uzavretý, objednávku kolegu už nie je možné zrušiť.', reason: 'closed' }),
    }))

    await gotoOrdersTab(page, cycle)
    await subOrderCancelBtn(page, id).click()
    await page.getByTestId(`guest-cancel-yes-${id}`).click()

    const err = page.getByTestId(`guest-row-error-${id}`)
    await expect(err).toBeVisible()
    await expect(err).toContainText('uzavretý')

    const row = page.getByTestId(`guest-suborder-${id}`)
    await expect(row, 'a refused cancel must not be shown as done').not.toContainText('Zrušené')
    await expect(row).toContainText('10.00 EUR')

    adminToken = token
    expect(listedSubOrder(await hostView(host, cycle.id), id).status).toBe('submitted')
  })
})

// ---------------------------------------------------------------------------
// UC-GR-011 — the guest order-confirmation mail (GR-T8)
//
// The module's LAST row and its THIRD consumer of module 08's mail seam. Verified
// against the SHARED Mailgun stub (`e2e/mailgun-harness.js` — the EM-T2 extraction;
// reuse, never fork), exactly as UC-GR-010 item 10 prescribes: a throwaway backend
// whose `MAILGUN_BASE_URL` points at a 127.0.0.1 stub, the ambient MAILGUN_* env
// blanked FIRST so an operator's real key can never be inherited.
//
// ⚠ The rest of this file runs against the gate server with NO `MAILGUN_*` env at
// all (the mailer's rule 1 no-op), which is what makes every zero-request assertion
// below meaningful rather than incidental.
//
// ⚠ THE RISK THIS DESCRIBE EXISTS FOR IS NOT THE COPY — it is D11. The submit
// handler's stock check sits OUTSIDE the insert transaction and is safe only while
// the handler is fully synchronous under `instances: 1` (the GA-T8 lesson). The
// "a stub 500 still 201s" test is the mutation target: making the send blocking
// reddens it.

const MAIL_SUBJECT = 'Potvrdenie objednávky - Podpultovka'
// ⚠ DRAFT copy pending PO sign-off (14 §OPEN), hoisted for the GR-T7/T5/T6 reason:
// sign-off is then a known TWO-PLACE edit (these constants + `routes/guest.js`),
// never a grep for quoted Slovak across the suite.
const MAIL_INTRO = 'Dobrý deň, vaša objednávka bola prijatá.'
const MAIL_ORDER_HEADING = 'Objednávka:'
const MAIL_PAYMENT_HEADING = 'Platba:'
const MAIL_TOTAL_LABEL = 'Spolu'
const MAIL_REFERENCE_LABEL = 'Referencia'
const MAIL_IBAN_LABEL = 'IBAN'
// ⚠ The eighth string. It was the ONE draft label not mirrored here at first, and no
// test configured `payment_revolut_username` — so the two-place sign-off guarantee
// held for seven strings out of eight and that kv row was rendered but never
// asserted. Both halves fixed: the constant below and `setRevolut()` in the body test.
const MAIL_REVOLUT_LABEL = 'Revolut'
const MAIL_AMOUNT_LABEL = 'Suma'
// Reuses the confirmation screen's own signed line, recast declaratively — one voice
// for one fact across mail and screen (plain hyphen, as on the screen).
const MAIL_SAVE_LINK = 'Stav objednávky uvidíte na tomto odkaze - uložte si ho:'

const MAIL_ENV = { MAILGUN_API_KEY: FAKE_MAILGUN_KEY, MAILGUN_DOMAIN: STUB_MAILGUN_DOMAIN }
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'
// The mailed link is followed in a real browser; that needs the built SPA the harness
// backend would serve. Absent ⇒ the backend answers 503 with the build command.
const SPA_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/public/index.html')
const HAS_SPA = fs.existsSync(SPA_INDEX)
// Read off disk (the `self-hosted-fonts.spec.js` / `catalog-import.spec.js` precedent)
// for the D11 source-level gate below.
const GUEST_ROUTE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/routes/guest.js')

// The A/B pair for 08 §UC-EM-004, applied to a GUEST URL: an origin the deployment
// really is served from (so `resolveLoginUrl`'s Origin branch WOULD honour it) and a
// different pinned base URL that must beat it. Without an allowlisted Origin the
// negative is vacuous — `index.js`'s CORS callback 500s a foreign Origin before any
// route runs, so the resolver would never be reached.
const ALLOWED_ORIGIN = 'https://allowed-gr8.test'
const PINNED_BASE_URL = 'https://pinned-gr8.test'

const GUEST_EMAIL = () => `gr8.${uniq}.${Math.floor(Math.random() * 1e6)}@example.test`
const IBAN = 'SK9911110000001234567890'

async function waitForStubCalls(stub, count, label) {
  await expect.poll(() => stub.requests.length, { message: label, timeout: 10_000 }).toBe(count)
}

// ⚠ Nothing may fire AFTER the expected count either. Gives a background send a beat
// to prove it stayed quiet — the "no mail on this path" half of D10.
async function expectNoFurtherCalls(stub, count, label) {
  await new Promise((r) => setTimeout(r, 1500))
  expect(stub.requests.length, label || 'no extra outbound sends settled late').toBe(count)
}

// ⚠ The shared harness hands back its OWN request context + admin token; this wrapper
// swaps the module-level `ctx`/`adminToken` for the duration so every fixture builder
// at the top of this file targets the harness server instead of the gate server. The
// invitation-approval.spec.js pattern verbatim — safe because `fullyParallel: false`.
async function withHarness(mailEnv, fn) {
  const savedCtx = ctx
  const savedToken = adminToken
  try {
    await withMailHarness(mailEnv, async (harness) => {
      ctx = harness.ctx
      adminToken = harness.adminToken
      await fn(harness)
    })
  } finally {
    ctx = savedCtx
    adminToken = savedToken
  }
}

const setIban = (iban) => admin('/api/admin/settings', { method: 'put', data: { paymentIban: iban } })
const setRevolut = (username) =>
  admin('/api/admin/settings', { method: 'put', data: { paymentRevolutUsername: username } })
const REVOLUT_USERNAME = 'podpultovka'

// ⚠ THE POSITIVE CONTROL for every zero-send assertion. A test that proves "no mail
// was sent" is worthless until it has proved, IN THE SAME HARNESS INSTANCE, that a
// mail CAN be sent: a broken `MAILGUN_*` env on this particular throwaway backend
// would otherwise satisfy the negative just as well as the rule under test does.
// (Test 1 proves the env works, but in a DIFFERENT process.)
async function proveTheHarnessCanSend(stub, { linkToken, productId }, expectedBefore) {
  expect(stub.requests.length, 'the control starts from the asserted zero').toBe(expectedBefore)
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, {
    data: {
      guest_name: 'Kontrolna Vzorka', guest_phone: uniquePhone(), guest_email: GUEST_EMAIL(),
      items: [{ product_id: productId, variant: '250g', quantity: 1 }],
    },
  })
  expect(res.status(), 'the control submit').toBe(201)
  await waitForStubCalls(stub, expectedBefore + 1, 'a VALID address on THIS SAME server does send (0 → 1)')
}

test.describe('UC-GR-011 — the guest order-confirmation mail', () => {
  // ⚠⚠ THE ONLY GATE ON D11's ACTUAL RISK, and it is a SOURCE-level one because the
  // risk is not observable at runtime.
  //
  // The elapsed-time assertion further down covers exactly ONE mutation: a yield
  // between the send and `res.json()`. It does NOT cover a yield placed AFTER the
  // response (harmless to the 201, still forbidden), and — the case the rule exists
  // for — it CANNOT cover a yield inserted between the stock check and the insert
  // transaction. That window is where `instances: 1` + a fully synchronous handler is
  // the whole of the overselling defence on the app's only unauthenticated write
  // (the GA-T8 lesson: `instances: 1` was never the load-bearing half on its own —
  // "and the handlers are fully synchronous" was). A request that yields there lets a
  // second one pass the same stock check and both insert; nothing in this suite can
  // reproduce it, and production would just quietly sell coffee it does not have.
  //
  // So the rule is enforced where it is legible: zero concurrency keywords in the
  // file, full stop. Cheap, total, and it fails on the LINE that introduces the
  // hazard rather than three months later on a stock report.
  test('⚠ D11 — routes/guest.js contains ZERO concurrency keywords (the source-level gate the runtime cannot provide)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    const source = fs.readFileSync(GUEST_ROUTE, 'utf8')
    const found = [...source.matchAll(/\b(async|await)\b/g)].map((m) => {
      const line = source.slice(0, m.index).split('\n').length
      return `${m[1]} at guest.js:${line}`
    })
    expect(
      found,
      'routes/guest.js must stay fully synchronous (14 §UC-GR-011 rule 2 / D11).\n' +
        'The submit handler checks stock OUTSIDE the insert transaction; that is safe ONLY because\n' +
        'nothing can interleave — `instances: 1` AND a handler that cannot yield. A single keyword\n' +
        'here reopens overselling on the app\'s only unauthenticated write, and NO behavioural test\n' +
        'in this repo can detect it. If you need a network call in this file, fire it as a floating\n' +
        'promise AFTER the response, the way `deliverOrderConfirmation` does.'
    ).toEqual([])
  })

  test('submit WITH an e-mail: ONE send whose text + html carry the items, the total, the shared payment reference and the canonical /g/o/ URL built from PUBLIC_BASE_URL', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withHarness({ ...MAIL_ENV, PUBLIC_BASE_URL: PINNED_BASE_URL, CORS_ORIGIN: ALLOWED_ORIGIN }, async ({ stub }) => {
      expect((await setIban(IBAN)).status(), 'set the payment IBAN').toBe(200)
      // ⚠ Configured so the Revolut kv row is actually RENDERED and therefore
      // actually asserted below. It also makes the "only one origin in the html"
      // assertion non-trivial: a `revolut.me/<user>` link is exactly what the
      // implementation rejects, and with the username unset it could never appear.
      expect((await setRevolut(REVOLUT_USERNAME)).status(), 'set the Revolut username').toBe(200)

      const host = await makeHost('mailbody')
      const cycle = await makeCycle('mailbody')
      const product = await addProduct(cycle.id, {
        name: `GR mailbody ${uniq}`, purpose: 'Espresso', price_250g: 7.6, price_1kg: 25,
      })
      const link = await shareLink(host, cycle.id)

      const email = GUEST_EMAIL()
      const identity = { guest_name: 'Martina Tomasova', guest_phone: uniquePhone(), guest_email: email }
      const res = await ctx.post(`/api/guest/${link.token}/orders`, {
        headers: { Origin: ALLOWED_ORIGIN },
        data: { ...identity, items: [{ product_id: product.id, variant: '250g', quantity: 2 }] },
      })
      expect(res.status(), 'the submit still 201s').toBe(201)
      const created = await res.json()
      const orderToken = created.order.order_token
      const url = `${PINNED_BASE_URL}/g/o/${orderToken}`

      await waitForStubCalls(stub, 1, 'exactly one outbound send')
      await expectNoFurtherCalls(stub, 1)
      const fields = multipartFields(stub.requests[0])

      expect(fields.to, 'addressed to the e-mail given at checkout').toBe(email)
      expect(fields.subject).toBe(MAIL_SUBJECT)
      expect(fields['o:tracking-clicks'], 'tracking stays disabled per message').toBe('no')
      expect(fields['o:tracking-opens']).toBe('no')

      // ── the plain part: the deliverability baseline carries EVERYTHING ──
      expect(fields.text).toContain(MAIL_INTRO)
      expect(fields.text).toContain(MAIL_ORDER_HEADING)
      // The item line: quantity × name (variant) - line amount, `€` on lines.
      expect(fields.text, 'the item line, priced from the frozen snapshot').toContain(
        `2× GR mailbody ${uniq} (250g) - 15.20 €`
      )
      expect(fields.text, 'the total, EUR on totals').toContain(`${MAIL_TOTAL_LABEL}: 15.20 EUR`)
      expect(fields.text).toContain(MAIL_PAYMENT_HEADING)
      // ⚠ The SHARED formatter — the guest's mail and the admin's unpaid overview can
      // never disagree about the reference (the GSO-T6 one-formatter rule).
      expect(created.payment.reference).toBe(`G${created.order.id} / ${identity.guest_name} / ${cycle.name}`)
      expect(fields.text, 'the reference the 201 carries, byte-identical').toContain(
        `${MAIL_REFERENCE_LABEL}: ${created.payment.reference}`
      )
      expect(fields.text).toContain(`${MAIL_IBAN_LABEL}: ${IBAN}`)
      expect(fields.text).toContain(`${MAIL_REVOLUT_LABEL}: ${REVOLUT_USERNAME}`)
      expect(fields.text, 'the Revolut USERNAME, never a revolut.me link').not.toContain('revolut.me')
      expect(fields.text).toContain(`${MAIL_AMOUNT_LABEL}: 15.20 EUR`)
      expect(fields.text).toContain(MAIL_SAVE_LINK)
      expect(fields.text, 'the bare canonical URL in the plain part').toContain(url)

      // ⚠ The mailed token IS the 201's `status_path` token, and the CANONICAL form
      // only — never the pair form (UC-GR-003's "never newly emitted" rule).
      expect(created.status_path).toBe(`/g/o/${orderToken}`)
      expect(fields.text, 'no pair-form URL is ever minted').not.toContain(`/g/${link.token}/o/`)
      expect(fields.html).not.toContain(`/g/${link.token}/o/`)
      // The pin beat a genuinely allowlisted request Origin.
      expect(fields.text).not.toContain(ALLOWED_ORIGIN)

      // ── the html part ──
      expect(fields.html, 'renderEmail produced the branded shell').toContain('<!DOCTYPE html>')
      expect(fields.html, 'the branded text wordmark').toContain('POD<span')
      expect(fields.html, 'the button href is the canonical URL').toContain(`href="${url}"`)
      expect(fields.html).toContain(created.payment.reference)
      expect(fields.html).toContain(IBAN)
      expect(fields.html, 'the Revolut row reaches the html part too').toContain(REVOLUT_USERNAME)
      expect(fields.html).toContain('15.20')
      // 08 §UC-EM-005 item 3 — no remote assets, no CDN, no second host anywhere.
      // ⚠ Non-trivial precisely because a Revolut username IS configured above: the
      // obvious "helpful" change is a `revolut.me/<user>` payment link, and that is
      // the assertion that would stop it.
      const hosts = new Set([...fields.html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map((m) => new URL(m[0]).origin))
      expect([...hosts], 'the only origin in the mail is the pinned one').toEqual([PINNED_BASE_URL])
    })
  })

  test('the mailed link REALLY OPENS the order — a confirmation mail with a dead link is the failure this row exists to prevent', async ({ browser }) => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.skip(!HAS_SPA, 'needs the built SPA at backend/public (npm run build in frontend/)')
    // No PUBLIC_BASE_URL override here: `startBackend` pins it to the harness server's
    // own origin, so the mailed URL is followable.
    await withHarness(MAIL_ENV, async ({ stub, backend }) => {
      const host = await makeHost('maillive')
      const cycle = await makeCycle('maillive')
      const product = await addProduct(cycle.id, {
        name: `GR maillive ${uniq}`, purpose: 'Espresso', price_250g: 9,
      })
      const link = await shareLink(host, cycle.id)
      const email = GUEST_EMAIL()
      const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
        guest_name: 'Zuzana Malikova', guest_phone: uniquePhone(), guest_email: email,
      })

      await waitForStubCalls(stub, 1, 'one outbound send')
      const text = multipartFields(stub.requests[0]).text
      // Extracted FROM THE MAIL BODY, never composed by the test.
      const match = text.match(/https?:\/\/[^\s]*\/g\/o\/[A-Z0-9]+/)
      expect(match, 'the plain part carries a followable canonical URL').toBeTruthy()
      const mailedUrl = match[0]
      expect(mailedUrl, 'the mailed origin is the harness server').toBe(`${backend.baseUrl}/g/o/${created.order.order_token}`)

      // A FRESH context: no localStorage, no session — exactly what a guest opening
      // the mail on another device has.
      const context = await browser.newContext({ baseURL: backend.baseUrl })
      try {
        const page = await context.newPage()
        await page.goto(mailedUrl)
        // The ORDER, not merely a page: the ordered line and the amount owed.
        // (Scoped to `status-item` — the cycle heading carries the same name.)
        const line = page.getByTestId('status-item')
        await expect(line, 'the ordered line renders').toBeVisible({ timeout: 15_000 })
        await expect(line).toContainText(`GR maillive ${uniq}`)
        await expect(line).toContainText('9.00')
        // …and it is THIS guest's order, not a generic page: the status screen shows
        // the total owed. (The payment reference itself lives behind PaymentModal.)
        await expect(page.getByText('9.00 EUR').first()).toBeVisible()
      } finally {
        await context.close()
      }
    })
  })

  test('submit WITHOUT an e-mail: ZERO sends, and the 201 payload shape is unchanged', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withHarness(MAIL_ENV, async ({ stub }) => {
      const host = await makeHost('nomail')
      const cycle = await makeCycle('nomail')
      const product = await addProduct(cycle.id, { name: `GR nomail ${uniq}`, purpose: 'Espresso', price_250g: 11 })
      const link = await shareLink(host, cycle.id)

      const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
        guest_name: 'Bez Mailu', guest_phone: uniquePhone(),
      })
      expect(created.order.guest_email, 'an omitted optional field stays null').toBe(null)
      expect(created.status_path).toBe(`/g/o/${created.order.order_token}`)
      expect(created.payment.reference).toContain(`G${created.order.id} / `)

      await expectNoFurtherCalls(stub, 0, 'no e-mail given ⇒ no send, no build, no log')
      // …and the zero above is the RULE, not a broken harness.
      await proveTheHarnessCanSend(stub, { linkToken: link.token, productId: product.id }, 0)
    })
  })

  test('⚠ D11 fire-and-forget: an UNHAPPY AND SLOW Mailgun neither fails nor delays the 201, and the sub-order exists', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withHarness(MAIL_ENV, async ({ stub }) => {
      // ⚠ THE MUTATION TARGET FOR D11, and the SLOW half is the load-bearing one.
      // A 500 alone proves nothing: the mailer never throws, so a blocking send
      // would still answer 201 — just later. The instrument is therefore the CLOCK
      // (the magic-link §UC-ML-003 rule-2 technique): the stub records the request
      // immediately and delays only its REPLY, so a handler that waits on the send
      // is measurably slower. Mutation-verified — making the send blocking takes the
      // 201 from ~200 ms to the full delay and reddens the elapsed assertion below.
      // The same blocking send would also reopen the GA-T8 check-then-write hazard on
      // the out-of-transaction stock check, which NO test in this repo can see.
      const REPLY_DELAY_MS = 4000
      stub.setReply({ status: 500, body: { message: 'Mailgun is unhappy' } })
      stub.setReplyDelay(REPLY_DELAY_MS)
      expect((await setIban(IBAN)).status()).toBe(200)

      const host = await makeHost('mail500')
      const cycle = await makeCycle('mail500')
      const product = await addProduct(cycle.id, { name: `GR mail500 ${uniq}`, purpose: 'Espresso', price_250g: 12.5 })
      const link = await shareLink(host, cycle.id)

      const startedAt = Date.now()
      const res = await ctx.post(`/api/guest/${link.token}/orders`, {
        data: {
          guest_name: 'Ivana Kovacova', guest_phone: uniquePhone(), guest_email: GUEST_EMAIL(),
          items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
        },
      })
      const elapsed = Date.now() - startedAt
      expect(res.status(), 'the 201 survives an unhappy Mailgun').toBe(201)
      // ⚠ THE ASSERTION THE MUTATION REDDENS. Half the delay is a wide margin on a
      // loaded box while still being unreachable by a handler that waits on the send.
      expect(elapsed, `the 201 did not wait on the send (${elapsed} ms of a ${REPLY_DELAY_MS} ms reply delay)`)
        .toBeLessThan(REPLY_DELAY_MS / 2)
      const created = await res.json()
      // The FULL payment payload, not a degraded one.
      expect(created.payment.amount).toBe(12.5)
      expect(created.payment.iban).toBe(IBAN)
      expect(created.payment.reference).toContain(`G${created.order.id} / Ivana Kovacova / `)

      await waitForStubCalls(stub, 1, 'the send was attempted')

      // The order really is there, readable through the canonical URL.
      const status = await ctx.get(`/api/guest/o/${created.order.order_token}`)
      expect(status.status(), 'the sub-order exists and resolves').toBe(200)
      expect((await status.json()).items.length).toBe(1)
    })
  })

  test('⚠ D10 send-on-CREATE only: an edit and an items:[] cancel fire NO further send', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withHarness(MAIL_ENV, async ({ stub }) => {
      const host = await makeHost('d10')
      const cycle = await makeCycle('d10')
      const product = await addProduct(cycle.id, {
        name: `GR d10 ${uniq}`, purpose: 'Espresso', price_250g: 8, price_1kg: 24,
      })
      const link = await shareLink(host, cycle.id)
      const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
        guest_name: 'Petra Novakova', guest_phone: uniquePhone(), guest_email: GUEST_EMAIL(),
      })

      await waitForStubCalls(stub, 1, 'the CREATE mails, once')
      const canonical = `/api/guest/o/${created.order.order_token}`

      // (1) an EDIT
      const edited = await ctx.put(canonical, {
        data: { items: [{ product_id: product.id, variant: '1kg', quantity: 1 }] },
      })
      expect(edited.status(), 'the edit succeeds').toBe(200)
      await expectNoFurtherCalls(stub, 1, 'an edit sends nothing (D10)')

      // (2) a CANCEL — the literal `items: []`, the only input that may cancel
      const cancelled = await ctx.put(canonical, { data: { items: [] } })
      expect(cancelled.status(), 'the cancel succeeds').toBe(200)
      expect((await cancelled.json()).order.status).toBe('cancelled')
      await expectNoFurtherCalls(stub, 1, 'a cancel sends nothing (D10) — the named follow-up stays unimplemented')
    })
  })

  test('an implausible address is refused by the mailer WITHOUT a network call, and the 201 is untouched', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    await withHarness(MAIL_ENV, async ({ stub }) => {
      const host = await makeHost('badmail')
      const cycle = await makeCycle('badmail')
      const product = await addProduct(cycle.id, { name: `GR badmail ${uniq}`, purpose: 'Espresso', price_250g: 6 })
      const link = await shareLink(host, cycle.id)

      // `validateIdentity` deliberately has NO shape check and this row adds none —
      // the mailer's own loose `EMAIL_SHAPE` gate answers `invalid_recipient`.
      const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
        guest_name: 'Nespravna Adresa', guest_phone: uniquePhone(), guest_email: 'not-an-address',
      })
      expect(created.order.guest_email, 'the stored value is never mutated by the send').toBe('not-an-address')

      await expectNoFurtherCalls(stub, 0, 'EMAIL_SHAPE refuses before any network call')
      // …and the zero above is the GATE, not a broken harness: the same server, the
      // same link, the same product — only the address differs.
      await proveTheHarnessCanSend(stub, { linkToken: link.token, productId: product.id }, 0)
    })
  })
})

// ---------------------------------------------------------------------------
// UC-GR-012 / D3 AMENDED — a host may not regenerate a link colleagues are already
// ordering through; the ADMIN is the escalation target.
//
// PO instruction, verbatim (2026-08-31): "ak už hosť objednal, priateľ by nemal byť
// schopný vygenerovať odkaz, ktorý vytvorenú objednávku zruší. V dialogu by mal mat
// napisane, ze novy odkaz nie je možné vygenerovať, kým existujú vytvorené
// objednávky. Ak chce aj tak nový odkaz vygenerovať, musí kontaktovať admina."
//
// ⚠ WHY THIS IS MORE THAN A UI RULE. "Contact the admin" only means something if the
// admin can actually do it, and under D3 as originally written the admin could NOT
// regenerate — so the copy would have pointed at a dead end. That is precisely the
// GSO-T5 failure pattern this whole module exists to remove ("escalate to the admin"
// with no admin route, and a paying guest nobody could help). So the row ships both
// halves, and the tests below run the escalation end to end rather than testing each
// half in isolation.
//
// ⚠ WHAT MAKES THE AMENDMENT SAFE, and the one property everything here rests on: a
// guest's order URL resolves by `order_token` ALONE (§UC-GR-001/002, GR-T1/GR-T2), so
// NO regeneration by anyone can strand an already-created order. D3's stated reason
// for forbidding an admin regenerate — "it silently severs every colleague already
// holding the URL" — was true only while the (link, order) PAIR was the credential.
// It is spent. What regeneration still does is retire the ORDERING url, which is
// exactly the deliberate act the PO wants gated.
//
// The surviving half of D3 is asserted too: the admin regenerate writes `token` and
// never `active`, so it can never republish a link the host revoked after a leak.

// DRAFT copy pending PO sign-off (14 §OPEN), hoisted for the standing reason: the
// sign-off edit is then a known TWO-PLACE change (this constant + the SFC literal),
// never a grep for quoted Slovak across the suite.
//
// ⚠ The declension is restated here INDEPENDENTLY of `lib/plural.js`'s
// `ordersAccusativeLabel` rather than imported — a spec that imports the helper it is
// checking would pass through any change to it. 1 objednávku / 2-4 objednávky /
// 5+ objednávok, the ACCUSATIVE, because the sentence puts it after "máte".
const regenBlockedOrders = (n) => (
  n === 1 ? '1 objednávku' : (n >= 2 && n <= 4 ? `${n} objednávky` : `${n} objednávok`)
)
const REGEN_BLOCKED = (n) =>
  `Cez tento odkaz už máte ${regenBlockedOrders(n)} od kolegov, preto nový odkaz nie je možné vygenerovať. Ak ho potrebujete, kontaktujte správcu.`

// The host's own create-or-regenerate POST, unasserted — the tests below check its
// status themselves, which `shareLink()` cannot do (it asserts 200/201).
const hostRegenerate = (host, cycleId) =>
  ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })

test.describe('UC-GR-012 — regeneration is blocked while colleagues have live orders', () => {
  test('THE RULE: the host is refused with 409 `has_orders`, and the refusal is NON-DESTRUCTIVE', async () => {
    await refreshAdminToken()
    const { host, cycle, link } = await orderScenario('regenblock')

    const refused = await hostRegenerate(host, cycle.id)
    expect(refused.status(), 'a colleague has ordered — the host may not invalidate the link').toBe(409)
    const body = await refused.json()
    expect(body.reason).toBe('has_orders')
    expect(body.live_orders, 'the count the dialog renders comes from the same predicate').toBe(1)
    // Slovak, vy-form, and it names the escalation target — otherwise the host is
    // refused with nowhere to go.
    expect(body.error).toContain('kontaktujte správcu')

    // ⚠ THE REFUSAL WROTE NOTHING. A 409 that had already rotated the token would be
    // the worst of both worlds: the colleagues' link dead AND the host told it failed.
    const after = (await hostView(host, cycle.id)).link
    expect(after.token, 'the token did not move').toBe(link.token)
    expect(after.id).toBe(link.id)
    expect(after.active, '`active` untouched too').toBe(1)
  })

  test('CREATION is untouched by the gate — a first-time share still 201s', async () => {
    await refreshAdminToken()
    const host = await makeHost('regencreate')
    const cycle = await makeCycle('regencreate')

    // ⚠ The gate lives in the `if (existing)` branch, so the create path cannot be
    // reached by it — with no link row there is nothing for a sub-order to hang off.
    // Asserted rather than argued, because a future refactor that hoists the count
    // above the branch would break first-time sharing for everyone.
    const created = await hostRegenerate(host, cycle.id)
    expect(created.status(), 'a host with no link can always create one').toBe(201)
    const payload = await created.json()
    expect(payload.regenerated).toBe(false)
    expect(payload.link.token).toBeTruthy()
    expect(payload.totals.count, 'a brand-new link has no sub-orders by construction').toBe(0)

    // And an EMPTY existing link still regenerates freely — the gate is about live
    // orders, not about the link having been shared before.
    const again = await hostRegenerate(host, cycle.id)
    expect(again.status()).toBe(200)
    const rotated = await again.json()
    expect(rotated.regenerated).toBe(true)
    expect(rotated.link.id, 'same row').toBe(payload.link.id)
    expect(rotated.link.token).not.toBe(payload.link.token)
  })

  test('a CANCELLED sub-order does NOT block — the status predicate doing its job', async () => {
    await refreshAdminToken()
    const { host, cycle, link, created } = await orderScenario('regencancelled')

    // Blocked while it is live…
    expect((await hostRegenerate(host, cycle.id)).status()).toBe(409)

    // …and free again once it is called off. A cancelled sub-order owes nothing, holds
    // no stock and is nobody's pending hand-over, so there is nothing left to protect.
    expect((await cancelSubOrder(created.order.id)).status(), 'admin cancels').toBe(200)

    const allowed = await hostRegenerate(host, cycle.id)
    expect(allowed.status(), 'a cancelled order must not keep the link frozen forever').toBe(200)
    const fresh = (await allowed.json()).link
    expect(fresh.id, 'still the same row').toBe(link.id)
    expect(fresh.token).not.toBe(link.token)

    // ⚠ And the cancelled row is STILL THERE (GSO-T4: cancelling keeps the item rows).
    // The gate reads a status predicate, never a row count — if it ever regresses to
    // `COUNT(*)`, this stays green while the test above goes red, which is why both
    // halves are asserted in one test.
    const view = await hostView(host, cycle.id)
    expect(view.guest_orders.map((o) => o.id), 'the record of what was called off survives').toContain(created.order.id)
    expect(view.totals.count, 'but it counts for nothing').toBe(0)
  })

  test('the ADMIN regenerate is EXEMPT, rotates IN PLACE, and every live sub-order survives it', async () => {
    await refreshAdminToken()
    const { host, cycle, product, link } = await orderScenario('regenadmin')
    const second = await submitGuest(link.token, [
      { product_id: product.id, variant: '1kg', quantity: 1 },
    ], { guest_name: 'Kolega Druhy', guest_phone: uniquePhone() })

    const before = await hostView(host, cycle.id)
    expect(before.totals.count, 'two live colleagues').toBe(2)
    expect((await hostRegenerate(host, cycle.id)).status(), 'the host is still refused').toBe(409)

    // The escalation target. No `has_orders` gate — being exempt is its whole purpose.
    const fresh = await adminRegenerate(cycle.id, host.id)
    expect(fresh.id, '⚠ UPDATE IN PLACE. `guest_orders.link_id` CASCADES ON DELETE, so a DELETE+INSERT here would wipe every sub-order').toBe(link.id)
    expect(fresh.token).not.toBe(link.token)

    // ⚠ THE CASCADE PROOF, stated in terms a DELETE+INSERT could not fake: the same
    // sub-order IDS, with their items and totals intact, still hanging off the link.
    const after = await hostView(host, cycle.id)
    expect(after.link.id).toBe(link.id)
    expect(after.totals.count, 'nothing was cascaded away').toBe(2)
    expect(after.guest_orders.map((o) => o.id).sort()).toEqual(before.guest_orders.map((o) => o.id).sort())
    for (const row of before.guest_orders) {
      const kept = after.guest_orders.find((o) => o.id === row.id)
      expect(kept.status).toBe('submitted')
      expect(kept.total).toBe(row.total)
      expect(kept.items.length, 'the item rows survived too').toBe(row.items.length)
    }
  })

  test('⚠ THE PO RULE END TO END: guest orders → host refused → admin regenerates → her URL still opens, the old link takes no new orders', async () => {
    await refreshAdminToken()
    const { host, cycle, product, link, created, orderToken } = await orderScenario('regene2e')

    // ── 1. The host tries to regenerate and is refused, with the reason. ────
    const refused = await hostRegenerate(host, cycle.id)
    expect(refused.status()).toBe(409)
    expect((await refused.json()).reason).toBe('has_orders')

    // ── 2. The admin — whom the dialog names — performs it instead. ─────────
    const fresh = await adminRegenerate(cycle.id, host.id)
    expect(fresh.token).not.toBe(link.token)

    // ── 3. THE PROPERTY THAT MAKES ALL OF THIS SAFE: her existing order URL still
    //       resolves, under the retired link half AND canonically. This is the whole
    //       basis for amending D3 — without it, an admin regenerate would recreate
    //       the incident instead of resolving it.
    for (const [label, path] of [
      ['her SAVED pair URL, retired link half', pairPath(link.token, orderToken)],
      ['the new pair form', pairPath(fresh.token, orderToken)],
      ['the canonical form', canonicalPath(orderToken)],
    ]) {
      const res = await ctx.get(path)
      expect(res.status(), `${label} must still resolve`).toBe(200)
      expect((await res.json()).order.id).toBe(created.order.id)
    }

    // ── 4. …and the OLD share link is genuinely retired for NEW business, which is
    //       the entire point of regenerating. Both public doors, not just the listing.
    const listing = await ctx.get(`/api/guest/${link.token}`)
    expect(listing.status(), 'the old ordering link no longer lists the offer').toBe(404)
    const newOrder = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: { guest_name: 'Neskory Kolega', guest_phone: uniquePhone(), items: [{ product_id: product.id, variant: '250g', quantity: 1 }] },
    })
    expect(newOrder.status(), '⚠ and nobody NEW can order through it').toBe(404)

    // ── 5. The new link works, so the host is not left without a share URL. ─
    const viaNew = await ctx.get(`/api/guest/${fresh.token}`)
    expect(viaNew.status()).toBe(200)
  })

  test('the admin regenerate 404s where there is nothing to rotate, and never creates one', async () => {
    await refreshAdminToken()
    const host = await makeHost('regen404')
    const cycle = await makeCycle('regen404')

    const noLink = await admin(`/api/guest-links/cycle/${cycle.id}/host/${host.id}/regenerate`, { method: 'post' })
    expect(noLink.status(), 'no link for this (cycle, host)').toBe(404)
    expect((await noLink.json()).reason).toBe('no_link')

    // ⚠ AND IT DID NOT SILENTLY MINT ONE. "Regenerate" doubling as create-if-missing
    // is how a rotation ends up handing out links nobody asked for; that capability is
    // the sibling route and stays there.
    expect((await hostView(host, cycle.id)).link, 'no link was created as a side effect').toBeFalsy()

    expect((await admin(`/api/guest-links/cycle/999999/host/${host.id}/regenerate`, { method: 'post' })).status()).toBe(404)
    expect((await admin(`/api/guest-links/cycle/${cycle.id}/host/999999/regenerate`, { method: 'post' })).status()).toBe(404)
  })

  test('THE DIALOG: the regenerate affordance is REPLACED by the explanation, and deactivation stays', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle } = await orderScenario('regendialog')

    const dialog = await openFromOrderPage(page, host, cycle)

    // ⚠ REPLACED, not disabled. A disabled button reads as "you may do this, later",
    // and the host has nothing to wait for — the answer is to contact the admin.
    await expect(dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' })).toHaveCount(0)
    await expect(dialog.locator('.confirmbox')).toHaveCount(0)

    const blocked = dialog.getByTestId('regen-blocked')
    await expect(blocked).toHaveText(REGEN_BLOCKED(1))
    // `div.field-help` for the §UC-GR-009 placement reason: `p.sub` is pinned as a
    // SINGLE element in an immutable spec, and `.field-help` is A10-covered.
    expect(await blocked.evaluate((el) => el.tagName.toLowerCase())).toBe('div')
    await expect(blocked).toHaveClass(/field-help/)

    // The "regenerate only on a leak" guidance yields to it — otherwise the dialog
    // would be telling the host to do something this very state forbids.
    await expect(dialog.getByTestId('regen-guidance')).toHaveCount(0)

    // ⚠ DEACTIVATION IS STILL OFFERED, and that is deliberate: revoking a leaked link
    // is exactly what a host with live orders still needs, and it strands nobody —
    // every existing order resolves by `order_token`.
    await expect(dialog.getByRole('button', { name: 'Deaktivovať odkaz' })).toBeVisible()
    // The URL stays copyable: the colleagues who have NOT ordered yet still need it.
    await expect(dialog.getByTestId('guest-link-url')).toBeVisible()

    // No horizontal overflow at 320px — the copy is long and this is the narrowest
    // supported width (the standing mobile invariant).
    await page.setViewportSize({ width: 320, height: 900 })
    await expect(blocked).toBeVisible()
    const box = await overflow(page)
    expect(box.scrollW, `320px: no sideways scroll (${box.scrollW} vs ${box.clientW})`).toBeLessThanOrEqual(box.clientW)
  })

  test('THE DIALOG: the count declines, and the affordance RETURNS once the only order is cancelled', async ({ page }) => {
    await refreshAdminToken()
    const { host, cycle, product, link, created } = await orderScenario('regendialog2')
    await submitGuest(link.token, [{ product_id: product.id, variant: '1kg', quantity: 1 }],
      { guest_name: 'Kolega Dva', guest_phone: uniquePhone() })
    const third = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }],
      { guest_name: 'Kolega Tri', guest_phone: uniquePhone() })

    let dialog = await openFromOrderPage(page, host, cycle)
    // 3 → the 2-4 branch ("3 objednávky"), a different form from the 1 case above.
    await expect(dialog.getByTestId('regen-blocked')).toHaveText(REGEN_BLOCKED(3))

    // Cancel two of the three: still blocked, and the number must FOLLOW.
    expect((await cancelSubOrder(created.order.id)).status()).toBe(200)
    expect((await cancelSubOrder(third.order.id)).status()).toBe(200)

    await page.reload()
    dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.getByTestId('regen-blocked'), 'the count tracks LIVE orders, not rows').toHaveText(REGEN_BLOCKED(1))

    // Cancel the last one — the affordance comes back. This is a STATE rule, not a
    // one-way latch: a host whose colleagues all called off can share afresh.
    const remaining = (await hostView(host, cycle.id)).guest_orders
      .find((o) => (o.status || 'submitted') !== 'cancelled')
    expect((await cancelSubOrder(remaining.id)).status()).toBe(200)

    dialog = await openFromOrderPage(page, host, cycle)
    await expect(dialog.getByTestId('regen-blocked')).toHaveCount(0)
    await expect(dialog.getByTestId('regen-guidance'), 'the standing guidance comes back with it').toBeVisible()
    const trigger = dialog.getByRole('button', { name: 'Vygenerovať nový odkaz' })
    await expect(trigger).toBeVisible()

    // …and it really works from here, rather than merely being rendered.
    await trigger.click()
    await dialog.getByRole('button', { name: 'Áno, vygenerovať' }).click()
    await expect(dialog.getByTestId('guest-link-url')).not.toHaveText(new RegExp(`/g/${link.token}$`))
    expect((await hostView(host, cycle.id)).link.token).not.toBe(link.token)
  })

  test('THE ADMIN UI: the orders tab regenerates a host\'s link, with the consequence stated', async ({ page }) => {
    await refreshAdminToken()
    // The host lands on this tab via `listedOrders`' has-guests branch — no own order
    // needed (the `orderScenario` guest sub-order is what lists them).
    const { host, cycle, link, orderToken } = await orderScenario('regenadminui')

    const token = await adoptUiAdmin(page)
    await gotoOrdersTab(page, cycle)

    // The inline confirm states BOTH halves, because the admin has to know that the
    // colleagues' existing orders are not what they are breaking.
    await hostLinkRegenBtn(page, host.id).click()
    const confirm = page.getByTestId(`host-guest-link-regen-confirm-${host.id}`)
    await expect(confirm).toContainText('Starý odkaz prestane prijímať nové objednávky.')
    await expect(confirm).toContainText('Už vytvorené objednávky kolegov zostanú funkčné.')

    // "Nie" backs out with nothing written.
    await page.getByTestId(`host-guest-link-regen-no-${host.id}`).click()
    await expect(confirm).toHaveCount(0)
    adminToken = token
    expect((await adminLinks(cycle.id)).find((l) => l.host_friend_id === host.id).token,
      'backing out rotates nothing').toBe(link.token)

    // And through.
    await hostLinkRegenBtn(page, host.id).click()
    await page.getByTestId(`host-guest-link-regen-yes-${host.id}`).click()
    await expect(page.getByTestId(`host-guest-link-regen-confirm-${host.id}`),
      'success closes the confirm').toHaveCount(0)

    adminToken = token
    const stored = (await adminLinks(cycle.id)).find((l) => l.host_friend_id === host.id)
    expect(stored.token, 'the token rotated').not.toBe(link.token)
    expect(stored.id, 'in place — same row').toBe(link.id)
    expect(stored.active, 'and `active` was never written').toBe(1)

    // The guest's order still resolves — the promise the confirm copy makes.
    expect((await ctx.get(canonicalPath(orderToken))).status()).toBe(200)
  })
})
