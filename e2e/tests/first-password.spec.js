import { test, expect, request as playwrightRequest } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { ADMIN_PASSWORD, FRIENDS_PASSWORD } from '../fixtures.js'
import { CAN_SPAWN_BACKEND, startBackend } from '../mailgun-harness.js'

// GA-T11 — `POST /api/friends/:id/set-password`: the FIRST password, for a friend who
// has none (10 §UC-GA-004's security model, §UC-GA-007's surface).
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS ROUTE EXISTS AT ALL — neither sibling fits, and the reasons differ
// ═════════════════════════════════════════════════════════════════════════════
//
//   · `PUT /:id/change-password` answers **400** `Nemáte nastavené osobné heslo`
//     for exactly this friend (`friends.js`, the `!friend.password_hash` guard):
//     it changes a password, and there is none to change.
//   · `POST /:id/setup-credentials` would NOT refuse them (its 409 needs
//     `password_hash` **AND** `username`, and this friend has neither) — the
//     mismatch is SECURITY, not status codes. That route serves the TRANSITION-mode
//     `needsCredentialSetup` flow, i.e. it runs by definition while `auth_mode` is
//     not modern, so it cannot carry the modern-mode guard that GA-T5 identified as
//     the only real defence against credential PLANTING: in legacy/transition mode
//     `POST /friends/auth` with `{password: <shared>, friendId: <anyone>}` mints a
//     session that IS the victim's resolved identity, so every ownership check
//     downstream passes. See `friends.js`'s `requireGoogleLinkOwner` comment.
//
// So: a NEW route, owner-guarded AND modern-mode-guarded, and the modern-mode 409 is
// the load-bearing half. This file pins both halves.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE REACHABILITY FINDING (GA-T11, measured — it decided the route's shape)
// ═════════════════════════════════════════════════════════════════════════════
//
// Which friend can actually reach this route? Every modern-mode session mint was
// walked, and the answer is narrower than it looks:
//
//   · `POST /friends/auth` personal branch — requires `username` + `password_hash`.
//   · `POST /friends/auth` shared branch   — 401 in modern mode.
//   · `POST /magic-link/redeem`            — requires `password_hash` (§UC-ML-005).
//   · `POST /onboarding/:token` + module 07's approval — both ALWAYS write `username`
//     AND `password_hash` (07 §UC-IA-005: "a friend with a login"), so neither can
//     produce `hasCredentials: false`.
//   · a session minted in legacy/transition mode does NOT survive the flip:
//     `PUT /api/admin/settings` DELETEs every `friend_sessions` row on a mode change.
//   · `POST /friends/auth/google`          — requires `google_sub` ONLY.
//
// ⇒ the ONE modern-mode session a credential-less friend can hold is a GOOGLE login,
// and a `google_sub` on a credential-less row cannot come from `PUT /:id/google-link`
// (it demands a modern-mode session first) nor from approval (which mints a password),
// so today it comes from a data migration/restore or an operator — and from
// `api.linkGoogle` here, which is the same write.
//
// ⇒ the route MUST take an optional `username`, or a friend who reaches it would end up
// with a password and nothing to type it next to.
//
// ⚠ AND `username` IS NOT GUARANTEED NULL ON SUCH A ROW — the reason the route reads it
// conditionally rather than unconditionally. `PUT /:id/admin-username`
// (`friends.js:1679`) writes `username` and never touches `password_hash`, and it is
// the ONLY writer that does (every `UPDATE friends SET` / `INSERT INTO friends` in
// `backend/src` was walked; the admin PATCH's allow-list is
// name/display_name/active/phone/email only). So a supplied `username` is honoured ONLY
// while `friends.username IS NULL` and NEVER as a rename — FUP-T20's product decision
// keeps the username read-only in the portal; the admin renames. The "honoured ONLY
// while NULL" test below builds precisely that row, through that admin route.

const TEST_CLIENT_ID = 'test-client'
const GOOGLE_ENV = { GOOGLE_CLIENT_ID: TEST_CLIENT_ID, GOOGLE_AUTH_TEST_MODE: '1' }
const NEEDS_SOURCE = 'needs the backend source beside e2e/ (skipped against a deployment)'

// ── Route messages, copied VERBATIM from the handler (the `nonstring-body-shape`
// convention: a re-worded constant here would be a silent copy change on a real
// screen). The `auth_mode` 409 is byte-identical to `POST /friends/auth/google`'s.
const MODE_409 = 'Nastavenie vlastného hesla je dostupné až po prechode na osobné prihlasovanie'
const ALREADY_SET = 'Heslo je už nastavené. Použite zmenu hesla.'
const PASSWORD_RULE = 'Heslo musí mať aspoň 8 znakov'
const USERNAME_REQUIRED = 'Uzivatelske meno je povinne'
const USERNAME_TAKEN = 'Užívateľské meno je už obsadené'
const FOREIGN = 'Nemáte oprávnenie na tento účet'

