import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD } from '../fixtures.js'

// IA-T3 / 07 §UC-IA-005 — `POST /api/invitations/:id/approve`, the API half.
// (The dialog that drives it is IA-T4's; §UC-IA-008 item 5 splits this file that way.)
//
// This is a CREDENTIAL path: one admin call mints a login that did not exist before,
// and the plaintext temp password exists in exactly one HTTP response and nowhere else
// — never persisted, never logged, never returned by any other endpoint. So the
// assertions here are not "a friend appeared":
//
//   1. The credentials REALLY WORK — every happy path ends in `POST /api/friends/auth`
//      with the returned username + tempPassword, because a friend row whose
//      `password_hash` does not match the string handed to the admin is worse than a
//      failed approval: it looks like success and locks the person out. A deliberately
//      wrong password is checked to 401 in the same test, so a server that accepted
//      anything could not pass.
//   2. The THREE DELIBERATE NON-WRITES are asserted as ZERO rows, not as "unchanged":
//      no `friend_subscriptions` row (an invited friend starts UNFILTERED — this
//      diverges from onboarding's bakery auto-subscribe, so one test creates a friend
//      through onboarding in the same run and shows `['bakery']`, which is what makes
//      the empty array here evidence rather than a field that is always empty), no
//      session mint, and no `transactions` row (creation is not a financial event —
//      the GSO-T6 lesson; a stray row would corrupt a real balance).
//   3. Every FAILURE is NON-DESTRUCTIVE and RETRYABLE: after a 400/409 the invitation
//      is still `pending`, no friend was created, and the very next call with a fixed
//      username succeeds. That is the dialog's whole error UX (§UC-IA-006 "inline 409,
//      field stays editable") and the transaction is the mechanism.
//
// ⚠ FIXTURES ARE PER TEST (§UC-IA-008 item 5): Playwright restarts the worker after a
// failure and re-runs `beforeAll`, so accumulated shared state makes the next run's
// numbers different from this one's (the GSO-T8 lesson). `beforeAll` here does nothing
// but log the admin in; every invitation, friend and cycle is built inside its test.
//
// Rate limits: friend logins sit on `authLimiter` and `/invitations/register` on
// `abuseLimiter`. Run with a generous budget for both — see e2e/README.md.

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// The 32-char unambiguous CODE_ALPHABET (schema.js) — `generateTempPassword()` is
// `randomCode(12)` over it, `generateUid()` is `randomCode(8)`.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TEMP_PASSWORD_RE = new RegExp(`^[${CODE_CHARS}]{12}$`)
const UID_RE = new RegExp(`^[${CODE_CHARS}]{8}$`)

// A pending phone is globally unique (`idx_invitations_phone_pending`) and the tests
// that end in a 400/409 leave their invitation pending, so a shared number would fail
// a later test for a reason that is not under test. Per-run seed + counter.
const phoneSeed = String(Date.now()).slice(-8)
let phoneSeq = 0
function uniquePhone() {
  return `09${phoneSeed}${String(++phoneSeq).padStart(2, '0')}`
}

