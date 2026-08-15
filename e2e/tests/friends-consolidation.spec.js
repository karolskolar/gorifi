import { test, expect, request as playwrightRequest } from '@playwright/test'
import { ADMIN_PASSWORD, fixtureEmail } from '../fixtures.js'

// FC-T1 / 11 §UC-FC-004,005,007 — the API half of the friends-consolidation module:
// type guards + bounds on the two admin write routes, the response-stripping
// invariants (now incl. `google_sub` + the derived `googleLinked`), and the
// no-back-propagation pin against the invitations row.
//
// ⚠ FC-T2 adds the UI half (AdminFriends table + modal, 11 §UC-FC-002/003) as sibling
// describes IN THIS FILE. Harness trap for that half: there is exactly ONE admin token
// app-wide (`admin.js` does INSERT OR REPLACE 'admin_token'), so a UI admin login
// invalidates the token `beforeAll` mints here — a UI describe that also calls the API
// must adopt the browser's token (`localStorage.getItem('adminToken')`), never mix in
// a second API login mid-file.
//
// Fixtures are PER TEST, not a shared beforeAll (the GSO-T8 worker-restart lesson):
// `beforeAll` does nothing but log the admin in.
//
// UC-FC-004's server bounds, mirrored by FC-T2's `maxlength` attributes
// (the GSO-T3 mirror convention). Source of truth: LOCAL constants in
// backend/src/routes/friends.js — MAX_NAME_LENGTH 120, MAX_PHONE_LENGTH 32,
// MAX_EMAIL_LENGTH 160, MAX_NOTE_LENGTH 200.
const BOUNDS = { name: 120, phone: 32, email: 160, display_name: 200 }

// UC-FC-005 / UC-IA-005-style raw-text pin: run against the FULL response body so a
// future `SELECT *` widening cannot leak credential material or the raw Google
// subject. `google_sub` is in the list from this module on (a no-op until module 10
// adds the column — module 10 INHERITS this rule).
const STRIP_RE = /(password_hash|access_token|invite_code|google_sub)/

let ctx
let adminToken
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
let seq = 0

function uniqueName(label) {
  return `E2E FC ${label} ${uniq}${++seq}`
}

async function admin(path, opts = {}) {
  return ctx[opts.method || 'get'](path, {
    headers: { 'X-Admin-Token': adminToken },
    ...(opts.data !== undefined ? { data: opts.data } : {}),
  })
}

// A plain friend via the admin route (valid string name — the same shape
// invitation-approval.spec.js uses, which UC-FC-008 item 3 keeps working).
async function makeFriend(label, extra = {}) {
  const res = await admin('/api/friends', { method: 'post', data: { name: uniqueName(label), ...extra } })
  expect(res.status(), 'friend create').toBe(201)
  return res.json()
}

async function friendRow(id) {
  const res = await admin('/api/friends')
  expect(res.status(), 'admin friends list').toBe(200)
  const row = (await res.json()).find((f) => f.id === id)
  expect(row, `friend ${id} in the admin list`).toBeTruthy()
  return row
}

// ── UC-FC-007 fixture builders (idiom from invitation-approval.spec.js) ───────
// A friend with a Bearer session — the only way to read an invite code, because
// `friends.js` strips `invite_code` from every response.
const phoneSeed = String(Date.now()).slice(-8)
let phoneSeq = 0
function uniquePhone() {
  return `09${phoneSeed}${String(++phoneSeq).padStart(2, '0')}`
}