let seq = 0
const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const tag = (label) => `${label}-${uniq}-${++seq}`

/**
 * Run `fn` against a freshly seeded throwaway backend (the module-10 idiom —
 * `google-auth.spec.js`'s `withGoogleBackend`, trimmed to what this file needs).
 *
 * ⚠ A throwaway, NOT the shared gate server, and that is not tidiness: this file
 * flips `auth_mode` to `modern`, and on the shared server that DELETES every
 * `friend_sessions` row — i.e. it would pull the seeded session out from under any
 * other spec file's fixtures. CLAUDE.md's "provision modern and restore legacy" rule
 * is satisfied by the throwaway being thrown away.
 */
async function withBackend(fn) {
  let backend
  let ctx
  try {
    backend = await startBackend({ ...GOOGLE_ENV })
    ctx = await playwrightRequest.newContext({ baseURL: backend.baseUrl })
    const login = await ctx.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
    expect(login.status(), 'harness admin login (did seed.mjs run?)').toBe(200)
    await fn(makeApi(ctx, (await login.json()).token, backend.dbPath))
  } finally {
    await ctx?.dispose()
    await backend?.stop()
  }
}

function makeApi(ctx, adminToken, dbPath) {
  const admin = () => ({ 'X-Admin-Token': adminToken })
  const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {})

  function withDb(fn) {
    const db = new DatabaseSync(dbPath)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  return {
    ctx,
    withDb,
    bearer,
    async setMode(mode) {
      const r = await ctx.put('/api/admin/settings', { headers: admin(), data: { authMode: mode } })
      expect(r.status(), `switch to ${mode}`).toBe(200)
      expect((await r.json()).authMode).toBe(mode)
    },
    /** No username, no password — the state this row exists for. */
    async plainFriend(label) {
      const created = await ctx.post('/api/friends', { headers: admin(), data: { name: `GA11 ${label}` } })
      expect(created.status(), 'friend create').toBe(201)
      return created.json()
    },
    async giveUsername(id, username) {
      const r = await ctx.put(`/api/friends/${id}/admin-username`, { headers: admin(), data: { username } })
      expect(r.status(), 'admin-username').toBe(200)
      return username
    },
    async givePassword(id, password = 'adminSet123') {
      const r = await ctx.put(`/api/friends/${id}/reset-password`, { headers: admin(), data: { password } })
      expect(r.status(), 'reset-password').toBe(200)
      return password
    },
    /** The out-of-band link — see the reachability note above. */
    linkGoogle(id, { sub, email = null }) {
      withDb((db) => {
        db.prepare('UPDATE friends SET google_sub = ?, google_email = ? WHERE id = ?').run(sub, email, Number(id))
      })
    },
    row(id) {
      return withDb((db) => db.prepare(
        'SELECT id, username, password_hash, must_change_password, google_sub FROM friends WHERE id = ?'
      ).get(Number(id)))
    },
    sessionCount(id) {
      return withDb((db) => db.prepare('SELECT COUNT(*) AS n FROM friend_sessions WHERE friend_id = ?').get(Number(id)).n)
    },
    /** The legacy shared-password mint — the only per-friend token for a friend with
     *  no credentials, and only outside modern mode. */
    async legacySession(friendId) {
      const r = await ctx.post('/api/friends/auth', { data: { password: FRIENDS_PASSWORD, friendId } })
      expect(r.status(), 'legacy per-friend session mint').toBe(200)
      return (await r.json()).token
    },
    /** The ONE modern-mode session a credential-less friend can hold. */
    async googleSession(sub, email = null) {
      const r = await ctx.post('/api/friends/auth/google', { data: { id_token: `TEST:${sub}:${email || ''}` } })
      expect(r.status(), 'google login').toBe(200)
      const body = await r.json()
      expect(body.hasCredentials, 'the fixture really has no password').toBe(false)
      return body.token
    },
    async passwordLogin(username, password) {
      return ctx.post('/api/friends/auth', { data: { username, password } })
    },
    setPassword(id, token, data) {
      return ctx.post(`/api/friends/${id}/set-password`, { headers: bearer(token), data })
    },
    setPasswordAsAdmin(id, data) {
      return ctx.post(`/api/friends/${id}/set-password`, { headers: admin(), data })
    },
    /** `data` bypassing Playwright's JSON serialisation, for the body-shape matrix. */
    setPasswordRaw(id, token, raw) {
      return ctx.post(`/api/friends/${id}/set-password`, {
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        data: raw,
      })
    },
    profile(id, token) {
      return ctx.get(`/api/friends/${id}/profile`, { headers: bearer(token) })
    },
  }
}