let nameSeq = 0
function uniqueUsername(label) {
  const suffix = `_${uniq}${++nameSeq}`
  return `${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data ? { data: opts.data } : {}),
  })
}

// ── DB_PATH: strictly-extra assertions only ──────────────────────────────────
// Everything that CAN be seen through the API is asserted through the API so the
// coverage is not env-gated: `hasCredentials` proves `password_hash` is set,
// `subscriptions` proves the `friend_subscriptions` non-write, and
// `GET /api/friends/:id/detail` proves the `transactions` non-write. These direct
// reads add only what no route exposes: that the stored hash is a bcrypt digest and
// not the plaintext, that no `friend_sessions` row exists, and GLOBAL row counts
// (which catch a row written with a NULL/foreign `friend_id`).
const DB_PATH = process.env.DB_PATH || ''

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

function countAll(table) {
  return withDb((db) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n))
}

// ── Fixture builders ─────────────────────────────────────────────────────────

// A friend with a real per-friend Bearer session — needed to read an invite code,
// because `friends.js` strips `invite_code` from every friend response and
// `GET /invitations/my-code` is the only route to a valid one. Idiom copied from
// invite-register-shell.spec.js / guest-lead-capture.spec.js.
async function makeFriendWithSession(label) {
  const username = uniqueUsername(label)
  const name = `E2E ${label} ${uniq}`
  const created = await admin('/api/friends', { method: 'post', data: { name } })
  expect(created.status(), 'friend create').toBe(201)
  const friend = await created.json()

  expect((await admin(`/api/friends/${friend.id}/admin-username`, { method: 'put', data: { username } })).status()).toBe(200)
  expect((await admin(`/api/friends/${friend.id}/reset-password`, { method: 'put', data: { password: 'initPass1' } })).status()).toBe(200)

  const login = await ctx.post('/api/friends/auth', { data: { username, password: 'initPass1' } })
  expect(login.status(), 'friend login').toBe(200)
  const first = (await login.json()).token
  const chg = await ctx.put(`/api/friends/${friend.id}/change-password`, {
    headers: { Authorization: `Bearer ${first}` },
    data: { currentPassword: 'initPass1', newPassword: 'ownPass1' },
  })
  expect(chg.status(), 'forced change').toBe(200)
  const token = (await chg.json()).token || first

  return { id: friend.id, name, username, token, auth: { Authorization: `Bearer ${token}` } }
}

// An inviter + their invite code. Per test, so a worker restart cannot reuse one.
async function makeInviter(label) {
  const inviter = await makeFriendWithSession(label)
  const res = await ctx.get('/api/invitations/my-code', { headers: inviter.auth })
  expect(res.status(), 'my-code').toBe(200)
  const { inviteCode } = await res.json()
  expect(inviteCode, 'invite code').toBeTruthy()
  return { ...inviter, inviteCode }
}

async function invitationById(id) {
  const res = await admin('/api/invitations')
  expect(res.status(), 'admin invitations list').toBe(200)
  return (await res.json()).find((row) => row.id === id) || null
}

// Register a pending invitation through the ONLY public writer and read its row back
// (`GET /api/invitations` is `SELECT i.*`, so `username` and `created_friend_id`
// surface with no route change — the GSO-T10 `source` precedent).
async function registerInvitation(inviter, { name, username, email } = {}) {
  const phone = uniquePhone()
  const applicant = name || `Ján Kováč ${uniq}${nameSeq}`
  const res = await ctx.post('/api/invitations/register', {
    data: {
      invite_code: inviter.inviteCode,
      name: applicant,
      phone,
      ...(email === undefined ? { email: `ia3.${phone}@example.test` } : email === null ? {} : { email }),
      ...(username ? { username } : {}),
    },
  })
  expect(res.status(), 'invitation register').toBe(201)

  const list = await admin('/api/invitations?status=pending')
  expect(list.status()).toBe(200)
  const rows = (await list.json()).filter((row) => row.phone === phone)
  expect(rows, `exactly one pending invitation for ${phone}`).toHaveLength(1)
  return rows[0]
}

function approve(id, data) {
  return admin(`/api/invitations/${id}/approve`, { method: 'post', ...(data === undefined ? {} : { data }) })
}

// The admin view of the created friend. Carries everything the 201 body deliberately
// omits: display_name, phone, email, active, must_change_password, onboarding_source,
// hasCredentials (⇒ password_hash is set) and subscriptions (⇒ the non-write).
async function friendRow(id) {
  const res = await admin('/api/friends')
  expect(res.status(), 'admin friends list').toBe(200)
  const row = (await res.json()).find((f) => f.id === id)
  expect(row, `friend ${id} in the admin list`).toBeTruthy()
  return row
}

async function friendTransactions(id) {
  const res = await admin(`/api/friends/${id}/detail`)
  expect(res.status(), 'friend detail').toBe(200)
  return (await res.json()).transactions
}

async function loginAs(username, password) {
  return ctx.post('/api/friends/auth', { data: { username, password } })
}

test.beforeAll(async ({ baseURL }) => {
  ctx = await playwrightRequest.newContext({ baseURL: baseURL || process.env.BASE_URL || 'http://localhost:3997' })
  const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), 'admin login').toBe(200)
  adminToken = (await login.json()).token
})

test.afterAll(async () => {
  await ctx?.dispose()
})

test.describe('Approval API — the happy path', () => {
  test('creates a friend with EVERY column from §UC-IA-005 and back-links the invitation', async () => {
    const inviter = await makeInviter('happyinv')
    const requested = uniqueUsername('lego')
    const invitation = await registerInvitation(inviter, { username: requested })
    expect(invitation.username, 'the applicant\'s requested username is stored').toBe(requested)
    expect(invitation.created_friend_id, 'no back-link before approval').toBeFalsy()

    const note = `Pozval/a: ${inviter.name}`
    const res = await approve(invitation.id, { note })
    expect(res.status(), 'approve').toBe(201)
    const body = await res.json()

    // ── the 201 shape: hand-picked, never sanitizeFriend, never SELECT * ──
    expect(Object.keys(body).sort(), 'top-level keys').toEqual(['friend', 'tempPassword', 'username'])
    expect(Object.keys(body.friend).sort(), 'friend keys').toEqual(['id', 'name', 'uid', 'username'])
    expect(body.friend.name, 'name comes from the invitation').toBe(invitation.name)
    expect(body.friend.username).toBe(requested)
    expect(body.username, 'the resolved username is echoed at the top level').toBe(requested)
    expect(body.friend.uid, 'uid over the unambiguous alphabet').toMatch(UID_RE)
    expect(body.tempPassword, '12 chars over CODE_ALPHABET (≈60 bits, clears the ≥8 policy)').toMatch(TEMP_PASSWORD_RE)

    // No credential material and NO SESSION (deliberate non-write #2) anywhere in
    // the response — asserted on the raw text so a nested key cannot hide.
    const raw = await res.text()
    expect(raw).not.toMatch(/invite_code|access_token|password_hash|expiresAt/)
    expect(body.token, 'no session is minted — the friend logs in themselves').toBeUndefined()

    // ── the friend row ──
    const friend = await friendRow(body.friend.id)
    expect(friend.name).toBe(invitation.name)
    expect(friend.display_name, 'the note lands in display_name').toBe(note)
    expect(friend.username).toBe(requested)
    expect(friend.phone, 'phone carried over').toBe(invitation.phone)
    expect(friend.email, 'email carried over').toBe(invitation.email)
    expect(friend.active, 'created active').toBe(1)
    expect(friend.must_change_password, 'the shipped forced-change gate fires on first login').toBe(1)
    expect(friend.onboarding_source, 'provenance for a normal referral invitation').toBe('invitation')
    expect(friend.hasCredentials, 'password_hash is set').toBe(true)
    expect(friend.uid).toBe(body.friend.uid)
    // The admin list is sanitized; if it were not, this row would be the leak.
    expect(friend).not.toHaveProperty('password_hash')
    expect(friend).not.toHaveProperty('access_token')
    expect(friend).not.toHaveProperty('invite_code')

    // ── the invitation row ──
    const after = await invitationById(invitation.id)
    expect(after.status).toBe('processed')
    expect(after.processed_at, 'processed_at stamped').toBeTruthy()
    expect(after.created_friend_id, 'back-link to the created friend').toBe(body.friend.id)
    expect(after.admin_note, 'the note also lands on the invitation').toBe(note)
    // Resolved conflict #4: approval never rewrites the applicant's request.
    expect(after.username, 'the invitation keeps the requested username as history').toBe(requested)

    // ── the credentials really work ──
    const ok = await loginAs(requested, body.tempPassword)
    expect(ok.status(), 'login with the temp password').toBe(200)
    const session = await ok.json()
    expect(session.mustChangePassword, 'first login is forced through the change gate').toBe(true)
    expect(session.hasCredentials).toBe(true)
    expect(session.friend.id).toBe(body.friend.id)
    expect(session.token, 'a real session is minted BY THE LOGIN, not by the approval').toBeTruthy()

    // Non-vacuity for the assertion above: the hash is not a rubber stamp.
    const wrong = await loginAs(requested, 'DEFINITELY-NOT-THE-TEMP-PASSWORD')
    expect(wrong.status(), 'a wrong password is still rejected').toBe(401)

    // Strictly-extra: the plaintext is NOT what got stored.
    const stored = withDb((db) =>
      db.prepare('SELECT password_hash, must_change_password FROM friends WHERE id = ?').get(body.friend.id)
    )
    if (stored) {
      expect(stored.password_hash, 'bcrypt digest').toMatch(/^\$2[aby]\$/)
      expect(stored.password_hash, 'the plaintext is never persisted').not.toContain(body.tempPassword)
      expect(Number(stored.must_change_password)).toBe(1)
    }
  })

  test('a guest-sourced invitation is stamped onboarding_source = guest_order', async () => {
    // The GSO-T10 provenance follow-up this UC closes: a lead that came through a
    // guest sub-order must stay distinguishable from a referral invitation after it
    // becomes a friend, because the invitation row the admin later deletes was the
    // only record of it. `invitations.source` is server-set in exactly one place, so
    // the fixture has to go the whole way round: host → link → sub-order → CTA.
    const host = await makeFriendWithSession('gsohost')

    const cycleRes = await admin('/api/cycles', {
      method: 'post',
      data: { name: `E2E IA3 guest ${uniq}`, type: 'coffee', status: 'open' },
    })
    expect(cycleRes.status(), 'cycle create').toBe(201)
    const cycle = await cycleRes.json()

    const productRes = await admin('/api/products', {
      method: 'post',
      data: { cycle_id: cycle.id, name: `IA3 Guest ${uniq}`, purpose: 'Espresso', price_250g: 10, price_1kg: 30 },
    })
    expect(productRes.status(), 'product create').toBe(201)
    const product = await productRes.json()

    const linkRes = await ctx.post(`/api/guest-links/cycle/${cycle.id}`, { headers: host.auth })
    expect([200, 201]).toContain(linkRes.status())
    const { link } = await linkRes.json()

    const guestPhone = uniquePhone()
    const submitted = await ctx.post(`/api/guest/${link.token}/orders`, {
      data: {
        guest_name: `Marek Hosť ${uniq}`,
        guest_phone: guestPhone,
        items: [{ product_id: product.id, variant: '250g', quantity: 1 }],
      },
    })
    expect(submitted.status(), 'guest submit').toBe(201)
    const { order } = await submitted.json()

    const leadPhone = uniquePhone()
    const cta = await ctx.post(`/api/guest/${link.token}/orders/${order.order_token}/invite-request`, {
      data: { name: `Marek Hosť ${uniq}`, phone: leadPhone, email: `lead.${leadPhone}@example.test` },
    })
    expect(cta.status(), 'invite request').toBe(201)

    const lead = (await (await admin('/api/invitations?status=pending')).json()).find((r) => r.phone === leadPhone)
    expect(lead, 'the lead landed in the invitations queue').toBeTruthy()
    expect(lead.source, 'tagged at creation by guest.js').toBe('guest_order')
    expect(lead.username, 'the CTA has no username field — approval must supply one').toBeFalsy()

    const username = uniqueUsername('marek')
    const res = await approve(lead.id, { username })
    expect(res.status(), 'approve the guest-sourced lead').toBe(201)
    const body = await res.json()

    const friend = await friendRow(body.friend.id)
    expect(friend.onboarding_source, 'provenance survives the invitation row').toBe('guest_order')
    expect(friend.username).toBe(username)
    expect(friend.must_change_password).toBe(1)

    // Same gate as a referral invitation — a guest-sourced friend is a normal friend.
    const ok = await loginAs(username, body.tempPassword)
    expect(ok.status()).toBe(200)
    expect((await ok.json()).mustChangePassword).toBe(true)
  })

  test('the temp password differs per approval and each one only opens its own account', async () => {
    // The generator is a CSPRNG, so two approvals in one run must not share a
    // password — and a password must not be interchangeable between the two friends
    // it was minted for (which is what a hash written to the wrong row looks like).
    const inviter = await makeInviter('twoinv')
    const a = await registerInvitation(inviter, { username: uniqueUsername('aa') })
    const b = await registerInvitation(inviter, { username: uniqueUsername('bb') })

    const ra = await approve(a.id, {})
    const rb = await approve(b.id, {})
    expect(ra.status()).toBe(201)
    expect(rb.status()).toBe(201)
    const ba = await ra.json()
    const bb = await rb.json()

    expect(ba.tempPassword).not.toBe(bb.tempPassword)
    expect(ba.friend.uid).not.toBe(bb.friend.uid)
    expect((await loginAs(ba.username, ba.tempPassword)).status()).toBe(200)
    expect((await loginAs(bb.username, bb.tempPassword)).status()).toBe(200)
    expect((await loginAs(ba.username, bb.tempPassword)).status(), 'cross-account password must fail').toBe(401)
  })
})

test.describe('Approval API — the three deliberate non-writes', () => {
  test('no friend_subscriptions row, no session, no transactions row', async () => {
    const inviter = await makeInviter('nonwrites')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('nowrite') })

    // ⚠ The baselines are taken HERE, after the fixtures — not at the top of the
    // test. `makeInviter` logs a friend in, so it legitimately mints
    // `friend_sessions` rows; a baseline captured before it would attribute the
    // fixture's own sessions to the approval and fail for the wrong reason.
    const beforeTransactions = countAll('transactions')
    const beforeSessions = countAll('friend_sessions')

    const res = await approve(invitation.id, { note: 'nič navyše' })
    expect(res.status()).toBe(201)
    const body = await res.json()

    // (1) UNFILTERED — no rows in friend_subscriptions means the friend sees
    // everything (friends.js / live-cycle.js). This deliberately diverges from
    // onboarding's bakery auto-subscribe; the contrast is proved below.
    const friend = await friendRow(body.friend.id)
    expect(friend.subscriptions, 'an invited friend starts unfiltered').toEqual([])

    // (2) NO SESSION MINT — the friend logs in themselves. The response carries no
    // token (asserted in the happy path too) and no session row exists for them.
    // ⚠ This is the ONE non-write whose strong form is DB_PATH-gated: no route lists
    // sessions, so without DB_PATH a server that minted a session and simply did not
    // return it would go unseen. Mutation-checked WITH DB_PATH (adding
    // `createFriendSession(friendId)` reddens exactly this assertion).
    expect(body.token).toBeUndefined()
    const sessionsForFriend = withDb((db) =>
      Number(db.prepare('SELECT COUNT(*) AS n FROM friend_sessions WHERE friend_id = ?').get(body.friend.id).n)
    )
    if (sessionsForFriend !== null) expect(sessionsForFriend, 'no session minted by the approval').toBe(0)
    if (beforeSessions !== null) expect(countAll('friend_sessions'), 'global friend_sessions unmoved').toBe(beforeSessions)

    // (3) NO transactions ROW — creation is not a financial event (GSO-T6). Checked
    // per-friend through the API AND as a global count, which is the only way to see
    // a row written with a NULL or foreign friend_id.
    expect(await friendTransactions(body.friend.id), 'no ledger entry for a new friend').toEqual([])
    expect(friend.balance, 'balance starts at zero').toBe(0)
    if (beforeTransactions !== null) {
      expect(countAll('transactions'), 'no transactions row anywhere').toBe(beforeTransactions)
    }
  })

  test('NON-VACUITY: onboarding self-signup DOES auto-subscribe, so the empty array above is evidence', async () => {
    // If `subscriptions` were simply always empty on a fresh friend, the assertion
    // above would prove nothing. The other creation path in the same codebase writes
    // a bakery row inside its transaction — so this is what "diverges deliberately"
    // looks like from the outside.
    const created = await admin('/api/onboarding-links', {
      method: 'post',
      data: { note: `E2E IA3 onboarding ${uniq}` },
    })
    expect(created.status(), 'onboarding link create').toBe(201)
    const { token } = await created.json()

    const username = uniqueUsername('onb')
    const signup = await ctx.post(`/api/onboarding/${token}`, {
      data: { name: `E2E Onboard ${uniq}`, phone: uniquePhone(), username, password: 'onboardPass1' },
    })
    expect(signup.status(), 'onboarding signup').toBe(201)
    const signupBody = await signup.json()

    const friend = await friendRow(signupBody.friendId)
    expect(friend.subscriptions, 'onboarding auto-subscribes to bakery').toEqual(['bakery'])
    // …and it DOES mint a session for auto-login, which the approval deliberately
    // does not: both halves of "diverges deliberately" are visible in one response.
    expect(signupBody.token, 'onboarding mints a session').toBeTruthy()
  })
})

test.describe('Approval API — the failure contract', () => {
  test('an unknown invitation id is 404', async () => {
    const res = await approve(999999, { username: uniqueUsername('ghost') })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.error, 'Slovak, no id echoed').toBeTruthy()
    expect(body).not.toHaveProperty('tempPassword')
  })

  test('a second approve is 409 and CARRIES created_friend_id, and creates no second friend', async () => {
    const inviter = await makeInviter('twice')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('twice') })

    const first = await approve(invitation.id, { note: 'prvý raz' })
    expect(first.status()).toBe(201)
    const created = (await first.json()).friend.id

    const second = await approve(invitation.id, { username: uniqueUsername('twiceb') })
    expect(second.status(), 'not pending any more').toBe(409)
    const body = await second.json()
    expect(body.created_friend_id, 'the dialog can say who already exists').toBe(created)
    expect(body).not.toHaveProperty('tempPassword')

    // Exactly ONE friend carries this invitation's name.
    const all = await (await admin('/api/friends')).json()
    expect(all.filter((f) => f.name === invitation.name), 'no duplicate friend').toHaveLength(1)
  })

  test('a REJECTED invitation is 409 too, with created_friend_id null', async () => {
    const inviter = await makeInviter('rejected')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('rej') })
    expect((await admin(`/api/invitations/${invitation.id}`, { method: 'patch', data: { status: 'rejected' } })).status()).toBe(200)

    const res = await approve(invitation.id, { username: uniqueUsername('rejb') })
    expect(res.status()).toBe(409)
    const body = await res.json()
    expect(body.created_friend_id, 'nothing was ever created for this row').toBeFalsy()

    const after = await invitationById(invitation.id)
    expect(after.status, 'a rejection is not silently reopened').toBe('rejected')
  })

  test('a taken username is 409 field:username, writes nothing, and the retry succeeds', async () => {
    const occupant = await makeFriendWithSession('occupant')
    const inviter = await makeInviter('takeninv')
    const requested = uniqueUsername('wanted')
    const invitation = await registerInvitation(inviter, { username: requested })

    const clash = await approve(invitation.id, { username: occupant.username, note: 'kolízia' })
    expect(clash.status(), 'the authoritative uniqueness check is here, at approval').toBe(409)
    const body = await clash.json()
    expect(body.field, 'the dialog points at the username input').toBe('username')
    expect(body).not.toHaveProperty('tempPassword')

    // NOTHING was written — the invitation is still approvable and no friend exists.
    const untouched = await invitationById(invitation.id)
    expect(untouched.status, 'still pending after the 409').toBe('pending')
    expect(untouched.created_friend_id).toBeFalsy()
    expect(untouched.admin_note, 'the note of a FAILED approval is not stored either').toBeFalsy()
    const all = await (await admin('/api/friends')).json()
    expect(all.filter((f) => f.name === invitation.name), 'no half-created friend').toHaveLength(0)

    // The dialog's inline-409 flow: fix the username, retry, same invitation.
    const override = uniqueUsername('override')
    const retry = await approve(invitation.id, { username: override, note: 'druhý pokus' })
    expect(retry.status(), 'retry after fixing the username').toBe(201)
    const ok = await retry.json()
    expect(ok.username, 'the admin override wins over the applicant\'s request').toBe(override)
    expect((await loginAs(override, ok.tempPassword)).status()).toBe(200)

    // Resolved conflict #4: the override lands on the FRIEND only.
    const after = await invitationById(invitation.id)
    expect(after.username, 'the invitation still records what the applicant asked for').toBe(requested)
    expect(after.created_friend_id).toBe(ok.friend.id)
    expect(after.admin_note).toBe('druhý pokus')
  })

  test('an invalid username is 400 field:username and the invitation stays pending', async () => {
    const inviter = await makeInviter('invalid')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('good') })

    for (const [label, username] of [
      ['too short', 'ab'],
      ['a space', 'ma ma'],
      ['too long', 'a'.repeat(31)],
      ['a forbidden char', 'jan@kovac'],
      ['diacritics', 'jánko'],
    ]) {
      const res = await approve(invitation.id, { username })
      expect(res.status(), `${label} ⇒ 400`).toBe(400)
      const body = await res.json()
      expect(body.field, `${label} ⇒ field marker`).toBe('username')
      expect(body.error, `${label} ⇒ Slovak message with diacritics`).toMatch(/Prihlasovacie meno/)
    }

    // ⚠ A BLANK override does NOT fall back to the applicant's request. This
    // invitation HAS a username, so `||` instead of `??` in the resolution chain
    // would silently approve with a name the admin had just cleared — and this is the
    // only test that can see the difference (the username-less test below reaches the
    // same 400 either way, because there the invitation's own value is NULL).
    const blank = await approve(invitation.id, { username: '   ' })
    expect(blank.status(), 'a cleared field is an error to fix, not a silent fallback').toBe(400)
    expect((await blank.json()).field).toBe('username')

    const after = await invitationById(invitation.id)
    expect(after.status).toBe('pending')
    expect(after.created_friend_id).toBeFalsy()
  })

  test('no username ANYWHERE is 400 field:username — there is no username-less approval', async () => {
    const inviter = await makeInviter('nouser')
    // Registered without a username, so `invitations.username` is NULL: the ONLY
    // remaining source is the body, and the fallback chain must not invent one.
    const invitation = await registerInvitation(inviter)
    expect(invitation.username, 'stored as NULL when the applicant left it blank').toBeFalsy()

    for (const [label, data] of [
      ['no body at all', undefined],
      ['an empty body', {}],
      ['a note but no username', { note: 'iba nota' }],
      ['an explicitly blank username', { username: '   ' }],
      ['an explicitly empty username', { username: '' }],
    ]) {
      const res = await approve(invitation.id, data)
      expect(res.status(), `${label} ⇒ 400`).toBe(400)
      expect((await res.json()).field, `${label} ⇒ field marker`).toBe('username')
    }

    // Nothing was written by any of those attempts.
    const after = await invitationById(invitation.id)
    expect(after.status).toBe('pending')
    expect(after.admin_note, 'not even the note of a rejected attempt').toBeFalsy()

    // …and supplying one now works, so the 400s were about the username only.
    const username = uniqueUsername('supplied')
    const res = await approve(invitation.id, { username })
    expect(res.status()).toBe(201)
    expect((await loginAs(username, (await res.json()).tempPassword)).status()).toBe(200)
  })

  test('a non-string username or note is 400, never a 500', async () => {
    // Same class as the `{name:123} → 500` bug UC-IA-003 fixed on the public
    // register: nothing in an admin body is trusted to have `.trim()` either.
    const inviter = await makeInviter('types')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('typed') })

    for (const [field, data] of [
      ['username', { username: 123 }],
      ['username', { username: { toString: 1 } }],
      ['username', { username: ['a'] }],
      ['note', { username: uniqueUsername('t'), note: 42 }],
      ['note', { username: uniqueUsername('t'), note: { a: 1 } }],
    ]) {
      const res = await approve(invitation.id, data)
      expect(res.status(), `${field}: ${JSON.stringify(data)} ⇒ 400`).toBe(400)
      expect((await res.json()).field).toBe(field)
    }

    expect((await invitationById(invitation.id)).status, 'still pending').toBe('pending')
  })

  test('the note is optional: absent KEEPS the existing admin_note and leaves display_name null', async () => {
    const inviter = await makeInviter('noteless')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('noteless') })

    // A note the admin wrote earlier through the shipped status PATCH. `note ??
    // existing` means an absent note must not erase it.
    expect((await admin(`/api/invitations/${invitation.id}`, { method: 'patch', data: { admin_note: 'pôvodná nota' } })).status()).toBe(200)
    expect((await invitationById(invitation.id)).status, 'the PATCH kept it pending').toBe('pending')

    const res = await approve(invitation.id, { username: uniqueUsername('nl') })
    expect(res.status()).toBe(201)
    const body = await res.json()

    const after = await invitationById(invitation.id)
    expect(after.admin_note, 'an absent note keeps what was there').toBe('pôvodná nota')
    const friend = await friendRow(body.friend.id)
    expect(friend.display_name, 'display_name comes from the note, not from admin_note').toBeFalsy()
  })
})