function uniqueUsername(label) {
  const suffix = `_fc${uniq}${++seq}`
  return `${String(label).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30 - suffix.length) + suffix
}

async function makeFriendWithSession(label) {
  const username = uniqueUsername(label)
  const friend = await makeFriend(label)
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
  return { id: friend.id, username, token, auth: { Authorization: `Bearer ${token}` } }
}

async function makeInviter(label) {
  const inviter = await makeFriendWithSession(label)
  const res = await ctx.get('/api/invitations/my-code', { headers: inviter.auth })
  expect(res.status(), 'my-code').toBe(200)
  const { inviteCode } = await res.json()
  expect(inviteCode, 'invite code').toBeTruthy()
  return { ...inviter, inviteCode }
}

// ⚠ NEVER SEND REAL MAIL (07 §UC-IA-009): approval mails the invitation's address, so
// the address comes from `fixtureEmail` — an address only on a mail-safe target;
// off-local the invitation carries none and the transport is never reached.
async function registerInvitation(inviter) {
  const phone = uniquePhone()
  const email = fixtureEmail(phone)
  const res = await ctx.post('/api/invitations/register', {
    data: {
      invite_code: inviter.inviteCode,
      name: `Ján Konsolidovaný ${uniq}${seq}`,
      phone,
      ...(email ? { email } : {}),
    },
  })
  expect(res.status(), 'invitation register').toBe(201)
  const list = await admin('/api/invitations?status=pending')
  expect(list.status()).toBe(200)
  const rows = (await list.json()).filter((row) => row.phone === phone)
  expect(rows, `exactly one pending invitation for ${phone}`).toHaveLength(1)
  return rows[0]
}

async function invitationById(id) {
  const res = await admin('/api/invitations')
  expect(res.status(), 'admin invitations list').toBe(200)
  return (await res.json()).find((row) => row.id === id) || null
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

// ── UC-FC-004: type guards — 400 with a field marker, never a 500 ─────────────
test.describe('API — UC-FC-004 type guards', () => {
  test('POST {name: 123} is 400 field:name, not a 500', async () => {
    const res = await admin('/api/friends', { method: 'post', data: { name: 123 } })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.field).toBe('name')
    expect(body.error).toBeTruthy()
  })

  test('POST with a non-string email is 400 field:email (the recorded live 500)', async () => {
    const res = await admin('/api/friends', { method: 'post', data: { name: uniqueName('tg-email'), email: 123 } })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('email')
  })

  test('POST with object phone / array display_name is 400 with the right marker', async () => {
    const phone = await admin('/api/friends', { method: 'post', data: { name: uniqueName('tg-ph'), phone: {} } })
    expect(phone.status()).toBe(400)
    expect((await phone.json()).field).toBe('phone')

    const note = await admin('/api/friends', { method: 'post', data: { name: uniqueName('tg-dn'), display_name: [] } })
    expect(note.status()).toBe(400)
    expect((await note.json()).field).toBe('display_name')
  })

  test('PATCH {email: {}} is 400 field:email and writes nothing', async () => {
    const friend = await makeFriend('tg-patch', { email: 'keep@example.test' })
    const res = await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { email: {} } })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('email')
    expect((await friendRow(friend.id)).email).toBe('keep@example.test')
  })

  test('PATCH with boolean name is 400 field:name', async () => {
    const friend = await makeFriend('tg-bool')
    const res = await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { name: true } })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('name')
  })
})

// ── UC-FC-004: length bounds (after trim) ─────────────────────────────────────
test.describe('API — UC-FC-004 bounds', () => {
  test('one-over-bound values are each 400 with their field marker', async () => {
    const friend = await makeFriend('bounds')
    const over = [
      ['name', 'x'.repeat(BOUNDS.name + 1)],
      ['phone', '9'.repeat(BOUNDS.phone + 1)],
      ['email', `${'a'.repeat(BOUNDS.email - 5)}@${'b'.repeat(5)}`], // 161 chars
      ['display_name', 'x'.repeat(BOUNDS.display_name + 1)],
    ]
    for (const [field, value] of over) {
      const post = await admin('/api/friends', {
        method: 'post',
        data: { name: uniqueName('b-post'), [field]: value },
      })
      expect(post.status(), `POST ${field} over bound`).toBe(400)
      expect((await post.json()).field, `POST ${field} marker`).toBe(field)

      const patch = await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { [field]: value } })
      expect(patch.status(), `PATCH ${field} over bound`).toBe(400)
      expect((await patch.json()).field, `PATCH ${field} marker`).toBe(field)
    }
  })

  test('exactly-at-bound values are accepted and stored trimmed (non-vacuity)', async () => {
    // name at 120 needs the unique prefix inside the bound
    const name = uniqueName('b-max').padEnd(BOUNDS.name, 'x')
    const email = `${'a'.repeat(BOUNDS.email - 6)}@${'b'.repeat(5)}` // 160 chars
    const res = await admin('/api/friends', {
      method: 'post',
      data: {
        name: `  ${name}  `, // bound applies AFTER trim
        phone: '9'.repeat(BOUNDS.phone),
        email,
        display_name: 'x'.repeat(BOUNDS.display_name),
      },
    })
    expect(res.status()).toBe(201)
    const created = await res.json()
    expect(created.name).toBe(name)
    const row = await friendRow(created.id)
    expect(row.phone).toBe('9'.repeat(BOUNDS.phone))
    expect(row.email).toBe(email)
    expect(row.display_name).toBe('x'.repeat(BOUNDS.display_name))
  })
})

// ── UC-FC-004: the name rule + the relabelled message ─────────────────────────
test.describe('API — UC-FC-004 name required', () => {
  test('POST without a name is 400 and the message no longer claims a login', async () => {
    const res = await admin('/api/friends', { method: 'post', data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.field).toBe('name')
    expect(body.error).toBe('Meno a priezvisko je povinné')
    expect(body.error).not.toMatch(/prihlasovac/i)
  })

  test('POST with a whitespace-only name is 400 field:name', async () => {
    const res = await admin('/api/friends', { method: 'post', data: { name: '   ' } })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('name')
  })

  test('PATCH {name: "  "} is 400 and the row is unchanged (used to silently blank it)', async () => {
    const friend = await makeFriend('blank')
    const res = await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { name: '  ' } })
    expect(res.status()).toBe(400)
    expect((await res.json()).field).toBe('name')
    expect((await friendRow(friend.id)).name).toBe(friend.name)
  })

  test('PATCH with explicit nulls CLEARS phone/email/display_name (the shipped admin UI payload)', async () => {
    // AdminFriends.vue sends `trim() || null` to clear a field (UC-FC-003 pins the
    // payload forward), and §UC-FC-004 preserves the old null-clears-it behaviour
    // verbatim — the type-guard list deliberately excludes `null`. A removed email
    // must really leave the row, or the "Bez e-mailu" badge and the module-09
    // recovery seam render stale.
    const friend = await makeFriend('null-clear', {
      phone: '0900333444',
      email: 'clear-me@example.test',
      display_name: 'poznámka na zmazanie',
    })
    const res = await admin(`/api/friends/${friend.id}`, {
      method: 'patch',
      data: { phone: null, email: null, display_name: null },
    })
    expect(res.status()).toBe(200)
    const row = await friendRow(friend.id)
    expect(row.phone).toBeNull()
    expect(row.email).toBeNull()
    expect(row.display_name).toBeNull()
  })

  test('PATCH without name leaves it untouched (absent ≠ blank)', async () => {
    const friend = await makeFriend('absent')
    const res = await admin(`/api/friends/${friend.id}`, { method: 'patch', data: { phone: '0900111222' } })
    expect(res.status()).toBe(200)
    const row = await friendRow(friend.id)
    expect(row.name).toBe(friend.name)
    expect(row.phone).toBe('0900111222')
  })

  test('module-03 pin: PATCH /:id/profile keeps its own "Prihlasovacie meno" message', async () => {
    // 11 §UC-FC-004 explicitly leaves the friend-profile route's copy to module 03
    // (it serves FriendPortalSession.vue's pinned label). Only the ADMIN route was
    // relabelled — this pin fails if the relabel over-reaches.
    const friend = await makeFriendWithSession('m03pin')
    const res = await ctx.patch(`/api/friends/${friend.id}/profile`, {
      headers: friend.auth,
      data: { name: '   ' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toContain('Prihlasovacie meno je povinné')
  })
})

// ── UC-FC-005: response invariants ────────────────────────────────────────────
test.describe('API — UC-FC-005 stripping + googleLinked', () => {
  test('GET /api/friends: raw body never leaks credential material, every row carries googleLinked', async () => {
    await makeFriend('strip-list') // at least one row exists
    const res = await admin('/api/friends')
    expect(res.status()).toBe(200)
    expect(await res.text()).not.toMatch(STRIP_RE)
    const rows = await res.json()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(typeof row.googleLinked, `googleLinked on friend ${row.id}`).toBe('boolean')
      // Pre-module-10 DB: the column does not exist, so the derivation must land
      // on false via the same code path — no flag, no error (graceful rule).
      expect(row.googleLinked).toBe(false)
    }
  })

  test('GET /api/friends/:id/detail: same raw-text pin + googleLinked on the friend', async () => {
    const friend = await makeFriend('strip-detail')
    const res = await admin(`/api/friends/${friend.id}/detail`)
    expect(res.status()).toBe(200)
    expect(await res.text()).not.toMatch(STRIP_RE)
    const body = await res.json()
    expect(body.friend.googleLinked).toBe(false)
  })

  test('a valid POST still creates a friend with NO credentials, and its 201 body is stripped too', async () => {
    const res = await admin('/api/friends', { method: 'post', data: { name: uniqueName('nocreds') } })
    expect(res.status()).toBe(201)
    expect(await res.text()).not.toMatch(STRIP_RE)
    const created = await res.json()
    const row = await friendRow(created.id)
    expect(row.username).toBeNull()
    expect(row.hasCredentials).toBe(false)
  })
})

// ── UC-FC-007: no back-propagation into the invitations row ───────────────────
test.describe('API — UC-FC-007 invitation stays frozen', () => {
  test('editing an approved friend leaves the source invitation row byte-identical', async () => {
    const inviter = await makeInviter('fc7inv')
    const invitation = await registerInvitation(inviter)

    const approved = await admin(`/api/invitations/${invitation.id}/approve`, {
      method: 'post',
      data: { username: uniqueUsername('fc7'), note: 'schválené v FC-T1' },
    })
    expect(approved.status(), 'approve').toBe(201)
    const friendId = (await approved.json()).friend.id

    const before = await invitationById(invitation.id)
    expect(before, 'invitation row after approve').toBeTruthy()
    expect(before.created_friend_id).toBe(friendId)

    const edit = await admin(`/api/friends/${friendId}`, {
      method: 'patch',
      data: {
        name: `Ján Opravený ${uniq}${seq}`,
        phone: uniquePhone(),
        email: 'oprava@example.test',
        display_name: 'opravená poznámka',
      },
    })
    expect(edit.status(), 'admin edit of the approved friend').toBe(200)
    const row = await friendRow(friendId)
    expect(row.email).toBe('oprava@example.test')

    // The invitation is the frozen historical record (07 §UC-IA-001): status,
    // username request, admin_note, created_friend_id — the WHOLE row — unchanged.
    const after = await invitationById(invitation.id)
    expect(after).toEqual(before)
  })
})