/** The fixture the route was built for: modern mode, Google-only, no credentials. */
async function googleOnlyFriend(api, label) {
  const friend = await api.plainFriend(label)
  const sub = tag(`sub-${label}`)
  const email = `${label}@example.test`
  api.linkGoogle(friend.id, { sub, email })
  await api.setMode('modern')
  const token = await api.googleSession(sub, email)
  return { friend, sub, email, token }
}

// ═════════════════════════════════════════════════════════════════════════════

test.describe('GA-T11 — the first password: authorization', () => {
  test('anonymous is 401 and an admin token is 401 — the mode guard never answers first', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const friend = await api.plainFriend(tag('anon'))

      // ⚠ Legacy (the seeded mode) — an anonymous caller must get the UNIFORM 401 the
      // `api-security.spec.js` sweep asserts, never the `auth_mode` 409. That is what
      // pins the guard ORDER: ownership first, mode second (GA-T5's rule, inherited).
      const anon = await api.setPassword(friend.id, null, { password: 'brandNew123' })
      expect(anon.status(), 'anonymous').toBe(401)
      expect(await anon.text()).not.toContain('auth_mode')

      // ⚠ An admin token is NOT host identity (CLAUDE.md): this is a friend surface,
      // so it must not unlock with one either. The same claim is swept target-
      // agnostically in `api-security.spec.js`'s `FRIEND_IDENTITY_ENDPOINTS`; asserted
      // here too because this file owns the route's whole boundary.
      const asAdmin = await api.setPasswordAsAdmin(friend.id, { password: 'brandNew123' })
      expect(asAdmin.status(), 'an admin token is not a friend session').toBe(401)

      await api.setMode('modern')
      const anonModern = await api.setPassword(friend.id, null, { password: 'brandNew123' })
      expect(anonModern.status(), 'anonymous, modern mode').toBe(401)

      expect(api.row(friend.id).password_hash, 'nothing was written').toBeNull()
    })
  })

  test('a foreign friend is refused (403) and the victim keeps no password', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const victim = await api.plainFriend(tag('victim'))
      const { token } = await googleOnlyFriend(api, tag('attacker'))

      const res = await api.setPassword(victim.id, token, { password: 'plantedPw123', username: tag('planted').slice(0, 30) })
      expect(res.status(), 'friend A must not mint friend B a credential').toBe(403)
      expect((await res.json()).error).toBe(FOREIGN)

      const row = api.row(victim.id)
      expect(row.password_hash, 'SEC-A1: the victim row is untouched').toBeNull()
      expect(row.username).toBeNull()
    })
  })

  test('⚠ the modern-mode guard: legacy AND transition both 409, with a resolved owner', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    // ⚠ THE LOAD-BEARING CONTROL (GA-T5). The caller below is a perfectly resolved
    // owner — and that is the point: in legacy/transition mode a session is mintable
    // for ANY friend from the shared office password alone, so the ownership check is
    // satisfied by an attacker just as easily as by the friend. Only the mode guard
    // stops a planted password that would become a permanent alternative credential
    // the moment the admin flips to modern.
    await withBackend(async (api) => {
      const friend = await api.plainFriend(tag('legacy'))

      for (const mode of ['legacy', 'transition']) {
        await api.setMode(mode)
        // ⚠ Re-minted per mode: the mode flip deletes every session row.
        const token = await api.legacySession(friend.id)
        const res = await api.setPassword(friend.id, token, { password: 'plantedPw123', username: tag('plant').slice(0, 30) })
        expect(res.status(), `${mode} mode must refuse`).toBe(409)
        const body = await res.json()
        expect(body.error).toBe(MODE_409)
        expect(body.field, 'the client renders it on the mode, not the password').toBe('auth_mode')

        const row = api.row(friend.id)
        expect(row.password_hash, `${mode}: no credential was planted`).toBeNull()
        expect(row.username, `${mode}: no username was planted either`).toBeNull()
      }
    })
  })
})