test.describe('Approval API — the admin boundary', () => {
  test('a friend session and a bad admin token are both 401, and nothing is created', async () => {
    // The anonymous 401 is in the canonical ADMIN_ENDPOINTS sweep
    // (api-security.spec.js, 07 §UC-IA-008 item 1). This adds the two boundaries
    // that sweep does not cover: the invitations router is a MIXED mount, so a
    // per-route guard is the only thing standing between a FRIEND session and the
    // ability to mint another friend's credentials.
    const inviter = await makeInviter('boundary')
    const invitation = await registerInvitation(inviter, { username: uniqueUsername('bound') })
    const path = `/api/invitations/${invitation.id}/approve`

    const anon = await ctx.post(path, { data: { username: uniqueUsername('x') } })
    expect(anon.status(), 'anonymous').toBe(401)

    const asFriend = await ctx.post(path, {
      headers: inviter.auth,
      data: { username: uniqueUsername('x') },
    })
    expect(asFriend.status(), 'a friend Bearer session is not admin identity').toBe(401)

    const badToken = await ctx.post(path, {
      headers: { 'X-Admin-Token': 'not-a-real-token' },
      data: { username: uniqueUsername('x') },
    })
    expect(badToken.status(), 'a wrong admin token').toBe(401)

    const after = await invitationById(invitation.id)
    expect(after.status, 'untouched by every rejected call').toBe('pending')
    expect(after.created_friend_id).toBeFalsy()
  })

  test('the public half of the MIXED mount is still public', async () => {
    // Regression net for the one mistake the per-route guard prevents: wrapping the
    // whole mount in requireAdmin would 401 the public registration flow IA-T2 built.
    const inviter = await makeInviter('mixed')
    const code = await ctx.get(`/api/invitations/code/${inviter.inviteCode}`)
    expect(code.status(), 'GET /code/:code stays public').toBe(200)
    expect((await code.json()).inviterName).toBe(inviter.name)

    const reg = await ctx.post('/api/invitations/register', {
      data: { invite_code: inviter.inviteCode, name: `E2E Mixed ${uniq}`, phone: uniquePhone() },
    })
    expect(reg.status(), 'POST /register stays public').toBe(201)
  })
})
