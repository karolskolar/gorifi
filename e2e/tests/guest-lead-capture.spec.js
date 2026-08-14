import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD } from '../fixtures.js'

// GSO-T10: lead capture (§UC-GSO-015, §Lead Capture, Decision 7).
//
// Every guest is a contactable lead — phone is mandatory at checkout — so both
// guest screens carry a low-key "ask for your own account" CTA that creates a row
// in the EXISTING `invitations` table, attributed to the HOST and tagged with its
// source so the admin can tell where the lead came from.
//
// The endpoint is `POST /api/guest/:token/orders/:orderToken/invite-request`: the
// same PAIR of tokens that guards the status page, so the host's referral
// `invite_code` never has to be published into a guest payload (the alternative
// would have been reusing the public `POST /api/invitations/register`, which keys
// on that code). Everything here is therefore anonymous — `ctx` carries no auth
// headers — which is exactly why the spec hammers on bounds, mass assignment and
// the duplicate-phone path.
//
// The three properties that make or break the feature:
//   - ATTRIBUTION: `invited_by_friend_id` is the host of the link, taken from the
//     link, never from the body. A lead credited to nobody (or to whoever the
//     caller names) is the whole feature failing silently.
//   - the SOURCE TAG: set server-side, rendered in the admin's invitations list.
//   - a duplicate pending phone is a **clean 409, never a 500** — it is guarded by
//     a partial unique index (`idx_invitations_phone_pending`) as well as by an app
//     check, and the app check alone loses the race.
//
// Deliberate asymmetry (mirrors GSO-T4's read/write split): a LOCKED cycle and a
// CANCELLED sub-order both still accept the request — that is precisely when a
// guest asks for an account — while a dead link or a deactivated host 410s,
// because the invitation would be attributed to a host who can no longer log in.
//
// NOTE ON RATE LIMITS: these endpoints sit behind the shared `abuseLimiter`.
// Run the full suite with a generous budget — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// Pending phones are globally unique (partial unique index), so every test needs
// its own number — and it must not collide with a leftover from an earlier run
// against a long-lived target either. 12 digits: '09' + a per-run seed + counter.
const phoneSeed = String(Date.now()).slice(-8)
let phoneSeq = 0
function uniquePhone() {
  return `09${phoneSeed}${String(++phoneSeq).padStart(2, '0')}`
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// A friend with a real per-friend Bearer session — the host identity the
// guest-link endpoints require. Mirrors guest-status.spec.js.
let hostSeq = 0
async function makeHost(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffix = `_${uniq}${++hostSeq}`
  const username = `gso10_${slug}`.slice(0, 30 - suffix.length) + suffix
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
  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeCycle(label) {
  const name = `E2E GSO10 ${label} ${uniq}`
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

async function setLinkActive(host, linkId, active) {
  const res = await ctx.patch(`/api/guest-links/${linkId}`, { headers: host.auth, data: { active } })
  expect(res.status(), 'link active toggle').toBe(200)
}

// Submit a sub-order through the GSO-T3 endpoint — the only way one is created.
async function submitGuest(linkToken, items, identity) {
  const res = await ctx.post(`/api/guest/${linkToken}/orders`, { data: { ...identity, items } })
  expect(res.status(), 'guest submit').toBe(201)
  return res.json()
}

function invitePath(linkToken, orderToken) {
  return `/api/guest/${linkToken}/orders/${orderToken}/invite-request`
}

async function askForAccount(linkToken, orderToken, data) {
  return ctx.post(invitePath(linkToken, orderToken), { data })
}

async function getStatus(linkToken, orderToken) {
  const res = await ctx.get(`/api/guest/${linkToken}/orders/${orderToken}`)
  expect(res.status(), 'status GET').toBe(200)
  return res.json()
}

// The admin's own view of the invitations — the only way to READ back what the
// anonymous endpoint wrote, which is what makes the mass-assignment checks real.
async function invitationsFor(phone, status) {
  const res = await admin(`/api/invitations${status ? `?status=${status}` : ''}`)
  expect(res.status(), 'admin invitations list').toBe(200)
  return (await res.json()).filter((inv) => inv.phone === phone)
}

async function oneInvitationFor(phone, status) {
  const rows = await invitationsFor(phone, status)
  expect(rows, `exactly one invitation for ${phone}`).toHaveLength(1)
  return rows[0]
}

// One host + open coffee cycle + product + link + a submitted sub-order: the state
// a guest is in when the CTA is on screen.
async function scenario(label, { identity } = {}) {
  const host = await makeHost(label)
  const cycle = await makeCycle(label)
  const product = await addProduct(cycle.id, {
    name: `GSO10 ${label} ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
  })
  const link = await shareLink(host, cycle.id)
  const guestPhone = identity?.guest_phone || uniquePhone()
  const created = await submitGuest(link.token, [{ product_id: product.id, variant: '250g', quantity: 1 }], {
    guest_name: `Marek ${label}`, guest_phone: guestPhone, ...identity,
  })
  return { host, cycle, product, link, order: created.order, guestPhone }
}

test.beforeAll(async ({ playwright }) => {
  ctx = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

test.describe('Lead capture API — POST /api/guest/:token/orders/:orderToken/invite-request', () => {
  test('creates a PENDING invitation attributed to the HOST, tagged as a guest order, with the contact carried over', async () => {
    const { host, link, order, guestPhone } = await scenario('happy')

    const res = await askForAccount(link.token, order.order_token, {
      name: 'Marek Hostovic',
      phone: guestPhone,
      email: 'marek@example.com',
    })
    expect(res.status(), 'invite request accepted').toBe(201)
    expect((await res.json()).success).toBe(true)

    const inv = await oneInvitationFor(guestPhone, 'pending')
    // ATTRIBUTION — the host of the link, and nobody else. This is the assertion
    // the whole task exists for.
    expect(inv.invited_by_friend_id, 'credited to the host of the link').toBe(host.id)
    expect(inv.inviter_name).toBe(host.name)
    // The SOURCE TAG, set server-side.
    expect(inv.source, 'guest-order source tag').toBe('guest_order')
    // Contact carried over, status is the pending queue the admin already works.
    expect(inv.status).toBe('pending')
    expect(inv.name).toBe('Marek Hostovic')
    expect(inv.phone).toBe(guestPhone)
    expect(inv.email).toBe('marek@example.com')
    expect(inv.admin_note ?? null).toBeNull()
    expect(inv.processed_at ?? null).toBeNull()
  })

  test('the e-mail is optional, exactly as it is at checkout', async () => {
    const { link, order, guestPhone } = await scenario('noemail')

    const res = await askForAccount(link.token, order.order_token, { name: 'Bez Mailu', phone: guestPhone })
    expect(res.status()).toBe(201)

    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.email ?? null, 'no e-mail stored, not an empty string').toBeNull()
  })

  test('a SECOND request for the same phone is a clean 409 — the partial unique index must never surface as a 500', async () => {
    const { link, order, guestPhone } = await scenario('dupe')

    expect((await askForAccount(link.token, order.order_token, { name: 'Prvy Krat', phone: guestPhone })).status()).toBe(201)

    const again = await askForAccount(link.token, order.order_token, { name: 'Druhy Krat', phone: guestPhone })
    expect(again.status(), 'a duplicate pending phone is a conflict, not a crash').toBe(409)
    const body = await again.json()
    expect(body.error, 'a Slovak explanation, not a stack trace').toBeTruthy()
    expect(JSON.stringify(body), 'no SQLite internals leaked').not.toMatch(/UNIQUE|SQLITE|constraint/i)
    expect(body.reason).toBe('exists')

    // And the first row is untouched — a rejected retry must not overwrite it.
    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.name).toBe('Prvy Krat')
  })

  test('a duplicate phone across DIFFERENT links and hosts is still one clean 409', async () => {
    const first = await scenario('crossa')
    const second = await scenario('crossb')

    expect((await askForAccount(first.link.token, first.order.order_token, {
      name: 'Jeden Clovek', phone: first.guestPhone,
    })).status()).toBe(201)

    // The same person ordered through a second host's link too (same phone).
    const res = await askForAccount(second.link.token, second.order.order_token, {
      name: 'Jeden Clovek', phone: first.guestPhone,
    })
    expect(res.status()).toBe(409)
    expect((await res.json()).reason).toBe('exists')

    const rows = await invitationsFor(first.guestPhone)
    expect(rows, 'still exactly one lead for that phone').toHaveLength(1)
    expect(rows[0].invited_by_friend_id, 'credited to the FIRST host').toBe(first.host.id)
  })

  test('the guest cannot set the status, the attribution, the source tag or the admin note', async () => {
    const { host, link, order, guestPhone } = await scenario('massassign')
    const stranger = await makeHost('stranger')

    const res = await askForAccount(link.token, order.order_token, {
      name: 'Utocnik Hostovic',
      phone: guestPhone,
      email: 'utocnik@example.com',
      // Everything a mass assignment would love to reach:
      status: 'processed',
      invited_by_friend_id: stranger.id,
      source: 'onboarding_link',
      admin_note: 'schvalene, urobte ma priatelom',
      invite_code: 'HACKED1',
      processed_at: '2020-01-01 00:00:00',
      id: 999999,
    })
    expect(res.status()).toBe(201)

    // Re-read through the ADMIN api — the guest's own response could lie by omission.
    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.status, 'still in the pending queue').toBe('pending')
    expect(inv.invited_by_friend_id, 'still the host of the link').toBe(host.id)
    expect(inv.invited_by_friend_id).not.toBe(stranger.id)
    expect(inv.source, 'the source tag is server-owned').toBe('guest_order')
    expect(inv.admin_note ?? null, 'the admin note is the admin\'s').toBeNull()
    expect(inv.processed_at ?? null).toBeNull()
    expect(inv.invite_code, 'the referral code comes from the host row, not the body').not.toBe('HACKED1')
    expect(inv.id).not.toBe(999999)
  })

  test('identity validation and bounds reject with a 400 and write nothing', async () => {
    const { link, order } = await scenario('bounds')
    const good = uniquePhone()

    const cases = [
      ['no body at all', {}, 'name'],
      ['a blank name', { name: '   ', phone: good }, 'name'],
      ['a name past the 120-char bound', { name: 'A'.repeat(121), phone: good }, 'name'],
      ['a name that is not text', { name: { toString: 1 }, phone: good }, 'name'],
      ['no phone', { name: 'Bez Telefonu' }, 'phone'],
      ['a phone with 8 digits', { name: 'Kratky Telefon', phone: '12345678' }, 'phone'],
      ['a phone past the 32-char bound', { name: 'Dlhy Telefon', phone: '9'.repeat(33) }, 'phone'],
      ['a phone that is not text', { name: 'Objekt', phone: { toString: 1 } }, 'phone'],
      ['an e-mail past the 160-char bound', { name: 'Dlhy Mail', phone: good, email: `${'e'.repeat(160)}@x.sk` }, 'email'],
      ['an e-mail that is not text', { name: 'Objekt Mail', phone: good, email: { toString: 1 } }, 'email'],
    ]

    for (const [label, data, field] of cases) {
      const res = await askForAccount(link.token, order.order_token, data)
      expect(res.status(), `${label} → 400 (and never a 500)`).toBe(400)
      const body = await res.json()
      expect(body.error, `${label} → a Slovak message`).toBeTruthy()
      expect(body.field, `${label} → names the field`).toBe(field)
    }

    // Nothing was persisted by any of them.
    expect(await invitationsFor(good), 'no lead created by an invalid request').toHaveLength(0)
  })

  test('an unknown link token, a foreign link token and an unknown order token all 404 with the same message', async () => {
    const mine = await scenario('resolve')
    const other = await scenario('resolveother')

    const unknownLink = await askForAccount('THISLINKDOESNOTEXIST', mine.order.order_token, {
      name: 'Nikto', phone: uniquePhone(),
    })
    expect(unknownLink.status()).toBe(404)
    const unknownLinkBody = await unknownLink.json()

    const unknownOrder = await askForAccount(mine.link.token, 'THISORDERDOESNOTEXIST', {
      name: 'Nikto', phone: uniquePhone(),
    })
    expect(unknownOrder.status()).toBe(404)

    // A REAL order token under somebody else's link token: the pair is the
    // credential, not either half — and the message must not become an oracle for
    // "this order token exists somewhere".
    const crossPhone = uniquePhone()
    const crossed = await askForAccount(other.link.token, mine.order.order_token, {
      name: 'Cudzi', phone: crossPhone,
    })
    expect(crossed.status(), 'a foreign link token does not resolve the order').toBe(404)
    expect((await crossed.json()).error).toBe(unknownLinkBody.error)

    expect(await invitationsFor(crossPhone), 'no lead created for a cross-link attempt').toHaveLength(0)
  })

  test('a deactivated link and a deactivated host both 410 — the lead would be credited to a closed door', async () => {
    const dead = await scenario('deadlink')
    await setLinkActive(dead.host, dead.link.id, false)

    const deadPhone = uniquePhone()
    const res = await askForAccount(dead.link.token, dead.order.order_token, { name: 'Mrtvy Odkaz', phone: deadPhone })
    expect(res.status(), 'deactivated link').toBe(410)
    expect((await res.json()).reason).toBe('inactive')
    expect(await invitationsFor(deadPhone)).toHaveLength(0)

    const gone = await scenario('deadhost')
    expect((await admin(`/api/friends/${gone.host.id}`, { method: 'patch', data: { active: false } })).status()).toBe(200)

    const gonePhone = uniquePhone()
    const hostRes = await askForAccount(gone.link.token, gone.order.order_token, { name: 'Mrtvy Host', phone: gonePhone })
    expect(hostRes.status(), 'deactivated host').toBe(410)
    expect((await hostRes.json()).reason).toBe('inactive')
    expect(await invitationsFor(gonePhone)).toHaveLength(0)
  })

  test('a LOCKED cycle still accepts the request — that is exactly when a guest asks for an account', async () => {
    const { host, cycle, link, order, guestPhone } = await scenario('locked')
    await setCycleStatus(cycle.id, 'locked')

    // The write half of the ordering surface is shut...
    expect((await ctx.put(`/api/guest/${link.token}/orders/${order.order_token}`, {
      data: { items: [] },
    })).status(), 'edits end at the lock (GSO-T4)').toBe(409)

    // ...but the lead capture is not: the coffee has just arrived.
    const res = await askForAccount(link.token, order.order_token, { name: 'Po Uzavreti', phone: guestPhone })
    expect(res.status(), 'the CTA survives the lock').toBe(201)
    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.invited_by_friend_id).toBe(host.id)
    expect(inv.source).toBe('guest_order')
  })

  test('a CANCELLED sub-order still accepts the request — a cancelled order is still a lead', async () => {
    const { host, link, order, guestPhone } = await scenario('cancelled')
    expect((await ctx.put(`/api/guest/${link.token}/orders/${order.order_token}`, {
      data: { items: [] },
    })).status(), 'explicit empty cart cancels').toBe(200)

    const res = await askForAccount(link.token, order.order_token, { name: 'Zruseny Ale Lead', phone: guestPhone })
    expect(res.status()).toBe(201)
    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.invited_by_friend_id).toBe(host.id)
  })

  test('a processed lead frees the phone again — the guard is on PENDING rows only', async () => {
    const { link, order, guestPhone } = await scenario('reopen')
    expect((await askForAccount(link.token, order.order_token, { name: 'Prvy Pokus', phone: guestPhone })).status()).toBe(201)

    const first = await oneInvitationFor(guestPhone, 'pending')
    expect((await admin(`/api/invitations/${first.id}`, { method: 'patch', data: { status: 'rejected' } })).status()).toBe(200)

    // The admin rejected it; the guest may ask again (and the index allows it).
    const res = await askForAccount(link.token, order.order_token, { name: 'Druhy Pokus', phone: guestPhone })
    expect(res.status(), 'a rejected lead does not block the phone forever').toBe(201)
    const pending = await oneInvitationFor(guestPhone, 'pending')
    expect(pending.name).toBe('Druhy Pokus')
    expect(pending.source).toBe('guest_order')
  })

  test('the endpoint is anonymous BY DESIGN and its response carries nothing privileged', async () => {
    const { link, order, guestPhone } = await scenario('anon')

    // No Authorization, no X-Admin-Token, no X-Friends-Password — `ctx` has none.
    const res = await askForAccount(link.token, order.order_token, { name: 'Anonym Lead', phone: guestPhone })
    expect(res.status(), 'reachable with no credential but the token pair').toBe(201)

    const raw = await res.text()
    expect(Object.keys(JSON.parse(raw)).sort(), 'a bare acknowledgement').toEqual(['success'])
    // The host's referral code, the guest's order token, ids, contact rows: none of
    // it belongs in the answer to an unauthenticated write.
    expect(raw).not.toMatch(/invite_code|order_token|access_token|password|invited_by/i)
  })

  test('the status payload advertises the CTA and remembers that it was used', async () => {
    const { host, link, order, guestPhone } = await scenario('payload')

    const before = await getStatus(link.token, order.order_token)
    expect(before.invite_request, 'the backend owns whether the CTA is offered').toBeTruthy()
    expect(before.invite_request.available).toBe(true)
    expect(before.invite_request.requested, 'no lead yet').toBe(false)

    expect((await askForAccount(link.token, order.order_token, { name: 'Uz Poziadal', phone: guestPhone })).status()).toBe(201)

    const after = await getStatus(link.token, order.order_token)
    expect(after.invite_request.requested, 'the page must not invite a pointless second submission').toBe(true)

    // A dead link withdraws the CTA rather than offering an action the server 410s.
    await setLinkActive(host, link.id, false)
    const dead = await getStatus(link.token, order.order_token)
    expect(dead.invite_request.available, 'no affordance the backend would refuse').toBe(false)
  })
})

async function loginAsAdminUI(page) {
  await page.goto('/admin')
  await page.locator('#password').fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /Prihlásiť sa/ }).click()
  await expect(page).toHaveURL(/\/admin\/dashboard/)
  // ⚠ There is exactly ONE admin token app-wide (`admin.js` keeps it in a single
  // `settings` row), so this UI login invalidates the one `beforeAll` minted. The
  // retargeted test below reads back through `admin()` AFTER logging in here, so the
  // browser's token has to be adopted or those reads 401.
  adminToken = await page.evaluate(() => localStorage.getItem('adminToken'))
  expect(adminToken, 'the UI login stored an admin token').toBeTruthy()
}

test.describe('Lead capture UI', () => {
  test('the confirmation screen offers the CTA, prefilled from the checkout, and confirms the request', async ({ page }) => {
    const host = await makeHost('uiconf')
    const cycle = await makeCycle('uiconf')
    const product = await addProduct(cycle.id, {
      name: `GSO10 uiconf ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30,
    })
    const link = await shareLink(host, cycle.id)
    const phone = uniquePhone()

    // Genuinely public: no login, no stubs.
    await page.goto(`/g/${link.token}`)
    await page.getByTestId(`product-${product.id}`).getByTestId('inc-250g').click()
    await page.getByTestId('open-checkout').click()
    await page.getByTestId('guest-name').fill('Marek Konfirmacia')
    await page.getByTestId('guest-phone').fill(phone)
    await page.getByTestId('guest-email').fill('marek.ui@example.com')
    await page.getByTestId('guest-submit').click()

    await expect(page.getByTestId('guest-confirmation')).toBeVisible()
    // The payment modal opens over the confirmation (§UC-GSO-003); the CTA must not
    // compete with it, so close it first.
    const modal = page.getByRole('dialog')
    if (await modal.count()) await modal.getByRole('button', { name: 'Zavrieť' }).click()

    const cta = page.getByTestId('invite-cta')
    await expect(cta, 'the low-key lead-capture CTA').toBeVisible()
    // ⚠ SANCTIONED SPEC UPDATE (06 §UC-GX-011 item 1, resolved conflict #2), the
    // only edit RD-GX-4 spends. The fold line moved from the shipped "Chcete si
    // nabudúce objednať sami?" to the prototype's "Chcete si objednať sami?" — the
    // word "nabudúce" now lives only in the unfolded body, which this assertion is
    // made before opening. Both wordings satisfy the CLAUDE.md GSO-T10 register pin
    // (vy-form, no reader-gendered participle); that pin is what this line exists to
    // protect, and the new regex still protects it.
    await expect(cta).toContainText(/objednať sami/i)

    await page.getByTestId('invite-cta-open').click()
    // Prefilled from the sub-order the guest just created — name/phone/email carried over.
    await expect(page.getByTestId('invite-name')).toHaveValue('Marek Konfirmacia')
    await expect(page.getByTestId('invite-phone')).toHaveValue(phone)
    await expect(page.getByTestId('invite-email')).toHaveValue('marek.ui@example.com')

    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-done'), 'clear success feedback').toBeVisible()
    // The form is gone: no pointless second submission on offer.
    await expect(page.getByTestId('invite-submit')).toHaveCount(0)

    const inv = await oneInvitationFor(phone, 'pending')
    expect(inv.invited_by_friend_id).toBe(host.id)
    expect(inv.source).toBe('guest_order')
    expect(inv.name).toBe('Marek Konfirmacia')
    expect(inv.email).toBe('marek.ui@example.com')
  })

  test('the status screen offers the same CTA, and shows the already-requested state instead of a form', async ({ page }) => {
    const { host, link, order, guestPhone } = await scenario('uistatus')

    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await expect(page.getByTestId('guest-status')).toBeVisible()

    const cta = page.getByTestId('invite-cta')
    await expect(cta).toBeVisible()
    await page.getByTestId('invite-cta-open').click()
    await expect(page.getByTestId('invite-name')).toHaveValue('Marek uistatus')
    await expect(page.getByTestId('invite-phone')).toHaveValue(guestPhone)
    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-done')).toBeVisible()

    const inv = await oneInvitationFor(guestPhone, 'pending')
    expect(inv.invited_by_friend_id).toBe(host.id)

    // Coming back later: the server says the lead is already pending, so the page
    // states that instead of offering a submission that would 409.
    await page.reload()
    await expect(page.getByTestId('guest-status')).toBeVisible()
    await expect(page.getByTestId('invite-requested')).toBeVisible()
    await expect(page.getByTestId('invite-cta-open')).toHaveCount(0)
  })

  test('a cancelled sub-order still offers the CTA — the guest is a lead either way', async ({ page }) => {
    const { link, order, guestPhone } = await scenario('uicancel')
    expect((await ctx.put(`/api/guest/${link.token}/orders/${order.order_token}`, {
      data: { items: [] },
    })).status()).toBe(200)

    await page.goto(`/g/${link.token}/o/${order.order_token}`)
    await expect(page.getByTestId('status-cancelled')).toBeVisible()
    await expect(page.getByTestId('invite-cta')).toBeVisible()

    await page.getByTestId('invite-cta-open').click()
    await page.getByTestId('invite-submit').click()
    await expect(page.getByTestId('invite-done')).toBeVisible()
    expect((await oneInvitationFor(guestPhone, 'pending')).source).toBe('guest_order')
  })

  test('the admin invitations list tags the guest-order lead, and approving it in the dialog stamps the provenance onto the friend', async ({ page }) => {
    // ⚠ RETARGETED — 07 §UC-IA-008 item 2. This test used to pin the `?create=1`
    // navigation-prefill flow ("Vytvoriť" → router.push('/admin/friends?name=…') →
    // the AdminFriends modal reading query params). 07 resolved conflict #1 RETIRES
    // that flow: "Vytvoriť" now opens the approval dialog in place, so the old
    // `toHaveURL(/\/admin\/friends/)` + three `getByPlaceholder` assertions describe
    // markup that no longer exists.
    //
    // The property being protected is unchanged and is in fact STRONGER: it was
    // "a guest-sourced lead can be turned into a friend, carrying its details" —
    // now proved by actually completing the conversion rather than by inspecting a
    // prefilled form that a human still had to submit. It is additionally UPGRADED to
    // assert `friends.onboarding_source === 'guest_order'` (07 §UC-IA-005), which is
    // the GSO-T10 follow-up: before this, provenance died with the invitation row the
    // admin later deletes.
    const { host, link, order, guestPhone } = await scenario('uiadmin')
    expect((await askForAccount(link.token, order.order_token, {
      name: `Lead Admin ${uniq}`, phone: guestPhone, email: 'lead.admin@example.com',
    })).status()).toBe(201)

    await loginAsAdminUI(page)
    await page.goto('/admin/invitations')

    const row = page.locator('tr', { hasText: guestPhone })
    await expect(row).toBeVisible()
    await expect(row, 'the inviting host is named').toContainText(host.name)
    await expect(row.getByTestId('invitation-source-guest'), 'the source tag').toBeVisible()
    await expect(row.getByTestId('invitation-source-guest')).toContainText(/hosťovskú objednávku/i)

    // "Vytvoriť" opens the approval dialog IN PLACE — no navigation at any point.
    await row.getByRole('button', { name: 'Vytvoriť' }).click()
    const dialog = page.getByTestId('approve-dialog')
    await expect(dialog).toBeVisible()
    await expect(page, 'the retired flow navigated away; this one does not').toHaveURL(/\/admin\/invitations$/)

    // The lead's details are what the admin approves against — the same three fields
    // the retired prefill carried, now read-only context rather than an editable form.
    const summary = dialog.getByTestId('approve-summary')
    await expect(summary).toContainText(`Lead Admin ${uniq}`)
    await expect(summary).toContainText(guestPhone)
    await expect(summary).toContainText('lead.admin@example.com')
    await expect(dialog.getByTestId('approve-source-guest'), 'the guest badge follows into the dialog').toBeVisible()

    // The CTA has no username field, so the dialog suggests one from the name.
    const username = `lead.admin.${uniq}`.slice(0, 30)
    await dialog.getByTestId('approve-username').fill(username)
    await dialog.getByTestId('approve-submit').click()
    await expect(dialog.getByTestId('approve-credentials')).toBeVisible()
    await expect(dialog.getByTestId('approve-cred-username')).toHaveText(username)

    // THE UPGRADE (the GSO-T10 provenance follow-up this module closes): the created
    // friend is permanently tagged as having arrived through a guest order. The
    // friends list is admin-readable, so this survives deleting the invitation row.
    const friends = await (await admin('/api/friends')).json()
    const created = friends.find((f) => f.username === username)
    expect(created, 'the approval really created the friend').toBeTruthy()
    expect(created.onboarding_source, 'provenance outlives the invitation row').toBe('guest_order')
    expect(created.name).toBe(`Lead Admin ${uniq}`)
    expect(created.phone).toBe(guestPhone)
    expect(created.email).toBe('lead.admin@example.com')
    expect(created.must_change_password, 'a temp password always forces a rotation').toBe(1)

    // The invitation is back-linked and out of the pending queue, behind the dialog
    // that still holds the only copy of the plaintext password.
    const inv = await oneInvitationFor(guestPhone, 'processed')
    expect(inv.created_friend_id).toBe(created.id)
    await expect(dialog, 'still open — it is the only holder of the temp password').toBeVisible()
  })
})
