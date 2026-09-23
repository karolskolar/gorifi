import { test, expect, request as playwrightRequest } from '@playwright/test'
// PI-T1 · 18 §UC-PI-019 item 1 — the ONE home of the „portal is ready“ gate.
// It replaces this file's `getByRole('heading', { name: 'Objednávkové cykly' })`
// waits: that heading is a STRUCTURE module 18 retires (§UC-PI-005), so a gate
// tied to its copy could not survive the screen. Same claim, one home.
import { expectLanding, gotoCycle as portalGotoCycle } from '../helpers/portal.js'
import { ADMIN_PASSWORD, CYCLE_NAME } from '../fixtures.js'
import { makeAdmin } from '../helpers/admin.js'

// GSO-T2: the host's guest share link (`guest_order_links`) — create,
// regenerate (keeps the row id, and therefore any sub-orders hanging off it),
// deactivate/reactivate — plus the auth boundaries: anonymous 401, bare
// shared-password-without-identity 401, foreign friend 403.
//
// The public `/g/:token` surface (and everything that creates guest sub-orders)
// arrives with GSO-T3, so the sub-order list asserted here is empty by
// construction — the *shape* is what later tasks enrich.

let ctx
let adminToken
let cycleId
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// SEC-S2: tokens come from the same CSPRNG alphabet as invite codes / UIDs
// (see invite-code.spec.js). Randomness itself can't be asserted from the
// outside, so — as elsewhere in this suite — length + alphabet is the proxy.
const TOKEN_ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

// FUP-T27 — ONE home for the admin request path: it re-authenticates ONCE on a
// 401 instead of trusting a token the next `POST /api/admin/login` anywhere in the
// suite silently rotates out. See `helpers/admin.js`.
const admin = makeAdmin({
  ctx: () => ctx,
  token: () => adminToken,
  adopt: (t) => { adminToken = t },
})