test.describe('GA-T11 — the first password: state guards', () => {
  test('a friend who already HAS a password is refused (409) and keeps the old one', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const friend = await api.plainFriend(tag('haspw'))
      const username = tag('haspw').replace(/[^a-z0-9._-]/g, '').slice(0, 30)
      await api.giveUsername(friend.id, username)
      const password = await api.givePassword(friend.id)
      api.linkGoogle(friend.id, { sub: tag('sub-haspw'), email: 'haspw@example.test' })
      await api.setMode('modern')

      const login = await api.passwordLogin(username, password)
      expect(login.status(), 'seed login').toBe(200)
      const token = (await login.json()).token

      const before = api.row(friend.id).password_hash
      const res = await api.setPassword(friend.id, token, { password: 'anotherOne123' })
      expect(res.status(), 'setting a FIRST password is not changing one').toBe(409)
      expect((await res.json()).error).toBe(ALREADY_SET)

      // ⚠ The refusal test reads the row back (spec hygiene): a 409 that still wrote
      // would be a silent password change without the current-password proof
      // `PUT /:id/change-password` demands.
      expect(api.row(friend.id).password_hash, 'the stored hash is untouched').toBe(before)
      expect((await api.passwordLogin(username, password)).status(), 'the old password still works').toBe(200)
      expect((await api.passwordLogin(username, 'anotherOne123')).status(), 'the new one never took').toBe(401)
    })
  })

  test('the username is honoured ONLY while `friends.username` is NULL — never a rename', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const friend = await api.plainFriend(tag('named'))
      const username = tag('named').replace(/[^a-z0-9._-]/g, '').slice(0, 30)
      await api.giveUsername(friend.id, username)
      const sub = tag('sub-named')
      api.linkGoogle(friend.id, { sub, email: 'named@example.test' })
      await api.setMode('modern')
      const token = await api.googleSession(sub, 'named@example.test')

      const wanted = tag('renamed').replace(/[^a-z0-9._-]/g, '').slice(0, 30)
      const res = await api.setPassword(friend.id, token, { password: 'firstOne123', username: wanted })
      expect(res.status(), 'the password half still succeeds').toBe(200)

      const row = api.row(friend.id)
      expect(row.username, 'FUP-T20: the portal never renames — the admin does').toBe(username)
      expect(row.password_hash, 'the password was set').toBeTruthy()
      expect((await res.json()).friend.username, 'and the response says which login to use').toBe(username)
      expect((await api.passwordLogin(username, 'firstOne123')).status(), 'the real login works').toBe(200)
      expect((await api.passwordLogin(wanted, 'firstOne123')).status(), 'the wanted one was never created').toBe(401)
    })
  })

  test('a NULL username makes one mandatory: 400 without it, 409 when taken', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const other = await api.plainFriend(tag('other'))
      const takenName = tag('taken').replace(/[^a-z0-9._-]/g, '').slice(0, 30)
      await api.giveUsername(other.id, takenName)

      const { friend, token } = await googleOnlyFriend(api, tag('nouser'))

      // ⚠ A password with no username to type it beside is not a login. The route
      // refuses rather than writing a credential the friend cannot use.
      const missing = await api.setPassword(friend.id, token, { password: 'firstOne123' })
      expect(missing.status(), 'no username anywhere').toBe(400)
      const missingBody = await missing.json()
      expect(missingBody.error).toBe(USERNAME_REQUIRED)
      expect(missingBody.field).toBe('username')
      expect(api.row(friend.id).password_hash, 'and nothing was written').toBeNull()

      const bad = await api.setPassword(friend.id, token, { password: 'firstOne123', username: 'NO' })
      expect(bad.status(), 'the shared format rule applies').toBe(400)
      expect((await bad.json()).field).toBe('username')

      const taken = await api.setPassword(friend.id, token, { password: 'firstOne123', username: takenName })
      expect(taken.status(), 'a taken username').toBe(409)
      const takenBody = await taken.json()
      expect(takenBody.error).toBe(USERNAME_TAKEN)
      expect(takenBody.field).toBe('username')
      expect(api.row(friend.id).password_hash, 'a refused username writes no password either').toBeNull()
    })
  })

  test('the password rules match the siblings: short 400s, and every malformed shape 400s (never 500)', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const { friend, token } = await googleOnlyFriend(api, tag('shapes'))
      const username = tag('shapes').replace(/[^a-z0-9._-]/g, '').slice(0, 30)

      const short = await api.setPassword(friend.id, token, { password: 'short1', username })
      expect(short.status()).toBe(400)
      expect((await short.json()).error).toBe(PASSWORD_RULE)

      // ⚠ The FUP-T11 type guard, which must sit ABOVE `hashPassword` — bcryptjs
      // THROWS on a non-string, so every shape below used to be a 500 plus a stack in
      // the log. `{length:12}` clears a bare length rule natively; a number and `true`
      // have `undefined < 8 === false`; and the ONE-ELEMENT ARRAY is the trap (its
      // `length` is 1, so a length-only rule 400s it by accident and the suite passes
      // vacuously).
      for (const shape of [{ length: 12 }, 12345678, true, ['abcdefghij'], ['a'], { toString: 1 }, null]) {
        const res = await api.setPassword(friend.id, token, { password: shape, username })
        expect(res.status(), `password: ${JSON.stringify(shape)}`).toBe(400)
        expect((await res.json()).error, `password: ${JSON.stringify(shape)}`).toBe(PASSWORD_RULE)
      }

      for (const shape of [{ toLowerCase: 1 }, { trim: 1 }, 12345678, true, [username], { toString: 1 }]) {
        const res = await api.setPassword(friend.id, token, { password: 'firstOne123', username: shape })
        expect(res.status(), `username: ${JSON.stringify(shape)}`).toBe(400)
      }

      // ⚠ WHOLE-BODY shapes (CLAUDE.md: `{}`, `true`, `[id]`, `'abc'` must 400, never
      // 500) — a destructure of a non-object is where this class hides.
      for (const raw of ['{}', 'true', `[${friend.id}]`, '"abc"', 'null', '[]', '12']) {
        const res = await api.setPasswordRaw(friend.id, token, raw)
        expect(res.status(), `body: ${raw}`).toBe(400)
      }

      expect(api.row(friend.id).password_hash, 'not one malformed request wrote anything').toBeNull()
    })
  })
})

test.describe('GA-T11 — the first password: the happy path', () => {
  test('⚠ the friend can ACTUALLY LOG IN afterwards — and the old sessions are gone', async () => {
    test.skip(!CAN_SPAWN_BACKEND, NEEDS_SOURCE)
    test.setTimeout(120_000)

    await withBackend(async (api) => {
      const { friend, sub, email, token } = await googleOnlyFriend(api, tag('happy'))
      const username = tag('happy').replace(/[^a-z0-9._-]/g, '').slice(0, 30)
      const password = 'myFirstPw123'

      // A second live session for this friend, so the invalidation is provable.
      const second = await api.googleSession(sub, email)
      expect(api.sessionCount(friend.id), 'two live sessions before').toBe(2)

      const res = await api.setPassword(friend.id, token, { password, username })
      expect(res.status(), 'the first password is set').toBe(200)
      const body = await res.json()
      expect(body.success).toBe(true)
      expect(typeof body.token, 'the caller is handed a fresh session, not logged out').toBe('string')
      expect(body.expiresAt).toBeTruthy()
      expect(body.friend.id).toBe(friend.id)
      expect(body.friend.username).toBe(username)
      // The client flips its own `hasCredentials` off this, so the change-password
      // fold replaces the set-password one without a reload.
      expect(body.friend.hasCredentials).toBe(true)
      // ⚠ The strip rule (11 §UC-FC-005, inherited by module 10): a hand-picked
      // response, asserted on RAW BYTES so a future `SELECT *` spread is caught.
      const raw = JSON.stringify(body)
      expect(raw).not.toMatch(/password_hash|access_token|invite_code|google_sub/)

      // ⚠ THE POINT OF THE WHOLE ROW: the credential is USABLE.
      const login = await api.passwordLogin(username, password)
      expect(login.status(), 'the friend can now log in with name and password').toBe(200)
      const loginBody = await login.json()
      expect(loginBody.hasCredentials).toBe(true)
      expect(loginBody.mustChangePassword, 'a self-chosen password is not a forced one').toBe(false)

      // The "I have secured my account" event: every OTHER session dies, the caller's
      // own is replaced (`change-password`'s contract, copied deliberately).
      expect((await api.profile(friend.id, second)).status(), 'the other session is gone').toBe(401)
      expect((await api.profile(friend.id, token)).status(), 'and so is the presenting one').toBe(401)
      expect((await api.profile(friend.id, body.token)).status(), 'the re-mint works').toBe(200)

      const row = api.row(friend.id)
      expect(row.username).toBe(username)
      expect(row.password_hash).toBeTruthy()
      expect(row.must_change_password, 'the friend chose it, so nothing is forced').toBe(0)
      expect(row.google_sub, 'setting a password does not touch the Google link').toBe(sub)

      // Second call: now it is a CHANGE, and this route refuses it.
      const again = await api.setPassword(friend.id, body.token, { password: 'secondTry123', username })
      expect(again.status(), 'first-time only').toBe(409)
      expect((await api.passwordLogin(username, password)).status(), 'the first password still stands').toBe(200)
    })
  })
})