// Create a friend with real credentials and log them in, so we hold a per-friend
// Bearer session token (the identity these endpoints require).
//
// `validateUsername` caps usernames at 30 chars and allows [a-z0-9._-] only, so
// the label is normalised and truncated: a long label must never turn into a 400
// from PUT /admin-username that looks like a failure of whatever the test was
// actually asserting. Uniqueness lives entirely in the run id + sequence SUFFIX,
// so truncation can only ever eat the (cosmetic) label.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso_${slug}`.slice(0, 30 - suffix.length) + suffix
  expect(username.length, 'username must fit validateUsername').toBeLessThanOrEqual(30)
  const name = `E2E GSO ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const body = await login.json()

  // An admin reset flags must-change; clear it so the session is a normal one.
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${body.token}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || body.token
  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
  const cycles = await admin('/api/cycles')
  cycleId = (await cycles.json()).find((c) => c.name === CYCLE_NAME).id
})

test.afterAll(async () => { await ctx?.dispose() })

test.describe('Guest share link — host CRUD', () => {
  test('host creates a link: CSPRNG token >= 12 chars, active, scoped to the cycle', async () => {
    const host = await makeHost('create')

    // Nothing shared yet.
    const before = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
    expect(before.status()).toBe(200)
    const beforeBody = await before.json()
    expect(beforeBody.link, 'no link before the host shares').toBeNull()
    expect(beforeBody.guest_orders, 'sub-order list is present even with no link').toEqual([])

    const res = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
    expect(res.status()).toBe(201)
    const { link, regenerated } = await res.json()
    expect(regenerated).toBe(false)
    expect(link.cycle_id).toBe(cycleId)
    expect(link.host_friend_id).toBe(host.id)
    expect(link.active).toBe(1)
    expect(link.token.length, 'token must be >= 12 chars (SEC-S2)').toBeGreaterThanOrEqual(12)
    expect(link.token, 'token must be drawn from the unambiguous CSPRNG alphabet (SEC-S2)').toMatch(TOKEN_ALPHABET)

    // GET returns the same link plus the (still empty) sub-order shape.
    const after = await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
    const afterBody = await after.json()
    expect(afterBody.link.id).toBe(link.id)
    expect(afterBody.link.token).toBe(link.token)
    expect(afterBody.guest_orders).toEqual([])
    expect(afterBody.totals).toEqual({ count: 0, total: 0 })
  })

  test('regenerating replaces the token but keeps the same link row (sub-orders survive)', async () => {
    const host = await makeHost('regen')

    const first = await (await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    const second = await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })
    expect(second.status()).toBe(200)
    const secondBody = await second.json()

    expect(secondBody.regenerated).toBe(true)
    expect(secondBody.link.id, 'same row → guest_orders.link_id FKs stay valid').toBe(first.link.id)
    expect(secondBody.link.token, 'a fresh token is issued').not.toBe(first.link.token)
    expect(secondBody.link.active).toBe(1)

    // The old token is gone: exactly one link exists for this (host, cycle) and
    // it carries the new token, so nothing can resolve the old one. (The public
    // `/g/:token` resolution check lands with GSO-T3.)
    const current = await (await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    expect(current.link.id).toBe(first.link.id)
    expect(current.link.token).toBe(secondBody.link.token)
    expect(current.link.token).not.toBe(first.link.token)
  })

  test('deactivating flips active; sharing again reactivates the same row', async () => {
    const host = await makeHost('deact')
    const created = await (await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()

    const patch = await ctx.patch(`/api/guest-links/${created.link.id}`, { headers: host.auth })
    expect(patch.status()).toBe(200)
    expect((await patch.json()).link.active).toBe(0)

    const readBack = await (await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    expect(readBack.link.active).toBe(0)

    // Re-share: same row, reactivated, new token.
    const again = await (await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    expect(again.link.id).toBe(created.link.id)
    expect(again.link.active).toBe(1)
  })

  test('PATCH with an explicit { active: true } body reactivates without issuing a new token', async () => {
    // Distinct from the "share again" path above: PATCH is the direct
    // deactivate/reactivate toggle and must not rotate the token — only POST
    // (regenerate) does that.
    const host = await makeHost('patchon')
    const created = await (await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    const { token } = created.link

    const off = await ctx.patch(`/api/guest-links/${created.link.id}`, { headers: host.auth })
    expect(off.status()).toBe(200)
    expect((await off.json()).link.active).toBe(0)

    const on = await ctx.patch(`/api/guest-links/${created.link.id}`, { headers: host.auth, data: { active: true } })
    expect(on.status()).toBe(200)
    const onBody = await on.json()
    expect(onBody.link.active).toBe(1)
    expect(onBody.link.id).toBe(created.link.id)
    expect(onBody.link.token, 'PATCH reactivation must not rotate the token').toBe(token)
  })

  test('an unknown cycle is a 404', async () => {
    const host = await makeHost('nocycle')
    expect((await ctx.post('/api/guest-links/cycle/99999999', { headers: host.auth })).status()).toBe(404)
    expect((await ctx.get('/api/guest-links/cycle/99999999', { headers: host.auth })).status()).toBe(404)
  })
})

test.describe('Guest share link — auth boundaries', () => {
  test('another friend cannot deactivate or read the host\'s link', async () => {
    const host = await makeHost('owner')
    const other = await makeHost('intruder')
    const created = await (await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()

    // Foreign friend on the host's link row → 403.
    const forbidden = await ctx.patch(`/api/guest-links/${created.link.id}`, { headers: other.auth })
    expect(forbidden.status(), 'foreign friend must not touch another host\'s link').toBe(403)
    expect((await (await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()).link.active).toBe(1)

    // The cycle-scoped GET is keyed on the authenticated friend, so the other
    // friend sees their own (absent) link, never the host's.
    const otherView = await (await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: other.auth })).json()
    expect(otherView.link).toBeNull()
  })

  test('a missing link row is a 404, not a 403 leak', async () => {
    const host = await makeHost('missing')
    expect((await ctx.patch('/api/guest-links/99999999', { headers: host.auth })).status()).toBe(404)
  })

  test('anonymous requests are rejected (401)', async () => {
    expect((await ctx.get(`/api/guest-links/cycle/${cycleId}`)).status()).toBe(401)
    expect((await ctx.post(`/api/guest-links/cycle/${cycleId}`)).status()).toBe(401)
    expect((await ctx.patch('/api/guest-links/1')).status()).toBe(401)
  })

  test('the shared friends password without a personal identity is rejected (401)', async () => {
    // Legacy shared-password auth resolves no friendId, so there is no host to
    // attribute the link to — and accepting a friend_id from the client would
    // reopen the IDOR SEC-A1 closed. Must be 401, not 200.
    const shared = { 'X-Friends-Password': process.env.FRIENDS_PASSWORD || 'e2e-friends-pass' }
    expect((await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: shared })).status()).toBe(401)
    expect((await ctx.post(`/api/guest-links/cycle/${cycleId}`, { headers: shared })).status()).toBe(401)

    // Sanity: the same shared password IS still accepted by an ordinary friend
    // endpoint, so the 401 above is this endpoint's identity rule, not a bad
    // password or a disabled legacy mode.
    expect((await ctx.get('/api/friends/cycles', { headers: shared })).status()).toBe(200)
  })
})

// UI pass on both share entry points (§UC-GSO-005 names FriendOrder AND
// FriendPortal). They share one GuestShareDialog component, so each test proves
// its own entry point reaches it. `navigator.share` does not exist in desktop
// Chromium, so the native share button must simply be absent rather than
// breaking the dialog.

// Sign the browser in as `host`, the way "remember me" does.
//
// FriendPortal resolves the stored session against GET /api/friends?active=true,
// which is admin-gated — an anonymous browser cannot read it (see e2e/README.md),
// so that ONE response is stubbed. Everything under test (the guest-link
// endpoints) still goes to the real backend with the real Bearer token.
async function signInAsHost(page, host) {
  const stored = JSON.stringify({
    friendId: host.id,
    friendName: host.name,
    token: host.token,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  })
  await page.addInitScript((value) => {
    localStorage.setItem('gorifi_friend_auth', value)
  }, stored)

  await page.route('**/api/friends?active=true', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: host.id, name: host.name, uid: 'E2EGSOUI', active: 1, subscriptions: ['coffee', 'bakery'] }]),
  }))
}

test.describe('Guest share link — UI', () => {
  test('host can open the share dialog from the order page and see the link + copy button', async ({ page }) => {
    const host = await makeHost('ui')
    await signInAsHost(page, host)

    await page.goto('/')
    await expectLanding(page)

    // Open the cycle → FriendOrder.
    // ⚠ PI-T3 · 18 §UC-PI-019 item 3 — the cycle CARDS are retired (§UC-PI-005);
    // `helpers/portal.js gotoCycle()` is the one home of portal → order navigation.
    await portalGotoCycle(page, cycleId)

    const shareButton = page.getByRole('button', { name: 'Zdieľať objednávku s kolegami' })

    // Sharing lives on the "Kolegovia" tab now — it used to sit above the product
    // list on every load, which is exactly what the tab split removed.
    await expect(shareButton, 'sharing must not clutter the own-order tab').toBeHidden()
    await page.getByTestId('main-tab-guests').click()
    await expect(shareButton).toBeVisible()
    await shareButton.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // No link yet → the host creates one from the dialog.
    await dialog.getByRole('button', { name: 'Vytvoriť odkaz' }).click()

    const urlField = dialog.getByTestId('guest-link-url')
    await expect(urlField).toBeVisible()
    // RD-KG-2, authorized by 05 §UC-KG-007 "Authorized e2e edits" item 1: the
    // value box is NeoCopyRow's `div.copyrow > .val` (02 §UC-DS-011), so there is
    // no <input> to read a value from. The element's text is always the FULL URL
    // — CSS truncates visually only. Assertion unchanged in substance.
    const value = (await urlField.textContent()).trim()
    expect(value, 'the full shareable URL is surfaced').toMatch(/\/g\/[A-Z2-9]{12,}$/)

    // SANCTIONED RETARGET (GL-T6b, 19 §UC-GL-008 — the standing section adds a second copy button; scoped to the per-cycle section)
    await expect(dialog.getByTestId('per-cycle-link').getByRole('button', { name: 'Kopírovať' })).toBeVisible()
    // navigator.share is unavailable here, so the native share sheet button hides.
    await expect(dialog.getByRole('button', { name: 'Zdieľať' })).toHaveCount(0)

    // The link the UI shows is the one the API stored.
    const fromApi = await (await ctx.get(`/api/guest-links/cycle/${cycleId}`, { headers: host.auth })).json()
    expect(value.endsWith(`/g/${fromApi.link.token}`)).toBe(true)
  })

  test('host can share straight from the LANDING cartbar, and the URL stays `/`', async ({ page }) => {
    // ⚠ PI-T3 · 18 §UC-PI-011/§UC-PI-019 item 12 — RETARGETED, not weakened. This was
    // „host can share straight from the portal cycle CARD, and only for open cycles".
    // The card is retired (§UC-PI-005); the landing IS the current open round, and its
    // share affordance is the `.cartbar` icon, whose accessible name §UC-PI-011 fixes
    // to the same „Zdieľať s kolegami" the card's button carried.
    //
    // ⚠ THE „only for open cycles" HALF MOVED RATHER THAN DIED, and it had to: this
    // suite's database carries ~135 open rounds, so locking ONE cycle does not make
    // the landing closed — the resolver simply picks the next newest open one, and a
    // `toHaveCount(0)` here would be measuring the wrong round. The absence is pinned
    // in `portal-landing.spec.js` („no share affordance when the round is not open"),
    // against a STUBBED cycles payload where „no open round" is an actual state.
    const host = await makeHost('uiportal')

    // Created last ⇒ the newest open round ⇒ the landing's round (lib/portal-state.js).
    const name = `E2E GSO Landing ${uniq}`
    const res = await admin('/api/cycles', { method: 'post', data: { name, type: 'coffee', status: 'open' } })
    expect(res.status()).toBe(201)
    const cycle = await res.json()

    await signInAsHost(page, host)
    await page.goto('/')
    await expectLanding(page)

    const share = page.locator('.app .cartbar').getByRole('button', { name: 'Zdieľať s kolegami' })
    await expect(share, 'the open round offers the cartbar share icon').toHaveCount(1)

    // …and it must not navigate. (The card's `@click.stop` claim, restated on the
    // control that replaced it: the bar submits and cancels orders, so a share tap
    // leaving `/` would be the same defect one layer down.)
    await share.click()
    await expect(page).toHaveURL(/\/$/)

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog, 'the dialog names the round it shares').toContainText(name)
    await dialog.getByRole('button', { name: 'Vytvoriť odkaz' }).click()

    // RD-KG-2, authorized by 05 §UC-KG-007 item 1 — see the note above.
    const value = (await dialog.getByTestId('guest-link-url').textContent()).trim()
    expect(value).toMatch(/\/g\/[A-Z2-9]{12,}$/)
    // SANCTIONED RETARGET (GL-T6b, 19 §UC-GL-008 — the standing section adds a second copy button; scoped to the per-cycle section)
    await expect(dialog.getByTestId('per-cycle-link').getByRole('button', { name: 'Kopírovať' })).toBeVisible()

    const fromApi = await (await ctx.get(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })).json()
    expect(value.endsWith(`/g/${fromApi.link.token}`)).toBe(true)
  })

  test('a slow load for one cycle cannot overwrite the link shown for another', async ({ page }) => {
    // ONE dialog serves every entry point, so an in-flight GET for a previously
    // opened cycle must never land on top of the cycle currently on screen: the host
    // would copy the wrong /g/:token (colleagues order into the wrong cycle) and the
    // deactivate/regenerate buttons would hit the wrong row.
    //
    // ⚠ PI-T3 · §UC-PI-019 item 12 — RETARGETED. Two cycle cards side by side is not
    // a state that exists any more: the landing resolves exactly ONE round. So the
    // two openings are the landing's cartbar icon (round A, the newest open) and the
    // DEEP LINK's Kolegovia card (round B) — two entry points, still one dialog.
    //
    // ⚠ AND THE HOP BETWEEN THEM IS `goBack()`, NOT A SECOND `page.goto`. The race is
    // about a response outliving a dialog WITHIN one document; a fresh document load
    // aborts the held request and the test would pass vacuously. Loading `/cycle/B`
    // cold bounces to `/` (shipped behaviour — `helpers/portal.js gotoCycle`), which
    // leaves `/cycle/B` one same-document history entry away.
    const host = await makeHost('race')

    const cycleBName = `E2E GSO Race B ${uniq}`
    const cycleB = await (await admin('/api/cycles', {
      method: 'post', data: { name: cycleBName, type: 'coffee', status: 'open' },
    })).json()
    // A is created LAST, so A is the landing's round.
    const cycleAName = `E2E GSO Race A ${uniq}`
    const cycleA = await (await admin('/api/cycles', {
      method: 'post', data: { name: cycleAName, type: 'coffee', status: 'open' },
    })).json()

    const linkA = (await (await ctx.post(`/api/guest-links/cycle/${cycleA.id}`, { headers: host.auth })).json()).link
    const linkB = (await (await ctx.post(`/api/guest-links/cycle/${cycleB.id}`, { headers: host.auth })).json()).link
    expect(linkA.token).not.toBe(linkB.token)

    await signInAsHost(page, host)

    // Hold cycle A's GET open so its response lands only after the dialog has been
    // reopened for cycle B.
    await page.route(`**/api/guest-links/cycle/${cycleA.id}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await route.continue()
    })

    await page.goto(`/cycle/${cycleB.id}`)
    await expectLanding(page)

    const staleLoad = page.waitForResponse((r) =>
      r.url().includes(`/api/guest-links/cycle/${cycleA.id}`) && r.request().method() === 'GET')
    await page.locator('.app .cartbar').getByRole('button', { name: 'Zdieľať s kolegami' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/cycle/${cycleB.id}$`))
    await page.getByTestId('main-tab-guests').click()
    await page.getByRole('button', { name: /Zdieľať/ }).click()

    const dialog = page.getByRole('dialog')
    const urlField = dialog.getByTestId('guest-link-url')
    // RD-KG-2, authorized by 05 §UC-KG-007 item 1 — see the note in the first UI
    // test: `toHaveValue` has no meaning on NeoCopyRow's `.val` <div>, and the
    // same anchored regex is applied to its text instead. The race this test
    // exists for is unchanged.
    await expect(urlField).toHaveText(new RegExp(`/g/${linkB.token}$`))

    // Let cycle A's stale response land — it must not replace what is on screen.
    await staleLoad
    await expect(urlField, 'a stale response must not swap in another cycle\'s link').toHaveText(new RegExp(`/g/${linkB.token}$`))
    expect((await urlField.textContent()).trim()).not.toContain(linkA.token)

    // And the buttons in this dialog still act on cycle B: deactivating here
    // must leave cycle A's link untouched.
    await dialog.getByRole('button', { name: 'Deaktivovať odkaz' }).click()
    await expect(dialog).toContainText('Odkaz je deaktivovaný')
    const afterA = await (await ctx.get(`/api/guest-links/cycle/${cycleA.id}`, { headers: host.auth })).json()
    const afterB = await (await ctx.get(`/api/guest-links/cycle/${cycleB.id}`, { headers: host.auth })).json()
    expect(afterA.link.active, 'cycle A must stay active').toBe(1)
    expect(afterB.link.active, 'cycle B is the one deactivated').toBe(0)

    // With several open rounds in the database, the dialog must say which one it is
    // sharing — an unlabelled URL is impossible to verify.
    await expect(dialog, 'the dialog names the cycle it is sharing').toContainText(cycleBName)
  })
})
